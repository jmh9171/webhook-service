import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Braces,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  Eye,
  EyeOff,
  Inbox,
  Link2,
  Loader2,
  LogOut,
  Radio,
  Search,
  Send,
  Settings2,
  Terminal,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import type { CapturedRequest, InboxSnapshot } from "../shared/types";
import {
  createCurl,
  isSensitiveHeader,
  replayHeaders,
  replayUrl,
} from "../shared/replay";

const targetKey = "webhook-inbox.replay-url.v1";
const sensitiveKey = "webhook-inbox.include-sensitive.v1";
function readSetting(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function bytes(value: number) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}
function time(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function targetError(value: string) {
  if (!value.trim()) return "";
  try {
    replayUrl(value, "");
    return "";
  } catch {
    return "Enter a complete http:// or https:// URL without credentials or a #fragment.";
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  if (response.status === 401)
    window.dispatchEvent(new Event("inbox:unauthorized"));
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Your dashboard session needs a sign-in. Refresh to continue."
        : response.status === 404
          ? "This request has expired or the inbox was cleared."
          : `The server returned ${response.status}. Please try again.`,
    );
  return response.json();
}

function CopyButton({
  value,
  children = "Copy",
  primary = false,
  disabled = false,
}: {
  value: string;
  children?: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2500);
  }
  return (
    <button
      className={primary ? "button primary" : "button"}
      disabled={disabled}
      onClick={copy}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? "Copied" : failed ? "Select text to copy" : children}
    </button>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-title">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function InboxPage() {
  const [snapshot, setSnapshot] = useState<InboxSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CapturedRequest | null>(null);
  const [tab, setTab] = useState<"body" | "headers" | "query" | "curl">("body");
  const [format, setFormat] = useState<"pretty" | "raw">("pretty");
  const [destination, setDestination] = useState(() => readSetting(targetKey));
  const [includeSensitive, setIncludeSensitive] = useState(
    () => readSetting(sensitiveKey) === "true",
  );
  const [storageError, setStorageError] = useState(false);
  const [settings, setSettings] = useState(false);
  const [guide, setGuide] = useState(false);
  const [clearDialog, setClearDialog] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const instance = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    try {
      localStorage.setItem(targetKey, destination);
      localStorage.setItem(sensitiveKey, String(includeSensitive));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [destination, includeSensitive]);

  const refresh = useCallback(async () => {
    try {
      const data = await api<InboxSnapshot>("/api/inbox");
      if (!mounted.current) return;
      if (instance.current && instance.current !== data.instanceId)
        setNotice(
          "The app restarted. Request history was reset; your browser settings are still saved.",
        );
      instance.current = data.instanceId;
      setSnapshot(data);
      setError("");
      setSelectedId((current) =>
        data.requests.some((request) => request.id === current)
          ? current
          : (data.requests[0]?.id ?? null),
      );
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      await refresh();
      if (!cancelled) timer = setTimeout(tick, 2000);
    }
    void tick();
    return () => {
      mounted.current = false;
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    setDetail(null);
    setDetailError("");
    setRevealed(false);
    if (!selectedId) return;
    let cancelled = false;
    api<CapturedRequest>(`/api/requests/${selectedId}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setDetailError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const captureUrl = snapshot
    ? new URL(snapshot.capturePath, window.location.origin).href
    : "";
  const invalidTarget = targetError(destination);
  let curl = "";
  let finalUrl = "";
  if (detail && destination.trim() && !invalidTarget) {
    finalUrl = replayUrl(destination, detail.query);
    curl = createCurl(detail, destination, includeSensitive);
  }
  const requests =
    snapshot?.requests.filter((request) =>
      `${request.method} ${request.path} ${request.query}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    ) ?? [];
  const requestCount = snapshot?.requests.length ?? 0;
  let body = detail?.bodyText ?? "";
  let json = false;
  if (detail?.bodyText) {
    try {
      const parsed = JSON.parse(detail.bodyText);
      json = true;
      if (format === "pretty") body = JSON.stringify(parsed, null, 2);
    } catch {
      /* Raw non-JSON text remains visible. */
    }
  }

  async function sendTest() {
    if (!snapshot) return;
    setBusy(true);
    try {
      const response = await fetch(snapshot.capturePath, {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Source": "inbox-test",
        },
        body: JSON.stringify(
          {
            event: "test.webhook",
            message: "Your inbox is ready.",
            data: { id: "evt_001", status: "delivered" },
            sent_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      });
      if (!response.ok)
        throw new Error(`Test request failed (${response.status}).`);
      await refresh();
      setTab("body");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    try {
      await api("/api/requests", {
        method: "DELETE",
        headers: { "X-Inbox-Action": "clear" },
      });
      await refresh();
      setClearDialog(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <main>
        <section className="page-heading">
          <div>
            <div className="eyebrow">WORKSPACE / REQUEST INSPECTOR</div>
            <h1>
              The inbox<span>_</span>
            </h1>
            <p>Catch incoming webhooks. Take them back to localhost.</p>
          </div>
          <div className="heading-counter">
            <strong>{String(requestCount).padStart(2, "0")}</strong>
            <span>
              CAPTURED
              <br />
              REQUESTS
            </span>
          </div>
        </section>
        {error && (
          <div className="alert" role="alert">
            {error}
            <button className="text-button" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button
              className="icon-button"
              aria-label="Dismiss notice"
              onClick={() => setNotice("")}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <section className="setup-grid">
          <div className="endpoint-card">
            <div className="card-eyebrow">
              <span>
                <Radio size={14} /> YOUR CAPTURE URL
              </span>
              <span className="https-label">
                {location.protocol === "https:" ? "HTTPS" : "LOCAL"}
              </span>
            </div>
            <div className="endpoint-row">
              <code title={captureUrl}>
                {captureUrl || "Connecting to your inbox…"}
              </code>
              <CopyButton value={captureUrl} primary disabled={!captureUrl}>
                Copy URL
              </CopyButton>
            </div>
            <p>
              Point your webhook provider here. Incoming requests appear below.
            </p>
          </div>
          <button className="replay-setting" onClick={() => setSettings(true)}>
            <div className="setting-top">
              <span className="card-eyebrow">
                <Settings2 size={14} /> LOCAL REPLAY URL
              </span>
              <ArrowUpRight size={17} />
            </div>
            <div className={`saved-destination ${!destination ? "unset" : ""}`}>
              {destination || "Set your localhost destination"}
            </div>
            <div className="setting-foot">
              <span className="tiny-dot" />
              {storageError
                ? "Browser storage unavailable"
                : destination
                  ? "Remembered in this browser"
                  : "Set once. Reuse every time."}
            </div>
          </button>
        </section>
        <section className="workspace" aria-label="Request inspector">
          <aside className="request-panel">
            <div className="panel-heading">
              <h2>
                Requests <span className="count">{requestCount}</span>
              </h2>
              <button
                className="icon-button delete-button"
                title="Clear all requests"
                aria-label="Clear all requests"
                disabled={!requestCount || busy}
                onClick={() => setClearDialog(true)}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="search-wrap">
              <Search size={15} />
              <input
                aria-label="Filter requests"
                placeholder="Filter by method or path…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <span className="search-label">FILTER</span>
            </div>
            <div className="request-list">
              {requests.length ? (
                requests.map((request) => (
                  <button
                    className={`request-row ${selectedId === request.id ? "selected" : ""}`}
                    key={request.id}
                    onClick={() => setSelectedId(request.id)}
                  >
                    <div className="request-row-top">
                      <span
                        className={`method method-${request.method.toLowerCase()}`}
                      >
                        {request.method}
                      </span>
                      <span className="request-time">
                        {time(request.receivedAt)}
                      </span>
                    </div>
                    <div
                      className="request-path"
                      title={`${request.path}${request.query ? `?${request.query}` : ""}`}
                    >
                      {request.path}
                      {request.query ? `?${request.query}` : ""}
                    </div>
                    <div className="request-row-bottom">
                      <span>
                        {request.contentType.split(";")[0] || "No content type"}
                      </span>
                      <span>
                        {bytes(request.size)}
                        <ChevronRight size={13} />
                      </span>
                    </div>
                  </button>
                ))
              ) : (
                <div className="list-empty">
                  <Inbox size={28} strokeWidth={1.3} />
                  <strong>
                    {filter ? "No matching requests" : "Nothing here yet"}
                  </strong>
                  <p>
                    {filter
                      ? "Try a different method or path."
                      : "Your next webhook will land right here."}
                  </p>
                </div>
              )}
            </div>
            <div className="list-footer">
              <Clock3 size={13} />
              Last {snapshot?.limits.maxRequests ?? 100} requests · temporary
              history
            </div>
          </aside>
          <div className="detail-panel">
            {detailError ? (
              <div className="detail-empty">
                <Inbox size={35} />
                <h2>Request no longer available</h2>
                <p>{detailError}</p>
                <button className="button" onClick={() => void refresh()}>
                  Refresh inbox
                </button>
              </div>
            ) : !selectedId ? (
              <div className="detail-empty">
                <div className="empty-icon">
                  <Webhook size={35} strokeWidth={1.5} />
                  <span />
                </div>
                <span className="eyebrow">READY WHEN YOU ARE</span>
                <h2>Waiting for a webhook.</h2>
                <p>
                  Send a request to your capture URL to see its
                  <br className="desktop-break" /> body, headers, and everything
                  in between.
                </p>
                <button
                  className="button dark"
                  onClick={() => void sendTest()}
                  disabled={!snapshot || busy}
                >
                  {busy ? (
                    <Loader2 className="spin" size={16} />
                  ) : (
                    <Send size={16} />
                  )}
                  Send a test request
                  <ArrowRight size={16} />
                </button>
                <span className="empty-note">
                  A real request, straight to your inbox.
                </span>
                <div className="workflow">
                  <span>
                    <i>01</i>Capture
                  </span>
                  <ChevronRight size={13} />
                  <span>
                    <i>02</i>Inspect
                  </span>
                  <ChevronRight size={13} />
                  <span>
                    <i>03</i>Replay locally
                  </span>
                </div>
              </div>
            ) : !detail ? (
              <div className="detail-empty">
                <Loader2 size={25} className="spin" />
                <p>Loading request…</p>
              </div>
            ) : (
              <>
                <div className="detail-heading">
                  <div>
                    <div className="detail-title">
                      <span
                        className={`method method-${detail.method.toLowerCase()}`}
                      >
                        {detail.method}
                      </span>
                      <span className="received-badge">
                        <Check size={12} />
                        Received
                      </span>
                      <span className="detail-size">{bytes(detail.size)}</span>
                    </div>
                    <h2 title={detail.path}>{detail.path}</h2>
                    <div className="detail-meta">
                      {new Date(detail.receivedAt).toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      at {time(detail.receivedAt)}
                      <span>·</span>
                      {detail.contentType || "No content type"}
                    </div>
                  </div>
                  <button
                    className="button dark replay-button"
                    onClick={() => {
                      if (!destination.trim() || invalidTarget)
                        setSettings(true);
                      else setTab("curl");
                    }}
                  >
                    <Terminal size={15} />
                    Replay locally
                    <ArrowUpRight size={14} />
                  </button>
                </div>
                <div
                  className="tabs"
                  role="tablist"
                  aria-label="Request details"
                >
                  {(
                    [
                      ["body", "Body", <Braces size={15} />],
                      ["headers", "Headers", <Code2 size={15} />],
                      ["query", "Query", <Link2 size={15} />],
                      ["curl", "cURL / Postman", <Terminal size={15} />],
                    ] as const
                  ).map(([name, label, icon]) => (
                    <button
                      id={`tab-${name}`}
                      key={name}
                      role="tab"
                      aria-selected={tab === name}
                      aria-controls={`content-${name}`}
                      onClick={() => setTab(name)}
                      className={tab === name ? "active" : ""}
                    >
                      {icon}
                      {label}
                      {name === "headers" && (
                        <span>{detail.headers.length}</span>
                      )}
                      {name === "query" && detail.query && (
                        <span>
                          {Array.from(new URLSearchParams(detail.query)).length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <div
                  className="tab-content"
                  id={`content-${tab}`}
                  role="tabpanel"
                  aria-labelledby={`tab-${tab}`}
                >
                  {tab === "body" && (
                    <>
                      <div className="content-toolbar">
                        <div className="segmented">
                          <button
                            className={format === "pretty" ? "active" : ""}
                            onClick={() => setFormat("pretty")}
                          >
                            Pretty
                          </button>
                          <button
                            className={format === "raw" ? "active" : ""}
                            onClick={() => setFormat("raw")}
                          >
                            Raw
                          </button>
                        </div>
                        <div className="toolbar-actions">
                          <span className="language-label">
                            {detail.binary ? "BINARY" : json ? "JSON" : "TEXT"}
                          </span>
                          {!detail.binary && (
                            <CopyButton value={detail.bodyText ?? ""}>
                              Copy body
                            </CopyButton>
                          )}
                          <a
                            className="icon-button"
                            href={`/api/requests/${detail.id}/body`}
                            download="webhook-body.bin"
                            aria-label="Download original body"
                            title="Download original body"
                          >
                            <ArrowDownToLine size={16} />
                          </a>
                        </div>
                      </div>
                      {detail.binary ? (
                        <div className="binary-body">
                          <Braces size={30} />
                          <h3>Original bytes, kept intact.</h3>
                          <p>
                            This body is binary, compressed, or multipart.
                            <br />
                            Download it and attach it as a binary body in
                            Postman.
                          </p>
                          <a
                            className="button"
                            href={`/api/requests/${detail.id}/body`}
                            download="webhook-body.bin"
                          >
                            <ArrowDownToLine size={15} />
                            Download body
                          </a>
                        </div>
                      ) : !detail.size ? (
                        <div className="binary-body">
                          <Braces size={28} />
                          <h3>No request body</h3>
                          <p>This request arrived without a body.</p>
                        </div>
                      ) : (
                        <div className="code-editor">
                          <div className="line-numbers" aria-hidden="true">
                            {body
                              .split("\n")
                              .slice(0, 2000)
                              .map((_, index) => (
                                <div key={index}>{index + 1}</div>
                              ))}
                          </div>
                          <pre>
                            <code>{body}</code>
                          </pre>
                        </div>
                      )}
                      <div className="body-footer">
                        <span className="tiny-dot" />
                        Original bytes preserved for replay
                        <span>{bytes(detail.size)}</span>
                      </div>
                    </>
                  )}
                  {tab === "headers" && (
                    <>
                      <div className="content-toolbar">
                        <span className="small-label">
                          {detail.headers.length} request headers
                        </span>
                        <button
                          className="button"
                          onClick={() => setRevealed(!revealed)}
                        >
                          {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                          {revealed
                            ? "Hide sensitive values"
                            : "Reveal sensitive values"}
                        </button>
                      </div>
                      <div className="data-table">
                        <div className="table-header">
                          <span>NAME</span>
                          <span>VALUE</span>
                        </div>
                        {detail.headers.map(([name, value], index) => (
                          <div className="table-row" key={index}>
                            <span>{name}</span>
                            <code>
                              {isSensitiveHeader(name) && !revealed
                                ? "••••••••"
                                : value}
                            </code>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {tab === "query" && (
                    <>
                      <div className="content-toolbar">
                        <span className="small-label">Query parameters</span>
                      </div>
                      {detail.query ? (
                        <div className="data-table">
                          <div className="table-header">
                            <span>NAME</span>
                            <span>VALUE</span>
                          </div>
                          {Array.from(new URLSearchParams(detail.query)).map(
                            ([name, value], index) => (
                              <div className="table-row" key={index}>
                                <span>{name}</span>
                                <code>{value || "(empty)"}</code>
                              </div>
                            ),
                          )}
                        </div>
                      ) : (
                        <div className="binary-body">
                          <Link2 size={28} />
                          <h3>No query parameters</h3>
                          <p>This request has no query string.</p>
                        </div>
                      )}
                    </>
                  )}
                  {tab === "curl" && (
                    <div className="curl-content">
                      <div className="replay-destination">
                        <div>
                          <span className="eyebrow">REPLAY DESTINATION</span>
                          <code>
                            {finalUrl || "Choose your local endpoint"}
                          </code>
                        </div>
                        <button
                          className="icon-button"
                          aria-label="Edit replay settings"
                          onClick={() => setSettings(true)}
                        >
                          <Settings2 size={17} />
                        </button>
                      </div>
                      {!curl ? (
                        <div className="binary-body">
                          <Terminal size={28} />
                          <h3>Where should this request go?</h3>
                          <p>
                            Set your local URL once. This browser will remember
                            it.
                          </p>
                          <button
                            className="button dark"
                            onClick={() => setSettings(true)}
                          >
                            Set replay URL
                            <ArrowRight size={15} />
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="content-toolbar">
                            <span className="small-label">
                              Ready to import into Postman
                            </span>
                            <CopyButton value={curl} primary>
                              Copy for Postman
                            </CopyButton>
                          </div>
                          <pre className="curl-code">
                            <code>{curl}</code>
                          </pre>
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={includeSensitive}
                              onChange={(event) =>
                                setIncludeSensitive(event.target.checked)
                              }
                            />
                            Include sensitive headers (Authorization, Cookie,
                            API keys)
                          </label>
                          <p className="export-note">
                            {detail.headers.length -
                              replayHeaders(detail.headers, includeSensitive)
                                .length}{" "}
                            transport, proxy, or sensitive headers omitted.
                            Method, query, and body are preserved.
                          </p>
                          {detail.binary && (
                            <div className="notice">
                              Download the original body and attach it as a
                              binary body in Postman.
                              <a
                                href={`/api/requests/${detail.id}/body`}
                                download="webhook-body.bin"
                              >
                                Download body
                              </a>
                            </div>
                          )}
                          {detail.headers.some(([name]) =>
                            /signature|timestamp/i.test(name),
                          ) && (
                            <p className="export-note">
                              Captured signatures may fail freshness checks or
                              validation against a different URL.
                            </p>
                          )}
                          <div className="postman-tip">
                            <span className="tip-icon">
                              <ArrowUpRight size={17} />
                            </span>
                            <div>
                              <strong>From here to localhost</strong>
                              <p>
                                Open Postman on your computer → Import → paste
                                the cURL → Send.
                              </p>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
        <footer className="page-footer">
          <span>
            <span className="tiny-dot" />
            TEMPORARY HISTORY / CLEARED ON RESTART
          </span>
          <button
            className="text-button"
            disabled={!snapshot || busy}
            onClick={() => void sendTest()}
          >
            <Send size={13} />
            Send test request
            <ArrowUpRight size={13} />
          </button>
        </footer>
      </main>
      {settings && (
        <Modal title="Local replay settings" onClose={() => setSettings(false)}>
          <p className="modal-description">
            Choose where copied requests should go. This stays in your browser
            and is reused for every cURL export.
          </p>
          <label className="field-label" htmlFor="replay-url">
            Local endpoint URL
          </label>
          <input
            id="replay-url"
            className={`url-input ${invalidTarget ? "invalid" : ""}`}
            autoFocus
            type="url"
            placeholder="http://localhost:3000/api/webhooks"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            aria-describedby="url-help"
          />
          <p
            id="url-help"
            className={invalidTarget ? "field-error" : "field-help"}
          >
            {invalidTarget ||
              "Use your complete local route. Incoming query parameters are appended automatically."}
          </p>
          <div className="saved-message" role="status">
            {storageError ? (
              "Browser storage is unavailable. This URL will only last until you refresh."
            ) : (
              <>
                <Check size={15} />
                Changes saved automatically in this browser.
              </>
            )}
          </div>
          <div className="modal-actions">
            <button className="button dark" onClick={() => setSettings(false)}>
              Done
              <Check size={15} />
            </button>
          </div>
        </Modal>
      )}
      {guide && (
        <Modal
          title="A webhook, all the way home."
          onClose={() => setGuide(false)}
        >
          <div className="guide-steps">
            <div>
              <span>01</span>
              <section>
                <h3>Give your provider the capture URL</h3>
                <p>
                  Copy the URL at the top of the page and use it as your
                  provider's webhook endpoint.
                </p>
              </section>
            </div>
            <div>
              <span>02</span>
              <section>
                <h3>Inspect what actually arrived</h3>
                <p>
                  Choose a request to view its original body, headers, and query
                  parameters.
                </p>
              </section>
            </div>
            <div>
              <span>03</span>
              <section>
                <h3>Replay it against localhost</h3>
                <p>
                  Set your local URL in replay settings. Copy the cURL from the
                  request's cURL / Postman tab, then import it into the Postman
                  desktop app and send.
                </p>
              </section>
            </div>
          </div>
          <div className="postman-tip">
            <Clock3 size={20} />
            <p>
              The last 100 requests are kept in memory, up to 20 MiB of bodies.
              Older requests are evicted; a server restart clears history. Your
              local URL stays saved in this browser.
            </p>
          </div>
          <div className="modal-actions">
            <button className="button dark" onClick={() => setGuide(false)}>
              Got it
              <Check size={15} />
            </button>
          </div>
        </Modal>
      )}
      {clearDialog && (
        <Modal title="Clear your inbox?" onClose={() => setClearDialog(false)}>
          <p className="modal-description">
            This removes all {requestCount} captured requests. Your capture URL
            and browser replay settings stay the same.
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setClearDialog(false)}>
              Keep requests
            </button>
            <button
              className="button danger"
              onClick={() => void clear()}
              disabled={busy}
            >
              <Trash2 size={15} />
              {busy ? "Clearing…" : "Clear all requests"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
