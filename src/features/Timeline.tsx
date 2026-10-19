import { useState } from "react";
import { ArrowRight, Send, Trash2 } from "lucide-react";
import { shellQuote } from "../../shared/replay";
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
export function TimelinePage() {
  const { data, error, refresh } = useLab();
  const [filter, setFilter] = useState(""),
    [source, setSource] = useState("all"),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false),
    [event, setEvent] = useState("notification.delivered"),
    [correlation, setCorrelation] = useState("order_001"),
    [status, setStatus] = useState("delivered");
  const url = data ? new URL(data.eventPath, location.origin).href : "";
  const payload = {
    event,
    correlationId: correlation,
    status,
    detail: "Event sent from the timeline test form",
  };
  const curl = `curl --request POST ${shellQuote(url)} \\\n  --header 'Content-Type: application/json' \\\n  --data-raw ${shellQuote(JSON.stringify(payload))}`;
  const items =
    data?.events.filter(
      (e) =>
        (source === "all" || source === e.source) &&
        `${e.title} ${e.correlation} ${e.status} ${e.detail}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
    ) ?? [];
  return (
    <Page
      eyebrow="MONITOR"
      title="Event timeline"
      description="Follow a request through your tools and external apps using one shared correlation ID."
    >
      <Note>
        Captured webhooks, simulator calls, and watchdog alerts appear
        automatically. To include notification delivery, have App Notifier or
        another app POST an event to the integration URL below.
      </Note>
      <Panel
        title="Activity"
        description="Newest first. Up to 300 events are retained in memory."
        actions={
          <button
            className="button"
            disabled={busy || !data?.events.length}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/lab/events", undefined, "DELETE");
                await refresh();
              } catch (e) {
                setFailure((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Trash2 size={14} />
            Clear timeline
          </button>
        }
      >
        <div className="lab-form-grid">
          <Field label="Search or correlation ID">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter a request’s full journey…"
            />
          </Field>
          <Field label="Source">
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {["all", "capture", "chaos", "mock", "heartbeat", "external"].map(
                (v) => (
                  <option key={v} value={v}>
                    {v === "all" ? "All sources" : v}
                  </option>
                ),
              )}
            </select>
          </Field>
        </div>
        <ErrorBox error={failure || error} />
        {items.length ? (
          <div className="event-timeline">
            {items.map((e) => (
              <article key={e.id}>
                <span
                  className={`timeline-point ${/missed|failed|^[45]/.test(e.status) ? "bad" : ""}`}
                />
                <div className="timeline-time">
                  {new Date(e.at).toLocaleTimeString()}
                  <small>{e.source}</small>
                </div>
                <div className="timeline-content">
                  <div>
                    <h3>{e.title}</h3>
                    <span className="lab-badge">{e.status}</span>
                  </div>
                  <p>{e.detail}</p>
                  <button
                    className="correlation-link"
                    title="Filter this correlation ID"
                    onClick={() => setFilter(e.correlation)}
                  >
                    {e.correlation}
                    <ArrowRight size={12} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty>
            {data?.events.length
              ? "No matching events. Try a different filter."
              : "Your first webhook or simulator request will start the timeline."}
          </Empty>
        )}
      </Panel>
      <Panel
        title="Connect another app"
        description="POST delivery events here with the same correlationId used by the original request."
      >
        <div className="lab-url">
          <code>{url || "Connecting…"}</code>
          <Copy value={url} label="Copy event URL" />
        </div>
        <Note>
          For captured requests, the ID comes from X-Correlation-Id,
          X-Request-Id, correlationId, event_id, data.id, or id, in that order.
          Without one, the capture’s ID is used.
        </Note>
        <div className="lab-form-grid">
          <Field label="Event name">
            <input value={event} onChange={(e) => setEvent(e.target.value)} />
          </Field>
          <Field label="Correlation ID">
            <input
              value={correlation}
              onChange={(e) => setCorrelation(e.target.value)}
            />
          </Field>
          <Field label="Status">
            <input value={status} onChange={(e) => setStatus(e.target.value)} />
          </Field>
        </div>
        <div className="lab-actions">
          <Copy value={curl} label="Copy integration cURL" />
          <button
            className="button"
            disabled={!url || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(data!.eventPath, payload);
                await refresh();
                setFailure("");
              } catch (e) {
                setFailure((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Send size={14} />
            Send test event
          </button>
        </div>
        <details>
          <summary>Integration example</summary>
          <Code value={curl} />
        </details>
      </Panel>
    </Page>
  );
}
