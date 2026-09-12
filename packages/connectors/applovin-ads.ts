import { AppError, text } from '../domain/errors.js';
import type { Connector, ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { countryCode, currencyCode, daysAgo, headerAuth, isoDate, microsString, microsToDecimal, moneyToMicros, ymd } from './marketing-utils.js';

const MANAGE = 'https://api.ads.axon.ai/manage/v1';
const REPORT = 'https://r.applovin.com/report';

function accountId(ctx: ConnectorContext): string {
  const id = ctx.credentials.accountId || ctx.connection.accountId;
  if (!id || !/^\d+$/.test(id)) throw new AppError('INVALID_INPUT', 'AppLovin Ads account_id 가 필요합니다.');
  return id;
}

function campaignKey(ctx: ConnectorContext): string {
  const key = ctx.credentials.campaignManagementKey || ctx.credentials.apiKey;
  if (!key) throw new AppError('AUTH_REQUIRED', 'Campaign Management API 키를 연결하세요. MAX Management Key와 다릅니다.');
  return key;
}

function reportKey(ctx: ConnectorContext): string {
  const key = ctx.credentials.reportKey;
  if (!key) throw new AppError('AUTH_REQUIRED', '광고 보고용 Report Key가 필요합니다. Campaign Management 키와 별개입니다.');
  return key;
}

function auth(ctx: ConnectorContext): Record<string, string> {
  return headerAuth('raw', campaignKey(ctx));
}

function manageUrl(path: string, ctx: ConnectorContext, extra?: Record<string, string>): string {
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

async function listCampaigns(ctx: ConnectorContext, ids?: string): Promise<ConnectorResult> {
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

async function readCampaign(ctx: ConnectorContext, id: string): Promise<ResourceInput> {
  const listed = await listCampaigns(ctx, id);
  const resource = listed.resources?.find(item => item.externalId === id);
  if (!resource) throw new AppError('RESOURCE_NOT_FOUND', '캠페인을 다시 조회할 수 없습니다.');
  return resource;
}

const TRACKING_METHODS = ['ADJUST', 'APPSFLYER', 'APSALAR', 'BRANCH', 'KOCHAVA', 'TENJIN'] as const;
const BIDDING = ['TARGET_GOAL_WITH_CPI_BILLING', 'AUTO_BIDDING_WITH_CPM_BILLING'] as const;
const GOAL_TYPES = ['CPI', 'CPE', 'CPP', 'AD_ROAS', 'CHK_ROAS', 'BLD_ROAS'] as const;

function httpsUrl(value: unknown, label: string): string {
  const raw = text(value, label, 2000);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new AppError('INVALID_INPUT', `${label}는 https URL이어야 합니다.`); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new AppError('INVALID_INPUT', `${label}는 인증 정보 없는 https URL이어야 합니다.`);
  }
  return raw;
}

function campaignStatus(value: unknown): 'LIVE' | 'PAUSED' {
  const status = text(value, '상태', 16).toUpperCase();
  if (status === 'ACTIVE') return 'LIVE';
  if (status !== 'LIVE' && status !== 'PAUSED') throw new AppError('INVALID_INPUT', '캠페인 상태는 LIVE 또는 PAUSED만 허용합니다.');
  return status as 'LIVE' | 'PAUSED';
}

async function createCampaign(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  // Official /campaign/create ignores `status` (Create column = Ignored).
  // Do not send status and do not follow with a non-atomic pause.
  // Activation must be the explicit user field LIVE.
  const activation = campaignStatus(input.activation ?? input.status);
  if (activation !== 'LIVE') {
    throw new AppError('UNSUPPORTED_OPERATION', 'AppLovin /campaign/create는 status를 무시합니다. PAUSED 초안 생성은 원자적으로 보장되지 않아 허용하지 않습니다. 활성(LIVE)을 명시하거나 기존 캠페인을 중지하십시오.');
  }
  const name = text(input.name, '캠페인 이름', 255);
  const platform = text(input.platform ?? ctx.credentials.platform ?? '', '플랫폼', 16).toUpperCase();
  if (platform !== 'ANDROID' && platform !== 'IOS') throw new AppError('INVALID_INPUT', 'platform은 ANDROID 또는 IOS 여야 합니다.');
  const pkg = text(input.packageName ?? ctx.project?.appIdentifier ?? ctx.credentials.packageName ?? '', '패키지 이름', 200);
  const itunesId = platform === 'IOS' ? text(input.itunesId ?? ctx.credentials.itunesId ?? '', 'iTunes ID', 32) : undefined;
  if (platform === 'IOS' && !/^\d{8,12}$/.test(itunesId ?? '')) throw new AppError('INVALID_INPUT', 'iOS 캠페인에는 itunes_id가 필요합니다.');
  const currency = currencyCode(input.currency ?? 'USD');
  if (currency !== 'USD') throw new AppError('CURRENCY_MISMATCH', 'AppLovin 예산은 USD입니다.');
  const daily = microsToDecimal(microsString(input.dailyBudgetMicros, '일일 예산'));
  const countries = input.country === undefined ? [] : Array.isArray(input.country) ? input.country : [input.country];
  if (!countries.length) throw new AppError('INVALID_INPUT', '타깃 국가가 필요합니다.');
  const targeting = [...new Set(countries.map(value => countryCode(value)))].map(country_code => ({ country_code }));
  const bidding = text(input.biddingStrategy ?? 'TARGET_GOAL_WITH_CPI_BILLING', '입찰 전략', 64).toUpperCase();
  if (!BIDDING.includes(bidding as typeof BIDDING[number])) throw new AppError('INVALID_INPUT', '입찰 전략은 TARGET_GOAL_WITH_CPI_BILLING 또는 AUTO_BIDDING_WITH_CPM_BILLING 입니다.');
  const goalType = text(input.goalType ?? 'CPI', '목표 유형', 16).toUpperCase();
  if (!GOAL_TYPES.includes(goalType as typeof GOAL_TYPES[number])) throw new AppError('INVALID_INPUT', '지원 goal_type은 CPI, CPE, CPP, AD_ROAS, CHK_ROAS, BLD_ROAS 입니다.');
  const goalValue = text(input.goalValue, '목표 값', 32);
  if (!/^\d+(?:\.\d+)?$/.test(goalValue)) throw new AppError('INVALID_AMOUNT', '목표 값은 십진 숫자여야 합니다.');
  const trackingMethod = text(input.trackingMethod ?? ctx.credentials.trackingMethod ?? '', '트래킹 방법', 32).toUpperCase();
  if (!TRACKING_METHODS.includes(trackingMethod as typeof TRACKING_METHODS[number])) {
    throw new AppError('INVALID_INPUT', 'trackingMethod는 ADJUST, APPSFLYER, APSALAR, BRANCH, KOCHAVA, TENJIN 중 하나여야 합니다.');
  }
  const startDate = isoDate(input.startDate ?? ymd(), '시작일').replace(/Z$/, '').replace(/\.\d+$/, '');
  const body: Record<string, unknown> = {
    name, type: 'APP', platform, package_name: pkg,
    start_date: startDate.includes('T') ? startDate : `${startDate}T00:00:00`,
    targeting,
    budget: { daily_budget_for_all_countries: daily },
    goal: { goal_value_for_all_countries: goalValue, goal_type: goalType },
    bidding_strategy: bidding,
    tracking: {
      tracking_method: trackingMethod,
      impression_url: httpsUrl(input.impressionUrl ?? ctx.credentials.impressionUrl, 'impression_url'),
      click_url: httpsUrl(input.clickUrl ?? ctx.credentials.clickUrl, 'click_url'),
    },
  };
  if (itunesId) body.itunes_id = Number(itunesId);
  if (goalType === 'CPE') body.goal = { ...body.goal as object, event_target: text(input.eventTarget, '이벤트 이름', 100) };
  if (goalType === 'AD_ROAS' || goalType === 'CHK_ROAS' || goalType === 'BLD_ROAS') {
    const day = text(input.roasDayTarget ?? 'DAY7', 'ROAS 일수', 8).toUpperCase();
    if (day !== 'DAY7' && day !== 'DAY28') throw new AppError('INVALID_INPUT', 'roas_day_target은 DAY7 또는 DAY28 입니다.');
    body.goal = { ...body.goal as object, roas_day_target: day };
  }
  if (typeof input.endDate === 'string' && input.endDate.trim()) body.end_date = isoDate(input.endDate, '종료일').replace(/Z$/, '');
  else body.is_continuous_delivery = true;
  const created = await ctx.request<Record<string, unknown>>(manageUrl('/campaign/create', ctx), {
    method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, json: body, write: true,
  });
  const id = String(created.id ?? '');
  if (!id) throw new AppError('INVALID_PROVIDER_RESPONSE', '생성된 캠페인 ID가 없습니다.');
  ctx.checkpoint({ externalId: id, activation: 'LIVE', statusIgnoredOnCreate: true });
  const resource = await readCampaign(ctx, id);
  return {
    resources: [resource],
    summary: {
      externalId: id,
      status: resource.status,
      activationRequested: 'LIVE',
      statusFieldOnCreate: 'ignored',
      note: '공식 create는 status를 무시합니다. 요청한 활성은 LIVE이며, 실제 상태는 재조회 값입니다. 생성 직후 pause를 자동 호출하지 않았습니다.',
    },
  };
}

async function updateCampaign(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const id = text(input.externalId, '캠페인 ID', 32);
  const current = await readCampaign(ctx, id);
  const body: Record<string, unknown> = { id, type: 'APP' };
  if (typeof input.name === 'string') body.name = text(input.name, '캠페인 이름', 255);
  if (typeof input.status === 'string') body.status = campaignStatus(input.status);
  if (input.dailyBudgetMicros != null) {
    const currency = currencyCode(input.currency ?? 'USD');
    if (currency !== 'USD') throw new AppError('CURRENCY_MISMATCH', 'AppLovin 예산은 USD입니다.');
    body.budget = { daily_budget_for_all_countries: microsToDecimal(microsString(input.dailyBudgetMicros, '일일 예산')) };
  }
  await ctx.request(manageUrl('/campaign/update', ctx), {
    method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, json: body, write: true,
  });
  ctx.checkpoint({ externalId: id });
  const resource = await readCampaign(ctx, id);
  const data = { ...current.data, ...resource.data };
  if (body.budget) data.dailyBudgetMicros = microsString(input.dailyBudgetMicros, '일일 예산');
  data.currency = 'USD';
  return {
    summary: { externalId: id, updated: true, status: resource.status, dailyBudgetMicros: data.dailyBudgetMicros, currency: 'USD' },
    resources: [{ ...resource, name: String(body.name ?? resource.name), status: String(body.status ?? resource.status), data }],
  };
}

async function spendMetrics(ctx: ConnectorContext): Promise<ConnectorResult> {
  const key = reportKey(ctx);
  const start = daysAgo(6);
  const end = ymd();
  const url = `${REPORT}?${new URLSearchParams({
    api_key: key, start, end, format: 'json', report_type: 'advertiser',
    columns: 'day,cost,campaign_id_external,campaign_package_name',
  })}`;
  const data = await ctx.request<unknown>(url, { headers: {}, write: false });
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : null);
  if (!rows) throw new AppError('INVALID_PROVIDER_RESPONSE', 'AppLovin 광고 보고 응답 형식을 확인할 수 없습니다.');
  const metrics = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const date = String(item.day ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || item.cost == null) continue;
    const campaign = item.campaign_id_external != null ? String(item.campaign_id_external) : 'account';
    const pkg = item.campaign_package_name != null ? String(item.campaign_package_name) : undefined;
    metrics.push({
      date, currency: 'USD', kind: 'spend' as const, amountMicros: moneyToMicros(item.cost, '광고비'),
      basis: 'estimated' as const, sourceId: `applovin-ads:spend:${campaign}:${date}`,
      appIdentifier: pkg,
    });
  }
  return { metrics, summary: { from: start, to: end, timeZone: 'UTC', currency: 'USD', rowCount: metrics.length } };
}

export const applovinAdsConnector: Connector = {
  capability: {
    provider: 'applovin-ads', name: 'AppLovin Ads', category: 'marketing',
    description: 'Axon Campaign Management API로 기존 캠페인을 수정하고, 명시한 LIVE 생성·광고 지출 조회를 수행합니다.',
    authKind: 'Campaign Management API 키 + 별도 Report Key',
    fields: [
      { key: 'accountId', label: 'AppLovin account_id', required: true, placeholder: '숫자 계정 ID' },
      { key: 'campaignManagementKey', label: 'Campaign Management API 키', secret: true, required: true },
      { key: 'reportKey', label: '광고 Reporting API Report Key', secret: true },
      { key: 'packageName', label: '기본 패키지 이름' },
      { key: 'itunesId', label: 'iOS iTunes ID' },
      { key: 'platform', label: '기본 플랫폼 (IOS 또는 ANDROID)' },
      { key: 'defaultCountry', label: '기본 타깃 국가', placeholder: 'US' },
      { key: 'trackingMethod', label: 'MMP tracking_method (예: APPSFLYER, ADJUST)' },
      { key: 'impressionUrl', label: 'impression_url', secret: false },
      { key: 'clickUrl', label: 'click_url' },
    ],
    operations: ['check', 'sync', 'list-campaigns', 'create-campaign', 'update-campaign', 'pause-campaign'],
    operationFields: {
      'create-campaign': [
        { key: 'name', type: 'text', required: true, label: '캠페인 이름' },
        { key: 'activation', type: 'select', required: true, label: '생성 시 활성', options: [{ value: 'LIVE', label: 'LIVE (생성 직후 집행 가능)' }], hint: '공식 create는 status를 무시합니다. PAUSED 초안은 원자적으로 만들 수 없어 LIVE만 명시합니다. 생성 후 자동 pause는 하지 않습니다.' },
        { key: 'dailyBudgetMicros', type: 'money', required: true, label: '일일 예산' },
        { key: 'currency', type: 'text', required: true, label: '통화', placeholder: 'USD', hint: 'USD만 허용합니다.' },
        { key: 'platform', type: 'select', required: true, label: '플랫폼', options: [{ value: 'ANDROID', label: 'ANDROID' }, { value: 'IOS', label: 'IOS' }] },
        { key: 'packageName', type: 'text', required: false, label: '패키지 이름', hint: '프로젝트 appIdentifier가 있으면 생략' },
        { key: 'itunesId', type: 'text', required: false, label: 'iTunes ID', hint: 'iOS만 필수' },
        { key: 'country', type: 'text', required: true, label: '타깃 국가', placeholder: 'US,KR' },
        { key: 'startDate', type: 'date', required: true, label: '시작일' },
        { key: 'biddingStrategy', type: 'select', required: true, label: '입찰 전략', options: [
          { value: 'TARGET_GOAL_WITH_CPI_BILLING', label: '목표 제어·설치 과금' },
          { value: 'AUTO_BIDDING_WITH_CPM_BILLING', label: '자동 입찰·노출 과금' },
        ] },
        { key: 'goalType', type: 'select', required: true, label: '목표 유형', options: [
          { value: 'CPI', label: 'CPI' }, { value: 'CPE', label: 'CPE' }, { value: 'CPP', label: 'CPP' },
          { value: 'AD_ROAS', label: 'AD_ROAS' }, { value: 'CHK_ROAS', label: 'IAP ROAS' }, { value: 'BLD_ROAS', label: 'Blended ROAS' },
        ] },
        { key: 'goalValue', type: 'text', required: true, label: '목표 값', hint: 'CPI 등은 달러, ROAS는 비율(0.3=30%). 마이크로가 아닙니다.' },
        { key: 'roasDayTarget', type: 'select', required: false, label: 'ROAS 일수', options: [{ value: 'DAY7', label: 'DAY7' }, { value: 'DAY28', label: 'DAY28' }] },
        { key: 'eventTarget', type: 'text', required: false, label: 'CPE 이벤트 이름' },
        { key: 'trackingMethod', type: 'select', required: true, label: 'MMP', options: [
          { value: 'APPSFLYER', label: 'AppsFlyer' }, { value: 'ADJUST', label: 'Adjust' }, { value: 'BRANCH', label: 'Branch' },
          { value: 'KOCHAVA', label: 'Kochava' }, { value: 'TENJIN', label: 'Tenjin' }, { value: 'APSALAR', label: 'Singular' },
        ] },
        { key: 'impressionUrl', type: 'text', required: true, label: 'impression_url' },
        { key: 'clickUrl', type: 'text', required: true, label: 'click_url' },
        { key: 'objective', remove: true },
        { key: 'status', remove: true },
      ],
      'update-campaign': [
        { key: 'name', type: 'text', label: '이름' },
        { key: 'dailyBudgetMicros', type: 'money', label: '일일 예산' },
        { key: 'currency', type: 'text', label: '통화' },
        { key: 'status', type: 'select', label: '상태', options: [{ value: 'PAUSED', label: '일시중지' }, { value: 'LIVE', label: '활성' }] },
      ],
      'pause-campaign': [],
    },
    setupUrl: 'https://support.applovin.com/en/growth/promoting-your-apps/api/axon-campaign-management-api',
    limitations: [
      'Campaign Management 키는 MAX Management Key·Report Key와 다릅니다. 계정 허용 목록이 필요할 수 있습니다.',
      '공식 /campaign/create는 status를 무시합니다(Create=Ignored). PAUSED 초안을 가장하지 않으며, 사용자가 activation=LIVE를 명시한 생성만 허용합니다. 생성 직후 pause를 자동 호출하지 않습니다.',
      '기존 캠페인의 update는 LIVE/PAUSED를 공식 계약대로 변경합니다.',
      '예산 필드는 USD 십진 금액입니다. UI의 dailyBudgetMicros를 1,000,000으로 나눕니다.',
      '보고는 UTC이며 최근 45일 창입니다. 미귀속 매출로 ROAS를 만들지 않습니다.',
    ],
  },
  async execute(operation, input, ctx) {
    if (operation === 'check') {
      const listed = await ctx.request<unknown>(manageUrl('/campaign/list', ctx, { page: '1', size: '1' }), { headers: auth(ctx) });
      if (!Array.isArray(listed)) throw new AppError('INVALID_PROVIDER_RESPONSE', '연결 확인 응답이 올바르지 않습니다.');
      return { summary: { connected: true, accountId: accountId(ctx), allowlistMayApply: true } };
    }
    if (operation === 'list-campaigns') return listCampaigns(ctx);
    if (operation === 'sync') {
      const listed = await listCampaigns(ctx);
      let spend: ConnectorResult = { summary: {}, metrics: [] };
      try { spend = await spendMetrics(ctx); }
      catch (error) {
        if ((error as AppError).code !== 'AUTH_REQUIRED') throw error;
      }
      return { resources: listed.resources, resourceSnapshots: listed.resourceSnapshots, metrics: spend.metrics, summary: { ...listed.summary, spendRows: spend.metrics?.length ?? 0 } };
    }
    if (operation === 'create-campaign') return createCampaign(input, ctx);
    if (operation === 'update-campaign') return updateCampaign(input, ctx);
    if (operation === 'pause-campaign') return updateCampaign({ externalId: input.externalId, status: 'PAUSED' }, ctx);
    throw new AppError('UNSUPPORTED_OPERATION', 'AppLovin Ads에서 지원하지 않는 작업입니다.');
  },
};
