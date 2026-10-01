// 사전 등록한 실험 규칙에 따른 결정 스냅샷. 같은 입력이면 같은 스냅샷을 만든다.
import { createHash } from 'node:crypto';
import { armMetrics, cohortDay, convertMicros, factsByArm, freshness, LOWER_IS_BETTER, PROPORTION_METRICS, windowEndsAt } from './attribution.js';
import { benjaminiHochberg, holmAdjust, sequentialNominalAlpha, twoProportionTest, welchTest } from './stats.js';
import type { ArmMetrics, AttributionFact, DataQuality, DecisionOutcome, DecisionSnapshot, Experiment, FxSnapshot, GrowthPolicy, MetricKey, OperationMandate } from './types.js';

export const ALGORITHM_VERSION = 'growth-decision/1';
const DAY_MS = 86_400_000;

export interface EvaluationInput {
  experiment: Experiment; facts: AttributionFact[]; policy: GrowthPolicy; mandate: OperationMandate;
  fx: FxSnapshot[]; now: Date; agentTaskId?: string;
}

type Comparison = DecisionSnapshot['comparisons'][number];

export function decisionId(experimentId: string, version: number, look: number, kind: DecisionSnapshot['kind'], now: Date): string {
  const minute = now.toISOString().slice(0, 16);
  return createHash('sha256').update(`${experimentId}|${version}|${look}|${kind}|${minute}`).digest('hex');
}

function favorable(metric: MetricKey, effect: number): number {
  return LOWER_IS_BETTER.includes(metric) ? -effect : effect;
}

function compare(experiment: Experiment, arms: ArmMetrics[], boundaryP: number | null): Comparison[] {
  const control = experiment.arms.find(arm => arm.role === 'control');
  const controlMetrics = arms.find(item => item.armId === control?.id);
  const treatments = experiment.arms.filter(arm => arm.role === 'treatment');
  if (!controlMetrics) return [];
  const proportion = PROPORTION_METRICS.includes(experiment.hypothesis.primaryMetric);
  const tests = treatments.map(arm => {
    const metrics = arms.find(item => item.armId === arm.id)!;
    return proportion
      ? twoProportionTest({ successes: controlMetrics.successes ?? 0, trials: controlMetrics.trials ?? 0 }, { successes: metrics.successes ?? 0, trials: metrics.trials ?? 0 }, experiment.alpha)
      : welchTest(controlMetrics.values ?? [], metrics.values ?? [], experiment.alpha);
  });
  // 계산할 수 없는 비교도 family 크기에 포함해(p=1) 보정이 느슨해지지 않게 한다.
  const raw = tests.map(test => test.pValue ?? 1);
  const adjusted = experiment.multiplicity === 'holm' ? holmAdjust(raw) : benjaminiHochberg(raw);
  return treatments.map((arm, index) => {
    const test = tests[index];
    const adjustedP = test.pValue === null ? null : adjusted[index];
    return { armId: arm.id, effect: test.effect, ciLow: test.ciLow, ciHigh: test.ciHigh, pValue: test.pValue, adjustedP, boundaryP,
      significant: adjustedP !== null && boundaryP !== null && adjustedP <= boundaryP };
  });
}

interface EvaluateOptions { ignoreFreshness?: boolean }

/**
 * 결정 규칙:
 * - guardrail 위반·손실 한도 초과는 설계와 시점에 관계없이 먼저 중지(stop_guardrail, stop_loss)한다.
 * - observational_comparison은 승자를 정하지 않는다(observational_only).
 * - fixed_horizon은 horizonAt(없으면 startedAt+maxDurationDays) 이후 한 번, sequential은 looks[looksUsed] 시각 이후에만 효능을 본다.
 *   효능 look을 쓴 스냅샷만 kind 'efficacy'이고 look = looksUsed+1이다. 호출자는 이 경우에만 looksUsed를 올린다.
 * - 효능 시점인데 데이터를 평가할 수 없으면 look을 쓰지 않고 blocked로 둔다. 단 최대 관찰 기간이 지났는데 표본이 부족하면
 *   inconclusive로 종료한다(look 소비).
 * - 표본 부족 판단에는 최소 관찰 기간(minDurationDays) 미충족도 포함한다.
 */
function evaluate(input: EvaluationInput, options: EvaluateOptions = {}): DecisionSnapshot {
  const { experiment, policy, mandate, now, fx } = input;
  const hypothesis = experiment.hypothesis;
  const nowMs = now.getTime();
  const reasons: string[] = [];
  const qualityReasons: string[] = [];
  const byArm = factsByArm(experiment, input.facts, now);
  const armFacts = [...new Map([...byArm.values()].flat().map(fact => [fact.id, fact])).values()];
  const arms = armMetrics(experiment, input.facts, now, { variableCostRate: policy.variableCostRate });

  const controls = experiment.arms.filter(arm => arm.role === 'control');
  const treatments = experiment.arms.filter(arm => arm.role === 'treatment');
  const assignmentProven = experiment.design === 'native_ab' && controls.length === 1 && treatments.length >= 1;
  if (experiment.design !== 'native_ab') qualityReasons.push('공급자가 무작위 배정을 보장하는 A/B가 아니라 관찰 비교입니다.');
  else if (!assignmentProven) qualityReasons.push('대조군 1개와 실험군 1개 이상이 필요합니다.');

  const stale = freshness(armFacts, policy, now, [experiment.provider]).filter(item => item.stale);
  const fresh = options.ignoreFreshness || stale.length === 0;
  if (!fresh) qualityReasons.push(...stale.map(item => item.reason!));

  const startedMs = experiment.startedAt ? Date.parse(experiment.startedAt) : null;
  const shortArms = arms.filter(item => item.samples < hypothesis.minSamplePerArm);
  const durationMet = startedMs !== null && nowMs >= startedMs + hypothesis.minDurationDays * DAY_MS;
  const sampleSufficient = shortArms.length === 0 && durationMet;
  if (shortArms.length) qualityReasons.push(`arm별 최소 표본 ${hypothesis.minSamplePerArm}에 못 미치는 arm이 있습니다(${shortArms.map(item => `${item.armId}: ${item.samples}`).join(', ')}).`);
  if (!durationMet) qualityReasons.push(`최소 관찰 기간 ${hypothesis.minDurationDays}일이 지나지 않았습니다.`);

  // factsByArm이 귀속 창이 끝난 cohort만 돌려주므로, 완료된 cohort가 하나라도 있어야 비교할 수 있다.
  const latest = armFacts.map(cohortDay).sort().at(-1);
  const windowComplete = latest !== undefined && nowMs >= windowEndsAt(latest, hypothesis.attributionWindowDays);
  if (!latest) qualityReasons.push(`실험 기간에 귀속 창(${hypothesis.attributionWindowDays}일)이 끝난 arm fact가 없습니다.`);

  const currencies = new Set(armFacts.filter(fact => fact.amountMicros !== undefined && ['spend', 'revenue', 'refund', 'fee', 'tax'].includes(fact.kind)).map(fact => fact.currency ?? ''));
  const currencyConsistent = currencies.size <= 1 && !currencies.has('');
  if (!currencyConsistent) qualityReasons.push('실험 arm의 금액 fact 통화가 하나가 아니어서 비교할 수 없습니다.');

  // guardrail은 실험군마다 매 호출 평가한다. 값을 알 수 없는 guardrail은 위반은 아니지만 승자 확정을 막는다.
  const violations: string[] = [];
  const unknownGuardrails: string[] = [];
  const cache = new Map<MetricKey, ArmMetrics[]>();
  for (const guardrail of hypothesis.guardrails) {
    const metrics = cache.get(guardrail.metric) ?? armMetrics(experiment, input.facts, now, { metric: guardrail.metric, variableCostRate: policy.variableCostRate });
    cache.set(guardrail.metric, metrics);
    for (const arm of treatments) {
      const value = metrics.find(item => item.armId === arm.id)?.estimate ?? null;
      if (value === null) { unknownGuardrails.push(`${arm.label}의 guardrail ${guardrail.metric} 값을 확인할 수 없습니다.`); continue; }
      if (guardrail.direction === 'min' ? value < guardrail.threshold : value > guardrail.threshold) {
        violations.push(`${arm.label}: ${guardrail.metric} ${round(value)}이(가) ${guardrail.direction === 'min' ? '하한' : '상한'} ${guardrail.threshold}을(를) 넘었습니다.`);
      }
    }
  }

  // 손실 = 전체 arm 광고비 − 귀속 순수익. 위임 통화로 환산할 수 없으면 판단 불가로 둔다.
  let lossUnknown: string | null = null;
  let lossExceeded = false;
  const limitCurrency = mandate.limits.currency;
  let loss = 0n;
  for (const item of arms) {
    if (!item.currency) {
      if ((byArm.get(item.armId) ?? []).some(fact => fact.amountMicros !== undefined)) lossUnknown = `${item.armId} arm의 통화가 섞여 손실을 계산할 수 없습니다.`;
      continue;
    }
    const net = BigInt(item.spendMicros ?? '0') - BigInt(item.revenueMicros ?? '0');
    const converted = convertMicros(net.toString(), item.currency, limitCurrency, fx, now.toISOString(), policy, now);
    if (converted.micros === null) { lossUnknown = `손실 한도 통화(${limitCurrency})로 환산할 수 없습니다. ${converted.reason}`; continue; }
    loss += BigInt(converted.micros);
  }
  if (!lossUnknown && loss > BigInt(mandate.limits.maxLossMicros)) lossExceeded = true;

  const quality: DataQuality = { fresh, sampleSufficient, windowComplete, assignmentProven, currencyConsistent, reasons: qualityReasons };
  const build = (kind: DecisionSnapshot['kind'], outcome: DecisionOutcome, look: number, comparisons: Comparison[] = [], winnerArmId?: string): DecisionSnapshot => {
    const snapshot: DecisionSnapshot = {
      id: decisionId(experiment.id, experiment.version, look, kind, now), experimentId: experiment.id, experimentVersion: experiment.version,
      projectId: experiment.projectId, at: now.toISOString(), look, kind, outcome, arms, comparisons, quality,
      guardrailViolations: violations, factIds: armFacts.map(fact => fact.id).sort(),
      policyVersion: policy.version, algorithmVersion: ALGORITHM_VERSION, mandateId: mandate.id,
      reasons: [...new Set([...reasons, ...qualityReasons, ...unknownGuardrails, ...(lossUnknown ? [lossUnknown] : [])])],
    };
    if (winnerArmId) snapshot.winnerArmId = winnerArmId;
    if (input.agentTaskId) snapshot.agentTaskId = input.agentTaskId;
    return snapshot;
  };

  if (violations.length) { reasons.push('guardrail 위반으로 신규 지출을 중지해야 합니다.', ...violations); return build('guardrail', 'stop_guardrail', experiment.looksUsed); }
  if (lossExceeded) {
    reasons.push(`누적 손실이 위임 손실 한도(${mandate.limits.maxLossMicros} ${limitCurrency} micros)를 넘어 신규 지출을 중지해야 합니다.`);
    return build('guardrail', 'stop_loss', experiment.looksUsed);
  }
  if (experiment.design === 'observational_comparison') {
    reasons.push('관찰 비교 실험은 효능 판정·승자 확대에 쓰지 않습니다.');
    return build('quality_check', 'observational_only', experiment.looksUsed, compare(experiment, arms, null).map(item => ({ ...item, significant: false })));
  }
  if (startedMs === null) { reasons.push('실험 시작 시각이 없어 효능을 판단하지 않습니다.'); return build('quality_check', 'blocked', experiment.looksUsed); }

  const pastMax = nowMs >= startedMs + hypothesis.maxDurationDays * DAY_MS;
  const stopping = experiment.stopping;
  const totalLooks = stopping.kind === 'sequential' ? stopping.looks.length : 1;
  const nextLook = experiment.looksUsed + 1;
  if (experiment.looksUsed >= totalLooks) { reasons.push('사전 등록한 효능 판정 look을 모두 사용했습니다.'); return build('quality_check', 'blocked', experiment.looksUsed); }
  let dueAt: number;
  let boundary: number;
  if (stopping.kind === 'sequential') {
    dueAt = Date.parse(stopping.looks[experiment.looksUsed]);
    boundary = sequentialNominalAlpha(experiment.alpha, nextLook, totalLooks, stopping.spending);
  } else {
    dueAt = experiment.horizonAt ? Date.parse(experiment.horizonAt) : startedMs + hypothesis.maxDurationDays * DAY_MS;
    boundary = experiment.alpha;
  }

  if (nowMs < dueAt) {
    if (pastMax && !sampleSufficient) { reasons.push('최대 관찰 기간이 지났지만 표본이 부족해 결론을 낼 수 없습니다.'); return build('quality_check', 'inconclusive', experiment.looksUsed); }
    reasons.push(`다음 효능 판정 시점(${new Date(dueAt).toISOString()}) 전입니다. 중간 조회는 데이터 품질·guardrail 감시에만 씁니다.`);
    return build('quality_check', 'continue', experiment.looksUsed);
  }

  const evaluable = fresh && sampleSufficient && windowComplete && assignmentProven && currencyConsistent && !lossUnknown && !unknownGuardrails.length;
  if (!evaluable) {
    if (pastMax && !sampleSufficient) { reasons.push('최대 관찰 기간이 지났지만 표본이 부족해 결론을 낼 수 없습니다.'); return build('efficacy', 'inconclusive', nextLook); }
    reasons.push('효능 판정 시점이지만 데이터 품질 조건을 충족하지 못해 look을 사용하지 않고 보류합니다.');
    return build('quality_check', 'blocked', experiment.looksUsed);
  }

  const comparisons = compare(experiment, arms, boundary);
  const metric = hypothesis.primaryMetric;
  const winners = comparisons.filter(item => item.significant && item.effect !== null && favorable(metric, item.effect) >= hypothesis.minimumEffect)
    .sort((a, b) => favorable(metric, b.effect!) - favorable(metric, a.effect!));
  if (winners.length) {
    reasons.push(`${winners[0].armId} arm이 보정 p ${round(winners[0].adjustedP!)} ≤ 경계 ${round(boundary)}이고 최소 효과 ${hypothesis.minimumEffect} 이상입니다.`);
    return build('efficacy', 'winner', nextLook, comparisons, winners[0].armId);
  }
  const final = nextLook === totalLooks || pastMax;
  if (final) {
    reasons.push('마지막 효능 판정에서 유의하고 최소 효과를 넘는 실험군이 없습니다.');
    return build('efficacy', 'no_effect', nextLook, comparisons);
  }
  reasons.push(`look ${nextLook}/${totalLooks}에서 경계 ${round(boundary)}를 넘는 실험군이 없어 관찰을 계속합니다.`);
  return build('efficacy', 'continue', nextLook, comparisons);
}

function round(value: number): string {
  return Number(value.toPrecision(4)).toString();
}

export function evaluateExperiment(input: EvaluationInput): DecisionSnapshot {
  return evaluate(input);
}

/**
 * 확정된 winner를 정정된 fact로 다시 평가한다. 재평가는 이전 결정과 같은 look과 cohort 범위(이전 결정의 최신 cohort 이하)로
 * 제한해 새로 쌓인 데이터가 아니라 정정만 반영하고, 과거 결정이라 신선도는 보지 않는다.
 * 같은 승자가 유지되면 null, 아니면 invalidation 스냅샷을 돌려준다.
 */
export function invalidateDecision(previous: DecisionSnapshot, experiment: Experiment, facts: AttributionFact[], policy: GrowthPolicy,
  mandate: OperationMandate, fx: FxSnapshot[], now: Date): DecisionSnapshot | null {
  if (previous.outcome !== 'winner' || previous.experimentId !== experiment.id) return null;
  const used = new Set(previous.factIds);
  const cohortLimit = facts.filter(fact => used.has(fact.id)).map(cohortDay).sort().at(-1) ?? previous.at.slice(0, 10);
  const scoped = facts.filter(fact => cohortDay(fact) <= cohortLimit);
  const replay = evaluate({ experiment: { ...experiment, looksUsed: previous.look - 1 }, facts: scoped, policy, mandate, fx, now }, { ignoreFreshness: true });
  if (replay.outcome === 'winner' && replay.winnerArmId === previous.winnerArmId) return null;
  const snapshot: DecisionSnapshot = {
    ...replay,
    id: decisionId(experiment.id, experiment.version, previous.look, 'invalidation', now),
    look: previous.look, kind: 'invalidation', outcome: 'invalidated',
    reasons: [`이전 승자 결정(${previous.id.slice(0, 12)})이 정정된 데이터 재평가에서 유지되지 않습니다(재평가 결과: ${replay.outcome}${replay.winnerArmId ? ', ' + replay.winnerArmId : ''}). 자동 재증액하지 않습니다.`, ...replay.reasons],
  };
  delete snapshot.winnerArmId;
  return snapshot;
}
