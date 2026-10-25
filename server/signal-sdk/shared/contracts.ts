export type Source = 'browser' | 'server';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface CaptureEvent {
  eventId: string;
  name: string;
  occurredAt: string;
  distinctId?: string | null;
  anonymousId?: string | null;
  properties?: Record<string, JsonValue>;
  schemaVersion?: number;
}
export interface Receipt {
  eventId: string;
  status: 'accepted' | 'duplicate' | 'suppressed';
  receiptId: string | null;
  receivedAt: string | null;
}
export interface CaptureResult { accepted: number; duplicates: number; suppressed: number; receipts: Receipt[] }
export interface ProjectSummary {
  id: string; slug: string; name: string; environment: string; eventCount: number;
  /** Most recent receipt time for the project, or null before its first event. */
  lastEventAt: string | null; activeKeys: number;
}
/** Ingestion allowlists. Empty lists accept any valid event name / property key; personal-data keys are always dropped. */
export interface ProjectPolicy {
  projectId: string; environment: string; editable: boolean;
  allowedEventNames: string[]; allowedPropertyKeys: string[]; updatedAt: string | null;
}
export interface CollectorKeySummary {
  id: string; projectId: string; producerId: string; namespace: string; source: Source;
  label: string; prefix: string | null; createdAt: string; revokedAt: string | null;
}
export interface IssuedCollectorKey { key: CollectorKeySummary; rawKey: string }
export interface CollectorKeysPage { keys: CollectorKeySummary[]; nextCursor: string | null }
export interface ProjectAuditEntry {
  id: string; projectId: string; action: 'project.created' | 'project.policy_updated' | 'key.issued' | 'key.rotated' | 'key.revoked';
  actor: 'local-admin'; keyId: string | null; replacementKeyId: string | null; source: Source | null; at: string;
}
export interface StoredEvent {
  id: string; eventId: string; name: string; occurredAt: string; receivedAt: string;
  distinctId: string | null; anonymousId: string | null; properties: Record<string, JsonValue>; source: Source;
}
export interface ReportOverview {
  from: string; to: string; timezone: 'UTC'; provisional: boolean;
  summary: { totalEvents: number; identifiedIds: number; anonymousEvents: number; serverEvents: number };
  trend: Array<{ date: string; events: number; identifiedIds: number }>;
  /** The fixed demo funnel; null for non-synthetic projects (use a configurable funnel in Reports). */
  funnel: { steps: Array<{ name: string; count: number; conversionRate: number }>; windowHours: number; source: 'server'; subject: 'distinct identified IDs' } | null;
  eventNames: string[];
}
export type DemoFunnel = NonNullable<ReportOverview['funnel']>;
export interface EventsPage { events: StoredEvent[]; nextCursor: string | null }
export type DemoScenario = 'baseline' | 'retry' | 'conflict' | 'invalid' | 'isolation';
export interface ScenarioResult { title: string; passed: boolean; checks: Array<{ label: string; passed: boolean; detail: string }> }
export interface ApiError { error: { code: string; message: string; details?: unknown } }
export const FUNNEL_STEPS = ['workspace_created', 'report_created', 'report_shared'] as const;
/** eventValues/batchValues count JSON values (objects, arrays, primitives) inside event properties. */
export const LIMITS = { batchEvents: 100, batchBytes: 262144, eventBytes: 16384, propertyBytes: 4096, propertyDepth: 4, eventValues: 500, batchValues: 5000, queueEvents: 1000, queueBytes: 1048576, queueTtlMs: 900000 } as const;
