mod classify;
mod db;
mod drives;
mod gallery;
mod hash;
mod immich;
mod keychain;
mod scan;
mod sync;
mod thumb;
mod verify;

use drives::DriveInfo;
use immich::{ImmichClient, UserInfo};
use sqlx::SqlitePool;
use tauri::{Manager, State};

/// Validate a server URL + API key. Returns the owning user on success.
#[tauri::command]
async fn test_connection(server_url: String, api_key: String) -> Result<UserInfo, String> {
    let client = ImmichClient::new(&server_url, &api_key)?;
    client.ping().await?;
    client.me().await
}

/// Store the API key in the OS keychain, keyed by server URL.
#[tauri::command]
fn set_api_key(server_url: String, api_key: String) -> Result<(), String> {
    keychain::set_api_key(&server_url, &api_key)
}

#[tauri::command]
fn delete_api_key(server_url: String) -> Result<(), String> {
    keychain::delete_api_key(&server_url)
}

/// Whether a key is saved for this server (never returns the secret itself).
#[tauri::command]
fn has_api_key(server_url: String) -> Result<bool, String> {
    Ok(keychain::get_api_key(&server_url)?.is_some())
}

/// Currently-mounted removable volumes (best-effort; UI also offers a folder picker).
#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    drives::list_removable_drives()
}

/// Previously-seen cards with aggregate counts, newest first.
#[tauri::command]
async fn list_recent_cards(pool: State<'_, SqlitePool>) -> Result<Vec<db::CardHistory>, String> {
    db::list_recent_cards(pool.inner()).await
}

/// Forget cached file rows for a card (forces a clean re-hash on next sync/verify).
#[tauri::command]
async fn clear_card_cache(card_id: String, pool: State<'_, SqlitePool>) -> Result<(), String> {
    db::clear_card(pool.inner(), &card_id).await
}

/// Resolve the stable card id for a source path (so the UI can target its cache).
#[tauri::command]
fn card_id_for(source_path: String) -> String {
    db::card_identity(std::path::Path::new(&source_path)).id
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let pool = tauri::async_runtime::block_on(db::init(&handle))
                .expect("failed to open local database");
            app.manage(pool);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            test_connection,
            set_api_key,
            delete_api_key,
            has_api_key,
            list_drives,
            list_recent_cards,
            clear_card_cache,
            card_id_for,
            sync::start_sync,
            verify::verify_card,
            thumb::local_thumbnail,
            gallery::immich_tile,
            gallery::immich_timeline_buckets,
            gallery::immich_timeline_bucket
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
