import { AppError, object, text } from '../../packages/domain/errors.js';
import type { AutomationPolicy, Connection, Project } from '../../packages/domain/index.js';
import { isWriteOperation } from '../../packages/domain/operations.js';
import { parseMicros } from '../../packages/metrics/index.js';

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
