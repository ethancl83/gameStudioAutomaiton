import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enforceReleasedForAds } from '../apps/controller/campaign-budget.js';
import { AutomationScheduler } from '../apps/controller/automation.js';
import { campaignPerformance, planCampaignRules } from '../packages/growth/rebalance.js';
import { Store } from '../packages/storage/index.js';
import { DEFAULT_POLICY, type Connection, type ExternalResource, type Project, type ReleaseObservation } from '../packages/domain/index.js';
import type { AttributionFact, GrowthPolicy, OperationMandate } from '../packages/growth/types.js';

const project = { id: 'p', appIdentifier: 'com.test', policy: DEFAULT_POLICY, storeApps: { 'google-play': { connectionId: 'play', appId: 'com.test' } } } as unknown as Project;
const ads = { id: 'ads', provider: 'google-ads' } as Connection;
const axon = { id: 'axon', provider: 'applovin-ads' } as Connection;
const published: ReleaseObservation = { id: 'r', projectId: 'p', connectionId: 'play', provider: 'google-play', version: '1.0', published: true, publishedAt: '2026-09-01T00:00:00Z' };

test('ads stay paused until a public store release is observed', () => {
  assert.doesNotThrow(() => enforceReleasedForAds(project, ads, 'create-campaign', { name: 'draft' }, []), 'Google Ads creates PAUSED drafts');
  assert.throws(() => enforceReleasedForAds(project, ads, 'update-campaign', { externalId: '1', status: 'ENABLED' }, []), { code: 'APP_NOT_RELEASED' });
  assert.throws(() => enforceReleasedForAds(project, axon, 'create-campaign', { activation: 'LIVE' }, [{ ...published, published: false }]), { code: 'APP_NOT_RELEASED' });
  assert.doesNotThrow(() => enforceReleasedForAds(project, ads, 'pause-campaign', { externalId: '1' }, []), 'pausing is always allowed');
  assert.doesNotThrow(() => enforceReleasedForAds(project, ads, 'update-campaign', { externalId: '1', status: 'ENABLED' }, [published]));
  assert.doesNotThrow(() => enforceReleasedForAds({ ...project, storeApps: undefined }, ads, 'update-campaign', { status: 'ENABLED' }, []), 'unmapped projects keep the existing policy');
});

const DAY = 86_400_000;
const now = new Date('2026-09-24T00:00:00Z');
const policy = { projectId: 'p', version: 1, alpha: 0.05, multiplicity: 'holm', defaultStopping: 'fixed_horizon', freshnessHours: { 'google-ads': 48 }, fxMaxAgeHours: 48, variableCostRate: 0, allowPricingExperiments: false, updatedAt: '' } as GrowthPolicy;
const mandate = { id: 'm', projectId: 'p', status: 'active', actions: ['observe', 'ads-stop', 'ads-rebalance'], connectionIds: ['ads'], goals: { roas: { target: 1.2, basis: 'gross_conversion_value', windowDays: 0 } },
  limits: { currency: 'USD', maxDailySpendMicros: '100000000', maxTotalSpendMicros: '1', maxLossMicros: '1', maxBudgetStep: 0.2, cooldownHours: 24, maxDailyReplies: 0, campaignStopRoasBelow: 0.3, minDecisionSpendMicros: '50000000' },
  startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-30T00:00:00Z' } as unknown as OperationMandate;
const campaign = (id: string, budget: string): ExternalResource => ({ id, connectionId: 'ads', projectId: 'p', provider: 'google-ads', kind: 'campaign', externalId: id, name: id, status: 'ENABLED', data: { dailyBudgetMicros: budget, currency: 'USD' }, updatedAt: '' });
function facts(id: string, spend: number, revenue: number): AttributionFact[] {
  const out: AttributionFact[] = [];
  for (let day = 2; day <= 8; day++) {
    const date = new Date(now.getTime() - day * DAY).toISOString().slice(0, 10);
    const base = { projectId: 'p', provider: 'google-ads' as const, connectionId: 'ads', campaignId: id, acquisitionDate: date, eventDate: date, currency: 'USD', observedAt: now.toISOString(), collectedAt: now.toISOString(), sourceWatermark: date, revision: 1, finality: 'estimated' as const };
    out.push({ ...base, id: `${id}-s-${date}`, kind: 'spend', amountMicros: String(spend), sourceId: `${id}:s:${date}` });
    out.push({ ...base, id: `${id}-r-${date}`, kind: 'revenue', amountMicros: String(revenue), revenueBasis: 'gross_conversion_value', attributionWindowDays: 0, sourceId: `${id}:r:${date}` });
  }
  return out;
}

test('campaign rules stop very poor campaigns and move one budget step from under- to over-performers', () => {
  const campaigns = [campaign('good', '20000000'), campaign('weak', '20000000'), campaign('bad', '20000000'), campaign('tiny', '20000000')];
  const all = [...facts('good', 10_000_000, 20_000_000), ...facts('weak', 10_000_000, 8_000_000), ...facts('bad', 10_000_000, 1_000_000), ...facts('tiny', 1_000_000, 0)];
  const performance = campaignPerformance({ campaigns, facts: all, policy, now, windowDays: 0, basis: 'gross_conversion_value', lookbackDays: 14 });
  assert.equal(performance.find(item => item.campaignId === 'good')!.roas, 2);
  const plan = planCampaignRules({ mandate, performance, lastChangeAt: {}, now });
  assert.deepEqual(plan.stops.map(item => item.campaignId), ['bad']);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0]!.from.campaignId, 'weak', 'stopped and below-minimum-spend campaigns are not rebalanced');
  assert.equal(plan.moves[0]!.to.campaignId, 'good');
  assert.equal(plan.moves[0]!.fromBudgetMicros, '16000000');
  assert.equal(plan.moves[0]!.toBudgetMicros, '24000000', 'total daily budget unchanged');
  const cooled = planCampaignRules({ mandate, performance, lastChangeAt: { 'ads:good': new Date(now.getTime() - 3_600_000).toISOString() }, now });
  assert.equal(cooled.moves.length, 0);
  const stale = campaignPerformance({ campaigns, facts: all, policy, now: new Date(now.getTime() + 5 * DAY), windowDays: 0, basis: 'gross_conversion_value', lookbackDays: 14 });
  assert.equal(planCampaignRules({ mandate, performance: stale, lastChangeAt: {}, now }).moves.length, 0, 'stale data never moves budget');
  assert.equal(planCampaignRules({ mandate: { ...mandate, limits: { ...mandate.limits, minDecisionSpendMicros: undefined } }, performance, lastChangeAt: {}, now }).stops.length, 0);
});

test('a device that handed over via transfer backup stops write automations but keeps read syncs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'appops-transfer-')); const store = new Store(directory, { heartbeat: false });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.put('connection', 'ads', { id: 'ads', provider: 'google-ads', status: 'connected' } as Connection);
  store.put('project', 'p', { ...project, policy: { ...DEFAULT_POLICY, autoRelease: true }, rootPath: directory, targets: ['android'] });
  store.put('settings', 'device-transferred', { at: now.toISOString(), backupId: 'b' });
  const calls: string[] = [];
  const scheduler = new AutomationScheduler(store, { build: () => { calls.push('build'); throw new Error('no'); }, action: (_id, input) => { calls.push((input as { operation: string }).operation); return { id: 'r' } as never; },
    reconcile: () => { throw new Error('no'); }, supported: (_provider, operation) => operation === 'sync', socialCycle: () => { calls.push('social'); }, growthCycle: () => { calls.push('growth'); } });
  scheduler.start(); await scheduler.tick(); await scheduler.stop();
  assert.deepEqual(calls, ['sync']);
});

test('rebalancing never raises the receiving campaign by more than one budget step', () => {
  const campaigns = [campaign('small-good', '10000000'), campaign('big-weak', '100000000')];
  const all = [...facts('small-good', 10_000_000, 20_000_000), ...facts('big-weak', 10_000_000, 8_000_000)];
  const performance = campaignPerformance({ campaigns, facts: all, policy, now, windowDays: 0, basis: 'gross_conversion_value', lookbackDays: 14 });
  const plan = planCampaignRules({ mandate: { ...mandate, actions: ['observe', 'ads-rebalance'] } as OperationMandate, performance, lastChangeAt: {}, now });
  assert.equal(plan.moves[0]!.toBudgetMicros, '12000000', '+20% of the receiver, not 20% of the giver');
  assert.equal(plan.moves[0]!.fromBudgetMicros, '98000000');
});
