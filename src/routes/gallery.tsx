import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Link, useLocation } from "react-router";
import {
  AlertTriangle,
  FolderOpen,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { PhotoTile } from "../components/tile.tsx";
import { useJobs } from "../lib/jobs.tsx";
import {
  badgeFor,
  cardDisplayName,
  clearCardCache,
  hasApiKey,
  immichTile,
  immichTimelineBucket,
  immichTimelineBuckets,
  listDrives,
  loadSettings,
  localThumbnail,
  resolveCard,
  setCardNickname,
  type CardRef,
  type DriveInfo,
  type Settings,
  type TimeBucket,
} from "../lib/immich.ts";

const GRID = "grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1";

type SortOrder = "newest" | "oldest";
type SyncFilter = "all" | "synced" | "unsynced";

const VERIFY_PHASE: Record<string, string> = {
  hash: "Hashing files",
  check: "Checking against Immich",
  done: "Done",
};

const SYNC_PHASE: Record<string, string> = {
  scan: "Scanning card",
  hash: "Hashing files",
  check: "Checking for duplicates",
  upload: "Uploading",
  stack: "Stacking RAW + JPEG",
  done: "Finishing up",
};

type Mode = "library" | "card";

export default function Gallery() {
  const location = useLocation();
  const initialSource = (location.state as { source?: string } | null)?.source ?? null;
  const jobs = useJobs();

  const [settings, setSettings] = useState<Settings | null>(null);
  const [configured, setConfigured] = useState(false);
  const [mode, setMode] = useState<Mode>(
    initialSource || jobs.verify.source || jobs.verify.running ? "card" : "library",
  );

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

  // Hand-off from Home's Verify button: start a verify for the passed card.
  useEffect(() => {
    if (initialSource && settings && !jobs.busy && jobs.verify.source !== initialSource) {
      setMode("card");
      jobs.startVerify({
        serverUrl: settings.serverUrl,
        sourcePath: initialSource,
        uploadFilter: settings.uploadFilter,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSource, settings]);

  if (settings && !configured) {
    return (
      <div className="mx-auto max-w-xl p-6 text-center">
        <UploadCloud className="mx-auto mb-3 opacity-60" size={40} />
        <h1 className="text-xl font-bold mb-2">Connect to Immich first</h1>
        <Link to="/settings" className="btn btn-primary">
          Open Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-2xl font-bold mr-auto">Gallery</h1>
        <div className="join">
          <button
            className={`btn join-item btn-sm ${mode === "library" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMode("library")}
          >
            Immich library
          </button>
          <button
            className={`btn join-item btn-sm ${mode === "card" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setMode("card")}
          >
            Card
          </button>
        </div>
      </div>

      {settings &&
        (mode === "library" ? (
          <LibraryView serverUrl={settings.serverUrl} />
        ) : (
          <CardView settings={settings} />
        ))}
    </div>
  );
}

// ---- Library mode ----

function LibraryView({ serverUrl }: { serverUrl: string }) {
  const [buckets, setBuckets] = useState<TimeBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverUrl) return;
    immichTimelineBuckets(serverUrl)
      .then(setBuckets)
      .catch((e) => setError(String(e)));
  }, [serverUrl]);

  if (error) {
    return (
      <div className="alert alert-error">
        <AlertTriangle size={18} />
        <span className="text-sm break-all">{error}</span>
      </div>
    );
  }
  if (!buckets) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="animate-spin opacity-50" />
      </div>
    );
  }
  if (buckets.length === 0) {
    return <p className="opacity-60 text-sm">No photos in your Immich library yet.</p>;
  }

  return (
    <>
      {buckets.map((b) => (
        <BucketSection key={b.timeBucket} serverUrl={serverUrl} bucket={b} />
      ))}
    </>
  );
}

function BucketSection({ serverUrl, bucket }: { serverUrl: string; bucket: TimeBucket }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ids, setIds] = useState<string[] | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !done) {
          done = true;
          io.disconnect();
          immichTimelineBucket(serverUrl, bucket.timeBucket)
            .then(setIds)
            .catch(() => setIds([]));
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [serverUrl, bucket.timeBucket]);

  const label = new Date(bucket.timeBucket).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });

  return (
    <section ref={ref} className="mb-5">
      <h3 className="mb-2 text-sm font-semibold opacity-70">
        {label} · {bucket.count}
      </h3>
      {ids === null ? (
        <div className={GRID}>
          {Array.from({ length: Math.min(bucket.count, 12) }).map((_, i) => (
            <div key={i} className="aspect-square animate-pulse rounded-md bg-base-300" />
          ))}
        </div>
      ) : (
        <div className={GRID}>
          {ids.map((id) => (
            <PhotoTile
              key={id}
              cloud="in"
              load={async () => {
                const t = await immichTile(serverUrl, id);
                return { src: t.thumb, badge: badgeFor(t.name, t.isRaw), isVideo: t.isVideo };
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---- Card mode (a view over the shared jobs.verify state, so it survives tab changes) ----

function CardView({ settings }: { settings: Settings }) {
  const jobs = useJobs();
  const v = jobs.verify;
  const source = v.source;

  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [force, setForce] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [syncFilter, setSyncFilter] = useState<SyncFilter>("all");
  const [cardRef, setCardRef] = useState<CardRef | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  // Resolve the card's identity + saved nickname whenever the source changes.
  useEffect(() => {
    setEditingName(false);
    if (source) resolveCard(source).then(setCardRef).catch(() => setCardRef(null));
    else setCardRef(null);
  }, [source]);

  const refreshDrives = useCallback(() => {
    listDrives()
      .then(setDrives)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshDrives();
  }, [refreshDrives]);

  function verify(src: string) {
    jobs.startVerify({
      serverUrl: settings.serverUrl,
      sourcePath: src,
      uploadFilter: settings.uploadFilter,
      force,
    });
  }

  async function saveName() {
    setEditingName(false);
    if (!cardRef) return;
    const name = nameDraft.trim();
    await setCardNickname(cardRef.cardId, name || null);
    setCardRef({ ...cardRef, nickname: name || null });
  }

  async function pickFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Choose SD card or folder" });
    if (typeof dir === "string") verify(dir);
  }

  async function syncMissing() {
    if (!source) return;
    await jobs.startSync({
      serverUrl: settings.serverUrl,
      deviceId: settings.deviceId,
      uploadFilter: settings.uploadFilter,
      stackMode: settings.stackMode,
      sourcePath: source,
      force,
    });
    // No re-verify needed — the grid's cloud icons update live as each file uploads.
  }

  async function clearCache() {
    if (!source) return;
    setClearing(true);
    try {
      const ref = cardRef ?? (await resolveCard(source));
      await clearCardCache(ref.cardId);
      verify(source);
    } catch (e) {
      console.error(e);
    } finally {
      setClearing(false);
    }
  }

  if (!source) {
    return (
      <div className="card bg-base-200">
        <div className="card-body gap-3">
          <div className="flex items-center justify-between">
            <h2 className="card-title text-base">Pick a card or folder to verify</h2>
            <button className="btn btn-ghost btn-xs" onClick={refreshDrives}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
          {drives.length === 0 ? (
            <p className="opacity-60 text-sm">No removable drives detected.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {drives.map((d) => (
                <li
                  key={d.mountPoint}
                  className="flex items-center justify-between rounded-lg bg-base-100 p-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <HardDrive size={20} className="shrink-0 opacity-70" />
                    <span className="truncate font-medium">{d.name || d.mountPoint}</span>
                  </div>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={jobs.busy}
                    onClick={() => verify(d.mountPoint)}
                  >
                    Verify
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            className="btn btn-outline btn-sm self-start"
            onClick={pickFolder}
            disabled={jobs.busy}
          >
            <FolderOpen size={16} /> Choose folder…
          </button>
        </div>
      </div>
    );
  }

  // Derive counts from the live cloud map so they update as verify/sync stream in.
  const missing = Object.values(v.cloud).filter((c) => c === "out").length;
  const inImmich = Object.values(v.cloud).filter((c) => c === "in").length;

  // Sort (by file mtime) + filter (by sync state) the grid. "unsynced" = anything not yet
  // confirmed in Immich, so it shrinks as verify streams confirmations in.
  const syncedCount = v.files.filter((f) => v.cloud[f.id] === "in").length;
  const unsyncedCount = v.files.length - syncedCount;
  const visibleFiles = (() => {
    let fs = v.files;
    if (syncFilter === "synced") fs = fs.filter((f) => v.cloud[f.id] === "in");
    else if (syncFilter === "unsynced") fs = fs.filter((f) => v.cloud[f.id] !== "in");
    return [...fs].sort((a, b) => (sortOrder === "newest" ? b.mtime - a.mtime : a.mtime - b.mtime));
  })();

  const syncing = jobs.sync.running;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="text-sm min-w-0">
          <div className="flex items-center gap-1">
            {editingName ? (
              <input
                autoFocus
                className="input input-xs input-bordered"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setEditingName(false);
                }}
              />
            ) : (
              <>
                <span className="font-medium truncate">
                  {cardRef ? cardDisplayName(cardRef) : source}
                </span>
                {cardRef && (
                  <button
                    className="btn btn-ghost btn-xs px-1"
                    title="Rename card"
                    onClick={() => {
                      setNameDraft(cardRef.nickname ?? "");
                      setEditingName(true);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                )}
              </>
            )}
          </div>
          <div className="text-xs opacity-60 truncate">
            {v.files.length} files · {inImmich} in Immich · {missing} to upload
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="label cursor-pointer gap-1 text-xs">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={force}
              disabled={jobs.busy}
              onChange={(e) => setForce(e.target.checked)}
            />
            Re-check everything
          </label>
          <button
            className="btn btn-ghost btn-sm"
            onClick={clearCache}
            disabled={jobs.busy || clearing}
            title="Clear this card's cache"
          >
            {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => jobs.clearVerify()} disabled={jobs.busy}>
            Change
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={syncMissing}
            disabled={jobs.busy || missing === 0}
          >
            {syncing ? <Loader2 size={14} className="animate-spin" /> : null}
            {syncing ? "Syncing…" : `Sync missing${missing ? ` (${missing})` : ""}`}
          </button>
        </div>
      </div>

      {v.running && (
        <div className="mb-3 rounded-lg bg-base-200 p-3">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Loader2 size={14} className="animate-spin" />
              {v.progress ? (VERIFY_PHASE[v.progress.phase] ?? "Verifying") : "Scanning card…"}
            </span>
            {v.progress && v.progress.total > 0 && (
              <span className="opacity-60">
                {v.progress.done} / {v.progress.total}
              </span>
            )}
          </div>
          {v.progress && v.progress.total > 0 ? (
            <progress
              className="progress progress-primary w-full"
              value={v.progress.done}
              max={v.progress.total}
            />
          ) : (
            <progress className="progress progress-primary w-full" />
          )}
          <div className="mt-1 text-xs opacity-60">
            {inImmich} in Immich · {missing} to upload
          </div>
        </div>
      )}

      {syncing && (
        <div className="mb-3 rounded-lg bg-base-200 p-3">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Loader2 size={14} className="animate-spin" />
              {jobs.sync.progress ? (SYNC_PHASE[jobs.sync.progress.phase] ?? "Syncing") : "Starting…"}
            </span>
            {jobs.sync.progress && jobs.sync.progress.total > 0 && (
              <span className="opacity-60">
                {jobs.sync.progress.done} / {jobs.sync.progress.total}
              </span>
            )}
          </div>
          {jobs.sync.progress && jobs.sync.progress.total > 0 ? (
            <progress
              className="progress progress-primary w-full"
              value={jobs.sync.progress.done}
              max={jobs.sync.progress.total}
            />
          ) : (
            <progress className="progress progress-primary w-full" />
          )}
          <div className="mt-1 text-xs opacity-60">
            {inImmich} in Immich · {missing} to upload
          </div>
        </div>
      )}

      {v.error && (
        <div className="alert alert-error mb-3">
          <AlertTriangle size={18} />
          <span className="text-sm break-all">{v.error}</span>
        </div>
      )}

      {/* Sort + filter toolbar */}
      {v.files.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="join">
            {(
              [
                ["all", "All", v.files.length],
                ["synced", "Synced", syncedCount],
                ["unsynced", "Unsynced", unsyncedCount],
              ] as [SyncFilter, string, number][]
            ).map(([key, label, count]) => (
              <button
                key={key}
                className={`btn btn-xs join-item ${syncFilter === key ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setSyncFilter(key)}
              >
                {label} <span className="opacity-60">{count}</span>
              </button>
            ))}
          </div>
          <div className="join ml-auto">
            {(
              [
                ["newest", "Newest"],
                ["oldest", "Oldest"],
              ] as [SortOrder, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className={`btn btn-xs join-item ${sortOrder === key ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setSortOrder(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {v.files.length === 0 && !v.running ? (
        <p className="opacity-60 text-sm">No matching files on this source (check the upload filter).</p>
      ) : visibleFiles.length === 0 ? (
        <p className="opacity-60 text-sm">
          No {syncFilter} files{v.running ? " yet — still checking…" : ""}.
        </p>
      ) : (
        <div className={GRID}>
          {visibleFiles.map((f) => (
            <PhotoTile
              key={f.id}
              badge={f.kind === "raw" ? "RAW" : badgeFor(f.name, false)}
              isVideo={f.kind === "video"}
              cloud={v.cloud[f.id] ?? "checking"}
              load={async () => ({ src: await localThumbnail(f.path) })}
            />
          ))}
        </div>
      )}
    </>
  );
}
