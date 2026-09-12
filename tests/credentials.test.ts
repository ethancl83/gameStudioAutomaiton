import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, createVerify } from 'node:crypto';
import { mkdtemp, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CredentialError,
  CredentialVault,
  GoogleOAuthBroker,
  GOOGLE_TOKEN_ENDPOINT,
  KeyringKeyProvider,
  TokenManager,
  createAppleJwt,
  verifyAppleJwt,
  type Credentials,
  type KeyProvider,
} from '../packages/credentials/index.js';

// ---------------------------------------------------------------------------
// Test doubles. These tests validate the crypto/keyring/fetch boundaries with
// injected providers and a mocked token endpoint; no real Google/Apple account
// or OS keyring is exercised here.
// ---------------------------------------------------------------------------

class MemoryKeyProvider implements KeyProvider {
  readonly name = 'memory';
  key: Buffer | undefined;
  locked = false;

  async getKey(): Promise<Buffer | undefined> {
    if (this.locked) {
      throw new CredentialError('vault_locked', 'test key store is locked', { retryable: true });
    }
    return this.key;
  }

  async setKey(key: Buffer): Promise<void> {
    if (this.locked) {
      throw new CredentialError('vault_locked', 'test key store is locked', { retryable: true });
    }
    this.key = Buffer.from(key);
  }
}

interface RecordedCall {
  url: string;
  body: URLSearchParams;
}

function createFetchMock(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchImplementation = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), body: new URLSearchParams(String(init?.body ?? '')) };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, fetch: fetchImplementation };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function newVaultDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'credentials-test-'));
}

function decodeJwtSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function expectCredentialError(promise: Promise<unknown>, code: string): Promise<CredentialError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CredentialError, `expected CredentialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected CredentialError with code ${code}, but nothing was thrown`);
}

const rsaPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ecPair = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ---------------------------------------------------------------------------
// CredentialVault
// ---------------------------------------------------------------------------

test('vault stores, reads, lists and removes credentials through AES-GCM files', async () => {
  const directory = await newVaultDir();
  const vault = new CredentialVault(directory, { keyProvider: new MemoryKeyProvider() });
  const value: Credentials = { apiKey: 'super-secret-api-key', accountId: 'acc-1' };

  assert.equal(await vault.has('conn-1'), false);
  await vault.set('conn-1', value);
  assert.equal(await vault.has('conn-1'), true);
  assert.deepEqual(await vault.get('conn-1'), value);

  await vault.remove('conn-1');
  assert.equal(await vault.has('conn-1'), false);
  await vault.remove('conn-1'); // idempotent
  await expectCredentialError(vault.get('conn-1'), 'credential_not_found');
});

test('vault files never contain plaintext secrets and leave no temp files behind', async () => {
  const directory = await newVaultDir();
  const vault = new CredentialVault(directory, { keyProvider: new MemoryKeyProvider() });
  await vault.set('conn-1', { refreshToken: 'PLAINTEXT-SENTINEL-VALUE' });

  const entries = await readdir(directory);
  assert.deepEqual(entries, ['conn-1.cred.json']);
  const raw = await readFile(join(directory, 'conn-1.cred.json'), 'utf8');
  assert.ok(!raw.includes('PLAINTEXT-SENTINEL-VALUE'), 'ciphertext file must not contain the secret');
  assert.ok(!raw.includes('refreshToken'), 'ciphertext file must not contain field names');
  const record = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(record.schema, 1);
  assert.equal(record.keyVersion, 1);
  assert.equal(record.algorithm, 'aes-256-gcm');
  assert.equal(Buffer.from(String(record.nonce), 'base64').length, 12);
  assert.equal(Buffer.from(String(record.tag), 'base64').length, 16);
});

test('vault rejects path-escaping or malformed ids', async () => {
  const directory = await newVaultDir();
  const vault = new CredentialVault(directory, { keyProvider: new MemoryKeyProvider() });
  for (const id of ['../evil', 'a/b', 'a\\b', '', '.', '..', 'a..b', '.hidden']) {
    await expectCredentialError(vault.set(id, { a: 'b' }), 'invalid_id');
    await expectCredentialError(vault.get(id), 'invalid_id');
    await expectCredentialError(vault.has(id), 'invalid_id');
    await expectCredentialError(vault.remove(id), 'invalid_id');
  }
});

test('vault rejects non-string credential values', async () => {
  const directory = await newVaultDir();
  const vault = new CredentialVault(directory, { keyProvider: new MemoryKeyProvider() });
  await expectCredentialError(vault.set('conn-1', { count: 1 } as unknown as Credentials), 'invalid_credentials');
  await expectCredentialError(vault.set('conn-1', ['a'] as unknown as Credentials), 'invalid_credentials');
});

test('tampered ciphertext and files copied to another id fail closed', async () => {
  const directory = await newVaultDir();
  const provider = new MemoryKeyProvider();
  const vault = new CredentialVault(directory, { keyProvider: provider });
  await vault.set('conn-1', { apiKey: 'value' });

  const file = join(directory, 'conn-1.cred.json');
  const record = JSON.parse(await readFile(file, 'utf8')) as { ciphertext: string };
  const corrupted = Buffer.from(record.ciphertext, 'base64');
  corrupted[0] = corrupted[0]! ^ 0xff;
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), ciphertext: corrupted.toString('base64') }));
  await expectCredentialError(vault.get('conn-1'), 'decrypt_failed');

  // Rebuild a clean record, then copy it under a different id: the id is part
  // of the AAD, so decryption under the other id must fail.
  await vault.set('conn-1', { apiKey: 'value' });
  await copyFile(file, join(directory, 'conn-2.cred.json'));
  await expectCredentialError(vault.get('conn-2'), 'decrypt_failed');
});

test('a lost master key never leads to silent re-keying while ciphertext exists', async () => {
  const directory = await newVaultDir();
  const original = new MemoryKeyProvider();
  const vault = new CredentialVault(directory, { keyProvider: original });
  await vault.set('conn-1', { apiKey: 'value' });

  const fresh = new MemoryKeyProvider(); // simulates key loss (new machine, wiped keyring)
  const recovered = new CredentialVault(directory, { keyProvider: fresh });
  await expectCredentialError(recovered.get('conn-1'), 'master_key_missing');
  await expectCredentialError(recovered.set('conn-2', { apiKey: 'other' }), 'master_key_missing');
  assert.equal(fresh.key, undefined, 'no replacement key may be created');

  const status = await recovered.status();
  assert.equal(status.available, false);
  assert.match(status.reason ?? '', /master key/);
});

test('a locked key store is reported as locked, distinct from an absent key', async () => {
  const directory = await newVaultDir();
  const provider = new MemoryKeyProvider();
  const vault = new CredentialVault(directory, { keyProvider: provider });
  await vault.set('conn-1', { apiKey: 'value' });

  provider.locked = true;
  const status = await vault.status();
  assert.equal(status.available, false);
  assert.equal(status.backend, 'memory');
  assert.match(status.reason ?? '', /locked/);
  const error = await expectCredentialError(vault.get('conn-1'), 'vault_locked');
  assert.equal(error.retryable, true);
});

test('an empty vault is available and creates its master key on first write', async () => {
  const directory = await newVaultDir();
  const provider = new MemoryKeyProvider();
  const vault = new CredentialVault(directory, { keyProvider: provider });

  const before = await vault.status();
  assert.deepEqual(before, { available: true, backend: 'memory' });
  assert.equal(provider.key?.length, undefined);

  await vault.set('conn-1', { apiKey: 'value' });
  assert.equal(provider.key?.length, 32);
  assert.deepEqual(await vault.status(), { available: true, backend: 'memory' });
});

// ---------------------------------------------------------------------------
// KeyringKeyProvider boundary (fake AsyncEntry; the real OS keyring is not
// exercised in automated tests)
// ---------------------------------------------------------------------------

test('keyring provider maps entry results and rejections to the vault contract', async () => {
  const stored: Uint8Array[] = [];
  const working = new KeyringKeyProvider({
    entry: {
      async getSecret() {
        // The native binding resolves null (not undefined) for absent entries.
        return stored[0] ?? null;
      },
      async setSecret(secret: Uint8Array) {
        stored[0] = secret;
      },
    },
  });
  assert.equal(await working.getKey(), undefined);
  await working.setKey(Buffer.alloc(32, 7));
  assert.equal((await working.getKey())?.length, 32);

  const locked = new KeyringKeyProvider({
    entry: {
      async getSecret(): Promise<Uint8Array | undefined> {
        throw new Error('org.freedesktop.secrets collection is locked');
      },
      async setSecret() {
        throw new Error('org.freedesktop.secrets collection is locked');
      },
    },
  });
  const error = await expectCredentialError(locked.getKey(), 'vault_locked');
  assert.equal(error.retryable, true);
  await expectCredentialError(locked.setKey(Buffer.alloc(32)), 'vault_locked');
});

// ---------------------------------------------------------------------------
// TokenManager — Google service account
// ---------------------------------------------------------------------------

async function newVaultWith(id: string, value: Credentials): Promise<CredentialVault> {
  const vault = new CredentialVault(await newVaultDir(), { keyProvider: new MemoryKeyProvider() });
  await vault.set(id, value);
  return vault;
}

test('service account flow signs an RS256 assertion for the pinned endpoint, ignoring token_uri', async () => {
  const vault = await newVaultWith('g-1', {
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'robot@example.iam.gserviceaccount.com',
      private_key: rsaPair.privateKey,
      token_uri: 'https://evil.example/steal-tokens',
    }),
  });
  const mock = createFetchMock(() => jsonResponse(200, { access_token: 'sa-token', expires_in: 3600, token_type: 'Bearer' }));
  const manager = new TokenManager(vault, { fetch: mock.fetch });

  const token = await manager.getAccessToken({ id: 'g-1', provider: 'google-play' }, ['https://www.googleapis.com/auth/androidpublisher']);
  assert.equal(token, 'sa-token');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]!.url, GOOGLE_TOKEN_ENDPOINT, 'secrets must only ever go to the pinned Google endpoint');

  const body = mock.calls[0]!.body;
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const assertion = body.get('assertion')!;
  const [headerSegment, payloadSegment, signatureSegment] = assertion.split('.');
  assert.deepEqual(decodeJwtSegment(headerSegment!), { alg: 'RS256', typ: 'JWT' });
  const payload = decodeJwtSegment(payloadSegment!);
  assert.equal(payload.aud, GOOGLE_TOKEN_ENDPOINT);
  assert.equal(payload.iss, 'robot@example.iam.gserviceaccount.com');
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/androidpublisher');
  const verified = createVerify('RSA-SHA256')
    .update(`${headerSegment}.${payloadSegment}`)
    .verify(rsaPair.publicKey, Buffer.from(signatureSegment!, 'base64url'));
  assert.equal(verified, true, 'assertion must verify with the service account public key');
});

test('service account flow requires at least one scope', async () => {
  const vault = await newVaultWith('g-1', {
    serviceAccountJson: JSON.stringify({ client_email: 'a@b.c', private_key: rsaPair.privateKey }),
  });
  const mock = createFetchMock(() => jsonResponse(200, { access_token: 'x', expires_in: 3600 }));
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  await expectCredentialError(manager.getAccessToken({ id: 'g-1', provider: 'admob' }), 'invalid_scopes');
  assert.equal(mock.calls.length, 0);
});

// ---------------------------------------------------------------------------
// TokenManager — Google OAuth refresh, caching, serialization, rotation
// ---------------------------------------------------------------------------

const OAUTH_CREDENTIALS: Credentials = {
  clientId: 'client-1.apps.googleusercontent.com',
  clientSecret: 'client-secret-1',
  refreshToken: 'refresh-token-INITIAL',
};

test('refresh flow caches per scope set and honors invalidate()', async () => {
  const vault = await newVaultWith('g-2', OAUTH_CREDENTIALS);
  let counter = 0;
  const mock = createFetchMock(() => jsonResponse(200, { access_token: `token-${counter++}`, expires_in: 3600 }));
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  const connection = { id: 'g-2', provider: 'google-ads' as const };

  const first = await manager.getAccessToken(connection, ['scope-a', 'scope-b']);
  const second = await manager.getAccessToken(connection, ['scope-b', 'scope-a']); // same set, different order
  assert.equal(first, second);
  assert.equal(mock.calls.length, 1, 'scope order must not defeat the cache');
  assert.equal(mock.calls[0]!.body.get('grant_type'), 'refresh_token');
  assert.equal(mock.calls[0]!.body.get('client_id'), OAUTH_CREDENTIALS.clientId);
  assert.equal(mock.calls[0]!.body.get('client_secret'), OAUTH_CREDENTIALS.clientSecret);
  assert.equal(mock.calls[0]!.body.get('refresh_token'), OAUTH_CREDENTIALS.refreshToken);

  const other = await manager.getAccessToken(connection, ['scope-c']);
  assert.notEqual(other, first);
  assert.equal(mock.calls.length, 2, 'a different scope set gets its own token');

  manager.invalidate('g-2');
  await manager.getAccessToken(connection, ['scope-a', 'scope-b']);
  assert.equal(mock.calls.length, 3, 'invalidate must force a fresh refresh');
});

test('tokens with expiry shorter than the safety margin are not cached', async () => {
  const vault = await newVaultWith('g-2', OAUTH_CREDENTIALS);
  const mock = createFetchMock(() => jsonResponse(200, { access_token: 'short-lived', expires_in: 30 }));
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  const connection = { id: 'g-2', provider: 'google-ads' as const };
  await manager.getAccessToken(connection, ['scope-a']);
  await manager.getAccessToken(connection, ['scope-a']);
  assert.equal(mock.calls.length, 2, 'a token expiring inside the margin must not be reused');
});

test('concurrent requests for one connection share a single refresh', async () => {
  const vault = await newVaultWith('g-2', OAUTH_CREDENTIALS);
  const mock = createFetchMock(async () => {
    await new Promise(resolvePause => setTimeout(resolvePause, 20));
    return jsonResponse(200, { access_token: 'shared-token', expires_in: 3600 });
  });
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  const connection = { id: 'g-2', provider: 'google-play' as const };

  const tokens = await Promise.all(Array.from({ length: 5 }, () => manager.getAccessToken(connection, ['scope-a'])));
  assert.deepEqual(tokens, Array.from({ length: 5 }, () => 'shared-token'));
  assert.equal(mock.calls.length, 1, 'refreshes per connection must be serialized and deduplicated');
});

test('rotated refresh tokens are persisted; unchanged responses never rewrite the vault', async () => {
  const vault = await newVaultWith('g-2', OAUTH_CREDENTIALS);
  const responses = [
    { access_token: 'token-1', expires_in: 30, refresh_token: 'refresh-token-ROTATED' },
    { access_token: 'token-2', expires_in: 30 },
  ];
  const mock = createFetchMock((_call, index) => jsonResponse(200, responses[index] ?? responses[1]!));
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  const connection = { id: 'g-2', provider: 'google-ads' as const };

  await manager.getAccessToken(connection, ['scope-a']);
  const afterRotation = await vault.get('g-2');
  assert.equal(afterRotation.refreshToken, 'refresh-token-ROTATED');
  assert.equal(afterRotation.clientId, OAUTH_CREDENTIALS.clientId, 'other fields survive the rotation write');
  assert.equal(afterRotation.clientSecret, OAUTH_CREDENTIALS.clientSecret);

  await manager.getAccessToken(connection, ['scope-a']);
  assert.equal(mock.calls[1]!.body.get('refresh_token'), 'refresh-token-ROTATED', 'the rotated token is used next');
  assert.equal((await vault.get('g-2')).refreshToken, 'refresh-token-ROTATED', 'a response without refresh_token leaves the stored one intact');
});

test('missing refresh token requires re-authorization without any network call', async () => {
  const vault = await newVaultWith('g-2', { clientId: 'client-1' });
  const mock = createFetchMock(() => jsonResponse(200, {}));
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  await expectCredentialError(manager.getAccessToken({ id: 'g-2', provider: 'google-ads' }, ['s']), 'reauthorization_required');
  assert.equal(mock.calls.length, 0);
});

test('transient HTTP failures are retryable and never classified as re-login', async () => {
  const vault = await newVaultWith('g-2', OAUTH_CREDENTIALS);
  const mock = createFetchMock(() => jsonResponse(503, { error: 'internal_failure' }));
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  const error = await expectCredentialError(
    manager.getAccessToken({ id: 'g-2', provider: 'google-ads' }, ['scope-a']),
    'token_temporarily_unavailable',
  );
  assert.equal(error.retryable, true);
  assert.notEqual(error.code, 'reauthorization_required');
  assert.ok(!error.message.includes(OAUTH_CREDENTIALS.refreshToken!), 'errors must not leak the refresh token');

  const network = new TokenManager(vault, {
    fetch: (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  });
  const networkError = await expectCredentialError(
    network.getAccessToken({ id: 'g-2', provider: 'google-ads' }, ['scope-a']),
    'token_temporarily_unavailable',
  );
  assert.equal(networkError.retryable, true);
});

test('invalid_grant marks the connection as needing re-authorization, without leaking secrets', async () => {
  const vault = await newVaultWith('g-2', OAUTH_CREDENTIALS);
  const mock = createFetchMock(() => jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' }));
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  const error = await expectCredentialError(
    manager.getAccessToken({ id: 'g-2', provider: 'google-play' }, ['scope-a']),
    'reauthorization_required',
  );
  assert.ok(!error.message.includes(OAUTH_CREDENTIALS.refreshToken!));
  assert.ok(!error.message.includes(OAUTH_CREDENTIALS.clientSecret!));
});

// ---------------------------------------------------------------------------
// TokenManager — Apple and API-key providers
// ---------------------------------------------------------------------------

test('Apple connections yield a short-lived, verifiable ES256 JWT that is cached', async () => {
  const vault = await newVaultWith('a-1', { keyId: 'KEY123', issuerId: 'issuer-uuid', privateKey: ecPair.privateKey });
  const mock = createFetchMock(() => jsonResponse(500, {}));
  const manager = new TokenManager(vault, { fetch: mock.fetch });
  const connection = { id: 'a-1', provider: 'app-store' as const };

  const token = await manager.getAccessToken(connection);
  assert.equal(mock.calls.length, 0, 'Apple tokens are minted locally, no HTTP');
  const { header, payload } = verifyAppleJwt(token, ecPair.publicKey);
  assert.equal(header.kid, 'KEY123');
  assert.equal(payload.iss, 'issuer-uuid');
  assert.equal(payload.aud, 'appstoreconnect-v1');
  const lifetime = (payload.exp as number) - (payload.iat as number);
  assert.ok(lifetime > 0 && lifetime <= 20 * 60, `lifetime ${lifetime}s must stay within Apple's 20 minute limit`);

  assert.equal(await manager.getAccessToken(connection), token, 'the JWT is cached until near expiry');

  const tampered = `${token.slice(0, token.lastIndexOf('.') + 1)}${Buffer.alloc(64, 1).toString('base64url')}`;
  assert.throws(() => verifyAppleJwt(tampered, ecPair.publicKey), (error: unknown) => (error as CredentialError).code === 'jwt_invalid');
});

test('createAppleJwt fails closed on missing fields, foreign key types, and oversized lifetimes', () => {
  assert.throws(
    () => createAppleJwt({ keyId: '', issuerId: 'i', privateKey: ecPair.privateKey }),
    (error: unknown) => (error as CredentialError).code === 'invalid_credentials',
  );
  assert.throws(
    () => createAppleJwt({ keyId: 'k', issuerId: 'i', privateKey: rsaPair.privateKey }),
    (error: unknown) => (error as CredentialError).code === 'invalid_credentials',
  );
  assert.throws(
    () => createAppleJwt({ keyId: 'k', issuerId: 'i', privateKey: ecPair.privateKey, lifetimeSeconds: 3600 }),
    (error: unknown) => (error as CredentialError).code === 'invalid_credentials',
  );
});

test('API-key providers read the key from the vault and fail on missing fields', async () => {
  const vault = await newVaultWith('s-1', { apiKey: 'steam-partner-key' });
  const manager = new TokenManager(vault, { fetch: createFetchMock(() => jsonResponse(500, {})).fetch });
  assert.equal(await manager.getAccessToken({ id: 's-1', provider: 'steam' }), 'steam-partner-key');

  await vault.set('s-2', { label: 'no key here' });
  await expectCredentialError(manager.getAccessToken({ id: 's-2', provider: 'applovin-max' }), 'invalid_credentials');
});

// ---------------------------------------------------------------------------
// GoogleOAuthBroker — PKCE, state, TTL, redirect validation
// ---------------------------------------------------------------------------

test('broker builds a PKCE authorization URL and the exchange proves the verifier', async () => {
  const mock = createFetchMock(() =>
    jsonResponse(200, { access_token: 'ignored', refresh_token: 'refresh-NEW', expires_in: 3599, scope: 'scope-a scope-b' }),
  );
  const broker = new GoogleOAuthBroker({ fetch: mock.fetch });
  const begun = broker.begin({
    clientId: 'client-1',
    clientSecret: 'secret-1',
    redirectUri: 'http://127.0.0.1:43111/oauth/callback',
    scopes: ['scope-a', 'scope-b'],
  });

  const url = new URL(begun.authorizationUrl);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), begun.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  const challenge = url.searchParams.get('code_challenge')!;

  const credentials = await broker.complete({ state: begun.state, code: 'auth-code-1' });
  assert.equal(mock.calls[0]!.url, GOOGLE_TOKEN_ENDPOINT);
  const body = mock.calls[0]!.body;
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'auth-code-1');
  assert.equal(body.get('redirect_uri'), 'http://127.0.0.1:43111/oauth/callback');
  const verifier = body.get('code_verifier')!;
  assert.equal(createHash('sha256').update(verifier, 'ascii').digest('base64url'), challenge, 'S256(verifier) must equal the challenge');
  assert.deepEqual(credentials, {
    clientId: 'client-1',
    refreshToken: 'refresh-NEW',
    clientSecret: 'secret-1',
    grantedScopes: 'scope-a scope-b',
  });
});

test('broker state is strictly single-use and unknown states are rejected', async () => {
  const mock = createFetchMock(() => jsonResponse(200, { access_token: 'x', refresh_token: 'r', expires_in: 3600 }));
  const broker = new GoogleOAuthBroker({ fetch: mock.fetch });
  const begun = broker.begin({ clientId: 'c', redirectUri: 'http://localhost:8080/cb', scopes: ['s'] });

  await broker.complete({ state: begun.state, code: 'code-1' });
  await expectCredentialError(broker.complete({ state: begun.state, code: 'code-1' }), 'oauth_state_invalid');
  await expectCredentialError(broker.complete({ state: 'never-issued', code: 'code-1' }), 'oauth_state_invalid');
  assert.equal(mock.calls.length, 1, 'a replayed state must not reach the token endpoint');
});

test('broker states expire after their TTL', async () => {
  let now = 1_000_000;
  const mock = createFetchMock(() => jsonResponse(200, { access_token: 'x', refresh_token: 'r' }));
  const broker = new GoogleOAuthBroker({ fetch: mock.fetch, now: () => now });
  const begun = broker.begin({ clientId: 'c', redirectUri: 'http://localhost:1234/cb', scopes: ['s'] });
  now += 11 * 60 * 1000;
  await expectCredentialError(broker.complete({ state: begun.state, code: 'code-1' }), 'oauth_state_expired');
  assert.equal(mock.calls.length, 0);
});

test('broker only accepts loopback redirect URIs and requires scopes', () => {
  const broker = new GoogleOAuthBroker();
  for (const redirectUri of ['https://example.com/cb', 'http://192.168.0.10/cb', 'myapp://callback', 'not a url']) {
    assert.throws(
      () => broker.begin({ clientId: 'c', redirectUri, scopes: ['s'] }),
      (error: unknown) => (error as CredentialError).code === 'invalid_redirect_uri',
      `redirect ${redirectUri} must be rejected`,
    );
  }
  assert.throws(
    () => broker.begin({ clientId: 'c', redirectUri: 'http://localhost:1/cb', scopes: [] }),
    (error: unknown) => (error as CredentialError).code === 'invalid_oauth_input',
  );
  for (const redirectUri of ['http://localhost:8080/cb', 'http://127.0.0.1:9/cb', 'http://[::1]:7777/cb']) {
    const begun = broker.begin({ clientId: 'c', redirectUri, scopes: ['s'] });
    assert.ok(begun.state.length >= 32);
  }
});

test('broker failures keep authorization codes and secrets out of error messages', async () => {
  const mock = createFetchMock(() => jsonResponse(500, { error: 'backend_error' }));
  const broker = new GoogleOAuthBroker({ fetch: mock.fetch });
  const begun = broker.begin({ clientId: 'c', clientSecret: 'SECRET-XYZ', redirectUri: 'http://localhost:5/cb', scopes: ['s'] });
  const error = await expectCredentialError(
    broker.complete({ state: begun.state, code: 'SECRET-AUTH-CODE' }),
    'token_temporarily_unavailable',
  );
  assert.ok(!error.message.includes('SECRET-AUTH-CODE'));
  assert.ok(!error.message.includes('SECRET-XYZ'));

  const noRefresh = createFetchMock(() => jsonResponse(200, { access_token: 'only-access' }));
  const broker2 = new GoogleOAuthBroker({ fetch: noRefresh.fetch });
  const begun2 = broker2.begin({ clientId: 'c', redirectUri: 'http://localhost:5/cb', scopes: ['s'] });
  await expectCredentialError(broker2.complete({ state: begun2.state, code: 'code' }), 'oauth_exchange_incomplete');
});
