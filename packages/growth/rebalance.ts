// 캠페인 성과 규칙(이상 성과 중지·총액 유지 재배분). 외부 쓰기 전에 호출하는 순수 함수다.
// 캠페인 간 비교는 무작위 배정이 아니므로 승자 판정이 아니라 사용자가 위임한 운영 규칙으로만 쓴다.
import type { ExternalResource } from '../domain/index.js';
import { parseMicros } from '../metrics/index.js';
import { cohortDay, currentFacts, freshness, windowEndsAt } from './attribution.js';
import type { AttributionFact, GrowthPolicy, OperationMandate, RevenueBasis } from './types.js';

const DAY = 86_400_000;
const ACTIVE = new Set(['ENABLED', 'ACTIVE', 'LIVE', 'RUNNING']);

export interface CampaignPerformance {
  connectionId: string; campaignId: string; name: string; status: string;
  budgetMicros: string; currency: string;
  spendMicros: string; revenueMicros: string; roas: number | null;
  fresh: boolean; reasons: string[];
}

/**
 * 귀속 창이 끝난 최근 cohort(lookbackDays)만 모아 캠페인별 ROAS를 계산한다.
 * 수익 fact는 basis와 귀속 창이 정확히 같아야 하고(0은 공급자 기본 창), 통화가 캠페인 예산 통화와 같아야 한다.
 */
export function campaignPerformance(input: { campaigns: ExternalResource[]; facts: AttributionFact[]; policy: GrowthPolicy; now: Date; windowDays: number; basis: RevenueBasis; lookbackDays: number }): CampaignPerformance[] {
  const facts = currentFacts(input.facts).facts;
  const nowMs = input.now.getTime();
  return input.campaigns.filter(item => item.kind === 'campaign').map(campaign => {
    const currency = String(campaign.data.currency ?? '');
    const reasons: string[] = [];
    const own = facts.filter(fact => fact.connectionId === campaign.connectionId && fact.campaignId === campaign.externalId && !fact.experimentId);
    const done = own.filter(fact => {
      const day = cohortDay(fact);
      return windowEndsAt(day, input.windowDays) <= nowMs && Date.parse(day + 'T00:00:00Z') >= nowMs - (input.lookbackDays + input.windowDays + 1) * DAY;
    });
    let spend = 0n; let revenue = 0n; let mixed = false;
    for (const fact of done) {
      if (!fact.amountMicros) continue;
      if (fact.currency !== currency) { mixed = true; continue; }
      if (fact.kind === 'spend') spend += parseMicros(fact.amountMicros);
      else if (fact.kind === 'revenue' && fact.revenueBasis === input.basis && fact.attributionWindowDays === input.windowDays) revenue += parseMicros(fact.amountMicros);
    }
    if (mixed) reasons.push('캠페인 예산과 다른 통화의 fact가 있어 성과를 계산하지 않습니다.');
    if (!done.length) reasons.push('귀속 창이 끝난 최근 cohort fact가 없습니다.');
    if (spend === 0n) reasons.push('기간 광고비가 0입니다.');
    const stale = freshness(own, input.policy, input.now, [campaign.provider]).filter(item => item.stale);
    reasons.push(...stale.map(item => item.reason!));
    const roas = !mixed && spend > 0n ? Number(revenue) / Number(spend) : null;
    return { connectionId: campaign.connectionId, campaignId: campaign.externalId, name: campaign.name, status: campaign.status,
      budgetMicros: String(campaign.data.dailyBudgetMicros ?? '0'), currency, spendMicros: spend.toString(), revenueMicros: revenue.toString(), roas, fresh: stale.length === 0, reasons };
  });
}

export interface CampaignRulePlan {
  stops: Array<{ connectionId: string; campaignId: string; reason: string }>;
  moves: Array<{ from: CampaignPerformance; to: CampaignPerformance; fromBudgetMicros: string; toBudgetMicros: string; reason: string }>;
  blockers: string[];
}

/**
 * - 중지: ads-stop과 campaignStopRoasBelow가 있을 때 최소 광고비 이상·신선한 캠페인의 ROAS가 기준 미만이면 중지한다.
 * - 재배분: ads-rebalance가 있을 때 목표 ROAS 미만 중 최저 캠페인 예산의 1회 증액 폭만큼을 목표 이상 중 최고 캠페인으로 옮긴다.
 *   총 일일 예산은 바뀌지 않고, 주기마다 한 번만, 두 캠페인 모두 cooldown이 지나야 한다.
 */
export function planCampaignRules(input: { mandate: OperationMandate; performance: CampaignPerformance[]; lastChangeAt: Record<string, string>; now: Date }): CampaignRulePlan {
  const { mandate, now } = input;
  const plan: CampaignRulePlan = { stops: [], moves: [], blockers: [] };
  const target = mandate.goals.roas?.target;
  const minimum = mandate.limits.minDecisionSpendMicros;
  if (!mandate.actions.includes('ads-stop') && !mandate.actions.includes('ads-rebalance')) return plan;
  if (!minimum) { plan.blockers.push('캠페인 성과 규칙에 필요한 판단 최소 광고비가 위임에 없습니다.'); return plan; }
  const eligible = input.performance.filter(item => {
    if (!ACTIVE.has(item.status.toUpperCase())) return false;
    if (item.roas === null || !item.fresh) { plan.blockers.push(`${item.name}: ${item.reasons[0] ?? '성과를 계산할 수 없습니다.'}`); return false; }
    if (item.currency !== mandate.limits.currency) { plan.blockers.push(`${item.name}: 위임 통화와 다른 캠페인입니다.`); return false; }
    return parseMicros(item.spendMicros) >= parseMicros(minimum);
  });
  const stopBelow = mandate.limits.campaignStopRoasBelow;
  if (mandate.actions.includes('ads-stop') && stopBelow !== undefined) {
    for (const item of eligible) if (item.roas! < stopBelow) plan.stops.push({ connectionId: item.connectionId, campaignId: item.campaignId, reason: `ROAS ${item.roas!.toFixed(3)}가 중지 기준 ${stopBelow} 미만입니다.` });
  }
  if (!mandate.actions.includes('ads-rebalance')) return plan;
  if (target === undefined) { plan.blockers.push('재배분에 필요한 목표 ROAS가 위임에 없습니다.'); return plan; }
  const stopped = new Set(plan.stops.map(item => item.connectionId + ':' + item.campaignId));
  const ready = (item: CampaignPerformance) => {
    const last = input.lastChangeAt[item.connectionId + ':' + item.campaignId];
    return !last || now.getTime() >= Date.parse(last) + mandate.limits.cooldownHours * 3_600_000;
  };
  const candidates = eligible.filter(item => !stopped.has(item.connectionId + ':' + item.campaignId) && ready(item));
  const under = candidates.filter(item => item.roas! < target).sort((a, b) => a.roas! - b.roas!)[0];
  const over = candidates.filter(item => item.roas! >= target).sort((a, b) => b.roas! - a.roas!)[0];
  if (!under || !over) return plan;
  // 옮기는 금액은 주는 쪽과 받는 쪽 모두 1회 변경 폭을 넘지 않게 작은 쪽 기준으로 정한다.
  const budget = parseMicros(under.budgetMicros);
  const step = BigInt(Math.floor(mandate.limits.maxBudgetStep * 1_000_000));
  const fromCap = budget * step / 1_000_000n; const toCap = parseMicros(over.budgetMicros) * step / 1_000_000n;
  const amount = fromCap < toCap ? fromCap : toCap;
  if (amount <= 0n || budget - amount <= 0n) { plan.blockers.push(`${under.name}: 옮길 예산이 없습니다.`); return plan; }
  plan.moves.push({ from: under, to: over, fromBudgetMicros: (budget - amount).toString(), toBudgetMicros: (parseMicros(over.budgetMicros) + amount).toString(),
    reason: `목표 ROAS ${target} 미만인 ${under.name}(${under.roas!.toFixed(3)})의 예산 ${amount} micros를 ${over.name}(${over.roas!.toFixed(3)})로 옮깁니다. 캠페인 비교는 관찰 기반 운영 규칙입니다.` });
  return plan;
}
