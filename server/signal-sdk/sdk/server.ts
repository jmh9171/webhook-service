import { createCaptureClient } from "./capture.js";
import type { CaptureClient, CaptureOptions } from "./capture.js";

/** Import from server processes only. Never expose a server key to a browser. */
export function createServerCapture(options: CaptureOptions): CaptureClient {
  if (typeof window !== "undefined")
    throw new Error("Server capture cannot run in a browser.");
  return createCaptureClient(options, "server");
}
export type {
  CaptureCallOptions,
  CaptureClient,
  CaptureClock,
  CaptureDiagnostic,
  CaptureOptions,
  CaptureOutcome,
  FlushResult,
} from "./capture.js";
