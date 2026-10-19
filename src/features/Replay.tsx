import { useState } from "react";
import {
  Download,
  Plus,
  Trash2,
  ArrowDown,
  ArrowUp,
  Upload,
} from "lucide-react";
import {
  runnerScript,
  sequencePlan,
  setJsonPath,
  type ReplayRecord,
  type Json,
} from "../../shared/lab";
import {
  Code,
  Destination,
  download,
  encode,
  ErrorBox,
  Field,
  Note,
  Page,
  Panel,
  RecordPicker,
  ScriptExport,
  useDestination,
  CaptureSelect,
} from "../lab-ui";

export function ReplayPage({ disorder = false }: { disorder?: boolean }) {
  const [records, setRecords] = useState<ReplayRecord[]>([]),
    [destination, setDestination] = useDestination();
  const [order, setOrder] = useState<"original" | "reverse" | "shuffle">(
      "original",
    ),
    [speed, setSpeed] = useState(1),
    [burst, setBurst] = useState(false),
    [duplicates, setDuplicates] = useState(2),
    [omitEvery, setOmit] = useState(0),
    [seed, setSeed] = useState(42);
  let script = "",
    error = "",
    plan: ReplayRecord[] = [];
  try {
    if (records.length && destination) {
      plan = sequencePlan(records, {
        order,
        seed,
        duplicates: disorder ? duplicates : 1,
        omitEvery: disorder ? omitEvery : 0,
        speed,
        burst: disorder || burst,
      });
      script = runnerScript(plan, destination, {
        burst: disorder ? false : burst,
      });
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <Page
      eyebrow="LOCAL REPLAY"
      title={disorder ? "Event disorder" : "Time machine"}
      description={
        disorder
          ? "Duplicate, shuffle, or omit events to check whether your application handles messy delivery."
          : "Turn captured traffic into a recording you can replay on your machine."
      }
    >
      <Note>
        {disorder
          ? "This changes which requests arrive and their order. Use Time machine when you only want to change playback speed."
          : "This keeps the recording intact. Use Event disorder to deliberately duplicate or drop events."}
      </Note>
      <RecordPicker onChange={setRecords} />
      <Panel title={disorder ? "Delivery pattern" : "Playback controls"}>
        <div className="lab-form-grid">
          <Destination value={destination} onChange={setDestination} />
          <Field label="Order">
            <select
              value={order}
              onChange={(e) => setOrder(e.target.value as typeof order)}
            >
              <option value="original">Oldest first</option>
              <option value="reverse">Newest first (reverse)</option>
              {disorder && (
                <option value="shuffle">Shuffle with a repeatable seed</option>
              )}
            </select>
          </Field>
          {disorder ? (
            <>
              <Field
                label="Copies of each event"
                help="1 keeps one copy. 2 sends every retained event twice."
              >
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={duplicates}
                  onChange={(e) => setDuplicates(Number(e.target.value))}
                />
              </Field>
              <Field label="Omit every Nth event" help="0 keeps every event.">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={omitEvery}
                  onChange={(e) => setOmit(Number(e.target.value))}
                />
              </Field>
              {order === "shuffle" && (
                <Field label="Shuffle seed">
                  <input
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                  />
                </Field>
              )}
            </>
          ) : (
            <>
              <Field label="Playback speed">
                <select
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  <option value="0.1">0.1× · ten times slower</option>
                  <option value="1">1× · original gaps</option>
                  <option value="10">10× · ten times faster</option>
                  <option value="100">100× · quick playback</option>
                </select>
              </Field>
              <label className="lab-check">
                <input
                  type="checkbox"
                  checked={burst}
                  onChange={(e) => setBurst(e.target.checked)}
                />
                Burst: send all requests at once
              </label>
            </>
          )}
        </div>
        <ErrorBox error={error} />
        {plan.length > 0 && (
          <div className="lab-stat-row">
            <strong>
              {plan.length}
              <small>outgoing requests</small>
            </strong>
            <strong>
              {Math.round(
                plan.reduce((s, r) => s + (r.delayMs ?? 0), 0) / 1000,
              )}
              s<small>scheduled waiting, plus response time</small>
            </strong>
          </div>
        )}
      </Panel>
      <ScriptExport script={script} />
    </Page>
  );
}
interface Step {
  id: string;
  name: string;
  delayMs: number;
  method: string;
  field: string;
  value: string;
  destination: string;
}
const newStep = (): Step => ({
  id: crypto.randomUUID(),
  name: "Send event",
  delayMs: 1000,
  method: "POST",
  field: "",
  value: '"processed"',
  destination: "",
});
export function WorkflowPage() {
  const [destination, setDestination] = useDestination(),
    [body, setBody] = useState(
      '{\n  "event": "order.created",\n  "data": { "id": "order_001", "status": "new" }\n}',
    ),
    [steps, setSteps] = useState<Step[]>([
      { ...newStep(), name: "Order received", delayMs: 0 },
      { ...newStep(), name: "Order processed", field: "data.status" },
    ]),
    [trigger, setTrigger] = useState(false),
    [port, setPort] = useState(8788),
    [failure, setFailure] = useState("");
  function update(id: string, change: Partial<Step>) {
    setSteps((s) =>
      s.map((step) => (step.id === id ? { ...step, ...change } : step)),
    );
  }
  let script = "",
    error = "";
  try {
    let parsed = JSON.parse(body) as Json;
    if (steps.length > 20) throw Error("Use at most 20 steps.");
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw Error("Local trigger port must be between 1024 and 65535.");
    const changes: { path: string; value: Json }[] = [];
    const records = steps.map((step) => {
      if (
        !Number.isInteger(step.delayMs) ||
        step.delayMs < 0 ||
        step.delayMs > 60000
      )
        throw Error("Step delays must be from 0 to 60,000 milliseconds.");
      if (step.field) {
        if (
          step.field
            .split(".")
            .some(
              (p) =>
                !p || ["__proto__", "constructor", "prototype"].includes(p),
            )
        )
          throw Error("Use a valid dot-separated field path.");
        const value = JSON.parse(step.value) as Json;
        parsed = setJsonPath(parsed, step.field, value);
        changes.push({ path: step.field, value });
      }
      return {
        label: step.name || "Send event",
        method: step.method,
        query: "",
        headers: [["Content-Type", "application/json"]] as [string, string][],
        bodyBase64: encode(body),
        receivedAt: new Date().toISOString(),
        delayMs: step.delayMs,
        destination: step.destination || undefined,
        useTrigger: trigger,
        changes: [...changes],
      };
    });
    if (destination)
      script = runnerScript(records, destination, {
        listenPort: trigger ? port : undefined,
      });
  } catch (e) {
    error = (e as Error).message;
  }
  function save() {
    download(
      "webhook-workflow.json",
      JSON.stringify(
        {
          version: 1,
          kind: "webhook-workflow",
          destination,
          body,
          steps,
          trigger,
          port,
        },
        null,
        2,
      ),
      "application/json",
    );
  }
  async function load(file?: File) {
    if (!file) return;
    setFailure("");
    try {
      if (file.size > 524288)
        throw Error("Scenario files must be smaller than 512 KiB.");
      const v = JSON.parse(await file.text());
      if (
        v.version !== 1 ||
        v.kind !== "webhook-workflow" ||
        typeof v.body !== "string" ||
        typeof v.destination !== "string" ||
        !Array.isArray(v.steps) ||
        !v.steps.length ||
        v.steps.length > 20
      )
        throw Error("Choose an exported Webhook Lab workflow.");
      if (
        v.steps.some(
          (s: Step) =>
            typeof s.name !== "string" ||
            typeof s.field !== "string" ||
            typeof s.value !== "string" ||
            typeof s.destination !== "string" ||
            typeof s.delayMs !== "number" ||
            ![
              "GET",
              "HEAD",
              "POST",
              "PUT",
              "PATCH",
              "DELETE",
              "OPTIONS",
            ].includes(s.method),
        )
      )
        throw Error("Workflow contains an invalid step.");
      setBody(v.body);
      setDestination(v.destination);
      setSteps(v.steps.map((s: Step) => ({ ...s, id: crypto.randomUUID() })));
      setTrigger(!!v.trigger);
      setPort(v.port || 8788);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <Page
      eyebrow="LOCAL REPLAY"
      title="Workflow builder"
      description="Arrange a sequence of events, add delays, and change fields between steps. The workflow runs on your computer."
    >
      <Panel
        title="Starting event"
        description="Paste a JSON event or use an existing capture."
        actions={
          <div className="lab-actions">
            <label className="button file-button">
              <Upload size={14} />
              Import workflow
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => void load(e.target.files?.[0])}
              />
            </label>
            <button className="button" onClick={save}>
              <Download size={14} />
              Save workflow
            </button>
          </div>
        }
      >
        <ErrorBox error={failure} />
        <CaptureSelect
          onLoad={(r) => {
            if (r.binary) setFailure("Choose a JSON text capture.");
            else setBody(r.bodyText || "{}");
          }}
        />
        <textarea
          aria-label="Starting JSON event"
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="lab-form-grid">
          <Destination value={destination} onChange={setDestination} />
          <Field label="Start behavior">
            <select
              value={trigger ? "listen" : "now"}
              onChange={(e) => setTrigger(e.target.value === "listen")}
            >
              <option value="now">Run once when the script starts</option>
              <option value="listen">Wait for a webhook on localhost</option>
            </select>
          </Field>
          {trigger && (
            <Field label="Local trigger port">
              <input
                type="number"
                min="1024"
                max="65535"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </Field>
          )}
        </div>
        {trigger && (
          <Note>
            The script listens at http://localhost:{port}. POST a JSON event
            there to start a run. Each step uses that event and applies the
            changes accumulated so far.
          </Note>
        )}
      </Panel>
      <section className="workflow-builder" aria-label="Workflow steps">
        {steps.map((step, i) => (
          <Panel
            key={step.id}
            title={`${String(i + 1).padStart(2, "0")} · ${step.name || "Send event"}`}
            actions={
              <div className="lab-actions">
                <button
                  className="icon-button"
                  aria-label={`Move step ${i + 1} up`}
                  disabled={!i}
                  onClick={() =>
                    setSteps((s) => {
                      const a = [...s];
                      [a[i - 1], a[i]] = [a[i], a[i - 1]];
                      return a;
                    })
                  }
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Move step ${i + 1} down`}
                  disabled={i === steps.length - 1}
                  onClick={() =>
                    setSteps((s) => {
                      const a = [...s];
                      [a[i + 1], a[i]] = [a[i], a[i + 1]];
                      return a;
                    })
                  }
                >
                  <ArrowDown size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove step ${i + 1}`}
                  disabled={steps.length === 1}
                  onClick={() =>
                    setSteps((s) => s.filter((v) => v.id !== step.id))
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            }
          >
            <div className="lab-form-grid">
              <Field label="Step name">
                <input
                  value={step.name}
                  onChange={(e) => update(step.id, { name: e.target.value })}
                />
              </Field>
              <Field label="Wait before sending (ms)">
                <input
                  type="number"
                  min="0"
                  max="60000"
                  value={step.delayMs}
                  onChange={(e) =>
                    update(step.id, { delayMs: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Method">
                <select
                  value={step.method}
                  onChange={(e) => update(step.id, { method: e.target.value })}
                >
                  {[
                    "POST",
                    "PUT",
                    "PATCH",
                    "GET",
                    "DELETE",
                    "HEAD",
                    "OPTIONS",
                  ].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Field
                label="Field to change (optional)"
                help="Use a dot path, such as data.status."
              >
                <input
                  value={step.field}
                  onChange={(e) => update(step.id, { field: e.target.value })}
                  placeholder="data.status"
                />
              </Field>
              {step.field && (
                <Field
                  label="New value as JSON"
                  help={'Quote strings, for example "processed".'}
                >
                  <input
                    className="technical"
                    value={step.value}
                    onChange={(e) => update(step.id, { value: e.target.value })}
                  />
                </Field>
              )}
              <Field label="Destination override (optional)">
                <input
                  className="technical"
                  value={step.destination}
                  onChange={(e) =>
                    update(step.id, { destination: e.target.value })
                  }
                  placeholder="Use the default destination"
                />
              </Field>
            </div>
          </Panel>
        ))}
      </section>
      <button
        className="button"
        disabled={steps.length >= 20}
        onClick={() => setSteps((s) => [...s, newStep()])}
      >
        <Plus size={15} />
        Add step
      </button>
      <ErrorBox error={error} />
      <ScriptExport script={script} name="webhook-workflow.mjs" />
    </Page>
  );
}
