// Typed bridge to the Rust backend + settings persistence.
// Secrets (the API key) live only in the OS keychain, reached through Rust commands — never here.

import { Channel, invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

export type UserInfo = { email: string; name: string };

export type PermCheck = { name: string; ok: boolean };
export type TestResult = { email: string; name: string; permissions: PermCheck[] };

export type DriveInfo = {
  name: string;
  mountPoint: string;
  totalBytes: number;
  availableBytes: number;
  isRemovable: boolean;
};

export type UploadFilter = "raw" | "image" | "both";
export type StackMode = "off" | "jpeg-cover" | "raw-cover";

export type Settings = {
  /** the active instance's base URL */
  serverUrl: string;
  /** all known Immich instance base URLs */
  instances: string[];
  deviceId: string;
  uploadFilter: UploadFilter;
  stackMode: StackMode;
};

export type SyncProgress = {
  phase: "scan" | "hash" | "check" | "upload" | "stack" | "done";
  done: number;
  total: number;
  current: string | null;
};

export type Summary = {
  scanned: number;
  skippedFilter: number;
  skippedCached: number;
  alreadyInImmich: number;
  uploaded: number;
  stacked: number;
  errors: number;
  errorMessages: string[];
};

type SyncEvent = { event: "progress"; data: SyncProgress };

// ---- Settings store (non-secret values) ----

const SETTINGS_FILE = "settings.json";
let _store: Store | null = null;

async function store(): Promise<Store> {
  if (!_store) _store = await load(SETTINGS_FILE, { autoSave: true });
  return _store;
}

export async function loadSettings(): Promise<Settings> {
  const s = await store();
  const savedUrl = (await s.get<string>("serverUrl")) ?? "";
  let instances = (await s.get<string[]>("instances")) ?? [];
  // Migrate a single legacy serverUrl into the instances list.
  if (instances.length === 0 && savedUrl) instances = [savedUrl];
  // The active instance must be one we know about.
  const serverUrl = savedUrl && instances.includes(savedUrl) ? savedUrl : (instances[0] ?? "");

  let deviceId = (await s.get<string>("deviceId")) ?? "";
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await s.set("deviceId", deviceId);
    await s.save();
  }
  const uploadFilter = ((await s.get<string>("uploadFilter")) as UploadFilter) ?? "both";
  const stackMode = ((await s.get<string>("stackMode")) as StackMode) ?? "off";
  return { serverUrl, instances, deviceId, uploadFilter, stackMode };
}

export async function saveSettings(partial: Partial<Settings>): Promise<void> {
  const s = await store();
  for (const [k, v] of Object.entries(partial)) {
    await s.set(k, v);
  }
  await s.save();
}

// ---- Commands ----

export const testConnection = (serverUrl: string, apiKey: string) =>
  invoke<TestResult>("test_connection", { serverUrl, apiKey });

export const setApiKey = (serverUrl: string, apiKey: string) =>
  invoke<void>("set_api_key", { serverUrl, apiKey });

export const deleteApiKey = (serverUrl: string) =>
  invoke<void>("delete_api_key", { serverUrl });

export const hasApiKey = (serverUrl: string) =>
  invoke<boolean>("has_api_key", { serverUrl });

export const listDrives = () => invoke<DriveInfo[]>("list_drives");

export type StartSyncConfig = {
  serverUrl: string;
  deviceId: string;
  uploadFilter: UploadFilter;
  stackMode: StackMode;
  sourcePath: string;
  force?: boolean;
};

export async function startSync(
  config: StartSyncConfig,
  onProgress: (p: SyncProgress) => void,
): Promise<Summary> {
  const onEvent = new Channel<SyncEvent>();
  onEvent.onmessage = (msg) => {
    if (msg.event === "progress") onProgress(msg.data);
  };
  return invoke<Summary>("start_sync", { config, onEvent });
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---- Gallery / verify ----

export type FileKind = "raw" | "image" | "video";

/** Per-tile sync state: still checking, confirmed in Immich, or missing. */
export type CloudState = "checking" | "in" | "out";

export type CardFile = {
  id: string;
  path: string;
  name: string;
  kind: FileKind;
  /** file mtime (unix secs) — sort key for oldest/newest. */
  mtime: number;
  /** true when the cache already confirms it's in Immich (instant paint); null = unknown. */
  cachedInImmich: boolean | null;
};

export type VerifySummary = {
  total: number;
  inImmich: number;
  missing: number;
  skippedCached: number;
  errors: number;
};

export type CardHistory = {
  cardId: string;
  label: string;
  nickname: string | null;
  mountPoint: string | null;
  totalBytes: number | null;
  lastSynced: number | null;
  files: number;
  uploaded: number;
  inImmich: number;
};

export type CardRef = {
  cardId: string;
  label: string;
  nickname: string | null;
};

/** The name to show for a card: its nickname if set, else the volume label. */
export function cardDisplayName(c: { nickname: string | null; label: string }): string {
  return c.nickname && c.nickname.trim() ? c.nickname : c.label;
}

export type TileMeta = { thumb: string; name: string; isRaw: boolean; isVideo: boolean };

export type TimeBucket = { timeBucket: string; count: number };

type VerifyEventMsg =
  | { event: "files"; data: { files: CardFile[] } }
  | { event: "progress"; data: { phase: string; done: number; total: number } }
  | { event: "file"; data: { id: string; inImmich: boolean; immichId: string | null } };

export type VerifyCallbacks = {
  onFiles: (files: CardFile[]) => void;
  onFile: (id: string, inImmich: boolean, immichId: string | null) => void;
  onProgress?: (phase: string, done: number, total: number) => void;
};

export async function verifyCard(
  config: { serverUrl: string; sourcePath: string; uploadFilter: UploadFilter; force?: boolean },
  cb: VerifyCallbacks,
): Promise<VerifySummary> {
  const onEvent = new Channel<VerifyEventMsg>();
  onEvent.onmessage = (m) => {
    if (m.event === "files") cb.onFiles(m.data.files);
    else if (m.event === "file") cb.onFile(m.data.id, m.data.inImmich, m.data.immichId ?? null);
    else if (m.event === "progress") cb.onProgress?.(m.data.phase, m.data.done, m.data.total);
  };
  return invoke<VerifySummary>("verify_card", { config, onEvent });
}

export const localThumbnail = (path: string) => invoke<string>("local_thumbnail", { path });

export const immichTile = (serverUrl: string, assetId: string) =>
  invoke<TileMeta>("immich_tile", { serverUrl, assetId });

export const immichTimelineBuckets = (serverUrl: string) =>
  invoke<TimeBucket[]>("immich_timeline_buckets", { serverUrl });

export const immichTimelineBucket = (serverUrl: string, timeBucket: string) =>
  invoke<string[]>("immich_timeline_bucket", { serverUrl, timeBucket });

// ---- Cache / history ----

export const listRecentCards = () => invoke<CardHistory[]>("list_recent_cards");

export const clearCardCache = (cardId: string) =>
  invoke<void>("clear_card_cache", { cardId });

export const resolveCard = (sourcePath: string) =>
  invoke<CardRef>("resolve_card", { sourcePath });

export const setCardNickname = (cardId: string, nickname: string | null) =>
  invoke<void>("set_card_nickname", { cardId, nickname });

/** Relative "time ago" for a unix-seconds timestamp. */
export function timeAgo(unixSecs: number | null): string {
  if (!unixSecs) return "never";
  const diff = Date.now() / 1000 - unixSecs;
  if (diff < 60) return "just now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(unixSecs * 1000).toLocaleDateString();
}

/** Format badge text for a tile: "RAW" for raw, else the uppercased extension. */
export function badgeFor(name: string, isRaw: boolean): string {
  if (isRaw) return "RAW";
  const ext = name.split(".").pop();
  return ext ? ext.toUpperCase() : "IMG";
}
