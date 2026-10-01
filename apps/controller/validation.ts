import { relative, isAbsolute, resolve } from 'node:path';
import { AppError, object, text } from '../../packages/domain/errors.js';
import { PROVIDERS, type Provider } from '../../packages/domain/index.js';

export function providerValue(value: unknown): Provider {
  if (!PROVIDERS.includes(value as Provider)) throw new AppError('INVALID_PROVIDER', '지원하는 서비스를 선택해 주세요.');
  return value as Provider;
}
export { targetValue } from '../../packages/domain/validation.js';
export function credentialValues(input: unknown): Record<string, string> {
  const data = object(input); const result: Record<string, string> = {};
  if (Object.keys(data).length > 40) throw new AppError('INVALID_CREDENTIALS', '입력 항목이 너무 많습니다.');
  for (const [key, value] of Object.entries(data)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(key) || typeof value !== 'string' || value.length > 500_000 || value.includes('\0')) {
      throw new AppError('INVALID_CREDENTIALS', '연결 정보 형식을 확인해 주세요.');
    }
    if (value.trim()) result[key] = value.trim();
  }
  return result;
}
export function within(root: string, child: string): boolean {
  const value = relative(resolve(root), resolve(child));
  return value === '' || (value !== '..' && !value.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(value));
}
export { enforcePolicy, policyValue } from './policy.js';
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const value = error as { code?: string; message?: string; retryable?: boolean };
  const messages: Record<string, [string, string, number]> = {
    vault_locked: ['VAULT_LOCKED', 'OS 보관함이 잠겨 있습니다. 보관함을 열면 저장된 연결로 계속합니다.', 423],
    vault_unavailable: ['VAULT_UNAVAILABLE', 'OS 보관함을 사용할 수 없습니다. 보관함 서비스 상태를 확인해 주세요.', 503],
    master_key_missing: ['KEY_MISSING', '암호문을 여는 보관함 키를 찾지 못했습니다. 기존 키 복원이 필요합니다.', 409],
    reauthorization_required: ['AUTH_REVOKED', '서비스가 저장된 연결 권한을 철회했습니다. 이 계정만 다시 연결해 주세요.', 401],
    credential_not_found: ['AUTH_REQUIRED', '저장된 연결 정보가 없습니다. 계정 연결을 복구해 주세요.', 401],
    token_temporarily_unavailable: ['TEMPORARY', '인증 서비스가 일시적으로 응답하지 않습니다. 자동으로 다시 확인합니다.', 503],
    invalid_credentials: ['INVALID_CREDENTIALS', '서비스 연결 정보의 필수 항목이나 형식을 확인해 주세요.', 400],
  };
  const mapped = value.code ? messages[value.code] : undefined;
  if (mapped) return new AppError(...mapped);
  if (value.retryable) return new AppError('TEMPORARY', '서비스가 일시적으로 응답하지 않습니다.', 503);
  if (value.code?.startsWith('oauth_')) return new AppError('OAUTH_FAILED', '인증 요청이 만료되었거나 완료되지 않았습니다. 계정 연결을 다시 시작해 주세요.');
  return new AppError(value.code ?? 'INTERNAL_ERROR', '작업을 처리할 수 없습니다. 이력의 상태와 환경을 확인해 주세요.', 500);
}
