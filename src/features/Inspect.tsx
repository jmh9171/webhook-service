import { useState } from "react";
import { Download } from "lucide-react";
import { diffValues } from "../../shared/lab";
import { isSensitiveHeader } from "../../shared/replay";
import type { CapturedRequest } from "../../shared/types";
import {
  CaptureSelect,
  Code,
  Copy,
  download,
  Empty,
  ErrorBox,
  Field,
  Note,
  Page,
  Panel,
} from "../lab-ui";

export function JsonPage() {
  const [input, setInput] = useState(""),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [result, setResult] = useState(""),
    [valid, setValid] = useState(false);
  function format(compact = false) {
    try {
      const value = JSON.parse(input);
      setInput(JSON.stringify(value, null, compact ? undefined : 2));
      setValid(true);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setValid(false);
    }
  }
  function search() {
    try {
      let value = JSON.parse(input);
      for (const part of query
        .replace(/^\$\.?/, "")
        .split(".")
        .filter(Boolean)) {
        if (
          value === null ||
          typeof value !== "object" ||
          !Object.hasOwn(value, part)
        )
          throw Error(`Field ${query} was not found.`);
        value = value[part];
      }
      setResult(JSON.stringify(value, null, 2));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Page
      eyebrow="UTILITIES"
      title="JSON workbench"
      description="Validate and format JSON, or extract a field. Data stays in this page unless you copy or download it."
    >
      <Panel
        title="Your JSON"
        actions={
          <div className="lab-actions">
            <Copy value={input} />
            <button
              className="button"
              disabled={!input}
              onClick={() =>
                download("payload.json", input, "application/json")
              }
            >
              <Download size={14} />
              Download
            </button>
          </div>
        }
      >
        <CaptureSelect
          onLoad={(r) => {
            if (r.binary)
              setError(
                "This capture contains binary data. Download its body from the Inbox.",
              );
            else {
              setInput(r.bodyText || "");
              setValid(false);
              setResult("");
            }
          }}
        />
        <textarea
          rows={17}
          aria-label="JSON input"
          placeholder={'{\n  "paste": "your JSON here"\n}'}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setValid(false);
            setResult("");
          }}
        />
        <div className="lab-actions">
          <button className="button primary" onClick={() => format()}>
            Validate & format
          </button>
          <button className="button" onClick={() => format(true)}>
            Minify
          </button>
          {valid && <span className="success-label">Valid JSON</span>}
        </div>
        <ErrorBox error={error} />
      </Panel>
      <Panel
        title="Extract a field"
        description="Use dot notation for fields and array indexes, such as data.items.0.id."
      >
        <div className="lab-inline">
          <input
            className="technical"
            aria-label="Field path"
            placeholder="data.items.0.id"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="button" onClick={search}>
            Extract
          </button>
        </div>
        {result && (
          <>
            <Code value={result} />
            <Copy value={result} />
          </>
        )}
      </Panel>
    </Page>
  );
}
function comparable(r: CapturedRequest, reveal: boolean) {
  const headers: Record<string, string[]> = {};
  for (const [name, value] of r.headers) {
    const key = name.toLowerCase();
    if (isSensitiveHeader(key) && !reveal) continue;
    (headers[key] ??= []).push(value);
  }
  let body: unknown = r.bodyText;
  try {
    body = JSON.parse(r.bodyText || "");
  } catch {
    /* Compare text as text. */
  }
  return {
    method: r.method,
    path: r.path,
    query: [...new URLSearchParams(r.query)],
    headers,
    body: r.binary ? "[binary body: compare downloaded files]" : body,
  };
}
export function ComparePage() {
  const [mode, setMode] = useState("captures"),
    [a, setA] = useState<CapturedRequest | null>(null),
    [b, setB] = useState<CapturedRequest | null>(null),
    [left, setLeft] = useState(""),
    [right, setRight] = useState(""),
    [reveal, setReveal] = useState(false);
  let changes: ReturnType<typeof diffValues> = [],
    error = "",
    ready = false;
  try {
    if (mode === "captures" && a && b) {
      changes = diffValues(comparable(a, reveal), comparable(b, reveal));
      ready = true;
    } else if (mode === "json" && left && right) {
      changes = diffValues(JSON.parse(left), JSON.parse(right));
      ready = true;
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <Page
      eyebrow="INSPECT"
      title="Compare"
      description="Find exactly what changed between two requests, or compare two JSON documents."
    >
      <Panel title="Comparison source">
        <div className="lab-form-grid">
          <Field label="Mode">
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="captures">Captured HTTP requests</option>
              <option value="json">Pasted JSON documents</option>
            </select>
          </Field>
          {mode === "captures" && (
            <label className="lab-check">
              <input
                type="checkbox"
                checked={reveal}
                onChange={(e) => setReveal(e.target.checked)}
              />
              Include sensitive header values
            </label>
          )}
        </div>
      </Panel>
      <div className="lab-columns">
        <Panel title="Before">
          {mode === "captures" ? (
            <>
              <CaptureSelect onLoad={setA} label="Earlier request" />
              {a && (
                <Code value={JSON.stringify(comparable(a, reveal), null, 2)} />
              )}
            </>
          ) : (
            <textarea
              rows={12}
              aria-label="Before JSON"
              value={left}
              onChange={(e) => setLeft(e.target.value)}
              placeholder="Paste original JSON…"
            />
          )}
        </Panel>
        <Panel title="After">
          {mode === "captures" ? (
            <>
              <CaptureSelect onLoad={setB} label="Later request" />
              {b && (
                <Code value={JSON.stringify(comparable(b, reveal), null, 2)} />
              )}
            </>
          ) : (
            <textarea
              rows={12}
              aria-label="After JSON"
              value={right}
              onChange={(e) => setRight(e.target.value)}
              placeholder="Paste changed JSON…"
            />
          )}
        </Panel>
      </div>
      <ErrorBox error={error} />
      <Panel
        title={
          ready
            ? changes.length
              ? `${changes.length} differences`
              : "No differences"
            : "Choose both sides"
        }
      >
        {ready ? (
          changes.length ? (
            <div className="diff-list">
              {changes.map((d, i) => (
                <article key={i}>
                  <div>
                    <span className={`lab-badge ${d.kind}`}>{d.kind}</span>
                    <code>{d.path}</code>
                  </div>
                  {d.before !== undefined && (
                    <pre className="diff-before">
                      − {JSON.stringify(d.before, null, 2)}
                    </pre>
                  )}
                  {d.after !== undefined && (
                    <pre className="diff-after">
                      + {JSON.stringify(d.after, null, 2)}
                    </pre>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <Note>The compared values match.</Note>
          )
        ) : (
          <Empty>
            Select two requests or paste two documents to see differences.
          </Empty>
        )}
      </Panel>
    </Page>
  );
}
