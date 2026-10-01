import { AppError } from '../domain/errors.js';
import type { ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { headerAuth, moneyToMicros } from './marketing-utils.js';

const MANAGE = 'https://api.ads.axon.ai/manage/v1';
export function accountId(ctx: ConnectorContext): string {
  const id = ctx.credentials.accountId || ctx.connection.accountId;
  if (!id || !/^\d+$/.test(id)) throw new AppError('INVALID_INPUT', 'AppLovin Ads account_id 가 필요합니다.');
  return id;
}

function campaignKey(ctx: ConnectorContext): string {
  const key = ctx.credentials.campaignManagementKey || ctx.credentials.apiKey;
  if (!key) throw new AppError('AUTH_REQUIRED', 'Campaign Management API 키를 연결하세요. MAX Management Key와 다릅니다.');
  return key;
}

export function auth(ctx: ConnectorContext): Record<string, string> {
  return headerAuth('raw', campaignKey(ctx));
}

export function manageUrl(path: string, ctx: ConnectorContext, extra?: Record<string, string>): string {
  const query = new URLSearchParams({ account_id: accountId(ctx), ...extra });
  return `${MANAGE}${path}?${query}`;
}

function campaignResource(item: Record<string, unknown>): ResourceInput {
  const budget = (item.budget ?? {}) as Record<string, unknown>;
  const daily = budget.daily_budget_for_all_countries;
  const dailyMicros = daily != null ? moneyToMicros(String(daily), '일일 예산') : undefined;
  return {
    kind: 'campaign',
    externalId: String(item.id ?? ''),
    name: String(item.name ?? item.id ?? ''),
    status: String(item.status ?? 'UNKNOWN'),
    data: {
      hashedId: item.hashed_id,
      platform: item.platform,
      packageName: item.package_name,
      itunesId: item.itunes_id,
      type: item.type,
      biddingStrategy: item.bidding_strategy,
      dailyBudget: daily,
      dailyBudgetMicros: dailyMicros ?? '0',
      currency: 'USD',
      targeting: item.targeting,
      startDate: item.start_date,
      appIdentifier: typeof item.package_name === 'string' ? item.package_name : (item.itunes_id != null ? String(item.itunes_id) : undefined),
    },
  };
}

export async function listCampaigns(ctx: ConnectorContext, ids?: string): Promise<ConnectorResult> {
  const resources: ResourceInput[] = [];
  for (let page = 1; page <= 50; page++) {
    const extra: Record<string, string> = { page: String(page), size: '100' };
    if (ids) extra.ids = ids;
    const rows = await ctx.request<unknown>(manageUrl('/campaign/list', ctx, extra), { headers: auth(ctx) });
    if (!Array.isArray(rows)) throw new AppError('INVALID_PROVIDER_RESPONSE', '캠페인 목록 응답이 배열이 아닙니다.');
    for (const row of rows) {
      if (row && typeof row === 'object') resources.push(campaignResource(row as Record<string, unknown>));
    }
    if (ids || rows.length < 100) break;
    if (page === 50) throw new AppError('PAGINATION_LIMIT', '캠페인 전체 목록을 가져오지 못했습니다. 이전 목록을 보존합니다.');
  }
  return { resources, ...(!ids ? { resourceSnapshots: [{ kind: 'campaign' as const }] } : {}), summary: { accountId: accountId(ctx), campaignCount: resources.length } };
}

export async function readCampaign(ctx: ConnectorContext, id: string): Promise<ResourceInput> {
  const listed = await listCampaigns(ctx, id);
  const resource = listed.resources?.find(item => item.externalId === id);
  if (!resource) throw new AppError('RESOURCE_NOT_FOUND', '캠페인을 다시 조회할 수 없습니다.');
  return resource;
}
