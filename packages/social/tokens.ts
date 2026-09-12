// Access-token supply for social connections: refresh + rotation on top of a
// secret store (a CredentialVault satisfies SecretStore). Secrets are read from
// and written back to the store only; nothing is logged. Per-connection refresh
// is serialized so a rotated refresh token is never invalidated by an
// overlapping exchange.

import { AppError } from '../domain/errors.js';
import { X_TOKEN_ENDPOINT, THREADS_REFRESH_ENDPOINT } from './oauth.js';
import type { SecretStore, SocialProvider } from './types.js';

export interface TokenConnectionRef {
  id: string;
  provider: SocialProvider;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const ACCESS_SKEW_MS = 120_000; // refresh X access tokens 2 min before expiry
const THREADS_MIN_AGE_MS = 24 * 3600 * 1000; // Threads: token must be >= 24h old to refresh
const THREADS_REFRESH_BEFORE_MS = 5 * 24 * 3600 * 1000; // refresh within 5 days of expiry

export class SocialTokenManager {
  readonly #vault: SecretStore;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedToken>();
  // Connections whose next resolve must NOT trust an unexpired stored access
  // token (set by invalidate() after a 401). Cleared on a successful refresh
  // and by reset().
  readonly #forced = new Set<string>();
  // Serializes all token work per connection id; entries are removed once the
  // last pending operation for a connection settles.
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(vault: SecretStore, options?: { fetch?: typeof fetch; now?: () => number }) {
    this.#vault = vault;
    this.#fetch = options?.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.#now = options?.now ?? Date.now;
  }

  /**
   * A token we handed out was rejected (401). Force the next resolve to refresh
   * even if the stored access token is not yet past its recorded expiry.
   */
  invalidate(id: string): void {
    this.#cache.delete(id);
    this.#forced.add(id);
  }

  /**
   * Explicit replacement (a fresh OAuth connect replaced the stored secrets).
   * Drop the cache AND any forced flag so the next resolve simply reads and
   * trusts the newly stored credentials.
   */
  reset(id: string): void {
    this.#cache.delete(id);
    this.#forced.delete(id);
  }

  async getAccessToken(connection: TokenConnectionRef): Promise<string> {
    const previous = this.#locks.get(connection.id) ?? Promise.resolve();
    const run = previous.then(
      () => this.#resolve(connection),
      () => this.#resolve(connection),
    );
    const guard = run.catch(() => undefined);
    this.#locks.set(connection.id, guard);
    // Remove the lock entry once this is the last settled operation, so the map
    // does not grow without bound.
    void guard.then(() => {
      if (this.#locks.get(connection.id) === guard) this.#locks.delete(connection.id);
    });
    return run;
  }

  async #resolve(connection: TokenConnectionRef): Promise<string> {
    const cached = this.#cache.get(connection.id);
    if (cached && cached.expiresAt - ACCESS_SKEW_MS > this.#now()) return cached.token;
    const credentials = await this.#vault.get(connection.id);
    if (connection.provider === 'x') return this.#resolveX(connection.id, credentials);
    if (connection.provider === 'threads') return this.#resolveThreads(connection.id, credentials);
    throw new AppError('PROVIDER_UNAVAILABLE', '이 제공자는 토큰 관리를 사용하지 않습니다.');
  }

  async #resolveX(id: string, credentials: Record<string, string>): Promise<string> {
    const forced = this.#forced.has(id);
    const storedExpiry = Number(credentials.accessTokenExpiresAt ?? 0);
    // A forced connection ignores the stored token even if it looks unexpired.
    if (!forced && credentials.accessToken && storedExpiry - ACCESS_SKEW_MS > this.#now()) {
      this.#cache.set(id, { token: credentials.accessToken, expiresAt: storedExpiry });
      return credentials.accessToken;
    }
    const refreshToken = credentials.refreshToken;
    const clientId = credentials.clientId;
    if (!refreshToken || !clientId) {
      throw new AppError('AUTH_REQUIRED', '연결을 다시 설정해 주세요. 저장된 refresh 토큰이 없습니다.', 401);
    }
    const headers: Record<string, string> = {};
    if (credentials.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${credentials.clientSecret}`).toString('base64')}`;
    }
    const payload = await this.#post(X_TOKEN_ENDPOINT, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }, headers);
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
    if (!accessToken) throw new AppError('AUTH_REQUIRED', '토큰 갱신에 실패했습니다. 연결을 다시 설정해 주세요.', 401);
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 7200;
    const expiresAt = this.#now() + expiresIn * 1000;
    // X rotates the refresh token on every use; persist the new one atomically
    // so the old (now invalid) token is never reused.
    const rotated = typeof payload.refresh_token === 'string' && payload.refresh_token ? payload.refresh_token : refreshToken;
    const updated: Record<string, string> = {
      ...credentials,
      refreshToken: rotated,
      accessToken,
      accessTokenExpiresAt: String(expiresAt),
    };
    if (typeof payload.scope === 'string') updated.grantedScopes = payload.scope;
    await this.#vault.set(id, updated);
    this.#forced.delete(id);
    this.#cache.set(id, { token: accessToken, expiresAt });
    return accessToken;
  }

  async #resolveThreads(id: string, credentials: Record<string, string>): Promise<string> {
    const forced = this.#forced.has(id);
    const token = credentials.accessToken;
    if (!token) throw new AppError('AUTH_REQUIRED', '연결을 다시 설정해 주세요. 저장된 토큰이 없습니다.', 401);
    const obtainedAt = Number(credentials.tokenObtainedAt ?? 0);
    const expiresAt = Number(credentials.tokenExpiresAt ?? 0);
    const now = this.#now();
    if (expiresAt && expiresAt <= now) {
      // A lapsed long-lived token cannot be refreshed; a fresh connect is needed.
      throw new AppError('AUTH_REQUIRED', 'Threads 토큰이 만료되었습니다. 연결을 다시 설정해 주세요.', 401);
    }
    // Threads requires the token to be at least 24h old before it can be
    // refreshed; that minimum is always respected, even when forced.
    const oldEnough = !obtainedAt || now - obtainedAt >= THREADS_MIN_AGE_MS;
    const nearExpiry = !expiresAt || expiresAt - now <= THREADS_REFRESH_BEFORE_MS;
    if ((forced || nearExpiry) && oldEnough) {
      const payload = await this.#get(THREADS_REFRESH_ENDPOINT, {
        grant_type: 'th_refresh_token',
        access_token: token,
      });
      const refreshed = typeof payload.access_token === 'string' ? payload.access_token : '';
      if (refreshed) {
        const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 60 * 24 * 3600;
        const newExpiry = now + expiresIn * 1000;
        const updated: Record<string, string> = {
          ...credentials,
          accessToken: refreshed,
          tokenObtainedAt: String(now),
          tokenExpiresAt: String(newExpiry),
        };
        await this.#vault.set(id, updated);
        this.#forced.delete(id);
        this.#cache.set(id, { token: refreshed, expiresAt: newExpiry });
        return refreshed;
      }
      // Refresh produced nothing usable. If we were forced (the stored token was
      // rejected), we must not keep handing it out.
      if (forced) throw new AppError('AUTH_REQUIRED', 'Threads 토큰을 갱신하지 못했습니다. 연결을 다시 설정해 주세요.', 401);
    } else if (forced) {
      // Forced, but the token is too new to refresh (Threads 24h minimum). It
      // was rejected and cannot be renewed here, so a reconnect is required.
      throw new AppError('AUTH_REQUIRED', 'Threads 토큰이 거부되었지만 아직 갱신할 수 없습니다. 연결을 다시 설정해 주세요.', 401);
    }
    if (expiresAt) this.#cache.set(id, { token, expiresAt });
    return token;
  }

  async #post(endpoint: string, form: Record<string, string>, headers: Record<string, string>): Promise<Record<string, unknown>> {
    return this.#exchange(endpoint, 'POST', new URLSearchParams(form).toString(), headers);
  }

  async #get(endpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.#exchange(url.toString(), 'GET', undefined, {});
  }

  async #exchange(url: string, method: string, body: string | undefined, headers: Record<string, string>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
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
      throw new AppError('TEMPORARY', '토큰 서버에 연결하지 못했습니다.', 503);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // invalid_grant / revoked → reconnect; do not retry as a transient error.
      if (response.status === 400 || response.status === 401) {
        throw new AppError('AUTH_REQUIRED', '토큰이 더 이상 유효하지 않습니다. 연결을 다시 설정해 주세요.', 401);
      }
      throw new AppError('TEMPORARY', `토큰 서버가 일시적으로 요청을 처리하지 못했습니다 (HTTP ${response.status}).`, 503);
    }
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new AppError('INVALID_PROVIDER_RESPONSE', '토큰 서버 응답을 해석할 수 없습니다.', 502);
    }
  }
}
