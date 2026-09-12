import { createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto';

import { CredentialError } from './errors.js';

export const APPLE_JWT_AUDIENCE = 'appstoreconnect-v1';
// App Store Connect rejects tokens valid for longer than 20 minutes.
const MAX_LIFETIME_SECONDS = 20 * 60;
const DEFAULT_LIFETIME_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CredentialError('jwt_invalid', 'JWT segment is not valid base64url-encoded JSON');
  }
}

export interface AppleJwtInput {
  keyId: string;
  issuerId: string;
  privateKey: string;
  lifetimeSeconds?: number;
  nowSeconds?: number;
}

export interface AppleJwt {
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export function createAppleJwt(input: AppleJwtInput): AppleJwt {
  for (const field of ['keyId', 'issuerId', 'privateKey'] as const) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new CredentialError('invalid_credentials', `Apple credentials are missing the required field "${field}"`);
    }
  }
  const lifetime = input.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > MAX_LIFETIME_SECONDS) {
    throw new CredentialError('invalid_credentials', `Apple JWT lifetime must be between 1 and ${MAX_LIFETIME_SECONDS} seconds`);
  }
  let keyObject;
  try {
    keyObject = createPrivateKey(input.privateKey);
  } catch {
    throw new CredentialError('invalid_credentials', 'Apple privateKey is not a readable PEM-encoded private key');
  }
  if (keyObject.asymmetricKeyType !== 'ec' || keyObject.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new CredentialError('invalid_credentials', 'Apple API keys must be EC keys on the P-256 curve for ES256');
  }
  const issuedAt = Math.floor(input.nowSeconds ?? Date.now() / 1000);
  const expiresAt = issuedAt + Math.floor(lifetime);
  const header = { alg: 'ES256', kid: input.keyId, typ: 'JWT' };
  const payload = { iss: input.issuerId, iat: issuedAt, exp: expiresAt, aud: APPLE_JWT_AUDIENCE };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: keyObject, dsaEncoding: 'ieee-p1363' });
  return { token: `${signingInput}.${signature.toString('base64url')}`, issuedAt, expiresAt };
}

export interface VerifiedAppleJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export function verifyAppleJwt(token: string, publicKeyPem: string, options?: { nowSeconds?: number }): VerifiedAppleJwt {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new CredentialError('jwt_invalid', 'a JWT must consist of three dot-separated segments');
  }
  const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
  const header = decodeJsonSegment(headerSegment);
  const payload = decodeJsonSegment(payloadSegment);
  if (header.alg !== 'ES256') {
    throw new CredentialError('jwt_invalid', 'Apple JWTs must be signed with ES256');
  }
  let valid = false;
  try {
    valid = createVerify('SHA256')
      .update(`${headerSegment}.${payloadSegment}`)
      .verify({ key: createPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureSegment, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new CredentialError('jwt_invalid', 'Apple JWT signature verification failed');
  }
  const now = Math.floor(options?.nowSeconds ?? Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw new CredentialError('jwt_invalid', 'Apple JWT is expired or has no expiry');
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + CLOCK_SKEW_SECONDS) {
    throw new CredentialError('jwt_invalid', 'Apple JWT issued-at time is in the future');
  }
  if (payload.aud !== APPLE_JWT_AUDIENCE) {
    throw new CredentialError('jwt_invalid', `Apple JWT audience must be "${APPLE_JWT_AUDIENCE}"`);
  }
  return { header, payload };
}
