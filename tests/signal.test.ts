import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSignalAnalytics } from "../server/signal.js";
import type { SignalAnalytics } from "../server/signal.js";
import type { CaptureEvent } from "../server/signal-sdk/shared/contracts.js";

const call = { distinctId: "workspace:pseudonymous-123", eventId: "action:stable-123" };
const properties = { method: "POST", bytes: 42, authenticated: true };

function events(init?: RequestInit): CaptureEvent[] {
  return JSON.parse(String(init?.body)).events;
}

function accepted(init?: RequestInit, duplicate = false): Response {
  const batch = events(init);
  return Response.json({
    accepted: duplicate ? 0 : batch.length,
    duplicates: duplicate ? batch.length : 0,
    suppressed: 0,
    receipts: batch.map(({ eventId }) => ({
      eventId,
      status: duplicate ? "duplicate" : "accepted",
      receiptId: "receipt-id",
      receivedAt: new Date().toISOString(),
    })),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Condition did not become true");
}

test("absent and blank keys make no requests or timers", async (t) => {
  const fetcher = t.mock.fn<typeof fetch>(async () => {
    throw new Error("must not fetch");
  });
  const timeout = t.mock.method(globalThis, "setTimeout");
  const interval = t.mock.method(globalThis, "setInterval");
  for (const apiKey of [undefined, "", " \n\t"]) {
    const analytics = createSignalAnalytics({ apiKey, fetch: fetcher });
    analytics.capture("webhook_received", properties, call);
    await analytics.close();
    await analytics.close();
  }
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal(timeout.mock.callCount(), 0);
  assert.equal(interval.mock.callCount(), 0);
});

test("real SDK uses the fixed server contract and key header; close flushes once", async (t) => {
  const requests: { url: unknown; init?: RequestInit }[] = [];
  const analytics = createSignalAnalytics({
    apiKey: "test-server-key",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return accepted(init);
    },
  });
  t.after(() => analytics.close());
  analytics.capture("webhook_received", properties, call);
  assert.equal(requests.length, 0);
  const closing = analytics.close();
  assert.equal(analytics.close(), closing);
  await closing;
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, "https://clonalytics-staging-kpjmx.sevalla.app/api/capture/server");
  assert.equal(init?.method, "POST");
  assert.equal(init?.credentials, "omit");
  assert.equal(init?.redirect, "error");
  assert.deepEqual(init?.headers, {
    "content-type": "application/json",
    "x-project-key": "test-server-key",
  });
  const [event] = events(init);
  assert.deepEqual(event, {
    ...call,
    name: "webhook_received",
    properties,
    occurredAt: event.occurredAt,
    anonymousId: null,
    schemaVersion: 1,
  });
  assert.ok(Number.isFinite(Date.parse(event.occurredAt)));
  assert.ok(init?.signal instanceof AbortSignal);
  analytics.capture("after_close", {}, { ...call, eventId: "after-close" });
  await analytics.close();
  assert.equal(requests.length, 1);
});

test("queued event IDs deduplicate and each call keeps its pseudonymous identity", async (t) => {
  t.mock.method(console, "warn", () => {});
  const sent: CaptureEvent[] = [];
  const analytics = createSignalAnalytics({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      sent.push(...events(init));
      return accepted(init, true);
    },
  });
  t.after(() => analytics.close());
  analytics.capture("webhook_received", properties, call);
  analytics.capture("webhook_received", properties, call);
  analytics.capture("webhook_received", {}, {
    distinctId: "workspace:pseudonymous-456",
    eventId: "action:stable-456",
  });
  await analytics.close();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(({ distinctId, anonymousId, eventId }) => ({ distinctId, anonymousId, eventId })), [
    { ...call, anonymousId: null },
    { distinctId: "workspace:pseudonymous-456", eventId: "action:stable-456", anonymousId: null },
  ]);
});

test("transient retries preserve the exact event and stop after two retries", async (t) => {
  const diagnostics = t.mock.method(console, "warn", () => {});
  const bodies: string[] = [];
  const analytics = createSignalAnalytics({
    apiKey: "private-test-key",
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return Response.json({ error: "private-server-body" }, { status: 503 });
    },
  });
  t.after(() => analytics.close());
  analytics.capture("private-event-name", { value: "private-property-value" }, call);
  // Keep the test process alive while SDK timers are deliberately unref'ed.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await analytics.close();
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  const logged = diagnostics.mock.calls.map(({ arguments: args }) => JSON.stringify(args)).join("\n");
  for (const secret of ["private-test-key", "private-server-body", "private-event-name", "private-property-value", call.distinctId, call.eventId]) {
    assert.ok(!logged.includes(secret), secret);
  }
  assert.match(logged, /retry_exhausted/);
  assert.match(logged, /503/);
  for (const { arguments: args } of diagnostics.mock.calls) {
    assert.equal(args[0], "[signal]");
    assert.ok(Object.keys(args[1]).every((key) => ["code", "count", "status"].includes(key)));
  }
});

test("a transport retry is accepted with the original event ID", async (t) => {
  t.mock.method(console, "warn", () => {});
  const bodies: string[] = [];
  const analytics = createSignalAnalytics({
    apiKey: "test-key",
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new Error("sensitive transport details");
      return accepted(init, true);
    },
  });
  t.after(() => analytics.close());
  analytics.capture("webhook_received", properties, call);
  const keepAlive = setInterval(() => {}, 100);
  try {
    await analytics.close();
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("capture errors, malformed collector responses, and throwing loggers fail open", async (t) => {
  t.mock.method(console, "warn", () => { throw new Error("logger failed"); });
  let requests = 0;
  const analytics = createSignalAnalytics({
    apiKey: "test-key",
    fetch: async () => {
      requests++;
      return Response.json({ unexpected: "sensitive body" });
    },
  });
  t.after(() => analytics.close());
  assert.doesNotThrow(() => analytics.capture("invalid", { value: Number.NaN }, call));
  const brokenCall = { get distinctId(): string { throw new Error("sensitive caller data"); }, eventId: "broken" };
  assert.doesNotThrow(() => analytics.capture("broken", {}, brokenCall));
  analytics.capture("valid", {}, call);
  await assert.doesNotReject(analytics.close());
  assert.equal(requests, 1);
});

test("initialization failures are contained with a sanitized diagnostic", async (t) => {
  const diagnostics = t.mock.method(console, "warn", () => {});
  let analytics: SignalAnalytics | undefined;
  assert.doesNotThrow(() => {
    analytics = createSignalAnalytics({
      apiKey: "test-key",
      get fetch(): typeof fetch { throw new Error("sensitive init failure"); },
    });
  });
  analytics!.capture("ignored", {}, call);
  await analytics!.close();
  assert.deepEqual(diagnostics.mock.calls.map(({ arguments: args }) => args), [
    ["[signal]", { code: "init_failed", count: 0 }],
  ]);
});

test("the default flush cadence is ten seconds and every analytics timer is unref'ed", async (t) => {
  const interval = t.mock.method(globalThis, "setInterval");
  const timeout = t.mock.method(globalThis, "setTimeout");
  const analytics = createSignalAnalytics({
    apiKey: "test-key",
    fetch: async (_url, init) => accepted(init),
  });
  t.after(() => analytics.close());
  analytics.capture("webhook_received", properties, call);
  await analytics.close();
  assert.equal(interval.mock.callCount(), 1);
  assert.equal(interval.mock.calls[0].arguments[1], 10_000);
  assert.equal(interval.mock.calls[0].result!.hasRef(), false);
  assert.ok(timeout.mock.callCount() >= 3); // Queue expiry, shutdown, request.
  for (const { result } of timeout.mock.calls) assert.equal(result!.hasRef(), false);
});

test("unexpected SDK flush and shutdown exceptions never escape or log their errors", async (t) => {
  const diagnostics = t.mock.method(console, "warn", () => {});
  let requests = 0;
  const analytics = createSignalAnalytics({
    apiKey: "test-key",
    flushIntervalMs: 5,
    fetch: async (_url, init) => { requests++; return accepted(init); },
  });
  t.after(() => analytics.close());
  analytics.capture("webhook_received", properties, call);
  // Expiry checks inside SDK.flush() consult its clock before making a request.
  t.mock.method(Date, "now", () => { throw new Error("private clock failure"); });
  await waitFor(() => diagnostics.mock.calls.some(({ arguments: args }) => args[1].code === "flush_failed"));
  await assert.doesNotReject(analytics.close());
  assert.equal(requests, 0);
  const logged = JSON.stringify(diagnostics.mock.calls.map(({ arguments: args }) => args));
  assert.match(logged, /close_failed/);
  assert.ok(!logged.includes("private clock failure"));
});

test("periodic flush is serial and close drains captures queued during a flight", async (t) => {
  let release!: (response: Response) => void;
  const requests: RequestInit[] = [];
  const analytics = createSignalAnalytics({
    apiKey: "test-key",
    flushIntervalMs: 5,
    fetch: async (_url, init) => {
      requests.push(init!);
      if (requests.length === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return accepted(init);
    },
  });
  t.after(() => analytics.close());
  analytics.capture("first", {}, call);
  await waitFor(() => requests.length === 1);
  analytics.capture("second", {}, { ...call, eventId: "second-action" });
  await delay(30);
  assert.equal(requests.length, 1);
  const closing = analytics.close();
  release(accepted(requests[0]));
  await closing;
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((init) => events(init).map(({ eventId }) => eventId)), [
    [call.eventId], ["second-action"],
  ]);
  await delay(20);
  assert.equal(requests.length, 2);
});

test("close aborts an existing flight at its deadline even if fetch ignores abort", async (t) => {
  t.mock.method(console, "warn", () => {});
  const requests: RequestInit[] = [];
  const analytics = createSignalAnalytics({
    apiKey: "test-key",
    flushIntervalMs: 5,
    shutdownTimeoutMs: 35,
    fetch: async (_url, init) => {
      requests.push(init!);
      return new Promise<Response>(() => {});
    },
  });
  t.after(() => analytics.close());
  analytics.capture("webhook_received", {}, call);
  await waitFor(() => requests.length === 1);
  const started = Date.now();
  await Promise.all([analytics.close(), delay(75)]);
  assert.ok(Date.now() - started < 500);
  assert.equal(requests[0].signal?.aborted, true);
  await delay(30);
  assert.equal(requests.length, 1);
});

test("close also bounds its own final flush and cancels retry waits", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const mode of ["hanging", "retry"] as const) {
    let requests = 0;
    let signal: AbortSignal | null | undefined;
    const analytics = createSignalAnalytics({
      apiKey: "test-key",
      shutdownTimeoutMs: 20,
      fetch: async (_url, init) => {
        requests++;
        signal = init?.signal;
        return mode === "hanging"
          ? new Promise<Response>(() => {})
          : Response.json({}, { status: 429 });
      },
    });
    t.after(() => analytics.close());
    analytics.capture("webhook_received", {}, call);
    await Promise.all([analytics.close(), delay(50)]);
    if (mode === "hanging") assert.equal(signal?.aborted, true);
    assert.equal(requests, 1);
    await delay(30);
    assert.equal(requests, 1);
  }
});
