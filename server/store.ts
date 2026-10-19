import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { CapturedRequest, HeaderPair, RequestSummary } from '../shared/types.js';

export const limits = { maxRequests: 100, maxBodyBytes: 1024 * 1024, maxStoredBytes: 20 * 1024 * 1024 };
export interface StoredRequest extends RequestSummary { headers: HeaderPair[]; body: Buffer }

export class RequestStore {
  readonly instanceId = randomUUID();
  private entries: StoredRequest[] = [];
  storedBytes = 0;

  constructor(private readonly capacity = limits.maxRequests, private readonly byteBudget = limits.maxStoredBytes) {}

  add(input: Omit<StoredRequest, 'id' | 'receivedAt' | 'size'>): StoredRequest {
    if (input.body.length > this.byteBudget) throw new Error('Body exceeds storage budget');
    const entry = { ...input, id: randomUUID(), receivedAt: new Date().toISOString(), size: input.body.length };
    this.entries.unshift(entry);
    this.storedBytes += entry.size;
    while (this.entries.length > this.capacity || this.storedBytes > this.byteBudget) this.storedBytes -= this.entries.pop()!.size;
    return entry;
  }

  list(): RequestSummary[] {
    return this.entries.map(({ body: _body, headers: _headers, ...summary }) => summary);
  }
  get(id: string) { return this.entries.find((entry) => entry.id === id); }
  clear() { this.entries = []; this.storedBytes = 0; }
}

export function requestDetail(entry: StoredRequest): CapturedRequest {
  const { body, ...metadata } = entry;
  let bodyText: string | null = null;
  const encoded = entry.headers.some(([name, value]) => name.toLowerCase() === 'content-encoding' && value.toLowerCase() !== 'identity');
  const multipart = /^multipart\//i.test(entry.contentType);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    // Treat non-UTF-8, compressed, multipart, and embedded control bytes as file bodies.
    if (!encoded && !multipart && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text) && Buffer.from(text).equals(body)) bodyText = text;
  } catch { /* Preserve the original bytes for download. */ }
  return { ...metadata, bodyText, binary: bodyText === null };
}
