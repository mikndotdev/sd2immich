//! On-card sidecar (`sd2i.data`): a gzip-compressed JSON blob written to the card root carrying a
//! stable card UUID, the card name, and per-Immich-account sync status. This makes card identity
//! robust (read the UUID instead of guessing from the volume) and lets sync status follow the card
//! between computers. Best-effort: read-only cards fall back to the volume-heuristic identity.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "sd2i.data";
const SCHEMA: u32 = 1;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub rel_path: String,
    pub name: String,
    pub kind: String,
    pub base_key: String,
    pub size: i64,
    pub mtime: i64,
    #[serde(default)]
    pub checksum: Option<String>,
    #[serde(default)]
    pub immich_id: Option<String>,
    pub status: String,
    #[serde(default)]
    pub stacked: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceData {
    #[serde(default)]
    pub server_url: Option<String>,
    #[serde(default)]
    pub last_synced: i64,
    #[serde(default)]
    pub files: Vec<FileRecord>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardData {
    pub schema: u32,
    pub card_id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// keyed by Immich user id (the "same library" key)
    #[serde(default)]
    pub instances: BTreeMap<String, InstanceData>,
}

impl CardData {
    pub fn new(card_id: String) -> Self {
        CardData {
            schema: SCHEMA,
            card_id,
            name: None,
            instances: BTreeMap::new(),
        }
    }
}

impl FileRecord {
    pub fn from_row(r: &crate::db::FileRow) -> Self {
        FileRecord {
            rel_path: r.rel_path.clone(),
            name: r.name.clone(),
            kind: r.kind.clone(),
            base_key: r.base_key.clone(),
            size: r.size,
            mtime: r.mtime,
            checksum: r.checksum.clone(),
            immich_id: r.immich_id.clone(),
            status: r.status.clone(),
            stacked: r.stacked,
        }
    }

    pub fn to_row(&self) -> crate::db::FileRow {
        crate::db::FileRow {
            rel_path: self.rel_path.clone(),
            name: self.name.clone(),
            kind: self.kind.clone(),
            base_key: self.base_key.clone(),
            size: self.size,
            mtime: self.mtime,
            checksum: self.checksum.clone(),
            immich_id: self.immich_id.clone(),
            status: self.status.clone(),
            stacked: self.stacked,
            error: None,
        }
    }

    pub fn to_cached(&self) -> crate::db::CachedFile {
        crate::db::CachedFile {
            size: self.size,
            mtime: self.mtime,
            checksum: self.checksum.clone(),
            immich_id: self.immich_id.clone(),
            status: self.status.clone(),
            stacked: self.stacked,
        }
    }
}

pub struct Ident {
    pub card_id: String,
    pub label: String,
    pub has_sidecar: bool,
    pub writable: bool,
    pub name: Option<String>,
}

fn sidecar_path(source: &Path) -> PathBuf {
    source.join(FILE_NAME)
}

/// Read + parse the sidecar (gzip, falling back to raw JSON). `None` if missing or corrupt.
pub fn read(source: &Path) -> Option<CardData> {
    let bytes = std::fs::read(sidecar_path(source)).ok()?;
    let json = gunzip(&bytes).unwrap_or(bytes);
    serde_json::from_slice::<CardData>(&json).ok()
}

/// Write the sidecar (gzip-compressed JSON). Errors on read-only media.
pub fn write(source: &Path, data: &CardData) -> Result<(), String> {
    let json = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(&json).map_err(|e| e.to_string())?;
    let gz = enc.finish().map_err(|e| e.to_string())?;
    std::fs::write(sidecar_path(source), gz).map_err(|e| e.to_string())
}

fn gunzip(bytes: &[u8]) -> Option<Vec<u8>> {
    let mut d = flate2::read::GzDecoder::new(bytes);
    let mut out = Vec::new();
    d.read_to_end(&mut out).ok().map(|_| out)
}

/// Whether a `sd2i.data` file is physically present (regardless of whether it parses).
pub fn file_exists(source: &Path) -> bool {
    sidecar_path(source).exists()
}

/// Whether we can write to the card root (probe by creating + removing a temp file).
pub fn is_writable(source: &Path) -> bool {
    let probe = source.join(".sd2i.probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

pub fn new_card_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Resolve identity: sidecar UUID when present, else a provisional volume-heuristic id (no UUID is
/// minted until a write is consented to).
pub fn identify(source: &Path) -> Ident {
    let base = crate::db::card_identity(source);
    match read(source) {
        Some(data) => Ident {
            card_id: data.card_id,
            label: base.label,
            has_sidecar: true,
            writable: is_writable(source),
            name: data.name,
        },
        None => Ident {
            card_id: base.id,
            label: base.label,
            has_sidecar: false,
            writable: is_writable(source),
            name: None,
        },
    }
}
