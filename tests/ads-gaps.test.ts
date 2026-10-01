import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AppError } from '../packages/domain/errors.js';
import { DEFAULT_POLICY, type Connection, type Project } from '../packages/domain/index.js';
import { googleAdsConnector } from '../packages/connectors/google-ads.js';
import { applovinAdsConnector } from '../packages/connectors/applovin-ads.js';
import type { AttributionInput, ConnectorContext, ConnectorResult, ProviderRequest, VerifiedArtifact } from '../packages/connectors/types.js';
import { daysAgo } from '../packages/connectors/marketing-utils.js';

interface Recorded { url: string; options: ProviderRequest }
const directories: string[] = [];
after(() => Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))));

async function workDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ads-gaps-'));
  directories.push(directory);
  return directory;
}

function png(width: number, height: number, padding = 64): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(padding, 7)]);
}

async function artifact(bytes: Buffer, name = 'hero.png'): Promise<VerifiedArtifact> {
  const path = join(await workDirectory(), name);
  await writeFile(path, bytes);
  return { path, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'file' };
}

async function createContext(options: {
  provider: Connection['provider'];
  credentials?: Record<string, string>;
  accountId?: string;
  appIdentifier?: string;
  artifact?: VerifiedArtifact;
  handler: (url: string, request: ProviderRequest) => unknown;
}): Promise<{ context: ConnectorContext; requests: Recorded[]; checkpoints: Array<Record<string, unknown>> }> {
  const directory = await workDirectory();
  const requests: Recorded[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  const connection: Connection = {
    id: 'conn-1', provider: options.provider, label: 'test', accountId: options.accountId ?? '1234567890',
    status: 'connected', createdAt: now, updatedAt: now, lastCheckedAt: null, lastError: null, authKind: 'test', credentialFields: [],
  };
  const project: Project | undefined = options.appIdentifier === undefined ? undefined : {
    id: 'proj-1', createdAt: now, updatedAt: now, policy: DEFAULT_POLICY, rootPath: directory, name: 'demo', engine: 'unknown', engineVersion: null,
    appIdentifier: options.appIdentifier, targets: [], findings: [], inspectedAt: now,
  };
  const context: ConnectorContext = {
    connection, credentials: { ...(options.credentials ?? {}) }, project, artifact: options.artifact,
    signal: new AbortController().signal, workDirectory: directory,
    markDispatched: () => undefined,
    checkpoint: data => { checkpoints.push({ ...data }); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'oauth-access-token',
    request: async <T>(url: string, request: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      return options.handler(url, request) as T;
    },
    progress: () => undefined,
  };
  return { context, requests, checkpoints };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try { await promise; }
  catch (error) {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}`);
}

const query = (request: ProviderRequest) => String((request.json as { query?: string } | undefined)?.query ?? '');
const CREATIVE_INPUT = { externalId: '555', headlines: '["헤드라인 하나","헤드라인 둘"]', descriptions: '["설명 문구"]' };

function googleHandler(state: { assets: Map<string, string>; loseMutate?: boolean; assetMutates: number }) {
  return (url: string, request: ProviderRequest) => {
    if (url.endsWith('googleAds:search')) {
      const q = query(request);
      if (q.includes('FROM customer')) return { results: [{ customer: { id: '1234567890', currencyCode: 'USD', timeZone: 'UTC', descriptiveName: 't' } }] };
      if (q.includes('FROM asset')) {
        const name = q.match(/asset\.name = '([^']+)'/)?.[1] ?? '';
        const resourceName = state.assets.get(name);
        return { results: resourceName ? [{ asset: { resourceName, name, type: 'IMAGE' } }] : [] };
      }
      return { results: [{ campaign: { id: '555', name: 'Harbor UA', status: 'PAUSED', resourceName: 'customers/1234567890/campaigns/555' }, campaignBudget: { amountMicros: '1', explicitlyShared: false } }] };
    }
    if (url.endsWith('/assets:mutate')) {
      state.assetMutates += 1;
      const name = (request.json as { operations: Array<{ create: { name: string } }> }).operations[0]!.create.name;
      state.assets.set(name, 'customers/1234567890/assets/777');
      if (state.loseMutate) { state.loseMutate = false; throw new AppError('TEMPORARY', 'response lost', 503); }
      return { results: [{ resourceName: 'customers/1234567890/assets/777' }] };
    }
    if (url.endsWith('googleAds:mutate')) return { mutateOperationResponses: [] };
    throw new Error(url);
  };
}

function appAdImages(requests: Recorded[]): unknown {
  const mutate = requests.filter(item => item.url.endsWith('googleAds:mutate')).at(-1)!;
  const ops = (mutate.options.json as { mutateOperations: Array<{ adGroupAdOperation?: { create: { ad: { appAd: { images?: unknown } } } } }> }).mutateOperations;
  return ops.find(item => item.adGroupAdOperation)!.adGroupAdOperation!.create.ad.appAd.images;
}

test('Google Ads create-creative uploads a verified project image through AssetService and links it to the AppAd', async () => {
  const bytes = png(1200, 1200);
  const file = await artifact(bytes);
  const state = { assets: new Map<string, string>(), assetMutates: 0 };
  const { context, requests, checkpoints } = await createContext({ provider: 'google-ads', artifact: file, handler: googleHandler(state) });
  const result = await googleAdsConnector.execute('create-creative', { ...CREATIVE_INPUT, mediaAssetId: 'media-1' }, context);
  const upload = requests.find(item => item.url.endsWith('/v25/customers/1234567890/assets:mutate'));
  assert.ok(upload);
  assert.equal(upload!.options.write, true);
  assert.equal(upload!.options.method, 'POST');
  const create = (upload!.options.json as { operations: Array<{ create: Record<string, unknown> }> }).operations[0]!.create;
  assert.equal(create.name, `gso-image-${file.sha256}`);
  assert.equal(create.type, 'IMAGE');
  assert.equal((create.imageAsset as { data: string }).data, bytes.toString('base64'));
  // 이름 검색(읽기)이 업로드(쓰기)보다 먼저다.
  const searchIndex = requests.findIndex(item => query(item.options).includes('FROM asset'));
  assert.ok(searchIndex >= 0 && searchIndex < requests.indexOf(upload!));
  assert.equal(requests[searchIndex]!.options.write, false);
  assert.deepEqual(appAdImages(requests), [{ asset: 'customers/1234567890/assets/777' }]);
  assert.equal(checkpoints.find(item => item.stage === 'image-asset')?.assetResourceName, 'customers/1234567890/assets/777');
  assert.deepEqual(result.summary.imageAsset, { resourceName: 'customers/1234567890/assets/777', name: `gso-image-${file.sha256}`, reused: false, sha256: file.sha256, width: 1200, height: 1200, aspectRatio: '1:1' });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(bytes.toString('base64')), false);
  assert.equal(serialized.includes('oauth-access-token'), false);
  assert.equal(serialized.includes(file.path), false);
});

test('Google Ads image upload reuses the deterministic asset after a lost mutate response', async () => {
  const file = await artifact(png(1200, 628));
  const state = { assets: new Map<string, string>(), loseMutate: true, assetMutates: 0 };
  const first = await createContext({ provider: 'google-ads', artifact: file, handler: googleHandler(state) });
  await expectCode(googleAdsConnector.execute('create-creative', { ...CREATIVE_INPUT, mediaAssetId: 'media-1' }, first.context), 'TEMPORARY');
  assert.equal(first.requests.some(item => item.url.endsWith('googleAds:mutate')), false);
  const retry = await createContext({ provider: 'google-ads', artifact: file, handler: googleHandler(state) });
  const result = await googleAdsConnector.execute('create-creative', { ...CREATIVE_INPUT, mediaAssetId: 'media-1' }, retry.context);
  assert.equal(state.assetMutates, 1);
  assert.equal(retry.requests.some(item => item.url.endsWith('/assets:mutate')), false);
  assert.equal((result.summary.imageAsset as { reused: boolean; aspectRatio: string }).reused, true);
  assert.equal((result.summary.imageAsset as { aspectRatio: string }).aspectRatio, '1.91:1');
  assert.deepEqual(appAdImages(retry.requests), [{ asset: 'customers/1234567890/assets/777' }]);
});

// 관리자 계정 여부 조회(읽기)만 허용한다. 이미지 검사는 캠페인 조회·업로드 전에 끝나야 한다.
function accountOnly(_url: string, request: ProviderRequest): unknown {
  if (query(request).includes('FROM customer')) return { results: [{ customer: { id: '1234567890', currencyCode: 'USD', timeZone: 'UTC' } }] };
  throw new Error('no campaign or upload request expected');
}

test('Google Ads rejects oversize, off-ratio, undersized, WebP, missing, or changed images before campaign reads or uploads', async () => {
  const cases: Array<[Buffer | undefined, string]> = [
    [png(1200, 1200, 5 * 1024 * 1024), 'INVALID_IMAGE'],
    [png(1000, 300), 'INVALID_IMAGE'],
    [png(150, 150), 'INVALID_IMAGE'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)]), 'INVALID_IMAGE'],
    [undefined, 'ARTIFACT_REQUIRED'],
  ];
  for (const [bytes, code] of cases) {
    const { context, requests } = await createContext({ provider: 'google-ads', artifact: bytes ? await artifact(bytes) : undefined, handler: accountOnly });
    const error = await expectCode(googleAdsConnector.execute('create-creative', { ...CREATIVE_INPUT, mediaAssetId: 'media-1' }, context), code);
    assert.ok(requests.every(item => query(item.options).includes('FROM customer') && item.options.write === false), error.message);
  }
  const file = await artifact(png(1200, 1200));
  await writeFile(file.path, png(1200, 1200, 65));
  const changed = await createContext({ provider: 'google-ads', artifact: file, handler: accountOnly });
  await expectCode(googleAdsConnector.execute('create-creative', { ...CREATIVE_INPUT, mediaAssetId: 'media-1' }, changed.context), 'MEDIA_CHANGED');
  assert.ok(changed.requests.every(item => query(item.options).includes('FROM customer')));
});

function attributionHandler(options: { downloadActions: boolean }) {
  return (url: string, request: ProviderRequest) => {
    const q = query(request);
    if (q.includes('FROM customer')) return { results: [{ customer: { id: '1234567890', currencyCode: 'KRW', timeZone: 'Asia/Seoul', descriptiveName: 't' } }] };
    if (q.includes('FROM conversion_action')) return { results: options.downloadActions ? [{ conversionAction: { id: '1' } }] : [] };
    if (q.includes("conversion_action_category = 'DOWNLOAD'")) return { results: [{ campaign: { id: '7' }, segments: { date: '2026-09-20' }, metrics: { conversions: '4' } }] };
    if (q.includes('conversions_value')) {
      return { results: [
        { campaign: { id: '7', appCampaignSetting: { appId: 'com.harbor.game' } }, segments: { date: '2026-09-20' }, metrics: { costMicros: '12500000', conversions: '6.5', conversionsValue: 30.25, clicks: '40', impressions: '1000' } },
        { campaign: { id: '8' }, segments: { date: '2026-09-20' }, metrics: { costMicros: '999', conversions: '1', conversionsValue: 1, clicks: '1', impressions: '1' } },
      ] };
    }
    if (q.includes('cost_micros')) return { results: [{ segments: { date: '2026-09-20' }, metrics: { costMicros: '12500999' }, campaign: { appCampaignSetting: { appId: 'com.harbor.game' } } }] };
    if (q.includes('FROM campaign')) return { results: [{ campaign: { id: '7', name: 'UA', status: 'ENABLED' }, campaignBudget: { amountMicros: '1' } }] };
    throw new Error(url);
  };
}

function byKind(facts: AttributionInput[]): Record<string, AttributionInput> {
  return Object.fromEntries(facts.map(fact => [fact.kind, fact]));
}

test('Google Ads sync emits deterministic App campaign attribution facts without changing spend metrics', async () => {
  const { context, requests } = await createContext({ provider: 'google-ads', handler: attributionHandler({ downloadActions: true }) });
  const result = await googleAdsConnector.execute('sync', {}, context);
  assert.deepEqual(result.metrics?.map(metric => [metric.kind, metric.amountMicros, metric.sourceId]), [['spend', '12500999', 'google-ads:spend:1234567890:com.harbor.game:2026-09-20']]);
  const facts = result.attribution ?? [];
  assert.equal(facts.length, 6, 'non-app campaign row is excluded');
  const kinds = byKind(facts);
  assert.deepEqual(Object.keys(kinds).sort(), ['clicks', 'conversions', 'impressions', 'installs', 'revenue', 'spend']);
  for (const fact of facts) {
    assert.equal(fact.campaignId, '7');
    assert.equal(fact.acquisitionDate, '2026-09-20');
    assert.equal(fact.eventDate, '2026-09-20');
    assert.equal(fact.cohortKey, 'gads:7:2026-09-20');
    assert.equal(fact.attributionWindowDays, 0);
    assert.equal(fact.finality, 'estimated');
    assert.equal(fact.revision, 1);
    assert.equal(fact.sourceWatermark, '2026-09-20');
    assert.equal(fact.appIdentifier, 'com.harbor.game');
    assert.equal(fact.experimentId, undefined);
    assert.equal(fact.sourceId, `google-ads:campaign:1234567890:7:2026-09-20:${fact.kind}`);
  }
  assert.deepEqual([kinds.spend!.currency, kinds.spend!.amountMicros], ['KRW', '12500000']);
  assert.deepEqual([kinds.revenue!.revenueBasis, kinds.revenue!.amountMicros], ['gross_conversion_value', '30250000']);
  assert.equal(kinds.installs!.count, 4);
  assert.equal(kinds.conversions!.count, 6.5);
  assert.equal(kinds.clicks!.count, 40);
  assert.equal(kinds.impressions!.count, 1000);
  assert.equal(result.summary.installsBasis, 'download_conversion_actions');
  assert.ok(requests.every(item => item.options.write === false));
  const again = await googleAdsConnector.execute('sync', {}, (await createContext({ provider: 'google-ads', handler: attributionHandler({ downloadActions: true }) })).context);
  assert.deepEqual(again.attribution?.map(fact => fact.sourceId), facts.map(fact => fact.sourceId));
});

test('Google Ads campaign-attribution falls back to all conversions for installs and bounds the range', async () => {
  const { context, requests } = await createContext({ provider: 'google-ads', handler: attributionHandler({ downloadActions: false }) });
  const result = await googleAdsConnector.execute('campaign-attribution', { startDate: '2026-09-01', endDate: '2026-09-20' }, context);
  assert.equal(result.summary.installsBasis, 'all_conversions_fallback');
  assert.equal(byKind(result.attribution ?? []).installs!.count, 6.5);
  assert.equal(result.metrics, undefined);
  assert.equal(requests.some(item => query(item.options).includes('conversion_action_category')), false);
  assert.ok(requests.some(item => query(item.options).includes("segments.date BETWEEN '2026-09-01' AND '2026-09-20'")));
  await expectCode(googleAdsConnector.execute('campaign-attribution', { startDate: '2026-01-01', endDate: '2026-09-20' }, context), 'INVALID_INPUT');
  await expectCode(googleAdsConnector.execute('campaign-attribution', { startDate: '2026-09-31' }, context), 'INVALID_INPUT');
  assert.ok(googleAdsConnector.capability.operations.includes('campaign-attribution'));
  assert.ok(googleAdsConnector.capability.operationFields?.['create-creative']?.some(field => field.key === 'mediaAssetId'));
});

// ---- AppLovin ----
const APPLOVIN = { accountId: '99', campaignManagementKey: 'cm-secret-key', reportKey: 'report-secret-key' };
const CAMPAIGN = { id: '7', name: 'UA', status: 'LIVE', package_name: 'com.harbor.game', budget: { daily_budget_for_all_countries: '50' } };

interface AxonState {
  images: Array<Record<string, unknown>>;
  assets: Record<string, Record<string, unknown>>;
  sets: Array<Record<string, unknown>>;
  uploadStatus: 'FINISHED' | 'PENDING';
  uploads: number;
}

function axonHandler(state: AxonState) {
  return (url: string, request: ProviderRequest) => {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    assert.equal(request.headers?.Authorization, 'cm-secret-key');
    assert.equal(params.get('account_id'), '99');
    switch (parsed.pathname) {
      case '/manage/v1/campaign/list': return params.get('ids') ? [{ ...CAMPAIGN, id: params.get('ids') }] : [CAMPAIGN];
      case '/manage/v1/asset/list':
        if (params.get('resource_type') === 'image') return state.images;
        return (params.get('ids') ?? '').split(',').flatMap(id => state.assets[id] ? [state.assets[id]] : []);
      case '/manage/v1/asset/upload': {
        state.uploads += 1;
        assert.ok(request.body instanceof FormData);
        assert.equal(request.json, undefined);
        assert.equal(request.write, true);
        return { upload_id: 'c7a3db4226b24bd8bb0b38c46654aa54' };
      }
      case '/manage/v1/asset/upload_result':
        assert.equal(params.get('upload_id'), 'c7a3db4226b24bd8bb0b38c46654aa54');
        return state.uploadStatus === 'PENDING'
          ? { upload_status: 'PENDING', details: [{ file_status: 'PENDING', name: 'x.png' }] }
          : { upload_status: 'FINISHED', details: [{ id: '900', file_status: 'SUCCESS', resource_type: 'IMAGE' }] };
      case '/manage/v1/creative_set/list_by_campaign_id':
        return { campaign_count: 1, creative_set_count: state.sets.length, campaigns: { [params.get('ids')!]: state.sets } };
      case '/manage/v1/creative_set/list': {
        const ids = params.get('ids');
        return ids ? state.sets.filter(item => item.id === ids) : state.sets;
      }
      case '/manage/v1/creative_set/create': {
        const body = request.json as Record<string, unknown>;
        const set = { ...body, id: '555', campaign_id: body.campaign_id, assets: (body.assets as Array<{ id: string }>).map(item => state.assets[item.id] ?? item) };
        state.sets.push(set);
        return { id: '555', version: 'V2' };
      }
      case '/manage/v1/creative_set/update': {
        const body = request.json as Record<string, unknown>;
        const index = state.sets.findIndex(item => item.id === body.id);
        state.sets[index] = { ...state.sets[index], ...body, ...(body.assets ? { assets: (body.assets as Array<{ id: string }>).map(item => state.assets[item.id] ?? item) } : {}) };
        return { id: body.id, version: 'V2' };
      }
      default: throw new Error(url);
    }
  };
}

function axonState(overrides: Partial<AxonState> = {}): AxonState {
  return {
    images: [], sets: [], uploadStatus: 'FINISHED', uploads: 0,
    assets: {
      '900': { id: '900', name: 'gso.png', status: 'IN_REVIEW', asset_type: 'IMG_INTER_P', resource_type: 'IMAGE' },
      '901': { id: '901', name: 'clip.mp4', status: 'ACTIVE', asset_type: 'VID_LONG_P', resource_type: 'VIDEO' },
      '902': { id: '902', name: 'banner.png', status: 'ACTIVE', asset_type: 'IMG_BANNER', resource_type: 'IMAGE' },
      '903': { id: '903', name: 'bad.mp4', status: 'REJECTED', asset_type: 'VID_SHORT_P', resource_type: 'VIDEO', violation_reasons: ['misleading'] },
      '905': { id: '905', name: 'playable.html', status: 'ACTIVE', asset_type: 'HOSTED_HTML', resource_type: 'HTML' },
    },
    ...overrides,
  };
}

test('AppLovin create-creative uploads the project image, validates composition, and creates a PAUSED creative set', async () => {
  const bytes = png(1080, 1920);
  const file = await artifact(bytes);
  const state = axonState();
  const { context, requests, checkpoints } = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, artifact: file, appIdentifier: 'com.harbor.game', handler: axonHandler(state) });
  const result = await applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'Harbor portrait', assetIds: '["901"]', mediaAssetId: 'media-1', languages: 'english,KOREAN', countries: 'US,KR' }, context);
  const upload = requests.find(item => item.url.includes('/asset/upload?'))!;
  const form = upload.options.body as FormData;
  const part = form.get('files') as File;
  assert.equal(part.name, `gso-${file.sha256.slice(0, 32)}.png`);
  assert.equal(part.type, 'image/png');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes);
  assert.equal(checkpoints.find(item => item.stage === 'asset-upload')?.sha1, createHash('sha1').update(bytes).digest('hex'));
  const create = requests.find(item => item.url.includes('/creative_set/create'))!;
  assert.equal(create.options.write, true);
  assert.deepEqual(create.options.json, { campaign_id: '7', type: 'APP', name: 'Harbor portrait', assets: [{ id: '901' }, { id: '900' }], status: 'PAUSED', languages: ['ENGLISH', 'KOREAN'], countries: ['US', 'KR'] });
  assert.equal(result.resources?.[0]?.kind, 'creative');
  assert.equal(result.resources?.[0]?.externalId, '555');
  assert.deepEqual(result.resources?.[0]?.data.assetIds, ['901', '900']);
  assert.equal(result.summary.created, true);
  assert.equal(result.summary.uploadedAssetId, '900');
  assert.equal(checkpoints.at(-1)?.creativeSetId, '555');
  const serialized = JSON.stringify(result);
  for (const secret of ['cm-secret-key', 'report-secret-key']) assert.equal(serialized.includes(secret), false);

  // 재실행: 같은 해시 asset과 같은 이름의 세트를 재사용하고 다시 쓰지 않는다.
  state.images = [{ id: '900', status: 'IN_REVIEW', asset_hash: createHash('sha1').update(bytes).digest('hex').toUpperCase() }];
  const retry = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, artifact: file, handler: axonHandler(state) });
  const reused = await applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'Harbor portrait', assetIds: '["901"]', mediaAssetId: 'media-1' }, retry.context);
  assert.equal(reused.summary.reused, true);
  assert.equal(reused.summary.assetReused, true);
  assert.equal(state.uploads, 1);
  assert.equal(retry.requests.some(item => item.options.write), false);
  // 같은 이름이지만 다른 구성이면 중복 생성 대신 거부한다.
  await expectCode(applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'Harbor portrait', assetIds: '["905"]' }, retry.context), 'RECONCILIATION_REQUIRED');
  assert.equal(retry.requests.some(item => item.options.write), false);
});

test('AppLovin create-creative waits on pending uploads and refuses invalid compositions before creating', async () => {
  const file = await artifact(png(1080, 1920));
  const pending = axonState({ uploadStatus: 'PENDING' });
  const first = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, artifact: file, handler: axonHandler(pending) });
  const waiting = await applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'P', assetIds: '["901"]', mediaAssetId: 'media-1' }, first.context);
  assert.equal(waiting.waitingExternal, true);
  assert.equal(waiting.summary.uploadId, 'c7a3db4226b24bd8bb0b38c46654aa54');
  assert.equal(first.requests.some(item => item.url.includes('/creative_set/create')), false);
  const reconciled = await applovinAdsConnector.execute('reconcile', { uploadId: 'c7a3db4226b24bd8bb0b38c46654aa54' }, first.context);
  assert.equal(reconciled.waitingExternal, true);
  pending.uploadStatus = 'FINISHED';
  const finished = await applovinAdsConnector.execute('reconcile', { uploadId: 'c7a3db4226b24bd8bb0b38c46654aa54' }, first.context);
  assert.deepEqual([finished.summary.assetId, finished.summary.confirmed, finished.waitingExternal], ['900', false, undefined]);

  const state = axonState();
  const { context, requests } = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, handler: axonHandler(state) });
  await expectCode(applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'Only image', assetIds: '["900"]' }, context), 'CREATIVE_REQUIRED');
  await expectCode(applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'Banner', assetIds: '["902","901"]' }, context), 'CREATIVE_REQUIRED');
  await expectCode(applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'Rejected', assetIds: '["900","903"]' }, context), 'ASSET_REJECTED');
  await expectCode(applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'Missing', assetIds: '["900","999"]' }, context), 'RESOURCE_NOT_FOUND');
  await expectCode(applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'X', assetIds: '["901"]', languages: 'KLINGON' }, context), 'INVALID_INPUT');
  await expectCode(applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'X' }, context), 'CREATIVE_REQUIRED');
  assert.equal(requests.some(item => item.options.write), false);
  const other = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, appIdentifier: 'com.other.game', handler: axonHandler(state) });
  await expectCode(applovinAdsConnector.execute('create-creative', { externalId: '7', name: 'X', assetIds: '["900","901"]' }, other.context), 'RESOURCE_MISMATCH');
  assert.equal(other.requests.some(item => item.options.write), false);
});

test('AppLovin list-creatives and update-creative keep campaign scope and append uploaded images', async () => {
  const state = axonState({ sets: [{ id: '555', campaign_id: '7', type: 'APP', name: 'S', status: 'PAUSED', assets: [{ id: '900', asset_type: 'IMG_INTER_P' }, { id: '901', asset_type: 'VID_LONG_P' }], languages: ['ENGLISH'], countries: [] }] });
  const { context, requests } = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, handler: axonHandler(state) });
  const scoped = await applovinAdsConnector.execute('list-creatives', { externalId: '7' }, context);
  assert.equal(scoped.resourceSnapshots, undefined);
  assert.equal(scoped.resources?.[0]?.data.campaignId, '7');
  const all = await applovinAdsConnector.execute('list-creatives', {}, context);
  assert.deepEqual(all.resourceSnapshots, [{ kind: 'creative' }]);
  assert.ok(requests.every(item => item.options.write === undefined || item.options.write === false));

  const file = await artifact(png(1080, 1920, 99));
  state.assets['904'] = { id: '904', status: 'IN_REVIEW', asset_type: 'IMG_INTER_P', resource_type: 'IMAGE' };
  state.images = [{ id: '904', status: 'IN_REVIEW', asset_hash: createHash('sha1').update(png(1080, 1920, 99)).digest('hex') }];
  const updating = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, artifact: file, handler: axonHandler(state) });
  const updated = await applovinAdsConnector.execute('update-creative', { externalId: '7', creativeSetId: '555', status: 'LIVE', mediaAssetId: 'media-2' }, updating.context);
  const body = updating.requests.find(item => item.url.includes('/creative_set/update'))!.options.json;
  assert.deepEqual(body, { id: '555', campaign_id: '7', type: 'APP', status: 'LIVE', assets: [{ id: '900' }, { id: '901' }, { id: '904' }] });
  assert.equal(updated.resources?.[0]?.status, 'LIVE');
  assert.deepEqual(updated.summary.changed, ['status', 'assets']);
  await expectCode(applovinAdsConnector.execute('update-creative', { externalId: '8', creativeSetId: '555', status: 'PAUSED' }, context), 'RESOURCE_MISMATCH');
  await expectCode(applovinAdsConnector.execute('update-creative', { externalId: '7', creativeSetId: '555' }, context), 'INVALID_INPUT');
  for (const operation of ['list-creatives', 'create-creative', 'update-creative', 'campaign-attribution']) {
    assert.ok(applovinAdsConnector.capability.operations.includes(operation));
    assert.ok(applovinAdsConnector.capability.operationFields?.[operation]);
  }
});

function reportHandler(options: { rejectCohort?: boolean } = {}) {
  const recent = daysAgo(1);
  const old = daysAgo(10);
  return (url: string) => {
    const parsed = new URL(url);
    if (parsed.origin === 'https://api.ads.axon.ai') return [CAMPAIGN];
    assert.equal(parsed.origin + parsed.pathname, 'https://r.applovin.com/report');
    assert.equal(parsed.searchParams.get('api_key'), 'report-secret-key');
    assert.equal(parsed.searchParams.get('report_type'), 'advertiser');
    const columns = parsed.searchParams.get('columns')!;
    if (parsed.searchParams.get('day_column') === 'day') {
      if (options.rejectCohort) throw new AppError('PROVIDER_REJECTED', '서비스가 입력 또는 현재 상태를 허용하지 않았습니다 (HTTP 400).', 422);
      assert.equal(columns, 'day,campaign_id_external,campaign_package_name,total_rev_0d,total_rev_1d,total_rev_3d,total_rev_7d,total_rev_14d,total_rev_28d');
      return { results: [
        { day: old, campaign_id_external: 'c7', campaign_package_name: 'com.harbor.game', total_rev_0d: '1.5', total_rev_1d: '2', total_rev_3d: '3.25', total_rev_7d: '5', total_rev_14d: '6', total_rev_28d: '7' },
        { day: old, campaign_id_external: null, total_rev_0d: '100' },
      ] };
    }
    if (columns === 'day,cost,campaign_id_external,campaign_package_name') return [{ day: recent, cost: '12.5', campaign_id_external: 'c7', campaign_package_name: 'com.harbor.game' }];
    assert.equal(columns, 'day,campaign_id_external,campaign_package_name,cost,conversions,impressions,clicks');
    return [
      { day: recent, campaign_id_external: 'c7', campaign_package_name: 'com.harbor.game', cost: '10', conversions: '3', impressions: '500', clicks: '20' },
      { day: recent, campaign_id_external: 'c7', campaign_package_name: 'com.harbor.game', cost: '2.5', conversions: 1, impressions: 100, clicks: 5 },
    ];
  };
}

test('AppLovin sync emits campaign spend/install facts and completed cohort revenue windows', async () => {
  const { context } = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, handler: reportHandler() });
  const result = await applovinAdsConnector.execute('sync', {}, context);
  assert.deepEqual(result.metrics?.map(metric => [metric.kind, metric.amountMicros, metric.sourceId]), [['spend', '12500000', `applovin-ads:spend:c7:${daysAgo(1)}`]]);
  const facts = result.attribution ?? [];
  const realtime = facts.filter(fact => fact.kind !== 'revenue');
  assert.deepEqual(realtime.map(fact => [fact.kind, fact.amountMicros ?? fact.count]), [['spend', '12500000'], ['installs', 4], ['clicks', 25], ['impressions', 600]]);
  for (const fact of realtime) {
    assert.deepEqual([fact.campaignId, fact.acquisitionDate, fact.attributionWindowDays, fact.cohortKey, fact.appIdentifier], ['c7', daysAgo(1), 0, `applovin:c7:${daysAgo(1)}`, 'com.harbor.game']);
    assert.equal(fact.sourceId, `applovin-ads:campaign:99:c7:${daysAgo(1)}:${fact.kind}`);
  }
  const revenue = facts.filter(fact => fact.kind === 'revenue');
  assert.deepEqual(revenue.map(fact => [fact.attributionWindowDays, fact.amountMicros]), [[0, '1500000'], [1, '2000000'], [3, '3250000'], [7, '5000000']], '14d/28d cohort windows are not complete yet');
  for (const fact of revenue) {
    assert.deepEqual([fact.currency, fact.revenueBasis, fact.finality, fact.revision, fact.acquisitionDate, fact.eventDate, fact.sourceWatermark], ['USD', 'gross_conversion_value', 'estimated', 1, daysAgo(10), daysAgo(10), daysAgo(10)]);
    assert.equal(fact.sourceId, `applovin-ads:campaign:99:c7:${daysAgo(10)}:revenue:${fact.attributionWindowDays}d`);
  }
  assert.equal(result.summary.attributionFacts, facts.length);
  assert.equal(JSON.stringify(result).includes('report-secret-key'), false);
  const again = await applovinAdsConnector.execute('sync', {}, (await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, handler: reportHandler() })).context);
  assert.deepEqual(again.attribution?.map(fact => fact.sourceId), facts.map(fact => fact.sourceId));
});

test('AppLovin cohort rejection keeps sync spend facts but fails the explicit attribution operation', async () => {
  const { context } = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: APPLOVIN, handler: reportHandler({ rejectCohort: true }) });
  const synced: ConnectorResult = await applovinAdsConnector.execute('sync', {}, context);
  assert.equal(synced.summary.cohortRevenue, 'unavailable');
  assert.equal(synced.attribution?.some(fact => fact.kind === 'revenue'), false);
  assert.equal(synced.attribution?.some(fact => fact.kind === 'spend'), true);
  await expectCode(applovinAdsConnector.execute('campaign-attribution', {}, context), 'PROVIDER_REJECTED');
  await expectCode(applovinAdsConnector.execute('campaign-attribution', { startDate: daysAgo(60) }, context), 'INVALID_INPUT');
  const noKey = await createContext({ provider: 'applovin-ads', accountId: '99', credentials: { accountId: '99', campaignManagementKey: 'cm-secret-key' }, handler: reportHandler() });
  await expectCode(applovinAdsConnector.execute('campaign-attribution', {}, noKey.context), 'AUTH_REQUIRED');
  const syncedWithoutKey = await applovinAdsConnector.execute('sync', {}, noKey.context);
  assert.deepEqual(syncedWithoutKey.attribution, []);
});
