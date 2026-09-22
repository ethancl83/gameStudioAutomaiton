import type { BuildCredential } from '../domain/index.js';
import { AppError, object, prohibitSecrets } from '../domain/errors.js';
import type { BuildKeyReference, BuildSecuritySelection } from './index.js';

export const KEY_HELPER_IMAGE = 'appops-linux-runner:local';
export const KEY_HELPER_INPUT_LIMIT = 16 * 1024 * 1024;
export const KEY_HELPER_OUTPUT_LIMIT = 64 * 1024;
export const KEY_HELPER_LABEL = 'appops.trusted-key';
export type CredentialMetadata = { fingerprint: string; publicKey?: string; details: Record<string, string> };
export type SignatureMetadata = { fingerprint: string; keyId: string; version: number; format: string };
export type DependencyMetadata = { path: string; commit: string; hash: string; key: BuildKeyReference };
export type KeyHelperRequest =
  | { operation: 'validate'; kind: BuildCredential['kind']; credentials: Record<string, string> }
  | { operation: 'sign'; reference: BuildKeyReference; format: 'aab' | 'apk'; credentials: Record<string, string> }
  | { operation: 'fetch'; dependency: BuildSecuritySelection['sshDependencies'][number]; credentials: Record<string, string> };
export type KeyHelperMetadata = CredentialMetadata | SignatureMetadata | DependencyMetadata;

// Error messages, stderr, tool output, and arbitrary result properties never cross this boundary.
const ERROR_CODES = new Set(['INVALID_INPUT', 'INVALID_BUILD_CREDENTIAL', 'KEY_RUNTIME_UNAVAILABLE', 'ISOLATION_UNAVAILABLE',
  'KEY_TOOL_FAILED', 'KEY_TOOL_TIMEOUT', 'CANCELLED', 'SIGNING_TOOL_REQUIRED', 'SIGNING_FORMAT_UNSUPPORTED', 'SIGNATURE_MISMATCH',
  'SIGNATURE_INVALID', 'ARTIFACT_ESCAPE', 'DEPENDENCY_PATH_ESCAPE', 'DEPENDENCY_PATH_EXISTS', 'DEPENDENCY_REVISION_INVALID',
  'INVALID_TOOL_ROOT', 'INVALID_TOOL_SCRIPT', 'BUILD_KEY_NOT_FOUND', 'DOCKER_KEY_PROTOCOL']);
export function helperErrorCode(error: unknown): string {
  return error instanceof AppError && ERROR_CODES.has(error.code) ? error.code : 'KEY_TOOL_FAILED';
}
export function protocolError(): never { throw new AppError('DOCKER_KEY_PROTOCOL', '키 헬퍼 응답 형식이 올바르지 않습니다.'); }
export function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) protocolError();
}
export function boundedString(value: unknown, maximum = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value);
}
export function keyReference(value: unknown): BuildKeyReference {
  const data = object(value); exactKeys(data, ['id', 'version', 'fingerprint']);
  if (!boundedString(data.id, 100) || !Number.isSafeInteger(data.version) || Number(data.version) < 1 || !boundedString(data.fingerprint, 200)) protocolError();
  return data as unknown as BuildKeyReference;
}
export function sameReference(left: BuildKeyReference, right: BuildKeyReference): boolean {
  return left.id === right.id && left.version === right.version && left.fingerprint === right.fingerprint;
}
export function parseHelperResponse(output: string, request: KeyHelperRequest, exitCode: number | null): KeyHelperMetadata {
  if (Buffer.byteLength(output) > KEY_HELPER_OUTPUT_LIMIT) protocolError();
  let raw: unknown; try { raw = JSON.parse(output); } catch { return protocolError(); }
  // Defense in depth alongside the operation-specific exact schema below.
  try { prohibitSecrets(raw); } catch { return protocolError(); }
  const envelope = object(raw);
  if (envelope.ok === false) {
    exactKeys(envelope, ['ok', 'code']);
    if (typeof envelope.code !== 'string' || !ERROR_CODES.has(envelope.code) || exitCode === 0) protocolError();
    throw new AppError(envelope.code, '키 헬퍼 작업에 실패했습니다. 키·암호·도구 설정을 확인해 주세요.');
  }
  exactKeys(envelope, ['ok', 'result']);
  if (envelope.ok !== true || exitCode !== 0) protocolError();
  const result = object(envelope.result);
  if (request.operation === 'validate') {
    exactKeys(result, ['fingerprint', 'details'], request.kind === 'ssh' ? ['publicKey'] : []);
    if (!boundedString(result.fingerprint, 200)) protocolError();
    const details = object(result.details);
    if (request.kind === 'ssh') {
      exactKeys(details, ['host', 'port', 'username', 'algorithm']);
      if (details.host !== request.credentials.host || details.port !== request.credentials.port || details.username !== request.credentials.username ||
        !boundedString(result.publicKey, 16_384) || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}$/.test(result.publicKey) ||
        details.algorithm !== result.publicKey.split(' ')[0] || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(result.fingerprint)) protocolError();
    } else {
      exactKeys(details, ['keyAlias', 'expiresAt', 'algorithm']);
      if (details.keyAlias !== request.credentials.keyAlias || !boundedString(details.algorithm, 32) || !['rsa', 'rsa-pss', 'dsa', 'ec', 'ed25519', 'ed448', 'unknown'].includes(details.algorithm) ||
        !boundedString(details.expiresAt, 30) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(details.expiresAt) || !Number.isFinite(Date.parse(details.expiresAt)) || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(result.fingerprint)) protocolError();
    }
    return result as CredentialMetadata;
  }
  if (request.operation === 'sign') {
    exactKeys(result, ['fingerprint', 'keyId', 'version', 'format']);
    if (result.fingerprint !== request.reference.fingerprint || result.keyId !== request.reference.id ||
      result.version !== request.reference.version || result.format !== request.format) protocolError();
    return result as SignatureMetadata;
  }
  exactKeys(result, ['path', 'commit', 'hash', 'key']);
  if (result.path !== request.dependency.relativePath || !boundedString(result.commit, 64) || !/^[a-f0-9]{40,64}$/.test(result.commit) ||
    !boundedString(result.hash, 64) || !/^[a-f0-9]{64}$/.test(result.hash) || !sameReference(keyReference(result.key), request.dependency.key)) protocolError();
  return result as DependencyMetadata;
}
