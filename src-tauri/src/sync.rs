//! Sync orchestration: scan → (cache fast-path) → hash → bulk-check → upload → optional stack.
//!
//! One-way and idempotent. Correctness (no duplicate assets) comes entirely from Immich's
//! server-side SHA-1 dedup — we pre-flight with `bulk-upload-check` purely to avoid sending bytes
//! the server already has. The local DB cache is a *speed* layer: files whose (size, mtime) are
//! unchanged and were previously confirmed on the server skip hashing, checking, and uploading.
//! Progress is streamed over a `Channel`; the final `Summary` is the return value.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::ipc::Channel;
use tauri::State;

use crate::classify::{Classifier, Kind, UploadFilter};
use crate::db::{self, FileRow};
use crate::immich::{CheckItem, ImmichClient};
use crate::keychain;

const CHECK_BATCH: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub server_url: String,
    pub device_id: String,
    /// "raw" | "image" | "both"
    pub upload_filter: String,
    /// "off" | "jpeg-cover" | "raw-cover"
    pub stack_mode: String,
    pub source_path: String,
    /// Bypass the local cache and re-hash/re-check everything.
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum SyncEvent {
    /// `total == 0` means indeterminate (used while scanning).
    Progress {
        phase: String,
        done: u32,
        total: u32,
        current: Option<String>,
    },
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub scanned: u32,
    pub skipped_filter: u32,
    pub skipped_cached: u32,
    pub already_in_immich: u32,
    pub uploaded: u32,
    pub stacked: u32,
    pub errors: u32,
    pub error_messages: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StackMode {
    Off,
    JpegCover,
    RawCover,
}

impl StackMode {
    fn parse(s: &str) -> Self {
        match s {
            "jpeg-cover" => Self::JpegCover,
            "raw-cover" => Self::RawCover,
            _ => Self::Off,
        }
    }
}

struct Candidate {
    path: PathBuf,
    rel_path: String,
    name: String,
    kind: Kind,
    base_key: String,
    size: i64,
    mtime: i64,
    checksum: Option<String>,
    immich_id: Option<String>,
    /// persisted state: pending | uploaded | duplicate | error
    status: String,
    stacked: bool,
    needs_upload: bool,
    /// satisfied from cache — skip hash/check/upload
    resolved: bool,
    error: Option<String>,
}

fn emit(ch: &Channel<SyncEvent>, phase: &str, done: u32, total: u32, current: Option<String>) {
    let _ = ch.send(SyncEvent::Progress {
        phase: phase.to_string(),
        done,
        total,
        current,
    });
}

/// Format a filesystem time as RFC-3339; fall back to "now" if unavailable.
fn fmt_time(t: Option<SystemTime>) -> String {
    match t {
        Some(st) => {
            let dt: DateTime<Utc> = st.into();
            dt.to_rfc3339()
        }
        None => Utc::now().to_rfc3339(),
    }
}

fn file_times(path: &Path) -> (String, String) {
    let meta = std::fs::metadata(path).ok();
    let modified = meta.as_ref().and_then(|m| m.modified().ok());
    let created = meta.as_ref().and_then(|m| m.created().ok()).or(modified);
    (fmt_time(created), fmt_time(modified))
}

#[tauri::command]
pub async fn start_sync(
    config: SyncConfig,
    on_event: Channel<SyncEvent>,
    pool: State<'_, SqlitePool>,
) -> Result<Summary, String> {
    let pool = pool.inner();
    let filter = UploadFilter::parse(&config.upload_filter);
    let stack_mode = StackMode::parse(&config.stack_mode);
    let source = PathBuf::from(&config.source_path);
    if !source.is_dir() {
        return Err(format!("Not a folder: {}", source.display()));
    }

    // Credentials + client.
    let api_key = keychain::get_api_key(&config.server_url)?
        .ok_or_else(|| "No API key saved for this server — set it in Settings".to_string())?;
    let client = ImmichClient::new(&config.server_url, &api_key)?;

    // Accepted-extension lists drive classification.
    let media = client.media_types().await?;
    let classifier = Classifier::new(&media.image, &media.video);

    let mut summary = Summary::default();

    // Card identity + cache.
    let card = db::card_identity(&source);
    db::touch_card(pool, &card).await?;
    let cache = if config.force {
        HashMap::new()
    } else {
        db::load_card_cache(pool, &card.id).await.unwrap_or_default()
    };

    // ---- Scan + classify/filter (shared with verify) ----
    let scan = crate::scan::scan_source(&source, &classifier, filter);
    summary.scanned = scan.scanned;
    summary.skipped_filter = scan.skipped_filter;
    emit(&on_event, "scan", summary.scanned, 0, None);

    let mut candidates: Vec<Candidate> = scan
        .files
        .into_iter()
        .map(|f| {
            let mut c = Candidate {
                path: f.path,
                rel_path: f.rel_path,
                name: f.name,
                kind: f.kind,
                base_key: f.base_key,
                size: f.size,
                mtime: f.mtime,
                checksum: None,
                immich_id: None,
                status: "pending".into(),
                stacked: false,
                needs_upload: false,
                resolved: false,
                error: None,
            };
            // Cache fast-path: unchanged + previously confirmed ⇒ skip all work.
            if let Some(hit) = cache.get(&c.rel_path) {
                if hit.confirms_upload(c.size, c.mtime) {
                    c.checksum = hit.checksum.clone();
                    c.immich_id = hit.immich_id.clone();
                    c.status = hit.status.clone();
                    c.stacked = hit.stacked;
                    c.resolved = true;
                    summary.skipped_cached += 1;
                }
            }
            c
        })
        .collect();

    // ---- Hash (only unresolved), concurrently ----
    let to_hash: Vec<(usize, PathBuf)> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.resolved)
        .map(|(i, c)| (i, c.path.clone()))
        .collect();
    let results = crate::hash::hash_many(to_hash, crate::hash::hash_concurrency(), |done, total| {
        emit(&on_event, "hash", done, total, None);
    })
    .await;
    for (i, res) in results {
        match res {
            Ok(hex) => candidates[i].checksum = Some(hex),
            Err(e) => {
                let rel = candidates[i].rel_path.clone();
                candidates[i].status = "error".into();
                candidates[i].error = Some(e.to_string());
                summary.errors += 1;
                summary.error_messages.push(format!("hash {rel}: {e}"));
            }
        }
    }

    // ---- Bulk dedup check (only unresolved with a checksum) ----
    let checkable: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.resolved && c.checksum.is_some())
        .map(|(i, _)| i)
        .collect();
    let check_total = checkable.len() as u32;
    let mut checked_done = 0u32;
    for batch in checkable.chunks(CHECK_BATCH) {
        let items: Vec<CheckItem> = batch
            .iter()
            .map(|&i| CheckItem {
                id: i.to_string(),
                checksum: candidates[i].checksum.clone().unwrap(),
            })
            .collect();
        match client.bulk_upload_check(items).await {
            Ok(results) => {
                for r in results {
                    let Ok(idx) = r.id.parse::<usize>() else { continue };
                    if r.action == "accept" {
                        candidates[idx].needs_upload = true;
                    } else if r.reason.as_deref() == Some("duplicate") {
                        candidates[idx].immich_id = r.asset_id;
                        candidates[idx].status = "duplicate".into();
                        summary.already_in_immich += 1;
                    } else {
                        candidates[idx].status = "error".into();
                        let reason = r.reason.unwrap_or_else(|| "unknown".into());
                        candidates[idx].error = Some(format!("rejected ({reason})"));
                        summary.errors += 1;
                        summary
                            .error_messages
                            .push(format!("{}: rejected ({reason})", candidates[idx].rel_path));
                    }
                }
            }
            Err(e) => {
                summary.errors += 1;
                summary.error_messages.push(format!("bulk-check: {e}"));
            }
        }
        checked_done += batch.len() as u32;
        emit(&on_event, "check", checked_done, check_total, None);
    }

    // ---- Upload ----
    let to_upload: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, c)| c.needs_upload)
        .map(|(i, _)| i)
        .collect();
    let up_total = to_upload.len() as u32;
    for (n, &i) in to_upload.iter().enumerate() {
        let path = candidates[i].path.clone();
        let rel = candidates[i].rel_path.clone();
        let checksum = candidates[i].checksum.clone().unwrap_or_default();
        let (created, modified) = file_times(&path);
        emit(&on_event, "upload", n as u32, up_total, Some(rel.clone()));
        match client
            .upload_asset(&path, &rel, &config.device_id, &created, &modified, &checksum)
            .await
        {
            Ok(res) => {
                candidates[i].immich_id = Some(res.id);
                if res.status == "created" {
                    candidates[i].status = "uploaded".into();
                    summary.uploaded += 1;
                } else {
                    // "duplicate" or "replaced": already effectively on the server
                    candidates[i].status = "duplicate".into();
                    summary.already_in_immich += 1;
                }
            }
            Err(e) => {
                candidates[i].status = "error".into();
                candidates[i].error = Some(e.to_string());
                summary.errors += 1;
                summary.error_messages.push(format!("upload {rel}: {e}"));
            }
        }
        emit(&on_event, "upload", (n + 1) as u32, up_total, None);
    }

    // ---- Optional RAW+JPEG stacking (idempotent via the persisted `stacked` flag) ----
    // Stack any base_key pair where both members are on the server and neither is already stacked.
    if stack_mode != StackMode::Off && filter == UploadFilter::Both {
        struct Slot {
            idx: usize,
            immich_id: String,
            stacked: bool,
        }
        let mut groups: HashMap<String, (Option<Slot>, Option<Slot>)> = HashMap::new();
        for (idx, c) in candidates.iter().enumerate() {
            if let Some(id) = &c.immich_id {
                let entry = groups.entry(c.base_key.clone()).or_default();
                let slot = Slot { idx, immich_id: id.clone(), stacked: c.stacked };
                match c.kind {
                    Kind::Raw => entry.0 = Some(slot),
                    Kind::Image => entry.1 = Some(slot),
                    Kind::Video => {}
                }
            }
        }

        // (cover_idx, other_idx, cover_id, other_id)
        let pairs: Vec<(usize, usize, String, String)> = groups
            .values()
            .filter_map(|(raw, img)| match (raw, img) {
                (Some(r), Some(i)) if !r.stacked && !i.stacked => Some(match stack_mode {
                    StackMode::RawCover => (r.idx, i.idx, r.immich_id.clone(), i.immich_id.clone()),
                    _ => (i.idx, r.idx, i.immich_id.clone(), r.immich_id.clone()), // JPEG cover
                }),
                _ => None,
            })
            .collect();

        let stack_total = pairs.len() as u32;
        for (n, (cover_idx, other_idx, cover_id, other_id)) in pairs.iter().enumerate() {
            match client.create_stack(vec![cover_id.clone(), other_id.clone()]).await {
                Ok(()) => {
                    summary.stacked += 1;
                    candidates[*cover_idx].stacked = true;
                    candidates[*other_idx].stacked = true;
                }
                Err(e) => {
                    summary.errors += 1;
                    summary.error_messages.push(format!("stack: {e}"));
                }
            }
            emit(&on_event, "stack", (n + 1) as u32, stack_total, None);
        }
    }

    // ---- Persist everything to the cache ----
    let rows: Vec<FileRow> = candidates
        .iter()
        .map(|c| FileRow {
            rel_path: c.rel_path.clone(),
            name: c.name.clone(),
            kind: c.kind.as_str().to_string(),
            base_key: c.base_key.clone(),
            size: c.size,
            mtime: c.mtime,
            checksum: c.checksum.clone(),
            immich_id: c.immich_id.clone(),
            status: c.status.clone(),
            stacked: c.stacked,
            error: c.error.clone(),
        })
        .collect();
    if let Err(e) = db::upsert_files(pool, &card.id, &rows).await {
        summary.error_messages.push(format!("cache write: {e}"));
    }

    emit(&on_event, "done", 0, 0, None);
    Ok(summary)
}
