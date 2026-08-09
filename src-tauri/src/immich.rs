//! Thin async client over the Immich REST API.
//!
//! Only the handful of endpoints sd2immich needs are implemented. Authentication is a
//! single `x-api-key` header on every request. Deduplication is entirely server-side and
//! keyed on the SHA-1 checksum of an asset's bytes — see `bulk_upload_check` (pre-flight)
//! and the `x-immich-checksum` upload header.

use std::path::Path;

use reqwest::multipart::{Form, Part};
use reqwest::Body;
use serde::{Deserialize, Serialize};
use tokio_util::codec::{BytesCodec, FramedRead};

/// Authenticated Immich client bound to one server + key.
pub struct ImmichClient {
    api_base: String,
    api_key: String,
    http: reqwest::Client,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfo {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct MediaTypes {
    #[serde(default)]
    pub image: Vec<String>,
    #[serde(default)]
    pub video: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)] // part of the API response; not used yet (XMP sidecar upload is future work)
    pub sidecar: Vec<String>,
}

/// One entry sent to `POST /assets/bulk-upload-check`.
#[derive(Debug, Serialize)]
pub struct CheckItem {
    pub id: String,
    /// SHA-1 hex digest of the file's bytes.
    pub checksum: String,
}

/// One result returned by `POST /assets/bulk-upload-check`.
#[derive(Debug, Deserialize)]
pub struct CheckResult {
    pub id: String,
    /// "accept" (upload it) or "reject" (see `reason`).
    pub action: String,
    /// Present on reject: "duplicate" | "unsupported" | ...
    #[serde(default)]
    pub reason: Option<String>,
    /// Existing asset id when `reason == "duplicate"`.
    #[serde(rename = "assetId", default)]
    pub asset_id: Option<String>,
}

/// Result of a single upload. `status` is "created" | "replaced" | "duplicate".
#[derive(Debug, Deserialize)]
pub struct UploadResult {
    pub id: String,
    pub status: String,
}

/// Minimal asset metadata for a gallery tile badge.
#[derive(Debug, Deserialize)]
pub struct AssetInfo {
    #[serde(rename = "originalFileName", default)]
    pub original_file_name: String,
    #[serde(rename = "type", default)]
    pub asset_type: String, // IMAGE | VIDEO | AUDIO | OTHER
}

/// One month bucket from `GET /timeline/buckets`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBucket {
    pub time_bucket: String,
    #[serde(default)]
    pub count: u32,
}

/// Current (columnar) `GET /timeline/bucket` response — we only need the id column.
#[derive(Deserialize)]
struct BucketAssets {
    #[serde(default)]
    id: Vec<String>,
}

#[derive(Serialize)]
struct BulkReq {
    assets: Vec<CheckItem>,
}

#[derive(Deserialize)]
struct BulkResp {
    #[serde(default)]
    results: Vec<CheckResult>,
}

#[derive(Serialize)]
struct StackReq {
    #[serde(rename = "assetIds")]
    asset_ids: Vec<String>,
}

impl ImmichClient {
    /// `server_url` may be given with or without a trailing `/api` and/or trailing slash.
    pub fn new(server_url: &str, api_key: &str) -> Result<Self, String> {
        let root = server_url.trim().trim_end_matches('/');
        if root.is_empty() {
            return Err("Server URL is empty".into());
        }
        let api_base = if root.ends_with("/api") {
            root.to_string()
        } else {
            format!("{root}/api")
        };
        let http = reqwest::Client::builder()
            .user_agent("sd2immich")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            api_base,
            api_key: api_key.to_string(),
            http,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.api_base, path)
    }

    /// `GET /server/ping` — cheap reachability check (does not validate the key).
    pub async fn ping(&self) -> Result<(), String> {
        let resp = self
            .http
            .get(self.url("/server/ping"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(format!("Ping failed: HTTP {}", resp.status()))
        }
    }

    /// `GET /users/me` — validates the API key and returns the owning user.
    pub async fn me(&self) -> Result<UserInfo, String> {
        let resp = self
            .http
            .get(self.url("/users/me"))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Authentication failed: HTTP {}", resp.status()));
        }
        resp.json::<UserInfo>().await.map_err(|e| e.to_string())
    }

    /// `GET /server/media-types` — the extensions this server accepts.
    pub async fn media_types(&self) -> Result<MediaTypes, String> {
        let resp = self
            .http
            .get(self.url("/server/media-types"))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("media-types failed: HTTP {}", resp.status()));
        }
        resp.json::<MediaTypes>().await.map_err(|e| e.to_string())
    }

    /// `POST /assets/bulk-upload-check` — ask which checksums the server already has.
    pub async fn bulk_upload_check(&self, items: Vec<CheckItem>) -> Result<Vec<CheckResult>, String> {
        if items.is_empty() {
            return Ok(Vec::new());
        }
        let resp = self
            .http
            .post(self.url("/assets/bulk-upload-check"))
            .header("x-api-key", &self.api_key)
            .json(&BulkReq { assets: items })
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("bulk-upload-check failed: HTTP {}", resp.status()));
        }
        let parsed = resp.json::<BulkResp>().await.map_err(|e| e.to_string())?;
        Ok(parsed.results)
    }

    /// `POST /assets` (multipart) — stream a file up. Returns 201=created / 200=duplicate.
    pub async fn upload_asset(
        &self,
        path: &Path,
        device_asset_id: &str,
        device_id: &str,
        file_created_at: &str,
        file_modified_at: &str,
        checksum_hex: &str,
    ) -> Result<UploadResult, String> {
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        let len = file
            .metadata()
            .await
            .map_err(|e| e.to_string())?
            .len();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("asset")
            .to_string();

        let stream = FramedRead::new(file, BytesCodec::new());
        let part = Part::stream_with_length(Body::wrap_stream(stream), len)
            .file_name(file_name)
            .mime_str("application/octet-stream")
            .map_err(|e| e.to_string())?;

        let form = Form::new()
            .text("deviceAssetId", device_asset_id.to_string())
            .text("deviceId", device_id.to_string())
            .text("fileCreatedAt", file_created_at.to_string())
            .text("fileModifiedAt", file_modified_at.to_string())
            .part("assetData", part);

        let resp = self
            .http
            .post(self.url("/assets"))
            .header("x-api-key", &self.api_key)
            .header("x-immich-checksum", checksum_hex)
            .multipart(form)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("upload failed: HTTP {status}: {body}"));
        }
        resp.json::<UploadResult>().await.map_err(|e| e.to_string())
    }

    /// `POST /stacks` — group assets into a stack; the first id becomes the cover/primary.
    pub async fn create_stack(&self, asset_ids: Vec<String>) -> Result<(), String> {
        if asset_ids.len() < 2 {
            return Err("a stack needs at least 2 assets".into());
        }
        let resp = self
            .http
            .post(self.url("/stacks"))
            .header("x-api-key", &self.api_key)
            .json(&StackReq { asset_ids })
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("create stack failed: HTTP {status}: {body}"));
        }
        Ok(())
    }

    /// `GET /assets/{id}` — minimal metadata for a tile badge.
    pub async fn asset_info(&self, id: &str) -> Result<AssetInfo, String> {
        let resp = self
            .http
            .get(self.url(&format!("/assets/{id}")))
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("asset info: HTTP {}", resp.status()));
        }
        resp.json::<AssetInfo>().await.map_err(|e| e.to_string())
    }

    /// `GET /assets/{id}/thumbnail?size=thumbnail` — JPEG/WebP bytes.
    pub async fn asset_thumbnail(&self, id: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .http
            .get(self.url(&format!("/assets/{id}/thumbnail")))
            .query(&[("size", "thumbnail")])
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("thumbnail: HTTP {}", resp.status()));
        }
        Ok(resp.bytes().await.map_err(|e| e.to_string())?.to_vec())
    }

    /// `GET /timeline/buckets?size=MONTH` — month buckets for library browsing.
    pub async fn timeline_buckets(&self) -> Result<Vec<TimeBucket>, String> {
        let resp = self
            .http
            .get(self.url("/timeline/buckets"))
            .query(&[("size", "MONTH")])
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("timeline buckets: HTTP {}", resp.status()));
        }
        resp.json::<Vec<TimeBucket>>().await.map_err(|e| e.to_string())
    }

    /// `GET /timeline/bucket?size=MONTH&timeBucket=…` — asset ids in one bucket.
    pub async fn timeline_bucket(&self, time_bucket: &str) -> Result<Vec<String>, String> {
        let resp = self
            .http
            .get(self.url("/timeline/bucket"))
            .query(&[("size", "MONTH"), ("timeBucket", time_bucket)])
            .header("x-api-key", &self.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("timeline bucket: HTTP {}", resp.status()));
        }
        let parsed = resp.json::<BucketAssets>().await.map_err(|e| e.to_string())?;
        Ok(parsed.id)
    }
}
