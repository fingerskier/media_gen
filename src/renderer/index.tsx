import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Bridge,
  Control,
  Mode,
  Snapshot,
  Recipe,
  PublicAsset,
} from "../shared/types";
import "./style.css";
declare global {
  interface Window {
    mediaGen: Bridge;
  }
}
const tabs = ["Create", "Library", "Jobs"] as const;
type Value = string | number | boolean;
// Coerce a draft value into something the main-process validator accepts for this control.
function normalize(c: Control, raw: Value | undefined): Value {
  switch (c.kind) {
    case "select":
      return c.options.includes(raw as string | number) ? raw! : c.default;
    case "number": {
      const n =
        typeof raw === "number" && Number.isFinite(raw) ? raw : c.default;
      const clamped = Math.min(c.max, Math.max(c.min, n));
      return c.integer ? Math.round(clamped) : clamped;
    }
    case "toggle":
      return typeof raw === "boolean" ? raw : c.default;
    case "text":
      return typeof raw === "string" ? raw.slice(0, c.maxLength) : c.default;
  }
}
function ControlInput({
  control: c,
  value,
  onChange,
}: {
  control: Control;
  value: Value | undefined;
  onChange: (v: Value) => void;
}) {
  const current = normalize(c, value);
  switch (c.kind) {
    case "select":
      return (
        <select
          id={c.key}
          value={String(current)}
          onChange={(e) =>
            onChange(c.options.find((v) => String(v) === e.target.value)!)
          }
        >
          {c.options.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v).replace("*", " × ")}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <input
          id={c.key}
          type="number"
          min={c.min}
          max={c.max}
          step={c.step ?? (c.integer ? 1 : "any")}
          value={typeof value === "number" ? value : Number(current)}
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            if (Number.isFinite(n)) onChange(n);
          }}
          onBlur={() => onChange(current)}
        />
      );
    case "toggle":
      return (
        <select
          id={c.key}
          value={current ? "on" : "off"}
          onChange={(e) => onChange(e.target.value === "on")}
        >
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      );
    case "text":
      return (
        <input
          id={c.key}
          type="text"
          maxLength={c.maxLength}
          value={String(current)}
          placeholder="Optional"
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
function App() {
  const [data, setData] = useState<Snapshot>();
  const [tab, setTab] = useState<string>("Create");
  const [mode, setMode] = useState<Mode>("image");
  const [drafts, setDrafts] = useState<
    Record<
      Mode,
      { model?: string; prompt: string; parameters: Recipe["parameters"] }
    >
  >({
    image: { prompt: "", parameters: {} },
    video: { prompt: "", parameters: {} },
  });
  const [selected, setSelected] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [mediaError, setMediaError] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [key, setKey] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const [search, setSearch] = useState("");
  const pendingJob = useRef<string | null>(null);
  const inflight = useRef(false);
  const submission = useRef<{ signature: string; token: string } | null>(null);
  async function refresh() {
    try {
      const next = await window.mediaGen.snapshot();
      setData(next);
      if (pendingJob.current) {
        const ready = next.assets.find((a) => a.jobId === pendingJob.current);
        if (ready) {
          setSelected(ready.id);
          pendingJob.current = null;
          setMessage("Your result is ready and saved locally.");
        }
      }
    } catch {
      setMessage(
        "Could not read the local library. Restart the app or check storage permissions.",
      );
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setZoom(1);
    setMediaError(false);
  }, [selected]);
  const draft = drafts[mode];
  const model = data?.models.find(
    (m) =>
      m.mode === mode && m.id === (draft.model ?? data.modelDefaults[mode]),
  );
  const asset = data?.assets.find((a) => a.id === selected);
  const job = data?.jobs.find((j) => j.id === asset?.jobId);
  const active =
    data?.jobs.filter((j) =>
      ["queued", "submitting", "running", "downloading"].includes(j.state),
    ) ?? [];
  const updateDraft = (patch: Partial<typeof draft>) =>
    setDrafts((prev) => ({ ...prev, [mode]: { ...prev[mode], ...patch } }));
  async function action(fn: () => Promise<unknown>, success?: string) {
    try {
      await fn();
      if (success) setMessage(success);
      await refresh();
    } catch {
      setMessage(
        "Operation failed. Check your settings or local files and try again.",
      );
    }
  }
  async function saveModelDefault(target: Mode, id: string) {
    setSavingModel(true);
    try {
      await window.mediaGen.saveModelDefault(target, id);
      setDrafts((prev) => ({
        ...prev,
        [target]: { prompt: prev[target].prompt, parameters: {} },
      }));
      setMessage(
        "Model default saved. Existing jobs and recipes are unchanged.",
      );
    } catch {
      setMessage(
        "Could not load that model's settings from Atlas Cloud. Check your connection and try again.",
      );
    } finally {
      setSavingModel(false);
      await refresh();
    }
  }
  async function refreshCatalog() {
    await action(
      () => window.mediaGen.refreshCatalog(),
      "Model list refreshed from Atlas Cloud.",
    );
  }
  async function generate() {
    if (
      !model ||
      inflight.current ||
      !draft.prompt.trim() ||
      !data?.credentials.configured
    )
      return;
    const recipe: Recipe = {
      mode,
      model: model.id,
      prompt: draft.prompt,
      parameters: Object.fromEntries(
        model.controls.map((c) => [
          c.key,
          normalize(c, draft.parameters[c.key]),
        ]),
      ),
    };
    const signature = JSON.stringify(recipe);
    if (submission.current?.signature !== signature)
      submission.current = { signature, token: crypto.randomUUID() };
    inflight.current = true;
    setPending(true);
    try {
      pendingJob.current = await window.mediaGen.enqueue(
        submission.current.token,
        recipe,
      );
      submission.current = null;
      setMessage(
        "Queued at Atlas Cloud. You can keep working while it generates.",
      );
      await refresh();
    } catch {
      setMessage(
        "Could not confirm the local submission. Check Jobs before trying again.",
      );
    } finally {
      inflight.current = false;
      setPending(false);
    }
  }
  function open(a: PublicAsset) {
    setSelected(a.id);
    setTab("Create");
    setMessage("");
  }
  function reuse() {
    if (!job) return;
    setMode(job.recipe.mode);
    setDrafts((prev) => ({
      ...prev,
      [job.recipe.mode]: {
        model: job.recipe.model,
        prompt: job.recipe.prompt,
        parameters: job.recipe.parameters,
      },
    }));
    setTab("Create");
    setMessage(
      "Settings copied. Edit the prompt before generating a new version.",
    );
  }
  const thumbnails = (assets: PublicAsset[]) =>
    assets.map((a) => {
      const j = data?.jobs.find((j) => j.id === a.jobId);
      return (
        <button
          key={a.id}
          className={"thumb " + (selected === a.id ? "selected" : "")}
          aria-label={"Open " + (j?.recipe.prompt ?? "result")}
          onClick={() => open(a)}
        >
          {a.missing ? (
            <span>Missing file</span>
          ) : a.mime.startsWith("image/") ? (
            <img src={a.url} alt="" loading="lazy" />
          ) : (
            <div className="video-thumb">
              <span>▷</span>
              <small>VIDEO</small>
            </div>
          )}
          <div>
            <strong>{j?.recipe.prompt ?? "Untitled"}</strong>
            <small>
              {j?.recipe.mode === "video" ? "Video" : "Image"} ·{" "}
              {j ? new Date(j.created).toLocaleDateString() : ""}
            </small>
          </div>
        </button>
      );
    });
  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="brand-mark">
            M<span>◦</span>
          </div>
          <div>
            <h1>Media Gen</h1>
            <p>YOUR LOCAL CREATIVE WORKBENCH</p>
          </div>
        </div>
        <nav aria-label="Workspace">
          {tabs.map((t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t}
              {t === "Jobs" && active.length > 0 && (
                <span className="count">{active.length}</span>
              )}
            </button>
          ))}
        </nav>
        <button
          className={"settings-button " + (tab === "Settings" ? "active" : "")}
          onClick={() => setTab("Settings")}
        >
          Settings <span aria-hidden>⚙</span>
        </button>
      </header>
      {message && (
        <div className="notice" role="status">
          <span>{message}</span>
          <button aria-label="Dismiss message" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
      {!data ? (
        <div className="empty">
          <h2>Opening your library…</h2>
          <p>Your media stays on this device.</p>
        </div>
      ) : tab === "Settings" ? (
        <main className="settings">
          <div className="section-heading">
            <p className="eyebrow">CONNECTIONS</p>
            <h2>A key to your creative tools.</h2>
            <p>
              Bring your own API key. Media Gen has no account or subscription.
            </p>
          </div>
          <section className="settings-card">
            <div className="row">
              <h3>Atlas Cloud</h3>
              <span
                className={
                  "pill " + (data.credentials.configured ? "good" : "")
                }
              >
                {data.credentials.configured
                  ? "Connected key"
                  : "Not configured"}
              </span>
            </div>
            <p>One API key for the supported image and video models below.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const value = key;
                setKey("");
                void action(
                  () => window.mediaGen.saveKey(value),
                  "API key saved. Generation is ready.",
                );
              }}
            >
              <label htmlFor="api-key">API key</label>
              <input
                id="api-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Paste your Atlas Cloud API key"
              />
              <p className="hint">
                {data.credentials.secureAvailable
                  ? "Keys are encrypted with your OS credential store."
                  : "Secure OS storage is unavailable. Your key is kept in memory for this session only."}
              </p>
              <div className="row">
                <button
                  className="primary"
                  disabled={!key.trim()}
                  type="submit"
                >
                  Save key
                </button>
                <button
                  type="button"
                  disabled={!data.credentials.configured}
                  onClick={() =>
                    void action(
                      () => window.mediaGen.clearKey(),
                      "Key removed from this app.",
                    )
                  }
                >
                  Forget key
                </button>
              </div>
            </form>
            <div className="settings-note">
              Storage: {data.credentials.storage}. Keys are never included in
              your library or exports. Saving a key does not submit a generation
              or verify the account balance.
            </div>
          </section>
          <section className="settings-card">
            <h3>Generation models</h3>
            <p>
              Choose the default for each mode. Changes save automatically on
              this device; they never submit a generation. Picking a model for
              the first time downloads its published settings schema.
            </p>
            {(["image", "video"] as Mode[]).map((target) => {
              const rows = data.catalog.entries.filter(
                (e) => e.mode === target,
              );
              const current = rows.find(
                (e) => e.id === data.modelDefaults[target],
              );
              const groups = [...new Set(rows.map((e) => e.organization))];
              return (
                <div className="field" key={target}>
                  <label htmlFor={"model-" + target}>
                    Default {target} model
                  </label>
                  <select
                    id={"model-" + target}
                    value={data.modelDefaults[target]}
                    disabled={savingModel}
                    onChange={(e) =>
                      void saveModelDefault(target, e.target.value)
                    }
                  >
                    {groups.map((org) => (
                      <optgroup label={org} key={org}>
                        {rows
                          .filter((e) => e.organization === org)
                          .map((e) => (
                            <option
                              value={e.id}
                              key={e.id}
                              disabled={Boolean(e.unsupported)}
                            >
                              {e.name}
                              {e.price ? ` · $${e.price}` : ""}
                              {e.unsupported ? " · unavailable" : ""}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  <p className="hint">
                    {data.modelDefaults[target]}
                    {current?.description ? ` — ${current.description}` : ""}
                  </p>
                </div>
              );
            })}
            <div className="row">
              <p className="hint">
                {!data.catalog.online
                  ? "Live model list is disabled. Showing built-in models only."
                  : data.catalog.updated
                    ? `${data.catalog.entries.length} Atlas models · list updated ${new Date(data.catalog.updated).toLocaleString()}`
                    : "Built-in models only. Refresh to load the full Atlas list."}
              </p>
              <button
                type="button"
                disabled={!data.catalog.online || data.catalog.refreshing}
                onClick={() => void refreshCatalog()}
              >
                {data.catalog.refreshing ? "Refreshing…" : "Refresh model list"}
              </button>
            </div>
            <p className="hint">
              Listed prices are the provider's base price and the unit varies by
              model; final charges depend on your settings. Models needing
              reference images, audio or video inputs are marked unavailable.
              Switching resets that mode’s draft parameters but keeps its
              prompt. Reuse settings restores the saved recipe’s model without
              changing these defaults.
            </p>
          </section>
          <section className="settings-card">
            <h3>Local by default</h3>
            <p>
              Outputs and recipes stay in your local library. Only an explicit
              Generate action sends your prompt and selected settings to Atlas
              Cloud.
            </p>
            <p>
              No telemetry. No automatic provider fallback. No background
              daemon.
            </p>
            <p className="hint">
              Video extension, video editing, and additional providers are
              planned—not enabled in this build.
            </p>
          </section>
        </main>
      ) : tab === "Jobs" ? (
        <main className="wide">
          <div className="section-heading">
            <p className="eyebrow">GENERATION QUEUE</p>
            <h2>Keep creating. We’ll keep track.</h2>
            <p>
              Closing pauses local tracking, not remote billing. Ambiguous
              submissions are never retried automatically.
            </p>
          </div>
          {!data.jobs.length ? (
            <div className="empty panel">
              <h3>No jobs yet</h3>
              <p>Your next idea starts in Create.</p>
            </div>
          ) : (
            <div className="job-list">
              {data.jobs.map((j) => (
                <article key={j.id}>
                  <div>
                    <span className={"pill state-" + j.state}>
                      {[
                        "queued",
                        "submitting",
                        "running",
                        "downloading",
                      ].includes(j.state) && (
                        <span className="pulse" aria-label="In progress" />
                      )}
                      {j.state.replaceAll("_", " ")}
                    </span>
                    {[
                      "queued",
                      "submitting",
                      "running",
                      "downloading",
                    ].includes(j.state) && (
                      <small className="elapsed">
                        {Math.floor(
                          Math.max(0, Date.now() - j.created) / 60000,
                        )}
                        m{" "}
                        {Math.floor(
                          Math.max(0, Date.now() - j.created) / 1000,
                        ) % 60}
                        s elapsed
                      </small>
                    )}
                    <h3>{j.recipe.prompt}</h3>
                    <p>
                      {j.recipe.mode} · Atlas Cloud · {j.recipe.model}
                    </p>
                    <small>{new Date(j.created).toLocaleString()}</small>
                    {j.message && <p className="job-message">{j.message}</p>}
                  </div>
                  {j.state === "queued" && (
                    <button
                      onClick={() =>
                        void action(
                          () => window.mediaGen.cancelQueued(j.id),
                          "Queued job cancelled. Nothing submitted.",
                        )
                      }
                    >
                      Cancel queued
                    </button>
                  )}
                  {[
                    "running",
                    "downloading",
                    "tracking_failed",
                    "download_failed",
                  ].includes(j.state) && (
                    <button
                      title="Pauses local tracking only. Provider processing and billing may continue."
                      onClick={() =>
                        void action(
                          () => window.mediaGen.stopTracking(j.id),
                          "Tracking stopped. Remote processing and billing may continue.",
                        )
                      }
                    >
                      Stop tracking
                    </button>
                  )}
                  {["download_failed", "tracking_failed", "paused"].includes(
                    j.state,
                  ) && (
                    <button
                      onClick={() =>
                        void action(
                          () => window.mediaGen.retry(j.id),
                          j.hasRemoteJob
                            ? "Resuming the existing job. No new generation submitted."
                            : "Unsubmitted request requeued. Atlas credits are used when it is submitted.",
                        )
                      }
                    >
                      {!j.hasRemoteJob
                        ? "Resume queued request"
                        : j.state === "download_failed"
                          ? "Retry download"
                          : "Resume tracking"}
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </main>
      ) : tab === "Library" ? (
        <main className="wide">
          <div className="section-heading">
            <p className="eyebrow">YOUR COLLECTION</p>
            <h2>Good ideas deserve a home.</h2>
            <p>Original media and the recipe behind every result.</p>
          </div>
          <input
            className="search"
            aria-label="Search library"
            placeholder="Search prompts or model names…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="library-grid">
            {thumbnails(
              data.assets.filter((a) => {
                const j = data.jobs.find((j) => j.id === a.jobId);
                return (
                  (j?.recipe.prompt ?? "") +
                  " " +
                  (j?.recipe.model ?? "")
                )
                  .toLowerCase()
                  .includes(search.toLowerCase());
              }),
            )}
          </div>
          {!data.assets.length && (
            <div className="empty panel">
              <h3>Your library starts here</h3>
              <p>
                Completed generations are saved automatically—no expiring links
                to babysit.
              </p>
            </div>
          )}
        </main>
      ) : (
        <main className="workspace">
          <aside className="composer">
            <p className="eyebrow">MAKE SOMETHING NEW</p>
            <div className="segmented">
              {(["image", "video"] as Mode[]).map((m) => (
                <button
                  key={m}
                  className={mode === m ? "active" : ""}
                  onClick={() => setMode(m)}
                >
                  {m === "image" ? "Image" : "Video"}
                </button>
              ))}
            </div>
            <div className="provider">
              <span className="provider-icon">A</span>
              <div>
                <strong>Atlas Cloud</strong>
                <small>{model?.name}</small>
              </div>
              <span className="pill">API</span>
            </div>
            <label htmlFor="prompt">Prompt</label>
            <textarea
              id="prompt"
              maxLength={10000}
              value={draft.prompt}
              onChange={(e) => updateDraft({ prompt: e.target.value })}
              placeholder={
                mode === "image"
                  ? "Describe the image you have in mind. Subject, light, texture, mood…"
                  : "Describe the scene, movement, and camera. What unfolds over time?"
              }
              rows={7}
            />
            <p className="hint prompt-hint">Be specific. Make it yours.</p>
            <div className="controls">
              {model?.controls.map((c) => (
                <div key={c.key}>
                  <label htmlFor={c.key} title={c.description}>
                    {c.label}
                  </label>
                  <ControlInput
                    control={c}
                    value={draft.parameters[c.key]}
                    onChange={(v) =>
                      updateDraft({
                        parameters: { ...draft.parameters, [c.key]: v },
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <div className="composer-bottom">
              <div className="estimate">
                <span>Estimated cost</span>
                <strong>Unknown</strong>
              </div>
              <p className="hint">
                Uses your Atlas credits. Final charges depend on the provider.
                No automatic retries of paid requests.
              </p>
              <button
                className="primary generate"
                disabled={
                  !draft.prompt.trim() ||
                  !data.credentials.configured ||
                  pending
                }
                onClick={() => void generate()}
              >
                {pending ? "Queuing…" : `Generate ${mode}`}{" "}
                <span aria-hidden>↗</span>
              </button>
              {!data.credentials.configured && (
                <button
                  className="text-button"
                  onClick={() => setTab("Settings")}
                >
                  Add your Atlas key to get started →
                </button>
              )}
            </div>
          </aside>
          <section className="canvas">
            <div className="canvas-heading">
              <div>
                <p className="eyebrow">THE BIG PICTURE</p>
                <h2>{asset ? "Your result" : "Room for your next idea."}</h2>
              </div>
              <span className="pill">
                {asset ? "Saved locally" : "LOCAL LIBRARY"}
              </span>
            </div>
            <div className={"preview " + (!asset ? "empty-preview" : "")}>
              {!asset ? (
                <div className="empty">
                  <div className="empty-symbol">✧</div>
                  <h3>From a few words to something new.</h3>
                  <p>
                    Write a prompt, choose your format, and generate.
                    <br />
                    Your images and videos will appear here.
                  </p>
                  <div className="empty-tags">
                    <span>Imagine</span>
                    <span>Generate</span>
                    <span>Keep creating</span>
                  </div>
                </div>
              ) : asset.missing ? (
                <div className="empty">
                  <h3>Original file is missing</h3>
                  <p>
                    The recipe is still saved. Restore the file from a library
                    backup.
                  </p>
                </div>
              ) : mediaError ? (
                <div className="empty">
                  <h3>This file cannot be previewed</h3>
                  <p>
                    The format may be unsupported or the file damaged. Export
                    the original to inspect it.
                  </p>
                </div>
              ) : asset.mime.startsWith("image/") ? (
                <div className="image-scroll">
                  <img
                    style={{
                      width: zoom === 1 ? "auto" : `${zoom * 100}%`,
                      maxWidth: zoom === 1 ? "100%" : "none",
                      maxHeight: zoom === 1 ? "100%" : "none",
                    }}
                    src={asset.url}
                    alt={job?.recipe.prompt ?? "Generated image"}
                    onError={() => setMediaError(true)}
                  />
                </div>
              ) : (
                <video
                  key={asset.id}
                  src={asset.url}
                  controls
                  preload="metadata"
                  onError={() => setMediaError(true)}
                />
              )}
            </div>
            <div className="result-actions">
              <div>
                {asset?.mime.startsWith("image/") && (
                  <>
                    <button
                      aria-label="Zoom out"
                      onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
                    >
                      −
                    </button>
                    <button onClick={() => setZoom(1)}>Fit</button>
                    <button
                      aria-label="Zoom in"
                      onClick={() => setZoom((z) => Math.min(4, z + 0.5))}
                    >
                      +
                    </button>
                  </>
                )}
              </div>
              <div>
                <button disabled={!job} onClick={reuse}>
                  Reuse settings
                </button>
                <button
                  disabled={!asset || asset.missing}
                  onClick={() =>
                    asset && void action(() => window.mediaGen.reveal(asset.id))
                  }
                >
                  Show in folder
                </button>
                <button
                  aria-label="Export original"
                  className="export"
                  disabled={!asset || asset.missing}
                  onClick={() =>
                    asset &&
                    void action(
                      () => window.mediaGen.exportAsset(asset.id),
                      "Export dialog completed.",
                    )
                  }
                >
                  Export original ↗
                </button>
              </div>
            </div>
            {job && (
              <p className="recipe-caption">
                {job.recipe.prompt} <span>· {job.recipe.model}</span>
              </p>
            )}
            <div className="recent-heading">
              <h3>Recent results</h3>
              <button className="text-button" onClick={() => setTab("Library")}>
                View library →
              </button>
            </div>
            <div className="recent-strip">
              {data.assets.length ? (
                thumbnails(data.assets.slice(0, 8))
              ) : (
                <p className="muted">
                  Nothing saved yet. Your first result will start the
                  collection.
                </p>
              )}
            </div>
            {active.length > 0 && (
              <button className="queue-strip" onClick={() => setTab("Jobs")}>
                <span className="pulse" />
                {active.length} active job{active.length === 1 ? "" : "s"} ·
                View progress →
              </button>
            )}
          </section>
        </main>
      )}
      <footer>
        <span>
          <i /> Local-first. Yours to keep.
        </span>
        <span>
          {data?.assets.length ?? 0} saved results ·{" "}
          {data?.credentials.configured
            ? "Atlas key configured"
            : "Atlas key needed"}
        </span>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
