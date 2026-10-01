// 귀속 fact 정정 계보, FX 환산, 신선도, ROAS/순이익 ROI, arm 지표 계산. I/O 없는 순수 함수다.
import type { Provider } from '../domain/index.js';
import { parseMicros } from '../metrics/index.js';
import type { ArmMetrics, AttributionFact, DataQuality, Experiment, ExperimentArm, FxSnapshot, GrowthPolicy, MetricKey, PerformanceReport, RevenueBasis } from './types.js';

const DAY_MS = 86_400_000;
const GRAIN_FIELDS = ['projectId', 'provider', 'connectionId', 'campaignId', 'experimentId', 'armId', 'acquisitionDate', 'cohortKey',
  'attributionWindowDays', 'kind', 'currency', 'revenueBasis', 'eventDate', 'sourceId'] as const;
const MONEY_KINDS = new Set<AttributionFact['kind']>(['spend', 'revenue', 'refund', 'fee', 'tax']);
const DEDUCTION_KINDS = new Set<AttributionFact['kind']>(['refund', 'fee', 'tax']);
/** 성공/시행 합으로 계산하는 비율 지표. 나머지는 일별 값으로 Welch 검정한다. */
export const PROPORTION_METRICS: MetricKey[] = ['conversion_rate', 'retention_d1', 'crash_free_rate'];
export const LOWER_IS_BETTER: MetricKey[] = ['cost_per_install', 'refund_rate'];

export function grainKey(fact: AttributionFact): string {
  return JSON.stringify(GRAIN_FIELDS.map(field => fact[field] ?? null));
}

/** 'YYYY-MM-DD…'의 UTC 자정 ms. */
export function dayStart(date: string): number {
  return Date.parse(date.slice(0, 10) + 'T00:00:00Z');
}

/** 획득일 cohort의 귀속 창이 끝나는 시각: 획득일 하루가 끝난 뒤 windowDays일. */
export function windowEndsAt(acquisitionDate: string, windowDays: number): number {
  return dayStart(acquisitionDate) + (windowDays + 1) * DAY_MS;
}

/** 광고비는 지출일이 곧 획득일이므로 acquisitionDate가 없으면 eventDate를 cohort로 쓴다. */
export function cohortDay(fact: AttributionFact): string {
  return (fact.acquisitionDate ?? fact.eventDate).slice(0, 10);
}

function newer(a: AttributionFact, b: AttributionFact): boolean {
  if (a.revision !== b.revision) return a.revision > b.revision;
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt;
  if (a.collectedAt !== b.collectedAt) return a.collectedAt > b.collectedAt;
  return a.id > b.id;
}

/**
 * grain마다 대체되지 않은 최신 revision 하나만 남긴다. 다른 fact의 supersedes가 가리키는 fact는 버리고,
 * 같은 원천의 동일 grain 중복은 한 번만 센다.
 */
export function currentFacts(facts: AttributionFact[]): { facts: AttributionFact[]; dropped: Array<{ id: string; reason: string }> } {
  const superseded = new Set(facts.flatMap(fact => fact.supersedes && fact.supersedes !== fact.id ? [fact.supersedes] : []));
  const dropped: Array<{ id: string; reason: string }> = [];
  const best = new Map<string, AttributionFact>();
  for (const fact of [...facts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (superseded.has(fact.id)) { dropped.push({ id: fact.id, reason: '정정 fact로 대체되었습니다.' }); continue; }
    const key = grainKey(fact);
    const previous = best.get(key);
    if (!previous) { best.set(key, fact); continue; }
    const [kept, lost] = newer(fact, previous) ? [fact, previous] : [previous, fact];
    best.set(key, kept);
    dropped.push({ id: lost.id, reason: lost.revision === kept.revision ? '같은 원천의 중복 fact라 한 번만 반영했습니다.' : '같은 grain에 더 최신 revision이 있습니다.' });
  }
  return { facts: [...best.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), dropped };
}

const RATE_SCALE = 10n ** 10n;

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator, d = denominator < 0n ? -denominator : denominator;
  const quotient = (2n * n + d) / (2n * d);
  return negative ? -quotient : quotient;
}

function parseRate(rate: string): bigint | null {
  const match = /^(\d{1,20})(?:\.(\d{1,10}))?$/.exec(rate);
  if (!match) return null;
  const scaled = BigInt(match[1]) * RATE_SCALE + BigInt((match[2] ?? '').padEnd(10, '0'));
  return scaled > 0n ? scaled : null;
}

/**
 * 허용한 FX 출처의 스냅샷으로 정확히 환산한다(반올림 half-up). 거래일 이전의 가장 가까운 기준일 스냅샷을 쓰고,
 * 기준일이 거래일보다 fxMaxAgeHours 넘게 이전이면 오래된 환율로 본다. now 이후 기록된 스냅샷은 재현성을 위해 무시한다.
 */
export function convertMicros(amountMicros: string, from: string, to: string, fx: FxSnapshot[], date: string,
  policy: { fxSource?: string; fxMaxAgeHours: number }, now: Date): { micros: string | null; reason?: string; fxId?: string } {
  const amount = parseMicros(amountMicros);
  if (from === to) return { micros: amount.toString() };
  if (!policy.fxSource) return { micros: null, reason: `${from}→${to} 환산을 허용한 FX 출처가 없어 통화별로 분리합니다.` };
  const factDay = dayStart(date);
  const pair = fx.filter(item => (item.base === from && item.quote === to) || (item.base === to && item.quote === from));
  const candidates = pair.filter(item => item.source === policy.fxSource && Date.parse(item.recordedAt) <= now.getTime() && dayStart(item.date) <= factDay);
  if (!candidates.length) {
    const otherSource = pair.some(item => item.source !== policy.fxSource);
    return { micros: null, reason: otherSource ? `${from}/${to} 환율이 허용하지 않은 FX 출처에만 있어 환산하지 않습니다.` : `${policy.fxSource}의 ${date.slice(0, 10)} 이전 ${from}/${to} 환율이 없어 통화별로 분리합니다.` };
  }
  const snapshot = candidates.reduce((best, item) => {
    const byDate = dayStart(item.date) - dayStart(best.date);
    return byDate > 0 || (byDate === 0 && (item.version > best.version || (item.version === best.version && item.id > best.id))) ? item : best;
  });
  if ((factDay - dayStart(snapshot.date)) / 3_600_000 > policy.fxMaxAgeHours) {
    return { micros: null, reason: `환율 기준일(${snapshot.date.slice(0, 10)})이 거래일(${date.slice(0, 10)})보다 ${policy.fxMaxAgeHours}시간 넘게 오래되어 환산하지 않습니다.` };
  }
  const rate = parseRate(snapshot.rate);
  if (rate === null) return { micros: null, reason: `환율 ${snapshot.id}의 값 형식이 올바르지 않습니다.` };
  const micros = snapshot.base === from ? roundDiv(amount * rate, RATE_SCALE) : roundDiv(amount * RATE_SCALE, rate);
  return { micros: micros.toString(), fxId: snapshot.id };
}

/**
 * 같은 캠페인·날짜·종류를 캠페인 보고와 실험 arm 보고가 함께 내면 한쪽만 센다.
 * prefer='campaign'은 프로젝트 합계용(실험 fact를 버림), 'experiment'는 arm 지표용(캠페인 fact를 버림)이다.
 */
export function withoutOverlap(facts: AttributionFact[], prefer: 'campaign' | 'experiment'): AttributionFact[] {
  const key = (fact: AttributionFact) => JSON.stringify([fact.connectionId, fact.campaignId, fact.eventDate.slice(0, 10), fact.kind, fact.revenueBasis ?? null, fact.attributionWindowDays ?? null, fact.currency ?? null]);
  const winners = new Set(facts.filter(fact => fact.campaignId && (prefer === 'campaign' ? !fact.experimentId : Boolean(fact.experimentId))).map(key));
  return facts.filter(fact => !fact.campaignId || (prefer === 'campaign' ? !fact.experimentId : Boolean(fact.experimentId)) || !winners.has(key(fact)));
}

export interface ProviderFreshness { provider: Provider; lastObservedAt: string | null; stale: boolean; reason?: string }

/** 원천별 마지막 관측 시각(observedAt)을 신선도 기준과 비교한다. providers로 기대 원천을 넘기면 관측이 없어도 포함한다. */
export function freshness(facts: AttributionFact[], policy: GrowthPolicy, now: Date, providers: Provider[] = []): ProviderFreshness[] {
  const last = new Map<Provider, string>();
  for (const fact of facts) {
    const previous = last.get(fact.provider);
    if (!previous || Date.parse(fact.observedAt) > Date.parse(previous)) last.set(fact.provider, fact.observedAt);
  }
  return [...new Set<Provider>([...providers, ...last.keys()])].sort().map(provider => {
    const observed = last.get(provider) ?? null;
    const limit = policy.freshnessHours[provider];
    if (limit === undefined) return { provider, lastObservedAt: observed, stale: true, reason: `${provider}: 신선도 기준 미설정` };
    if (!observed) return { provider, lastObservedAt: null, stale: true, reason: `${provider}: 관측 데이터가 없습니다.` };
    const age = (now.getTime() - Date.parse(observed)) / 3_600_000;
    return age > limit
      ? { provider, lastObservedAt: observed, stale: true, reason: `${provider}: 마지막 관측 후 ${Math.floor(age)}시간이 지나 신선도 기준(${limit}시간)을 넘었습니다.` }
      : { provider, lastObservedAt: observed, stale: false };
  });
}

interface Amount { fact: AttributionFact; micros: bigint }

/**
 * 순수익 = net_proceeds 기준 수익 − 별도 환불·수수료·세금 fact(양수 금액).
 * 같은 sourceId의 net_proceeds 수익이 있으면 그 원천은 이미 차감한 값으로 보고 해당 원천의 차감 fact는 다시 빼지 않는다.
 */
function netProceeds(amounts: Amount[]): bigint {
  const netSources = new Set(amounts.filter(item => item.fact.kind === 'revenue' && item.fact.revenueBasis === 'net_proceeds').map(item => item.fact.sourceId));
  let total = 0n;
  for (const item of amounts) {
    if (item.fact.kind === 'revenue' && item.fact.revenueBasis === 'net_proceeds') total += item.micros;
    else if (DEDUCTION_KINDS.has(item.fact.kind) && !netSources.has(item.fact.sourceId)) total -= item.micros;
  }
  return total;
}

function rateMicros(amount: bigint, rate: number): bigint {
  if (amount <= 0n || !(rate > 0)) return 0n;
  return roundDiv(amount * BigInt(Math.round(rate * 1_000_000)), 1_000_000n);
}

function sum(amounts: Amount[], match: (fact: AttributionFact) => boolean): bigint {
  return amounts.reduce((total, item) => match(item.fact) ? total + item.micros : total, 0n);
}

function isAttributed(fact: AttributionFact): boolean {
  return Boolean(fact.acquisitionDate && (fact.campaignId || fact.armId));
}

export interface ReportOptions { windowDays: number; basis: RevenueBasis }

/**
 * 프로젝트 ROAS/순이익 ROI 보고서. 보고 통화로 모두 환산되면 하나, 아니면 원통화별 보고서를 만들고 판정을 막는다.
 * 수익·차감 fact는 획득일과 캠페인/arm 귀속이 있어야 하고 귀속 창이 windowDays여야 한다(다른 창은 다른 보고서에 속해 제외,
 * 창을 알 수 없는 수익은 혼합으로 보고 계산하지 않는다). 광고비는 cohortDay 기준으로 같은 기간에 합산한다.
 */
export function performanceReports(projectId: string, facts: AttributionFact[], policy: GrowthPolicy, fx: FxSnapshot[], now: Date, options: ReportOptions): PerformanceReport[] {
  const { windowDays, basis } = options;
  const current = withoutOverlap(currentFacts(facts.filter(fact => fact.projectId === projectId && Date.parse(fact.collectedAt) <= now.getTime())).facts, 'campaign');
  const commonReasons: string[] = [];
  const isRevenueFor = (fact: AttributionFact) => fact.kind === 'revenue' && (fact.revenueBasis === basis || fact.revenueBasis === 'net_proceeds');
  // 귀속 창이 아직 열린 최근 cohort는 수익이 덜 들어온 상태라 광고비와 함께 제외한다. 매일 동기화해도 판정이 막히지 않는다.
  let immature = 0;
  const relevant = current.filter(fact => {
    if (!MONEY_KINDS.has(fact.kind) || fact.amountMicros === undefined) return false;
    if (fact.kind === 'revenue' && !isRevenueFor(fact)) return false;
    if (fact.kind !== 'spend' && fact.attributionWindowDays !== undefined && fact.attributionWindowDays !== windowDays) return false;
    if (now.getTime() < windowEndsAt(cohortDay(fact), windowDays)) { immature++; return false; }
    return true;
  });
  if (immature && !relevant.length) commonReasons.push(`귀속 창(${windowDays}일)이 끝난 획득 cohort가 아직 없습니다.`);
  const missingCurrency = relevant.filter(fact => !fact.currency);
  if (missingCurrency.length) commonReasons.push(`통화가 없는 금액 fact ${missingCurrency.length}건을 제외했습니다.`);
  const priced = relevant.filter(fact => fact.currency);
  if (!priced.length && !immature) return [];

  const currencies = [...new Set(priced.map(fact => fact.currency!))].sort();
  const target = policy.reportingCurrency;
  let groups = new Map<string, Amount[]>();
  let currencyConsistent = currencies.length === 1;
  if (target && currencies.some(currency => currency !== target)) {
    const converted: Amount[] = [];
    const failures = new Set<string>();
    for (const fact of priced) {
      const result = convertMicros(fact.amountMicros!, fact.currency!, target, fx, fact.eventDate, policy, now);
      if (result.micros === null) failures.add(result.reason!); else converted.push({ fact, micros: BigInt(result.micros) });
    }
    if (!failures.size) { groups.set(target, converted); currencyConsistent = true; }
    else { commonReasons.push(...failures); currencyConsistent = false; }
  }
  if (!groups.size) for (const fact of priced) {
    const list = groups.get(fact.currency!) ?? [];
    list.push({ fact, micros: parseMicros(fact.amountMicros) });
    groups.set(fact.currency!, list);
  }
  if (!currencyConsistent) commonReasons.push('여러 통화가 섞여 있고 보고 통화로 환산할 수 없어 목표 판정을 하지 않습니다.');
  // 모든 cohort의 귀속 창이 열려 있으면 빈 보고서라도 돌려 미계산 사유를 화면에 보인다.
  const openCurrency = current.find(fact => MONEY_KINDS.has(fact.kind) && fact.currency)?.currency;
  if (!groups.size && immature && openCurrency) groups.set(policy.reportingCurrency ?? openCurrency, []);
  groups = new Map([...groups].sort(([a], [b]) => a < b ? -1 : 1));

  const stale = freshness(priced, policy, now).filter(item => item.stale);
  const fresh = stale.length === 0;
  const rate = policy.variableCostRate;
  const definitions = {
    roas: `ROAS = ${basis} 기준 귀속 수익(획득 cohort, ${windowDays}일 귀속 창, 원천 보고값) ÷ 같은 획득일 광고비. 공급자 보고 ROAS와 같은 기준이 아닐 수 있으며, 회사 회계 ROI나 기존 contribution(수익−지출) 지표가 아닙니다.`,
    netRoi: `순이익 ROI = (순수익 − 광고비 − 가변비용) ÷ (광고비 + 가변비용). 순수익 = net_proceeds 기준 귀속 수익 − 별도 환불·수수료·세금 fact이며, 같은 원천(sourceId)의 net_proceeds 수익에 이미 반영된 차감은 다시 빼지 않습니다. 가변비용 = 순수익(0 이상) × 가변비용 비율 ${rate}. 고정비·공통비를 제외하므로 회사 회계 ROI가 아니며 기존 contribution 지표와도 다릅니다.`,
  };

  return [...groups].map(([currency, amounts]) => {
    const spendFacts = amounts.filter(item => item.fact.kind === 'spend');
    const roasFacts = amounts.filter(item => item.fact.kind === 'revenue' && item.fact.revenueBasis === basis);
    const netFacts = amounts.filter(item => (item.fact.kind === 'revenue' && item.fact.revenueBasis === 'net_proceeds') || DEDUCTION_KINDS.has(item.fact.kind));
    const blockersFor = (set: Amount[]) => {
      const reasons: string[] = [];
      const unattributed = set.filter(item => !isAttributed(item.fact)).length;
      if (unattributed) reasons.push(`획득일·캠페인 귀속이 없는 수익 fact ${unattributed}건이 있어 앱 전체 contribution에만 쓸 수 있습니다.`);
      const unknownWindow = set.filter(item => item.fact.kind === 'revenue' && item.fact.attributionWindowDays === undefined).length;
      if (unknownWindow) reasons.push(`귀속 창을 알 수 없는 수익 fact ${unknownWindow}건이 섞여 있습니다.`);
      return reasons;
    };
    const days = [...spendFacts, ...roasFacts, ...netFacts].map(item => cohortDay(item.fact)).sort();
    const latest = days.at(-1);
    const windowComplete = latest !== undefined && now.getTime() >= windowEndsAt(latest, windowDays);
    const shared: string[] = [...commonReasons];
    if (!fresh) shared.push(...stale.map(item => item.reason!));
    if (!windowComplete && latest) shared.push(`최근 획득 cohort(${latest})의 ${windowDays}일 귀속 창이 아직 끝나지 않았습니다.`);

    const spend = sum(spendFacts, () => true);
    const attributedRevenue = sum(roasFacts, () => true);
    const net = netProceeds(netFacts);
    const variableCost = rateMicros(net, rate);

    const roasBlockers = [...shared, ...blockersFor(roasFacts)];
    if (spend === 0n) roasBlockers.push('광고비가 0이라 ROAS를 계산할 수 없습니다.');
    if (!roasFacts.length) roasBlockers.push(`${basis} 기준 귀속 수익 fact가 없습니다.`);

    const netBlockers = [...shared, ...blockersFor(netFacts)];
    if (!netFacts.some(item => item.fact.kind === 'revenue')) netBlockers.push('net_proceeds 기준 귀속 수익 fact가 없어 순이익 ROI를 계산할 수 없습니다.');
    if (netFacts.some(item => item.fact.finality === 'estimated')) netBlockers.push('추정(estimated) 단계 fact가 포함되어 순이익 ROI를 확정할 수 없습니다.');
    if (spend + variableCost === 0n) netBlockers.push('광고비와 가변비용이 0이라 순이익 ROI를 계산할 수 없습니다.');

    const attributed = [...roasFacts, ...netFacts].every(item => isAttributed(item.fact));
    const quality: DataQuality = {
      fresh, sampleSufficient: true, windowComplete, assignmentProven: attributed, currencyConsistent,
      reasons: [...new Set([...roasBlockers, ...netBlockers])],
    };
    const report: PerformanceReport = {
      projectId, currency, windowDays, basis,
      spendMicros: spend.toString(), attributedRevenueMicros: attributedRevenue.toString(), netProceedsMicros: net.toString(), variableCostMicros: variableCost.toString(),
      roas: roasBlockers.length ? null : Number(attributedRevenue) / Number(spend),
      netRoi: netBlockers.length ? null : Number(net - spend - variableCost) / Number(spend + variableCost),
      quality, definitions,
      factIds: [...new Set([...spendFacts, ...roasFacts, ...netFacts].map(item => item.fact.id))].sort(),
    };
    if (roasBlockers.length) report.roasReason = roasBlockers.join(' ');
    if (netBlockers.length) report.netRoiReason = netBlockers.join(' ');
    return report;
  });
}

function armMatches(arm: ExperimentArm, fact: AttributionFact): boolean {
  return fact.armId ? fact.armId === arm.id : Boolean(arm.campaignId && fact.campaignId === arm.campaignId);
}

/**
 * now 시점까지 수집된 현재 revision fact를 arm별로 나눈다. armId가 없으면 arm의 campaignId로 매칭하고,
 * 다른 실험에 귀속된 fact는 제외한다.
 */
export function factsByArm(experiment: Experiment, facts: AttributionFact[], now: Date): Map<string, AttributionFact[]> {
  // native A/B는 공급자가 배정한 실험 기간의 arm fact만 쓴다. 시작 전·다른 배정의 캠페인 fact가 arm 비교에 섞이면 인과 비교가 아니다.
  // 귀속 창이 끝나지 않은 cohort는 수익이 덜 들어와 비교를 왜곡하므로 제외한다.
  const start = experiment.startedAt?.slice(0, 10);
  const known = currentFacts(facts.filter(fact => fact.projectId === experiment.projectId && Date.parse(fact.collectedAt) <= now.getTime() &&
    (experiment.design === 'native_ab' ? fact.experimentId === experiment.id : !fact.experimentId || fact.experimentId === experiment.id) &&
    (!start || cohortDay(fact) >= start) && now.getTime() >= windowEndsAt(cohortDay(fact), experiment.hypothesis.attributionWindowDays))).facts;
  const scoped = withoutOverlap(known, 'experiment');
  return new Map(experiment.arms.map(arm => [arm.id, scoped.filter(fact => armMatches(arm, fact))]));
}

export interface ArmMetricOptions { metric?: MetricKey; variableCostRate?: number }

/**
 * 실험 arm별 지표. 비율 지표(PROPORTION_METRICS)는 성공/시행 합, 나머지는 cohort 일별 값(values)으로 요약한다.
 * estimate는 전체 합으로 계산한 pooled 값이고 검정은 일별 값을 쓴다. roas·arpdau·refund_rate는 hypothesis.revenueBasis가
 * 있어야 하며 수익 fact는 hypothesis 귀속 창과 같아야 한다. revenueMicros는 손실 계산용 귀속 순수익(net_proceeds − 별도 차감
 * + estimated_ad_revenue)이며 gross_conversion_value는 개발자 수익이 아니므로 넣지 않는다.
 */
export function armMetrics(experiment: Experiment, facts: AttributionFact[], now: Date, options: ArmMetricOptions = {}): ArmMetrics[] {
  const metric = options.metric ?? experiment.hypothesis.primaryMetric;
  const byArm = factsByArm(experiment, facts, now);
  return experiment.arms.map(arm => computeArm(arm.id, byArm.get(arm.id) ?? [], metric, experiment, options.variableCostRate ?? 0));
}

function computeArm(armId: string, facts: AttributionFact[], metric: MetricKey, experiment: Experiment, variableCostRate: number): ArmMetrics {
  const { attributionWindowDays: windowDays, revenueBasis: basis } = experiment.hypothesis;
  const count = (kind: AttributionFact['kind'], list = facts) => list.reduce((total, fact) => fact.kind === kind ? total + (fact.count ?? 0) : total, 0);
  const inWindow = (fact: AttributionFact) => fact.kind === 'spend' || fact.attributionWindowDays === windowDays;
  const money = facts.filter(fact => MONEY_KINDS.has(fact.kind) && fact.amountMicros !== undefined && inWindow(fact));
  const currencies = new Set(money.map(fact => fact.currency ?? ''));
  const currency = currencies.size === 1 && !currencies.has('') ? [...currencies][0] : undefined;
  const amounts: Amount[] = currency ? money.map(fact => ({ fact, micros: parseMicros(fact.amountMicros) })) : [];
  const result: ArmMetrics = { armId, samples: 0, estimate: null };
  if (currency) {
    result.currency = currency;
    result.spendMicros = sum(amounts, fact => fact.kind === 'spend').toString();
    result.revenueMicros = (netProceeds(amounts) + sum(amounts, fact => fact.kind === 'revenue' && fact.revenueBasis === 'estimated_ad_revenue')).toString();
  }

  if (PROPORTION_METRICS.includes(metric)) {
    let successes: number, trials: number;
    if (metric === 'conversion_rate') {
      const clicks = count('clicks');
      [successes, trials] = clicks > 0 || facts.some(fact => fact.kind === 'clicks') ? [count('conversions'), clicks] : [count('installs'), count('impressions')];
    } else if (metric === 'retention_d1') [successes, trials] = [count('retained_d1'), count('installs')];
    else { trials = count('sessions'); successes = Math.max(0, trials - count('crashes')); }
    return { ...result, successes, trials, samples: trials, estimate: trials > 0 ? successes / trials : null };
  }

  const needsBasis = metric === 'roas' || metric === 'arpdau' || metric === 'refund_rate';
  if (needsBasis && !basis) return result;
  // 나머지 지표는 모두 금액을 쓰므로 arm 안에서 통화가 하나여야 한다.
  if (!currency && money.length) return result;
  const basisRevenue = (fact: AttributionFact) => fact.kind === 'revenue' && fact.revenueBasis === basis;
  // arpdau는 사건일 기준 DAU 대비 지표라 eventDate, 나머지는 획득 cohort 기준으로 일별 묶음을 만든다.
  const dayOf = (fact: AttributionFact) => metric === 'arpdau' ? fact.eventDate.slice(0, 10) : cohortDay(fact);
  const days = new Map<string, { amounts: Amount[]; facts: AttributionFact[] }>();
  for (const fact of facts) {
    const key = dayOf(fact);
    const entry = days.get(key) ?? { amounts: [], facts: [] };
    entry.facts.push(fact);
    days.set(key, entry);
  }
  for (const item of amounts) days.get(dayOf(item.fact))!.amounts.push(item);

  const ratio = (list: Amount[], dayFacts: AttributionFact[]): number | null => {
    const spend = sum(list, fact => fact.kind === 'spend');
    switch (metric) {
      case 'roas': return spend > 0n ? Number(sum(list, basisRevenue)) / Number(spend) : null;
      case 'cost_per_install': { const installs = count('installs', dayFacts); return installs > 0 ? Number(spend) / 1_000_000 / installs : null; }
      case 'arpdau': { const users = count('active_users', dayFacts); return users > 0 ? Number(sum(list, basisRevenue)) / 1_000_000 / users : null; }
      case 'refund_rate': { const revenue = sum(list, basisRevenue); return revenue > 0n ? Number(sum(list, fact => fact.kind === 'refund')) / Number(revenue) : null; }
      case 'net_roi': {
        const net = netProceeds(list);
        const cost = spend + rateMicros(net, variableCostRate);
        return cost > 0n ? Number(net - cost) / Number(cost) : null;
      }
      default: return null;
    }
  };
  const values = [...days.keys()].sort().flatMap(day => { const value = ratio(days.get(day)!.amounts, days.get(day)!.facts); return value === null ? [] : [value]; });
  return { ...result, values, samples: values.length, estimate: ratio(amounts, facts) };
}
