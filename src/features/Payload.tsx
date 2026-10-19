import { useState } from "react";
import { Download, FlaskConical } from "lucide-react";
import {
  mutatePayload,
  runnerScript,
  inferShape,
  checkShape,
  type Shape,
  type Mutation,
} from "../../shared/lab";
import {
  CaptureSelect,
  Code,
  Destination,
  download,
  Empty,
  encode,
  ErrorBox,
  Field,
  Note,
  Page,
  Panel,
  ScriptExport,
  useDestination,
} from "../lab-ui";

const sample =
  '{\n  "event": "order.created",\n  "data": { "id": "order_001", "amount": 2500, "email": "test@example.com" }\n}';
export function MutationPage() {
  const [body, setBody] = useState(sample),
    [variants, setVariants] = useState<Mutation[]>([]),
    [selected, setSelected] = useState<number[]>([]),
    [preview, setPreview] = useState(0),
    [error, setError] = useState(""),
    [destination, setDestination] = useDestination();
  function generate() {
    try {
      const items = mutatePayload(body);
      setVariants(items);
      setSelected(items.map((_, i) => i));
      setPreview(0);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  let script = "",
    scriptError = "";
  try {
    if (destination && selected.length)
      script = runnerScript(
        selected.map((i) => ({
          label: variants[i].name,
          method: "POST",
          query: "",
          headers: [["Content-Type", "application/json"]],
          bodyBase64: encode(variants[i].body),
          receivedAt: new Date().toISOString(),
          delayMs: 100,
        })),
        destination,
      );
  } catch (e) {
    scriptError = (e as Error).message;
  }
  return (
    <Page
      eyebrow="LOCAL REPLAY"
      title="Payload mutation"
      description="Generate deliberate variations of one JSON event, then test them against your application."
    >
      <Panel
        title="Original payload"
        description="The example below is editable. Your captured request stays unchanged."
      >
        <CaptureSelect
          onLoad={(r) => {
            if (r.binary) setError("Choose a JSON text request.");
            else {
              setBody(r.bodyText || "{}");
              setVariants([]);
              setSelected([]);
            }
          }}
        />
        <textarea
          rows={9}
          aria-label="Original payload"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setVariants([]);
            setSelected([]);
          }}
        />
        <div className="lab-actions">
          <button className="button primary" onClick={generate}>
            <FlaskConical size={15} />
            Generate variations
          </button>
        </div>
        <ErrorBox error={error} />
      </Panel>
      {variants.length > 0 && (
        <div className="lab-columns">
          <Panel
            title={`${variants.length} variations`}
            description="Choose which cases to send. Select a name to inspect it."
            actions={
              <button
                className="button"
                onClick={() =>
                  setSelected(selected.length ? [] : variants.map((_, i) => i))
                }
              >
                {selected.length ? "Deselect all" : "Select all"}
              </button>
            }
          >
            <div className="mutation-list">
              {variants.map((v, i) => (
                <div
                  key={i}
                  className={
                    preview === i ? "mutation-row active" : "mutation-row"
                  }
                >
                  <input
                    aria-label={`Include ${v.name}`}
                    type="checkbox"
                    checked={selected.includes(i)}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked ? [...s, i] : s.filter((n) => n !== i),
                      )
                    }
                  />
                  <button onClick={() => setPreview(i)}>{v.name}</button>
                </div>
              ))}
            </div>
          </Panel>
          <Panel
            title={variants[preview]?.name || "Preview"}
            actions={
              <button
                className="button"
                onClick={() =>
                  download(
                    "payload-variations.json",
                    JSON.stringify(
                      selected.map((i) => variants[i]),
                      null,
                      2,
                    ),
                    "application/json",
                  )
                }
              >
                <Download size={14} />
                Download cases
              </button>
            }
          >
            <Code value={variants[preview]?.body || ""} />
          </Panel>
        </div>
      )}
      <Panel title="Test destination">
        <Destination value={destination} onChange={setDestination} />
        <Note>
          Each variation is sent as a separate POST request, 100ms apart. The
          runner reports the status of every case.
        </Note>
        <ErrorBox error={scriptError} />
      </Panel>
      <ScriptExport script={script} name="payload-tests.mjs" />
    </Page>
  );
}
export function ContractPage() {
  const [baseline, setBaseline] = useState(sample),
    [candidate, setCandidate] = useState(""),
    [shape, setShape] = useState<Shape | null>(null),
    [issues, setIssues] = useState<string[] | null>(null),
    [error, setError] = useState(""),
    [samples, setSamples] = useState<string[]>([]);
  function learn() {
    try {
      const values = (samples.length ? samples : [baseline]).map((text) =>
        JSON.parse(text),
      );
      setShape(inferShape(values));
      setIssues(null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function load(file?: File) {
    if (!file) return;
    try {
      if (file.size > 262144)
        throw Error("Contract files must be smaller than 256 KiB.");
      const parsed = JSON.parse(await file.text());
      if (parsed.kind !== "webhook-contract" || !parsed.shape)
        throw Error("Choose an exported contract file.");
      checkShape(parsed.shape, {});
      setShape(parsed.shape);
      setError("");
      setIssues(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Page
      eyebrow="INSPECT"
      title="Contract detective"
      description="Learn a payload’s structure, then find missing fields, new fields, and changed types in future events."
    >
      <div className="lab-columns">
        <Panel
          title="1. Learn the baseline"
          description="Use one example, or collect several to learn which fields are optional."
        >
          <CaptureSelect
            onLoad={(r) => {
              if (r.binary) setError("Choose a JSON text capture.");
              else {
                setBaseline(r.bodyText || "{}");
                setSamples([]);
              }
            }}
          />
          <textarea
            aria-label="Baseline payload"
            rows={10}
            value={baseline}
            onChange={(e) => setBaseline(e.target.value)}
          />
          <div className="lab-actions">
            <button
              className="button"
              onClick={() => {
                try {
                  JSON.parse(baseline);
                  setSamples((s) => [...s, baseline].slice(-20));
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Add example ({samples.length}/20)
            </button>
            <button className="button primary" onClick={learn}>
              Learn contract
            </button>
            {samples.length > 0 && (
              <button className="text-button" onClick={() => setSamples([])}>
                Clear examples
              </button>
            )}
          </div>
          <label className="file-button button">
            Import contract
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => void load(e.target.files?.[0])}
            />
          </label>
        </Panel>
        <Panel title="2. Check a new event">
          <CaptureSelect
            onLoad={(r) => {
              setCandidate(r.bodyText || "");
              setIssues(null);
            }}
            label="Choose a request to check"
          />
          <textarea
            aria-label="Candidate payload"
            rows={10}
            value={candidate}
            onChange={(e) => {
              setCandidate(e.target.value);
              setIssues(null);
            }}
            placeholder="Paste a newer JSON event…"
          />
          <button
            className="button primary"
            disabled={!shape || !candidate}
            onClick={() => {
              try {
                setIssues(checkShape(shape!, JSON.parse(candidate)));
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Check for drift
          </button>
        </Panel>
      </div>
      <ErrorBox error={error} />
      {issues !== null && (
        <Panel
          title={
            issues.length
              ? `${issues.length} changes found`
              : "Contract matches"
          }
        >
          {issues.length ? (
            <ul className="issue-list">
              {issues.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          ) : (
            <Note>
              All observed types and required fields match the learned baseline.
            </Note>
          )}
        </Panel>
      )}
      {shape ? (
        <Panel
          title="Learned contract"
          description="This describes observed structure; it does not prove that a payload is semantically valid."
          actions={
            <button
              className="button"
              onClick={() =>
                download(
                  "webhook-contract.json",
                  JSON.stringify(
                    { version: 1, kind: "webhook-contract", shape },
                    null,
                    2,
                  ),
                  "application/json",
                )
              }
            >
              <Download size={14} />
              Export contract
            </button>
          }
        >
          <Code value={JSON.stringify(shape, null, 2)} />
        </Panel>
      ) : (
        <Empty>
          Your learned contract will appear here. Export it to keep it across
          page changes and deployments.
        </Empty>
      )}
    </Page>
  );
}
