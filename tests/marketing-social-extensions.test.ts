import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AppError } from '../packages/domain/errors.js';
import { DEFAULT_POLICY, type Connection, type Project } from '../packages/domain/index.js';
import { googleAdsConnector } from '../packages/connectors/google-ads.js';
import { applovinAdsConnector } from '../packages/connectors/applovin-ads.js';
import { applovinMaxConnector } from '../packages/connectors/applovin-max.js';
import { admobConnector } from '../packages/connectors/admob.js';
import type { ConnectorContext, ProviderRequest } from '../packages/connectors/types.js';
import { xAdapter } from '../packages/social/x.js';
import { threadsAdapter } from '../packages/social/threads.js';
import { steamNewsAdapter } from '../packages/social/steam.js';
import type { SocialContext, SocialProvider, SocialRequest } from '../packages/social/types.js';

interface Recorded { url: string; options: ProviderRequest }
const temporaryDirectories: string[] = [];
after(() => Promise.all(temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true }))));

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try { await promise; }
  catch (error) {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}`);
}

async function marketingContext(options: {
  provider: Connection['provider'];
  credentials?: Record<string, string>;
  accountId?: string;
  appIdentifier?: string;
  handler: (url: string, request: ProviderRequest) => unknown;
}): Promise<{ context: ConnectorContext; requests: Recorded[]; checkpoints: Array<Record<string, unknown>> }> {
  const workDirectory = await mkdtemp(join(tmpdir(), 'mkt-ext-'));
  temporaryDirectories.push(workDirectory);
  const requests: Recorded[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  const connection: Connection = {
    id: 'conn-1', provider: options.provider, label: 'test', accountId: options.accountId ?? '1234567890',
    status: 'connected', createdAt: now, updatedAt: now, lastCheckedAt: null, lastError: null, authKind: 'test', credentialFields: [],
  };
  const project: Project = {
    id: 'proj-1', createdAt: now, updatedAt: now, policy: DEFAULT_POLICY,
    rootPath: workDirectory, name: 'demo', engine: 'unknown', engineVersion: null,
    appIdentifier: options.appIdentifier ?? 'com.harbor.game', targets: [], findings: [], inspectedAt: now,
  };
  const context: ConnectorContext = {
    connection, credentials: { ...(options.credentials ?? {}) }, project,
    signal: new AbortController().signal, workDirectory,
    markDispatched: () => undefined,
    checkpoint: data => { checkpoints.push({ ...data }); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'oauth-access-token',
    request: async <T>(url: string, request: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      if (request.write) context.markDispatched();
      return options.handler(url, request) as T;
    },
    progress: () => undefined,
  };
  return { context, requests, checkpoints };
}

function adsHandler(options: {
  campaign?: Record<string, unknown>;
  ads?: Record<string, unknown>[];
  mutate?: Record<string, unknown>;
} = {}) {
  const campaign = options.campaign ?? {
    id: '555', name: 'Harbor UA', status: 'PAUSED', resourceName: 'customers/1234567890/campaigns/555',
    campaignBudget: 'customers/1234567890/campaignBudgets/9',
    appCampaignSetting: { appId: 'com.harbor.game' },
  };
  return (url: string, request: ProviderRequest) => {
    if (url.includes('googleAds:search')) {
      const query = String((request.json as { query?: string })?.query ?? '');
      if (query.includes('FROM customer')) {
        return { results: [{ customer: { id: '1234567890', descriptiveName: 'Test', currencyCode: 'USD', timeZone: 'UTC' } }] };
      }
      if (query.includes('FROM ad_group_ad')) return { results: options.ads ?? [] };
      if (query.includes('campaign.id !=')) return { results: [] };
      return { results: [{ campaign, campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/9', amountMicros: '50000000', explicitlyShared: false } }] };
    }
    if (url.includes('googleAds:mutate')) {
      return options.mutate ?? { mutateOperationResponses: [
        { campaignBudgetResult: { resourceName: 'customers/1234567890/campaignBudgets/9' } },
        { campaignResult: { resourceName: 'customers/1234567890/campaigns/555' } },
        { adGroupResult: { resourceName: 'customers/1234567890/adGroups/1' } },
        { adGroupAdResult: { resourceName: 'customers/1234567890/adGroupAds/1' } },
      ] };
    }
    throw new Error(url);
  };
}

test('Google Ads create-campaign with official AppAd assets mutates ad group (no type) and AppAd', async () => {
  const { context, requests } = await marketingContext({
    provider: 'google-ads', appIdentifier: 'com.harbor.game', handler: adsHandler(),
  });
  const result = await googleAdsConnector.execute('create-campaign', {
    name: 'Harbor UA', dailyBudgetMicros: '50000000', currency: 'USD', targetCpaMicros: '2000000',
    headlines: JSON.stringify(['앱 설치', '지금 플레이']),
    descriptions: JSON.stringify(['무료로 플레이하세요']),
  }, context);
  const mutate = requests.find(item => item.url.endsWith('googleAds:mutate'));
  const ops = (mutate!.options.json as { mutateOperations: Array<Record<string, Record<string, Record<string, unknown>>>> }).mutateOperations;
  assert.equal(ops[1].campaignOperation.create.status, 'PAUSED');
  assert.equal(ops[1].campaignOperation.create.containsEuPoliticalAdvertising, 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING');
  const adGroup = ops.find(item => item.adGroupOperation);
  assert.ok(adGroup);
  assert.equal(adGroup!.adGroupOperation.create.type, undefined);
  assert.equal(adGroup!.adGroupOperation.create.status, 'ENABLED');
  const ad = ops.find(item => item.adGroupAdOperation);
  const appAd = ad!.adGroupAdOperation.create.ad as { appAd: { headlines: unknown[]; descriptions: unknown[] } };
  assert.equal(appAd.appAd.headlines.length, 2);
  assert.equal(appAd.appAd.descriptions.length, 1);
  assert.equal(result.summary.hasCreatives, true);
  assert.equal(googleAdsConnector.capability.operations.includes('create-creative'), true);
});

test('Google Ads rejects short headlines before dispatch and ENABLE without AppAd', async () => {
  const { context, requests } = await marketingContext({ provider: 'google-ads', handler: adsHandler() });
  await expectCode(googleAdsConnector.execute('create-campaign', {
    name: 'x', dailyBudgetMicros: '1000000', currency: 'USD', targetCpaMicros: '1',
    headlines: JSON.stringify(['only-one']), descriptions: JSON.stringify(['desc']),
  }, context), 'CREATIVE_REQUIRED');
  assert.equal(requests.some(item => item.options.write), false);
  await expectCode(googleAdsConnector.execute('update-campaign', { externalId: '555', status: 'ENABLED' }, context), 'CREATIVE_REQUIRED');
});

test('Google Ads ENABLE after confirmed AppAd and create-creative payload', async () => {
  const ads = [{ adGroupAd: { status: 'ENABLED', ad: { appAd: { headlines: [{ text: 'A cool puzzle game' }, { text: 'Remove connected blocks' }], descriptions: [{ text: '3 difficulty levels' }] } } } }];
  const ready = await marketingContext({ provider: 'google-ads', handler: adsHandler({ ads, campaign: { id: '555', name: 'Harbor UA', status: 'ENABLED', resourceName: 'customers/1234567890/campaigns/555' } }) });
  const enabled = await googleAdsConnector.execute('update-campaign', { externalId: '555', status: 'ENABLED' }, ready.context);
  assert.equal(enabled.summary.updated, true);
  const create = await marketingContext({ provider: 'google-ads', handler: adsHandler() });
  await googleAdsConnector.execute('create-creative', {
    externalId: '555',
    headlines: '["헤드라인 하나","헤드라인 둘"]',
    descriptions: '["설명 문구"]',
    youtubeVideoIds: '["dQw4w9WgXcQ"]',
  }, create.context);
  const mutate = create.requests.find(item => item.url.endsWith('googleAds:mutate'));
  const ops = (mutate!.options.json as { mutateOperations: Array<Record<string, unknown>> }).mutateOperations;
  assert.ok(ops.some(item => (item as { assetOperation?: { create?: { youtubeVideoAsset?: { youtubeVideoId: string } } } }).assetOperation?.create?.youtubeVideoAsset?.youtubeVideoId === 'dQw4w9WgXcQ'));
  await expectCode(googleAdsConnector.execute('create-creative', {
    externalId: '555', headlines: 'not-json', descriptions: '["x"]',
  }, create.context), 'INVALID_INPUT');
});

test('AppLovin create requires explicit LIVE and does not send status or auto-pause', async () => {
  const { context, requests } = await marketingContext({
    provider: 'applovin-ads', accountId: '99',
    credentials: { accountId: '99', campaignManagementKey: 'cm-key' },
    handler: (url, request) => {
      if (url.includes('/campaign/create')) {
        assert.equal((request.json as { status?: string }).status, undefined);
        return { id: '12345' };
      }
      if (url.includes('/campaign/list')) {
        return [{ id: '12345', name: 'UA', status: 'LIVE', package_name: 'com.harbor.game', budget: { daily_budget_for_all_countries: '50' } }];
      }
      if (url.includes('/campaign/update')) throw new Error('must not auto-pause after create');
      throw new Error(url);
    },
  });
  await expectCode(applovinAdsConnector.execute('create-campaign', {
    name: 'UA', dailyBudgetMicros: '50000000', currency: 'USD', activation: 'PAUSED',
    platform: 'ANDROID', country: 'US', startDate: '2026-09-12', biddingStrategy: 'TARGET_GOAL_WITH_CPI_BILLING',
    goalType: 'CPI', goalValue: '1.5', trackingMethod: 'APPSFLYER',
    impressionUrl: 'https://impression.appsflyer.com/x', clickUrl: 'https://app.appsflyer.com/x',
  }, context), 'UNSUPPORTED_OPERATION');
  const created = await applovinAdsConnector.execute('create-campaign', {
    name: 'UA', dailyBudgetMicros: '50000000', currency: 'USD', activation: 'LIVE',
    platform: 'ANDROID', country: ['US', 'KR'], startDate: '2026-09-12', biddingStrategy: 'TARGET_GOAL_WITH_CPI_BILLING',
    goalType: 'CPI', goalValue: '1.5', trackingMethod: 'APPSFLYER',
    impressionUrl: 'https://impression.appsflyer.com/x', clickUrl: 'https://app.appsflyer.com/x',
  }, context);
  assert.equal(created.resources?.[0].status, 'LIVE');
  assert.equal(created.summary.statusFieldOnCreate, 'ignored');
  assert.equal(requests.some(item => item.url.includes('/campaign/update')), false);
  const createReq = requests.find(item => item.url.includes('/campaign/create'));
  const body = createReq!.options.json as Record<string, unknown>;
  assert.equal(body.status, undefined);
  assert.equal(body.type, 'APP');
  assert.equal((body.tracking as { tracking_method: string }).tracking_method, 'APPSFLYER');
});

test('AppLovin update allows LIVE on an existing campaign', async () => {
  const { context, requests } = await marketingContext({
    provider: 'applovin-ads', accountId: '99',
    credentials: { accountId: '99', campaignManagementKey: 'cm-key' },
    handler: (url, request) => {
      if (url.includes('/campaign/list')) return [{ id: '7', name: 'UA', status: 'LIVE', package_name: 'com.harbor.game', budget: { daily_budget_for_all_countries: '50' } }];
      if (url.includes('/campaign/update')) {
        assert.equal((request.json as { status?: string }).status, 'LIVE');
        return { id: '7' };
      }
      throw new Error(url);
    },
  });
  const result = await applovinAdsConnector.execute('update-campaign', { externalId: '7', status: 'LIVE' }, context);
  assert.equal(result.resources?.[0].status, 'LIVE');
});

test('AdMob and MAX sdk-integration-config are reads that do not install SDK code', async () => {
  const admob = await marketingContext({
    provider: 'admob', accountId: 'pub-1234567890123456',
    credentials: { publisherId: 'pub-1234567890123456' },
    handler: (url) => {
      if (url.match(/\/v1\/accounts\/pub-\d+$/)) return { name: 'accounts/pub-1234567890123456', publisherId: 'pub-1234567890123456', currencyCode: 'USD', reportingTimeZone: 'UTC' };
      if (url.includes('/apps')) return { apps: [
        { appId: 'ca-app-pub-1~1', platform: 'ANDROID', linkedAppInfo: { appStoreId: 'com.harbor.game', displayName: 'Harbor' } },
        { appId: 'ca-app-pub-1~2', platform: 'IOS', linkedAppInfo: { appStoreId: '1234567890', displayName: 'Harbor iOS' } },
      ] };
      if (url.includes('/adUnits')) return { adUnits: [{ adUnitId: 'ca-app-pub-1/2', displayName: 'Banner', adFormat: 'BANNER', appId: 'ca-app-pub-1~1' }] };
      throw new Error(url);
    },
  });
  const admobResult = await admobConnector.execute('sdk-integration-config', {}, admob.context);
  assert.equal(admobResult.summary.installsSdk, false);
  const admobApps = admobResult.summary.apps as Array<{
    admobAppId: string; platform: string;
    androidManifest?: { metaDataName: string; value: string };
    infoPlist?: { key: string; value: string };
  }>;
  assert.equal(admobApps[0].admobAppId, 'ca-app-pub-1~1');
  assert.equal(admobApps[0].androidManifest?.metaDataName, 'com.google.android.gms.ads.APPLICATION_ID');
  assert.equal(admobApps[0].infoPlist, undefined);
  assert.equal(admobApps[1].infoPlist?.key, 'GADApplicationIdentifier');
  assert.equal(admobApps[1].infoPlist?.value, 'ca-app-pub-1~2');
  assert.equal(admobApps[1].androidManifest, undefined);
  assert.equal(admobResult.summary.iosDocumentation, 'https://developers.google.com/admob/ios/quick-start');
  assert.equal(admob.requests.some(item => item.options.write), false);
  assert.equal(admobConnector.capability.operations.includes('sdk-integration-config'), true);

  const storedSdkKey = 'sdk-from-dashboard';
  const max = await marketingContext({
    provider: 'applovin-max',
    credentials: { managementKey: 'mgmt', sdkKey: storedSdkKey },
    handler: () => [{ id: 'unit-1', name: 'Rewarded', platform: 'ios', package_name: 'com.harbor.game', ad_format: 'REWARD', disabled: false }],
  });
  const maxResult = await applovinMaxConnector.execute('sdk-integration-config', {}, max.context);
  const serialized = JSON.stringify(maxResult);
  assert.equal(maxResult.summary.installsSdk, false);
  assert.equal(maxResult.summary.sdkKey, undefined);
  assert.equal('sdkKey' in maxResult.summary, false);
  assert.equal(maxResult.summary.sdkKeyConfigured, true);
  assert.equal(maxResult.summary.sdkKeyPlaceholder, '«SDK-key»');
  assert.equal(serialized.includes(storedSdkKey), false, 'stored SDK key bytes must not appear in summary or resources');
  assert.equal(maxResult.summary.androidManifest, undefined, 'iOS must not receive a top-level AndroidManifest');
  const androidGuide = maxResult.summary.android as { androidManifest: { metaDataName: string; value: string }; initializer: string };
  const iosGuide = maxResult.summary.ios as { initializer: string; androidManifest?: unknown };
  assert.equal(androidGuide.androidManifest.metaDataName, 'applovin.sdk.key');
  assert.equal(androidGuide.androidManifest.value, '«your-SDK-key»');
  assert.equal(androidGuide.androidManifest.value.includes(storedSdkKey), false);
  assert.ok(androidGuide.initializer.includes('AppLovinSdkInitializationConfiguration.builder'));
  assert.ok(String(iosGuide.initializer).includes('ALSdkInitializationConfiguration'));
  assert.equal(iosGuide.androidManifest, undefined);
  assert.equal(maxResult.summary.iosDocumentation, 'https://support.applovin.com/en/max/ios/overview/integration');
  assert.equal(max.requests.some(item => item.options.write), false);
});

test('AdMob list-apps preserves official appApprovalState and does not map pending states to ACTIVE', async () => {
  const { context } = await marketingContext({
    provider: 'admob', accountId: 'pub-1234567890123456',
    credentials: { publisherId: 'pub-1234567890123456' },
    handler: (url) => {
      if (url.includes('/apps')) return { apps: [
        { appId: 'ca-app-pub-1~approved', platform: 'ANDROID', appApprovalState: 'APPROVED', linkedAppInfo: { displayName: 'Live' } },
        { appId: 'ca-app-pub-1~action', platform: 'ANDROID', appApprovalState: 'ACTION_REQUIRED', linkedAppInfo: { displayName: 'Needs action' } },
        { appId: 'ca-app-pub-1~review', platform: 'IOS', appApprovalState: 'IN_REVIEW', manualAppInfo: { displayName: 'Reviewing' } },
        { appId: 'ca-app-pub-1~unset', platform: 'ANDROID', manualAppInfo: { displayName: 'Unset' } },
      ] };
      throw new Error(url);
    },
  });
  const result = await admobConnector.execute('list-apps', {}, context);
  const byId = Object.fromEntries((result.resources ?? []).map(item => [item.externalId, item]));
  assert.equal(byId['ca-app-pub-1~approved'].status, 'ACTIVE');
  assert.equal(byId['ca-app-pub-1~approved'].data.appApprovalState, 'APPROVED');
  assert.equal(byId['ca-app-pub-1~action'].status, 'ACTION_REQUIRED');
  assert.equal(byId['ca-app-pub-1~action'].data.appApprovalState, 'ACTION_REQUIRED');
  assert.equal(byId['ca-app-pub-1~review'].status, 'IN_REVIEW');
  assert.equal(byId['ca-app-pub-1~review'].data.appApprovalState, 'IN_REVIEW');
  assert.notEqual(byId['ca-app-pub-1~action'].status, 'ACTIVE');
  assert.notEqual(byId['ca-app-pub-1~review'].status, 'ACTIVE');
  assert.notEqual(byId['ca-app-pub-1~unset'].status, 'ACTIVE');
  assert.equal(byId['ca-app-pub-1~unset'].status, 'APP_APPROVAL_STATE_UNSPECIFIED');
});

interface SocialRecorded { url: string; options: SocialRequest }

function socialContext(options: {
  provider: SocialProvider;
  accountId?: string;
  withProject?: boolean;
  handler: (url: string, request: SocialRequest) => unknown;
}) {
  const requests: SocialRecorded[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const context: SocialContext = {
    connection: { id: 'conn-1', provider: options.provider, accountId: options.accountId ?? '1000000000000001' },
    credentials: {},
    project: options.withProject === false ? undefined : { appIdentifier: 'com.harbor.game' },
    signal: new AbortController().signal,
    markDispatched: () => undefined,
    checkpoint: data => { checkpoints.push({ ...data }); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'social-access-token',
    request: async <T>(url: string, request: SocialRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      return options.handler(url, request) as T;
    },
    progress: () => undefined,
    sleep: async () => undefined,
  };
  return { context, requests, checkpoints };
}

test('X delete-post verifies ownership then DELETE /2/tweets/:id', async () => {
  const { context, requests, checkpoints } = socialContext({
    provider: 'x',
    handler: (url, request) => {
      if (url.includes('/users/me')) return { data: { id: '1000000000000001', username: 'harbor' } };
      if (url.includes('/tweets/1800000000000000001') && (request.method ?? 'GET') === 'GET') {
        return { data: { id: '1800000000000000001', author_id: '1000000000000001' } };
      }
      if (request.method === 'DELETE' && url.endsWith('/tweets/1800000000000000001')) {
        return { data: { deleted: true } };
      }
      throw new Error(url);
    },
  });
  const result = await xAdapter.execute('delete-post', { postId: '1800000000000000001' }, context);
  const del = requests.find(item => item.options.method === 'DELETE');
  assert.ok(del);
  assert.equal(del!.options.write, true);
  assert.equal(result.summary.deleted, true);
  assert.ok(checkpoints.some(item => item.operation === 'delete-post'));
  const other = socialContext({
    provider: 'x',
    handler: (url, request) => {
      if (url.includes('/users/me')) return { data: { id: '1000000000000001' } };
      if ((request.method ?? 'GET') === 'GET') return { data: { id: '9', author_id: '999' } };
      throw new Error('delete must not run');
    },
  });
  await expectCode(xAdapter.execute('delete-post', { postId: '1800000000000000002' }, other.context), 'ACCOUNT_MISMATCH');
});

test('X hide-reply sends PUT /hidden and stays unresolved on timeout', async () => {
  const ok = socialContext({
    provider: 'x',
    handler: (url, request) => {
      if (url.includes('/users/me')) return { data: { id: '1000000000000001' } };
      if (url.endsWith('/hidden') && request.method === 'PUT') return { data: { hidden: true } };
      throw new Error(url);
    },
  });
  const hidden = await xAdapter.execute('hide-reply', { postId: '1800000000000000003', hide: 'true' }, ok.context);
  assert.equal(hidden.summary.hidden, true);
  const timeout = socialContext({
    provider: 'x',
    handler: (url, request) => {
      if (url.includes('/users/me')) return { data: { id: '1000000000000001' } };
      if (request.method === 'PUT') throw new AppError('TEMPORARY', 'no response', 503);
      throw new Error(url);
    },
  });
  const unresolved = await xAdapter.execute('hide-reply', { postId: '1800000000000000003', hide: true }, timeout.context);
  assert.equal(unresolved.unresolved, true);
});

test('Threads IMAGE URL post and carousel children are not published', async () => {
  let publishes = 0;
  const { context, requests } = socialContext({
    provider: 'threads',
    handler: (url, request) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/threads_publish')) { publishes += 1; return { id: '9000000000000000999' }; }
      if (url.includes('/threads') && request.method === 'POST') {
        const form = request.form ?? {};
        if (form.is_carousel_item === 'true') return { id: form.image_url?.includes('2') ? '7000000000000000002' : '7000000000000000001' };
        if (form.media_type === 'CAROUSEL') return { id: '7000000000000000099' };
        if (form.media_type === 'IMAGE') return { id: '7000000000000000100' };
        return { id: '7000000000000000000' };
      }
      if (/\/\d+\?fields=id,status/.test(url)) return { id: 'x', status: 'FINISHED' };
      if (url.includes('fields=id,text')) return { id: '9000000000000000999', permalink: 'https://www.threads.net/@harbor/post/z' };
      throw new Error(url);
    },
  });
  const image = await threadsAdapter.execute('create-post', {
    mediaType: 'IMAGE', imageUrl: 'https://cdn.example.com/shot.jpg', text: '업데이트',
  }, context);
  const imageForm = requests.find(item => item.options.form?.media_type === 'IMAGE' && !item.options.form?.is_carousel_item);
  assert.equal(imageForm!.options.form?.image_url, 'https://cdn.example.com/shot.jpg');
  assert.equal(image.resources?.[0].externalId, '9000000000000000999');
  publishes = 0;
  const carousel = socialContext({
    provider: 'threads',
    handler: (url, request) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/threads_publish')) { publishes += 1; return { id: '9000000000000000888' }; }
      if (url.includes('/threads') && request.method === 'POST') {
        const form = request.form ?? {};
        if (form.is_carousel_item === 'true') return { id: `700000000000000000${form.image_url?.endsWith('b.jpg') ? '2' : '1'}` };
        return { id: '7000000000000000088' };
      }
      if (/\/\d+\?fields=id,status/.test(url)) return { id: 'x', status: 'FINISHED' };
      return { id: '9000000000000000888', permalink: 'https://www.threads.net/@harbor/post/c' };
    },
  });
  await threadsAdapter.execute('create-post', {
    mediaType: 'CAROUSEL', mediaUrls: JSON.stringify(['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg']),
  }, carousel.context);
  const childPosts = carousel.requests.filter(item => item.options.form?.is_carousel_item === 'true');
  assert.equal(childPosts.length, 2);
  const parent = carousel.requests.find(item => item.options.form?.media_type === 'CAROUSEL');
  assert.equal(parent!.options.form?.children?.split(',').length, 2);
  assert.equal(publishes, 1, 'only the carousel parent is published');
});

test('Threads rejects private media URLs and hide/delete use official endpoints', async () => {
  const { context, requests } = socialContext({
    provider: 'threads',
    handler: (url, request) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/manage_reply')) {
        assert.equal(request.form?.hide, 'true');
        return { success: true };
      }
      if (request.method === 'DELETE') return { success: true, deleted_id: '6000000000000000001' };
      throw new Error(url);
    },
  });
  await expectCode(threadsAdapter.execute('create-post', { mediaType: 'IMAGE', imageUrl: 'http://example.com/a.jpg' }, context), 'INVALID_INPUT');
  await expectCode(threadsAdapter.execute('create-post', { mediaType: 'IMAGE', imageUrl: 'https://127.0.0.1/a.jpg' }, context), 'INVALID_INPUT');
  await expectCode(threadsAdapter.execute('create-post', { mediaType: 'CAROUSEL', mediaUrls: '["https://cdn.example.com/only-one.jpg"]' }, context), 'INVALID_INPUT');
  const hidden = await threadsAdapter.execute('hide-reply', { postId: '6000000000000000002', hide: 'true' }, context);
  assert.equal(hidden.summary.success, true);
  assert.ok(requests.some(item => item.url.includes('/manage_reply') && item.options.write === true));
  const deleted = await threadsAdapter.execute('delete-post', { postId: '6000000000000000001' }, context);
  assert.equal(deleted.summary.deleted, true);
  assert.ok(requests.some(item => item.options.method === 'DELETE' && item.options.write === true));
});

test('Threads list-posts from the own-user endpoint is owned so first sync can delete', async () => {
  const { context, requests } = socialContext({
    provider: 'threads',
    handler: (url) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/replies')) return { data: [{ id: '5', text: 'nice', is_reply_owned_by_me: false }], paging: {} };
      if (url.includes('/threads')) return { data: [{ id: '1', text: 'own post', permalink: 'https://www.threads.net/@harbor/post/a' }], paging: {} };
      throw new Error(url);
    },
  });
  const posts = await threadsAdapter.execute('list-posts', {}, context);
  assert.equal(posts.resources?.[0].kind, 'post');
  assert.equal(posts.resources?.[0].data.owned, true);
  assert.equal(posts.resources?.every(item => item.data.owned === true), true);
  const list = requests.find(item => item.url.includes('/threads') && !item.url.includes('/replies'));
  assert.ok(list);
  const replies = await threadsAdapter.execute('list-replies', { postId: '6000000000000000001' }, context);
  assert.equal(replies.resources?.[0].kind, 'reply');
  assert.equal(replies.resources?.[0].data.owned, false, 'reply/mention rows must not inherit own-user list-posts owned:true');
});

test('Steam prepare-news is an explicit platform action with no write HTTP', async () => {
  let called = 0;
  const { context } = socialContext({
    provider: 'steam',
    accountId: '440',
    handler: () => { called += 1; throw new Error('no steam write'); },
  });
  const result = await steamNewsAdapter.execute('prepare-news', { appId: '440' }, context);
  assert.equal(called, 0);
  assert.equal(result.summary.published, false);
  assert.equal(result.summary.platformAction, true);
  assert.equal(result.unresolved, true);
  assert.equal(result.summary.actionUrl, 'https://partner.steamgames.com/apps/news/440');
  await expectCode(steamNewsAdapter.execute('create-post', { text: 'news' }, context), 'UNSUPPORTED_OPERATION');
});
