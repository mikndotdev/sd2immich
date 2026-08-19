import { useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, Pencil, Plus, Server, Trash2, XCircle } from "lucide-react";
import {
  deleteApiKey,
  hasApiKey,
  loadSettings,
  saveSettings,
  setApiKey,
  testConnection,
  type StackMode,
  type TestResult,
  type UploadFilter,
} from "../lib/immich";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; result: TestResult }
  | { kind: "error"; message: string };

const FILTERS: { value: UploadFilter; label: string }[] = [
  { value: "raw", label: "RAW only" },
  { value: "image", label: "JPEG only" },
  { value: "both", label: "Both RAW and JPEG" },
];

export default function SettingsPage() {
  const [serverUrl, setServerUrl] = useState(""); // active instance
  const [instances, setInstances] = useState<string[]>([]);
  const [keyed, setKeyed] = useState<Record<string, boolean>>({});
  const [uploadFilter, setUploadFilter] = useState<UploadFilter>("both");
  const [stackMode, setStackMode] = useState<StackMode>("off");
  const [writeSidecar, setWriteSidecar] = useState(true);

  // Add/Edit-server modal.
  const modalRef = useRef<HTMLDialogElement>(null);
  const [editingUrl, setEditingUrl] = useState<string | null>(null); // null = adding new
  const [draftUrl, setDraftUrl] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  useEffect(() => {
    loadSettings().then((s) => {
      setServerUrl(s.serverUrl);
      setInstances(s.instances);
      setUploadFilter(s.uploadFilter);
      setStackMode(s.stackMode);
      setWriteSidecar(s.writeSidecar);
      setWriteSidecar(s.writeSidecar);
      for (const url of s.instances) {
        hasApiKey(url)
          .then((has) => setKeyed((k) => ({ ...k, [url]: has })))
          .catch(() => {});
      }
    });
  }, []);

  // ---- Auto-saving mutations ----

  async function selectActive(url: string) {
    setServerUrl(url);
    await saveSettings({ serverUrl: url });
  }

  async function updateFilter(f: UploadFilter) {
    setUploadFilter(f);
    await saveSettings({ uploadFilter: f });
  }

  async function updateStack(m: StackMode) {
    setStackMode(m);
    await saveSettings({ stackMode: m });
  }

  async function updateWriteSidecar(v: boolean) {
    setWriteSidecar(v);
    await saveSettings({ writeSidecar: v });
  }

  async function removeInstance(url: string) {
    const next = instances.filter((u) => u !== url);
    const active = serverUrl === url ? (next[0] ?? "") : serverUrl;
    setInstances(next);
    setServerUrl(active);
    await saveSettings({ instances: next, serverUrl: active });
    deleteApiKey(url).catch(() => {});
    setKeyed((k) => {
      const c = { ...k };
      delete c[url];
      return c;
    });
  }

  // ---- Modal ----

  function openAdd() {
    setEditingUrl(null);
    setDraftUrl("");
    setDraftKey("");
    setTest({ kind: "idle" });
    modalRef.current?.showModal();
  }

  function openEdit(url: string) {
    setEditingUrl(url);
    setDraftUrl(url);
    setDraftKey("");
    setTest({ kind: "idle" });
    modalRef.current?.showModal();
  }

  const modalUrl = (editingUrl ?? draftUrl).trim().replace(/\/+$/, "");
  const canSubmit = modalUrl.length > 0 && draftKey.trim().length > 0;

  async function handleTest() {
    if (!canSubmit) return;
    setTest({ kind: "testing" });
    try {
      const result = await testConnection(modalUrl, draftKey.trim());
      setTest({ kind: "ok", result });
    } catch (e) {
      setTest({ kind: "error", message: String(e) });
    }
  }

  async function saveInstance() {
    if (!canSubmit) return;
    await setApiKey(modalUrl, draftKey.trim());
    const next = instances.includes(modalUrl) ? instances : [...instances, modalUrl];
    const active = serverUrl || modalUrl; // first instance becomes active
    setInstances(next);
    setServerUrl(active);
    await saveSettings({ instances: next, serverUrl: active });
    setKeyed((k) => ({ ...k, [modalUrl]: true }));
    modalRef.current?.close();
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Immich servers */}
      <div className="card bg-base-200">
        <div className="card-body flex flex-col gap-3">
          <h2 className="card-title text-base flex items-center gap-2">
            <Server size={16} /> Immich servers
          </h2>

          {instances.length === 0 ? (
            <p className="text-sm opacity-60">No servers yet. Add one to start syncing.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {instances.map((url) => (
                <div key={url} className="flex items-center gap-3 rounded-lg bg-base-100 p-3">
                  <input
                    type="radio"
                    name="active-instance"
                    className="radio radio-sm shrink-0"
                    checked={serverUrl === url}
                    onChange={() => selectActive(url)}
                    aria-label={`Use ${url}`}
                  />
                  <button className="min-w-0 flex-1 text-left" onClick={() => selectActive(url)}>
                    <div className="truncate font-medium">{url}</div>
                    <div className="text-xs opacity-60">
                      {keyed[url] === false ? "no key saved" : "key saved"}
                      {serverUrl === url ? " · active" : ""}
                    </div>
                  </button>
                  <button
                    className="btn btn-ghost btn-xs"
                    title="Update API key"
                    onClick={() => openEdit(url)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="btn btn-ghost btn-xs"
                    title="Remove server"
                    onClick={() => removeInstance(url)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button className="btn btn-outline btn-sm self-start" onClick={openAdd}>
            <Plus size={16} /> Add server
          </button>
        </div>
      </div>

      {/* Uploads */}
      <div className="card bg-base-200">
        <div className="card-body flex flex-col gap-4">
          <h2 className="card-title text-base">Uploads</h2>

          <div className="flex flex-col gap-1">
            <span className="label-text">Which stills to upload</span>
            <div className="flex flex-col gap-1">
              {FILTERS.map((f) => (
                <label key={f.value} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="upload-filter"
                    className="radio radio-sm"
                    checked={uploadFilter === f.value}
                    onChange={() => updateFilter(f.value)}
                  />
                  <span>{f.label}</span>
                </label>
              ))}
            </div>
            <span className="label-text-alt opacity-70">Videos are always uploaded.</span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="label-text">RAW + JPEG stacking</span>
            <select
              className="select select-bordered"
              value={stackMode}
              disabled={uploadFilter !== "both"}
              onChange={(e) => updateStack(e.target.value as StackMode)}
            >
              <option value="off">Off — upload as separate assets</option>
              <option value="jpeg-cover">Stack pairs — JPEG as cover</option>
              <option value="raw-cover">Stack pairs — RAW as cover</option>
            </select>
            <span className="label-text-alt opacity-70">
              {uploadFilter === "both"
                ? "Immich doesn't auto-link pairs; sd2immich groups them via the stacks API."
                : "Only available when uploading both formats."}
            </span>
          </div>

          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="checkbox checkbox-sm mt-0.5"
              checked={writeSidecar}
              onChange={(e) => updateWriteSidecar(e.target.checked)}
            />
            <span className="flex flex-col">
              <span className="label-text">Write sync data to cards (sd2i.data)</span>
              <span className="label-text-alt opacity-70">
                Adds a small file to each card so its sync status follows it between computers. You're
                asked before the first write to any card.
              </span>
            </span>
          </label>
        </div>
      </div>

      <p className="text-center text-xs opacity-50">Changes are saved automatically.</p>

      {/* Add / edit server modal */}
      <dialog ref={modalRef} className="modal">
        <div className="modal-box flex flex-col gap-3">
          <h3 className="text-lg font-bold">
            {editingUrl ? "Update API key" : "Add Immich server"}
          </h3>

          <label className="flex flex-col gap-1">
            <span className="label-text">Server URL</span>
            <input
              type="url"
              placeholder="http://192.168.1.10:2283"
              className="input input-bordered w-full"
              value={draftUrl}
              disabled={editingUrl !== null}
              onChange={(e) => {
                setDraftUrl(e.target.value);
                setTest({ kind: "idle" });
              }}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="label-text flex items-center gap-2">
              <KeyRound size={14} /> API key
            </span>
            <input
              type="password"
              placeholder="paste your API key"
              className="input input-bordered w-full"
              value={draftKey}
              onChange={(e) => {
                setDraftKey(e.target.value);
                setTest({ kind: "idle" });
              }}
            />
          </label>

          {/* Permission note */}
          <div className="rounded-lg bg-base-200 p-3 text-xs">
            <div className="mb-1 font-medium">API key permissions</div>
            <p className="mb-2 opacity-70">
              In Immich → Account Settings → API Keys, grant <code>all</code>, or at least:
            </p>
            <ul className="list-disc space-y-0.5 pl-4 opacity-70">
              <li>
                <code>asset.upload</code> — upload photos &amp; videos
              </li>
              <li>
                <code>asset.read</code>, <code>timeline.read</code> — browse &amp; verify the library
              </li>
              <li>
                <code>asset.view</code> — gallery thumbnails
              </li>
              <li>
                <code>stack.create</code> — RAW+JPEG stacking (only if enabled)
              </li>
            </ul>
          </div>

          <button
            className="btn btn-outline btn-sm"
            disabled={!canSubmit || test.kind === "testing"}
            onClick={handleTest}
          >
            {test.kind === "testing" && <Loader2 size={14} className="animate-spin" />}
            Test connection
          </button>

          {test.kind === "ok" && (
            <div className="flex flex-col gap-1 rounded-lg bg-base-200 p-3 text-sm">
              <span className="flex items-center gap-1 text-success">
                <CheckCircle2 size={16} /> Connected as {test.result.name || test.result.email}
              </span>
              {test.result.permissions.map((p) => (
                <span
                  key={p.name}
                  className={`flex items-center gap-1 text-xs ${p.ok ? "opacity-70" : "text-warning"}`}
                >
                  {p.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {p.name}
                </span>
              ))}
              {test.result.permissions.some((p) => !p.ok) && (
                <span className="text-xs text-warning">
                  Some capabilities are missing — grant the permissions above.
                </span>
              )}
            </div>
          )}
          {test.kind === "error" && (
            <div className="flex items-center gap-1 text-sm text-error">
              <XCircle size={16} /> <span className="break-all">{test.message}</span>
            </div>
          )}

          <div className="modal-action">
            <button className="btn btn-primary" disabled={!canSubmit} onClick={saveInstance}>
              {editingUrl ? "Save key" : "Add server"}
            </button>
            <form method="dialog">
              <button className="btn btn-ghost">Cancel</button>
            </form>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button>close</button>
        </form>
      </dialog>
    </div>
  );
}
