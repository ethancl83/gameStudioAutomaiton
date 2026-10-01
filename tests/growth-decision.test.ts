import test from 'node:test';
import assert from 'node:assert/strict';
import { ALGORITHM_VERSION, evaluateExperiment, invalidateDecision } from '../packages/growth/decision.js';
import { sequentialNominalAlpha } from '../packages/growth/stats.js';
import type { AttributionFact, Experiment, GrowthPolicy, OperationMandate } from '../packages/growth/types.js';

const policy: GrowthPolicy = { projectId: 'p', version: 2, alpha: 0.05, multiplicity: 'holm', defaultStopping: 'fixed_horizon',
  freshnessHours: { 'google-ads': 24, 'google-play': 48 }, fxMaxAgeHours: 48, variableCostRate: 0, allowPricingExperiments: false, updatedAt: '2026-09-01T00:00:00Z' };
const mandate = { id: 'm', projectId: 'p', version: 1, status: 'active', actions: ['observe', 'ads-experiment', 'ads-scale', 'ads-stop'],
  limits: { currency: 'USD', maxDailySpendMicros: '100000000000', maxTotalSpendMicros: '1000000000000', maxLossMicros: '1000000000000', maxBudgetStep: 0.2, cooldownHours: 24, maxDailyReplies: 0 },
  startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' } as OperationMandate;
const experiment: Experiment = {
  id: 'e', projectId: 'p', mandateId: 'm', version: 1, kind: 'ads', provider: 'google-ads', connectionId: 'ads', design: 'native_ab',
  hypothesis: { change: '소재', cohort: '신규', primaryMetric: 'conversion_rate', guardrails: [], minimumEffect: 0.1, attributionWindowDays: 3,
    minDurationDays: 7, maxDurationDays: 28, minSamplePerArm: 1000 },
  stopping: { kind: 'fixed_horizon' }, alpha: 0.05, multiplicity: 'holm',
  arms: [{ id: 'a', role: 'control', label: '대조군', campaignId: 'ca' }, { id: 'b', role: 'treatment', label: '실험군', campaignId: 'cb' }],
  status: 'observing', startedAt: '2026-09-01T00:00:00Z', horizonAt: '2026-09-15T00:00:00Z', looksUsed: 0, runIds: [], policyVersion: 2,
  createdAt: '2026-08-30T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

let sequence = 0;
function fact(armId: string, partial: Partial<AttributionFact>, observedAt: string): AttributionFact {
  sequence += 1;
  return { id: `f${String(sequence).padStart(4, '0')}`, projectId: 'p', provider: 'google-ads', connectionId: 'ads', experimentId: 'e', armId, kind: 'clicks',
    eventDate: '2026-09-03', acquisitionDate: '2026-09-03', observedAt, collectedAt: observedAt, sourceId: 'ads', sourceWatermark: 'w', revision: 1, finality: 'settled', ...partial };
}
/** arm별 클릭·전환을 5일(09-01~09-05)에 나눠 만든다. */
function conversions(arms: Record<string, [number, number]>, observedAt: string, day = (index: number) => `2026-09-0${index + 1}`): AttributionFact[] {
  return Object.entries(arms).flatMap(([armId, [clicks, converted]]) => [0, 1, 2, 3, 4].flatMap(index => [
    fact(armId, { kind: 'clicks', count: clicks / 5, acquisitionDate: day(index), eventDate: day(index) }, observedAt),
    fact(armId, { kind: 'conversions', count: converted / 5, acquisitionDate: day(index), eventDate: day(index) }, observedAt),
  ]));
}
const at = (iso: string) => new Date(iso);
const observedBefore = (iso: string) => new Date(Date.parse(iso) - 3_600_000).toISOString();
function run(exp: Experiment, facts: AttributionFact[], now: string) {
  return evaluateExperiment({ experiment: exp, facts, policy, mandate, fx: [], now: at(now) });
}

test('fixed horizon interim looks never produce a winner and do not consume the look', () => {
  const now = '2026-09-12T06:00:00Z';
  const decision = run(experiment, conversions({ a: [2000, 200], b: [2000, 300] }, observedBefore(now)), now);
  assert.equal(decision.outcome, 'continue');
  assert.equal(decision.kind, 'quality_check');
  assert.equal(decision.look, 0);
  assert.equal(decision.winnerArmId, undefined);
});

test('fixed horizon efficacy look picks a significant winner reproducibly', () => {
  const now = '2026-09-15T06:00:00Z';
  const facts = conversions({ a: [2000, 200], b: [2000, 300] }, observedBefore(now));
  const decision = run(experiment, facts, now);
  assert.equal(decision.outcome, 'winner');
  assert.equal(decision.kind, 'efficacy');
  assert.equal(decision.look, 1);
  assert.equal(decision.winnerArmId, 'b');
  assert.equal(decision.algorithmVersion, ALGORITHM_VERSION);
  assert.equal(decision.policyVersion, 2);
  assert.ok(decision.comparisons[0].significant && decision.comparisons[0].boundaryP === 0.05);
  assert.match(decision.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(run(experiment, [...facts].reverse(), '2026-09-15T06:00:30Z'), { ...decision, at: '2026-09-15T06:00:30.000Z' });
  // 효능 look을 이미 썼으면 다시 판정하지 않는다.
  assert.equal(run({ ...experiment, looksUsed: 1 }, facts, now).outcome, 'blocked');
});

test('no effect at the final look, and Holm correction across arms can remove significance', () => {
  const now = '2026-09-15T06:00:00Z';
  assert.equal(run(experiment, conversions({ a: [2000, 200], b: [2000, 205] }, observedBefore(now)), now).outcome, 'no_effect');
  // 단독이면 p≈0.043로 유의하지만 두 번째 실험군을 포함한 Holm 보정 후 0.086이다.
  assert.equal(run(experiment, conversions({ a: [2000, 200], b: [2000, 240] }, observedBefore(now)), now).outcome, 'winner');
  const threeArms = { ...experiment, arms: [...experiment.arms, { id: 'c', role: 'treatment' as const, label: '실험군2' }] };
  const decision = run(threeArms, conversions({ a: [2000, 200], b: [2000, 240], c: [2000, 200] }, observedBefore(now)), now);
  assert.equal(decision.outcome, 'no_effect');
  assert.ok(decision.comparisons[0].pValue! < 0.05 && decision.comparisons[0].adjustedP! > 0.05);
});

test('effects below the minimum practical effect or in the wrong direction are not winners', () => {
  const now = '2026-09-15T06:00:00Z';
  const facts = conversions({ a: [20000, 2000], b: [20000, 2150] }, observedBefore(now));
  const decision = run(experiment, facts, now);
  assert.ok(decision.comparisons[0].significant);
  assert.equal(decision.outcome, 'no_effect');
  assert.equal(run(experiment, conversions({ a: [2000, 300], b: [2000, 200] }, observedBefore(now)), now).outcome, 'no_effect');
});

test('sample shortage blocks without consuming a look and becomes inconclusive after max duration', () => {
  const small = (now: string) => conversions({ a: [100, 10], b: [100, 20] }, observedBefore(now));
  const blocked = run(experiment, small('2026-09-16T06:00:00Z'), '2026-09-16T06:00:00Z');
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.look, 0);
  assert.equal(blocked.quality.sampleSufficient, false);
  const late = run(experiment, small('2026-09-30T06:00:00Z'), '2026-09-30T06:00:00Z');
  assert.equal(late.outcome, 'inconclusive');
  assert.equal(late.look, 1);
});

test('incomplete attribution window and stale data block the efficacy look', () => {
  const now = '2026-09-15T06:00:00Z';
  const recent = conversions({ a: [2000, 200], b: [2000, 300] }, observedBefore(now), index => `2026-09-1${index + 2}`);
  const open = run(experiment, recent, now);
  assert.equal(open.outcome, 'blocked');
  assert.equal(open.quality.windowComplete, false);
  assert.ok(open.reasons.some(reason => reason.includes('귀속 창(3일)이 끝난 arm fact가 없습니다')));
  // 일부 cohort만 끝났으면 끝난 cohort만 표본에 들어가 표본 부족으로 보류한다.
  const partial = run(experiment, conversions({ a: [2000, 200], b: [2000, 300] }, observedBefore(now), index => `2026-09-1${index}`), now);
  assert.equal(partial.outcome, 'blocked');
  assert.equal(partial.arms.find(item => item.armId === 'a')!.trials, 800);
  const stale = run(experiment, conversions({ a: [2000, 200], b: [2000, 300] }, '2026-09-13T00:00:00Z'), now);
  assert.equal(stale.outcome, 'blocked');
  assert.equal(stale.quality.fresh, false);
});

test('observational comparisons never produce a winner', () => {
  const now = '2026-09-15T06:00:00Z';
  const decision = run({ ...experiment, design: 'observational_comparison' }, conversions({ a: [2000, 200], b: [2000, 400] }, observedBefore(now)), now);
  assert.equal(decision.outcome, 'observational_only');
  assert.equal(decision.winnerArmId, undefined);
  assert.ok(decision.comparisons.every(item => !item.significant));
  assert.equal(decision.quality.assignmentProven, false);
});

test('guardrail violations and loss limits stop spending even during interim looks', () => {
  const now = '2026-09-10T06:00:00Z';
  const observed = observedBefore(now);
  const guarded = { ...experiment, hypothesis: { ...experiment.hypothesis, guardrails: [{ metric: 'crash_free_rate' as const, direction: 'min' as const, threshold: 0.99 }] } };
  const facts = [...conversions({ a: [2000, 200], b: [2000, 300] }, observed),
    fact('b', { kind: 'sessions', count: 1000 }, observed), fact('b', { kind: 'crashes', count: 50 }, observed)];
  const stopped = run(guarded, facts, now);
  assert.equal(stopped.outcome, 'stop_guardrail');
  assert.equal(stopped.guardrailViolations.length, 1);
  assert.match(stopped.guardrailViolations[0], /crash_free_rate 0\.95/);

  const spend = ['a', 'b'].map(armId => fact(armId, { kind: 'spend', currency: 'USD', amountMicros: '100000000' }, observed));
  const limited = evaluateExperiment({ experiment, facts: [...conversions({ a: [2000, 200], b: [2000, 300] }, observed), ...spend], policy,
    mandate: { ...mandate, limits: { ...mandate.limits, maxLossMicros: '150000000' } }, fx: [], now: at(now) });
  assert.equal(limited.outcome, 'stop_loss');
  const withinLimit = evaluateExperiment({ experiment, facts: [...conversions({ a: [2000, 200], b: [2000, 300] }, observed), ...spend], policy,
    mandate: { ...mandate, limits: { ...mandate.limits, maxLossMicros: '200000000' } }, fx: [], now: at(now) });
  assert.equal(withinLimit.outcome, 'continue');
});

test('sequential looks wait for registered times and spend alpha per look', () => {
  const sequential: Experiment = { ...experiment, horizonAt: undefined,
    stopping: { kind: 'sequential', looks: ['2026-09-09T00:00:00Z', '2026-09-16T00:00:00Z', '2026-09-23T00:00:00Z'], spending: 'obrien_fleming' } };
  const facts = (now: string) => conversions({ a: [2000, 200], b: [2000, 250] }, observedBefore(now));
  assert.equal(run(sequential, facts('2026-09-08T12:00:00Z'), '2026-09-08T12:00:00Z').kind, 'quality_check');

  const first = run(sequential, facts('2026-09-09T06:00:00Z'), '2026-09-09T06:00:00Z');
  assert.equal(first.kind, 'efficacy');
  assert.equal(first.outcome, 'continue');
  assert.equal(first.look, 1);
  assert.equal(first.comparisons[0].boundaryP, sequentialNominalAlpha(0.05, 1, 3, 'obrien_fleming'));
  assert.ok(first.comparisons[0].pValue! < 0.05);

  // look 1을 썼으면 look 2 시각 전까지는 효능을 다시 보지 않는다.
  assert.equal(run({ ...sequential, looksUsed: 1 }, facts('2026-09-12T06:00:00Z'), '2026-09-12T06:00:00Z').outcome, 'continue');
  const second = run({ ...sequential, looksUsed: 1 }, facts('2026-09-16T06:00:00Z'), '2026-09-16T06:00:00Z');
  assert.equal(second.outcome, 'winner');
  assert.equal(second.look, 2);
  assert.equal(second.comparisons[0].boundaryP, sequentialNominalAlpha(0.05, 2, 3, 'obrien_fleming'));
  assert.equal(run({ ...sequential, looksUsed: 3 }, facts('2026-09-24T06:00:00Z'), '2026-09-24T06:00:00Z').outcome, 'blocked');
});

test('a late refund correction invalidates an earlier winner, and unchanged data keeps it', () => {
  const roi: Experiment = { ...experiment, hypothesis: { ...experiment.hypothesis, primaryMetric: 'net_roi', minSamplePerArm: 7 } };
  const decisionAt = '2026-09-15T06:00:00Z';
  const observed = observedBefore(decisionAt);
  const noise = [-2, 1, 0, 2, -1, 1, -2, 0, 2, -1];
  const facts = ['a', 'b'].flatMap(armId => noise.flatMap((delta, index) => {
    const day = `2026-09-${String(index + 1).padStart(2, '0')}`;
    const revenue = (armId === 'a' ? 120 : 150) + delta;
    return [
      fact(armId, { kind: 'spend', currency: 'USD', amountMicros: '100000000', eventDate: day, acquisitionDate: undefined }, observed),
      fact(armId, { provider: 'google-play', connectionId: 'play', sourceId: 'play', kind: 'revenue', revenueBasis: 'net_proceeds', attributionWindowDays: 3,
        currency: 'USD', amountMicros: String(revenue * 1_000_000), acquisitionDate: day, eventDate: day }, observed),
    ];
  }));
  const winner = evaluateExperiment({ experiment: roi, facts, policy, mandate, fx: [], now: at(decisionAt) });
  assert.equal(winner.outcome, 'winner');
  assert.equal(winner.winnerArmId, 'b');

  const later = at('2026-09-20T06:00:00Z');
  const scaled = { ...roi, looksUsed: 1 };
  assert.equal(invalidateDecision(winner, scaled, facts, policy, mandate, [], later), null);

  const refunds = noise.map((_, index) => fact('b', { provider: 'google-play', connectionId: 'play', sourceId: 'refund-feed', kind: 'refund', attributionWindowDays: 3,
    currency: 'USD', amountMicros: '30000000', acquisitionDate: `2026-09-${String(index + 1).padStart(2, '0')}`, eventDate: '2026-09-18' }, '2026-09-19T00:00:00Z'));
  // 이후 새 cohort는 정정 재평가 범위에 넣지 않는다.
  const newCohort = fact('b', { kind: 'spend', currency: 'USD', amountMicros: '1', eventDate: '2026-09-18', acquisitionDate: undefined }, '2026-09-19T00:00:00Z');
  const invalidated = invalidateDecision(winner, scaled, [...facts, ...refunds, newCohort], policy, mandate, [], later);
  assert.ok(invalidated);
  assert.equal(invalidated.kind, 'invalidation');
  assert.equal(invalidated.outcome, 'invalidated');
  assert.equal(invalidated.look, 1);
  assert.equal(invalidated.winnerArmId, undefined);
  assert.ok(!invalidated.factIds.includes(newCohort.id));
  assert.match(invalidated.reasons[0], /유지되지 않습니다/);
});
