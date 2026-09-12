import { AppError, text } from '../domain/errors.js';
import type { Connector, ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { daysAgo, headerAuth, moneyToMicros, ymd } from './marketing-utils.js';
import { maxSdkConfig } from './sdk-integration.js';

const HOST = 'https://o.applovin.com/mediation/v1';
const REPORT = 'https://r.applovin.com/maxReport';
const FORMATS: Record<string, string> = {
  banner: 'BANNER', interstitial: 'INTER', inter: 'INTER', rewarded: 'REWARD', reward: 'REWARD',
  mrec: 'MREC', native: 'NATIVE', appopen: 'APPOPEN', app_open: 'APPOPEN',
};

function managementKey(ctx: ConnectorContext): string {
  const key = ctx.credentials.managementKey || ctx.credentials.apiKey;
  if (!key) throw new AppError('AUTH_REQUIRED', 'MAX Management Key가 필요합니다. 광고 Campaign Management 키와 다릅니다.');
  return key;
}

function reportKey(ctx: ConnectorContext): string {
  const key = ctx.credentials.reportKey;
  if (!key) throw new AppError('AUTH_REQUIRED', 'MAX Report Key가 필요합니다.');
  return key;
}

function auth(ctx: ConnectorContext): Record<string, string> {
  return headerAuth('api-key', managementKey(ctx));
}

function unitResource(item: Record<string, unknown>): ResourceInput {
  return {
    kind: 'ad-unit',
    externalId: String(item.id ?? ''),
    name: String(item.name ?? item.id ?? ''),
    status: item.disabled === true ? 'DISABLED' : 'ACTIVE',
    data: {
      platform: item.platform,
      packageName: item.package_name,
      appIdentifier: typeof item.package_name === 'string' ? item.package_name : undefined,
      adFormat: item.ad_format,
      disabled: item.disabled === true,
      hasActiveExperiment: item.has_active_experiment === true,
    },
  };
}

async function listAdUnits(ctx: ConnectorContext): Promise<ConnectorResult> {
  const rows = await ctx.request<unknown>(`${HOST}/ad_units`, { headers: auth(ctx) });
  if (!Array.isArray(rows)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'MAX 광고 단위 목록이 배열이 아닙니다.');
  const resources = rows.filter(item => item && typeof item === 'object').map(item => unitResource(item as Record<string, unknown>));
  return { resources, summary: { adUnitCount: resources.length } };
}

function packageName(ctx: ConnectorContext, input: Record<string, unknown>): string {
  const value = text(input.packageName ?? ctx.project?.appIdentifier ?? ctx.credentials.packageName ?? '', '패키지 이름', 200);
  if (!value) throw new AppError('APP_IDENTIFIER_REQUIRED', '광고 단위에는 package_name이 필요합니다.');
  return value;
}

function adFormat(input: Record<string, unknown>): string {
  const raw = text(input.format ?? input.adFormat, '광고 형식', 32).toLowerCase();
  const mapped = FORMATS[raw] ?? (raw === 'banner' || raw === 'inter' || raw === 'reward' ? FORMATS[raw] : raw.toUpperCase());
  if (!['BANNER', 'INTER', 'REWARD', 'MREC'].includes(mapped)) {
    throw new AppError('INVALID_INPUT', '지원 형식은 BANNER, INTER, REWARD, MREC 입니다. NATIVE 템플릿 설정은 아직 지원하지 않습니다.');
  }
  return mapped;
}

async function createAdUnit(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const name = text(input.name, '광고 단위 이름', 255);
  const platform = text(input.platform ?? ctx.credentials.platform ?? '', '플랫폼', 16).toLowerCase();
  if (platform !== 'ios' && platform !== 'android') throw new AppError('INVALID_INPUT', 'platform은 ios 또는 android 여야 합니다.');
  const body = { name, platform, package_name: packageName(ctx, input), ad_format: adFormat(input) };
  const saved = await ctx.request<Record<string, unknown>>(`${HOST}/ad_unit`, {
    method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, json: body, write: true,
  });
  const id = String(saved.id ?? '');
  if (!id) throw new AppError('INVALID_PROVIDER_RESPONSE', '생성된 광고 단위 ID가 없습니다.');
  ctx.checkpoint({ externalId: id, adFormat: body.ad_format, platform });
  const resource = unitResource({ ...saved, id });
  return { resources: [resource], summary: { externalId: id, adFormat: body.ad_format, platform } };
}

async function updateAdUnit(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const id = text(input.externalId, '광고 단위 ID', 64);
  if (input.status !== undefined || input.disabled !== undefined) throw new AppError('UNSUPPORTED_OPERATION', 'MAX 광고 단위의 활성·중지는 공식 관리 API에서 변경할 수 없습니다.');
  const body: Record<string, unknown> = { id };
  body.name = text(input.name, '변경할 광고 단위 이름', 255);
  const saved = await ctx.request<Record<string, unknown>>(`${HOST}/ad_unit/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, json: body, write: true,
  });
  ctx.checkpoint({ externalId: id });
  return { resources: [unitResource({ ...saved, id })], summary: { externalId: id, updated: true } };
}

async function revenueMetrics(ctx: ConnectorContext): Promise<ConnectorResult> {
  const key = reportKey(ctx);
  const start = daysAgo(6);
  const end = ymd();
  const url = `${REPORT}?${new URLSearchParams({
    api_key: key, start, end, format: 'json',
    columns: 'day,estimated_revenue,package_name',
  })}`;
  const data = await ctx.request<unknown>(url);
  const rows = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results) ? (data as { results: unknown[] }).results : null);
  if (!rows) throw new AppError('INVALID_PROVIDER_RESPONSE', 'MAX 수익 보고 응답 형식을 확인할 수 없습니다.');
  const metrics = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const date = String(item.day ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || item.estimated_revenue == null) continue;
    const pkg = item.package_name != null ? String(item.package_name) : undefined;
    metrics.push({
      date, currency: 'USD', kind: 'revenue' as const, amountMicros: moneyToMicros(item.estimated_revenue, '추정 수익'),
      basis: 'estimated' as const, sourceId: `applovin-max:revenue:${pkg || 'account'}:${date}`,
      appIdentifier: pkg,
    });
  }
  return {
    metrics,
    summary: {
      from: start, to: end, timeZone: 'UTC', currency: 'USD', rowCount: metrics.length,
      note: 'MAX estimated_revenue는 미디에이션 합계입니다. 같은 기간의 AdMob 네트워크 수익과 더하지 마세요.',
    },
  };
}

export const applovinMaxConnector: Connector = {
  capability: {
    provider: 'applovin-max', name: 'AppLovin MAX', category: 'monetization',
    description: 'MAX 광고 단위를 만들고 추정 광고 수익을 조회합니다.',
    authKind: 'Management Key (Api-Key) + Report Key',
    fields: [
      { key: 'managementKey', label: 'MAX Management Key', secret: true, required: true },
      { key: 'reportKey', label: 'MAX Report Key', secret: true },
      { key: 'packageName', label: '기본 패키지 이름' },
      { key: 'platform', label: '기본 플랫폼 (ios 또는 android)' },
      { key: 'sdkKey', label: 'MAX SDK Key (대시보드 Keys, 선택)', secret: true },
    ],
    operations: ['check', 'sync', 'list-ad-units', 'create-ad-unit', 'update-ad-unit', 'sdk-integration-config'],
    operationFields: {
      'create-ad-unit': [
        { key: 'name', type: 'text', required: true, label: '광고 단위 이름' },
        { key: 'format', type: 'select', required: true, label: '형식', options: [
          { value: 'BANNER', label: 'BANNER' }, { value: 'INTER', label: 'INTER' }, { value: 'REWARD', label: 'REWARD' },
          { value: 'MREC', label: 'MREC' },
        ] },
        { key: 'platform', type: 'select', required: false, label: '플랫폼', options: [{ value: 'android', label: 'android' }, { value: 'ios', label: 'ios' }], hint: '연결 platform이 있으면 생략' },
        { key: 'packageName', type: 'text', required: false, label: '패키지 이름', hint: '프로젝트 appIdentifier가 있으면 생략' },
      ],
      'update-ad-unit': [
        { key: 'name', type: 'text', required: true },
        { key: 'status', remove: true },
      ],
      'sdk-integration-config': [],
    },
    setupUrl: 'https://support.applovin.com/en/max/advanced-features/ad-unit-management-api',
    limitations: [
      '광고 집행 Campaign Management 키와 MAX Management Key를 섞어 쓰지 않습니다.',
      '같은 앱/플랫폼/형식에 활성 광고 단위가 있으면 API가 추가 생성을 거부할 수 있습니다.',
      '수익 보고는 USD 추정값이며 UTC, 최근 45일입니다. network 열을 넣지 않아 AdMob 원천과 이중 합산하지 않습니다.',
      '캠페인 생성은 MAX 범위가 아닙니다.',
      'sdk-integration-config는 광고 단위 ID·패키지와 SDK Key 설정 여부(sdkKeyConfigured)만 반환합니다. SDK Key 값은 vault에 남고 요약·매니페스트·작업 이력에 넣지 않습니다. Android/iOS는 공식 initializer를 안내하며 iOS에 AndroidManifest를 쓰지 않습니다.',
    ],
  },
  async execute(operation, input, ctx) {
    if (operation === 'check') {
      await ctx.request(`${HOST}/ad_units?limit=1`, { headers: auth(ctx) });
      return { summary: { connected: true } };
    }
    if (operation === 'list-ad-units') return listAdUnits(ctx);
    if (operation === 'sync') {
      const listed = await listAdUnits(ctx);
      let revenue: ConnectorResult = { summary: {}, metrics: [] };
      try { revenue = await revenueMetrics(ctx); }
      catch (error) {
        if ((error as AppError).code !== 'AUTH_REQUIRED') throw error;
      }
      return { resources: listed.resources, metrics: revenue.metrics, summary: { ...listed.summary, ...revenue.summary } };
    }
    if (operation === 'sdk-integration-config') {
      const listed = await listAdUnits(ctx);
      return { resources: listed.resources, summary: maxSdkConfig(listed.resources ?? [], ctx.credentials.sdkKey) };
    }
    if (operation === 'create-ad-unit') return createAdUnit(input, ctx);
    if (operation === 'update-ad-unit') return updateAdUnit(input, ctx);
    throw new AppError('UNSUPPORTED_OPERATION', 'AppLovin MAX에서 지원하지 않는 작업입니다. 캠페인 작업은 applovin-ads 연결을 사용하세요.');
  },
};
