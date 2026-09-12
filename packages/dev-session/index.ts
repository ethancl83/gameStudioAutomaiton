import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function same(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** A separate per-user preview capability; the controller bearer is never given to the browser. */
export class DevSession {
  private readonly bootstrapToken: string;
  private readonly cookieToken: string;
  readonly cookieName: string;
  constructor(directory: string, readonly port: number) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'dev-session.json');
    let saved: { bootstrapToken: string; cookieToken: string } | undefined;
    try {
      const candidate = JSON.parse(readFileSync(file, 'utf8'));
      if (/^[A-Za-z0-9_-]{43}$/.test(candidate.bootstrapToken) && /^[A-Za-z0-9_-]{43}$/.test(candidate.cookieToken)) saved = candidate;
    } catch {}
    this.bootstrapToken = saved?.bootstrapToken ?? randomBytes(32).toString('base64url');
    this.cookieToken = saved?.cookieToken ?? randomBytes(32).toString('base64url');
    this.cookieName = 'appops_preview_' + port;
    writeFileSync(file, JSON.stringify({ port, bootstrapToken: this.bootstrapToken, cookieToken: this.cookieToken }), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  acceptsBootstrap(token: string | undefined): boolean { return same(token, this.bootstrapToken); }
  acceptsCookie(header: string | undefined): boolean {
    const value = header?.split(';').map(part => part.trim()).find(part => part.startsWith(this.cookieName + '='))?.slice(this.cookieName.length + 1);
    return same(value, this.cookieToken);
  }
  cookie(): string { return `${this.cookieName}=${this.cookieToken}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200`; }
}
