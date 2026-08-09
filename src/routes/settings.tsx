import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, XCircle } from "lucide-react";
import {
  hasApiKey,
  loadSettings,
  saveSettings,
  setApiKey,
  testConnection,
  type StackMode,
  type UploadFilter,
} from "../lib/immich";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; label: string }
  | { kind: "error"; message: string };

export default function SettingsPage() {
  const [serverUrl, setServerUrl] = useState("");
  const [apiKey, setApiKeyInput] = useState("");
  const [uploadFilter, setUploadFilter] = useState<UploadFilter>("both");
  const [stackMode, setStackMode] = useState<StackMode>("off");
  const [keySaved, setKeySaved] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadSettings().then((s) => {
      setServerUrl(s.serverUrl);
      setUploadFilter(s.uploadFilter);
      setStackMode(s.stackMode);
      if (s.serverUrl) hasApiKey(s.serverUrl).then(setKeySaved).catch(() => {});
    });
  }, []);

  async function handleTest() {
    if (!serverUrl || !apiKey) return;
    setTest({ kind: "testing" });
    try {
      const user = await testConnection(serverUrl, apiKey);
      setTest({ kind: "ok", label: user.name || user.email || "connected" });
    } catch (e) {
      setTest({ kind: "error", message: String(e) });
    }
  }

  async function handleSave() {
    setSaved(false);
    await saveSettings({ serverUrl, uploadFilter, stackMode });
    if (apiKey) {
      await setApiKey(serverUrl, apiKey);
      setApiKeyInput("");
      setKeySaved(true);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="mx-auto max-w-xl p-4">
      <h1 className="text-2xl font-bold mb-4">Settings</h1>

      {/* Server + key */}
      <div className="card bg-base-200 mb-4">
        <div className="card-body gap-3">
          <h2 className="card-title text-base">Immich server</h2>

          <label className="form-control">
            <span className="label-text mb-1">Server URL</span>
            <input
              type="url"
              placeholder="http://192.168.1.10:2283"
              className="input input-bordered w-full"
              value={serverUrl}
              onChange={(e) => {
                setServerUrl(e.target.value);
                setTest({ kind: "idle" });
              }}
            />
          </label>

          <label className="form-control">
            <span className="label-text mb-1 flex items-center gap-2">
              <KeyRound size={14} /> API key
              {keySaved && (
                <span className="badge badge-success badge-sm">saved in keychain</span>
              )}
            </span>
            <input
              type="password"
              placeholder={keySaved ? "•••••••• (leave blank to keep)" : "paste your API key"}
              className="input input-bordered w-full"
              value={apiKey}
              onChange={(e) => {
                setApiKeyInput(e.target.value);
                setTest({ kind: "idle" });
              }}
            />
            <span className="label-text-alt mt-1 opacity-70">
              Create one in Immich → Account Settings → API Keys.
            </span>
          </label>

          <div className="flex items-center gap-3">
            <button
              className="btn btn-outline btn-sm"
              disabled={!serverUrl || !apiKey || test.kind === "testing"}
              onClick={handleTest}
            >
              {test.kind === "testing" && <Loader2 size={14} className="animate-spin" />}
              Test connection
            </button>
            {test.kind === "ok" && (
              <span className="text-success flex items-center gap-1 text-sm">
                <CheckCircle2 size={16} /> {test.label}
              </span>
            )}
            {test.kind === "error" && (
              <span className="text-error flex items-center gap-1 text-sm">
                <XCircle size={16} /> {test.message}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Upload options */}
      <div className="card bg-base-200 mb-4">
        <div className="card-body gap-3">
          <h2 className="card-title text-base">Uploads</h2>

          <div className="form-control">
            <span className="label-text mb-1">Which stills to upload</span>
            <div className="join">
              {(["raw", "image", "both"] as UploadFilter[]).map((f) => (
                <button
                  key={f}
                  className={`btn join-item btn-sm ${uploadFilter === f ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setUploadFilter(f)}
                >
                  {f === "raw" ? "RAW only" : f === "image" ? "JPEG only" : "Both"}
                </button>
              ))}
            </div>
            <span className="label-text-alt mt-1 opacity-70">Videos are always uploaded.</span>
          </div>

          <label className="form-control">
            <span className="label-text mb-1">RAW + JPEG stacking</span>
            <select
              className="select select-bordered"
              value={stackMode}
              disabled={uploadFilter !== "both"}
              onChange={(e) => setStackMode(e.target.value as StackMode)}
            >
              <option value="off">Off — upload as separate assets</option>
              <option value="jpeg-cover">Stack pairs — JPEG as cover</option>
              <option value="raw-cover">Stack pairs — RAW as cover</option>
            </select>
            <span className="label-text-alt mt-1 opacity-70">
              {uploadFilter === "both"
                ? "Immich doesn't auto-link pairs; sd2immich groups them via the stacks API."
                : "Only available when uploading both formats."}
            </span>
          </label>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary" onClick={handleSave} disabled={!serverUrl}>
          Save
        </button>
        {saved && (
          <span className="text-success flex items-center gap-1 text-sm">
            <CheckCircle2 size={16} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}
