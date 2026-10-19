import type { HeaderPair } from './types.js';

const transportHeaders = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
  'forwarded', 'accept-encoding', 'expect',
]);
export const isSensitiveHeader = (name: string) => /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i.test(name);

export function replayHeaders(headers: HeaderPair[], includeSensitive = false): HeaderPair[] {
  const connectionNames = headers
    .filter(([name]) => name.toLowerCase() === 'connection')
    .flatMap(([, value]) => value.toLowerCase().split(',').map((name) => name.trim()));
  return headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return !transportHeaders.has(lower) && !connectionNames.includes(lower)
      && !/^(x-forwarded-|cf-|x-real-ip$)/i.test(lower)
      && (includeSensitive || !isSensitiveHeader(lower));
  });
}

export function replayUrl(destination: string, capturedQuery: string): string {
  const target = new URL(destination.trim());
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) {
    throw new Error('Use an http:// or https:// URL without credentials or a fragment.');
  }
  // Append the raw query without parsing/re-encoding duplicate keys or signed values.
  const base = target.href;
  if (!capturedQuery) return base;
  return `${base}${base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?'}${capturedQuery}`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createCurl(request: { method: string; query: string; headers: HeaderPair[]; bodyText: string | null; size: number; binary: boolean }, destination: string, includeSensitive = false) {
  const headers = replayHeaders(request.headers, includeSensitive);
  const parts = [`curl --globoff --request ${shellQuote(request.method)} ${shellQuote(replayUrl(destination, request.query))}`];
  for (const [name, value] of headers) parts.push(`--header ${shellQuote(`${name}: ${value}`)}`);
  // Suppress cURL's default form content type when the captured request had none.
  if (request.size && !headers.some(([name]) => name.toLowerCase() === 'content-type')) parts.push("--header 'Content-Type:'");
  if (request.size > 0) {
    if (request.binary || request.bodyText === null) parts.push("--data-binary '@webhook-body.bin'");
    else parts.push(`--data-raw ${shellQuote(request.bodyText)}`);
  }
  return parts.join(' \\\n  ');
}
