// App-level job context. Sync/verify run here (not in a route component) so the Tauri Channel and
// their progress survive tab changes — the Rust task keeps running and the UI keeps reflecting it.
// One job at a time. On completion, notify + bounce the dock, but only when the window is unfocused.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import {
  loadSettings,
  saveSettings,
  sidecarStatus,
  startSync as invokeSync,
  verifyCard,
  type CardFile,
  type CloudState,
  type StartSyncConfig,
  type Summary,
  type SyncProgress,
  type UploadFilter,
  type VerifySummary,
} from "./immich.ts";

type VerifyProgress = { phase: string; done: number; total: number };

type SyncState = {
  running: boolean;
  source: string | null;
  label: string | null;
  progress: SyncProgress | null;
  summary: Summary | null;
  error: string | null;
};

type VerifyState = {
  running: boolean;
  source: string | null;
  files: CardFile[];
  cloud: Record<string, CloudState>;
  progress: VerifyProgress | null;
  summary: VerifySummary | null;
  error: string | null;
};

type VerifyConfig = { serverUrl: string; sourcePath: string; uploadFilter: UploadFilter; force?: boolean };

type JobsCtx = {
  sync: SyncState;
  verify: VerifyState;
  busy: boolean;
  startSync: (config: StartSyncConfig, label?: string) => Promise<Summary | null>;
  startVerify: (config: VerifyConfig) => Promise<void>;
  clearVerify: () => void;
};

const IDLE_SYNC: SyncState = {
  running: false,
  source: null,
  label: null,
  progress: null,
  summary: null,
  error: null,
};
const IDLE_VERIFY: VerifyState = {
  running: false,
  source: null,
  files: [],
  cloud: {},
  progress: null,
  summary: null,
  error: null,
};

const Ctx = createContext<JobsCtx | null>(null);

/**
 * Per-card consent for writing the sd2i.data sidecar. Returns whether the backend should write it.
 * Prompts (native dialog) the first time a writable card lacks a sidecar; remembers a decline.
 */
async function resolveSidecarConsent(sourcePath: string): Promise<boolean> {
  try {
    const s = await loadSettings();
    if (!s.writeSidecar) return false;
    const status = await sidecarStatus(sourcePath);
    if (status.hasSidecar) return true; // already present ⇒ already consented
    if (!status.writable) return false; // read-only card
    if (s.sidecarDeclined.includes(status.provisionalId)) return false;
    const ok = await ask(
      "sd2immich will add a small sd2i.data file to this card so its sync status follows the card between computers. Add it?",
      { title: "Add file to card?", kind: "info" },
    );
    if (!ok) {
      await saveSettings({ sidecarDeclined: [...s.sidecarDeclined, status.provisionalId] });
    }
    return ok;
  } catch {
    return false;
  }
}

/** Fire a completion notification + one dock bounce — only if the window isn't focused. */
async function notifyDone(title: string, body: string) {
  try {
    const win = getCurrentWindow();
    if (await win.isFocused()) return;
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
    await win.requestUserAttention(UserAttentionType.Informational);
  } catch {
    /* notifications are best-effort */
  }
}

export function JobsProvider({ children }: { children: ReactNode }) {
  const [sync, setSync] = useState<SyncState>(IDLE_SYNC);
  const [verify, setVerify] = useState<VerifyState>(IDLE_VERIFY);
  const busyRef = useRef(false); // guards against overlapping starts (state updates are async)

  const startSync = useCallback(async (config: StartSyncConfig, label?: string) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    const writeSidecar = await resolveSidecarConsent(config.sourcePath);
    setSync({ ...IDLE_SYNC, running: true, source: config.sourcePath, label: label ?? null });
    try {
      const summary = await invokeSync(
        { ...config, writeSidecar },
        (p) => setSync((s) => ({ ...s, progress: p })),
        (id, inImmich) =>
          setVerify((v) =>
            v.source === config.sourcePath
              ? { ...v, cloud: { ...v.cloud, [id]: inImmich ? "in" : "out" } }
              : v,
          ),
      );
      setSync((s) => ({ ...s, running: false, progress: null, summary }));
      notifyDone(
        "Sync complete",
        `Uploaded ${summary.uploaded} · ${summary.alreadyInImmich} already in Immich` +
          (summary.errors ? ` · ${summary.errors} errors` : ""),
      );
      return summary;
    } catch (e) {
      setSync((s) => ({ ...s, running: false, progress: null, error: String(e) }));
      return null;
    } finally {
      busyRef.current = false;
    }
  }, []);

  const startVerify = useCallback(async (config: VerifyConfig) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const writeSidecar = await resolveSidecarConsent(config.sourcePath);
    setVerify({ ...IDLE_VERIFY, running: true, source: config.sourcePath });
    try {
      const summary = await verifyCard({ ...config, writeSidecar }, {
        onFiles: (fs) =>
          setVerify((v) => ({
            ...v,
            files: fs,
            cloud: Object.fromEntries(
              fs.map((f) => [f.id, (f.cachedInImmich ? "in" : "checking") as CloudState]),
            ),
          })),
        onFile: (id, inImmich) =>
          setVerify((v) => ({ ...v, cloud: { ...v.cloud, [id]: inImmich ? "in" : "out" } })),
        onProgress: (phase, done, total) => setVerify((v) => ({ ...v, progress: { phase, done, total } })),
      });
      setVerify((v) => ({ ...v, running: false, progress: null, summary }));
      notifyDone("Verify complete", `${summary.inImmich} in Immich · ${summary.missing} to upload`);
    } catch (e) {
      setVerify((v) => ({ ...v, running: false, progress: null, error: String(e) }));
    } finally {
      busyRef.current = false;
    }
  }, []);

  const clearVerify = useCallback(() => {
    if (busyRef.current && verify.running) return; // don't yank a running verify
    setVerify(IDLE_VERIFY);
  }, [verify.running]);

  const busy = sync.running || verify.running;

  return (
    <Ctx.Provider value={{ sync, verify, busy, startSync, startVerify, clearVerify }}>
      {children}
    </Ctx.Provider>
  );
}

export function useJobs(): JobsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useJobs must be used within <JobsProvider>");
  return ctx;
}
