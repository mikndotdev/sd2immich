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

/// A stable per-volume serial/UUID for the volume mounted at `mount_point`, when obtainable.
/// Used to tell physically-distinct cards apart even when they share a label (macOS names every
/// SD card "Untitled"). Best-effort and shell-based — returns `None` on any failure so callers
/// can fall back to a label+capacity heuristic.
pub fn volume_serial(mount_point: &str) -> Option<String> {
    if mount_point.is_empty() {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        macos_volume_uuid(mount_point)
    }
    #[cfg(target_os = "linux")]
    {
        linux_volume_uuid(mount_point)
    }
    #[cfg(target_os = "windows")]
    {
        windows_volume_serial(mount_point)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = mount_point;
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_volume_uuid(mount_point: &str) -> Option<String> {
    // `diskutil info <mount>` prints a line like: "   Volume UUID:   XXXXXXXX-...."
    let out = std::process::Command::new("diskutil")
        .arg("info")
        .arg(mount_point)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Volume UUID:") {
            let v = rest.trim();
            if !v.is_empty() && !v.eq_ignore_ascii_case("(none)") {
                return Some(v.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_volume_uuid(mount_point: &str) -> Option<String> {
    // `findmnt -no UUID --target <mount>` prints the filesystem UUID.
    let out = std::process::Command::new("findmnt")
        .args(["-no", "UUID", "--target", mount_point])
        .output()
        .ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[cfg(target_os = "windows")]
fn windows_volume_serial(mount_point: &str) -> Option<String> {
    // `cmd /c vol X:` prints a localized line ending in the "XXXX-XXXX" serial.
    let drive = mount_point.chars().next()?;
    let out = std::process::Command::new("cmd")
        .args(["/c", "vol", &format!("{drive}:")])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for token in text.split_whitespace() {
        let t = token.trim();
        let bytes = t.as_bytes();
        // Match the hex-dash-hex serial regardless of locale wording.
        if bytes.len() == 9
            && bytes[4] == b'-'
            && t.chars().enumerate().all(|(i, c)| i == 4 || c.is_ascii_hexdigit())
        {
            return Some(t.to_string());
        }
    }
    None
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
