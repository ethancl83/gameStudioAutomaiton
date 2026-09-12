import { AppError, text } from '../domain/errors.js';
import type { Connector, ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { countryCode, currencyCode, daysAgo, digits, microsString, ymd } from './marketing-utils.js';
import { appAdMeetsMinimum, buildAppAdOperations, parseAppAdAssets } from './google-ads-creatives.js';
import { parseMicros } from '../metrics/index.js';

const HOST = 'https://googleads.googleapis.com/v25';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
const GEO: Record<string, string> = {
  US: '2840', KR: '2410', JP: '2392', GB: '2826', DE: '2276', FR: '2250', CA: '2124', AU: '2036',
  BR: '2076', IN: '2356', ID: '2360', TW: '2158', HK: '2344', SG: '2702', TH: '2764', VN: '2704',
  ES: '2724', IT: '2380', MX: '2484', NL: '2528',
};

function customerId(ctx: ConnectorContext): string {
  return digits(ctx.connection.accountId || ctx.credentials.customerId || '', 'Google Ads 고객 ID');
}

async function headers(ctx: ConnectorContext): Promise<Record<string, string>> {
  const token = await ctx.accessToken([SCOPE]);
  const result: Record<string, string> = { Authorization: `Bearer ${token}` };
  const login = ctx.credentials.loginCustomerId?.replace(/-/g, '');
  if (login) {
    if (!/^\d{6,16}$/.test(login)) throw new AppError('INVALID_INPUT', 'loginCustomerId 형식을 확인해 주세요.');
    result['login-customer-id'] = login;
  }
  return result;
}

async function search<T extends Record<string, unknown>>(ctx: ConnectorContext, query: string, id = customerId(ctx)): Promise<T[]> {
  const rows: T[] = [];
  let pageToken = '';
  const seen = new Set<string>();
  do {
    if (seen.has(pageToken) || seen.size >= 50) throw new AppError('PAGINATION_LIMIT', 'Google Ads 목록이 너무 큽니다.');
    seen.add(pageToken);
    const body: Record<string, unknown> = { query };
    if (pageToken) body.pageToken = pageToken;
    const data = await ctx.request<{ results?: T[]; nextPageToken?: string }>(`${HOST}/customers/${id}/googleAds:search`, {
      method: 'POST', headers: await headers(ctx), json: body, write: false,
    });
    if (data.results !== undefined && !Array.isArray(data.results)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Google Ads 검색 응답 형식을 확인할 수 없습니다.');
    rows.push(...(data.results ?? []));
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
  } while (pageToken);
  return rows;
}

function campaignResource(row: Record<string, unknown>, currency: string): ResourceInput {
  const campaign = (row.campaign ?? {}) as Record<string, unknown>;
  const budget = (row.campaignBudget ?? {}) as Record<string, unknown>;
  const setting = (campaign.appCampaignSetting ?? {}) as Record<string, unknown>;
  const id = String(campaign.id ?? '');
  const amount = budget.amountMicros != null ? String(budget.amountMicros) : undefined;
  return {
    kind: 'campaign',
    externalId: id,
    name: String(campaign.name ?? id),
    status: String(campaign.status ?? 'UNKNOWN'),
    data: {
      resourceName: campaign.resourceName,
      advertisingChannelType: campaign.advertisingChannelType,
      advertisingChannelSubType: campaign.advertisingChannelSubType,
      campaignBudget: campaign.campaignBudget,
      budgetResourceName: budget.resourceName,
      dailyBudgetMicros: amount ?? '0',
      currency,
      explicitlyShared: budget.explicitlyShared === true,
      appId: setting.appId,
      appIdentifier: typeof setting.appId === 'string' ? setting.appId : undefined,
      appStore: setting.appStore,
    },
  };
}

async function customerInfo(ctx: ConnectorContext): Promise<{ id: string; currency: string; timeZone: string; name: string }> {
  const id = customerId(ctx);
  const rows = await search<Record<string, unknown>>(ctx, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer');
  const customer = (rows[0]?.customer ?? {}) as Record<string, unknown>;
  const currency = typeof customer.currencyCode === 'string' ? customer.currencyCode : '';
  if (!currency) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Google Ads 계정 통화를 확인할 수 없습니다.');
  return {
    id: String(customer.id ?? id),
    currency,
    timeZone: String(customer.timeZone ?? ''),
    name: String(customer.descriptiveName ?? ''),
  };
}

async function listCampaigns(ctx: ConnectorContext): Promise<ConnectorResult> {
  const info = await customerInfo(ctx);
  const rows = await search<Record<string, unknown>>(ctx, `SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.campaign_budget, campaign.app_campaign_setting.app_id, campaign.app_campaign_setting.app_store, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED'`);
  const resources = rows.map(row => campaignResource(row, info.currency));
  return { resources, resourceSnapshots: [{ kind: 'campaign' }], summary: { customerId: info.id, currency: info.currency, timeZone: info.timeZone, campaignCount: resources.length } };
}

async function spendMetrics(ctx: ConnectorContext): Promise<ConnectorResult> {
  const info = await customerInfo(ctx);
  const start = daysAgo(6);
  const end = ymd();
  const rows = await search<Record<string, unknown>>(ctx, `SELECT segments.date, metrics.cost_micros, campaign.app_campaign_setting.app_id FROM campaign WHERE segments.date BETWEEN '${start}' AND '${end}' AND campaign.status != 'REMOVED'`);
  const metrics = new Map<string, NonNullable<ConnectorResult['metrics']>[number]>();
  for (const row of rows) {
    const date = String((row.segments as { date?: string } | undefined)?.date ?? '');
    const cost = (row.metrics as { costMicros?: string | number } | undefined)?.costMicros;
    const appId = (row.campaign as { appCampaignSetting?: { appId?: string } } | undefined)?.appCampaignSetting?.appId;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || cost == null) continue;
    const sourceId = `google-ads:spend:${info.id}:${appId || 'campaign'}:${date}`;
    metrics.set(sourceId, {
      date, currency: info.currency, kind: 'spend' as const, amountMicros: (parseMicros(String(cost)) + parseMicros(metrics.get(sourceId)?.amountMicros ?? '0')).toString(),
      basis: 'estimated' as const, sourceId,
      appIdentifier: appId,
    });
  }
  return { metrics: [...metrics.values()], summary: { customerId: info.id, currency: info.currency, timeZone: info.timeZone, from: start, to: end, rowCount: metrics.size } };
}

function appId(ctx: ConnectorContext, input: Record<string, unknown>): { appId: string; appStore: 'GOOGLE_APP_STORE' | 'APPLE_APP_STORE' } {
  const identifier = text(input.appId ?? ctx.project?.appIdentifier ?? ctx.credentials.appId ?? ctx.credentials.packageName ?? '', '앱 식별자', 150);
  const itunes = ctx.credentials.itunesId || (typeof input.itunesId === 'string' ? input.itunesId : '');
  if (/^\d{8,12}$/.test(itunes || identifier)) return { appId: itunes || identifier, appStore: 'APPLE_APP_STORE' };
  if (/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(identifier)) return { appId: identifier, appStore: 'GOOGLE_APP_STORE' };
  throw new AppError('APP_IDENTIFIER_REQUIRED', 'Android 패키지 이름 또는 iOS iTunes ID가 필요합니다. 프로젝트 appIdentifier 또는 연결의 appId/itunesId를 설정하세요.');
}

async function createCampaign(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const info = await customerInfo(ctx);
  const name = text(input.name, '캠페인 이름', 255);
  const budgetMicros = microsString(input.dailyBudgetMicros, '일일 예산');
  if (budgetMicros === '0') throw new AppError('INVALID_AMOUNT', '일일 예산은 0보다 커야 합니다.');
  const currency = currencyCode(input.currency);
  if (currency !== info.currency) throw new AppError('CURRENCY_MISMATCH', `캠페인 통화(${currency})가 계정 통화(${info.currency})와 같아야 합니다.`);
  const cpa = input.targetCpaMicros;
  if (cpa == null) {
    throw new AppError('BIDDING_REQUIRED', 'App 캠페인은 생성 시 target CPA가 필요합니다. UI에 targetCpaMicros(마이크로 정수 문자열)를 추가해 주세요. 입찰·소재가 없으면 광고가 집행되지 않습니다.', 422);
  }
  const targetCpaMicros = microsString(cpa, '목표 CPA');
  if (targetCpaMicros === '0') throw new AppError('BIDDING_REQUIRED', '목표 CPA는 0일 수 없습니다. 지출이 발생하는 기본값을 만들지 않습니다.');
  const app = appId(ctx, input);
  const customer = info.id;
  const budgetTemp = `customers/${customer}/campaignBudgets/-1`;
  const campaignTemp = `customers/${customer}/campaigns/-2`;
  const campaignCreate: Record<string, unknown> = {
    resourceName: campaignTemp,
    name,
    status: 'PAUSED',
    advertisingChannelType: 'MULTI_CHANNEL',
    advertisingChannelSubType: 'APP_CAMPAIGN',
    campaignBudget: budgetTemp,
    appCampaignSetting: {
      appId: app.appId,
      appStore: app.appStore,
      biddingStrategyGoalType: 'OPTIMIZE_INSTALLS_TARGET_INSTALL_COST',
    },
    targetCpa: { targetCpaMicros },
    containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  };
  const operations: Record<string, unknown>[] = [
    {
      campaignBudgetOperation: {
        create: {
          resourceName: budgetTemp,
          name: `${name} budget`,
          amountMicros: budgetMicros,
          explicitlyShared: false,
        },
      },
    },
    { campaignOperation: { create: campaignCreate } },
  ];
  const assets = parseAppAdAssets(input, false);
  if (assets) {
    operations.push(...buildAppAdOperations({
      customerId: customer,
      campaignResourceName: campaignTemp,
      adGroupTemp: `customers/${customer}/adGroups/-3`,
      adGroupName: `${name} ads`,
      assets,
      youtubeTempStart: -4,
    }));
  }
  const countries = input.country === undefined ? [] : Array.isArray(input.country) ? input.country : [input.country];
  if (countries.length > 20) throw new AppError('INVALID_INPUT', '국가는 20개 이하로 선택해 주세요.');
  for (const iso of new Set(countries.map(value => countryCode(value)))) {
    const geo = typeof input.geoTargetConstant === 'string' ? text(input.geoTargetConstant, 'geoTargetConstant', 32) : GEO[iso];
    if (!geo) throw new AppError('UNSUPPORTED_LOCATION', `${iso} 의 Google Ads geoTargetConstant가 없습니다. 연결 또는 작업 입력에 geoTargetConstant를 지정해 주세요.`);
    operations.push({
      campaignCriterionOperation: {
        create: {
          campaign: campaignTemp,
          location: { geoTargetConstant: `geoTargetConstants/${geo}` },
        },
      },
    });
  }
  const mutate = await ctx.request<{ mutateOperationResponses?: Array<Record<string, { resourceName?: string }>> }>(
    `${HOST}/customers/${customer}/googleAds:mutate`,
    { method: 'POST', headers: await headers(ctx), json: { mutateOperations: operations }, write: true },
  );
  const campaignName = mutate.mutateOperationResponses?.find(item => item.campaignResult)?.campaignResult?.resourceName;
  const match = campaignName?.match(/campaigns\/(\d+)$/);
  if (!match) throw new AppError('INVALID_PROVIDER_RESPONSE', '생성된 캠페인 ID를 확인할 수 없습니다.');
  ctx.checkpoint({ externalId: match[1], resourceName: campaignName, status: 'PAUSED', hasCreatives: Boolean(assets) });
  const listed = await listCampaigns(ctx);
  const resource = listed.resources?.find(item => item.externalId === match[1]);
  if (!resource || resource.status !== 'PAUSED') throw new AppError('INVALID_PROVIDER_RESPONSE', '생성 후 캠페인 상태가 PAUSED인지 확인할 수 없습니다.');
  return {
    resources: [resource],
    summary: {
      externalId: match[1], status: resource.status, currency, dailyBudgetMicros: budgetMicros,
      appIdentifier: app.appId, hasCreatives: Boolean(assets),
      note: assets
        ? 'App 캠페인·광고그룹·AppAd가 PAUSED로 생성되었습니다. 활성화는 update-campaign의 ENABLED입니다.'
        : 'App 캠페인은 PAUSED로 생성되었습니다. 헤드라인/설명 소재가 없어 ENABLED로 올리지 않습니다.',
    },
  };
}

async function listAppAds(ctx: ConnectorContext, campaignId: string): Promise<Record<string, unknown>[]> {
  return search<Record<string, unknown>>(ctx, `SELECT ad_group_ad.status, ad_group_ad.ad.app_ad.headlines, ad_group_ad.ad.app_ad.descriptions, ad_group.id FROM ad_group_ad WHERE campaign.id = ${campaignId} AND ad_group_ad.status != 'REMOVED'`);
}

async function assertCreativesReady(ctx: ConnectorContext, campaignId: string): Promise<void> {
  const ads = await listAppAds(ctx, campaignId);
  const ready = ads.some(row => {
    const adGroupAd = (row.adGroupAd ?? {}) as Record<string, unknown>;
    const status = String(adGroupAd.status ?? '');
    if (status !== 'ENABLED' && status !== 'PAUSED') return false;
    return appAdMeetsMinimum((adGroupAd.ad ?? {}) as Record<string, unknown>);
  });
  if (!ready) {
    throw new AppError('CREATIVE_REQUIRED', '헤드라인 2개 이상·설명 1개 이상의 AppAd가 확인되지 않아 ENABLED로 올리지 않습니다. create-creative를 먼저 실행하세요.');
  }
}

async function createCreative(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const { row, info } = await loadCampaign(ctx, text(input.externalId, '캠페인 식별자', 32));
  const campaign = (row.campaign ?? {}) as Record<string, unknown>;
  const campaignId = String(campaign.id ?? '');
  const resourceName = String(campaign.resourceName ?? '');
  const assets = parseAppAdAssets(input, true);
  if (!assets) throw new AppError('CREATIVE_REQUIRED', 'App 광고 소재가 필요합니다.');
  const adGroupTemp = `customers/${info.id}/adGroups/-3`;
  const operations = buildAppAdOperations({
    customerId: info.id,
    campaignResourceName: resourceName,
    adGroupTemp,
    adGroupName: `${String(campaign.name ?? campaignId)} ads`,
    assets,
    youtubeTempStart: -4,
  });
  await ctx.request(`${HOST}/customers/${info.id}/googleAds:mutate`, {
    method: 'POST', headers: await headers(ctx), json: { mutateOperations: operations }, write: true,
  });
  ctx.checkpoint({ externalId: campaignId, resourceName, stage: 'creative' });
  return {
    resources: [campaignResource(row, info.currency)],
    summary: { externalId: campaignId, createdCreative: true, headlineCount: assets.headlines.length, descriptionCount: assets.descriptions.length },
  };
}

async function loadCampaign(ctx: ConnectorContext, externalId: string): Promise<{ row: Record<string, unknown>; info: Awaited<ReturnType<typeof customerInfo>> }> {
  const id = text(externalId, '캠페인 ID', 20);
  if (!/^\d{1,16}$/.test(id)) throw new AppError('INVALID_INPUT', '캠페인 ID 형식을 확인해 주세요.');
  const info = await customerInfo(ctx);
  const rows = await search<Record<string, unknown>>(ctx, `SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name, campaign.campaign_budget, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${id}`);
  if (!rows[0]) throw new AppError('RESOURCE_NOT_FOUND', '동기화된 캠페인을 찾을 수 없습니다.');
  return { row: rows[0], info };
}

async function assertUnsharedBudget(ctx: ConnectorContext, budgetResource: string, campaignId: string): Promise<void> {
  const others = await search<Record<string, unknown>>(ctx, `SELECT campaign.id FROM campaign WHERE campaign.campaign_budget = '${budgetResource}' AND campaign.id != ${campaignId} AND campaign.status != 'REMOVED'`);
  if (others.length > 0) throw new AppError('SHARED_BUDGET', '다른 캠페인이 같은 예산을 사용합니다. 공유 예산은 변경하지 않습니다.');
}

async function updateCampaign(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const { row, info } = await loadCampaign(ctx, text(input.externalId, '캠페인 식별자', 32));
  const campaign = (row.campaign ?? {}) as Record<string, unknown>;
  const budget = (row.campaignBudget ?? {}) as Record<string, unknown>;
  const resourceName = String(campaign.resourceName ?? '');
  const campaignId = String(campaign.id ?? '');
  const operations: Record<string, unknown>[] = [];
  const mask: string[] = [];
  const update: Record<string, unknown> = { resourceName };
  if (typeof input.name === 'string') { update.name = text(input.name, '캠페인 이름', 255); mask.push('name'); }
  if (typeof input.status === 'string') {
    const status = text(input.status, '상태', 16).toUpperCase();
    if (status !== 'PAUSED' && status !== 'ENABLED') throw new AppError('UNSUPPORTED_CHANGE', '캠페인 상태는 PAUSED 또는 ENABLED만 변경할 수 있습니다.');
    if (status === 'ENABLED') await assertCreativesReady(ctx, campaignId);
    update.status = status; mask.push('status');
  }
  if (mask.length) operations.push({ campaignOperation: { update, updateMask: mask.join(',') } });
  if (input.dailyBudgetMicros != null) {
    const currency = input.currency ? currencyCode(input.currency) : info.currency;
    if (currency !== info.currency) throw new AppError('CURRENCY_MISMATCH', `예산 통화(${currency})가 계정 통화(${info.currency})와 같아야 합니다.`);
    if (budget.explicitlyShared === true) throw new AppError('SHARED_BUDGET', '공유 캠페인 예산은 이 캠페인만의 금액으로 변경할 수 없습니다.');
    const budgetName = String(budget.resourceName ?? campaign.campaignBudget ?? '');
    if (!budgetName) throw new AppError('INVALID_PROVIDER_RESPONSE', '캠페인 예산 리소스를 확인할 수 없습니다.');
    await assertUnsharedBudget(ctx, budgetName, campaignId);
    operations.push({
      campaignBudgetOperation: {
        update: { resourceName: budgetName, amountMicros: microsString(input.dailyBudgetMicros, '일일 예산') },
        updateMask: 'amount_micros',
      },
    });
  }
  if (!operations.length) throw new AppError('INVALID_INPUT', '변경할 캠페인 필드가 없습니다.');
  await ctx.request(`${HOST}/customers/${info.id}/googleAds:mutate`, {
    method: 'POST', headers: await headers(ctx), json: { mutateOperations: operations }, write: true,
  });
  ctx.checkpoint({ externalId: campaignId, resourceName });
  const listed = await listCampaigns(ctx);
  const resource = listed.resources?.find(item => item.externalId === campaignId) ?? campaignResource(row, info.currency);
  return { resources: [resource], summary: { externalId: campaignId, updated: true, status: resource.status, dailyBudgetMicros: resource.data.dailyBudgetMicros, currency: info.currency } };
}

async function pauseCampaign(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  return updateCampaign({ externalId: input.externalId, status: 'PAUSED' }, ctx);
}

export const googleAdsConnector: Connector = {
  capability: {
    provider: 'google-ads', name: 'Google Ads', category: 'marketing',
    description: '승인된 Google Cloud OAuth 프로젝트로 App 캠페인·AppAd 소재를 만들고 예산·활성/중지를 관리합니다.',
    authKind: 'Google OAuth 또는 서비스 계정 (Cloud 프로젝트 API 접근 수준)',
    fields: [
      { key: 'clientId', label: 'Google OAuth 클라이언트 ID' },
      { key: 'clientSecret', label: 'OAuth 클라이언트 시크릿', secret: true },
      { key: 'refreshToken', label: 'OAuth 갱신 토큰', secret: true },
      { key: 'serviceAccountJson', label: '서비스 계정 JSON (OAuth 대신)', secret: true, multiline: true },
      { key: 'loginCustomerId', label: '관리자 계정 ID (MCC, 선택)' },
      { key: 'appId', label: '기본 앱 ID (패키지 이름 또는 iTunes ID)' },
      { key: 'itunesId', label: 'iOS iTunes ID (iOS 캠페인)' },
    ],
    operations: ['check', 'sync', 'list-campaigns', 'create-campaign', 'create-creative', 'update-campaign', 'pause-campaign'],
    operationFields: {
      'create-campaign': [
        { key: 'name', type: 'text', required: true, label: '캠페인 이름' },
        { key: 'dailyBudgetMicros', type: 'money', required: true, label: '일일 예산' },
        { key: 'currency', type: 'text', required: true, label: '통화', placeholder: 'USD', hint: '계정 통화와 같아야 합니다.' },
        { key: 'targetCpaMicros', type: 'money', required: true, label: '목표 CPA', hint: '0 불가. App 캠페인 설치 목표 CPA(마이크로).' },
        { key: 'appId', type: 'text', required: false, label: '앱 ID', hint: '선택한 프로젝트 또는 연결 appId가 있으면 생략합니다.' },
        { key: 'country', type: 'text', required: false, label: '국가', placeholder: 'US' },
        { key: 'headlines', type: 'textarea', required: false, label: '헤드라인 JSON 배열', hint: '["문구1","문구2"] 2–5개, 각 30자. 있으면 광고그룹·AppAd를 같은 mutate에 포함합니다.', placeholder: '["앱 설치","지금 플레이"]' },
        { key: 'descriptions', type: 'textarea', required: false, label: '설명 JSON 배열', hint: '["설명"] 1–5개, 각 90자.', placeholder: '["무료로 플레이하세요"]' },
        { key: 'imageAssetResourceNames', type: 'textarea', required: false, label: '이미지 애셋 리소스 JSON 배열', hint: '기존 customers/{id}/assets/{id}만. 바이너리 업로드 없음.' },
        { key: 'youtubeVideoIds', type: 'textarea', required: false, label: 'YouTube 동영상 ID JSON 배열', hint: '11자 동영상 ID. YoutubeVideoAsset으로 생성합니다.' },
        { key: 'objective', remove: true },
      ],
      'create-creative': [
        { key: 'headlines', type: 'textarea', required: true, label: '헤드라인 JSON 배열', hint: '["문구1","문구2"] 2–5개, 각 30자.' },
        { key: 'descriptions', type: 'textarea', required: true, label: '설명 JSON 배열', hint: '["설명"] 1–5개, 각 90자.' },
        { key: 'imageAssetResourceNames', type: 'textarea', required: false, label: '이미지 애셋 리소스 JSON 배열' },
        { key: 'youtubeVideoIds', type: 'textarea', required: false, label: 'YouTube 동영상 ID JSON 배열' },
      ],
      'update-campaign': [
        { key: 'name', type: 'text', label: '이름' },
        { key: 'dailyBudgetMicros', type: 'money', label: '일일 예산' },
        { key: 'currency', type: 'text', label: '통화' },
        { key: 'status', type: 'select', label: '상태', options: [{ value: 'PAUSED', label: '일시중지' }, { value: 'ENABLED', label: '활성' }], hint: 'ENABLED는 헤드라인 2개·설명 1개 이상의 AppAd가 있을 때만 허용합니다.' },
      ],
      'pause-campaign': [],
    },
    setupUrl: 'https://console.cloud.google.com/google/ads-apis/overview',
    limitations: [
      'developer token은 2026-09-09에 종료되었습니다. 신규 온보딩에 developerToken을 요구하지 않으며 요청 헤더에도 넣지 않습니다. 접근 수준은 OAuth/서비스 계정의 Cloud 프로젝트가 결정합니다.',
      'App 캠페인(MULTI_CHANNEL/APP_CAMPAIGN)만 생성하며 항상 PAUSED입니다. 공유 예산·포트폴리오 입찰은 사용할 수 없습니다.',
      '헤드라인 2–5개(30자)·설명 1–5개(90자)를 주면 같은 mutate에 광고그룹(type 미지정)과 AppAd를 만듭니다. 이미지 바이너리 업로드는 하지 않고 기존 asset 리소스·YouTube ID만 받습니다.',
      'ENABLED는 해당 캠페인에 최소 AppAd가 확인된 뒤에만 허용합니다. 소재 없이 활성으로 올리지 않습니다.',
      '예산 변경 전에 explicitly_shared=false 와 해당 예산을 쓰는 다른 캠페인이 없음을 확인합니다.',
      '실계정 쓰기·지출은 이 모듈의 단위 테스트에서 수행하지 않습니다.',
    ],
  },
  async execute(operation, input, ctx) {
    if (operation === 'check') {
      const info = await customerInfo(ctx);
      return { summary: { connected: true, customerId: info.id, currency: info.currency, timeZone: info.timeZone, name: info.name, developerTokenRequired: false } };
    }
    if (operation === 'list-campaigns') return listCampaigns(ctx);
    if (operation === 'sync') {
      const listed = await listCampaigns(ctx);
      const spend = await spendMetrics(ctx);
      return { resources: listed.resources, resourceSnapshots: listed.resourceSnapshots, metrics: spend.metrics, summary: { ...listed.summary, spendRows: spend.summary.rowCount } };
    }
    if (operation === 'create-campaign') return createCampaign(input, ctx);
    if (operation === 'create-creative') return createCreative(input, ctx);
    if (operation === 'update-campaign') return updateCampaign(input, ctx);
    if (operation === 'pause-campaign') return pauseCampaign(input, ctx);
    throw new AppError('UNSUPPORTED_OPERATION', 'Google Ads에서 지원하지 않는 작업입니다.');
  },
};
