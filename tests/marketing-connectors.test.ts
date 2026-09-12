import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';

import { AppError } from '../packages/domain/errors.js';
import { DEFAULT_POLICY, type Connection, type Project, type MetricFact } from '../packages/domain/index.js';
import { summarizeMetrics } from '../packages/metrics/index.js';
import { googleAdsConnector } from '../packages/connectors/google-ads.js';
import { applovinAdsConnector } from '../packages/connectors/applovin-ads.js';
import { applovinMaxConnector } from '../packages/connectors/applovin-max.js';
import { admobConnector } from '../packages/connectors/admob.js';
import type { Connector, ConnectorContext, ProviderRequest } from '../packages/connectors/types.js';

interface Recorded { url: string; options: ProviderRequest }
const temporaryDirectories: string[] = [];
after(() => Promise.all(temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true }))));

async function createContext(options: {
  provider: Connection['provider'];
  credentials?: Record<string, string>;
  accountId?: string;
  appIdentifier?: string;
  handler: (url: string, request: ProviderRequest) => unknown;
}): Promise<{ context: ConnectorContext; requests: Recorded[]; checkpoints: Array<Record<string, unknown>>; dispatched: () => number }> {
  const workDirectory = await mkdtemp(join(tmpdir(), 'mkt-conn-'));
  temporaryDirectories.push(workDirectory);
  const requests: Recorded[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  let dispatched = 0;
  const now = new Date().toISOString();
  const connection: Connection = {
    id: 'conn-1', provider: options.provider, label: 'test', accountId: options.accountId ?? '1234567890',
    status: 'connected', createdAt: now, updatedAt: now, lastCheckedAt: null, lastError: null, authKind: 'test', credentialFields: [],
  };
  const project: Project | undefined = options.appIdentifier === undefined ? undefined : {
    id: 'proj-1', createdAt: now, updatedAt: now, policy: DEFAULT_POLICY,
    rootPath: workDirectory, name: 'demo', engine: 'unknown', engineVersion: null,
    appIdentifier: options.appIdentifier, targets: [], findings: [], inspectedAt: now,
  };
  const context: ConnectorContext = {
    connection, credentials: { ...(options.credentials ?? {}) }, project,
    signal: new AbortController().signal, workDirectory,
    markDispatched: () => { dispatched += 1; },
    checkpoint: data => { checkpoints.push({ ...data }); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'oauth-access-token',
    request: async <T>(url: string, request: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      if (request.write) dispatched += 1;
      return options.handler(url, request) as T;
    },
    progress: () => undefined,
  };
  return { context, requests, checkpoints, dispatched: () => dispatched };
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

function adsSearchHandler(rows: Record<string, unknown>[]) {
  return (url: string, request: ProviderRequest) => {
    if (url.includes('googleAds:search')) {
      const query = String((request.json as { query?: string })?.query ?? '');
      if (query.includes('FROM customer') && query.includes('currency')) {
        return { results: [{ customer: { id: '1234567890', descriptiveName: 'Test', currencyCode: 'USD', timeZone: 'America/Los_Angeles' } }] };
      }
      if (query.includes('cost_micros')) {
        return { results: [{ segments: { date: '2026-09-10' }, metrics: { costMicros: '1500000' }, campaign: { appCampaignSetting: { appId: 'com.harbor.game' } } }] };
      }
      if (query.includes('campaign.id !=')) return { results: [] };
      return { results: rows };
    }
    if (url.includes('googleAds:mutate')) {
      return { mutateOperationResponses: [{ campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/9' } }, { campaignResult: { resourceName: 'customers/1234567890/campaigns/555' } }] };
    }
    throw new Error(url);
  };
}

test('Google Ads check uses v25, Cloud OAuth, and never sends developer-token', async () => {
  const { context, requests } = await createContext({
    provider: 'google-ads', accountId: '123-456-7890',
    handler: adsSearchHandler([]),
  });
  const result = await googleAdsConnector.execute('check', {}, context);
  assert.equal(result.summary.developerTokenRequired, false);
  assert.equal(result.summary.currency, 'USD');
  assert.ok(requests[0].url.includes('/v25/customers/1234567890/googleAds:search'));
  for (const item of requests) {
    assert.equal(item.options.headers?.['developer-token'], undefined);
    assert.equal(item.options.headers?.Authorization, 'Bearer oauth-access-token');
  }
  assert.equal(googleAdsConnector.capability.fields.some(field => field.key === 'developerToken'), false);
});

test('Google Ads creates a PAUSED App campaign atomically and checkpoints the id', async () => {
  const createdRow = {
    campaign: { id: '555', name: 'Harbor UA', status: 'PAUSED', resourceName: 'customers/1234567890/campaigns/555', appCampaignSetting: { appId: 'com.harbor.game' } },
    campaignBudget: { amountMicros: '50000000', explicitlyShared: false },
  };
  const { context, requests, checkpoints, dispatched } = await createContext({
    provider: 'google-ads', appIdentifier: 'com.harbor.game',
    handler: adsSearchHandler([createdRow]),
  });
  const result = await googleAdsConnector.execute('create-campaign', {
    name: 'Harbor UA', dailyBudgetMicros: '50000000', currency: 'USD', targetCpaMicros: '2000000', country: ['US', 'KR'],
  }, context);
  const mutate = requests.find(item => item.url.endsWith('googleAds:mutate'));
  assert.ok(mutate);
  assert.equal(mutate!.options.write, true);
  assert.ok(dispatched() >= 1);
  const ops = (mutate!.options.json as { mutateOperations: Array<Record<string, Record<string, Record<string, unknown>>>> }).mutateOperations;
  assert.equal(ops[0].campaignBudgetOperation.create.explicitlyShared, false);
  assert.equal(ops[1].campaignOperation.create.status, 'PAUSED');
  assert.equal(ops[1].campaignOperation.create.advertisingChannelType, 'MULTI_CHANNEL');
  assert.equal(ops[1].campaignOperation.create.advertisingChannelSubType, 'APP_CAMPAIGN');
  assert.equal(ops.filter(item => item.campaignCriterionOperation).length, 2);
  assert.equal((ops[1].campaignOperation.create.appCampaignSetting as { appId: string }).appId, 'com.harbor.game');
  assert.equal(result.resources?.[0].status, 'PAUSED');
  assert.equal(checkpoints[0].externalId, '555');
  assert.equal(result.waitingExternal, undefined);
  assert.equal(result.resources?.[0].data.dailyBudgetMicros, '50000000');
  assert.equal(mutate!.options.write, true);
  assert.equal(requests.find(item => item.url.includes('googleAds:search'))?.options.write, false);
});

test('Google Ads refuses missing CPA, currency mismatch, shared budgets, and ENABLE without creatives', async () => {
  const sharedRow = [{
    campaign: { id: '1', name: 'A', status: 'PAUSED', resourceName: 'customers/1234567890/campaigns/1', campaignBudget: 'customers/1234567890/campaignBudgets/9' },
    campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/9', amountMicros: '1000', explicitlyShared: true },
  }];
  const { context } = await createContext({ provider: 'google-ads', appIdentifier: 'com.a.b', handler: adsSearchHandler([]) });
  await expectCode(googleAdsConnector.execute('create-campaign', { name: 'x', dailyBudgetMicros: '1000000', currency: 'USD' }, context), 'BIDDING_REQUIRED');
  await expectCode(googleAdsConnector.execute('create-campaign', { name: 'x', dailyBudgetMicros: '1000000', currency: 'KRW', targetCpaMicros: '1' }, context), 'CURRENCY_MISMATCH');
  const shared = await createContext({ provider: 'google-ads', handler: adsSearchHandler(sharedRow) });
  await expectCode(googleAdsConnector.execute('update-campaign', { externalId: '1', dailyBudgetMicros: '2000000', currency: 'USD' }, shared.context), 'SHARED_BUDGET');
  const owned = await createContext({
    provider: 'google-ads',
    handler: (url, request) => {
      const query = String((request.json as { query?: string })?.query ?? '');
      if (query.includes('FROM customer') && query.includes('currency')) {
        return { results: [{ customer: { id: '1234567890', currencyCode: 'USD', timeZone: 'UTC', descriptiveName: 't' } }] };
      }
      if (query.includes('campaign.id !=')) return { results: [{ campaign: { id: '99' } }] };
      return adsSearchHandler([{
        campaign: { id: '1', name: 'A', status: 'PAUSED', resourceName: 'customers/1234567890/campaigns/1', campaignBudget: 'customers/1234567890/campaignBudgets/8' },
        campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/8', amountMicros: '1000', explicitlyShared: false },
      }])(url, request);
    },
  });
  await expectCode(googleAdsConnector.execute('update-campaign', { externalId: '1', dailyBudgetMicros: '2000000', currency: 'USD' }, owned.context), 'SHARED_BUDGET');
  await expectCode(googleAdsConnector.execute('update-campaign', { externalId: '1', status: 'ENABLED' }, shared.context), 'CREATIVE_REQUIRED');
});

test('Google Ads sync records spend micros without inventing ROAS', async () => {
  const { context } = await createContext({
    provider: 'google-ads',
    handler: adsSearchHandler([{
      campaign: { id: '7', name: 'UA', status: 'PAUSED', resourceName: 'customers/1234567890/campaigns/7' },
      campaignBudget: { amountMicros: '5000000', explicitlyShared: false },
    }]),
  });
  const result = await googleAdsConnector.execute('sync', {}, context);
  assert.equal(result.metrics?.[0].kind, 'spend');
  assert.equal(result.metrics?.[0].amountMicros, '1500000');
  assert.equal(result.metrics?.[0].currency, 'USD');
  assert.equal(result.metrics?.[0].appIdentifier, 'com.harbor.game');
  assert.equal(result.summary.roas, undefined);
});

test('AppLovin Ads lists with raw Authorization and requires explicit LIVE create fields', async () => {
  const { context, requests } = await createContext({
    provider: 'applovin-ads', accountId: '99',
    credentials: { accountId: '99', campaignManagementKey: 'cm-key' },
    handler: (url) => {
      if (url.includes('/campaign/list')) {
        return [{ id: '12345', name: 'UA', status: 'PAUSED', package_name: 'com.harbor.game', budget: { daily_budget_for_all_countries: '6000' } }];
      }
      throw new Error(url);
    },
  });
  const listed = await applovinAdsConnector.execute('list-campaigns', {}, context);
  assert.equal(requests[0].options.headers?.Authorization, 'cm-key');
  assert.ok(requests[0].url.includes('account_id=99'));
  assert.equal(listed.resources?.[0].data.dailyBudgetMicros, '6000000000');
  assert.equal(listed.resources?.[0].data.appIdentifier, 'com.harbor.game');
  assert.equal(applovinAdsConnector.capability.operations.includes('create-campaign'), true);
  await expectCode(applovinAdsConnector.execute('create-campaign', { name: 'UA', dailyBudgetMicros: '1', currency: 'USD' }, context), 'INVALID_INPUT');
  assert.ok(googleAdsConnector.capability.operationFields?.['create-campaign']?.some(field => field.key === 'targetCpaMicros' && field.required));
  assert.ok(applovinAdsConnector.capability.operationFields?.['create-campaign']?.some(field => field.key === 'activation' && field.required));
});

test('MAX creates ad units with Api-Key and keeps ads keys out of operations', async () => {
  const { context, requests, checkpoints } = await createContext({
    provider: 'applovin-max',
    credentials: { managementKey: 'mgmt', reportKey: 'rep' },
    appIdentifier: 'com.harbor.game',
    handler: (url) => {
      if (url.endsWith('/ad_unit')) return { id: 'deadbeef', name: 'Rewarded', platform: 'android', package_name: 'com.harbor.game', ad_format: 'REWARD', disabled: false };
      if (url.includes('/ad_units')) return [];
      throw new Error(url);
    },
  });
  const result = await applovinMaxConnector.execute('create-ad-unit', { name: 'Rewarded', format: 'rewarded', platform: 'android' }, context);
  assert.equal(requests[0].options.headers?.['Api-Key'], 'mgmt');
  assert.equal(requests[0].options.write, true);
  assert.equal(result.resources?.[0].externalId, 'deadbeef');
  assert.equal(checkpoints[0].externalId, 'deadbeef');
  assert.equal(applovinMaxConnector.capability.operations.includes('create-campaign'), false);
});

test('AdMob lists inventory and network earnings without exposing writes', async () => {
  const { context, requests } = await createContext({
    provider: 'admob', accountId: 'pub-1234567890123456',
    credentials: { publisherId: 'pub-1234567890123456' },
    handler: (url) => {
      if (url.match(/\/v1\/accounts\/pub-\d+$/)) return { name: 'accounts/pub-1234567890123456', publisherId: 'pub-1234567890123456', currencyCode: 'EUR', reportingTimeZone: 'Europe/Paris' };
      if (url.includes('/apps')) return { apps: [{ appId: 'ca-app-pub-1~1', name: 'accounts/x/apps/1', platform: 'ANDROID', manualAppInfo: { displayName: 'Harbor' } }] };
      if (url.includes('/adUnits')) return { adUnits: [{ adUnitId: 'ca-app-pub-1/2', displayName: 'Banner', adFormat: 'BANNER', appId: 'ca-app-pub-1~1' }] };
      if (url.includes('networkReport:generate')) {
        return [{ row: { dimensionValues: { DATE: { value: '20260910' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '1230000' } } } }];
      }
      throw new Error(url);
    },
  });
  const result = await admobConnector.execute('sync', {}, context);
  assert.equal(result.summary.currency, 'EUR');
  assert.equal(result.summary.timeZone, 'Europe/Paris');
  assert.equal(result.metrics?.[0].amountMicros, '1230000');
  assert.equal(result.metrics?.[0].kind, 'revenue');
  assert.ok(result.metrics?.[0].sourceId.includes('admob:network'));
  assert.equal(admobConnector.capability.operations.includes('create-ad-unit'), false);
  await expectCode(admobConnector.execute('create-ad-unit', { name: 'x', format: 'BANNER' }, context), 'UNSUPPORTED_OPERATION');
  assert.equal(requests.some(item => item.options.write), false);
  assert.equal(requests.find(item => item.url.includes('networkReport:generate'))?.options.write, false);
});

test('AppLovin update re-reads campaign and keeps budget fields', async () => {
  const { context } = await createContext({
    provider: 'applovin-ads', accountId: '99',
    credentials: { accountId: '99', campaignManagementKey: 'cm-key' },
    handler: (url, request) => {
      if (url.includes('/campaign/list')) {
        return [{ id: '7', name: 'UA', status: 'PAUSED', package_name: 'com.harbor.game', budget: { daily_budget_for_all_countries: '50' } }];
      }
      if (url.includes('/campaign/update')) {
        assert.equal((request.json as { status?: string }).status, 'PAUSED');
        return { id: '7' };
      }
      throw new Error(url);
    },
  });
  const result = await applovinAdsConnector.execute('pause-campaign', { externalId: '7' }, context);
  assert.equal(result.resources?.[0].data.dailyBudgetMicros, '50000000');
  assert.equal(result.resources?.[0].data.currency, 'USD');
  assert.equal(result.resources?.[0].status, 'PAUSED');
});

test('unsupported operations stay fail-closed for every connector', async () => {
  const connectors: Connector[] = [googleAdsConnector, applovinAdsConnector, applovinMaxConnector, admobConnector];
  for (const connector of connectors) {
    const { context } = await createContext({
      provider: connector.capability.provider,
      credentials: { accountId: '1', campaignManagementKey: 'k', managementKey: 'm', publisherId: 'pub-1' },
      handler: () => ({}),
    });
    await expectCode(connector.execute('upload-build', {}, context), 'UNSUPPORTED_OPERATION');
  }
});

test('Google Ads combines every campaign row for the same app and reporting date before persistence', async () => {
  const base = adsSearchHandler([]);
  const { context } = await createContext({ provider: 'google-ads', handler: (url, request) => {
    if (String((request.json as { query?: string })?.query).includes('cost_micros')) return { results: ['1000000', '2000000'].map((cost, index) => ({ campaign: { id: String(index + 1), appCampaignSetting: { appId: 'com.example.game' } }, metrics: { costMicros: cost }, segments: { date: '2026-09-10' } })) };
    return base(url, request);
  } });
  const result = await googleAdsConnector.execute('sync', {}, context);
  assert.equal(result.metrics?.length, 1); assert.equal(result.metrics?.[0]?.amountMicros, '3000000');
});
test('AdMob maps linked Android IDs to projects and excludes revenue already covered by MAX', async () => {
  const { context } = await createContext({ provider: 'admob', accountId: 'pub-1234567890123456', handler: url => {
    if (url.endsWith('pub-1234567890123456')) return { publisherId: 'pub-1234567890123456', currencyCode: 'USD', reportingTimeZone: 'America/Los_Angeles' };
    if (url.includes('/apps')) return { apps: [{ appId: 'ca-app-pub-1~1', platform: 'ANDROID', linkedAppInfo: { appStoreId: 'com.example.game', displayName: 'App' } }, { appId: 'ca-app-pub-1~2', platform: 'IOS', linkedAppInfo: { appStoreId: '123456' } }] };
    if (url.includes('/adUnits')) return { adUnits: [{ adUnitId: 'unit', appId: 'ca-app-pub-1~1' }] };
    if (url.includes('networkReport:generate')) return ['1', '2'].map(app => ({ row: { dimensionValues: { APP: { value: 'ca-app-pub-1~' + app }, DATE: { value: '20260910' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '1000000' } } } }));
    throw new Error('Unexpected request');
  } });
  const result = await admobConnector.execute('sync', {}, context);
  assert.equal(result.metrics?.[0]?.appIdentifier, 'com.example.game');
  assert.equal(result.metrics?.[1]?.appIdentifier, undefined);
  assert.equal(result.resources?.find(item => item.kind === 'ad-unit')?.data.appIdentifier, 'com.example.game');
  const facts = result.metrics!.map((metric, index) => ({ ...metric, id: String(index), connectionId: 'admob', provider: 'admob', projectId: null, collectedAt: '' } as MetricFact));
  const max: MetricFact = { ...facts[0]!, id: 'max', connectionId: 'max', provider: 'applovin-max', sourceId: 'max', amountMicros: '2000000' };
  const summary = summarizeMetrics([...facts, max]); assert.equal(summary[0]!.revenueMicros, '2000000'); assert.ok(summary[0]!.warnings?.length);
});
test('MAX rejects unsupported activation and incomplete native creation before dispatch', async () => {
  const { context, requests } = await createContext({ provider: 'applovin-max', credentials: { managementKey: 'test' }, appIdentifier: 'com.example.game', handler: () => ({}) });
  for (const input of [{ externalId: 'unit', status: 'inactive' }, { externalId: 'unit', disabled: true }]) {
    await expectCode(applovinMaxConnector.execute('update-ad-unit', input, context), 'UNSUPPORTED_OPERATION');
  }
  await expectCode(applovinMaxConnector.execute('create-ad-unit', { name: 'N', platform: 'android', format: 'NATIVE' }, context), 'INVALID_INPUT');
  assert.equal(requests.length, 0);
  assert.ok(applovinMaxConnector.capability.operationFields?.['update-ad-unit']?.some(field => field.key === 'status' && field.remove));
});
