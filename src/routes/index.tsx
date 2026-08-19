import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Link, useNavigate } from "react-router";
import {
  AlertTriangle,
  Check,
  FilePlus2,
  FolderOpen,
  HardDrive,
  History,
  Pencil,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useJobs } from "../lib/jobs.tsx";
import {
  cardDisplayName,
  clearCardCache,
  formatBytes,
  hasApiKey,
  listDrives,
  listRecentCards,
  loadSettings,
  saveSettings,
  setCardNickname,
  sidecarStatus,
  timeAgo,
  writeSidecarFile,
  type CardHistory,
  type DriveInfo,
  type Settings,
  type SidecarStatus,
  type Summary,
  type SyncProgress,
} from "../lib/immich";

const PHASE_LABEL: Record<SyncProgress["phase"], string> = {
  scan: "Scanning card",
  hash: "Hashing files",
  check: "Checking for duplicates",
  upload: "Uploading",
  stack: "Stacking RAW + JPEG",
  done: "Finishing up",
};

export default function Home() {
  const jobs = useJobs();
  const sync = jobs.sync;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [configured, setConfigured] = useState(false);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [force, setForce] = useState(false);
  const [recent, setRecent] = useState<CardHistory[]>([]);
  const [editingCard, setEditingCard] = useState<string | null>(null);
  const [cardNameDraft, setCardNameDraft] = useState("");
  const [sidecarMap, setSidecarMap] = useState<Record<string, SidecarStatus>>({});
  const [sidecarError, setSidecarError] = useState<string | null>(null);
  const navigate = useNavigate();

  const refreshRecent = useCallback(() => {
    listRecentCards()
      .then(setRecent)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  // Fetch sidecar status for recent cards that are currently inserted.
  useEffect(() => {
    for (const c of recent) {
      const mounted = drives.find((d) => d.mountPoint === c.mountPoint);
      if (mounted) {
        sidecarStatus(mounted.mountPoint)
          .then((st) => setSidecarMap((m) => ({ ...m, [c.cardId]: st })))
          .catch(() => {});
      }
    }
  }, [recent, drives]);

  useEffect(() => {
    loadSettings().then(async (s) => {
      setSettings(s);
      if (s.serverUrl) {
        try {
          setConfigured(await hasApiKey(s.serverUrl));
        } catch {
          setConfigured(false);
        }
      }
    });
  }, []);

  const refreshDrives = useCallback(() => {
    listDrives()
      .then(setDrives)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshDrives();
    const id = setInterval(refreshDrives, 3000);
    return () => clearInterval(id);
  }, [refreshDrives]);

  const runSync = useCallback(
    async (sourcePath: string) => {
      if (!settings || jobs.busy) return;
      await jobs.startSync({
        serverUrl: settings.serverUrl,
        deviceId: settings.deviceId,
        uploadFilter: settings.uploadFilter,
        stackMode: settings.stackMode,
        sourcePath,
        force,
      });
      refreshRecent();
    },
    [settings, force, jobs, refreshRecent],
  );

  async function pickFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Choose SD card or folder" });
    if (typeof dir === "string") runSync(dir);
  }

  async function saveCardName(cardId: string) {
    setEditingCard(null);
    const name = cardNameDraft.trim();
    await setCardNickname(cardId, name || null);
    refreshRecent();
  }

  async function addSidecar(mountPoint: string, provisionalId: string) {
    if (!settings) return;
    setSidecarError(null);
    try {
      await writeSidecarFile(mountPoint, settings.serverUrl);
      // If the card was previously declined, clear it so future syncs write silently.
      const s = await loadSettings();
      if (s.sidecarDeclined.includes(provisionalId)) {
        await saveSettings({
          sidecarDeclined: s.sidecarDeclined.filter((x) => x !== provisionalId),
        });
      }
      refreshRecent();
    } catch (e) {
      setSidecarError(String(e));
    }
  }

  if (settings && !configured) {
    return (
      <div className="mx-auto max-w-xl p-6 text-center">
        <UploadCloud className="mx-auto mb-3 opacity-60" size={40} />
        <h1 className="text-xl font-bold mb-2">Connect to Immich first</h1>
        <p className="opacity-70 mb-4">
          Add your server URL and API key so sd2immich knows where to upload.
        </p>
        <Link to="/settings" className="btn btn-primary">
          Open Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl p-4">
      <h1 className="text-2xl font-bold mb-4">Sync photos</h1>

      {/* Detected cards */}
      <div className="card bg-base-200 mb-4">
        <div className="card-body gap-3">
          <div className="flex items-center justify-between">
            <h2 className="card-title text-base">Detected cards</h2>
            <button className="btn btn-ghost btn-xs" onClick={refreshDrives} disabled={jobs.busy}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>

          {drives.length === 0 ? (
            <p className="opacity-60 text-sm">
              No removable drives detected. Insert a card, or choose a folder below.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {drives.map((d) => (
                <li
                  key={d.mountPoint}
                  className="flex items-center justify-between rounded-lg bg-base-100 p-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <HardDrive size={20} className="shrink-0 opacity-70" />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.name || d.mountPoint}</div>
                      <div className="text-xs opacity-60 truncate">
                        {d.mountPoint} · {formatBytes(d.availableBytes)} free of{" "}
                        {formatBytes(d.totalBytes)}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={jobs.busy}
                      onClick={() => navigate("/gallery", { state: { source: d.mountPoint } })}
                    >
                      Verify
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={jobs.busy}
                      onClick={() => runSync(d.mountPoint)}
                    >
                      Sync
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between">
            <button className="btn btn-outline btn-sm" onClick={pickFolder} disabled={jobs.busy}>
              <FolderOpen size={16} /> Choose folder…
            </button>
            <label className="label cursor-pointer gap-2 text-xs">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={force}
                disabled={jobs.busy}
                onChange={(e) => setForce(e.target.checked)}
              />
              Re-check everything
            </label>
          </div>
        </div>
      </div>

      {/* Progress (persists across tab changes via the jobs context) */}
      {sync.running && (
        <div className="card bg-base-200 mb-4">
          <div className="card-body gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {sync.progress ? PHASE_LABEL[sync.progress.phase] : "Starting…"}
              </span>
              {sync.progress && sync.progress.total > 0 && (
                <span className="opacity-60">
                  {sync.progress.done} / {sync.progress.total}
                </span>
              )}
            </div>
            {sync.progress && sync.progress.total > 0 ? (
              <progress
                className="progress progress-primary w-full"
                value={sync.progress.done}
                max={sync.progress.total}
              />
            ) : (
              <progress className="progress progress-primary w-full" />
            )}
            {sync.progress?.current && (
              <div className="text-xs opacity-60 truncate">{sync.progress.current}</div>
            )}
            {sync.source && <div className="text-xs opacity-50 truncate">from {sync.source}</div>}
          </div>
        </div>
      )}

      {/* Error */}
      {sync.error && (
        <div className="alert alert-error mb-4">
          <AlertTriangle size={18} />
          <span className="text-sm break-all">{sync.error}</span>
        </div>
      )}

      {/* Summary */}
      {sync.summary && !sync.running && <SummaryCard summary={sync.summary} />}

      {/* Recent cards */}
      {recent.length > 0 && (
        <div className="card bg-base-200 mt-4">
          <div className="card-body gap-3">
            <h2 className="card-title text-base flex items-center gap-2">
              <History size={16} /> Recent cards
            </h2>
            {sidecarError && (
              <div className="alert alert-error text-sm">
                <AlertTriangle size={16} />
                <span className="break-all">{sidecarError}</span>
              </div>
            )}
            <ul className="flex flex-col gap-2">
              {recent.map((c) => {
                const mounted = drives.find((d) => d.mountPoint === c.mountPoint);
                return (
                  <li
                    key={c.cardId}
                    className="flex items-center justify-between rounded-lg bg-base-100 p-3"
                  >
                    <div className="min-w-0">
                      {editingCard === c.cardId ? (
                        <input
                          autoFocus
                          className="input input-xs input-bordered w-44"
                          value={cardNameDraft}
                          onChange={(e) => setCardNameDraft(e.target.value)}
                          onBlur={() => saveCardName(c.cardId)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                            if (e.key === "Escape") setEditingCard(null);
                          }}
                        />
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="truncate font-medium">{cardDisplayName(c)}</span>
                          <button
                            className="btn btn-ghost btn-xs px-1"
                            title="Rename card"
                            onClick={() => {
                              setCardNameDraft(c.nickname ?? "");
                              setEditingCard(c.cardId);
                            }}
                          >
                            <Pencil size={12} />
                          </button>
                        </div>
                      )}
                      <div className="text-xs opacity-60 truncate">
                        {c.inImmich}/{c.files} in Immich · synced {timeAgo(c.lastSynced)}
                        {mounted ? " · inserted" : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {mounted && sidecarMap[c.cardId] && (
                        <SidecarBadge
                          status={sidecarMap[c.cardId]}
                          onWrite={() =>
                            addSidecar(mounted.mountPoint, sidecarMap[c.cardId].provisionalId)
                          }
                        />
                      )}
                      {mounted && (
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={jobs.busy}
                          onClick={() =>
                            navigate("/gallery", { state: { source: mounted.mountPoint } })
                          }
                        >
                          Verify
                        </button>
                      )}
                      <button
                        className="btn btn-ghost btn-sm"
                        title="Clear this card's cache"
                        disabled={jobs.busy}
                        onClick={async () => {
                          await clearCardCache(c.cardId);
                          refreshRecent();
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function SidecarBadge({ status, onWrite }: { status: SidecarStatus; onWrite: () => void }) {
  if (status.hasSidecar) {
    return (
      <span className="badge badge-success badge-sm gap-1" title="Sync file is on this card">
        <Check size={12} /> on card
      </span>
    );
  }
  if (status.fileExists) {
    return (
      <button
        className="badge badge-warning badge-sm gap-1"
        title="Sync file is corrupt — rewrite it"
        onClick={onWrite}
      >
        <AlertTriangle size={12} /> repair
      </button>
    );
  }
  if (status.writable) {
    return (
      <button
        className="badge badge-ghost badge-sm gap-1"
        title="Add the sync file to this card"
        onClick={onWrite}
      >
        <FilePlus2 size={12} /> add file
      </button>
    );
  }
  return (
    <span className="badge badge-ghost badge-sm opacity-60" title="Card is read-only">
      read-only
    </span>
  );
}

function SummaryCard({ summary }: { summary: Summary }) {
  const stats: { label: string; value: number; accent?: string }[] = [
    { label: "Uploaded", value: summary.uploaded, accent: "text-success" },
    { label: "Already in Immich", value: summary.alreadyInImmich },
    { label: "Skipped (cached)", value: summary.skippedCached },
    { label: "Stacked", value: summary.stacked },
    { label: "Skipped (filter)", value: summary.skippedFilter },
    { label: "Scanned", value: summary.scanned },
    { label: "Errors", value: summary.errors, accent: summary.errors ? "text-error" : undefined },
  ];
  return (
    <div className="card bg-base-200">
      <div className="card-body gap-3">
        <h2 className="card-title text-base">Done</h2>
        <div className="grid grid-cols-3 gap-2">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg bg-base-100 p-3 text-center">
              <div className={`text-2xl font-bold ${s.accent ?? ""}`}>{s.value}</div>
              <div className="text-xs opacity-60">{s.label}</div>
            </div>
          ))}
        </div>
        {summary.errorMessages.length > 0 && (
          <details className="collapse collapse-arrow bg-base-100">
            <summary className="collapse-title text-sm text-error">
              {summary.errorMessages.length} error(s)
            </summary>
            <div className="collapse-content">
              <ul className="text-xs opacity-70 list-disc pl-4 space-y-1">
                {summary.errorMessages.slice(0, 50).map((m, i) => (
                  <li key={i} className="break-all">
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
