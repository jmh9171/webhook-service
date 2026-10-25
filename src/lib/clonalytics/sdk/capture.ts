import { FUNNEL_STEPS, LIMITS } from "../shared/contracts.js";
import type {
  CaptureEvent,
  CaptureResult,
  JsonValue,
  Source,
} from "../shared/contracts.js";

export interface CaptureClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface CaptureDiagnostic {
  code:
    | "inactive"
    | "invalid_event"
    | "queue_full"
    | "expired"
    | "cleared"
    | "retry"
    | "retry_exhausted"
    | "quarantined"
    | "invalid_response";
  message: string;
  count: number;
  /** Bounded metadata only; payloads, credentials and server error text are never retained. */
  eventIds: string[];
  status?: number;
}

export interface CaptureOptions {
  /**
   * Collector origin with no path or /api suffix: a loopback HTTP(S) origin for
   * local work (http://127.0.0.1:3001) or an HTTPS origin for a hosted instance.
   */
  baseUrl: string;
  projectKey: string;
  fetch?: typeof globalThis.fetch;
  clock?: CaptureClock;
  random?: () => number;
  /** Defaults to 3 retries, capped at 5. Exhaustion discards payloads with diagnostics. */
  maxRetries?: number;
  /** Defaults to 10 seconds; capped at 30 seconds. */
  requestTimeoutMs?: number;
  onDiagnostic?: (diagnostic: CaptureDiagnostic) => void;
}

/** Per-call overrides. Server producers should pass `distinctId` on every call instead of `identify()`. */
export interface CaptureCallOptions {
  /** Pseudonymous subject ID for this event only (never an email). `null` sends it anonymously. */
  distinctId?: string | null;
  /** Stable ID derived from the business action, so a retried send is de-duplicated. */
  eventId?: string;
}

export type CaptureOutcome =
  | { queued: true; eventId: string }
  | { queued: false; reason: CaptureDiagnostic["code"] };

export interface FlushResult {
  accepted: number;
  duplicates: number;
  suppressed: number;
  quarantined: number;
  remaining: number;
  cancelled: boolean;
}

export interface CaptureClient {
  setConsent(granted: boolean): void;
  /** Disabling clears queued payloads and aborts this helper's current work. */
  setEnabled(enabled: boolean): void;
  identify(distinctId: string): void;
  reset(): void;
  capture(name: string, properties?: Record<string, JsonValue>, options?: CaptureCallOptions): CaptureOutcome;
  /** One flight at a time. Drains only the events present when this flush begins. */
  flush(): Promise<FlushResult>;
  /** Stops captures, flushes once by default, then clears memory. */
  shutdown(options?: { flush?: boolean }): Promise<FlushResult>;
  getState(): {
    consent: boolean;
    enabled: boolean;
    closed: boolean;
    queuedEvents: number;
    queuedBytes: number;
  };
  getDiagnostics(): CaptureDiagnostic[];
}

interface Entry {
  eventId: string;
  json: string;
  bytes: number;
  /** JSON values in properties, as counted by the collector (LIMITS.eventValues). */
  values: number;
  enqueuedAt: number;
  failures: number;
}
const encoder = new TextEncoder();
const defaultClock: CaptureClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Implementation shared by the browser and server entrypoints. No storage or Node imports. */
export function createCaptureClient(
  options: CaptureOptions,
  source: Source,
): CaptureClient {
  const origin = new URL(options.baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (
    !(origin.protocol === "https:" || (loopback && origin.protocol === "http:")) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      "Capture helper requires an HTTPS (or loopback HTTP) origin without a path or credentials.",
    );
  }
  if (!options.projectKey.trim())
    throw new Error("An explicitly provided project key is required.");
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5)
    throw new Error("maxRetries must be 0–5.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("requestTimeoutMs must be 1–30000.");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? defaultClock;
  const random = options.random ?? Math.random;
  const queue = new Map<string, Entry>();
  const diagnostics: CaptureDiagnostic[] = [];
  let queuedBytes = 0;
  let consent = false;
  let enabled = true;
  let closing = false;
  let closed = false;
  let distinctId: string | null = null;
  let anonymousId: string | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<FlushResult> | undefined;
  let operation: AbortController | undefined;

  function diagnose(
    code: CaptureDiagnostic["code"],
    message: string,
    entries: Entry[] = [],
    status?: number,
  ) {
    const diagnostic: CaptureDiagnostic = {
      code,
      message,
      count: entries.length,
      eventIds: entries.slice(0, 100).map((e) => e.eventId),
    };
    if (status !== undefined) diagnostic.status = status;
    diagnostics.push(diagnostic);
    if (diagnostics.length > 100) diagnostics.shift();
    const copy = { ...diagnostic, eventIds: [...diagnostic.eventIds] };
    try {
      if (options.onDiagnostic) options.onDiagnostic(copy);
      else console.warn("[capture]", copy);
    } catch {
      /* A diagnostic consumer cannot break capture or retries. */
    }
  }

  function remove(entries: Entry[]) {
    for (const entry of entries) {
      if (queue.delete(entry.eventId)) queuedBytes -= entry.bytes;
    }
  }

  function scheduleExpiry() {
    if (expiryTimer !== undefined) clock.clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const oldest = queue.values().next().value as Entry | undefined;
    if (oldest) {
      expiryTimer = clock.setTimeout(
        expire,
        Math.max(0, oldest.enqueuedAt + LIMITS.queueTtlMs - clock.now()),
      );
      // Node producers should not stay alive just because unused events remain queued.
      if (typeof expiryTimer === "object") expiryTimer.unref?.();
    }
  }

  function expire() {
    const expired = [...queue.values()].filter(
      (entry) => clock.now() - entry.enqueuedAt >= LIMITS.queueTtlMs,
    );
    remove(expired);
    scheduleExpiry();
    if (expired.length)
      diagnose("expired", "Queued events expired and were discarded.", expired);
  }

  function clear() {
    const discarded = [...queue.values()];
    queue.clear();
    queuedBytes = 0;
    scheduleExpiry();
    distinctId = anonymousId = null;
    operation?.abort();
    if (discarded.length)
      diagnose(
        "cleared",
        "Queued events cleared; an already sent request cannot be retracted.",
        discarded,
      );
  }

  function quarantine(
    entries: Entry[],
    result: FlushResult,
    code: CaptureDiagnostic["code"],
    status?: number,
  ) {
    const present = entries.filter((entry) => queue.has(entry.eventId));
    remove(present);
    result.quarantined += present.length;
    scheduleExpiry();
    diagnose(
      code,
      "Payloads discarded from memory; inspect the diagnostic before capturing again.",
      present,
      status,
    );
  }

  async function request(
    entries: Entry[],
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = clock.setTimeout(abort, timeoutMs);
    let rejectAbort: (() => void) | undefined;
    try {
      // The race also bounds injected fetchers that ignore AbortSignal.
      return await Promise.race([
        new Promise<never>((_, reject) => {
          rejectAbort = () =>
            reject(new Error("Capture request aborted or timed out."));
          controller.signal.addEventListener("abort", rejectAbort, {
            once: true,
          });
          if (controller.signal.aborted) rejectAbort();
        }),
        (async () => {
          if (controller.signal.aborted)
            throw new Error("Capture request cancelled.");
          const response = await fetcher(
            `${origin.origin}/api/capture/${source}`,
            {
              method: "POST",
              credentials: "omit",
              redirect: "error",
              headers: {
                "content-type": "application/json",
                "x-project-key": options.projectKey,
              },
              body: `{"events":[${entries.map((entry) => entry.json).join(",")}]}`,
              signal: controller.signal,
            },
          );
          let body: unknown;
          try {
            body = await response.json();
          } catch (error) {
            if (error instanceof SyntaxError) body = undefined;
            else throw error;
          }
          return {
            status: response.status,
            body,
            retryAfter: response.headers.get("retry-after"),
          };
        })(),
      ]);
    } finally {
      clock.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (rejectAbort)
        controller.signal.removeEventListener("abort", rejectAbort);
    }
  }

  function wait(delay: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clock.clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = clock.setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }

  async function drain(result: FlushResult, signal: AbortSignal) {
    const target = new Set(queue.keys());
    while (!signal.aborted) {
      expire();
      const batch: Entry[] = [];
      let bytes = encoder.encode('{"events":[]}').byteLength;
      let values = 0;
      for (const entry of queue.values()) {
        if (!target.has(entry.eventId)) continue;
        const added = entry.bytes + (batch.length ? 1 : 0);
        if (
          batch.length === LIMITS.batchEvents ||
          bytes + added > LIMITS.batchBytes ||
          values + entry.values > LIMITS.batchValues
        )
          break;
        batch.push(entry);
        bytes += added;
        values += entry.values;
      }
      if (!batch.length) break;
      let response: Awaited<ReturnType<typeof request>> | undefined;
      try {
        response = await request(batch, signal);
      } catch {
        /* Only transport failures are retried. */
      }
      if (signal.aborted) break;
      if (
        !response ||
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599)
      ) {
        const pending = batch.filter((entry) => queue.has(entry.eventId));
        pending.forEach((entry) => entry.failures++);
        const exhausted = pending.filter(
          (entry) => entry.failures > maxRetries,
        );
        if (exhausted.length)
          quarantine(exhausted, result, "retry_exhausted", response?.status);
        const retrying = pending.filter((entry) => queue.has(entry.eventId));
        if (!retrying.length) continue;
        const attempt = Math.max(...retrying.map((entry) => entry.failures));
        const sample = random();
        const jitter = Number.isFinite(sample)
          ? Math.max(0, Math.min(1, sample))
          : 0.5;
        let delay =
          Math.min(10_000, 500 * 2 ** (attempt - 1)) * (0.5 + 0.5 * jitter);
        const retryAfter = response?.retryAfter;
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const parsed = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - clock.now();
          if (Number.isFinite(parsed))
            delay = Math.max(delay, Math.min(10_000, Math.max(0, parsed)));
        }
        diagnose(
          "retry",
          "Retrying a transient failure with the original event IDs.",
          retrying,
          response?.status,
        );
        await wait(delay, signal);
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        const receipts = validReceipts(response.body, batch);
        if (!receipts)
          quarantine(batch, result, "invalid_response", response.status);
        else {
          result.accepted += receipts.accepted;
          result.duplicates += receipts.duplicates;
          result.suppressed += receipts.suppressed;
          remove(batch);
          scheduleExpiry();
        }
      } else {
        const indexes = rejectedIndexes(
          response.body,
          response.status,
          batch.length,
        );
        quarantine(
          indexes ? batch.filter((_, index) => indexes.has(index)) : batch,
          result,
          "quarantined",
          response.status,
        );
        // Atomic rejection: surviving entries remain queued unchanged for a smaller batch.
      }
    }
    result.cancelled = signal.aborted;
    result.remaining = queue.size;
    return result;
  }

  function flush(): Promise<FlushResult> {
    if (flight) return flight;
    expire();
    const result: FlushResult = {
      accepted: 0,
      duplicates: 0,
      suppressed: 0,
      quarantined: 0,
      remaining: queue.size,
      cancelled: false,
    };
    if (!consent || !enabled || closed || !queue.size)
      return Promise.resolve(result);
    operation = new AbortController();
    flight = drain(result, operation.signal).finally(() => {
      flight = undefined;
      operation = undefined;
    });
    return flight;
  }

  return {
    setConsent(granted) {
      if (closed || (closing && granted)) return;
      consent = granted;
      if (!granted) clear();
    },
    setEnabled(value) {
      if (closed || (closing && value)) return;
      enabled = value;
      if (!value) clear();
    },
    identify(id) {
      if (!consent || !enabled || closed || closing) return;
      if (!id.trim()) throw new Error("distinctId must be nonempty.");
      distinctId = id;
    },
    reset() {
      distinctId = anonymousId = null;
    },
    capture(name, properties = {}, call = {}) {
      expire();
      if (!consent || !enabled || closed || closing) {
        diagnose(
          "inactive",
          "Capture skipped because consent or local capture is inactive.",
        );
        return { queued: false, reason: "inactive" };
      }
      let entry: Entry;
      try {
        if (
          !name.trim() ||
          (source === "browser" &&
            (FUNNEL_STEPS as readonly string[]).includes(name))
        )
          throw new Error("Invalid event name.");
        if (!object(properties) || !isJson(properties))
          throw new Error("Properties must be JSON.");
        const perCall = call.distinctId !== undefined;
        if (typeof call.distinctId === "string" && !call.distinctId.trim())
          throw new Error("distinctId must be nonempty.");
        if (call.eventId !== undefined && (!call.eventId.trim() || call.eventId.length > 200))
          throw new Error("eventId must be 1–200 characters.");
        if (call.eventId !== undefined && queue.has(call.eventId))
          throw new Error("eventId is already queued.");
        // A per-call subject never shares the client's anonymous ID across users.
        if (!perCall) anonymousId ??= globalThis.crypto.randomUUID();
        const now = clock.now();
        const event: CaptureEvent = {
          eventId: call.eventId ?? globalThis.crypto.randomUUID(),
          name,
          occurredAt: new Date(now).toISOString(),
          distinctId: perCall ? (call.distinctId ?? null) : distinctId,
          anonymousId: perCall ? null : anonymousId,
          properties,
          schemaVersion: 1,
        };
        const json = JSON.stringify(event);
        const bytes = encoder.encode(json).byteLength;
        if (bytes > LIMITS.eventBytes)
          throw new Error("Event exceeds the byte limit.");
        // Count the serialized snapshot (what the collector receives), so sparse arrays,
        // toJSON and dropped keys are counted exactly as the server will.
        const sent = (JSON.parse(json) as CaptureEvent).properties ?? {};
        const values = Object.values(sent).reduce<number>((sum, value) => sum + countValues(value), 0);
        if (values > LIMITS.eventValues)
          throw new Error("Event properties exceed the value limit.");
        entry = {
          eventId: event.eventId,
          json,
          bytes,
          values,
          enqueuedAt: now,
          failures: 0,
        };
      } catch {
        diagnose(
          "invalid_event",
          "Capture skipped: invalid JSON, reserved browser event, or event exceeds 16 KiB or 500 property values.",
        );
        return { queued: false, reason: "invalid_event" };
      }
      if (
        queue.size >= LIMITS.queueEvents ||
        queuedBytes + entry.bytes > LIMITS.queueBytes
      ) {
        diagnose(
          "queue_full",
          "Capture skipped because the bounded memory queue is full.",
        );
        return { queued: false, reason: "queue_full" };
      }
      queue.set(entry.eventId, entry);
      queuedBytes += entry.bytes;
      scheduleExpiry();
      return { queued: true, eventId: entry.eventId };
    },
    flush,
    async shutdown(settings = {}) {
      closing = true;
      if (settings.flush === false) clear();
      const result = await flush();
      closed = true;
      consent = false;
      clear();
      return { ...result, remaining: 0 };
    },
    getState() {
      expire();
      return {
        consent,
        enabled,
        closed,
        queuedEvents: queue.size,
        queuedBytes,
      };
    },
    getDiagnostics() {
      return diagnostics.map((item) => ({
        ...item,
        eventIds: [...item.eventIds],
      }));
    },
  };
}

/** Counts JSON values the way the collector does: every object, array and primitive. */
function countValues(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((sum, item) => sum + countValues(item), 0);
  if (value !== null && typeof value === "object")
    return 1 + Object.values(value).reduce<number>((sum, item) => sum + countValues(item), 0);
  return 1;
}

function isJson(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const valid = Object.values(value).every((item) =>
    isJson(item, seen, depth + 1),
  );
  seen.delete(value);
  return valid;
}

function rejectedIndexes(
  body: unknown,
  status: number,
  length: number,
): Set<number> | undefined {
  if (![400, 409, 422].includes(status) || !object(body) || !object(body.error))
    return;
  const details = body.error.details;
  // The local API uses details: [{index, ...}]; tolerate an explicit errors wrapper too.
  const errors = Array.isArray(details)
    ? details
    : object(details)
      ? details.errors
      : undefined;
  if (!Array.isArray(errors) || !errors.length) return;
  const indexes = new Set<number>();
  for (const error of errors) {
    if (
      !object(error) ||
      !Number.isInteger(error.index) ||
      (error.index as number) < 0 ||
      (error.index as number) >= length
    )
      return;
    indexes.add(error.index as number);
  }
  return indexes;
}

function validReceipts(
  body: unknown,
  entries: Entry[],
): CaptureResult | undefined {
  if (
    !object(body) ||
    !Array.isArray(body.receipts) ||
    body.receipts.length !== entries.length
  )
    return;
  const ids = new Set(entries.map((entry) => entry.eventId));
  const counts = { accepted: 0, duplicates: 0, suppressed: 0 };
  for (const receipt of body.receipts) {
    if (
      !object(receipt) ||
      typeof receipt.eventId !== "string" ||
      !ids.delete(receipt.eventId) ||
      !["accepted", "duplicate", "suppressed"].includes(
        String(receipt.status),
      ) ||
      !(receipt.receiptId === null || typeof receipt.receiptId === "string") ||
      !(receipt.receivedAt === null || typeof receipt.receivedAt === "string")
    )
      return;
    if (receipt.status === "accepted") counts.accepted++;
    else if (receipt.status === "duplicate") counts.duplicates++;
    else counts.suppressed++;
  }
  if (
    body.accepted !== counts.accepted ||
    body.duplicates !== counts.duplicates ||
    body.suppressed !== counts.suppressed
  )
    return;
  return body as unknown as CaptureResult;
}
