import type { Connection, ExternalResource, Project, Run } from '../../packages/domain/index.js';
import { AppError, canonical } from '../../packages/domain/errors.js';
import { parseMicros } from '../../packages/metrics/index.js';

/** Reserve configured budgets (including paused campaigns) across every account of a project. */
export function enforceCampaignBudget(project: Project | undefined, connection: Connection, operation: string,
  input: Record<string, unknown>, resources: ExternalResource[], pending: Run[], currentRunId?: string): void {
  if (!project || !['create-campaign', 'update-campaign', 'pause-campaign'].includes(operation)) return;
  const selected = operation !== 'create-campaign' ? resources.find(item => item.kind === 'campaign' && item.connectionId === connection.id && item.externalId === input.externalId) : undefined;
  if (operation !== 'create-campaign') {
    if (!selected) throw new AppError('RESOURCE_SYNC_REQUIRED', '캠페인을 먼저 동기화한 뒤 변경해 주세요.');
    const identifier = selected.data.appIdentifier ?? selected.data.packageName ?? selected.data.bundleId ?? selected.data.appId;
    if (!selected.projectId) throw new AppError('RESOURCE_SYNC_REQUIRED', '캠페인을 동기화하고 해당 앱과 유일하게 연결된 프로젝트를 확인해 주세요.');
    if (selected.projectId !== project.id || (identifier && identifier !== project.appIdentifier)) {
      throw new AppError('RESOURCE_MISMATCH', '선택한 프로젝트에 속하는 캠페인만 변경할 수 있습니다.');
    }
    // Pausing an existing campaign must remain possible even if a new policy lowered the limit.
    if (operation === 'pause-campaign' || (String(input.status).toUpperCase() === 'PAUSED' && input.dailyBudgetMicros === undefined)) return;
  }
  const amounts = new Map<string, bigint>();
  const put = (key: string, raw: unknown, currency: unknown, preserveLarger = false) => {
    if (raw === undefined) throw new AppError('BUDGET_UNKNOWN', '기존 캠페인의 일일 예산을 확인할 수 없습니다. 캠페인을 동기화해 주세요.');
    if (currency !== project.policy.currency) throw new AppError('CURRENCY_MISMATCH', '프로젝트 예산은 같은 통화의 캠페인만 합산할 수 있습니다.');
    const value = parseMicros(raw);
    if (value < 0n) throw new AppError('BUDGET_UNKNOWN', '캠페인 예산 응답이 올바르지 않습니다.');
    amounts.set(key, preserveLarger && (amounts.get(key) ?? 0n) > value ? amounts.get(key)! : value);
  };
  for (const resource of resources) {
    const identifier = resource.data.appIdentifier ?? resource.data.packageName ?? resource.data.bundleId ?? resource.data.appId;
    if (resource.kind !== 'campaign' || ['REMOVED', 'DELETED'].includes(resource.status) ||
        !(resource.projectId === project.id || (identifier && identifier === project.appIdentifier))) continue;
    put(resource.connectionId + ':' + resource.externalId, resource.data.dailyBudgetMicros, resource.data.currency);
  }
  for (const run of pending) {
    if (run.id === currentRunId || run.projectId !== project.id || !['create-campaign', 'update-campaign'].includes(run.kind)) continue;
    if (run.connectionId === connection.id && run.kind === operation && canonical(run.input) === canonical(input)) continue;
    if (run.input.dailyBudgetMicros === undefined) continue;
    const id = run.input.externalId ?? run.result?.externalId ?? 'pending-' + run.id;
    put(run.connectionId + ':' + id, run.input.dailyBudgetMicros, run.input.currency, true);
  }
  const candidateKey = connection.id + ':' + (selected?.externalId ?? 'new-campaign');
  put(candidateKey, input.dailyBudgetMicros ?? selected?.data.dailyBudgetMicros, input.currency ?? selected?.data.currency);
  const total = [...amounts.values()].reduce((sum, amount) => sum + amount, 0n);
  if (total > parseMicros(project.policy.maxDailyBudgetMicros)) {
    throw new AppError('BUDGET_LIMIT', '기존 캠페인과 대기 중인 변경을 합친 일일 설정 예산이 프로젝트 한도를 넘습니다.', 403);
  }
}
