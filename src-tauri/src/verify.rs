//! Verify a card against Immich without uploading: scan → (cache fast-path) → hash → bulk-check.
//!
//! Streams the file list up-front (so the grid renders immediately, each entry carrying any cached
//! in-Immich state for an instant first paint), then a per-file verdict as batches resolve.
//! Cached-confirmed files resolve instantly with no hashing; only new/changed files are hashed and
//! checked. Results are written back to the cache. This is the sync pipeline minus the upload step.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::ipc::Channel;
use tauri::State;

use crate::classify::{Classifier, UploadFilter};
use crate::db::{self, FileRow};
use crate::immich::{CheckItem, ImmichClient};
use crate::keychain;

const CHECK_BATCH: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyConfig {
    pub server_url: String,
    pub source_path: String,
    pub upload_filter: String,
    /// Bypass the local cache and re-hash/re-check everything.
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFile {
    /// rel_path — stable, unique per file; used as the tile key.
    pub id: String,
    /// absolute path, for `local_thumbnail`.
    pub path: String,
    pub name: String,
    /// "raw" | "image" | "video"
    pub kind: String,
    /// file mtime (unix secs) — the sort key for oldest/newest ordering.
    pub mtime: i64,
    /// `Some(true)` when the cache already confirms this file is in Immich (instant paint);
    /// `None` when unknown and it must be checked.
    pub cached_in_immich: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifySummary {
    pub total: u32,
    pub in_immich: u32,
    pub missing: u32,
    pub skipped_cached: u32,
    pub errors: u32,
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum VerifyEvent {
    Files { files: Vec<CardFile> },
    Progress { phase: String, done: u32, total: u32 },
    File {
        id: String,
        in_immich: bool,
        immich_id: Option<String>,
    },
}

#[tauri::command]
pub async fn verify_card(
    config: VerifyConfig,
    on_event: Channel<VerifyEvent>,
    pool: State<'_, SqlitePool>,
) -> Result<VerifySummary, String> {
    let pool = pool.inner();
    let filter = UploadFilter::parse(&config.upload_filter);
    let source = PathBuf::from(&config.source_path);
    if !source.is_dir() {
        return Err(format!("Not a folder: {}", source.display()));
    }

    let api_key = keychain::get_api_key(&config.server_url)?
        .ok_or_else(|| "No API key saved for this server — set it in Settings".to_string())?;
    let client = ImmichClient::new(&config.server_url, &api_key)?;
    let media = client.media_types().await?;
    let classifier = Classifier::new(&media.image, &media.video);

    let card = db::card_identity(&source);
    db::touch_card(pool, &card).await?;
    let cache = if config.force {
        HashMap::new()
    } else {
        db::load_card_cache(pool, &card.id).await.unwrap_or_default()
    };

    let scan = crate::scan::scan_source(&source, &classifier, filter);

    // Per-file resolution: cached-confirmed files short-circuit; the rest need hashing + checking.
    struct Item {
        rel_path: String,
        name: String,
        kind: String,
        base_key: String,
        size: i64,
        mtime: i64,
        checksum: Option<String>,
        immich_id: Option<String>,
        status: String,     // uploaded | duplicate | pending | error (persisted)
        resolved: bool,     // confirmed from cache
        stacked: bool,
    }

    let mut items: Vec<Item> = Vec::with_capacity(scan.files.len());
    let mut files_event: Vec<CardFile> = Vec::with_capacity(scan.files.len());
    for f in &scan.files {
        let hit = if config.force { None } else { cache.get(&f.rel_path) };
        let resolved = hit.map(|h| h.confirms_upload(f.size, f.mtime)).unwrap_or(false);
        files_event.push(CardFile {
            id: f.rel_path.clone(),
            path: f.path.to_string_lossy().into_owned(),
            name: f.name.clone(),
            kind: f.kind.as_str().to_string(),
            mtime: f.mtime,
            cached_in_immich: if resolved { Some(true) } else { None },
        });
        items.push(Item {
            rel_path: f.rel_path.clone(),
            name: f.name.clone(),
            kind: f.kind.as_str().to_string(),
            base_key: f.base_key.clone(),
            size: f.size,
            mtime: f.mtime,
            checksum: hit.and_then(|h| h.checksum.clone()),
            immich_id: hit.and_then(|h| h.immich_id.clone()),
            status: hit.map(|h| h.status.clone()).unwrap_or_else(|| "pending".into()),
            resolved,
            stacked: hit.map(|h| h.stacked).unwrap_or(false),
        });
    }

    let total = items.len() as u32;
    let _ = on_event.send(VerifyEvent::Files { files: files_event });

    let mut summary = VerifySummary {
        total,
        in_immich: 0,
        missing: 0,
        skipped_cached: 0,
        errors: 0,
    };

    // Cached-confirmed files resolve instantly.
    for it in items.iter().filter(|i| i.resolved) {
        summary.in_immich += 1;
        summary.skipped_cached += 1;
        let _ = on_event.send(VerifyEvent::File {
            id: it.rel_path.clone(),
            in_immich: true,
            immich_id: it.immich_id.clone(),
        });
    }

    // Hash the rest (keyed by rel_path), concurrently. Failures resolve immediately as "missing".
    let to_hash: Vec<(usize, PathBuf)> = items
        .iter()
        .enumerate()
        .filter(|(_, it)| !it.resolved)
        .map(|(i, it)| (i, source.join(&it.rel_path)))
        .collect();
    let results = crate::hash::hash_many(to_hash, crate::hash::hash_concurrency(), |done, total| {
        let _ = on_event.send(VerifyEvent::Progress { phase: "hash".into(), done, total });
    })
    .await;
    let mut hashed: Vec<usize> = Vec::new();
    for (i, res) in results {
        match res {
            Ok(hex) => {
                items[i].checksum = Some(hex);
                hashed.push(i);
            }
            Err(_) => {
                items[i].status = "error".into();
                summary.errors += 1;
                summary.missing += 1;
                let _ = on_event.send(VerifyEvent::File {
                    id: items[i].rel_path.clone(),
                    in_immich: false,
                    immich_id: None,
                });
            }
        }
    }

    // Bulk-check the freshly-hashed files; each result flips its tile.
    let check_total = hashed.len() as u32;
    let mut done = 0u32;
    for batch in hashed.chunks(CHECK_BATCH) {
        let items_req: Vec<CheckItem> = batch
            .iter()
            .map(|&i| CheckItem {
                id: i.to_string(),
                checksum: items[i].checksum.clone().unwrap(),
            })
            .collect();
        match client.bulk_upload_check(items_req).await {
            Ok(results) => {
                for r in results {
                    let Ok(idx) = r.id.parse::<usize>() else { continue };
                    let in_immich = r.action != "accept" && r.reason.as_deref() == Some("duplicate");
                    if in_immich {
                        items[idx].status = "duplicate".into();
                        items[idx].immich_id = r.asset_id.clone();
                        summary.in_immich += 1;
                    } else {
                        items[idx].status = "pending".into();
                        summary.missing += 1;
                    }
                    let _ = on_event.send(VerifyEvent::File {
                        id: items[idx].rel_path.clone(),
                        in_immich,
                        immich_id: r.asset_id,
                    });
                }
            }
            Err(_) => {
                summary.errors += 1;
                for &i in batch {
                    summary.missing += 1;
                    let _ = on_event.send(VerifyEvent::File {
                        id: items[i].rel_path.clone(),
                        in_immich: false,
                        immich_id: None,
                    });
                }
            }
        }
        done += batch.len() as u32;
        let _ = on_event.send(VerifyEvent::Progress {
            phase: "check".into(),
            done,
            total: check_total,
        });
    }

    // Persist what we learned (checksums + confirmed/pending state) so the next run is instant.
    let rows: Vec<FileRow> = items
        .iter()
        .map(|it| FileRow {
            rel_path: it.rel_path.clone(),
            name: it.name.clone(),
            kind: it.kind.clone(),
            base_key: it.base_key.clone(),
            size: it.size,
            mtime: it.mtime,
            checksum: it.checksum.clone(),
            immich_id: it.immich_id.clone(),
            status: it.status.clone(),
            stacked: it.stacked,
            error: None,
        })
        .collect();
    let _ = db::upsert_files(pool, &card.id, &rows).await;

    let _ = on_event.send(VerifyEvent::Progress {
        phase: "done".into(),
        done: total,
        total,
    });
    Ok(summary)
}
