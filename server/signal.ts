import { createServerCapture } from "./signal-sdk/sdk/server.js";
import type { CaptureClient } from "./signal-sdk/sdk/server.js";

export interface SignalAnalytics {
  capture(
    name: string,
    properties: Record<string, string | number | boolean>,
    call: { distinctId: string; eventId: string },
  ): void;
  close(): Promise<void>;
}

export interface SignalAnalyticsOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  flushIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

// Deliberately do not read process.env here: callers opt in explicitly.
const disabled: SignalAnalytics = {
  capture() {},
  async close() {},
};

function diagnose(code: string, count = 0, status?: number): void {
  try {
    console.warn("[signal]", {
      code,
      count: Number.isSafeInteger(count) && count >= 0 ? count : 0,
      ...(Number.isInteger(status) && status! >= 100 && status! <= 599
        ? { status }
        : {}),
    });
  } catch {
    // Logging must never affect a webhook request or shutdown.
  }
}

function boundedMs(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.min(max, value))
    : fallback;
}

export function createSignalAnalytics(
  options: SignalAnalyticsOptions = {},
): SignalAnalytics {
  let client: CaptureClient | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let shutdownTimeoutMs: number;
  let closing = false;
  let flight: Promise<void> | undefined;
  let closed: Promise<void> | undefined;

  function disable(): void {
    try {
      client?.setEnabled(false);
    } catch {
      diagnose("disable_failed");
    }
  }

  try {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) return disabled;
    shutdownTimeoutMs = boundedMs(options.shutdownTimeoutMs, 3_000, 3_000);
    client = createServerCapture({
      baseUrl: "https://clonalytics-staging-kpjmx.sevalla.app",
      projectKey: apiKey,
      fetch: options.fetch,
      maxRetries: 2,
      requestTimeoutMs: 2_000,
      clock: {
        now: () => Date.now(),
        setTimeout(callback, delayMs) {
          const timeout = setTimeout(callback, delayMs);
          timeout.unref();
          return timeout;
        },
        clearTimeout: (timeout) => clearTimeout(timeout),
      },
      onDiagnostic: ({ code, count, status }) => diagnose(code, count, status),
    });
    client.setConsent(true);
    timer = setInterval(() => {
      if (closing || flight) return;
      flight = (async () => {
        try {
          await client!.flush();
        } catch {
          diagnose("flush_failed");
        }
      })().finally(() => {
        flight = undefined;
      });
    }, boundedMs(options.flushIntervalMs, 10_000, 60_000));
    timer.unref();
  } catch {
    if (timer) clearInterval(timer);
    disable();
    diagnose("init_failed");
    return disabled;
  }

  return {
    capture(name, properties, call) {
      if (closing) return;
      try {
        // Explicit per-event identity prevents shared client identity across users.
        client!.capture(name, properties, {
          distinctId: call.distinctId,
          eventId: call.eventId,
        });
      } catch {
        diagnose("capture_failed");
      }
    },
    close() {
      if (closed) return closed;
      closing = true;
      clearInterval(timer);
      closed = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (async () => {
          try {
            // A running flush snapshots its queue. Shutdown must also drain
            // events captured after that snapshot before close was called.
            await flight;
            await client!.shutdown();
          } catch {
            diagnose("close_failed");
          } finally {
            disable();
          }
        })();
        try {
          await Promise.race([
            cleanup,
            new Promise<void>((resolve) => {
              deadline = setTimeout(() => {
                diagnose("shutdown_timeout");
                disable(); // Clears the queue and aborts requests and retry waits.
                resolve();
              }, shutdownTimeoutMs);
              deadline.unref();
            }),
          ]);
          // The SDK races fetch against abort, so even an injected fetch that
          // ignores its signal cannot prevent this cleanup from settling.
          await cleanup;
        } finally {
          if (deadline) clearTimeout(deadline);
        }
      })();
      return closed;
    },
  };
}
