//! Commands backing the Gallery tab's "browse Immich library" mode: month buckets, the asset ids
//! in a bucket, and a per-tile payload (thumbnail data URL + badge metadata), fetched lazily.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;

use crate::classify::is_raw_ext;
use crate::immich::{ImmichClient, TimeBucket};
use crate::keychain;

fn client(server_url: &str) -> Result<ImmichClient, String> {
    let key = keychain::get_api_key(server_url)?
        .ok_or_else(|| "No API key saved for this server".to_string())?;
    ImmichClient::new(server_url, &key)
}

fn guess_mime(b: &[u8]) -> &'static str {
    if b.len() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
        "image/jpeg"
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.len() >= 8 && b[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        "image/png"
    } else {
        "image/jpeg"
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileMeta {
    pub thumb: String, // data URL
    pub name: String,
    pub is_raw: bool,
    pub is_video: bool,
}

#[tauri::command]
pub async fn immich_timeline_buckets(server_url: String) -> Result<Vec<TimeBucket>, String> {
    client(&server_url)?.timeline_buckets().await
}

#[tauri::command]
pub async fn immich_timeline_bucket(
    server_url: String,
    time_bucket: String,
) -> Result<Vec<String>, String> {
    client(&server_url)?.timeline_bucket(&time_bucket).await
}

#[tauri::command]
pub async fn immich_tile(server_url: String, asset_id: String) -> Result<TileMeta, String> {
    let c = client(&server_url)?;
    let info = c.asset_info(&asset_id).await?;
    let bytes = c.asset_thumbnail(&asset_id).await?;
    let ext = std::path::Path::new(&info.original_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    Ok(TileMeta {
        thumb: format!("data:{};base64,{}", guess_mime(&bytes), STANDARD.encode(&bytes)),
        name: info.original_file_name.clone(),
        is_raw: is_raw_ext(ext),
        is_video: info.asset_type == "VIDEO",
    })
}
