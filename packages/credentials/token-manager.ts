import { createPrivateKey, createSign } from 'node:crypto';

import type { Provider } from '../domain/index.js';
import { createAppleJwt } from './apple-jwt.js';
import { CredentialError } from './errors.js';
import { GOOGLE_TOKEN_ENDPOINT, postGoogleTokenRequest } from './google-token.js';
import type { Credentials } from './types.js';
import type { CredentialVault } from './vault.js';

const GOOGLE_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['google-play', 'google-ads', 'admob']);
const API_KEY_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['steam', 'applovin-ads', 'applovin-max']);
// Tokens are treated as expired this long before their actual expiry so a
// token handed to a caller does not die mid-request.
const EXPIRY_MARGIN_MS = 60_000;
const SERVICE_ACCOUNT_ASSERTION_LIFETIME_SECONDS = 3600;

export interface TokenConnectionRef {
  id: string;
  provider: Provider;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  const cleaned = (scopes ?? []).map(scope => scope.trim()).filter(scope => scope !== '');
  return [...new Set(cleaned)].sort();
}

export class TokenManager {
  readonly #vault: CredentialVault;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, Map<string, CachedToken>>();
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(vault: CredentialVault, options?: { fetch?: typeof fetch; now?: () => number }) {
    this.#vault = vault;
    const fetchImplementation = options?.fetch;
    this.#fetch = fetchImplementation ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.#now = options?.now ?? Date.now;
  }

  async getAccessToken(connection: { id: string; provider: Provider }, scopes?: string[]): Promise<string> {
    const normalized = normalizeScopes(scopes);
    const scopeKey = normalized.join(' ');
    const cached = this.#readCache(connection.id, scopeKey);
    if (cached !== undefined) return cached;
    // All refreshes for one connection are serialized: concurrent callers
    // share a single upstream request, and refresh-token rotation writes
    // never race each other.
    return this.#withConnectionLock(connection.id, async () => {
      const settled = this.#readCache(connection.id, scopeKey);
      if (settled !== undefined) return settled;
      return this.#issueToken(connection, normalized, scopeKey);
    });
  }

  invalidate(id: string): void {
    this.#cache.delete(id);
  }

  async #issueToken(connection: { id: string; provider: Provider }, scopes: string[], scopeKey: string): Promise<string> {
    if (GOOGLE_PROVIDERS.has(connection.provider)) return this.#issueGoogleToken(connection.id, scopes, scopeKey);
    if (connection.provider === 'app-store') return this.#issueAppleToken(connection.id, scopeKey);
    if (API_KEY_PROVIDERS.has(connection.provider)) return this.#readApiKey(connection.id, connection.provider);
    throw new CredentialError('unsupported_provider', `provider "${String(connection.provider)}" has no token strategy`);
  }

  async #issueGoogleToken(connectionId: string, scopes: string[], scopeKey: string): Promise<string> {
    const credentials = await this.#vault.get(connectionId);
    if (typeof credentials.serviceAccountJson === 'string' && credentials.serviceAccountJson !== '') {
      return this.#issueGoogleServiceAccountToken(connectionId, credentials.serviceAccountJson, scopes, scopeKey);
    }
    if (typeof credentials.clientId === 'string' && credentials.clientId !== '') {
      return this.#issueGoogleRefreshToken(connectionId, credentials, scopes, scopeKey);
    }
    throw new CredentialError(
      'invalid_credentials',
      `Google connection "${connectionId}" has neither a serviceAccountJson nor a clientId credential`,
    );
  }

  async #issueGoogleServiceAccountToken(
    connectionId: string,
    serviceAccountJson: string,
    scopes: string[],
    scopeKey: string,
  ): Promise<string> {
    if (scopes.length === 0) {
      throw new CredentialError('invalid_scopes', 'Google service account tokens require at least one scope');
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(serviceAccountJson) as Record<string, unknown>;
    } catch {
      throw new CredentialError('invalid_credentials', `serviceAccountJson for connection "${connectionId}" is not valid JSON`);
    }
    const clientEmail = parsed.client_email;
    const privateKeyPem = parsed.private_key;
    if (typeof clientEmail !== 'string' || clientEmail === '' || typeof privateKeyPem !== 'string' || privateKeyPem === '') {
      throw new CredentialError(
        'invalid_credentials',
        `serviceAccountJson for connection "${connectionId}" is missing client_email or private_key`,
      );
    }
    let privateKey;
    try {
      privateKey = createPrivateKey(privateKeyPem);
    } catch {
      throw new CredentialError('invalid_credentials', `serviceAccountJson for connection "${connectionId}" has an unreadable private_key`);
    }
    // The assertion audience and the POST target are both the pinned Google
    // endpoint; the JSON's token_uri is deliberately ignored so a crafted
    // service account file cannot redirect the signed assertion elsewhere.
    const issuedAt = Math.floor(this.#now() / 1000);
    const assertionPayload = {
      iss: clientEmail,
      scope: scopes.join(' '),
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + SERVICE_ACCOUNT_ASSERTION_LIFETIME_SECONDS,
    };
    const signingInput = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson(assertionPayload)}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
    const payload = await postGoogleTokenRequest(
      this.#fetch,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${signingInput}.${signature.toString('base64url')}`,
      }),
    );
    this.#storeCache(connectionId, scopeKey, payload.access_token, payload.expires_in);
    return payload.access_token;
  }

  async #issueGoogleRefreshToken(connectionId: string, credentials: Credentials, scopes: string[], scopeKey: string): Promise<string> {
    const refreshToken = credentials.refreshToken;
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      throw new CredentialError(
        'reauthorization_required',
        `Google connection "${connectionId}" has no stored refresh token; the user must complete the OAuth flow`,
      );
    }
    const parameters = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credentials.clientId,
      refresh_token: refreshToken,
    });
    if (typeof credentials.clientSecret === 'string' && credentials.clientSecret !== '') {
      parameters.set('client_secret', credentials.clientSecret);
    }
    if (scopes.length > 0) parameters.set('scope', scopes.join(' '));
    const payload = await postGoogleTokenRequest(this.#fetch, parameters);
    // Persist a rotated refresh token, and only then: the stored value is
    // never overwritten when the response repeats or omits the token.
    if (typeof payload.refresh_token === 'string' && payload.refresh_token !== '' && payload.refresh_token !== refreshToken) {
      await this.#vault.set(connectionId, { ...credentials, refreshToken: payload.refresh_token });
    }
    this.#storeCache(connectionId, scopeKey, payload.access_token, payload.expires_in);
    return payload.access_token;
  }

  async #issueAppleToken(connectionId: string, scopeKey: string): Promise<string> {
    const credentials = await this.#vault.get(connectionId);
    for (const field of ['keyId', 'issuerId', 'privateKey'] as const) {
      if (typeof credentials[field] !== 'string' || credentials[field] === '') {
        throw new CredentialError('invalid_credentials', `Apple connection "${connectionId}" is missing the required field "${field}"`);
      }
    }
    const jwt = createAppleJwt({
      keyId: credentials.keyId,
      issuerId: credentials.issuerId,
      privateKey: credentials.privateKey,
      nowSeconds: this.#now() / 1000,
    });
    const entry = this.#cacheFor(connectionId);
    entry.set(scopeKey, { token: jwt.token, expiresAt: jwt.expiresAt * 1000 - EXPIRY_MARGIN_MS });
    return jwt.token;
  }

  async #readApiKey(connectionId: string, provider: Provider): Promise<string> {
    const credentials = await this.#vault.get(connectionId);
    const apiKey = credentials.apiKey;
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new CredentialError('invalid_credentials', `${provider} connection "${connectionId}" is missing the required field "apiKey"`);
    }
    return apiKey;
  }

  #cacheFor(connectionId: string): Map<string, CachedToken> {
    let entry = this.#cache.get(connectionId);
    if (!entry) {
      entry = new Map();
      this.#cache.set(connectionId, entry);
    }
    return entry;
  }

  #readCache(connectionId: string, scopeKey: string): string | undefined {
    const cached = this.#cache.get(connectionId)?.get(scopeKey);
    if (!cached) return undefined;
    if (cached.expiresAt <= this.#now()) {
      this.#cache.get(connectionId)?.delete(scopeKey);
      return undefined;
    }
    return cached.token;
  }

  #storeCache(connectionId: string, scopeKey: string, token: string, expiresInSeconds: number | undefined): void {
    if (typeof expiresInSeconds !== 'number' || !Number.isFinite(expiresInSeconds)) return;
    const expiresAt = this.#now() + expiresInSeconds * 1000 - EXPIRY_MARGIN_MS;
    if (expiresAt <= this.#now()) return;
    this.#cacheFor(connectionId).set(scopeKey, { token, expiresAt });
  }

  async #withConnectionLock<T>(connectionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(connectionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(connectionId, guard);
    void guard.then(() => {
      if (this.#locks.get(connectionId) === guard) this.#locks.delete(connectionId);
    });
    return run;
  }
}
