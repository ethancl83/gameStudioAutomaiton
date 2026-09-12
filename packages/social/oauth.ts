// Provider OAuth brokers for one-time "connect" flows.
//
// Both brokers mirror the GoogleOAuthBroker contract in packages/credentials:
//   begin({ clientId, clientSecret?, redirectUri, scopes? }) => { state, authorizationUrl }
//   complete({ state, code }) => Credentials   (carrying user id + expiry)
// State (and, for X, the PKCE verifier) live ONLY in process memory: never the
// vault, disk, or logs. State is single-use and TTL-bounded. Endpoints are
// pinned constants; the exchange never trusts a URL from input.

import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '../domain/errors.js';

// Pinned endpoints (verified against official docs 2026-09-11; see doc).
export const X_AUTHORIZE_ENDPOINT = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_ENDPOINT = 'https://api.x.com/2/oauth2/token';
export const X_USERS_ME_ENDPOINT = 'https://api.x.com/2/users/me';
export const X_DEFAULT_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'tweet.moderate.write'];

export const THREADS_AUTHORIZE_ENDPOINT = 'https://threads.com/oauth/authorize';
export const THREADS_SHORT_TOKEN_ENDPOINT = 'https://graph.threads.com/oauth/access_token';
export const THREADS_LONG_TOKEN_ENDPOINT = 'https://graph.threads.net/access_token';
export const THREADS_REFRESH_ENDPOINT = 'https://graph.threads.net/refresh_access_token';
export const THREADS_DEFAULT_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_replies',
  'threads_read_replies',
  'threads_delete',
];

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 100;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type SocialCredentials = Record<string, string>;

function assertRedirectUri(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new AppError('INVALID_REDIRECT_URI', 'redirectUri가 올바른 URL이 아닙니다.');
  }
  if (url.username || url.password || url.hash) {
    throw new AppError('INVALID_REDIRECT_URI', 'redirectUri에 인증 정보나 fragment를 포함할 수 없습니다.');
  }
  const httpsOk = url.protocol === 'https:';
  const loopbackOk = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (!httpsOk && !loopbackOk) {
    throw new AppError('INVALID_REDIRECT_URI', 'redirectUri는 https 또는 로컬 loopback(http)이어야 합니다.');
  }
}

interface Pending {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  codeVerifier?: string;
  createdAt: number;
}

abstract class BaseBroker {
  protected readonly fetchImpl: typeof fetch;
  protected readonly now: () => number;
  protected readonly stateTtlMs: number;
  protected readonly pending = new Map<string, Pending>();

  constructor(options?: { fetch?: typeof fetch; now?: () => number; stateTtlMs?: number }) {
    this.fetchImpl = options?.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.now = options?.now ?? Date.now;
    this.stateTtlMs = options?.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  }

  protected consume(state: string, code: string): Pending {
    if (typeof state !== 'string' || state === '' || typeof code !== 'string' || code === '') {
      throw new AppError('INVALID_OAUTH_INPUT', 'state와 code가 모두 필요합니다.');
    }
    const pending = this.pending.get(state);
    // Consume before any network activity so a replayed callback cannot trigger
    // a second exchange.
    this.pending.delete(state);
    if (!pending) throw new AppError('OAUTH_STATE_INVALID', '알 수 없거나 이미 사용된 state입니다. 다시 연결을 시작해 주세요.');
    if (this.now() - pending.createdAt > this.stateTtlMs) {
      throw new AppError('OAUTH_STATE_EXPIRED', 'state가 만료되었습니다. 다시 연결을 시작해 주세요.');
    }
    return pending;
  }

  protected register(pending: Pending): string {
    this.prune();
    if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const state = randomBytes(32).toString('base64url');
    this.pending.set(state, pending);
    return state;
  }

  private prune(): void {
    const cutoff = this.now() - this.stateTtlMs;
    for (const [state, pending] of this.pending) if (pending.createdAt <= cutoff) this.pending.delete(state);
  }

  protected validateBegin(input: { clientId: string; scopes?: string[]; redirectUri: string }, fallback: string[]): string[] {
    if (typeof input.clientId !== 'string' || input.clientId === '') {
      throw new AppError('INVALID_OAUTH_INPUT', '연결을 시작하려면 clientId가 필요합니다.');
    }
    assertRedirectUri(input.redirectUri);
    const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : fallback;
    if (scopes.some(scope => typeof scope !== 'string' || scope.trim() === '')) {
      throw new AppError('INVALID_OAUTH_INPUT', 'scope 값이 올바르지 않습니다.');
    }
    return scopes;
  }

  protected async postForm(endpoint: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    return this.exchange(endpoint, 'POST', new URLSearchParams(form).toString(), headers);
  }

  protected async getJson(endpoint: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.exchange(url.toString(), 'GET', undefined, headers);
  }

  private async exchange(url: string, method: string, body: string | undefined, headers: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
          ...headers,
        },
        body,
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch {
      throw new AppError('TEMPORARY', '인증 서버에 연결하지 못했습니다.', 503);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // Auth error bodies can echo the code/secret; never surface them.
      if (response.status === 400 || response.status === 401) {
        throw new AppError('OAUTH_EXCHANGE_FAILED', '인증 코드 교환에 실패했습니다. 다시 연결을 시작해 주세요.', 401);
      }
      throw new AppError('TEMPORARY', `인증 서버가 일시적으로 요청을 처리하지 못했습니다 (HTTP ${response.status}).`, 503);
    }
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new AppError('INVALID_PROVIDER_RESPONSE', '인증 서버 응답을 해석할 수 없습니다.', 502);
    }
  }
}

/** X (OAuth 2.0 Authorization Code with PKCE). */
export class XOAuthBroker extends BaseBroker {
  begin(input: { clientId: string; clientSecret?: string; redirectUri: string; scopes?: string[] }): {
    state: string;
    authorizationUrl: string;
  } {
    const scopes = this.validateBegin(input, X_DEFAULT_SCOPES);
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const state = this.register({
      clientId: input.clientId,
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
      redirectUri: input.redirectUri,
      scopes,
      codeVerifier,
      createdAt: this.now(),
    });
    const url = new URL(X_AUTHORIZE_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { state, authorizationUrl: url.toString() };
  }

  async complete(input: { state: string; code: string }): Promise<SocialCredentials> {
    const pending = this.consume(input.state, input.code);
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier ?? '',
      client_id: pending.clientId,
    };
    const headers: Record<string, string> = {};
    if (pending.clientSecret) {
      // Confidential clients authenticate with HTTP Basic per X docs.
      headers.Authorization = `Basic ${Buffer.from(`${pending.clientId}:${pending.clientSecret}`).toString('base64')}`;
    }
    const token = await this.postForm(X_TOKEN_ENDPOINT, form, headers);
    const refreshToken = typeof token.refresh_token === 'string' ? token.refresh_token : '';
    const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
    if (!refreshToken || !accessToken) {
      throw new AppError('OAUTH_EXCHANGE_INCOMPLETE', 'refresh 토큰을 받지 못했습니다. offline.access 범위로 다시 연결해 주세요.');
    }
    const me = await this.getJson(X_USERS_ME_ENDPOINT, {}, { Authorization: `Bearer ${accessToken}` });
    const data = (me.data ?? {}) as Record<string, unknown>;
    const userId = typeof data.id === 'string' ? data.id : '';
    if (!userId) throw new AppError('OAUTH_EXCHANGE_INCOMPLETE', '계정 식별자를 확인하지 못했습니다.');
    const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 7200;
    const credentials: SocialCredentials = {
      clientId: pending.clientId,
      refreshToken,
      accessToken,
      accessTokenExpiresAt: String(this.now() + expiresIn * 1000),
      userId,
    };
    if (typeof data.username === 'string') credentials.username = data.username;
    if (typeof token.scope === 'string') credentials.grantedScopes = token.scope;
    if (pending.clientSecret) credentials.clientSecret = pending.clientSecret;
    return credentials;
  }
}

/** Threads (OAuth 2.0 Authorization Code; no PKCE, confidential client). */
export class ThreadsOAuthBroker extends BaseBroker {
  begin(input: { clientId: string; clientSecret?: string; redirectUri: string; scopes?: string[] }): {
    state: string;
    authorizationUrl: string;
  } {
    if (typeof input.clientSecret !== 'string' || input.clientSecret === '') {
      throw new AppError('INVALID_OAUTH_INPUT', 'Threads는 clientSecret이 필요합니다.');
    }
    const scopes = this.validateBegin(input, THREADS_DEFAULT_SCOPES);
    const state = this.register({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      redirectUri: input.redirectUri,
      scopes,
      createdAt: this.now(),
    });
    const url = new URL(THREADS_AUTHORIZE_ENDPOINT);
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(','));
    url.searchParams.set('state', state);
    return { state, authorizationUrl: url.toString() };
  }

  async complete(input: { state: string; code: string }): Promise<SocialCredentials> {
    const pending = this.consume(input.state, input.code);
    const secret = pending.clientSecret ?? '';
    // 1) Short-lived token + user id.
    const short = await this.postForm(THREADS_SHORT_TOKEN_ENDPOINT, {
      client_id: pending.clientId,
      client_secret: secret,
      grant_type: 'authorization_code',
      redirect_uri: pending.redirectUri,
      code: input.code,
    });
    const shortToken = typeof short.access_token === 'string' ? short.access_token : '';
    const userId = short.user_id != null ? String(short.user_id) : '';
    if (!shortToken || !userId) throw new AppError('OAUTH_EXCHANGE_INCOMPLETE', 'Threads 단기 토큰 교환이 완료되지 않았습니다.');
    // 2) Exchange for a long-lived (60-day) token.
    const long = await this.getJson(THREADS_LONG_TOKEN_ENDPOINT, {
      grant_type: 'th_exchange_token',
      client_secret: secret,
      access_token: shortToken,
    });
    const longToken = typeof long.access_token === 'string' ? long.access_token : '';
    if (!longToken) throw new AppError('OAUTH_EXCHANGE_INCOMPLETE', 'Threads 장기 토큰 교환이 완료되지 않았습니다.');
    const expiresIn = typeof long.expires_in === 'number' ? long.expires_in : 60 * 24 * 3600;
    return {
      threadsUserId: userId,
      // clientId is preserved so a later token repair/refresh has the full app
      // identity without a re-connect.
      clientId: pending.clientId,
      accessToken: longToken,
      clientSecret: secret,
      tokenObtainedAt: String(this.now()),
      tokenExpiresAt: String(this.now() + expiresIn * 1000),
    };
  }
}
