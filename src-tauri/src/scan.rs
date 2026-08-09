//! Shared recursive scan + classify + filter step, used by both `sync` (upload) and `verify`
//! (compare against Immich). Deterministic order; `rel_path` is the stable per-file identity.

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::classify::{Classifier, Kind, UploadFilter};

pub struct ScannedFile {
    pub path: PathBuf,
    pub rel_path: String,
    pub name: String,
    pub kind: Kind,
    pub base_key: String,
    /// bytes; part of the cache-validity key
    pub size: i64,
    /// mtime as unix secs; part of the cache-validity key
    pub mtime: i64,
}

pub struct ScanResult {
    pub files: Vec<ScannedFile>,
    /// media files found (before the filter)
    pub scanned: u32,
    /// stills dropped by the upload filter
    pub skipped_filter: u32,
}

pub fn scan_source(source: &Path, classifier: &Classifier, filter: UploadFilter) -> ScanResult {
    let mut files = Vec::new();
    let mut scanned = 0u32;
    let mut skipped_filter = 0u32;

    for entry in WalkDir::new(source).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("._") || name == ".DS_Store" {
                continue;
            }
        }
        let kind = match classifier.classify(path) {
            Some(k) => k,
            None => continue,
        };
        scanned += 1;
        if !filter.allows(kind) {
            skipped_filter += 1;
            continue;
        }
        let rel_path = path
            .strip_prefix(source)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let base_key = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
        let mtime = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        files.push(ScannedFile {
            path: path.to_path_buf(),
            rel_path,
            name,
            kind,
            base_key,
            size,
            mtime,
        });
    }

    ScanResult {
        files,
        scanned,
        skipped_filter,
    }
}
