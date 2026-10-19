import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sessionCookie = 'inbox_session';
export const sessionLifetime = 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash('sha256').update(value).digest();
export const secretsEqual = (left: string, right: string) => timingSafeEqual(digest(left), digest(right));

// Store only token hashes. Sessions, like the inbox, are intentionally temporary.
export class Sessions {
  private sessions = new Map<string, number>();
  private failures: number[] = [];
  constructor(private now = Date.now) {}

  create() {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(digest(token).toString('hex'), this.now() + sessionLifetime);
    this.failures = [];
    return token;
  }

  valid(token: string) {
    this.prune();
    return !!token && this.sessions.has(digest(token).toString('hex'));
  }

  revoke(token: string) { this.sessions.delete(digest(token).toString('hex')); }
  throttled() { this.prune(); return this.failures.length >= 10; }
  failed() { this.failures.push(this.now()); }

  private prune() {
    const now = this.now();
    for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key);
    this.failures = this.failures.filter((time) => time > now - 60000);
  }
}

export function readSession(cookie?: string) {
  return cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1) ?? '';
}

export function cookieHeader(token: string, secure: boolean, clear = false) {
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : sessionLifetime / 1000}${secure ? '; Secure' : ''}`;
}
