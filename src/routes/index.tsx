import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Link, useNavigate } from "react-router";
import { AlertTriangle, FolderOpen, HardDrive, History, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import {
  clearCardCache,
  formatBytes,
  hasApiKey,
  listDrives,
  listRecentCards,
  loadSettings,
  startSync,
  timeAgo,
  type CardHistory,
  type DriveInfo,
  type Settings,
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
  const [settings, setSettings] = useState<Settings | null>(null);
  const [configured, setConfigured] = useState(false);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [force, setForce] = useState(false);
  const [recent, setRecent] = useState<CardHistory[]>([]);
  const syncingRef = useRef(false);
  const navigate = useNavigate();

  const refreshRecent = useCallback(() => {
    listRecentCards()
      .then(setRecent)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

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
      if (syncingRef.current || !settings) return;
      syncingRef.current = true;
      setSyncing(true);
      setSummary(null);
      setError(null);
      setProgress(null);
      setSource(sourcePath);
      try {
        const result = await startSync(
          {
            serverUrl: settings.serverUrl,
            deviceId: settings.deviceId,
            uploadFilter: settings.uploadFilter,
            stackMode: settings.stackMode,
            sourcePath,
            force,
          },
          setProgress,
        );
        setSummary(result);
      } catch (e) {
        setError(String(e));
      } finally {
        syncingRef.current = false;
        setSyncing(false);
        setProgress(null);
        refreshRecent();
      }
    },
    [settings, force, refreshRecent],
  );

  async function pickFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Choose SD card or folder" });
    if (typeof dir === "string") runSync(dir);
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
            <button className="btn btn-ghost btn-xs" onClick={refreshDrives} disabled={syncing}>
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
                      disabled={syncing}
                      onClick={() => navigate("/gallery", { state: { source: d.mountPoint } })}
                    >
                      Verify
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={syncing}
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
            <button className="btn btn-outline btn-sm" onClick={pickFolder} disabled={syncing}>
              <FolderOpen size={16} /> Choose folder…
            </button>
            <label className="label cursor-pointer gap-2 text-xs">
              <input
                type="checkbox"
                className="checkbox checkbox-xs"
                checked={force}
                disabled={syncing}
                onChange={(e) => setForce(e.target.checked)}
              />
              Re-check everything
            </label>
          </div>
        </div>
      </div>

      {/* Progress */}
      {syncing && (
        <div className="card bg-base-200 mb-4">
          <div className="card-body gap-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {progress ? PHASE_LABEL[progress.phase] : "Starting…"}
              </span>
              {progress && progress.total > 0 && (
                <span className="opacity-60">
                  {progress.done} / {progress.total}
                </span>
              )}
            </div>
            {progress && progress.total > 0 ? (
              <progress
                className="progress progress-primary w-full"
                value={progress.done}
                max={progress.total}
              />
            ) : (
              <progress className="progress progress-primary w-full" />
            )}
            {progress?.current && <div className="text-xs opacity-60 truncate">{progress.current}</div>}
            {source && <div className="text-xs opacity-50 truncate">from {source}</div>}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="alert alert-error mb-4">
          <AlertTriangle size={18} />
          <span className="text-sm break-all">{error}</span>
        </div>
      )}

      {/* Summary */}
      {summary && !syncing && <SummaryCard summary={summary} />}

      {/* Recent cards */}
      {recent.length > 0 && (
        <div className="card bg-base-200 mt-4">
          <div className="card-body gap-3">
            <h2 className="card-title text-base flex items-center gap-2">
              <History size={16} /> Recent cards
            </h2>
            <ul className="flex flex-col gap-2">
              {recent.map((c) => {
                const mounted = drives.find((d) => d.mountPoint === c.mountPoint);
                return (
                  <li
                    key={c.cardId}
                    className="flex items-center justify-between rounded-lg bg-base-100 p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.label}</div>
                      <div className="text-xs opacity-60 truncate">
                        {c.inImmich}/{c.files} in Immich · synced {timeAgo(c.lastSynced)}
                        {mounted ? " · inserted" : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {mounted && (
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={syncing}
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
                        disabled={syncing}
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
