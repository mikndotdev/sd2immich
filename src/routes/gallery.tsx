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
import { PhotoTile, type CloudState } from "../components/tile.tsx";
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
  startSync,
  verifyCard,
  type CardFile,
  type CardRef,
  type DriveInfo,
  type Settings,
  type TimeBucket,
  type VerifySummary,
} from "../lib/immich.ts";

const GRID = "grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1";

type SortOrder = "newest" | "oldest";
type SyncFilter = "all" | "synced" | "unsynced";

const VERIFY_PHASE: Record<string, string> = {
  hash: "Hashing files",
  check: "Checking against Immich",
  done: "Done",
};

type Progress = { phase: string; done: number; total: number };

type Mode = "library" | "card";

export default function Gallery() {
  const location = useLocation();
  const initialSource = (location.state as { source?: string } | null)?.source ?? null;

  const [settings, setSettings] = useState<Settings | null>(null);
  const [configured, setConfigured] = useState(false);
  const [mode, setMode] = useState<Mode>(initialSource ? "card" : "library");
  const [source, setSource] = useState<string | null>(initialSource);

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
          <CardView settings={settings} source={source} setSource={setSource} />
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

// ---- Card mode ----

function CardView({
  settings,
  source,
  setSource,
}: {
  settings: Settings;
  source: string | null;
  setSource: (s: string | null) => void;
}) {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [files, setFiles] = useState<CardFile[]>([]);
  const [cloud, setCloud] = useState<Record<string, CloudState>>({});
  const [summary, setSummary] = useState<VerifySummary | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [force, setForceState] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const [syncFilter, setSyncFilter] = useState<SyncFilter>("all");
  const [cardRef, setCardRef] = useState<CardRef | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const verifyingRef = useRef(false);

  // Resolve the card's identity + saved nickname whenever the source changes.
  useEffect(() => {
    setEditingName(false);
    if (source) resolveCard(source).then(setCardRef).catch(() => setCardRef(null));
    else setCardRef(null);
  }, [source]);

  async function saveName() {
    setEditingName(false);
    if (!cardRef) return;
    const name = nameDraft.trim();
    await setCardNickname(cardRef.cardId, name || null);
    setCardRef({ ...cardRef, nickname: name || null });
  }
  const forceRef = useRef(false);
  const setForce = (v: boolean) => {
    forceRef.current = v;
    setForceState(v);
  };

  const refreshDrives = useCallback(() => {
    listDrives()
      .then(setDrives)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshDrives();
  }, [refreshDrives]);

  const verify = useCallback(
    async (src: string) => {
      if (verifyingRef.current) return;
      verifyingRef.current = true;
      setVerifying(true);
      setFiles([]);
      setCloud({});
      setSummary(null);
      setProgress(null);
      setError(null);
      try {
        const result = await verifyCard(
          {
            serverUrl: settings.serverUrl,
            sourcePath: src,
            uploadFilter: settings.uploadFilter,
            force: forceRef.current,
          },
          {
            onFiles: (fs) => {
              setFiles(fs);
              // Instant paint: trust cached "in Immich"; everything else is still "checking".
              setCloud(
                Object.fromEntries(
                  fs.map((f) => [f.id, (f.cachedInImmich ? "in" : "checking") as CloudState]),
                ),
              );
            },
            onFile: (id, inImmich) =>
              setCloud((c) => ({ ...c, [id]: inImmich ? "in" : "out" })),
            onProgress: (phase, done, total) => setProgress({ phase, done, total }),
          },
        );
        setSummary(result);
      } catch (e) {
        setError(String(e));
      } finally {
        verifyingRef.current = false;
        setVerifying(false);
        setProgress(null);
      }
    },
    [settings],
  );

  // Auto-verify when a source is set (e.g. handed over from Home's Verify button).
  useEffect(() => {
    if (source) verify(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  async function pickFolder() {
    const dir = await open({ directory: true, multiple: false, title: "Choose SD card or folder" });
    if (typeof dir === "string") setSource(dir);
  }

  async function syncMissing() {
    if (!source) return;
    setSyncMsg("Starting…");
    try {
      await startSync(
        {
          serverUrl: settings.serverUrl,
          deviceId: settings.deviceId,
          uploadFilter: settings.uploadFilter,
          stackMode: settings.stackMode,
          sourcePath: source,
          force: forceRef.current,
        },
        (p) => setSyncMsg(p.total > 0 ? `${p.phase} ${p.done}/${p.total}` : p.phase),
      );
      setSyncMsg(null);
      await verify(source); // refresh cloud state
    } catch (e) {
      setError(String(e));
      setSyncMsg(null);
    }
  }

  async function clearCache() {
    if (!source) return;
    setClearing(true);
    try {
      const ref = cardRef ?? (await resolveCard(source));
      await clearCardCache(ref.cardId);
      await verify(source);
    } catch (e) {
      setError(String(e));
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
                  <button className="btn btn-primary btn-sm" onClick={() => setSource(d.mountPoint)}>
                    Verify
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-outline btn-sm self-start" onClick={pickFolder}>
            <FolderOpen size={16} /> Choose folder…
          </button>
        </div>
      </div>
    );
  }

  const missing = summary?.missing ?? Object.values(cloud).filter((c) => c === "out").length;
  const inImmich = summary?.inImmich ?? Object.values(cloud).filter((c) => c === "in").length;

  // Sort (by file mtime) + filter (by sync state) the grid. "unsynced" = anything not yet
  // confirmed in Immich, so it shrinks as verify streams confirmations in.
  const syncedCount = files.filter((f) => cloud[f.id] === "in").length;
  const unsyncedCount = files.length - syncedCount;
  const visibleFiles = (() => {
    let fs = files;
    if (syncFilter === "synced") fs = fs.filter((f) => cloud[f.id] === "in");
    else if (syncFilter === "unsynced") fs = fs.filter((f) => cloud[f.id] !== "in");
    return [...fs].sort((a, b) =>
      sortOrder === "newest" ? b.mtime - a.mtime : a.mtime - b.mtime,
    );
  })();

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
            {files.length} files · {inImmich} in Immich · {missing} to upload
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="label cursor-pointer gap-1 text-xs">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={force}
              disabled={verifying}
              onChange={(e) => setForce(e.target.checked)}
            />
            Re-check everything
          </label>
          <button
            className="btn btn-ghost btn-sm"
            onClick={clearCache}
            disabled={verifying || clearing}
            title="Clear this card's cache"
          >
            {clearing ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSource(null)} disabled={verifying}>
            Change
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={syncMissing}
            disabled={verifying || syncMsg !== null || missing === 0}
          >
            {syncMsg ? <Loader2 size={14} className="animate-spin" /> : null}
            {syncMsg ?? `Sync missing${missing ? ` (${missing})` : ""}`}
          </button>
        </div>
      </div>

      {verifying && (
        <div className="mb-3 rounded-lg bg-base-200 p-3">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Loader2 size={14} className="animate-spin" />
              {progress ? (VERIFY_PHASE[progress.phase] ?? "Verifying") : "Scanning card…"}
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
          <div className="mt-1 text-xs opacity-60">
            {inImmich} in Immich · {missing} to upload
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error mb-3">
          <AlertTriangle size={18} />
          <span className="text-sm break-all">{error}</span>
        </div>
      )}

      {/* Sort + filter toolbar */}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="join">
            {(
              [
                ["all", "All", files.length],
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

      {files.length === 0 && !verifying ? (
        <p className="opacity-60 text-sm">No matching files on this source (check the upload filter).</p>
      ) : visibleFiles.length === 0 ? (
        <p className="opacity-60 text-sm">
          No {syncFilter} files{verifying ? " yet — still checking…" : ""}.
        </p>
      ) : (
        <div className={GRID}>
          {visibleFiles.map((f) => (
            <PhotoTile
              key={f.id}
              badge={f.kind === "raw" ? "RAW" : badgeFor(f.name, false)}
              isVideo={f.kind === "video"}
              cloud={cloud[f.id] ?? "checking"}
              load={async () => ({ src: await localThumbnail(f.path) })}
            />
          ))}
        </div>
      )}
    </>
  );
}
