export type HeaderPair = [string, string];

export interface RequestSummary {
  id: string;
  method: string;
  path: string;
  query: string;
  receivedAt: string;
  contentType: string;
  size: number;
}

export interface CapturedRequest extends RequestSummary {
  headers: HeaderPair[];
  bodyText: string | null;
  binary: boolean;
}

export interface InboxSnapshot {
  requests: RequestSummary[];
  instanceId: string;
  capturePath: string;
  limits: { maxRequests: number; maxBodyBytes: number; maxStoredBytes: number };
  storedBytes: number;
}

export interface LabEvent {
  id: string;
  at: string;
  source: "capture" | "chaos" | "mock" | "heartbeat" | "external";
  title: string;
  correlation: string;
  status: string;
  detail: string;
}
export interface ChaosConfig {
  id: string;
  name: string;
  mode: "first" | "every" | "random";
  failures: number;
  errorStatus: number;
  delayMs: number;
  jitterMs: number;
  attempts: number;
  calls: { at: string; status: number; delayMs: number }[];
}
export interface MockRoute {
  method: string;
  path: string;
  status: number;
  contentType: "application/json" | "text/plain";
  headers: HeaderPair[];
  body: string;
  delayMs: number;
  paginated: boolean;
  requiredBearer: string;
  perMinute: number;
}
export interface MockService {
  id: string;
  name: string;
  routes: MockRoute[];
  calls: { at: string; method: string; path: string; status: number }[];
}
export interface Watchdog {
  id: string;
  name: string;
  intervalSeconds: number;
  graceSeconds: number;
  createdAt: string;
  lastPing: string | null;
  status: "waiting" | "healthy" | "missed";
  alertUrl: string;
  delivery: string;
}
export interface LabState {
  chaos: ChaosConfig[];
  mocks: MockService[];
  watchdogs: Watchdog[];
  events: LabEvent[];
  eventPath: string;
}
