mod cardfile;
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
use immich::{CheckItem, ImmichClient, PermCheck, TestResult};
use sqlx::SqlitePool;
use tauri::{Manager, State};

/// Validate a server URL + API key, and probe the capabilities sd2immich relies on. Immich has no
/// endpoint to introspect a key's permissions, so we exercise the actual endpoints (read-only /
/// side-effect-free) and report which succeed.
#[tauri::command]
async fn test_connection(server_url: String, api_key: String) -> Result<TestResult, String> {
    let client = ImmichClient::new(&server_url, &api_key)?;
    client.ping().await?;
    let me = client.me().await?;

    // Browse/verify: needs asset.read / timeline.read.
    let read_ok = client.timeline_buckets().await.is_ok();
    // Upload pre-flight: bulk-upload-check with a dummy checksum is side-effect-free; needs
    // asset.upload. A made-up checksum simply comes back as "accept".
    let upload_ok = client
        .bulk_upload_check(vec![CheckItem {
            id: "sd2immich-probe".to_string(),
            checksum: "0".repeat(40),
        }])
        .await
        .is_ok();

    Ok(TestResult {
        email: me.email,
        name: me.name,
        permissions: vec![
            PermCheck { name: "Browse library (asset.read, timeline.read)".into(), ok: read_ok },
            PermCheck { name: "Upload (asset.upload)".into(), ok: upload_ok },
        ],
    })
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

/// Resolve a source path to its card identity + display name (id/label/nickname).
#[tauri::command]
async fn resolve_card(
    source_path: String,
    pool: State<'_, SqlitePool>,
) -> Result<db::CardRef, String> {
    Ok(db::resolve_card(pool.inner(), std::path::Path::new(&source_path)).await)
}

/// Set or clear a card's nickname (blank ⇒ clear). Also reflected into the card's sidecar when it's
/// currently mounted + writable, so the rename follows the card.
#[tauri::command]
async fn set_card_nickname(
    card_id: String,
    nickname: Option<String>,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    let nickname = nickname.filter(|s| !s.trim().is_empty());
    db::set_nickname(pool.inner(), &card_id, nickname.clone()).await?;
    if let Some(mount) = db::get_mount(pool.inner(), &card_id).await {
        let p = std::path::Path::new(&mount);
        if let Some(mut data) = cardfile::read(p) {
            if data.card_id == card_id {
                data.name = nickname;
                let _ = cardfile::write(p, &data);
            }
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarStatus {
    /// a `sd2i.data` file is present and parses
    has_sidecar: bool,
    /// a `sd2i.data` file is present (may be corrupt if `has_sidecar` is false)
    file_exists: bool,
    writable: bool,
    provisional_id: String,
}

/// For the consent gate + Home status badge: sidecar presence/validity, writability, and the
/// provisional (volume-heuristic) id used as the "declined" key before a UUID is minted.
#[tauri::command]
fn sidecar_status(source_path: String) -> SidecarStatus {
    let p = std::path::Path::new(&source_path);
    let ident = cardfile::identify(p);
    SidecarStatus {
        has_sidecar: ident.has_sidecar,
        file_exists: cardfile::file_exists(p),
        writable: ident.writable,
        provisional_id: db::card_identity(p).id,
    }
}

/// Write (or rewrite) the sidecar for a card on demand — e.g. after the user declined earlier and
/// changed their mind. Builds it from the current local DB rows for this card + Immich account.
#[tauri::command]
async fn write_sidecar(
    source_path: String,
    server_url: String,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    let p = std::path::Path::new(&source_path);
    if !cardfile::is_writable(p) {
        return Err("This card appears to be read-only.".into());
    }
    let api_key = keychain::get_api_key(&server_url)?
        .ok_or_else(|| "No API key saved for this server".to_string())?;
    let client = ImmichClient::new(&server_url, &api_key)?;
    let instance_id = client.me().await?.id;
    let pool = pool.inner();

    let existing = cardfile::read(p);
    let final_id = match &existing {
        Some(d) => d.card_id.clone(),
        None => {
            let uuid = cardfile::new_card_id();
            db::rekey_card(pool, &db::card_identity(p).id, &uuid).await?;
            uuid
        }
    };
    let rows = db::load_card_files(pool, &final_id).await;
    let mut data = existing.unwrap_or_else(|| cardfile::CardData::new(final_id.clone()));
    data.card_id = final_id.clone();
    data.name = db::get_nickname(pool, &final_id).await.or(data.name);
    data.instances.insert(
        instance_id,
        cardfile::InstanceData {
            server_url: Some(server_url),
            last_synced: cardfile::now_secs(),
            files: rows.iter().map(cardfile::FileRecord::from_row).collect(),
        },
    );
    cardfile::write(p, &data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
            resolve_card,
            set_card_nickname,
            sidecar_status,
            write_sidecar,
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
