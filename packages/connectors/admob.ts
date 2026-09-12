import { AppError } from '../domain/errors.js';
import type { Connector, ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { daysAgo, ymd } from './marketing-utils.js';
import { admobSdkConfig } from './sdk-integration.js';

const HOST = 'https://admob.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/admob.readonly';

function publisherId(ctx: ConnectorContext): string {
  const raw = ctx.credentials.publisherId || ctx.connection.accountId;
  const id = raw.startsWith('pub-') ? raw : `pub-${raw.replace(/^pub-/, '')}`;
  if (!/^pub-\d{16}$/.test(id) && !/^pub-\d+$/.test(id)) throw new AppError('INVALID_INPUT', 'AdMob publisher ID (pub-…)가 필요합니다.');
  return id;
}

function parent(ctx: ConnectorContext): string {
  return `accounts/${publisherId(ctx)}`;
}

async function headers(ctx: ConnectorContext): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await ctx.accessToken([SCOPE])}` };
}

async function account(ctx: ConnectorContext): Promise<{ name: string; publisherId: string; currencyCode: string; reportingTimeZone: string }> {
  const data = await ctx.request<Record<string, unknown>>(`${HOST}/${parent(ctx)}`, { headers: await headers(ctx) });
  const currency = String(data.currencyCode ?? '');
  const timeZone = String(data.reportingTimeZone ?? '');
  if (!currency || !timeZone) throw new AppError('INVALID_PROVIDER_RESPONSE', 'AdMob 계정 통화 또는 보고 시간대를 확인할 수 없습니다.');
  return {
    name: String(data.name ?? parent(ctx)),
    publisherId: String(data.publisherId ?? publisherId(ctx)),
    currencyCode: currency,
    reportingTimeZone: timeZone,
  };
}

async function paginate<T>(ctx: ConnectorContext, path: string, field: string): Promise<T[]> {
  const items: T[] = [];
  let pageToken = '';
  const seen = new Set<string>();
  do {
    if (seen.has(pageToken) || seen.size >= 50) throw new AppError('PAGINATION_LIMIT', 'AdMob 목록이 너무 큽니다.');
    seen.add(pageToken);
    const query = new URLSearchParams({ pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
    const data = await ctx.request<Record<string, unknown>>(`${HOST}/${path}?${query}`, { headers: await headers(ctx) });
    const rows = data[field];
    if (rows !== undefined && !Array.isArray(rows)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'AdMob 목록 응답 형식을 확인할 수 없습니다.');
    items.push(...((rows ?? []) as T[]));
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
  } while (pageToken);
  return items;
}

/** Official v1 AppApprovalState (developers.google.com/admob/api/reference/rest/v1/accounts.apps/list, 2026-09-11). ACTION_REQUIRED and IN_REVIEW must not be mapped to ACTIVE. */
function appApprovalStatus(state: unknown): string {
  if (state === 'ACTION_REQUIRED' || state === 'IN_REVIEW') return state;
  if (state === 'APPROVED') return 'ACTIVE';
  return typeof state === 'string' && state.length > 0 ? state : 'APP_APPROVAL_STATE_UNSPECIFIED';
}

async function listApps(ctx: ConnectorContext): Promise<ConnectorResult> {
  const apps = await paginate<Record<string, unknown>>(ctx, `${parent(ctx)}/apps`, 'apps');
  const resources: ResourceInput[] = apps.map(app => {
    const linked = (app.linkedAppInfo ?? {}) as Record<string, unknown>;
    const manual = (app.manualAppInfo ?? {}) as Record<string, unknown>;
    return {
      kind: 'product',
      externalId: String(app.appId ?? app.name ?? ''),
      name: String(linked.displayName ?? manual.displayName ?? app.appId ?? ''),
      status: appApprovalStatus(app.appApprovalState),
      data: { platform: app.platform, appStoreId: linked.appStoreId, admobAppId: app.appId, resourceName: app.name, appApprovalState: app.appApprovalState,
        ...(app.platform === 'ANDROID' && typeof linked.appStoreId === 'string' && /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(linked.appStoreId) ? { packageName: linked.appStoreId } : {}) },
    };
  });
  return { resources, summary: { appCount: resources.length } };
}

async function listAdUnits(ctx: ConnectorContext, apps?: ConnectorResult): Promise<ConnectorResult> {
  const inventory = apps ?? await listApps(ctx);
  const appIdentifiers = new Map((inventory.resources ?? []).map(resource => [resource.externalId, resource.data.packageName]));
  const units = await paginate<Record<string, unknown>>(ctx, `${parent(ctx)}/adUnits`, 'adUnits');
  const resources: ResourceInput[] = units.map(unit => ({
    kind: 'ad-unit',
    externalId: String(unit.adUnitId ?? ''),
    name: String(unit.displayName ?? unit.adUnitId ?? ''),
    status: 'ACTIVE',
    data: { adFormat: unit.adFormat, admobAppId: unit.appId, appIdentifier: appIdentifiers.get(String(unit.appId)), adTypes: unit.adTypes, resourceName: unit.name },
  }));
  return { resources, summary: { adUnitCount: resources.length } };
}

function reportDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return null;
}

async function networkRevenue(ctx: ConnectorContext, apps: ConnectorResult): Promise<ConnectorResult> {
  const appIdentifiers = new Map((apps.resources ?? []).map(resource => [resource.externalId, resource.data.packageName]));
  const info = await account(ctx);
  const start = daysAgo(6);
  const end = ymd();
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const data = await ctx.request<unknown>(`${HOST}/${parent(ctx)}/networkReport:generate`, {
    method: 'POST', headers: await headers(ctx), write: false,
    json: {
      reportSpec: {
        dateRange: { startDate: { year: sy, month: sm, day: sd }, endDate: { year: ey, month: em, day: ed } },
        dimensions: ['DATE', 'APP'],
        metrics: ['ESTIMATED_EARNINGS'],
        localizationSettings: { currencyCode: info.currencyCode },
      },
    },
  });
  const lines = Array.isArray(data) ? data : [];
  const metrics = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    const row = (line as { row?: Record<string, unknown> }).row;
    if (!row) continue;
    const dimensions = (row.dimensionValues ?? {}) as Record<string, { value?: string }>;
    const date = reportDate(String(dimensions.DATE?.value ?? ''));
    const appId = dimensions.APP?.value;
    const earnings = (row.metricValues as { ESTIMATED_EARNINGS?: { microsValue?: string } } | undefined)?.ESTIMATED_EARNINGS?.microsValue;
    if (!date || earnings == null) continue;
    metrics.push({
      date, currency: info.currencyCode, kind: 'revenue' as const, amountMicros: String(earnings),
      basis: 'estimated' as const, sourceId: `admob:network:${info.publisherId}:${appId || 'account'}:${date}`,
      appIdentifier: typeof appIdentifiers.get(appId ?? '') === 'string' ? appIdentifiers.get(appId ?? '') as string : undefined,
    });
  }
  return {
    metrics,
    summary: {
      publisherId: info.publisherId, currency: info.currencyCode, timeZone: info.reportingTimeZone,
      from: start, to: end, rowCount: metrics.length,
      note: 'AdMob 네트워크 ESTIMATED_EARNINGS입니다. MAX 미디에이션 추정 수익과 더하지 마세요.',
    },
  };
}

export const admobConnector: Connector = {
  capability: {
    provider: 'admob', name: 'AdMob', category: 'monetization',
    description: 'AdMob 계정·앱·광고 단위와 네트워크 추정 수익을 조회합니다. v1 안정 API에는 광고 단위 쓰기가 없습니다.',
    authKind: 'Google OAuth (admob.readonly)',
    fields: [
      { key: 'publisherId', label: 'AdMob publisher ID', required: true, placeholder: 'pub-0000000000000000' },
      { key: 'clientId', label: 'Google OAuth 클라이언트 ID' },
      { key: 'clientSecret', label: 'OAuth 클라이언트 시크릿', secret: true },
      { key: 'refreshToken', label: 'OAuth 갱신 토큰', secret: true },
    ],
    operations: ['check', 'sync', 'list-apps', 'list-ad-units', 'sdk-integration-config'],
    operationFields: {
      'create-ad-unit': [{ key: 'name', remove: true }, { key: 'format', remove: true }, { key: 'platform', remove: true }],
      'create-campaign': [{ key: 'name', remove: true }, { key: 'dailyBudgetMicros', remove: true }],
      'sdk-integration-config': [],
    },
    setupUrl: 'https://developers.google.com/admob/api/v1/getting-started',
    limitations: [
      'v1 accounts.adUnits.create는 없습니다. 미지원 create-ad-unit/update-ad-unit/create-campaign을 노출하지 않습니다.',
      'sdk-integration-config는 AdMob App ID·광고 단위 ID와 플랫폼별 설정 키만 반환합니다. Android는 AndroidManifest APPLICATION_ID, iOS는 Info.plist GADApplicationIdentifier입니다. SDK 코드를 설치하지 않습니다.',
      '보고 시간대는 계정 reportingTimeZone이며 통화는 계정 currencyCode입니다.',
      '네트워크 보고만 수집합니다. 미디에이션 AD_SOURCE 보고를 MAX 수익과 합산하지 마세요.',
    ],
  },
  async execute(operation, input, ctx) {
    void input;
    if (operation === 'check') {
      const info = await account(ctx);
      return { summary: { connected: true, ...info } };
    }
    if (operation === 'list-apps') return listApps(ctx);
    if (operation === 'list-ad-units') return listAdUnits(ctx);
    if (operation === 'sdk-integration-config') {
      const apps = await listApps(ctx);
      const units = await listAdUnits(ctx, apps);
      return { resources: [...(apps.resources ?? []), ...(units.resources ?? [])], summary: admobSdkConfig(apps.resources ?? [], units.resources ?? []) };
    }
    if (operation === 'sync') {
      const info = await account(ctx);
      const apps = await listApps(ctx);
      const units = await listAdUnits(ctx, apps);
      const revenue = await networkRevenue(ctx, apps);
      return {
        resources: [...(apps.resources ?? []), ...(units.resources ?? [])],
        metrics: revenue.metrics,
        summary: { ...info, ...apps.summary, ...units.summary, ...revenue.summary },
      };
    }
    throw new AppError('UNSUPPORTED_OPERATION', 'AdMob v1에서 지원하지 않는 작업입니다. 광고 단위 생성은 AdMob UI를 사용하세요.');
  },
};
