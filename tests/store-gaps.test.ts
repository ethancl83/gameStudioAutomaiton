import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { AppError } from '../packages/domain/errors.js';
import { DEFAULT_POLICY, type Connection, type Project } from '../packages/domain/index.js';
import { appStoreConnector } from '../packages/connectors/app-store.js';
import { parseAppleFinanceReport } from '../packages/connectors/apple-finance.js';
import { googlePlayConnector } from '../packages/connectors/google-play.js';
import { isWriteOperation, type ConnectorContext, type ProviderRequest, type VerifiedArtifact } from '../packages/connectors/types.js';

// All provider HTTP goes through a recorded context.request double; nothing reaches a real account.
interface Recorded { url: string; method: string; json: Record<string, any>; write: boolean }
type Handler = (url: URL, request: ProviderRequest) => unknown;

async function context(provider: 'google-play' | 'app-store', handler: Handler, options: { artifact?: VerifiedArtifact; credentials?: Record<string, string> } = {}) {
  const workDirectory = await mkdtemp(join(tmpdir(), 'store-gaps-'));
  const requests: Recorded[] = []; const checkpoints: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  const connection: Connection = { id: 'conn-1', provider, label: 't', accountId: 'a', status: 'connected', createdAt: now, updatedAt: now,
    lastCheckedAt: null, lastError: null, authKind: 'test', credentialFields: [] };
  const project: Project = { id: 'proj-1', createdAt: now, updatedAt: now, policy: DEFAULT_POLICY, rootPath: workDirectory, name: 'demo',
    engine: 'unknown', engineVersion: null, appIdentifier: provider === 'google-play' ? 'com.example.game' : 'com.example.demo', targets: [], findings: [], inspectedAt: now };
  const ctx: ConnectorContext = {
    connection, credentials: options.credentials ?? {}, project, signal: new AbortController().signal, artifact: options.artifact, workDirectory,
    markDispatched: () => undefined, checkpoint: data => { checkpoints.push({ ...data }); }, saveCredentials: async () => undefined,
    accessToken: async () => 'token', progress: () => undefined,
    request: async <T>(url: string, request: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, method: request.method ?? 'GET', json: (request.json ?? {}) as Record<string, any>, write: request.write === true });
      return await handler(new URL(url), request) as T;
    },
  };
  return { ctx, requests, checkpoints, writes: () => requests.filter(item => item.write) };
}

async function rejects(promise: Promise<unknown>, code: string): Promise<AppError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof AppError, String(error)); assert.equal(error.code, code, error.message); return error;
  }
  throw new Error(`expected ${code}`);
}
function unexpected(url: URL, request: ProviderRequest): never { throw new Error(`unexpected ${request.method ?? 'GET'} ${url.pathname}${url.search}`); }

// ---------------------------------------------------------------------------
// Google Play: per-option pricing and sale state
// ---------------------------------------------------------------------------
const PLAY = '/androidpublisher/v3/applications/com.example.game';
const usd = (units: string) => ({ currencyCode: 'USD', units, nanos: 0 });
function oneTime(states: [string, string] = ['ACTIVE', 'DRAFT']) {
  return {
    packageName: 'com.example.game', productId: 'gems', listings: [{ title: 'Gems', languageCode: 'en-US' }],
    purchaseOptions: [
      { purchaseOptionId: 'standard', state: states[0], buyOption: {}, regionalPricingAndAvailabilityConfigs: [
        { regionCode: 'US', availability: 'AVAILABLE', price: usd('1') }, { regionCode: 'CA', availability: 'AVAILABLE', price: { currencyCode: 'CAD', units: '2', nanos: 0 } }] },
      { purchaseOptionId: 'rental', state: states[1], rentOption: { rentalPeriod: 'P7D' }, regionalPricingAndAvailabilityConfigs: [
        { regionCode: 'US', availability: 'AVAILABLE', price: usd('3') }] },
    ],
  };
}
function subscription(state = 'ACTIVE') {
  return { packageName: 'com.example.game', productId: 'vip', listings: [{ title: 'VIP' }], basePlans: [
    { basePlanId: 'monthly', state, autoRenewingBasePlanType: { billingPeriodDuration: 'P1M' }, regionalConfigs: [{ regionCode: 'US', newSubscriberAvailability: true, price: usd('5') }] },
    { basePlanId: 'yearly', state: 'ACTIVE', autoRenewingBasePlanType: { billingPeriodDuration: 'P1Y' }, regionalConfigs: [{ regionCode: 'US', newSubscriberAvailability: true, price: usd('50') }] },
  ] };
}
const converted = { regionVersion: { version: '2026/09' }, convertedRegionPrices: { US: { price: { currencyCode: 'USD', units: '4', nanos: 490000000 } } } };

test('Play sale-state operations are classified as writes; list-products stays a read', () => {
  assert.equal(isWriteOperation('activate-product', 'google-play'), true);
  assert.equal(isWriteOperation('deactivate-product', 'google-play'), true);
  assert.equal(isWriteOperation('create-subscription', 'app-store'), true);
  assert.equal(isWriteOperation('submit-product', 'app-store'), true);
  assert.equal(isWriteOperation('upload-app-preview', 'app-store'), true);
  assert.equal(isWriteOperation('list-products', 'google-play'), false);
  for (const operation of ['activate-product', 'deactivate-product']) assert.ok(googlePlayConnector.capability.operations.includes(operation));
});

test('Play list-products exposes per-option state and regional prices', async () => {
  const { ctx } = await context('google-play', (url, request) => {
    if (url.pathname === PLAY + '/oneTimeProducts') return { oneTimeProducts: [oneTime()] };
    if (url.pathname === PLAY + '/subscriptions') return { subscriptions: [subscription('INACTIVE')] };
    return unexpected(url, request);
  });
  const result = await googlePlayConnector.execute('list-products', {}, ctx);
  const gems = result.resources!.find(item => item.externalId === 'com.example.game:one-time:gems')!;
  assert.equal(gems.status, 'ACTIVE');
  assert.deepEqual(gems.data.options, [
    { optionId: 'standard', state: 'ACTIVE', prices: [
      { regionCode: 'US', currency: 'USD', priceMicros: '1000000', available: true }, { regionCode: 'CA', currency: 'CAD', priceMicros: '2000000', available: true }] },
    { optionId: 'rental', state: 'DRAFT', prices: [{ regionCode: 'US', currency: 'USD', priceMicros: '3000000', available: true }] },
  ]);
  const vip = result.resources!.find(item => item.externalId === 'com.example.game:subscription:vip')!;
  assert.deepEqual((vip.data.options as Array<{ optionId: string; state: string }>).map(item => [item.optionId, item.state]), [['monthly', 'INACTIVE'], ['yearly', 'ACTIVE']]);
});

test('Play update-product targets one purchase option and preserves the other options and regions', async () => {
  const { ctx, writes, checkpoints } = await context('google-play', (url, request) => {
    if (url.pathname === PLAY + '/oneTimeProducts/gems') return oneTime();
    if (url.pathname === PLAY + '/pricing:convertRegionPrices') return converted;
    if (url.pathname === PLAY + '/onetimeproducts/gems' && request.method === 'PATCH') return { ...(request.json as object), purchaseOptions: oneTime().purchaseOptions };
    return unexpected(url, request);
  });
  const result = await googlePlayConnector.execute('update-product',
    { externalId: 'com.example.game:one-time:gems', optionId: 'rental', priceMicros: '4490000', currency: 'USD', country: 'US' }, ctx);
  const [patch] = writes();
  assert.equal(writes().length, 1);
  assert.equal(new URL(patch.url).searchParams.get('updateMask'), 'purchaseOptions');
  const options = patch.json.purchaseOptions as Array<Record<string, any>>;
  assert.deepEqual(options.map(item => item.purchaseOptionId), ['standard', 'rental']);
  assert.ok(options.every(item => !('state' in item)), 'output-only state must not be sent');
  assert.deepEqual(options[0], { purchaseOptionId: 'standard', buyOption: {}, regionalPricingAndAvailabilityConfigs: oneTime().purchaseOptions[0].regionalPricingAndAvailabilityConfigs });
  assert.deepEqual(options[1].regionalPricingAndAvailabilityConfigs, [{ regionCode: 'US', availability: 'AVAILABLE', price: { currencyCode: 'USD', units: '4', nanos: 490000000 } }]);
  assert.equal(result.summary.optionId, 'rental');
  assert.deepEqual(checkpoints.at(-1), { externalId: 'com.example.game:one-time:gems', optionId: 'rental' });
});

test('Play update-product refuses to guess among multiple options or change status with a price', async () => {
  const { ctx, writes } = await context('google-play', (url, request) => {
    if (url.pathname === PLAY + '/oneTimeProducts/gems') return oneTime();
    if (url.pathname === PLAY + '/pricing:convertRegionPrices') return converted;
    return unexpected(url, request);
  });
  const error = await rejects(googlePlayConnector.execute('update-product', { externalId: 'com.example.game:one-time:gems', priceMicros: '4490000', currency: 'USD' }, ctx), 'MULTIPLE_PRICE_OPTIONS');
  assert.deepEqual((error.details as { optionIds: string[] }).optionIds, ['standard', 'rental']);
  await rejects(googlePlayConnector.execute('update-product', { externalId: 'com.example.game:one-time:gems', optionId: 'missing', priceMicros: '4490000', currency: 'USD' }, ctx), 'RESOURCE_NOT_FOUND');
  await rejects(googlePlayConnector.execute('update-product', { externalId: 'com.example.game:one-time:gems', status: 'active', priceMicros: '1', currency: 'USD' }, ctx), 'UNSUPPORTED_CHANGE');
  assert.equal(writes().length, 0);
});

test('Play subscription base plan price change keeps the sibling base plan', async () => {
  const { ctx, writes } = await context('google-play', (url, request) => {
    if (url.pathname === PLAY + '/subscriptions/vip' && request.method !== 'PATCH') return subscription();
    if (url.pathname === PLAY + '/pricing:convertRegionPrices') return converted;
    if (url.pathname === PLAY + '/subscriptions/vip' && request.method === 'PATCH') return subscription();
    return unexpected(url, request);
  });
  await googlePlayConnector.execute('update-product', { externalId: 'com.example.game:subscription:vip', basePlanId: 'yearly', priceMicros: '4490000', currency: 'USD' }, ctx);
  const [patch] = writes();
  assert.equal(new URL(patch.url).searchParams.get('updateMask'), 'basePlans');
  const plans = patch.json.basePlans as Array<Record<string, any>>;
  assert.deepEqual(plans[0].regionalConfigs, subscription().basePlans[0].regionalConfigs);
  assert.deepEqual(plans[1].regionalConfigs[0].price, { currencyCode: 'USD', units: '4', nanos: 490000000 });
});

test('Play activate-product sends purchaseOptions:batchUpdateStates for one-time options and confirms the returned state', async () => {
  const { ctx, writes, checkpoints } = await context('google-play', (url, request) => {
    if (url.pathname === PLAY + '/oneTimeProducts/gems') return oneTime();
    if (url.pathname === PLAY + '/oneTimeProducts/gems/purchaseOptions:batchUpdateStates') return { oneTimeProducts: [oneTime(['ACTIVE', 'ACTIVE'])] };
    return unexpected(url, request);
  });
  const result = await googlePlayConnector.execute('activate-product', { externalId: 'com.example.game:one-time:gems', optionId: 'rental' }, ctx);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].method, 'POST');
  assert.deepEqual(writes()[0].json, { requests: [{ activatePurchaseOptionRequest: { packageName: 'com.example.game', productId: 'gems', purchaseOptionId: 'rental' } }] });
  assert.equal(result.summary.confirmed, true);
  assert.equal(result.summary.state, 'ACTIVE');
  assert.equal(result.unresolved, false);
  assert.deepEqual(checkpoints.at(-1), { externalId: 'com.example.game:one-time:gems', optionId: 'rental' });
});

test('Play activate-product is idempotent for an already active option and flags an unconfirmed transition', async () => {
  const already = await context('google-play', (url, request) => url.pathname === PLAY + '/oneTimeProducts/gems' ? oneTime() : unexpected(url, request));
  const skip = await googlePlayConnector.execute('activate-product', { externalId: 'com.example.game:one-time:gems', optionId: 'standard' }, already.ctx);
  assert.equal(already.writes().length, 0);
  assert.equal(skip.summary.changed, false);

  const stale = await context('google-play', (url, request) => {
    if (url.pathname === PLAY + '/oneTimeProducts/gems') return oneTime();
    if (url.pathname.endsWith('purchaseOptions:batchUpdateStates')) return { oneTimeProducts: [oneTime()] };
    return unexpected(url, request);
  });
  const result = await googlePlayConnector.execute('activate-product', { externalId: 'com.example.game:one-time:gems', optionId: 'rental' }, stale.ctx);
  assert.equal(result.unresolved, true, 'a provider response without the requested state must not be reported as success');
  assert.equal(result.summary.confirmed, false);
});

test('Play deactivate-product uses basePlans:deactivate for subscriptions and rejects drafts', async () => {
  const { ctx, writes } = await context('google-play', (url, request) => {
    if (url.pathname === PLAY + '/subscriptions/vip') return subscription();
    if (url.pathname === PLAY + '/subscriptions/vip/basePlans/monthly:deactivate') return subscription('INACTIVE');
    return unexpected(url, request);
  });
  const result = await googlePlayConnector.execute('deactivate-product', { externalId: 'com.example.game:subscription:vip', optionId: 'monthly' }, ctx);
  assert.deepEqual(writes()[0].json, { packageName: 'com.example.game', productId: 'vip', basePlanId: 'monthly' });
  assert.equal(result.summary.state, 'INACTIVE');
  assert.equal(result.summary.confirmed, true);

  const draft = await context('google-play', (url, request) => url.pathname === PLAY + '/oneTimeProducts/gems' ? oneTime() : unexpected(url, request));
  await rejects(googlePlayConnector.execute('deactivate-product', { externalId: 'com.example.game:one-time:gems', optionId: 'rental' }, draft.ctx), 'INVALID_INPUT');
  await rejects(googlePlayConnector.execute('deactivate-product', { externalId: 'com.example.game:one-time:gems' }, draft.ctx), 'MULTIPLE_PRICE_OPTIONS');
  assert.equal(draft.writes().length, 0);
});

// ---------------------------------------------------------------------------
// Apple: auto-renewable subscriptions and product review submission
// ---------------------------------------------------------------------------
const appleApp = { data: [{ id: 'app-99', type: 'apps', attributes: { name: 'Demo', bundleId: 'com.example.demo' } }] };
const territories = { data: [{ id: 'USA', type: 'territories', attributes: { currency: 'USD' } }, { id: 'KOR', type: 'territories', attributes: { currency: 'KRW' } }] };
const group = { id: 'grp-1', type: 'subscriptionGroups', attributes: { referenceName: 'Premium' } };
const sub = (state = 'MISSING_METADATA') => ({ id: 'sub-1', type: 'subscriptions', attributes: { name: 'Monthly', productId: 'premium.monthly', state, subscriptionPeriod: 'ONE_MONTH' },
  relationships: { group: { data: { type: 'subscriptionGroups', id: 'grp-1' } } } });

function appleSubscriptionHandler(options: { groups: unknown[]; existing?: unknown[]; subscriptionState?: string } ): Handler {
  let state = options.subscriptionState ?? 'MISSING_METADATA';
  return (url, request) => {
    const path = url.pathname;
    if (path === '/v1/apps' && url.searchParams.get('filter[bundleId]')) return appleApp;
    if (path === '/v1/territories') return territories;
    if (path === '/v1/apps/app-99/subscriptionGroups') return { data: options.groups };
    if (path === '/v1/subscriptionGroups' && request.method === 'POST') return { data: group };
    if (path === '/v1/subscriptionGroups/grp-1/subscriptions') return { data: url.searchParams.get('filter[productId]') ? options.existing ?? [] : [sub(state)] };
    if (path === '/v1/subscriptions' && request.method === 'POST') return { data: sub() };
    if (path === '/v1/subscriptions/sub-1/pricePoints') return { data: [{ id: 'spp-499', type: 'subscriptionPricePoints', attributes: { customerPrice: '4.99' } }, { id: 'spp-599', type: 'subscriptionPricePoints', attributes: { customerPrice: '5.99' } }] };
    if (path === '/v1/subscriptionPrices' && request.method === 'POST') return { data: { id: 'price-1', type: 'subscriptionPrices' } };
    if (path === '/v1/subscriptions/sub-1') return { data: sub(state) };
    if (path === '/v1/subscriptionSubmissions' && request.method === 'POST') { state = 'WAITING_FOR_REVIEW'; return { data: { id: 'subm-1', type: 'subscriptionSubmissions' } }; }
    return unexpected(url, request);
  };
}

test('Apple create-subscription reuses a group by reference name and prices the base territory exactly', async () => {
  const { ctx, writes, checkpoints } = await context('app-store', appleSubscriptionHandler({ groups: [group] }));
  const result = await appStoreConnector.execute('create-subscription',
    { subscriptionGroup: 'Premium', productId: 'premium.monthly', name: 'Monthly', billingPeriod: 'P1M', currency: 'USD', priceMicros: '4990000' }, ctx);
  assert.deepEqual(writes().map(item => new URL(item.url).pathname), ['/v1/subscriptions', '/v1/subscriptionPrices']);
  assert.deepEqual(writes()[0].json, { data: { type: 'subscriptions', attributes: { name: 'Monthly', productId: 'premium.monthly', subscriptionPeriod: 'ONE_MONTH' },
    relationships: { group: { data: { type: 'subscriptionGroups', id: 'grp-1' } } } } });
  assert.deepEqual(writes()[1].json.data.relationships, {
    subscription: { data: { type: 'subscriptions', id: 'sub-1' } }, territory: { data: { type: 'territories', id: 'USA' } },
    subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'spp-499' } } });
  assert.equal(result.summary.subscriptionGroupReused, true);
  assert.equal(result.summary.appliedCustomerPrice, '4.99');
  assert.equal(result.resources![0].externalId, 'subscription:sub-1');
  assert.equal(result.resources![0].data.productType, 'subscription');
  assert.ok(checkpoints.some(item => item.externalId === 'subscription:sub-1'));
});

test('Apple create-subscription creates a missing group, and refuses duplicates or inexact prices without inventing success', async () => {
  const created = await context('app-store', appleSubscriptionHandler({ groups: [] }));
  const result = await appStoreConnector.execute('create-subscription',
    { subscriptionGroup: 'Premium', productId: 'premium.monthly', name: 'Monthly', billingPeriod: 'ONE_MONTH', currency: 'USD', priceMicros: '4990000' }, created.ctx);
  assert.deepEqual(created.writes()[0].json, { data: { type: 'subscriptionGroups', attributes: { referenceName: 'Premium' }, relationships: { app: { data: { type: 'apps', id: 'app-99' } } } } });
  assert.equal(result.summary.subscriptionGroupReused, false);

  const duplicate = await context('app-store', appleSubscriptionHandler({ groups: [group], existing: [sub()] }));
  await rejects(appStoreConnector.execute('create-subscription',
    { subscriptionGroup: 'Premium', productId: 'premium.monthly', name: 'Monthly', billingPeriod: 'P1M', currency: 'USD', priceMicros: '4990000' }, duplicate.ctx), 'PRODUCT_EXISTS');
  assert.equal(duplicate.writes().length, 0);

  const inexact = await context('app-store', appleSubscriptionHandler({ groups: [group] }));
  const error = await rejects(appStoreConnector.execute('create-subscription',
    { subscriptionGroup: 'Premium', productId: 'premium.monthly', name: 'Monthly', billingPeriod: 'P1M', currency: 'USD', priceMicros: '5000000' }, inexact.ctx), 'PRICE_POINT_REQUIRED');
  assert.equal((error.details as Record<string, unknown>).externalId, 'subscription:sub-1');
  assert.deepEqual(inexact.writes().map(item => new URL(item.url).pathname), ['/v1/subscriptions']);
});

test('Apple list-products includes subscriptions and update-product reprices them via subscriptionPrices', async () => {
  const handler = appleSubscriptionHandler({ groups: [group] });
  const { ctx, writes } = await context('app-store', (url, request) => url.pathname === '/v1/apps/app-99/inAppPurchasesV2'
    ? { data: [{ id: 'iap-1', type: 'inAppPurchases', attributes: { name: 'Gems', productId: 'gems', state: 'APPROVED', inAppPurchaseType: 'CONSUMABLE' } }] }
    : handler(url, request));
  const listed = await appStoreConnector.execute('list-products', {}, ctx);
  assert.deepEqual(listed.resources!.map(item => [item.externalId, item.data.productType]), [['iap-1', 'in-app'], ['subscription:sub-1', 'subscription']]);
  assert.equal(listed.resources![1].data.subscriptionGroupName, 'Premium');

  const updated = await appStoreConnector.execute('update-product', { externalId: 'subscription:sub-1', priceMicros: '5990000', currency: 'USD' }, ctx);
  assert.equal(writes().length, 1);
  assert.equal(new URL(writes()[0].url).pathname, '/v1/subscriptionPrices');
  assert.equal(writes()[0].json.data.attributes.preserveCurrentPrice, true);
  assert.equal(updated.summary.appliedCustomerPrice, '5.99');
  await rejects(appStoreConnector.execute('update-product', { externalId: 'subscription:sub-1', status: 'active' }, ctx), 'UNSUPPORTED_OPERATION');
});

test('Apple submit-product posts subscriptionSubmissions / inAppPurchaseSubmissions only for READY_TO_SUBMIT products', async () => {
  const subscriptionCtx = await context('app-store', appleSubscriptionHandler({ groups: [group], subscriptionState: 'READY_TO_SUBMIT' }));
  const submitted = await appStoreConnector.execute('submit-product', { externalId: 'subscription:sub-1' }, subscriptionCtx.ctx);
  assert.deepEqual(subscriptionCtx.writes().map(item => item.json), [{ data: { type: 'subscriptionSubmissions', relationships: { subscription: { data: { type: 'subscriptions', id: 'sub-1' } } } } }]);
  assert.equal(submitted.summary.state, 'WAITING_FOR_REVIEW');

  let iapState = 'READY_TO_SUBMIT';
  const iap = { id: 'iap-1', type: 'inAppPurchases', attributes: { name: 'Gems', productId: 'gems', state: iapState } };
  const iapCtx = await context('app-store', (url, request) => {
    if (url.pathname === '/v1/apps') return appleApp;
    if (url.pathname === '/v2/inAppPurchases/iap-1') return { data: { ...iap, attributes: { ...iap.attributes, state: iapState } } };
    if (url.pathname === '/v1/apps/app-99/inAppPurchasesV2') return { data: [iap] };
    if (url.pathname === '/v1/inAppPurchaseSubmissions') { iapState = 'WAITING_FOR_REVIEW'; return { data: { id: 'iaps-1', type: 'inAppPurchaseSubmissions' } }; }
    return unexpected(url, request);
  });
  await appStoreConnector.execute('submit-product', { externalId: 'iap-1' }, iapCtx.ctx);
  assert.deepEqual(iapCtx.writes().map(item => item.json), [{ data: { type: 'inAppPurchaseSubmissions', relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id: 'iap-1' } } } } }]);
  const again = await appStoreConnector.execute('submit-product', { externalId: 'iap-1' }, iapCtx.ctx);
  assert.equal(again.summary.alreadySubmitted, true);
  assert.equal(iapCtx.writes().length, 1);

  const incomplete = await context('app-store', appleSubscriptionHandler({ groups: [group], subscriptionState: 'MISSING_METADATA' }));
  await rejects(appStoreConnector.execute('submit-product', { externalId: 'subscription:sub-1' }, incomplete.ctx), 'INVALID_INPUT');
  const foreign = await context('app-store', appleSubscriptionHandler({ groups: [], subscriptionState: 'READY_TO_SUBMIT' }));
  await rejects(appStoreConnector.execute('submit-product', { externalId: 'subscription:sub-1' }, foreign.ctx), 'RESOURCE_MISMATCH');
  assert.equal(incomplete.writes().length + foreign.writes().length, 0);
});

// ---------------------------------------------------------------------------
// Apple: App Preview video upload
// ---------------------------------------------------------------------------
async function video(name: string, brand = 'isom'): Promise<VerifiedArtifact> {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp' + brand, 'latin1'), Buffer.alloc(4096, 7)]);
  const path = join(await mkdtemp(join(tmpdir(), 'preview-')), name);
  await writeFile(path, bytes);
  return { path, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'file' };
}
const PUT_URL = 'https://store-030.blobstore.apple.com/preview?partNumber=1';
function previewDoc(asset: string, videoState?: string, extra: Record<string, unknown> = {}) {
  return { data: { id: 'pv-1', type: 'appPreviews', attributes: { fileName: 'trailer.mp4', assetDeliveryState: { state: asset, errors: [] },
    ...(videoState ? { videoDeliveryState: { state: videoState, errors: videoState === 'FAILED' ? [{ code: 'DURATION', description: 'too short' }] : [] } } : {}), ...extra },
  relationships: { appPreviewSet: { data: { type: 'appPreviewSets', id: 'pset-1' } } } } };
}
function previewHandler(size: number, finalVideo: string): Handler {
  return (url, request) => {
    const path = url.pathname;
    if (path === '/v1/apps') return appleApp;
    if (path === '/v1/appStoreVersions/ver-1') return { data: { id: 'ver-1', type: 'appStoreVersions', relationships: { app: { data: { type: 'apps', id: 'app-99' } } } } };
    if (path === '/v1/appStoreVersions/ver-1/appStoreVersionLocalizations') return { data: [{ id: 'loc-1', type: 'appStoreVersionLocalizations', attributes: { locale: 'ko' } }] };
    if (path === '/v1/appStoreVersionLocalizations/loc-1') return { data: { id: 'loc-1', type: 'appStoreVersionLocalizations', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'ver-1' } } } } };
    if (path === '/v1/appStoreVersionLocalizations/loc-1/appPreviewSets') return { data: [] };
    if (path === '/v1/appPreviewSets' && request.method === 'POST') return { data: { id: 'pset-1', type: 'appPreviewSets', attributes: { previewType: 'IPHONE_67' } } };
    if (path === '/v1/appPreviewSets/pset-1') return { data: { id: 'pset-1', type: 'appPreviewSets', relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: 'loc-1' } } } } };
    if (path === '/v1/appPreviewSets/pset-1/appPreviews') return { data: [] };
    if (path === '/v1/appPreviews' && request.method === 'POST') return previewDoc('AWAITING_UPLOAD', 'AWAITING_UPLOAD', { uploadOperations: [{ method: 'PUT', url: PUT_URL, offset: 0, length: size, requestHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] }] });
    if (url.href === PUT_URL) return '';
    if (path === '/v1/appPreviews/pv-1' && request.method === 'PATCH') return previewDoc('UPLOAD_COMPLETE', 'PROCESSING');
    if (path === '/v1/appPreviews/pv-1') return previewDoc('COMPLETE', finalVideo);
    return unexpected(url, request);
  };
}

test('Apple upload-app-preview reserves, uploads, commits, and waits for video processing', async () => {
  const artifact = await video('trailer.mp4');
  const { ctx, writes, checkpoints } = await context('app-store', previewHandler(artifact.size, 'PROCESSING'), { artifact });
  const result = await appStoreConnector.execute('upload-app-preview',
    { appStoreVersionId: 'ver-1', locale: 'ko', previewType: 'IPHONE_67', previewFrameTimeCode: '00:00:05:00' }, ctx);
  const paths = writes().map(item => item.url.startsWith('https://store-') ? 'PUT part' : `${item.method} ${new URL(item.url).pathname}`);
  assert.deepEqual(paths, ['POST /v1/appPreviewSets', 'POST /v1/appPreviews', 'PUT part', 'PATCH /v1/appPreviews/pv-1']);
  assert.deepEqual(writes()[0].json.data.attributes, { previewType: 'IPHONE_67' });
  assert.deepEqual(writes()[1].json.data.attributes, { fileName: 'trailer.mp4', fileSize: artifact.size, mimeType: 'video/mp4', previewFrameTimeCode: '00:00:05:00' });
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(4096, 7)]);
  assert.deepEqual(writes()[3].json.data.attributes, { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex'), previewFrameTimeCode: '00:00:05:00' });
  assert.equal(result.waitingExternal, true, 'video processing is not complete yet');
  assert.equal(result.summary.appPreviewId, 'pv-1');
  assert.equal(result.summary.confirmed, false);
  assert.equal(result.summary.videoDeliveryState, 'PROCESSING');
  assert.ok(checkpoints.some(item => item.appPreviewId === 'pv-1' && item.phase === 'preview-reserved'));
});

test('Apple upload-app-preview fails on rejected processing and validates the container before any request', async () => {
  const artifact = await video('trailer.mp4');
  const failed = await context('app-store', previewHandler(artifact.size, 'FAILED'), { artifact });
  const error = await rejects(appStoreConnector.execute('upload-app-preview', { appStoreVersionId: 'ver-1', locale: 'ko', previewType: 'IPHONE_67' }, failed.ctx), 'PROVIDER_REJECTED');
  assert.deepEqual(error.details, [{ code: 'DURATION', description: 'too short' }]);

  const renamed = await video('trailer.mp4', 'qt  ');
  const mismatch = await context('app-store', previewHandler(renamed.size, 'COMPLETE'), { artifact: renamed });
  await rejects(appStoreConnector.execute('upload-app-preview', { appStoreVersionId: 'ver-1', locale: 'ko', previewType: 'IPHONE_67' }, mismatch.ctx), 'INVALID_INPUT');
  await rejects(appStoreConnector.execute('upload-app-preview', { appStoreVersionId: 'ver-1', locale: 'ko', previewType: 'APP_IPHONE_99' }, mismatch.ctx), 'INVALID_INPUT');
  await rejects(appStoreConnector.execute('upload-app-preview', { appStoreVersionId: 'ver-1', locale: 'ko', previewType: 'IPHONE_67', previewFrameTimeCode: '5s' }, mismatch.ctx), 'INVALID_INPUT');
  assert.equal(mismatch.requests.length, 0);
  const quicktime = await video('trailer.mov', 'qt  ');
  const mov = await context('app-store', previewHandler(quicktime.size, 'COMPLETE'), { artifact: quicktime });
  const done = await appStoreConnector.execute('upload-app-preview', { appStoreVersionId: 'ver-1', locale: 'ko', previewType: 'IPHONE_67' }, mov.ctx);
  assert.equal(mov.writes()[1].json.data.attributes.mimeType, 'video/quicktime');
  assert.equal(done.summary.confirmed, true);
  assert.equal(done.waitingExternal, false);
});

test('Apple reconcile with appPreviewId checks ownership and maps asset/video states', async () => {
  for (const [video, confirmed, failed, waiting] of [['COMPLETE', true, false, false], ['PROCESSING', false, false, true], ['FAILED', false, true, false]] as const) {
    const { ctx, writes } = await context('app-store', previewHandler(1, video));
    const result = await appStoreConnector.execute('reconcile', { appPreviewId: 'pv-1' }, ctx);
    assert.equal(result.summary.confirmed, confirmed, video);
    assert.equal(result.failed, failed, video);
    assert.equal(result.waitingExternal, waiting, video);
    assert.equal(writes().length, 0);
  }
});

// ---------------------------------------------------------------------------
// Apple: monthly FINANCIAL settlement reports
// ---------------------------------------------------------------------------
// Column order per App Store Connect Help "Financial report fields" (checked 2026-09-24).
const FINANCE_HEADER = ['Start Date', 'End Date', 'UPC', 'ISRC / ISBN', 'Vendor Identifier', 'Quantity', 'Partner Share', 'Extended Partner Share',
  'Partner Share Currency', 'Sale or Return', 'Apple Identifier', 'Artist / Show / Developer / Author', 'Title', 'Label / Studio / Network / Developer / Publisher',
  'Grid', 'Product Type Identifier', 'ISAN / Other Identifier', 'Country of Sale', 'Pre-order Flag', 'Promo Code', 'Customer Price', 'Customer Currency'].join('\t');
function financeRow(quantity: string, share: string, extended: string, currency: string, sale: 'S' | 'R') {
  return ['08/03/2026', '08/30/2026', '', '', 'gems', quantity, share, extended, currency, sale, '123', 'Studio', 'Gems', '', '', 'IA1', '', 'US', '', '', '1.99', currency].join('\t');
}
const financeReport = gzipSync(Buffer.from([
  FINANCE_HEADER,
  financeRow('10', '1.40', '14.00', 'USD', 'S'),
  financeRow('-2', '1.40', '-2.80', 'USD', 'R'),
  financeRow('3', '1000', '3000', 'KRW', 'S'),
  '', 'Total_Rows\t3', 'Total_Amount\t11.20', 'Total_Units\t11',
].join('\n'), 'utf8'));

test('parseAppleFinanceReport sums signed partner share per period and currency, skipping total lines', () => {
  const { metrics, rows } = parseAppleFinanceReport(financeReport, '88888888', '2026-08');
  assert.equal(rows, 3);
  assert.deepEqual(metrics, [
    { date: '2026-08-30', currency: 'USD', kind: 'revenue', basis: 'settled', sourceId: 'apple-finance:88888888:2026-08:2026-08-03_2026-08-30', amountMicros: '11200000' },
    { date: '2026-08-30', currency: 'KRW', kind: 'revenue', basis: 'settled', sourceId: 'apple-finance:88888888:2026-08:2026-08-03_2026-08-30', amountMicros: '3000000000' },
  ]);
  const refundsOnly = gzipSync(Buffer.from([FINANCE_HEADER, financeRow('-1', '1.40', '-1.40', 'USD', 'R')].join('\n')));
  assert.equal(parseAppleFinanceReport(refundsOnly, '88888888', '2026-08').metrics[0].amountMicros, '-1400000');
  assert.throws(() => parseAppleFinanceReport(gzipSync(Buffer.from('Start Date\tEnd Date\n08/03/2026\t08/30/2026')), 'v', '2026-08'), /필수 열/);
  assert.throws(() => parseAppleFinanceReport(gzipSync(Buffer.from([FINANCE_HEADER, financeRow('1', 'x', 'abc', 'USD', 'S')].join('\n'))), 'v', '2026-08'), (error: AppError) => error.code === 'INVALID_REPORT');
});

test('Apple sync adds settled facts for re-collected months with replacement prefixes and keeps daily proceeds separate', async () => {
  const finance: string[] = [];
  const { ctx, writes } = await context('app-store', (url, request) => {
    if (url.pathname === '/v1/salesReports') throw new AppError('RESOURCE_NOT_FOUND', 'not ready', 404);
    if (url.pathname === '/v1/financeReports') {
      finance.push(url.search);
      assert.equal(request.format, 'bytes');
      assert.equal(url.searchParams.get('filter[reportType]'), 'FINANCIAL');
      assert.equal(url.searchParams.get('filter[regionCode]'), 'ZZ');
      assert.equal(url.searchParams.get('filter[vendorNumber]'), '88888888');
      return financeReport;
    }
    return unexpected(url, request);
  }, { credentials: { vendorNumber: '88888888' } });
  const result = await appStoreConnector.execute('sync', { financeMonth: '2026-08' }, ctx);
  assert.equal(finance.length, 1);
  assert.equal(new URLSearchParams(finance[0]).get('filter[reportDate]'), '2026-08');
  assert.deepEqual(result.metricSourcePrefixes, ['apple-finance:88888888:2026-08:']);
  assert.ok(result.metrics!.every(item => item.basis === 'settled' && item.sourceId.startsWith('apple-finance:88888888:2026-08:')));
  assert.ok(!result.metricSourcePrefixes!.some(prefix => 'apple:sales:88888888:2026-08-10:USD'.startsWith(prefix)), 'settled replacement must not delete daily proceeds');
  assert.equal(result.summary.financeStatus, 'collected');
  assert.equal(writes().length, 0);
  await rejects(appStoreConnector.execute('sync', { financeMonth: '202608' }, ctx), 'INVALID_INPUT');
});

test('Apple sync reports missing months and a missing Finance role without failing daily proceeds', async () => {
  let calls = 0;
  const missing = await context('app-store', url => {
    if (url.pathname === '/v1/salesReports') throw new AppError('RESOURCE_NOT_FOUND', 'not ready', 404);
    calls += 1;
    if (calls === 1) throw new AppError('RESOURCE_NOT_FOUND', 'not generated', 404);
    return financeReport;
  }, { credentials: { vendorNumber: '88888888' } });
  const result = await appStoreConnector.execute('sync', {}, missing.ctx);
  assert.equal(calls, 3);
  assert.equal((result.summary.missingMonths as string[]).length, 1);
  assert.equal(result.metricSourcePrefixes!.length, 2, 'only collected months are replaced');

  const denied = await context('app-store', url => {
    if (url.pathname === '/v1/salesReports') return gzipSync(Buffer.from('Units\tDeveloper Proceeds\tCurrency of Proceeds\n1\t0.70\tUSD'));
    throw new AppError('PERMISSION_REQUIRED', 'Finance role required', 403);
  }, { credentials: { vendorNumber: '88888888' } });
  const partial = await appStoreConnector.execute('sync', {}, denied.ctx);
  assert.equal(partial.summary.financeStatus, 'permission_required');
  assert.equal(partial.metrics!.filter(item => item.basis === 'proceeds').length, 5);
  assert.deepEqual(partial.metricSourcePrefixes, []);
});
