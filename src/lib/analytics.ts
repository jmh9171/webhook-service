import { createBrowserCapture } from './clonalytics/sdk/browser.js';
import type { CaptureClient, CaptureOptions } from './clonalytics/sdk/browser.js';

export type AnalyticsProperties = Record<string, string | number | boolean | null>;

export interface BrowserAnalytics {
  track(name: string, properties?: AnalyticsProperties): void;
  identify(userId: string): void;
  resetIdentity(): void;
  flush(): Promise<void>;
  dispose(): void;
}

export interface BrowserAnalyticsConfig {
  url?: unknown;
  key?: unknown;
  dev?: boolean;
}

export interface AnalyticsDiagnostic {
  code: string;
  count: number;
  status?: number;
}

export interface BrowserAnalyticsDependencies {
  createCapture?: (options: CaptureOptions) => CaptureClient;
  fetch?: typeof globalThis.fetch;
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  hot?: { dispose(callback: () => void): void };
  onDiagnostic?: (diagnostic: AnalyticsDiagnostic) => void;
}

const noop: BrowserAnalytics = Object.freeze({
  track() {}, identify() {}, resetIdentity() {},
  async flush() {}, dispose() {},
});

const sdkCodes = new Set([
  'inactive', 'invalid_event', 'queue_full', 'expired', 'cleared', 'retry',
  'retry_exhausted', 'quarantined', 'invalid_response',
]);

/** Internal-policy consent is enabled only for an explicitly configured browser key. */
export function createBrowserAnalytics(
  config: BrowserAnalyticsConfig = {},
  dependencies: BrowserAnalyticsDependencies = {},
): BrowserAnalytics {
  let dev = false;
  function diagnose(code: string, count = 1, status?: number) {
    if (!dev) return;
    try {
      const diagnostic: AnalyticsDiagnostic = { code, count };
      if (status !== undefined) diagnostic.status = status;
      const result = dependencies.onDiagnostic
        ? dependencies.onDiagnostic(diagnostic)
        : console.warn('[analytics]', diagnostic);
      void Promise.resolve(result).catch(() => {});
    } catch { /* Diagnostics must never affect the app. */ }
  }

  let url: string;
  let key: string;
  try {
    const rawUrl = config?.url;
    const rawKey = config?.key;
    // Missing either setting is completely silent, even in development.
    if (rawUrl == null || rawKey == null || rawUrl === '' || rawKey === '' ||
        (typeof rawUrl === 'string' && !rawUrl.trim()) ||
        (typeof rawKey === 'string' && !rawKey.trim())) return noop;
    dev = config.dev === true;
    if (typeof rawUrl !== 'string' || typeof rawKey !== 'string' ||
        !/^pk_[A-Za-z0-9_-]+$/.test(rawKey)) throw new Error();
    const origin = new URL(rawUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (!(origin.protocol === 'https:' || (loopback && origin.protocol === 'http:')) ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error();
    }
    url = origin.origin;
    key = rawKey;
  } catch {
    diagnose('invalid_config');
    return noop;
  }

  let client: CaptureClient | undefined;
  let subject: string | null = null;
  let disposed = false;
  let interval: unknown;
  let intervalInstalled = false;
  let doc: BrowserAnalyticsDependencies['document'];
  let listenerInstalled = false;
  let clearTimer: ((handle: unknown) => void) | undefined;

  // Observe unexpected promises even from SDK methods whose contract is synchronous.
  function attempt(code: string, operation: () => unknown, failClosed = false): boolean {
    try {
      const result = operation();
      void Promise.resolve(result).catch(() => {
        diagnose(code);
        if (failClosed) dispose();
      });
      return true;
    } catch {
      diagnose(code);
      if (failClosed) dispose();
      return false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const previous = client;
    client = undefined;
    subject = null;
    if (intervalInstalled) attempt('dispose_failed', () => clearTimer?.(interval));
    if (listenerInstalled) attempt('dispose_failed', () => doc?.removeEventListener('visibilitychange', onVisibility));
    if (previous) {
      attempt('dispose_failed', () => previous.setEnabled(false));
      attempt('dispose_failed', () => previous.shutdown({ flush: false }));
    }
  }

  async function flush(): Promise<void> {
    try { await client?.flush(); }
    catch { diagnose('flush_failed'); }
  }

  function onVisibility() {
    attempt('lifecycle_failed', () => {
      if (doc?.visibilityState === 'hidden') return flush();
    });
  }

  function resetClientIdentity(): boolean {
    const current = client;
    if (!current) return false;
    // Queued payloads already snapshot their identity; preserve them across sessions.
    if (!attempt('reset_failed', () => current.reset(), true)) return false;
    subject = null;
    return true;
  }

  try {
    client = (dependencies.createCapture ?? createBrowserCapture)({
      baseUrl: url,
      projectKey: key,
      fetch: dependencies.fetch,
      onDiagnostic(diagnostic) {
        // Never forward SDK messages, event IDs, credentials, or error objects.
        attempt('diagnostic_failed', () => {
          const { code: rawCode, count: rawCount, status: rawStatus } = diagnostic;
          const code = sdkCodes.has(rawCode) ? rawCode : 'sdk_diagnostic';
          const count = Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
          const status = typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
            ? rawStatus : undefined;
          diagnose(code, count, status);
        });
      },
    });
    if (!attempt('initialization_failed', () => client!.setConsent(true), true)) return noop;
    doc = dependencies.document === undefined ? globalThis.document : dependencies.document;
    clearTimer = dependencies.clearInterval ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
    interval = (dependencies.setInterval ?? globalThis.setInterval)(() => { void flush(); }, 10_000);
    intervalInstalled = true;
    if (doc) {
      listenerInstalled = true;
      doc.addEventListener('visibilitychange', onVisibility);
    }
    dependencies.hot?.dispose(dispose);
  } catch {
    diagnose('initialization_failed');
    dispose();
    return noop;
  }

  return {
    track(name, properties) {
      if (client) attempt('capture_failed', () => {
        if (properties !== undefined && (
          properties === null || typeof properties !== 'object' || Array.isArray(properties) ||
          !Object.values(properties).every((value) => value === null ||
            typeof value === 'string' || typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value)))
        )) {
          diagnose('invalid_event');
          return;
        }
        return client?.capture(name, properties);
      });
    },
    identify(userId) {
      if (!client) return;
      if (typeof userId !== 'string' || !userId.trim()) {
        resetClientIdentity();
        return;
      }
      if (subject === userId || !resetClientIdentity()) return;
      if (attempt('identify_failed', () => client?.identify(userId), true)) subject = userId;
    },
    resetIdentity() { resetClientIdentity(); },
    flush,
    dispose,
  };
}

export const analytics = createBrowserAnalytics({
  url: import.meta.env?.VITE_ANALYTICS_URL,
  key: import.meta.env?.VITE_ANALYTICS_KEY,
  dev: import.meta.env?.DEV,
}, { hot: import.meta.hot });

export const { track, identify, resetIdentity } = analytics;

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
