//! Removable-drive enumeration via `sysinfo`. Best-effort: some built-in card readers report
//! as non-removable, so the UI always offers a manual folder picker as a fallback. The frontend
//! polls `list_drives` on an interval to approximate hot-plug detection.

use serde::Serialize;
use sysinfo::Disks;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub name: String,
    pub mount_point: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub is_removable: bool,
}

/// All currently-mounted removable volumes.
pub fn list_removable_drives() -> Vec<DriveInfo> {
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| d.is_removable())
        .map(|d| DriveInfo {
            name: d.name().to_string_lossy().into_owned(),
            mount_point: d.mount_point().to_string_lossy().into_owned(),
            total_bytes: d.total_space(),
            available_bytes: d.available_space(),
            is_removable: d.is_removable(),
        })
        .collect()
}
