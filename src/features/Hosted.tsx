import { useState } from "react";
import { Plus, Trash2, RotateCcw, Send, Copy as CopyIcon } from "lucide-react";
import type { ChaosConfig, MockRoute } from "../../shared/types";
import {
  api,
  Code,
  Copy,
  Empty,
  ErrorBox,
  Field,
  Note,
  Page,
  Panel,
  useLab,
} from "../lab-ui";
const absolute = (path: string) => new URL(path, location.origin).href;
function useAction(refresh: () => Promise<void>) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}
export function ChaosPage() {
  const { data, error: loadError, refresh } = useLab();
  const action = useAction(refresh);
  const [name, setName] = useState("Retry experiment"),
    [mode, setMode] = useState<ChaosConfig["mode"]>("first"),
    [failures, setFailures] = useState(3),
    [errorStatus, setStatus] = useState(503),
    [delayMs, setDelay] = useState(0),
    [jitterMs, setJitter] = useState(0);
  return (
    <Page
      eyebrow="HOSTED SIMULATORS"
      title="Chaos lab"
      description="Give a webhook sender a deliberately unreliable endpoint and observe its retry behavior."
    >
      <Note>
        Chaos endpoints simulate delivery failures. Use Mock APIs for
        predictable API responses and pagination. Endpoint configuration and
        counters reset on restart.
      </Note>
      <Panel title="Create a chaos endpoint">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() =>
              api("/api/lab/chaos", {
                name,
                mode,
                failures,
                errorStatus,
                delayMs,
                jitterMs,
              }),
            );
          }}
        >
          <div className="lab-form-grid">
            <Field label="Experiment name">
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Failure pattern">
              <select
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as typeof mode);
                  setFailures(3);
                }}
              >
                <option value="first">Fail the first N requests</option>
                <option value="every">Fail every Nth request</option>
                <option value="random">Random failure percentage</option>
              </select>
            </Field>
            <Field
              label={
                mode === "random"
                  ? "Failure chance (%)"
                  : mode === "first"
                    ? "Initial failures"
                    : "Every Nth request"
              }
            >
              <input
                type="number"
                min="1"
                max={mode === "random" ? 100 : 1000}
                required
                value={failures}
                onChange={(e) => setFailures(Number(e.target.value))}
              />
            </Field>
            <Field label="Failure status">
              <select
                value={errorStatus}
                onChange={(e) => setStatus(Number(e.target.value))}
              >
                {[400, 401, 408, 429, 500, 502, 503, 504].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </Field>
            <Field label="Base response delay (ms)">
              <input
                type="number"
                min="0"
                max="10000"
                value={delayMs}
                onChange={(e) => setDelay(Number(e.target.value))}
              />
            </Field>
            <Field
              label="Additional random delay (ms)"
              help="Total delay is capped at 10 seconds."
            >
              <input
                type="number"
                min="0"
                max="10000"
                value={jitterMs}
                onChange={(e) => setJitter(Number(e.target.value))}
              />
            </Field>
          </div>
          <button className="button primary" disabled={action.busy}>
            <Plus size={15} />
            Create endpoint
          </button>
        </form>
      </Panel>
      <ErrorBox error={action.error || loadError} />
      {data?.chaos.length ? (
        data.chaos.map((c) => (
          <Panel
            key={c.id}
            title={c.name}
            description={`${c.mode === "first" ? `First ${c.failures} fail` : c.mode === "every" ? `Every ${c.failures}th fails` : `${c.failures}% failure chance`} · failure ${c.errorStatus} · success 200`}
            actions={
              <div className="lab-actions">
                <button
                  className="button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(`/api/lab/chaos/${c.id}/reset`, {}),
                    )
                  }
                >
                  <RotateCcw size={14} />
                  Reset attempts
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete ${c.name}`}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(`/api/lab/chaos/${c.id}`, undefined, "DELETE"),
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            }
          >
            <div className="lab-url">
              <code>{absolute(`/chaos/${c.id}`)}</code>
              <Copy value={absolute(`/chaos/${c.id}`)} label="Copy endpoint" />
            </div>
            <div className="lab-actions">
              <button
                className="button"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    fetch(`/chaos/${c.id}`, {
                      method: "POST",
                      credentials: "omit",
                      headers: { "Content-Type": "application/json" },
                      body: '{"event":"chaos.test"}',
                    }),
                  )
                }
              >
                <Send size={14} />
                Send test request
              </button>
              <span className="lab-meta">{c.attempts} attempts received</span>
            </div>
            {c.calls.length > 0 && (
              <div className="lab-table">
                <div className="lab-table-head">
                  <span>Arrival</span>
                  <span>Status</span>
                  <span>Delay</span>
                </div>
                {c.calls.slice(0, 10).map((call, i) => (
                  <div key={i}>
                    <span>{new Date(call.at).toLocaleTimeString()}</span>
                    <span
                      className={
                        call.status >= 400 ? "status-bad" : "status-good"
                      }
                    >
                      {call.status}
                    </span>
                    <span>{call.delayMs}ms</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        ))
      ) : (
        <Empty>
          Create your first endpoint, then paste its URL into a webhook provider
          or Postman.
        </Empty>
      )}
    </Page>
  );
}
const route = (): MockRoute => ({
  method: "GET",
  path: "/items",
  status: 200,
  contentType: "application/json",
  headers: [],
  body: '[\n  { "id": 1, "name": "First item" },\n  { "id": 2, "name": "Second item" }\n]',
  delayMs: 0,
  paginated: false,
  requiredBearer: "",
  perMinute: 0,
});
export function MockPage() {
  const { data, error: loadError, refresh } = useLab();
  const action = useAction(refresh);
  const [name, setName] = useState("My test API"),
    [routes, setRoutes] = useState<MockRoute[]>([route()]),
    [editing, setEditing] = useState(0);
  const current = routes[editing];
  function update(change: Partial<MockRoute>) {
    setRoutes((list) =>
      list.map((r, i) => (i === editing ? { ...r, ...change } : r)),
    );
  }
  return (
    <Page
      eyebrow="HOSTED SIMULATORS"
      title="Mock APIs"
      description="Create a temporary fake API with multiple routes, predictable responses, authentication, and rate limits."
    >
      <Note>
        Public mock URLs work from Postman and browser frontends. Custom
        headers, JSON/text bodies, and delays are configurable. Everything
        resets on restart; download your definition to keep it.
      </Note>
      <Panel title="API definition">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() => api("/api/lab/mocks", { name, routes }));
          }}
        >
          <Field label="API name">
            <input
              value={name}
              required
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div className="mock-editor">
            <nav aria-label="Mock routes">
              {routes.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  className={editing === i ? "active" : ""}
                  onClick={() => setEditing(i)}
                >
                  <span>{r.method}</span>
                  {r.path}
                </button>
              ))}
              <button
                type="button"
                disabled={routes.length >= 10}
                onClick={() => {
                  setRoutes((s) => [
                    ...s,
                    { ...route(), path: `/route-${s.length + 1}` },
                  ]);
                  setEditing(routes.length);
                }}
              >
                <Plus size={14} />
                Add route
              </button>
            </nav>
            <div className="mock-route-fields">
              <div className="lab-actions">
                <strong>Route {editing + 1}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Remove this route"
                  disabled={routes.length === 1}
                  onClick={() => {
                    setRoutes((s) => s.filter((_, i) => i !== editing));
                    setEditing(0);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="lab-form-grid">
                <Field label="Method">
                  <select
                    value={current.method}
                    onChange={(e) => update({ method: e.target.value })}
                  >
                    {[
                      "GET",
                      "POST",
                      "PUT",
                      "PATCH",
                      "DELETE",
                      "HEAD",
                      "OPTIONS",
                    ].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Path"
                  help="For example /items or /items/:id. Parameter routes match any one path segment."
                >
                  <input
                    className="technical"
                    required
                    value={current.path}
                    onChange={(e) => update({ path: e.target.value })}
                  />
                </Field>
                <Field label="Status code">
                  <input
                    type="number"
                    min="200"
                    max="599"
                    value={current.status}
                    onChange={(e) => update({ status: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Response type">
                  <select
                    value={current.contentType}
                    onChange={(e) =>
                      update({
                        contentType: e.target.value as MockRoute["contentType"],
                      })
                    }
                  >
                    <option>application/json</option>
                    <option>text/plain</option>
                  </select>
                </Field>
                <Field label="Delay (ms)">
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    value={current.delayMs}
                    onChange={(e) =>
                      update({ delayMs: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field
                  label="Rate limit per minute"
                  help="0 disables the limit. Exceeding it returns 429 with Retry-After."
                >
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    value={current.perMinute}
                    onChange={(e) =>
                      update({ perMinute: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field
                  label="Required bearer token (optional)"
                  help="Requests without this token receive 401. Use a disposable test value."
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={current.requiredBearer}
                    onChange={(e) => update({ requiredBearer: e.target.value })}
                  />
                </Field>
                <label className="lab-check">
                  <input
                    type="checkbox"
                    checked={current.paginated}
                    onChange={(e) => update({ paginated: e.target.checked })}
                  />
                  Paginate JSON array using ?page=1&limit=10
                </label>
              </div>
              <Field label="Response body (up to 16 KiB)">
                <textarea
                  rows={9}
                  value={current.body}
                  onChange={(e) => update({ body: e.target.value })}
                />
              </Field>
              <Field
                label="Custom response headers"
                help="One Name: value per line. Content and security headers are managed by the app."
              >
                <textarea
                  rows={3}
                  value={current.headers
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")}
                  onChange={(e) =>
                    update({
                      headers: e.target.value
                        .split("\n")
                        .filter(Boolean)
                        .map((line) => {
                          const i = line.indexOf(":");
                          return i < 0
                            ? [line, ""]
                            : [line.slice(0, i), line.slice(i + 1).trimStart()];
                        }),
                    })
                  }
                  placeholder="X-Test-Id: fixture-001"
                />
              </Field>
            </div>
          </div>
          <div className="lab-actions">
            <button className="button primary" disabled={action.busy}>
              <Plus size={15} />
              Create API
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                const a = document.createElement("a");
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      JSON.stringify(
                        { version: 1, kind: "mock-api", name, routes },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json" },
                  ),
                );
                a.href = url;
                a.download = "mock-api.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download definition
            </button>
            <label className="button file-button">
              Import definition
              <input
                type="file"
                accept=".json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void action.run(async () => {
                    if (file.size > 262144)
                      throw Error("Definition must be smaller than 256 KiB.");
                    const v = JSON.parse(await file.text());
                    if (
                      v.kind !== "mock-api" ||
                      typeof v.name !== "string" ||
                      !Array.isArray(v.routes) ||
                      !v.routes.length ||
                      v.routes.length > 10 ||
                      v.routes.some(
                        (r: MockRoute) =>
                          typeof r.path !== "string" ||
                          typeof r.body !== "string" ||
                          typeof r.requiredBearer !== "string" ||
                          typeof r.method !== "string" ||
                          !Array.isArray(r.headers) ||
                          r.headers.some(
                            (h) =>
                              !Array.isArray(h) ||
                              h.length !== 2 ||
                              h.some((v) => typeof v !== "string"),
                          ),
                      )
                    )
                      throw Error("Choose a valid exported mock definition.");
                    setName(v.name);
                    setRoutes(v.routes);
                    setEditing(0);
                  });
                }}
              />
            </label>
          </div>
        </form>
      </Panel>
      <ErrorBox error={action.error || loadError} />
      {data?.mocks.length ? (
        data.mocks.map((m) => (
          <Panel
            key={m.id}
            title={m.name}
            description={`${m.routes.length} routes · ${m.calls.length} recent calls retained`}
            actions={
              <div className="lab-actions">
                <button
                  className="button"
                  onClick={() => {
                    setName(m.name + " copy");
                    setRoutes(structuredClone(m.routes));
                    setEditing(0);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  <CopyIcon size={14} />
                  Copy to editor
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete ${m.name}`}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(`/api/lab/mocks/${m.id}`, undefined, "DELETE"),
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            }
          >
            <div className="lab-url">
              <code>{absolute(`/mock/${m.id}`)}</code>
              <Copy value={absolute(`/mock/${m.id}`)} label="Copy base URL" />
            </div>
            <div className="mock-live-routes">
              {m.routes.map((r, i) => (
                <div key={i}>
                  <span className="method">{r.method}</span>
                  <code>{r.path}</code>
                  <span>{r.status}</span>
                  <Copy
                    value={absolute(`/mock/${m.id}${r.path}`)}
                    label="Copy URL"
                  />
                </div>
              ))}
            </div>
            {m.calls.length > 0 && (
              <details>
                <summary>Recent requests</summary>
                <Code
                  value={m.calls
                    .slice(0, 10)
                    .map(
                      (c) =>
                        `${new Date(c.at).toLocaleTimeString()}  ${c.method} ${c.path} → ${c.status}`,
                    )
                    .join("\n")}
                />
              </details>
            )}
          </Panel>
        ))
      ) : (
        <Empty>Create an API to get its public base URL.</Empty>
      )}
    </Page>
  );
}
export function HeartbeatPage() {
  const { data, error: loadError, refresh } = useLab();
  const action = useAction(refresh);
  const [name, setName] = useState("Nightly task"),
    [intervalSeconds, setIntervalValue] = useState(60),
    [graceSeconds, setGrace] = useState(15),
    [alertUrl, setAlert] = useState("");
  return (
    <Page
      eyebrow="MONITOR"
      title="Heartbeat watchdog"
      description="Give a script or scheduled job a URL to ping. A missed heartbeat creates an event and can notify your alert receiver."
    >
      <Note>
        Watches run while this Sevalla instance is awake, even with your browser
        closed. Deployments reset all watches. This is a temporary testing
        monitor.
      </Note>
      <Panel title="Create a watch">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() =>
              api("/api/lab/watchdogs", {
                name,
                intervalSeconds,
                graceSeconds,
                alertUrl,
              }),
            );
          }}
        >
          <div className="lab-form-grid">
            <Field label="Watch name">
              <input
                required
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Expected interval (seconds)">
              <input
                type="number"
                required
                min="5"
                max="86400"
                value={intervalSeconds}
                onChange={(e) => setIntervalValue(Number(e.target.value))}
              />
            </Field>
            <Field label="Extra grace period (seconds)">
              <input
                type="number"
                required
                min="0"
                max="86400"
                value={graceSeconds}
                onChange={(e) => setGrace(Number(e.target.value))}
              />
            </Field>
            <Field
              label="Alert webhook URL (optional)"
              help="A public HTTPS receiver, such as an incoming webhook connected to App Notifier. Leave empty for timeline alerts only."
            >
              <input
                type="url"
                className="technical"
                value={alertUrl}
                onChange={(e) => setAlert(e.target.value)}
                placeholder="https://your-alert-receiver.example/webhook"
              />
            </Field>
          </div>
          <button className="button primary" disabled={action.busy}>
            <Plus size={15} />
            Create watch
          </button>
        </form>
      </Panel>
      <ErrorBox error={action.error || loadError} />
      {data?.watchdogs.length ? (
        data.watchdogs.map((w) => (
          <Panel
            key={w.id}
            title={w.name}
            description={`Expected every ${w.intervalSeconds}s + ${w.graceSeconds}s grace`}
            actions={
              <div className="lab-actions">
                <span
                  className={`lab-badge ${w.status === "missed" ? "removed" : "added"}`}
                >
                  {w.status}
                </span>
                <button
                  className="icon-button"
                  aria-label={`Delete ${w.name}`}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(`/api/lab/watchdogs/${w.id}`, undefined, "DELETE"),
                    )
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            }
          >
            <div className="lab-url">
              <code>{absolute(`/heartbeat/${w.id}`)}</code>
              <Copy
                value={absolute(`/heartbeat/${w.id}`)}
                label="Copy ping URL"
              />
            </div>
            <div className="watch-details">
              <div>
                <small>Last ping</small>
                <strong>
                  {w.lastPing
                    ? new Date(w.lastPing).toLocaleString()
                    : "Waiting for the first ping"}
                </strong>
              </div>
              <div>
                <small>Alert delivery</small>
                <strong>{w.delivery}</strong>
              </div>
            </div>
            <div className="lab-actions">
              <button
                className="button"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    fetch(`/heartbeat/${w.id}`, {
                      method: "POST",
                      credentials: "omit",
                    }),
                  )
                }
              >
                <Send size={14} />
                Ping now
              </button>
              {w.alertUrl && (
                <button
                  className="button"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(`/api/lab/watchdogs/${w.id}/test-alert`, {}),
                    )
                  }
                >
                  Send test alert
                </button>
              )}
              <Copy
                label="Copy cURL"
                value={`curl --fail --silent --show-error '${absolute(`/heartbeat/${w.id}`)}'`}
              />
            </div>
          </Panel>
        ))
      ) : (
        <Empty>
          Create a watch, then call its URL after your scheduled task succeeds.
        </Empty>
      )}
      <Panel
        title="Connect an alert receiver"
        description="The receiver gets one event when a watch becomes overdue and one when it recovers. It should accept this JSON shape:"
      >
        <Code
          value={JSON.stringify(
            {
              event: "heartbeat.missed",
              source: "webhook-lab",
              correlationId: "watch-id",
              watchdog: {
                name: "Nightly task",
                status: "missed",
                lastPing: null,
                intervalSeconds: 60,
              },
              at: "ISO timestamp",
            },
            null,
            2,
          )}
        />
        <p className="lab-help">
          Map this payload to a notification in your receiver. Receiver-specific
          email, SMS, and Slack settings stay in App Notifier.
        </p>
      </Panel>
    </Page>
  );
}
