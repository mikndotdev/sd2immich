//! Local SQLite cache + card history (Rust-owned `sqlx` pool).
//!
//! Purpose is speed and UX, never correctness — Immich's server-side SHA-1 dedup is the real
//! guard against duplicates. The cache lets a re-run skip hashing + the network for files it has
//! already dealt with, keyed on `(card_id, rel_path)` and validated by `(size, mtime)`.

use std::path::Path;

use serde::Serialize;
use sha1::{Digest, Sha1};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use tauri::Manager;

const SCHEMA_VERSION: i64 = 1;

/// Cached per-file state, enough to decide whether work can be skipped.
#[derive(Clone, Debug)]
pub struct CachedFile {
    pub size: i64,
    pub mtime: i64,
    pub checksum: Option<String>,
    pub immich_id: Option<String>,
    pub status: String,
    pub stacked: bool,
}

impl CachedFile {
    /// A cached row is a trustworthy "already in Immich" only when the bytes are unchanged and we
    /// previously confirmed it on the server. Cached "missing" is never trusted (an asset may have
    /// arrived via another device since), so those are always re-checked.
    pub fn confirms_upload(&self, size: i64, mtime: i64) -> bool {
        self.size == size
            && self.mtime == mtime
            && (self.status == "uploaded" || self.status == "duplicate")
    }
}

/// A row to persist after a sync/verify pass.
pub struct FileRow {
    pub rel_path: String,
    pub name: String,
    pub kind: String,
    pub base_key: String,
    pub size: i64,
    pub mtime: i64,
    pub checksum: Option<String>,
    pub immich_id: Option<String>,
    pub status: String,
    pub stacked: bool,
    pub error: Option<String>,
}

/// Stable-ish identity for a source (drive or folder). Correctness never depends on uniqueness.
pub struct CardId {
    pub id: String,
    pub label: String,
    pub mount_point: String,
    pub total_bytes: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardHistory {
    pub card_id: String,
    pub label: String,
    pub mount_point: Option<String>,
    pub total_bytes: Option<i64>,
    pub last_synced: Option<i64>,
    pub files: i64,
    pub uploaded: i64,
    pub in_immich: i64,
}

fn sha1_hex(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

/// Derive a card identity from a source path: match against a mounted removable drive when
/// possible (id = sha1(label:capacity)), else treat it as a plain folder (id = sha1(abs path)).
pub fn card_identity(source: &Path) -> CardId {
    let source_str = source.to_string_lossy().to_string();
    for d in crate::drives::list_removable_drives() {
        if !d.mount_point.is_empty() && source_str.starts_with(&d.mount_point) {
            return CardId {
                id: sha1_hex(&format!("{}:{}", d.name, d.total_bytes)),
                label: if d.name.is_empty() { d.mount_point.clone() } else { d.name.clone() },
                mount_point: d.mount_point,
                total_bytes: d.total_bytes as i64,
            };
        }
    }
    let abs = std::fs::canonicalize(source).unwrap_or_else(|_| source.to_path_buf());
    let abs_str = abs.to_string_lossy().to_string();
    let label = abs
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&abs_str)
        .to_string();
    CardId {
        id: sha1_hex(&abs_str),
        label,
        mount_point: abs_str,
        total_bytes: 0,
    }
}

/// Open (creating if needed) the DB at `app_data_dir()/sd2immich.db`, enable WAL, run migrations.
pub async fn init(app: &tauri::AppHandle) -> Result<SqlitePool, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let db_path = dir.join("sd2immich.db");

    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await
        .map_err(|e| e.to_string())?;

    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(pool: &SqlitePool) -> Result<(), String> {
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
    if version < 1 {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS cards (
              card_id     TEXT PRIMARY KEY,
              label       TEXT NOT NULL,
              mount_point TEXT,
              total_bytes INTEGER,
              first_seen  INTEGER NOT NULL,
              last_synced INTEGER
            );
            CREATE TABLE IF NOT EXISTS files (
              card_id    TEXT NOT NULL,
              rel_path   TEXT NOT NULL,
              name       TEXT NOT NULL,
              kind       TEXT NOT NULL,
              base_key   TEXT NOT NULL,
              size       INTEGER NOT NULL,
              mtime      INTEGER NOT NULL,
              checksum   TEXT,
              immich_id  TEXT,
              status     TEXT NOT NULL,
              stacked    INTEGER NOT NULL DEFAULT 0,
              error      TEXT,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (card_id, rel_path)
            );
            CREATE INDEX IF NOT EXISTS idx_files_card_status ON files(card_id, status);
            CREATE INDEX IF NOT EXISTS idx_files_checksum   ON files(checksum);
            "#,
        )
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        // PRAGMA can't be bound; SCHEMA_VERSION is a trusted constant.
        sqlx::query(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Insert or refresh a card row; stamps `last_synced`.
pub async fn touch_card(pool: &SqlitePool, card: &CardId) -> Result<(), String> {
    let ts = now();
    sqlx::query(
        r#"
        INSERT INTO cards (card_id, label, mount_point, total_bytes, first_seen, last_synced)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT(card_id) DO UPDATE SET
          label = excluded.label,
          mount_point = excluded.mount_point,
          total_bytes = excluded.total_bytes,
          last_synced = excluded.last_synced
        "#,
    )
    .bind(&card.id)
    .bind(&card.label)
    .bind(&card.mount_point)
    .bind(card.total_bytes)
    .bind(ts)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Load all cached rows for a card into a `rel_path -> CachedFile` map for fast lookup.
pub async fn load_card_cache(
    pool: &SqlitePool,
    card_id: &str,
) -> Result<std::collections::HashMap<String, CachedFile>, String> {
    let rows = sqlx::query(
        "SELECT rel_path, size, mtime, checksum, immich_id, status, stacked FROM files WHERE card_id = ?1",
    )
    .bind(card_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut map = std::collections::HashMap::with_capacity(rows.len());
    for r in rows {
        let rel: String = r.get("rel_path");
        map.insert(
            rel,
            CachedFile {
                size: r.get("size"),
                mtime: r.get("mtime"),
                checksum: r.get("checksum"),
                immich_id: r.get("immich_id"),
                status: r.get("status"),
                stacked: r.get::<i64, _>("stacked") != 0,
            },
        );
    }
    Ok(map)
}

/// Upsert a batch of file rows in one transaction.
pub async fn upsert_files(pool: &SqlitePool, card_id: &str, rows: &[FileRow]) -> Result<(), String> {
    let ts = now();
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for row in rows {
        sqlx::query(
            r#"
            INSERT INTO files
              (card_id, rel_path, name, kind, base_key, size, mtime, checksum, immich_id, status, stacked, error, updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
            ON CONFLICT(card_id, rel_path) DO UPDATE SET
              name=excluded.name, kind=excluded.kind, base_key=excluded.base_key,
              size=excluded.size, mtime=excluded.mtime, checksum=excluded.checksum,
              immich_id=excluded.immich_id, status=excluded.status, stacked=excluded.stacked,
              error=excluded.error, updated_at=excluded.updated_at
            "#,
        )
        .bind(card_id)
        .bind(&row.rel_path)
        .bind(&row.name)
        .bind(&row.kind)
        .bind(&row.base_key)
        .bind(row.size)
        .bind(row.mtime)
        .bind(&row.checksum)
        .bind(&row.immich_id)
        .bind(&row.status)
        .bind(row.stacked as i64)
        .bind(&row.error)
        .bind(ts)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Recent cards with aggregate counts, newest first.
pub async fn list_recent_cards(pool: &SqlitePool) -> Result<Vec<CardHistory>, String> {
    let rows = sqlx::query(
        r#"
        SELECT c.card_id, c.label, c.mount_point, c.total_bytes, c.last_synced,
               COUNT(f.rel_path) AS files,
               COALESCE(SUM(CASE WHEN f.status = 'uploaded' THEN 1 ELSE 0 END), 0) AS uploaded,
               COALESCE(SUM(CASE WHEN f.status IN ('uploaded','duplicate') THEN 1 ELSE 0 END), 0) AS in_immich
        FROM cards c
        LEFT JOIN files f ON f.card_id = c.card_id
        GROUP BY c.card_id
        ORDER BY c.last_synced DESC NULLS LAST
        LIMIT 50
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|r| CardHistory {
            card_id: r.get("card_id"),
            label: r.get("label"),
            mount_point: r.get("mount_point"),
            total_bytes: r.get("total_bytes"),
            last_synced: r.get("last_synced"),
            files: r.get("files"),
            uploaded: r.get("uploaded"),
            in_immich: r.get("in_immich"),
        })
        .collect())
}

/// Forget everything cached for a card (leaves the card row so history still lists it).
pub async fn clear_card(pool: &SqlitePool, card_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM files WHERE card_id = ?1")
        .bind(card_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
