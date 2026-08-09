//! Camera-agnostic file classification.
//!
//! We rely on the server's own accepted-extension lists (`GET /server/media-types`) to decide
//! what is uploadable at all, then overlay our own RAW extension set so RAW files (which Immich
//! reports under `image`) can be told apart from processed stills for the upload filter and for
//! RAW+JPEG stacking.

use std::collections::HashSet;
use std::path::Path;

/// Proprietary + open RAW container extensions (lowercase, no dot).
const RAW_EXTS: &[&str] = &[
    "cr2", "cr3", "crw", // Canon
    "nef", "nrw", // Nikon
    "arw", "sr2", "srf", // Sony
    "raf", // Fujifilm
    "orf", // Olympus/OM
    "rw2", // Panasonic
    "pef", // Pentax
    "rwl", // Leica
    "srw", // Samsung
    "3fr", "fff", // Hasselblad
    "iiq", "cap", // Phase One
    "x3f", // Sigma
    "kdc", "dcr", // Kodak
    "mrw", // Minolta
    "mef", // Mamiya
    "mos", // Leaf
    "erf", // Epson
    "dng", "raw", // generic
];

/// Is this extension (bare, lowercase or not) a known RAW format? Used by the thumbnail path.
pub fn is_raw_ext(ext: &str) -> bool {
    let e = ext.trim_start_matches('.').to_lowercase();
    RAW_EXTS.contains(&e.as_str())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Raw,
    Image,
    Video,
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Raw => "raw",
            Kind::Image => "image",
            Kind::Video => "video",
        }
    }
}

/// Which stills the user wants uploaded. Videos are never gated by this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadFilter {
    Raw,
    Image,
    Both,
}

impl UploadFilter {
    pub fn parse(s: &str) -> Self {
        match s {
            "raw" => Self::Raw,
            "image" | "jpeg" => Self::Image,
            _ => Self::Both,
        }
    }

    /// Videos always pass; stills are gated.
    pub fn allows(&self, kind: Kind) -> bool {
        match kind {
            Kind::Video => true,
            Kind::Raw => matches!(self, Self::Raw | Self::Both),
            Kind::Image => matches!(self, Self::Image | Self::Both),
        }
    }
}

pub struct Classifier {
    image: HashSet<String>,
    video: HashSet<String>,
    raw: HashSet<String>,
}

impl Classifier {
    /// Build from the server's `media-types` lists. Extensions arrive like `.jpg`; we normalise
    /// to bare lowercase (`jpg`).
    pub fn new(image_exts: &[String], video_exts: &[String]) -> Self {
        let norm = |v: &[String]| -> HashSet<String> {
            v.iter()
                .map(|s| s.trim_start_matches('.').to_lowercase())
                .collect()
        };
        Self {
            image: norm(image_exts),
            video: norm(video_exts),
            raw: RAW_EXTS.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// `None` => not a media file the server accepts (skip it entirely).
    pub fn classify(&self, path: &Path) -> Option<Kind> {
        let ext = path.extension()?.to_str()?.to_lowercase();
        let accepted = self.image.contains(&ext) || self.video.contains(&ext);
        if !accepted {
            return None;
        }
        if self.raw.contains(&ext) {
            Some(Kind::Raw)
        } else if self.video.contains(&ext) {
            Some(Kind::Video)
        } else {
            Some(Kind::Image)
        }
    }
}
