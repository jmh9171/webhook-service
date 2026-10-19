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
