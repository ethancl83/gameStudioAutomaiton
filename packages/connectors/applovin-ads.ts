import { AppError, text } from '../domain/errors.js';
import type { AttributionInput, Connector, ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { countryCode, currencyCode, daysAgo, isoDate, microsString, microsToDecimal, moneyToMicros, ymd } from './marketing-utils.js';
import { accountId, auth, manageUrl, listCampaigns, readCampaign } from './applovin-ads-client.js';
export { accountId, auth, manageUrl, readCampaign } from './applovin-ads-client.js';
import { createCreative, listCreatives, reconcileUpload, updateCreative } from './applovin-ads-creatives.js';
import { parseMicros } from '../metrics/index.js';

const REPORT = 'https://r.applovin.com/report';

function reportKey(ctx: ConnectorContext): string {
  const key = ctx.credentials.reportKey;
  if (!key) throw new AppError('AUTH_REQUIRED', '광고 보고용 Report Key가 필요합니다. Campaign Management 키와 별개입니다.');
  return key;
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

type Row = Record<string, unknown>;

async function report(ctx: ConnectorContext, columns: string, start: string, end: string, extra: Record<string, string> = {}): Promise<unknown[]> {
  const url = `${REPORT}?${new URLSearchParams({ api_key: reportKey(ctx), start, end, format: 'json', report_type: 'advertiser', columns, ...extra })}`;
  const data = await ctx.request<unknown>(url, { headers: {}, write: false });
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : null);
  if (!rows) throw new AppError('INVALID_PROVIDER_RESPONSE', 'AppLovin 광고 보고 응답 형식을 확인할 수 없습니다.');
  return rows;
}

async function spendMetrics(ctx: ConnectorContext): Promise<ConnectorResult> {
  const start = daysAgo(6);
  const end = ymd();
  const rows = await report(ctx, 'day,cost,campaign_id_external,campaign_package_name', start, end);
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Reporting API `total_rev_«x»` 중 획득 cohort 귀속 창으로 쓰는 값. 30d·90d·1y는 45일 조회 창에서 완료 cohort가 거의 없어 제외한다. */
const COHORT_DAYS = [0, 1, 3, 7, 14, 28] as const;
const REPORT_WINDOW_DAYS = 45;

function reportDate(value: unknown, label: string, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = text(value, label, 10);
  if (!DAY.test(raw) || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) throw new AppError('INVALID_INPUT', `${label}는 YYYY-MM-DD 형식이어야 합니다.`);
  return raw;
}

function reportCount(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) throw new AppError('INVALID_PROVIDER_RESPONSE', `AppLovin ${label} 값 형식을 확인할 수 없습니다.`);
  return parsed;
}

/** 캠페인·일자별 행을 합친다. 금액은 마이크로 BigInt, 횟수는 숫자로 더한다. */
function groupRows(rows: unknown[], money: string[], counts: string[]): Map<string, { campaignId: string; day: string; appIdentifier?: string; money: Map<string, bigint>; counts: Map<string, number> }> {
  const grouped = new Map<string, { campaignId: string; day: string; appIdentifier?: string; money: Map<string, bigint>; counts: Map<string, number> }>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Row;
    const day = String(item.day ?? '');
    const campaignId = item.campaign_id_external == null ? '' : String(item.campaign_id_external);
    // 캠페인 귀속이 없는 행은 ROAS·cohort 계산에 쓸 수 없어 귀속 fact로 남기지 않는다.
    if (!DAY.test(day) || !campaignId) continue;
    const key = `${campaignId}:${day}`;
    const entry = grouped.get(key) ?? { campaignId, day, appIdentifier: item.campaign_package_name != null && item.campaign_package_name !== '' ? String(item.campaign_package_name) : undefined, money: new Map(), counts: new Map() };
    for (const column of money) {
      if (item[column] == null || item[column] === '') continue;
      entry.money.set(column, (entry.money.get(column) ?? 0n) + parseMicros(moneyToMicros(item[column], column)));
    }
    for (const column of counts) entry.counts.set(column, (entry.counts.get(column) ?? 0) + reportCount(item[column], column));
    grouped.set(key, entry);
  }
  return grouped;
}

/**
 * 캠페인·일자별 귀속 fact.
 * - 실시간 보고(day_column 없음): cost→spend(USD), conversions→installs("Number of conversions (installs)"), clicks, impressions. 귀속 창 0 = 공급자 기본.
 * - cohort 보고(day_column=day, day=설치일): total_rev_{0,1,3,7,14,28}d → revenue, basis gross_conversion_value, 귀속 창 = cohort 일수.
 *   아직 끝나지 않은 cohort 창(설치일 + 창 + 1일 > 지금)은 값이 계속 바뀌므로 남기지 않는다.
 * 기존 spend MetricFact는 바꾸지 않는다.
 */
async function campaignAttribution(input: Record<string, unknown>, ctx: ConnectorContext, options: { cohortStart?: string; tolerateCohortRejection?: boolean } = {}): Promise<ConnectorResult> {
  const earliest = daysAgo(REPORT_WINDOW_DAYS - 1);
  const end = reportDate(input.endDate, '종료일', ymd());
  const start = reportDate(input.startDate, '시작일', daysAgo(6));
  if (start > end) throw new AppError('INVALID_INPUT', '시작일은 종료일보다 늦을 수 없습니다.');
  if (start < earliest) throw new AppError('INVALID_INPUT', `AppLovin 보고는 최근 ${REPORT_WINDOW_DAYS}일 창만 조회합니다. 시작일은 ${earliest} 이후여야 합니다.`);
  const cohortStart = options.cohortStart && options.cohortStart < start ? options.cohortStart : start;
  const observedAt = new Date().toISOString();
  const now = Date.now();
  const accountKey = accountId(ctx);
  const attribution: AttributionInput[] = [];
  const common = (campaignId: string, day: string, appIdentifier: string | undefined, watermark: string) => ({
    campaignId, acquisitionDate: day, eventDate: day, cohortKey: `applovin:${campaignId}:${day}`, observedAt, sourceWatermark: watermark,
    revision: 1, finality: 'estimated' as const, ...(appIdentifier ? { appIdentifier } : {}),
  });
  const sourceId = (campaignId: string, day: string, kind: string) => `applovin-ads:campaign:${accountKey}:${campaignId}:${day}:${kind}`;

  const realtime = groupRows(await report(ctx, 'day,campaign_id_external,campaign_package_name,cost,conversions,impressions,clicks', start, end), ['cost'], ['conversions', 'impressions', 'clicks']);
  const realtimeWatermark = [...realtime.values()].map(item => item.day).sort().at(-1) ?? end;
  for (const item of realtime.values()) {
    const base = { ...common(item.campaignId, item.day, item.appIdentifier, realtimeWatermark), attributionWindowDays: 0 };
    attribution.push(
      { ...base, kind: 'spend', currency: 'USD', amountMicros: (item.money.get('cost') ?? 0n).toString(), sourceId: sourceId(item.campaignId, item.day, 'spend') },
      { ...base, kind: 'installs', count: item.counts.get('conversions') ?? 0, sourceId: sourceId(item.campaignId, item.day, 'installs') },
      { ...base, kind: 'clicks', count: item.counts.get('clicks') ?? 0, sourceId: sourceId(item.campaignId, item.day, 'clicks') },
      { ...base, kind: 'impressions', count: item.counts.get('impressions') ?? 0, sourceId: sourceId(item.campaignId, item.day, 'impressions') },
    );
  }

  const revenueColumns = COHORT_DAYS.map(days => `total_rev_${days}d`);
  let cohortRejected: string | undefined;
  let cohortRows: unknown[] = [];
  try {
    cohortRows = await report(ctx, `day,campaign_id_external,campaign_package_name,${revenueColumns.join(',')}`, cohortStart, end, { day_column: 'day' });
  } catch (error) {
    if (!options.tolerateCohortRejection || !(error instanceof AppError) || error.code !== 'PROVIDER_REJECTED') throw error;
    cohortRejected = error.message;
  }
  const cohorts = groupRows(cohortRows, revenueColumns, []);
  const cohortWatermark = [...cohorts.values()].map(item => item.day).sort().at(-1) ?? end;
  for (const item of cohorts.values()) {
    for (const days of COHORT_DAYS) {
      const amount = item.money.get(`total_rev_${days}d`);
      if (amount === undefined || Date.parse(`${item.day}T00:00:00Z`) + (days + 1) * 86_400_000 > now) continue;
      attribution.push({
        ...common(item.campaignId, item.day, item.appIdentifier, cohortWatermark), attributionWindowDays: days,
        kind: 'revenue', currency: 'USD', amountMicros: amount.toString(), revenueBasis: 'gross_conversion_value', sourceId: sourceId(item.campaignId, item.day, `revenue:${days}d`),
      });
    }
  }
  return {
    attribution,
    summary: {
      accountId: accountKey, timeZone: 'UTC', currency: 'USD', from: start, to: end, cohortFrom: cohortStart, factCount: attribution.length,
      realtimeRows: realtime.size, cohortRows: cohorts.size, cohortWindows: [...COHORT_DAYS], revenueColumns, revenueBasis: 'gross_conversion_value',
      installsColumn: 'conversions', attributionWindowNote: '광고비·설치 fact의 0은 공급자 기본 귀속입니다. 수익 fact의 창은 total_rev_«x»d의 cohort 일수입니다.',
      ...(cohortRejected ? { cohortRevenue: 'unavailable', cohortRevenueReason: cohortRejected } : {}),
    },
  };
}

export const applovinAdsConnector: Connector = {
  capability: {
    provider: 'applovin-ads', name: 'AppLovin Ads', category: 'marketing',
    description: 'Axon Campaign Management API로 기존 캠페인을 수정하고, 명시한 LIVE 생성·소재 세트 관리·광고 지출과 캠페인 cohort 귀속 조회를 수행합니다.',
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
    operations: ['check', 'sync', 'list-campaigns', 'campaign-attribution', 'create-campaign', 'update-campaign', 'pause-campaign', 'list-creatives', 'create-creative', 'update-creative'],
    operationFields: {
      'campaign-attribution': [
        { key: 'startDate', type: 'date', required: false, label: '시작일', hint: '생략하면 6일 전. 최근 45일 안' },
        { key: 'endDate', type: 'date', required: false, label: '종료일', hint: '생략하면 오늘' },
      ],
      'list-creatives': [
        { key: 'externalId', type: 'text', required: false, label: '캠페인 ID', hint: '비우면 계정 전체 소재 세트' },
      ],
      'create-creative': [
        { key: 'name', type: 'text', required: true, label: '소재 세트 이름', hint: '같은 캠페인에서 같은 이름이면 재실행으로 보고 기존 세트를 재사용합니다.' },
        { key: 'assetIds', type: 'textarea', required: false, label: '기존 AppLovin asset ID JSON 배열', hint: 'HOSTED_HTML 또는 세로 전면 이미지(IMG_INTER_P)+동영상 구성이 필요합니다.', placeholder: '["62453682"]' },
        { key: 'mediaAssetId', type: 'text', required: false, label: '등록 이미지', hint: '프로젝트에 등록한 PNG·JPEG. /asset/upload 후 SHA1 해시로 중복을 막습니다.' },
        { key: 'status', type: 'select', required: false, label: '상태', options: [{ value: 'PAUSED', label: 'PAUSED (기본)' }, { value: 'LIVE', label: 'LIVE' }] },
        { key: 'languages', type: 'text', required: false, label: '언어', placeholder: 'ENGLISH,KOREAN' },
        { key: 'countries', type: 'text', required: false, label: '국가', placeholder: 'US,KR' },
      ],
      'update-creative': [
        { key: 'creativeSetId', type: 'text', required: true, label: '소재 세트 ID' },
        { key: 'name', type: 'text', required: false, label: '이름' },
        { key: 'status', type: 'select', required: false, label: '상태', options: [{ value: 'PAUSED', label: 'PAUSED' }, { value: 'LIVE', label: 'LIVE' }] },
        { key: 'assetIds', type: 'textarea', required: false, label: 'asset ID JSON 배열(전체 교체)', hint: '비우면 기존 asset 유지. mediaAssetId는 기존 목록에 추가합니다.' },
        { key: 'mediaAssetId', type: 'text', required: false, label: '추가할 등록 이미지' },
        { key: 'languages', type: 'text', required: false, label: '언어' },
        { key: 'countries', type: 'text', required: false, label: '국가' },
      ],
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
      'campaign-attribution과 sync는 캠페인·일자별 spend(cost)·installs(conversions)·clicks·impressions와, day_column=day cohort 보고의 total_rev_0d/1d/3d/7d/14d/28d를 revenue(gross_conversion_value, 귀속 창=cohort 일수)로 남깁니다. 끝나지 않은 cohort 창은 남기지 않습니다. 수익 통화 USD와 total_rev의 총매출 기준은 공식 문서에 명시되지 않아 가정입니다.',
      'sync에서 cohort 보고가 거부되면(allowlist·열 미지원) 광고비·설치 fact는 남기고 summary.cohortRevenue=unavailable로 표시합니다. campaign-attribution 작업은 거부를 그대로 실패로 보고합니다.',
      '소재 세트(creative set)는 /creative_set/list·list_by_campaign_id·create·update를 사용합니다. 생성은 기본 PAUSED이며 HOSTED_HTML 또는 IMG_INTER_P+동영상 구성과 거부되지 않은 asset을 전송 전에 확인합니다. 등록 이미지만으로는 소재 세트를 만들 수 없습니다.',
      '이미지 업로드는 /asset/upload(multipart files)이며 비동기 처리입니다. 업로드 전 /asset/list의 asset_hash(SHA1)로 같은 이미지를 찾아 재사용합니다. 처리 중이면 waiting_external로 두고 같은 입력의 재실행이 이어서 진행합니다. 업로드 이미지의 asset_type(IMG_INTER_P 등) 판정 기준은 공식 문서에 없습니다.',
      'clone·add-to-campaigns·remove 계열 소재 세트/asset 작업은 제공하지 않습니다.',
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
      let attributed: ConnectorResult = { summary: {}, attribution: [] };
      try {
        spend = await spendMetrics(ctx);
        attributed = await campaignAttribution({}, ctx, { cohortStart: daysAgo(REPORT_WINDOW_DAYS - 1), tolerateCohortRejection: true });
      } catch (error) {
        if ((error as AppError).code !== 'AUTH_REQUIRED') throw error;
      }
      return { resources: listed.resources, resourceSnapshots: listed.resourceSnapshots, metrics: spend.metrics, attribution: attributed.attribution,
        summary: { ...listed.summary, spendRows: spend.metrics?.length ?? 0, attributionFacts: attributed.attribution?.length ?? 0,
          ...(attributed.summary.cohortRevenue ? { cohortRevenue: attributed.summary.cohortRevenue } : {}) } };
    }
    if (operation === 'campaign-attribution') return campaignAttribution(input, ctx);
    if (operation === 'list-creatives') return listCreatives(input, ctx);
    if (operation === 'create-creative') return createCreative(input, ctx);
    if (operation === 'update-creative') return updateCreative(input, ctx);
    if (operation === 'reconcile' && input.uploadId !== undefined) return reconcileUpload(input, ctx);
    if (operation === 'create-campaign') return createCampaign(input, ctx);
    if (operation === 'update-campaign') return updateCampaign(input, ctx);
    if (operation === 'pause-campaign') return updateCampaign({ externalId: input.externalId, status: 'PAUSED' }, ctx);
    throw new AppError('UNSUPPORTED_OPERATION', 'AppLovin Ads에서 지원하지 않는 작업입니다.');
  },
};
