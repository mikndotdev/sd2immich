//! Local thumbnail generation for the gallery grid.
//!
//! Standard images decode/resize via the `image` crate; RAW files use quickraw's embedded-JPEG
//! preview (pure Rust — no libraw/FFI). Results are disk-cached under the app cache dir keyed by
//! path+mtime+size, so re-browsing is instant. Unsupported inputs (e.g. HEIC) return `Err`, and
//! the frontend renders a placeholder tile.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageFormat;
use tauri::Manager;

use crate::classify::is_raw_ext;

const MAX_EDGE: u32 = 400;

/// Returns a `data:image/jpeg;base64,…` URL for a ~400px thumbnail of `path`.
#[tauri::command]
pub async fn local_thumbnail(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let meta = std::fs::metadata(&src).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.len();

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("thumbs");

    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    mtime.hash(&mut h);
    size.hash(&mut h);
    MAX_EDGE.hash(&mut h);
    let cache_file = cache_dir.join(format!("{:016x}.jpg", h.finish()));

    let jpeg = tokio::task::spawn_blocking(move || generate(&src, &cache_dir, &cache_file))
        .await
        .map_err(|e| e.to_string())??;

    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(jpeg)))
}

fn generate(src: &Path, cache_dir: &Path, cache_file: &Path) -> Result<Vec<u8>, String> {
    if let Ok(bytes) = std::fs::read(cache_file) {
        if !bytes.is_empty() {
            return Ok(bytes);
        }
    }
    let img = decode(src)?;
    let thumb = img.thumbnail(MAX_EDGE, MAX_EDGE);
    let mut buf: Vec<u8> = Vec::new();
    thumb
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(cache_dir);
    let _ = std::fs::write(cache_file, &buf);
    Ok(buf)
}

fn decode(src: &Path) -> Result<image::DynamicImage, String> {
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("");
    if is_raw_ext(ext) {
        let raw = std::fs::read(src).map_err(|e| e.to_string())?;
        let (thumb_bytes, _orientation) =
            quickraw::Export::export_thumbnail_data(&raw).map_err(|e| format!("raw preview: {e:?}"))?;
        image::load_from_memory(&thumb_bytes).map_err(|e| e.to_string())
    } else {
        image::open(src).map_err(|e| e.to_string())
    }
}
