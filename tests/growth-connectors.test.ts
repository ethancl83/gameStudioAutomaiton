import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppError } from '../packages/domain/errors.js';
import { DEFAULT_POLICY, type Connection, type Project } from '../packages/domain/index.js';
import { googleAdsConnector } from '../packages/connectors/google-ads.js';
import { applovinMaxConnector } from '../packages/connectors/applovin-max.js';
import { isWriteOperation, type ConnectorContext, type ProviderRequest } from '../packages/connectors/types.js';

interface Recorded { url: string; options: ProviderRequest }
type Handler = (url: string, request: ProviderRequest, query: string) => unknown;

function createContext(provider: Connection['provider'], handler: Handler, appIdentifier?: string) {
  const requests: Recorded[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  const connection: Connection = {
    id: 'conn-1', provider, label: 'test', accountId: '1234567890', status: 'connected', createdAt: now, updatedAt: now,
    lastCheckedAt: null, lastError: null, authKind: 'test', credentialFields: [],
  };
  const project: Project | undefined = appIdentifier === undefined ? undefined : {
    id: 'proj-1', createdAt: now, updatedAt: now, policy: DEFAULT_POLICY, rootPath: '/tmp/none', name: 'demo', engine: 'unknown', engineVersion: null,
    appIdentifier, targets: [], findings: [], inspectedAt: now,
  };
  const context: ConnectorContext = {
    connection, credentials: provider === 'applovin-max' ? { managementKey: 'mk' } : {}, project,
    signal: new AbortController().signal, workDirectory: '/tmp/none',
    markDispatched: () => undefined,
    checkpoint: data => { checkpoints.push({ ...data }); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'oauth-access-token',
    request: async <T>(url: string, request: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      return handler(url, request, String((request.json as { query?: string } | undefined)?.query ?? '')) as T;
    },
    progress: () => undefined,
  };
  const writes = () => requests.filter(item => item.options.write === true);
  return { context, requests, checkpoints, writes };
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

const CUSTOMER = { results: [{ customer: { id: '1234567890', currencyCode: 'USD', timeZone: 'UTC', descriptiveName: 'T', manager: false } }] };
const APP_CAMPAIGNS = { results: [{ campaign: { id: '11', advertisingChannelType: 'MULTI_CHANNEL', advertisingChannelSubType: 'APP_CAMPAIGN' } }] };
const exp = (id: string, extra: Record<string, unknown> = {}) => ({ experiment: { resourceName: `customers/1234567890/experiments/${id}`, experimentId: id, name: `E${id}`, type: 'COMPARE_CAMPAIGNS', status: 'ENABLED', ...extra } });
const arm = (experimentId: string, suffix: string, control: boolean, split: string | undefined, campaigns: string[]) => ({ experimentArm: {
  resourceName: `customers/1234567890/experimentArms/${experimentId}~${suffix}`, name: control ? 'control' : 'treatment',
  experiment: `customers/1234567890/experiments/${experimentId}`, control, ...(split === undefined ? {} : { trafficSplit: split }),
  campaigns: campaigns.map(id => `customers/1234567890/campaigns/${id}`),
} });

test('probe-experiments maps permission, unsupported, missing allowlist, and campaign mix evidence without writes', async () => {
  const cases: Array<{ experiments: () => unknown; level: string; verification: string; reason: RegExp }> = [
    { experiments: () => { throw new AppError('PERMISSION_REQUIRED', '권한 없음', 403); }, level: 'action_required', verification: 'fixture', reason: /권한/ },
    { experiments: () => { throw new AppError('PROVIDER_REJECTED', 'rejected', 422); }, level: 'unsupported', verification: 'fixture', reason: /허용하지 않았습니다/ },
    { experiments: () => ({ results: [exp('1', { type: 'SEARCH_CUSTOM' })] }), level: 'action_required', verification: 'read_verified', reason: /allowlist/ },
    { experiments: () => ({ results: [exp('2')] }), level: 'read', verification: 'read_verified', reason: /실계정/ },
  ];
  for (const item of cases) {
    const { context, requests, writes } = createContext('google-ads', (_url, _request, query) => {
      if (query.includes('FROM customer')) return CUSTOMER;
      if (query.includes('FROM experiment')) return item.experiments();
      if (query.includes('FROM campaign')) return APP_CAMPAIGNS;
      throw new Error(query);
    });
    const result = await googleAdsConnector.execute('probe-experiments', {}, context);
    const capability = result.summary.capability as { level: string; verification: string; reasons: string[]; kind: string };
    assert.equal(capability.level, item.level);
    assert.equal(capability.verification, item.verification);
    assert.equal(capability.kind, 'ads_native_experiment');
    assert.ok(capability.reasons.some(reason => item.reason.test(reason)), capability.reasons.join(' / '));
    assert.ok(capability.reasons.some(reason => /Campaign Mix/.test(reason)));
    assert.equal(writes().length, 0);
    assert.ok(requests.every(request => request.options.write === false));
  }
});

test('list-experiments returns arms and marks missing traffic split as unproven assignment', async () => {
  const { context, writes } = createContext('google-ads', (_url, _request, query) => {
    if (query.includes('FROM customer')) return CUSTOMER;
    if (query.includes('FROM experiment_arm')) return { results: [arm('1', '1', true, '50', ['11']), arm('1', '2', false, '50', ['22']), arm('2', '1', true, '50', ['33']), arm('2', '2', false, undefined, ['44'])] };
    if (query.includes('FROM experiment')) return { results: [exp('1'), exp('2', { startDate: '2026-09-01' })] };
    throw new Error(query);
  });
  const result = await googleAdsConnector.execute('list-experiments', {}, context);
  assert.deepEqual(result.resourceSnapshots, [{ kind: 'experiment' }]);
  assert.deepEqual(result.resources?.map(item => [item.kind, item.externalId, item.data.assignmentValid]), [['experiment', '1', true], ['experiment', '2', false]]);
  const arms = result.resources![0]!.data.arms as Array<Record<string, unknown>>;
  assert.deepEqual(arms.map(item => [item.control, item.trafficSplit, item.campaigns]), [[true, 50, ['customers/1234567890/campaigns/11']], [false, 50, ['customers/1234567890/campaigns/22']]]);
  assert.match((result.resources![1]!.data.assignmentReasons as string[]).join(' '), /트래픽 분할 값이 없습니다/);
  assert.equal(result.resources![1]!.data.startDate, '2026-09-01');
  assert.equal(writes().length, 0);
});

test('experiment-metrics emits per-arm daily attribution facts clamped to the experiment window', async () => {
  let metricQuery = '';
  const { context, writes } = createContext('google-ads', (_url, _request, query) => {
    if (query.includes('FROM customer')) return CUSTOMER;
    if (query.includes('FROM experiment_arm')) return { results: [arm('7', '1', true, '50', ['11']), arm('7', '2', false, '50', ['22'])] };
    if (query.includes('FROM experiment')) return { results: [exp('7', { startDate: '2026-09-10', endDate: '2026-09-30' })] };
    if (query.includes('metrics.cost_micros')) {
      metricQuery = query;
      return { results: [
        { campaign: { id: '11', appCampaignSetting: { appId: 'com.harbor.game' } }, segments: { date: '2026-09-10' }, metrics: { costMicros: '1500000', conversions: 2.5, conversionsValue: 12.34, clicks: '10', impressions: '1000' } },
        { campaign: { id: '22' }, segments: { date: '2026-09-11' }, metrics: { costMicros: '0', clicks: '0', impressions: '5' } },
      ] };
    }
    throw new Error(query);
  });
  await expectCode(googleAdsConnector.execute('experiment-metrics', { experimentId: '7', startDate: '2026-09-12', endDate: '2026-09-01' }, context), 'INVALID_INPUT');
  const result = await googleAdsConnector.execute('experiment-metrics', { experimentId: '7', startDate: '2026-09-01', endDate: '2026-09-20' }, context);
  assert.match(metricQuery, /campaign\.id IN \(11, 22\)/);
  assert.match(metricQuery, /BETWEEN '2026-09-10' AND '2026-09-20'/);
  const facts = result.attribution!;
  assert.equal(facts.length, 10);
  assert.equal(new Set(facts.map(fact => fact.sourceId)).size, 10);
  const byKind = (campaign: string, kind: string) => facts.find(fact => fact.campaignId === campaign && fact.kind === kind)!;
  assert.deepEqual(
    (({ amountMicros, currency, armId, experimentId, cohortKey, eventDate, acquisitionDate, attributionWindowDays, revision, finality, sourceWatermark, appIdentifier }) =>
      ({ amountMicros, currency, armId, experimentId, cohortKey, eventDate, acquisitionDate, attributionWindowDays, revision, finality, sourceWatermark, appIdentifier }))(byKind('11', 'spend')),
    { amountMicros: '1500000', currency: 'USD', armId: 'customers/1234567890/experimentArms/7~1', experimentId: '7', cohortKey: 'gads:11:2026-09-10', eventDate: '2026-09-10',
      acquisitionDate: '2026-09-10', attributionWindowDays: 0, revision: 1, finality: 'estimated', sourceWatermark: '2026-09-11', appIdentifier: 'com.harbor.game' },
  );
  assert.equal(byKind('11', 'revenue').amountMicros, '12340000');
  assert.equal(byKind('11', 'revenue').revenueBasis, 'gross_conversion_value');
  assert.equal(byKind('11', 'conversions').count, 2.5);
  assert.equal(byKind('22', 'conversions').count, 0);
  assert.equal(byKind('22', 'impressions').count, 5);
  assert.equal(byKind('22', 'spend').armId, 'customers/1234567890/experimentArms/7~2');
  assert.ok(facts.every(fact => typeof fact.observedAt === 'string'));
  assert.equal(result.summary.assignmentValid, true);
  assert.equal(writes().length, 0);
});

test('experiment-metrics excludes campaigns shared by arms and reports unproven assignment', async () => {
  const { context } = createContext('google-ads', (_url, _request, query) => {
    if (query.includes('FROM customer')) return CUSTOMER;
    if (query.includes('FROM experiment_arm')) return { results: [arm('8', '1', true, '50', ['11']), arm('8', '2', false, '50', ['11'])] };
    if (query.includes('FROM experiment')) return { results: [exp('8')] };
    throw new Error(`no metric query expected: ${query}`);
  });
  const result = await googleAdsConnector.execute('experiment-metrics', { experimentId: '8', startDate: '2026-09-01', endDate: '2026-09-02' }, context);
  assert.deepEqual(result.attribution, []);
  assert.equal(result.summary.assignmentValid, false);
  assert.deepEqual(result.summary.excludedSharedCampaigns, ['11']);
});

function createHandler(state: { experiment?: Record<string, unknown>; arms: unknown[]; failArms?: boolean }) {
  return (url: string, request: ProviderRequest, query: string) => {
    if (query.includes('FROM customer')) return CUSTOMER;
    if (query.includes('FROM campaign')) return { results: [
      { campaign: { id: '11', resourceName: 'customers/1234567890/campaigns/11', status: 'PAUSED', advertisingChannelType: 'MULTI_CHANNEL', appCampaignSetting: { appId: 'com.harbor.game' } } },
      { campaign: { id: '22', resourceName: 'customers/1234567890/campaigns/22', status: 'PAUSED', advertisingChannelType: 'MULTI_CHANNEL', appCampaignSetting: { appId: 'com.harbor.game' } } },
    ] };
    if (query.includes('FROM experiment_arm')) return { results: state.arms };
    if (query.includes('FROM experiment')) return { results: state.experiment ? [state.experiment] : [] };
    if (url.endsWith('/experiments:mutate')) {
      const create = (request.json as { operations: Array<{ create: Record<string, unknown> }> }).operations[0]!.create;
      state.experiment = { experiment: { resourceName: 'customers/1234567890/experiments/77', experimentId: '77', ...create } };
      return { results: [{ resourceName: 'customers/1234567890/experiments/77' }] };
    }
    if (url.endsWith('/experimentArms:mutate')) {
      const operations = (request.json as { operations: Array<{ create: Record<string, unknown> }> }).operations;
      state.arms = operations.map((operation, index) => ({ experimentArm: { ...operation.create, resourceName: `customers/1234567890/experimentArms/77~${index + 1}` } }));
      if (state.failArms) throw new AppError('TEMPORARY', 'lost response', 503);
      return { results: state.arms.map(item => ({ resourceName: (item as { experimentArm: { resourceName: string } }).experimentArm.resourceName })) };
    }
    if (url.endsWith(':scheduleExperiment')) return { name: 'customers/1234567890/operations/abc' };
    throw new Error(url + query);
  };
}

const CREATE_INPUT = { name: 'Harbor bid test', requestKey: 'req-12345678', controlCampaignId: '11', treatmentCampaignId: '22', controlTrafficSplit: '50' };

test('create-experiment reuses the experiment found by deterministic name after a lost arm response', async () => {
  const state: { experiment?: Record<string, unknown>; arms: unknown[]; failArms?: boolean } = { arms: [], failArms: true };
  const first = createContext('google-ads', createHandler(state), 'com.harbor.game');
  await expectCode(googleAdsConnector.execute('create-experiment', CREATE_INPUT, first.context), 'TEMPORARY');
  const created = first.writes().find(item => item.url.endsWith('/experiments:mutate'))!;
  const body = (created.options.json as { operations: Array<{ create: Record<string, unknown> }> }).operations[0]!.create;
  assert.deepEqual(body, { name: 'Harbor bid test [gso:req-12345678]', type: 'COMPARE_CAMPAIGNS', status: 'SETUP' });
  const armBody = (first.writes().find(item => item.url.endsWith('/experimentArms:mutate'))!.options.json as { operations: Array<{ create: Record<string, unknown> }> }).operations.map(item => item.create);
  assert.deepEqual(armBody.map(item => [item.control, item.trafficSplit, item.campaigns]), [[true, '50', ['customers/1234567890/campaigns/11']], [false, '50', ['customers/1234567890/campaigns/22']]]);
  assert.equal(first.checkpoints[0]!.experimentId, '77');

  state.failArms = false;
  const retry = createContext('google-ads', createHandler(state), 'com.harbor.game');
  const result = await googleAdsConnector.execute('create-experiment', CREATE_INPUT, retry.context);
  assert.equal(retry.writes().length, 0, 'no second create after finding the experiment by name');
  assert.equal(result.summary.reused, true);
  assert.equal(result.summary.experimentId, '77');
  assert.equal(result.resources![0]!.data.assignmentValid, true);
});

test('create-experiment creates missing arms for an existing experiment and schedules as a long-running operation', async () => {
  const state: { experiment?: Record<string, unknown>; arms: unknown[] } = {
    arms: [], experiment: { experiment: { resourceName: 'customers/1234567890/experiments/77', experimentId: '77', name: 'Harbor bid test [gso:req-12345678]', type: 'COMPARE_CAMPAIGNS', status: 'SETUP' } },
  };
  const { context, writes, checkpoints } = createContext('google-ads', createHandler(state));
  const result = await googleAdsConnector.execute('create-experiment', { ...CREATE_INPUT, controlTrafficSplit: '30', schedule: 'true' }, context);
  assert.deepEqual(writes().map(item => item.url.split('/v25/')[1]), ['customers/1234567890/experimentArms:mutate', 'customers/1234567890/experiments/77:scheduleExperiment']);
  assert.equal(result.waitingExternal, true);
  assert.equal(result.summary.operationName, 'customers/1234567890/operations/abc');
  assert.equal(checkpoints.at(-1)!.operationName, 'customers/1234567890/operations/abc');
  assert.deepEqual((result.resources![0]!.data.arms as Array<{ trafficSplit: number }>).map(item => item.trafficSplit), [30, 70]);
});

test('create-experiment validates input and ownership before any write', async () => {
  const state = { arms: [] as unknown[] };
  const { context, writes } = createContext('google-ads', createHandler(state), 'com.other.game');
  await expectCode(googleAdsConnector.execute('create-experiment', { ...CREATE_INPUT, treatmentCampaignId: '11' }, context), 'INVALID_INPUT');
  await expectCode(googleAdsConnector.execute('create-experiment', { ...CREATE_INPUT, requestKey: 'short' }, context), 'INVALID_INPUT');
  await expectCode(googleAdsConnector.execute('create-experiment', { ...CREATE_INPUT, controlTrafficSplit: '100' }, context), 'INVALID_INPUT');
  await expectCode(googleAdsConnector.execute('create-experiment', { ...CREATE_INPUT, name: "x' OR 1=1" }, context), 'INVALID_INPUT');
  await expectCode(googleAdsConnector.execute('create-experiment', { ...CREATE_INPUT, startDate: '2026-02-30' }, context), 'INVALID_INPUT');
  await expectCode(googleAdsConnector.execute('create-experiment', CREATE_INPUT, context), 'RESOURCE_MISMATCH');
  assert.equal(writes().length, 0);
});

test('promote-experiment refuses Campaign Mix, starts system-managed promotion, and does not re-promote in progress', async () => {
  let current = exp('5');
  const { context, writes } = createContext('google-ads', (url, _request, query) => {
    if (query.includes('FROM customer')) return CUSTOMER;
    if (query.includes('FROM experiment_arm')) return { results: [] };
    if (query.includes('FROM experiment')) return { results: [current] };
    if (url.endsWith(':promoteExperiment')) return { name: 'customers/1234567890/operations/p1' };
    throw new Error(url);
  });
  await expectCode(googleAdsConnector.execute('promote-experiment', { experimentId: '5' }, context), 'UNSUPPORTED_OPERATION');
  current = exp('5', { type: 'SEARCH_CUSTOM', status: 'ENABLED' });
  const started = await googleAdsConnector.execute('promote-experiment', { experimentId: '5' }, context);
  assert.equal(started.waitingExternal, true);
  assert.equal(started.summary.operationName, 'customers/1234567890/operations/p1');
  current = exp('5', { type: 'SEARCH_CUSTOM', status: 'ENABLED', promoteStatus: 'IN_PROGRESS' });
  const again = await googleAdsConnector.execute('promote-experiment', { experimentId: '5' }, context);
  assert.equal(again.waitingExternal, true);
  assert.equal(writes().length, 1);
  current = exp('5', { type: 'SEARCH_CUSTOM', status: 'PROMOTED', promoteStatus: 'COMPLETED' });
  const reconciled = await googleAdsConnector.execute('reconcile', { experimentId: '5', action: 'promote' }, context);
  assert.equal(reconciled.summary.confirmed, true);
  assert.equal(writes().length, 1);
});

test('end-experiment ends a running experiment once and skips terminal ones', async () => {
  let current = exp('6');
  const { context, writes } = createContext('google-ads', (url, _request, query) => {
    if (query.includes('FROM customer')) return CUSTOMER;
    if (query.includes('FROM experiment_arm')) return { results: [] };
    if (query.includes('FROM experiment')) return { results: [current] };
    if (url.endsWith(':endExperiment')) { current = exp('6', { status: 'HALTED', endDate: '2026-09-24' }); return {}; }
    throw new Error(url);
  });
  const ended = await googleAdsConnector.execute('end-experiment', { experimentId: '6' }, context);
  assert.equal(ended.summary.ended, true);
  const again = await googleAdsConnector.execute('end-experiment', { experimentId: '6' }, context);
  assert.equal(again.summary.alreadyEnded, true);
  assert.equal(writes().length, 1);
  await expectCode(googleAdsConnector.execute('end-experiment', { experimentId: 'abc' }, context), 'INVALID_INPUT');
});

test('growth operations are classified as reads or writes', () => {
  for (const operation of ['probe-experiments', 'list-experiments', 'experiment-metrics', 'probe-ad-unit-experiments', 'list-ad-unit-experiments']) {
    assert.equal(isWriteOperation(operation), false, operation);
  }
  for (const operation of ['create-experiment', 'end-experiment', 'promote-experiment', 'create-ad-unit-experiment', 'promote-ad-unit-experiment', 'deprecate-ad-unit-experiment']) {
    assert.equal(isWriteOperation(operation), true, operation);
  }
  for (const operation of ['probe-experiments', 'list-experiments', 'experiment-metrics', 'create-experiment', 'end-experiment', 'promote-experiment']) {
    assert.ok(googleAdsConnector.capability.operations.includes(operation));
    assert.ok(googleAdsConnector.capability.operationFields?.[operation]);
  }
  for (const operation of ['probe-ad-unit-experiments', 'list-ad-unit-experiments', 'create-ad-unit-experiment', 'promote-ad-unit-experiment', 'deprecate-ad-unit-experiment']) {
    assert.ok(applovinMaxConnector.capability.operations.includes(operation));
    assert.ok(applovinMaxConnector.capability.operationFields?.[operation]);
  }
  assert.ok(googleAdsConnector.capability.limitations.some(item => /allowlist/.test(item) && /Campaign Mix/.test(item)));
  assert.ok(applovinMaxConnector.capability.limitations.some(item => /Axon/.test(item) && /획득/.test(item)));
});

function maxHandler(unit: Record<string, unknown>, experiment: Record<string, unknown> | undefined, saved: Record<string, unknown> = {}) {
  return (url: string, request: ProviderRequest) => {
    if (url.includes('/ad_units')) return [unit, { id: 'other', package_name: 'com.other', has_active_experiment: true }];
    if (url.includes('/ad_unit/')) return unit;
    if (url.includes('/ad_unit_experiment/') && request.method === 'POST') return saved;
    if (url.includes('/ad_unit_experiment/')) { if (!experiment) throw new AppError('RESOURCE_NOT_FOUND', 'none', 404); return experiment; }
    throw new Error(url);
  };
}

const UNIT = { id: 'unit1234', name: 'Inter', platform: 'android', ad_format: 'INTER', package_name: 'com.harbor.game', has_active_experiment: false, disabled: false };

test('MAX create checks the live ad unit, refuses a different active experiment, and reuses the same name', async () => {
  const active = createContext('applovin-max', maxHandler({ ...UNIT, has_active_experiment: true }, { id: 'unit1234', experiment_name: 'other_test' }), 'com.harbor.game');
  const input = { adUnitId: 'unit1234', experimentName: 'caps_test', testGroupAllocation: '25', frequencyCappingSettings: '[{"type":"time","time_capping_settings":{"day_limit":10,"minute_frequency":10}}]' };
  await expectCode(applovinMaxConnector.execute('create-ad-unit-experiment', { ...input, hasActiveExperiment: false }, active.context), 'EXPERIMENT_CONFLICT');
  assert.equal(active.writes().length, 0);
  assert.ok(active.requests[0]!.url.endsWith('/ad_unit/unit1234?fields=segments'));

  const same = createContext('applovin-max', maxHandler({ ...UNIT, has_active_experiment: true }, { id: 'unit1234', experiment_name: 'caps_test' }), 'com.harbor.game');
  const reused = await applovinMaxConnector.execute('create-ad-unit-experiment', input, same.context);
  assert.equal(reused.summary.reused, true);
  assert.equal(same.writes().length, 0);

  const fresh = createContext('applovin-max', maxHandler(UNIT, undefined, { id: 'unit1234', experiment_name: 'caps_test', disabled: false, promote: false, deprecate: false }), 'com.harbor.game');
  const created = await applovinMaxConnector.execute('create-ad-unit-experiment', input, fresh.context);
  const write = fresh.writes()[0]!;
  assert.equal(write.url, 'https://o.applovin.com/mediation/v1/ad_unit_experiment/unit1234');
  assert.equal(write.options.headers?.['Api-Key'], 'mk');
  assert.deepEqual(write.options.json, { experiment_name: 'caps_test', test_group_allocation: 25, frequency_capping_settings: [{ type: 'time', time_capping_settings: { day_limit: 10, minute_frequency: 10 } }] });
  assert.equal(created.resources![0]!.kind, 'experiment');
  assert.equal(created.resources![0]!.data.appIdentifier, 'com.harbor.game');
  assert.equal(fresh.checkpoints[0]!.adUnitId, 'unit1234');
});

test('MAX create validates payload, segment scope, and package ownership before writing', async () => {
  const { context, writes } = createContext('applovin-max', maxHandler(UNIT, undefined), 'com.other.game');
  await expectCode(applovinMaxConnector.execute('create-ad-unit-experiment', { adUnitId: 'unit1234', experimentName: 'x' }, context), 'INVALID_INPUT');
  await expectCode(applovinMaxConnector.execute('create-ad-unit-experiment', { adUnitId: 'unit1234', experimentName: 'x', bidFloors: '[]' }, context), 'INVALID_INPUT');
  await expectCode(applovinMaxConnector.execute('create-ad-unit-experiment', { adUnitId: 'unit1234', experimentName: 'x', testGroupAllocation: '30', bidFloors: '[{"cpm":"1.00"}]' }, context), 'INVALID_INPUT');
  await expectCode(applovinMaxConnector.execute('create-ad-unit-experiment', { adUnitId: 'unit1234', experimentName: 'x', segmentId: 's1', bidFloors: '[{"cpm":"1.00"}]' }, context), 'UNSUPPORTED_OPERATION');
  await expectCode(applovinMaxConnector.execute('create-ad-unit-experiment', { adUnitId: 'unit1234', experimentName: 'x', bidFloors: '[{"cpm":"1.00"}]' }, context), 'RESOURCE_MISMATCH');
  assert.equal(writes().length, 0);
});

test('MAX promote and deprecate send the official flag payloads only for the named active experiment', async () => {
  for (const [operation, flags] of [['promote-ad-unit-experiment', { promote: true, deprecate: false }], ['deprecate-ad-unit-experiment', { promote: false, deprecate: true }]] as const) {
    const { context, writes } = createContext('applovin-max', maxHandler({ ...UNIT, has_active_experiment: true }, { id: 'unit1234', experiment_name: 'caps_test' }, { message: 'Experiment successfully promoted' }), 'com.harbor.game');
    await expectCode(applovinMaxConnector.execute(operation, { adUnitId: 'unit1234', experimentName: 'wrong' }, context), 'RESOURCE_MISMATCH');
    const result = await applovinMaxConnector.execute(operation, { adUnitId: 'unit1234', experimentName: 'caps_test' }, context);
    assert.equal(writes().length, 1);
    assert.deepEqual(writes()[0]!.options.json, { id: 'unit1234', experiment_name: 'caps_test', ...flags });
    assert.equal(result.resources![0]!.status, flags.promote ? 'PROMOTED' : 'DEPRECATED');
  }
  const none = createContext('applovin-max', maxHandler(UNIT, undefined), 'com.harbor.game');
  await expectCode(applovinMaxConnector.execute('promote-ad-unit-experiment', { adUnitId: 'unit1234', experimentName: 'caps_test' }, none.context), 'RESOURCE_NOT_FOUND');
  assert.equal(none.writes().length, 0);
});

test('MAX list and probe read experiments without claiming write capability', async () => {
  const inactive = createContext('applovin-max', maxHandler(UNIT, undefined), 'com.harbor.game');
  const empty = await applovinMaxConnector.execute('list-ad-unit-experiments', { adUnitId: 'unit1234' }, inactive.context);
  assert.deepEqual(empty.resources, []);
  assert.equal(empty.summary.hasActiveExperiment, false);
  assert.equal(empty.summary.adUnitId, 'unit1234');

  const active = createContext('applovin-max', maxHandler({ ...UNIT, has_active_experiment: true }, {
    id: 'unit1234', experiment_name: 'net_test', test_group_allocation: 10, disabled: false,
    ad_network_settings: [{ ADMOB_NETWORK: { disabled: true, ad_network_app_id: 'ca-app-pub-1~2', ad_network_ad_units: [] } }],
  }), 'com.harbor.game');
  const listed = await applovinMaxConnector.execute('list-ad-unit-experiments', { adUnitId: 'unit1234' }, active.context);
  const groups = listed.resources![0]!.data.groups as { test: { allocationPercent: number; adNetworks: Array<Record<string, unknown>> } };
  assert.equal(groups.test.allocationPercent, 10);
  assert.deepEqual(groups.test.adNetworks, [{ network: 'ADMOB_NETWORK', disabled: true, adUnitCount: 0 }]);
  assert.ok(!JSON.stringify(listed).includes('ca-app-pub-1~2'));
  await expectCode(applovinMaxConnector.execute('list-ad-unit-experiments', { adUnitId: 'unit1234', segmentId: 'missing' }, active.context), 'RESOURCE_NOT_FOUND');

  const probe = await applovinMaxConnector.execute('probe-ad-unit-experiments', {}, active.context);
  const capability = probe.summary.capability as { level: string; verification: string; reasons: string[] };
  assert.equal(capability.level, 'read');
  assert.equal(capability.verification, 'fixture');
  assert.ok(capability.reasons.some(reason => reason.includes('실계정 쓰기 검증 필요')));
  assert.equal(probe.summary.adUnitCount, 1);
  assert.equal(active.writes().length, 0);
});
