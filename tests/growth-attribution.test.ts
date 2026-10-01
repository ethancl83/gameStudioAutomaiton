import test from 'node:test';
import assert from 'node:assert/strict';
import { armMetrics, convertMicros, currentFacts, freshness, performanceReports } from '../packages/growth/attribution.js';
import type { AttributionFact, Experiment, FxSnapshot, GrowthPolicy } from '../packages/growth/types.js';

const now = new Date('2026-09-24T12:00:00Z');
const policy: GrowthPolicy = { projectId: 'p', version: 3, alpha: 0.05, multiplicity: 'holm', defaultStopping: 'fixed_horizon',
  freshnessHours: { 'google-ads': 24, 'google-play': 48 }, fxMaxAgeHours: 48, variableCostRate: 0.1, allowPricingExperiments: false, updatedAt: '2026-09-01T00:00:00Z' };
let sequence = 0;
function fact(partial: Partial<AttributionFact>): AttributionFact {
  sequence += 1;
  return { id: 'f' + String(sequence).padStart(3, '0'), projectId: 'p', provider: 'google-ads', connectionId: 'ads', campaignId: 'c1', kind: 'spend',
    currency: 'USD', eventDate: '2026-09-10', acquisitionDate: '2026-09-10', observedAt: '2026-09-24T06:00:00Z', collectedAt: '2026-09-24T06:05:00Z',
    sourceId: 'ads-report', sourceWatermark: 'w1', revision: 1, finality: 'settled', ...partial };
}
const revenue = (partial: Partial<AttributionFact>) => fact({ provider: 'google-play', connectionId: 'play', kind: 'revenue', attributionWindowDays: 7, sourceId: 'play-report', ...partial });

test('current facts keep the latest non-superseded revision and count duplicate source rows once', () => {
  const original = revenue({ amountMicros: '10000000', revenueBasis: 'net_proceeds' });
  const correction = revenue({ amountMicros: '8000000', revenueBasis: 'net_proceeds', revision: 2, supersedes: original.id });
  const duplicate = { ...correction, id: 'dup-of-correction' };
  const otherSource = revenue({ amountMicros: '1000000', revenueBasis: 'net_proceeds', sourceId: 'other-report' });
  const refund = revenue({ kind: 'refund', amountMicros: '500000', sourceId: 'refund-feed' });
  const result = currentFacts([original, correction, duplicate, otherSource, refund]);
  assert.deepEqual(result.facts.map(item => item.id).sort(), [correction.id, otherSource.id, refund.id].sort());
  assert.deepEqual(result.dropped.map(item => item.id).sort(), [original.id, 'dup-of-correction'].sort());
});

test('FX conversion is exact, direction-aware and refuses missing, foreign-source or old rates', () => {
  const fx: FxSnapshot[] = [
    { id: 'fx1', source: 'ecb', date: '2026-09-10', base: 'USD', quote: 'KRW', rate: '1350.1234567891', recordedAt: '2026-09-10T18:00:00Z', version: 1 },
    { id: 'fx2', source: 'ecb', date: '2026-09-10', base: 'USD', quote: 'KRW', rate: '1360', recordedAt: '2026-09-11T18:00:00Z', version: 2 },
    { id: 'fx3', source: 'other', date: '2026-09-10', base: 'EUR', quote: 'USD', rate: '1.1', recordedAt: '2026-09-10T18:00:00Z', version: 1 },
  ];
  const fxPolicy = { fxSource: 'ecb', fxMaxAgeHours: 48 };
  assert.deepEqual(convertMicros('1500000', 'USD', 'USD', fx, '2026-09-10', fxPolicy, now), { micros: '1500000' });
  assert.deepEqual(convertMicros('1000000', 'USD', 'KRW', fx, '2026-09-10', fxPolicy, now), { micros: '1360000000', fxId: 'fx2' });
  // 기록 시점 이전에는 최신 version을 모른다.
  assert.equal(convertMicros('1000000', 'USD', 'KRW', fx, '2026-09-10', fxPolicy, new Date('2026-09-11T00:00:00Z')).micros, '1350123457');
  assert.equal(convertMicros('1360000000', 'KRW', 'USD', fx, '2026-09-11', fxPolicy, now).micros, '1000000');
  assert.equal(convertMicros('3', 'USD', 'KRW', [{ ...fx[1], rate: '0.5' }], '2026-09-10', fxPolicy, now).micros, '2');
  assert.equal(convertMicros('-3', 'USD', 'KRW', [{ ...fx[1], rate: '0.5' }], '2026-09-10', fxPolicy, now).micros, '-2');
  assert.match(convertMicros('1', 'USD', 'KRW', fx, '2026-09-10', { fxMaxAgeHours: 48 }, now).reason!, /FX 출처가 없어/);
  assert.match(convertMicros('1', 'USD', 'KRW', fx, '2026-09-20', fxPolicy, now).reason!, /오래되어/);
  assert.match(convertMicros('1', 'USD', 'KRW', fx, '2026-09-09', fxPolicy, now).reason!, /환율이 없어/);
  assert.match(convertMicros('1', 'EUR', 'USD', fx, '2026-09-10', fxPolicy, now).reason!, /허용하지 않은 FX 출처/);
});

test('freshness marks stale watermarks, missing sources and unconfigured thresholds', () => {
  const result = freshness([fact({ observedAt: '2026-09-23T06:00:00Z' }), revenue({ observedAt: '2026-09-23T06:00:00Z' }), fact({ provider: 'admob', kind: 'revenue' })], policy, now, ['applovin-max']);
  const by = Object.fromEntries(result.map(item => [item.provider, item]));
  assert.equal(by['google-ads'].stale, true);
  assert.match(by['google-ads'].reason!, /신선도 기준\(24시간\)/);
  assert.equal(by['google-play'].stale, false);
  assert.equal(by.admob.reason, 'admob: 신선도 기준 미설정');
  assert.equal(by['applovin-max'].lastObservedAt, null);
  assert.equal(by['applovin-max'].stale, true);
});

function baseFacts(): AttributionFact[] {
  return [
    fact({ amountMicros: '60000000', eventDate: '2026-09-10', acquisitionDate: undefined }),
    fact({ amountMicros: '40000000', eventDate: '2026-09-11', acquisitionDate: undefined }),
    revenue({ amountMicros: '150000000', revenueBasis: 'gross_conversion_value', provider: 'google-ads', connectionId: 'ads', sourceId: 'ads-conv' }),
    revenue({ amountMicros: '105000000', revenueBasis: 'net_proceeds' }),
    // 같은 원천의 net_proceeds에 이미 반영된 수수료라 다시 빼지 않는다.
    revenue({ kind: 'fee', amountMicros: '30000000' }),
    revenue({ kind: 'refund', amountMicros: '5000000', sourceId: 'refund-feed', acquisitionDate: '2026-09-11', eventDate: '2026-09-15' }),
  ];
}

test('ROAS and net ROI follow the documented numerator, deduction and variable-cost rules', () => {
  const [report] = performanceReports('p', baseFacts(), policy, [], now, { windowDays: 7, basis: 'gross_conversion_value' });
  assert.equal(report.currency, 'USD');
  assert.equal(report.spendMicros, '100000000');
  assert.equal(report.attributedRevenueMicros, '150000000');
  assert.equal(report.netProceedsMicros, '100000000');
  assert.equal(report.variableCostMicros, '10000000');
  assert.equal(report.roas, 1.5);
  assert.equal(report.netRoi, (100 - 100 - 10) / 110);
  assert.equal(report.roasReason, undefined);
  assert.match(report.definitions.roas, /회계 ROI나 기존 contribution/);
  assert.match(report.definitions.netRoi, /회사 회계 ROI가 아니며 기존 contribution/);
});

test('a late refund correction replaces the earlier refund instead of double-counting it', () => {
  const facts = baseFacts();
  const refund = facts.at(-1)!;
  const corrected = { ...refund, id: 'refund-rev2', amountMicros: '15000000', revision: 2, supersedes: refund.id };
  const [report] = performanceReports('p', [...facts, corrected], policy, [], now, { windowDays: 7, basis: 'gross_conversion_value' });
  assert.equal(report.netProceedsMicros, '90000000');
  assert.ok(report.factIds.includes('refund-rev2') && !report.factIds.includes(refund.id));
});

test('reports refuse to compute with zero spend, unattributed cohorts, mixed windows, stale data, open windows or estimates', () => {
  const run = (facts: AttributionFact[], at = now) => performanceReports('p', facts, policy, [], at, { windowDays: 7, basis: 'gross_conversion_value' })[0];
  const zero = run(baseFacts().filter(item => item.kind !== 'spend'));
  assert.equal(zero.roas, null);
  assert.match(zero.roasReason!, /광고비가 0/);

  const unattributed = run([...baseFacts(), revenue({ amountMicros: '1000000', revenueBasis: 'gross_conversion_value', acquisitionDate: undefined })]);
  assert.equal(unattributed.roas, null);
  assert.match(unattributed.roasReason!, /귀속이 없는 수익/);
  assert.equal(unattributed.quality.assignmentProven, false);

  const mixed = run([...baseFacts(), revenue({ amountMicros: '1000000', revenueBasis: 'gross_conversion_value', attributionWindowDays: undefined })]);
  assert.match(mixed.roasReason!, /귀속 창을 알 수 없는/);
  // 다른 창으로 명시된 수익은 다른 보고서에 속하므로 이 보고서 값에 영향이 없다.
  assert.equal(run([...baseFacts(), revenue({ amountMicros: '9000000', revenueBasis: 'gross_conversion_value', attributionWindowDays: 30 })]).roas, 1.5);

  const stale = run(baseFacts(), new Date('2026-09-26T12:00:00Z'));
  assert.equal(stale.roas, null);
  assert.equal(stale.quality.fresh, false);

  // 귀속 창이 열린 최근 cohort는 광고비·수익 모두 빼고, 끝난 cohort만으로 계산한다(매일 동기화해도 판정이 막히지 않음).
  const early = baseFacts().map(item => ({ ...item, observedAt: '2026-09-18T06:00:00Z', collectedAt: '2026-09-18T06:05:00Z' }));
  const partial = run(early, new Date('2026-09-18T12:00:00Z'));
  assert.equal(partial.spendMicros, '60000000', 'only the matured 09-10 cohort spend is counted');
  const none = baseFacts().map(item => ({ ...item, observedAt: '2026-09-16T06:00:00Z', collectedAt: '2026-09-16T06:05:00Z' }));
  const open = run(none, new Date('2026-09-16T12:00:00Z'));
  assert.equal(open.roas, null);
  assert.match(open.roasReason!, /끝난 획득 cohort가 아직 없습니다/);

  const estimated = run(baseFacts().map(item => item.kind === 'refund' ? { ...item, finality: 'estimated' as const } : item));
  assert.equal(estimated.roas, 1.5);
  assert.equal(estimated.netRoi, null);
  assert.match(estimated.netRoiReason!, /추정\(estimated\)/);
});

test('mixed currencies stay separated without FX and merge only when every fact converts', () => {
  const facts = [...baseFacts().filter(item => item.kind === 'spend'),
    revenue({ currency: 'KRW', amountMicros: '202500000000', revenueBasis: 'gross_conversion_value' })];
  const separated = performanceReports('p', facts, policy, [], now, { windowDays: 7, basis: 'gross_conversion_value' });
  assert.deepEqual(separated.map(item => item.currency), ['KRW', 'USD']);
  assert.ok(separated.every(item => item.roas === null && !item.quality.currencyConsistent));
  assert.ok(separated.every(item => /여러 통화/.test(item.roasReason!)));

  const fx: FxSnapshot[] = [{ id: 'fx', source: 'ecb', date: '2026-09-10', base: 'USD', quote: 'KRW', rate: '1350', recordedAt: '2026-09-10T18:00:00Z', version: 1 }];
  const merged = performanceReports('p', facts, { ...policy, reportingCurrency: 'USD', fxSource: 'ecb' }, fx, now, { windowDays: 7, basis: 'gross_conversion_value' });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].attributedRevenueMicros, '150000000');
  assert.equal(merged[0].roas, 1.5);
});

test('arm metrics match facts by arm or campaign and summarize proportions and daily ratios', () => {
  const experiment = { id: 'e', projectId: 'p', arms: [{ id: 'a', role: 'control', label: 'A', campaignId: 'c1' }, { id: 'b', role: 'treatment', label: 'B' }],
    hypothesis: { primaryMetric: 'conversion_rate', attributionWindowDays: 7, revenueBasis: 'gross_conversion_value', guardrails: [] } } as unknown as Experiment;
  const facts = [
    fact({ kind: 'clicks', count: 100 }), fact({ kind: 'conversions', count: 10 }),
    fact({ kind: 'clicks', count: 200, armId: 'b', campaignId: 'c2' }), fact({ kind: 'conversions', count: 30, armId: 'b', campaignId: 'c2' }),
    fact({ kind: 'conversions', count: 99, experimentId: 'other-experiment' }),
  ];
  const [a, b] = armMetrics(experiment, facts, now);
  assert.deepEqual([a.successes, a.trials, a.estimate], [10, 100, 0.1]);
  assert.deepEqual([b.successes, b.trials, b.samples], [30, 200, 200]);

  const roasFacts = ['2026-09-10', '2026-09-11', '2026-09-12'].flatMap((day, index) => [
    fact({ amountMicros: '10000000', eventDate: day, acquisitionDate: undefined }),
    revenue({ amountMicros: String((index + 1) * 10_000_000), revenueBasis: 'gross_conversion_value', acquisitionDate: day, eventDate: '2026-09-20' }),
  ]);
  const [roas] = armMetrics({ ...experiment, hypothesis: { ...experiment.hypothesis, primaryMetric: 'roas' } }, roasFacts, now);
  assert.deepEqual(roas.values, [1, 2, 3]);
  assert.equal(roas.samples, 3);
  assert.equal(roas.estimate, 2);
  assert.equal(roas.spendMicros, '30000000');
});

test('campaign and experiment reports for the same campaign-day are counted once per view', async () => {
  const { withoutOverlap } = await import('../packages/growth/attribution.js');
  const base = { projectId: 'p', provider: 'google-ads' as const, connectionId: 'c', campaignId: '1', eventDate: '2026-09-01', acquisitionDate: '2026-09-01', currency: 'USD', observedAt: '', collectedAt: '', sourceWatermark: '', revision: 1, finality: 'estimated' as const };
  const campaign = { ...base, id: 'a', kind: 'spend' as const, amountMicros: '5', sourceId: 'campaign' };
  const experiment = { ...base, id: 'b', kind: 'spend' as const, amountMicros: '5', sourceId: 'experiment', experimentId: 'e', armId: 'x' };
  const other = { ...base, id: 'c', kind: 'spend' as const, amountMicros: '7', sourceId: 'other', campaignId: '2', experimentId: 'e' };
  assert.deepEqual(withoutOverlap([campaign, experiment, other], 'campaign').map(item => item.id), ['a', 'c']);
  assert.deepEqual(withoutOverlap([campaign, experiment, other], 'experiment').map(item => item.id), ['b', 'c']);
});
