import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { analytics, createBrowserAnalytics } from '../src/lib/analytics.js';
import type { AnalyticsDiagnostic, BrowserAnalyticsConfig, BrowserAnalyticsDependencies } from '../src/lib/analytics.js';
import { createBrowserCapture } from '../src/lib/clonalytics/sdk/browser.js';
import type { CaptureClient, CaptureClock, CaptureOptions } from '../src/lib/clonalytics/sdk/browser.js';
import type { CaptureEvent } from '../src/lib/clonalytics/shared/contracts.js';

const config = { url: 'https://collector.example.test', key: 'pk_browser_fixture', dev: true };

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  listeners = 0;
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    this.listeners++;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    this.listeners--;
    super.removeEventListener(...args);
  }
  change(visibility: DocumentVisibilityState) {
    this.visibilityState = visibility;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function harness(overrides: BrowserAnalyticsDependencies = {}) {
  const doc = new FakeDocument();
  const diagnostics: AnalyticsDiagnostic[] = [];
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  const timeouts = new Map<number, () => void>();
  const requests: { url: string; init: RequestInit; events: CaptureEvent[] }[] = [];
  let next = 0;
  let hotDispose: (() => void) | undefined;
  let sdk: CaptureClient | undefined;
  const clock: CaptureClock = {
    now: () => 1_800_000_000_000,
    setTimeout(callback) {
      const id = ++next;
      timeouts.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) { timeouts.delete(handle as unknown as number); },
  };
  const fetcher: typeof fetch = async (url, init) => {
    const events = (JSON.parse(init!.body as string) as { events: CaptureEvent[] }).events;
    requests.push({ url: String(url), init: init!, events });
    return Response.json({
      accepted: events.length, duplicates: 0, suppressed: 0,
      receipts: events.map(({ eventId }) => ({ eventId, status: 'accepted', receiptId: 'receipt-fixture', receivedAt: null })),
    });
  };
  const dependencies: BrowserAnalyticsDependencies = {
    document: doc,
    setInterval(callback, delay) {
      const id = ++next;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(handle) { intervals.delete(handle as number); },
    hot: { dispose(callback) { hotDispose = callback; } },
    fetch: fetcher,
    createCapture(options) {
      sdk = createBrowserCapture({ ...options, clock, maxRetries: 0 });
      return sdk;
    },
    onDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
    ...overrides,
  };
  return {
    doc, diagnostics, intervals, timeouts, requests, dependencies,
    get sdk() { return sdk!; },
    hotDispose() { assert.ok(hotDispose); hotDispose(); },
    tick() { for (const timer of [...intervals.values()]) timer.callback(); },
  };
}

function stubClient(overrides: Partial<CaptureClient> = {}): CaptureClient {
  return {
    setConsent() {}, setEnabled() {}, identify() {}, reset() {},
    capture() { return { queued: true, eventId: 'fixture-event' }; },
    async flush() { return { accepted: 0, duplicates: 0, suppressed: 0, quarantined: 0, remaining: 0, cancelled: false }; },
    async shutdown() { return this.flush(); },
    getState() { return { consent: true, enabled: true, closed: false, queuedEvents: 0, queuedBytes: 0 }; },
    getDiagnostics() { return []; },
    ...overrides,
  };
}

test('missing either Vite setting is a silent no-op with no dependency access', async () => {
  let effects = 0;
  const dependencies = new Proxy({}, { get() { effects++; throw Error('must remain untouched'); } });
  for (const settings of [{}, { url: config.url }, { key: config.key },
    { url: '', key: config.key }, { url: config.url, key: '  ' },
    { url: undefined, key: 'sk_server_fixture', dev: true }]) {
    const instance = createBrowserAnalytics(settings, dependencies);
    assert.doesNotThrow(() => instance.track('page_opened'));
    instance.identify('webhook-lab:admin');
    instance.resetIdentity();
    await instance.flush();
    instance.dispose();
  }
  assert.equal(effects, 0);
  // Node has no Vite import.meta.env: importing the shared module is safe too.
  analytics.track('page_opened');
  analytics.identify('webhook-lab:admin');
  analytics.resetIdentity();
  await analytics.flush();
});

test('server/admin keys and malformed collector config cannot create an SDK, timer, or send', async () => {
  for (const settings of [
    ...['sk_server_fixture', 'admin_fixture', 'Bearer admin_fixture', 'pk_', ' pk_browser_fixture', 'pk_browser_fixture\n', 42].map((key) => ({ ...config, key })),
    ...['invalid', 'http://collector.example.test', 'https://user:password@collector.example.test', 'https://collector.example.test/api', 'https://collector.example.test/?token=fixture', 'https://collector.example.test/#fixture', 42].map((url) => ({ ...config, url })),
  ]) {
    let initialized = 0;
    const h = harness({ createCapture() { initialized++; throw Error('must not initialize'); } });
    const instance = createBrowserAnalytics(settings, h.dependencies);
    instance.track('page_opened');
    await instance.flush();
    assert.equal(initialized, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.doc.listeners, 0);
    assert.deepEqual(h.diagnostics, [{ code: 'invalid_config', count: 1 }]);
  }
  const throwingConfig = Object.defineProperty({}, 'url', { get() { throw Error('private-config'); } });
  assert.doesNotThrow(() => createBrowserAnalytics(throwingConfig));
  assert.doesNotThrow(() => createBrowserAnalytics(null as unknown as BrowserAnalyticsConfig));
});

test('real SDK sends only the browser collector contract with consent enabled', async () => {
  const h = harness();
  const instance = createBrowserAnalytics(config, h.dependencies);
  assert.equal(h.sdk.getState().consent, true);
  instance.identify('webhook-lab:admin');
  instance.track('inbox_opened', { tab: 'inbox', count: 2 });
  assert.equal(h.requests.length, 0);
  await instance.flush();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, 'https://collector.example.test/api/capture/browser');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
  assert.deepEqual(request.init.headers, { 'content-type': 'application/json', 'x-project-key': config.key });
  assert.deepEqual(Object.keys(request.init).sort(), ['body', 'credentials', 'headers', 'method', 'redirect', 'signal']);
  assert.equal(request.events[0].distinctId, 'webhook-lab:admin');
  assert.deepEqual(request.events[0].properties, { tab: 'inbox', count: 2 });
  instance.dispose();
  assert.equal(h.timeouts.size, 0);
});

test('identity boundaries preserve every queued identity snapshot and rotate anonymous IDs', async () => {
  const h = harness();
  const instance = createBrowserAnalytics(config, h.dependencies);
  instance.track('anonymous_before_login');
  instance.identify('webhook-lab:admin');
  assert.equal(h.sdk.getState().queuedEvents, 1);
  instance.track('old_account_queued');
  instance.identify('fixture:second-account');
  assert.equal(h.sdk.getState().queuedEvents, 2);
  instance.track('new_account_event');
  instance.identify('fixture:second-account');
  assert.equal(h.sdk.getState().queuedEvents, 3);
  instance.track('before_logout');
  instance.resetIdentity();
  assert.equal(h.sdk.getState().queuedEvents, 4);
  instance.track('after_logout');
  instance.resetIdentity();
  instance.track('after_anonymous_reset');
  await instance.flush();
  const events = h.requests.flatMap((request) => request.events);
  assert.deepEqual(events.map((event) => [event.name, event.distinctId]), [
    ['anonymous_before_login', null], ['old_account_queued', 'webhook-lab:admin'],
    ['new_account_event', 'fixture:second-account'], ['before_logout', 'fixture:second-account'],
    ['after_logout', null], ['after_anonymous_reset', null],
  ]);
  assert.equal(h.requests.length, 1);
  assert.equal(new Set(events.map(({ eventId }) => eventId)).size, events.length);
  assert.ok(events.every(({ anonymousId }) => typeof anonymousId === 'string'));
  assert.equal(events[2].anonymousId, events[3].anonymousId);
  assert.equal(new Set([events[0], events[1], events[2], events[4], events[5]].map(({ anonymousId }) => anonymousId)).size, 5);
  assert.equal(h.sdk.getState().queuedEvents, 0);
  assert.ok(!h.diagnostics.some(({ code }) => code === 'cleared'));
  instance.dispose();
});

test('reset preserves an in-flight old-user request and the next flush sends new identity snapshots', async () => {
  const signals: AbortSignal[] = [];
  const sent: CaptureEvent[][] = [];
  let completeFirst: ((response: Response) => void) | undefined;
  const receipt = (events: CaptureEvent[]) => Response.json({
    accepted: events.length, duplicates: 0, suppressed: 0,
    receipts: events.map(({ eventId }) => ({ eventId, status: 'accepted', receiptId: null, receivedAt: null })),
  });
  const h = harness({ fetch: async (_url, init) => {
    signals.push(init!.signal!);
    sent.push(JSON.parse(init!.body as string).events);
    if (sent.length === 1) return new Promise<Response>((resolve) => { completeFirst = resolve; });
    return receipt(sent.at(-1)!);
  } });
  const instance = createBrowserAnalytics(config, h.dependencies);
  instance.identify('fixture:first-account');
  instance.track('old_event');
  const pending = instance.flush();
  assert.equal(sent.length, 1);
  instance.resetIdentity();
  assert.equal(signals[0].aborted, false);
  instance.track('anonymous_event');
  instance.identify('fixture:next-account');
  instance.track('new_event');
  assert.ok(completeFirst);
  completeFirst(receipt(sent[0]));
  await pending;
  await instance.flush();
  assert.deepEqual(sent.map((events) => events.map((event) => [event.name, event.distinctId])), [
    [['old_event', 'fixture:first-account']], [['anonymous_event', null], ['new_event', 'fixture:next-account']],
  ]);
  assert.equal(signals[0].aborted, false);
  instance.dispose();
  assert.equal(h.timeouts.size, 0);
});

test('10-second and hidden-visibility flushes stop after HMR disposal and replacement', async () => {
  const h = harness();
  const instance = createBrowserAnalytics(config, h.dependencies);
  assert.deepEqual([...h.intervals.values()].map(({ delay }) => delay), [10_000]);
  assert.equal(h.doc.listeners, 1);
  instance.track('interval_event');
  h.tick();
  await instance.flush();
  instance.track('hidden_event');
  h.doc.change('visible');
  assert.equal(h.requests.length, 1);
  h.doc.change('hidden');
  await instance.flush();
  assert.deepEqual(h.requests.map(({ events }) => events[0].name), ['interval_event', 'hidden_event']);
  instance.track('discard_during_hmr');
  const staleTimer = [...h.intervals.values()][0].callback;
  h.hotDispose();
  h.hotDispose();
  instance.dispose();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.doc.listeners, 0);
  assert.equal(h.timeouts.size, 0);
  await setImmediate();
  assert.equal(h.sdk.getState().closed, true);
  staleTimer();
  instance.track('stale_module_event');
  instance.identify('stale-user');
  instance.resetIdentity();
  h.doc.change('hidden');
  await instance.flush();
  assert.equal(h.requests.length, 2);
  const replacement = createBrowserAnalytics(config, h.dependencies);
  assert.equal(h.intervals.size, 1);
  assert.equal(h.doc.listeners, 1);
  replacement.track('new_module_event');
  h.tick();
  await replacement.flush();
  assert.equal(h.requests.length, 3);
  replacement.dispose();
});

test('the module self-accepts HMR and invalidates importers to refresh their singleton bindings', () => {
  // Execute the actual module-level registration independently of Vite's env loader.
  // Factory lifecycle tests above cover disposal and replacement of timers/listeners.
  const source = readFileSync(new URL('../src/lib/analytics.ts', import.meta.url), 'utf8');
  const start = source.lastIndexOf('\nif (import.meta.hot) {');
  assert.notEqual(start, -1);
  const registration = source.slice(start).replaceAll('import.meta.hot', 'hot');
  let accepted: (() => void) | undefined;
  let invalidations = 0;
  const hot = {
    accept(callback: () => void) { accepted = callback; },
    invalidate() { invalidations++; },
  };
  runInNewContext(registration, { hot });
  assert.ok(accepted);
  assert.equal(invalidations, 0);
  accepted();
  assert.equal(invalidations, 1);
  assert.doesNotThrow(() => runInNewContext(registration, { hot: undefined }));
});

test('initialization and lifecycle setup failures are contained and clean up partial setup', async () => {
  for (const failure of ['constructor', 'consent', 'interval', 'listener', 'hot'] as const) {
    let stopped = 0;
    const h = harness();
    const sdk = stubClient({
      setConsent() { if (failure === 'consent') throw Error('private-init-error'); },
      async shutdown() { stopped++; return stubClient().flush(); },
    });
    h.dependencies.createCapture = () => { if (failure === 'constructor') throw Error('private-init-error'); return sdk; };
    if (failure === 'interval') h.dependencies.setInterval = () => { throw Error('private-timer-error'); };
    if (failure === 'listener') h.doc.addEventListener = () => { throw Error('private-doc-error'); };
    if (failure === 'hot') h.dependencies.hot = { dispose() { throw Error('private-hot-error'); } };
    const instance = createBrowserAnalytics(config, h.dependencies);
    assert.doesNotThrow(() => instance.track('private-event'));
    assert.doesNotThrow(() => instance.identify('private-subject'));
    assert.doesNotThrow(() => instance.resetIdentity());
    await instance.flush();
    instance.dispose();
    await setImmediate();
    assert.equal(h.intervals.size, 0);
    assert.equal(stopped, failure === 'constructor' ? 0 : 1);
    assert.ok(h.diagnostics.every((diagnostic) => diagnostic.code === 'initialization_failed'));
  }
});

test('capture, flush, identity, reset, and disposal throws/rejections never escape', async () => {
  for (const rejects of [false, true]) {
    const fail = () => { if (rejects) return Promise.reject(Error('private-sdk-error')); throw Error('private-sdk-error'); };
    for (const method of ['capture', 'flush', 'identify', 'reset', 'setConsent', 'setEnabled', 'shutdown'] as const) {
      const sdk = stubClient();
      Object.assign(sdk, { [method]: fail });
      const h = harness({ createCapture: () => sdk });
      const instance = createBrowserAnalytics(config, h.dependencies);
      assert.doesNotThrow(() => instance.track('private-event', { value: 'private-payload' }));
      assert.doesNotThrow(() => instance.identify('private-subject'));
      assert.doesNotThrow(() => instance.resetIdentity());
      await assert.doesNotReject(() => instance.flush());
      h.tick();
      h.doc.change('hidden');
      assert.doesNotThrow(() => instance.dispose());
      await setImmediate(); // node:test also fails on an unhandled rejection.
      assert.equal(h.intervals.size, 0);
      assert.equal(h.doc.listeners, 0);
      assert.ok(h.diagnostics.length > 0, `${method}, rejects=${rejects}`);
      assert.ok(!JSON.stringify(h.diagnostics).includes('private-'));
    }
  }
});

test('diagnostics retain only safe fixed codes/count/status; production and broken logging stay safe', async () => {
  const h = harness({ createCapture(options: CaptureOptions) {
    options.onDiagnostic!({ code: 'retry', count: 2, status: 503, message: 'private-payload', eventIds: ['private-id'] });
    options.onDiagnostic!({ code: 'private-secret' as 'retry', count: NaN, status: Infinity, message: config.key, eventIds: ['private-id'] });
    return stubClient();
  } });
  const instance = createBrowserAnalytics(config, h.dependencies);
  assert.deepEqual(h.diagnostics, [{ code: 'retry', count: 2, status: 503 }, { code: 'sdk_diagnostic', count: 0 }]);
  instance.dispose();
  const production = harness({ createCapture() { throw Error('private-initialization'); } });
  createBrowserAnalytics({ ...config, dev: false }, production.dependencies);
  createBrowserAnalytics({ ...config, key: 'sk_fixture', dev: false }, production.dependencies);
  assert.deepEqual(production.diagnostics, []);
  const broken = harness({ onDiagnostic() { throw Error('private-logger-error'); }, createCapture() { throw Error('private-sdk-error'); } });
  assert.doesNotThrow(() => createBrowserAnalytics(config, broken.dependencies));
  const rejected = harness({ onDiagnostic: async () => { throw Error('private-async-logger-error'); }, createCapture() { throw Error('private-sdk-error'); } });
  assert.doesNotThrow(() => createBrowserAnalytics(config, rejected.dependencies));
  await setImmediate();
});

test('real SDK invalid events and transport failures produce only bounded diagnostics', async () => {
  const h = harness({ fetch: async () => { throw Error('private-transport-error'); } });
  const instance = createBrowserAnalytics(config, h.dependencies);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => instance.track('invalid', cyclic as Record<string, never>));
  assert.doesNotThrow(() => instance.track(null as unknown as string));
  instance.track('valid_event');
  await instance.flush();
  assert.equal(h.sdk.getState().queuedEvents, 0);
  assert.deepEqual(h.diagnostics.map(({ code }) => code), ['invalid_event', 'invalid_event', 'retry_exhausted']);
  assert.ok(h.diagnostics.every((diagnostic) => Object.keys(diagnostic).every((key) => ['code', 'count', 'status'].includes(key))));
  instance.dispose();
});

test('track accepts flat primitives and rejects nested or nonfinite property values', async () => {
  const h = harness();
  const instance = createBrowserAnalytics(config, h.dependencies);
  const valid = { label: 'inbox', count: 3, enabled: false, empty: null };
  instance.track('flat_properties', valid);
  for (const invalid of [{ nested: {} }, { list: ['inbox'] }, { count: Infinity },
    { count: NaN }, { missing: undefined }, ['array'], null]) {
    instance.track('invalid_properties', invalid as never);
  }
  await instance.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].events.length, 1);
  assert.deepEqual(h.requests[0].events[0].properties, valid);
  assert.equal(h.diagnostics.filter(({ code }) => code === 'invalid_event').length, 7);
  instance.dispose();
});
