import { relative, isAbsolute, resolve } from 'node:path';
import { AppError, object, text } from '../../packages/domain/errors.js';
import { PROVIDERS, type AutomationPolicy, type BuildTarget, type Connection, type Project, type Provider } from '../../packages/domain/index.js';
import { parseMicros } from '../../packages/metrics/index.js';
import { isWriteOperation } from '../../packages/connectors/types.js';

export function providerValue(value: unknown): Provider {
  if (!PROVIDERS.includes(value as Provider)) throw new AppError('INVALID_PROVIDER', '지원하는 서비스를 선택해 주세요.');
  return value as Provider;
}
export function targetValue(value: unknown): BuildTarget {
  if (!['android', 'ios', 'windows', 'macos', 'linux'].includes(String(value))) throw new AppError('INVALID_TARGET', '빌드 대상을 선택해 주세요.');
  return value as BuildTarget;
}
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
export function policyValue(input: unknown, connections: Connection[]): AutomationPolicy {
  const data = object(input);
  for (const key of ['autoBuild', 'autoRelease', 'allowCampaignWrites', 'allowMonetizationWrites']) {
    if (typeof data[key] !== 'boolean') throw new AppError('INVALID_POLICY', '자동화 정책의 켜짐/꺼짐을 확인해 주세요.');
  }
  if (!Array.isArray(data.allowedConnectionIds) || data.allowedConnectionIds.some(id => typeof id !== 'string' || !connections.some(c => c.id === id))) {
    throw new AppError('INVALID_POLICY', '현재 연결된 계정만 자동화에 허용할 수 있습니다.');
  }
  const budget = parseMicros(data.maxDailyBudgetMicros);
  if (budget < 0n || budget > 1_000_000_000_000_000n) throw new AppError('INVALID_POLICY', '일일 광고 예산 한도를 확인해 주세요.');
  const currency = text(data.currency, '정책 통화', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError('INVALID_POLICY', '통화 코드를 확인해 주세요.');
  return { autoBuild: data.autoBuild as boolean, autoRelease: data.autoRelease as boolean,
    allowCampaignWrites: data.allowCampaignWrites as boolean, allowMonetizationWrites: data.allowMonetizationWrites as boolean,
    allowedConnectionIds: [...new Set(data.allowedConnectionIds as string[])], maxDailyBudgetMicros: budget.toString(), currency };
}
export function enforcePolicy(project: Project | undefined, connection: Connection, operation: string, input: Record<string, unknown>): void {
  if (!isWriteOperation(operation, connection.provider)) return;
  if (!project) throw new AppError('PROJECT_REQUIRED', '외부 변경을 적용할 프로젝트를 선택해 주세요.');
  // SocialAutomation enforces the dedicated saved channel policy and aggregate posting limits.
  if (operation === 'create-post' || operation === 'reply') return;
  const policy = project.policy;
  if (!policy.allowedConnectionIds.includes(connection.id)) throw new AppError('POLICY_DENIED', '프로젝트 정책에서 이 계정의 자동화를 허용해 주세요.', 403);
  if (operation === 'upload-build' && !policy.autoRelease) throw new AppError('POLICY_DENIED', '프로젝트 정책에서 배포를 허용해 주세요.', 403);
  if (['google-ads','applovin-ads'].includes(connection.provider) && !policy.allowCampaignWrites) throw new AppError('POLICY_DENIED', '프로젝트 정책에서 광고 변경을 허용해 주세요.', 403);
  if (operation.includes('campaign')) {
    if (!policy.allowCampaignWrites) throw new AppError('POLICY_DENIED', '프로젝트 정책에서 캠페인 변경을 허용해 주세요.', 403);
    if (input.dailyBudgetMicros !== undefined) {
      const amount = parseMicros(input.dailyBudgetMicros);
      if (amount <= 0n || amount > parseMicros(policy.maxDailyBudgetMicros)) throw new AppError('BUDGET_LIMIT', '일일 광고 예산이 프로젝트의 허용 한도를 넘습니다.', 403);
      if (String(input.currency ?? '').toUpperCase() !== policy.currency) throw new AppError('CURRENCY_MISMATCH', '캠페인 통화와 정책 통화가 일치해야 합니다.');
    }
    if (operation === 'create-campaign' && input.dailyBudgetMicros === undefined) throw new AppError('BUDGET_REQUIRED', '캠페인 일일 예산이 필요합니다.');
  }
  if ((operation.includes('product') || operation.includes('ad-unit')) && !policy.allowMonetizationWrites) {
    throw new AppError('POLICY_DENIED', '프로젝트 정책에서 수익화 설정 변경을 허용해 주세요.', 403);
  }
}
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
