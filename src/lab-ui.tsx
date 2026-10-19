import { useEffect, useRef, useState } from "react";
import { Check, Copy as CopyIcon, Download, RefreshCw } from "lucide-react";
import type { CapturedRequest, InboxSnapshot, LabState } from "../shared/types";
import type { ReplayRecord } from "../shared/lab";
import { fromCapture } from "../shared/lab";

export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { "X-Inbox-Action": "manage" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401)
    window.dispatchEvent(new Event("inbox:unauthorized"));
  const data = await response.json();
  if (!response.ok)
    throw Error(
      data.error || data.message || `Request failed (${response.status})`,
    );
  return data;
}
export function useInbox() {
  const [data, setData] = useState<InboxSnapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = () =>
      api<InboxSnapshot>("/api/inbox")
        .then((d) => {
          if (live) {
            setData(d);
            setError("");
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return { data, error };
}
export function useLab() {
  const [data, setData] = useState<LabState | null>(null),
    [error, setError] = useState("");
  const live = useRef(true);
  async function refresh() {
    try {
      const d = await api<LabState>("/api/lab");
      if (live.current) {
        setData(d);
        setError("");
      }
    } catch (e) {
      if (live.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    live.current = true;
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, []);
  return { data, error, refresh };
}
export function download(name: string, value: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function toBase64(bytes: Uint8Array) {
  let str = "";
  for (let i = 0; i < bytes.length; i += 8192)
    str += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(str);
}
export function fromBase64(text: string) {
  return Uint8Array.from(
    atob(text.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
export function encode(text: string) {
  return toBase64(new TextEncoder().encode(text));
}
export function Copy({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [state, setState] = useState("");
  useEffect(() => setState(""), [value]);
  return (
    <button
      className="button"
      disabled={!value}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => setState("Copied"),
          () => setState("Copy failed"),
        );
      }}
    >
      {state === "Copied" ? <Check size={14} /> : <CopyIcon size={14} />}{" "}
      {state || label}
    </button>
  );
}
export function Page({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="lab-page">
      <div className="lab-page-heading">
        <div className="eyebrow">{eyebrow}</div>
        <h1>
          {title}
          <span>.</span>
        </h1>
        <p>{description}</p>
      </div>
      {children}
    </main>
  );
}
export function Panel({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="lab-panel">
      <div className="lab-panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="lab-field">
      <label>
        <span>{label}</span>
        {children}
      </label>
      {help && <small>{help}</small>}
    </div>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return error ? (
    <p className="lab-error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Note({ children }: { children: React.ReactNode }) {
  return <div className="lab-note">{children}</div>;
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="lab-empty">{children}</div>;
}
export function Code({ value }: { value: string }) {
  return (
    <pre className="lab-code">
      <code>{value}</code>
    </pre>
  );
}
export function ScriptExport({
  script,
  name = "webhook-replay.mjs",
}: {
  script: string;
  name?: string;
}) {
  return (
    <Panel
      title="Run on your machine"
      description={`Download the script, review its destination, then run: node ${name}`}
      actions={
        <div className="lab-actions">
          <Copy value={script} label="Copy script" />
          <button
            className="button primary"
            disabled={!script}
            onClick={() => download(name, script, "text/javascript")}
          >
            <Download size={14} />
            Download .mjs
          </button>
        </div>
      }
    >
      {script ? (
        <details>
          <summary>Inspect generated script</summary>
          <Code value={script} />
        </details>
      ) : (
        <Empty>
          Choose requests and a valid destination to prepare your script.
        </Empty>
      )}
      <Note>
        The hosted app does not send these requests. Node.js 22+ on your
        computer sends them to your local endpoint. Authorization, cookies, and
        API key headers are excluded.
      </Note>
    </Panel>
  );
}
export function Destination({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field
      label="Destination URL"
      help="Saved in this browser and shared with the inbox replay setting."
    >
      <input
        className="technical"
        type="url"
        value={value}
        placeholder="http://localhost:3000/api/webhooks"
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
export function useDestination(): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem("webhook-inbox.replay-url.v1") || "";
    } catch {
      return "";
    }
  });
  return [
    value,
    (v) => {
      setValue(v);
      try {
        localStorage.setItem("webhook-inbox.replay-url.v1", v);
      } catch {
        /* Session setting still works. */
      }
    },
  ];
}
export function CaptureSelect({
  onLoad,
  label = "Load a captured request",
}: {
  onLoad: (r: CapturedRequest) => void;
  label?: string;
}) {
  const { data, error } = useInbox();
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  return (
    <div className="capture-select">
      <label>
        {label}
        <select
          defaultValue=""
          disabled={busy}
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            setBusy(true);
            setFailure("");
            void api<CapturedRequest>(`/api/requests/${id}`)
              .then(onLoad)
              .catch((e) => setFailure(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <option value="">
            {busy ? "Loading…" : "Choose from your inbox…"}
          </option>
          {data?.requests.map((r) => (
            <option key={r.id} value={r.id}>
              {r.method} {r.path} ·{" "}
              {new Date(r.receivedAt).toLocaleTimeString()}
            </option>
          ))}
        </select>
      </label>
      <ErrorBox error={failure || error} />
      {data && !data.requests.length && (
        <small>
          No captures yet. Send a webhook from the Inbox first, or paste your
          own data below.
        </small>
      )}
    </div>
  );
}
export function RecordPicker({
  onChange,
}: {
  onChange: (r: ReplayRecord[]) => void;
}) {
  const { data, error } = useInbox();
  const [chosen, setChosen] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const version = useRef(0);
  async function select(ids: string[]) {
    const revision = ++version.current;
    setChosen(ids);
    setBusy(true);
    setFailure("");
    try {
      const records = await Promise.all(
        ids.map(async (id) => {
          const request = await api<CapturedRequest>(`/api/requests/${id}`);
          const res = await fetch(`/api/requests/${id}/body`);
          if (!res.ok)
            throw Error("A selected request expired. Refresh the selection.");
          return fromCapture(
            request,
            toBase64(new Uint8Array(await res.arrayBuffer())),
          );
        }),
      );
      if (revision === version.current) onChange(records);
    } catch (e) {
      if (revision === version.current) {
        setFailure((e as Error).message);
        onChange([]);
      }
    } finally {
      if (revision === version.current) setBusy(false);
    }
  }
  return (
    <Panel
      title="Choose your recording"
      description="Only selected requests are included. Original body bytes and query parameters are preserved."
      actions={
        <button
          className="button"
          disabled={busy}
          onClick={() =>
            void select(
              chosen.length ? [] : (data?.requests.map((r) => r.id) ?? []),
            )
          }
        >
          {chosen.length ? "Deselect all" : "Select all"}
        </button>
      }
    >
      <ErrorBox error={failure || error} />
      <div className="record-list">
        {data?.requests.length ? (
          data.requests.map((r) => (
            <label key={r.id} className="record-option">
              <input
                type="checkbox"
                checked={chosen.includes(r.id)}
                disabled={busy}
                onChange={(e) =>
                  void select(
                    e.target.checked
                      ? [...chosen, r.id]
                      : chosen.filter((id) => id !== r.id),
                  )
                }
              />
              <span className="method">{r.method}</span>
              <code>{r.path}</code>
              <small>{new Date(r.receivedAt).toLocaleTimeString()}</small>
            </label>
          ))
        ) : (
          <Empty>
            No requests captured yet. Open the Inbox and send a test request to
            get started.
          </Empty>
        )}
      </div>
      <div className="lab-meta">
        {busy ? (
          <>
            <RefreshCw size={13} />
            Preparing original bytes…
          </>
        ) : (
          `${chosen.length} requests selected`
        )}
      </div>
    </Panel>
  );
}
