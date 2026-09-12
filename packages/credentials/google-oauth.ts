import { createHash, randomBytes } from 'node:crypto';

import { CredentialError } from './errors.js';
import { GOOGLE_AUTHORIZATION_ENDPOINT, postGoogleTokenRequest } from './google-token.js';
import type { Credentials } from './types.js';

const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_AUTHORIZATIONS = 100;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

interface PendingAuthorization {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier: string;
  createdAt: number;
}

function assertLoopbackRedirect(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new CredentialError('invalid_redirect_uri', 'redirectUri is not a valid URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new CredentialError(
      'invalid_redirect_uri',
      'redirectUri must target the local loopback interface (localhost, 127.0.0.1, or [::1])',
    );
  }
}

export class GoogleOAuthBroker {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #stateTtlMs: number;
  // Pending state and PKCE verifiers live only in process memory; they are
  // never written to the vault, disk, or logs.
  readonly #pending = new Map<string, PendingAuthorization>();

  constructor(options?: { fetch?: typeof fetch; now?: () => number; stateTtlMs?: number }) {
    const fetchImplementation = options?.fetch;
    this.#fetch = fetchImplementation ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    this.#now = options?.now ?? Date.now;
    this.#stateTtlMs = options?.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
  }

  begin(input: { clientId: string; clientSecret?: string; redirectUri: string; scopes: string[] }): {
    state: string;
    authorizationUrl: string;
  } {
    if (typeof input.clientId !== 'string' || input.clientId === '') {
      throw new CredentialError('invalid_oauth_input', 'clientId is required to begin an authorization');
    }
    if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.some(scope => typeof scope !== 'string' || scope.trim() === '')) {
      throw new CredentialError('invalid_oauth_input', 'scopes must be a non-empty array of non-empty strings');
    }
    assertLoopbackRedirect(input.redirectUri);
    this.#prune();
    if (this.#pending.size >= MAX_PENDING_AUTHORIZATIONS) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) this.#pending.delete(oldest);
    }
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    this.#pending.set(state, {
      clientId: input.clientId,
      ...(input.clientSecret !== undefined && input.clientSecret !== '' ? { clientSecret: input.clientSecret } : {}),
      redirectUri: input.redirectUri,
      codeVerifier,
      createdAt: this.#now(),
    });
    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    return { state, authorizationUrl: url.toString() };
  }

  async complete(input: { state: string; code: string }): Promise<Credentials> {
    if (typeof input.state !== 'string' || input.state === '' || typeof input.code !== 'string' || input.code === '') {
      throw new CredentialError('invalid_oauth_input', 'state and code are both required to complete an authorization');
    }
    const pending = this.#pending.get(input.state);
    // Single use: the state is consumed before any network activity, so a
    // replayed callback can never trigger a second exchange.
    this.#pending.delete(input.state);
    if (!pending) {
      throw new CredentialError('oauth_state_invalid', 'unknown or already used OAuth state; start a new authorization');
    }
    if (this.#now() - pending.createdAt > this.#stateTtlMs) {
      throw new CredentialError('oauth_state_expired', 'the OAuth state has expired; start a new authorization');
    }
    const parameters = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier,
    });
    if (pending.clientSecret !== undefined) parameters.set('client_secret', pending.clientSecret);
    const payload = await postGoogleTokenRequest(this.#fetch, parameters);
    if (typeof payload.refresh_token !== 'string' || payload.refresh_token === '') {
      throw new CredentialError(
        'oauth_exchange_incomplete',
        'the token exchange returned no refresh token; repeat the authorization with offline access and consent',
      );
    }
    const credentials: Credentials = { clientId: pending.clientId, refreshToken: payload.refresh_token };
    if (pending.clientSecret !== undefined) credentials.clientSecret = pending.clientSecret;
    if (typeof payload.scope === 'string' && payload.scope !== '') credentials.grantedScopes = payload.scope;
    return credentials;
  }

  #prune(): void {
    const cutoff = this.#now() - this.#stateTtlMs;
    for (const [state, pending] of this.#pending) {
      if (pending.createdAt <= cutoff) this.#pending.delete(state);
    }
  }
}
