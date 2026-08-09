//! Streaming SHA-1 — the checksum Immich uses for deduplication.
//!
//! `sha1_hex` is synchronous on purpose: callers run it inside `tokio::task::spawn_blocking` so a
//! large file never ties up an async worker. `hash_many` fans many files out across the blocking
//! pool with bounded concurrency so hashing overlaps I/O and uses multiple cores.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use futures_util::stream::StreamExt;
use sha1::{Digest, Sha1};

/// SHA-1 hex digest of a file's bytes, read in 1 MiB chunks.
pub fn sha1_hex(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// A sensible concurrency for hashing: scale with cores, clamped so a slow card reader isn't
/// thrashed and a fast SSD is still well-fed.
pub fn hash_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8)
}

/// Hash many files concurrently (up to `concurrency` at once). `progress(done, total)` fires as
/// each completes — in arbitrary order — so callers can drive a progress bar. Results are returned
/// tagged with each item's original index so the caller can map them back regardless of order.
pub async fn hash_many(
    items: Vec<(usize, PathBuf)>,
    concurrency: usize,
    mut progress: impl FnMut(u32, u32),
) -> Vec<(usize, std::io::Result<String>)> {
    let total = items.len() as u32;
    let mut done = 0u32;
    let mut out = Vec::with_capacity(items.len());

    let mut stream = futures_util::stream::iter(items.into_iter().map(|(idx, path)| async move {
        let res = tokio::task::spawn_blocking(move || sha1_hex(&path)).await;
        // Flatten the JoinError (panic/cancel) into an io::Error so callers see one error type.
        let res = res.unwrap_or_else(|e| {
            Err(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
        });
        (idx, res)
    }))
    .buffer_unordered(concurrency.max(1));

    while let Some(item) = stream.next().await {
        done += 1;
        progress(done, total);
        out.push(item);
    }
    out
}
