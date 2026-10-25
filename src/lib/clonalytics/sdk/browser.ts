import { createCaptureClient } from "./capture.js";
import type { CaptureClient, CaptureOptions } from "./capture.js";

/** Browser-observed events only; the API validates the key's matching source. */
export function createBrowserCapture(options: CaptureOptions): CaptureClient {
  return createCaptureClient(options, "browser");
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
