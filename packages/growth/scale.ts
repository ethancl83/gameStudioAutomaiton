// 승자 단계 증액과 안전 중지의 위임 범위 검사. 외부 쓰기 전에 호출하는 순수 함수다.
import { parseMicros } from '../metrics/index.js';
import type { DecisionSnapshot, OperationMandate } from './types.js';

export interface BudgetStepInput {
  mandate: OperationMandate;
  currentBudgetMicros: string;
  proposedBudgetMicros?: string;
  lastScaleAt?: string;
  spentTodayMicros: string;
  spentTotalMicros: string;
  /** 같은 위임에서 이미 예약된 다른 일일 예산(대기 중 run·다른 캠페인). */
  pendingBudgetMicros: string;
  now: Date;
  decision: DecisionSnapshot;
}

export interface PlanResult { allowed: boolean; budgetMicros: string | null; reasons: string[] }

function withinMandate(mandate: OperationMandate, now: Date, reasons: string[]): void {
  if (mandate.status !== 'active') reasons.push('위임이 활성 상태가 아닙니다.');
  const at = now.getTime();
  if (at < Date.parse(mandate.startsAt) || at >= Date.parse(mandate.endsAt)) reasons.push('위임 기간 밖입니다.');
}

/**
 * 한 단계 증액 계획. 새 예산 = min(현재 × (1 + maxBudgetStep), 제안값)이며 한 번에 한 단계만 올린다.
 * 일일 한도는 새 예산 + 대기 예약 합, 누적 한도는 누적 지출 + 대기 예약 + 새 예산 하루치로 보수적으로 검사한다.
 */
export function planBudgetStep(input: BudgetStepInput): PlanResult {
  const { mandate, decision, now } = input;
  const limits = mandate.limits;
  const reasons: string[] = [];
  withinMandate(mandate, now, reasons);
  if (!mandate.actions.includes('ads-scale')) reasons.push('증액(ads-scale)이 위임 범위에 없습니다.');
  if (decision.mandateId !== mandate.id) reasons.push('다른 위임에서 만든 결정입니다.');
  if (decision.outcome !== 'winner') reasons.push('승자 결정이 아니면 증액하지 않습니다.');
  else if (!decision.quality.fresh) reasons.push('신선하지 않은 데이터로 만든 결정이라 증액하지 않습니다.');
  if (input.lastScaleAt) {
    const readyAt = Date.parse(input.lastScaleAt) + limits.cooldownHours * 3_600_000;
    if (now.getTime() < readyAt) reasons.push(`직전 증액 후 cooldown ${limits.cooldownHours}시간이 지나지 않았습니다.`);
  }
  const current = parseMicros(input.currentBudgetMicros);
  if (current <= 0n) reasons.push('현재 예산을 확인할 수 없어 증액 폭을 계산할 수 없습니다.');
  const stepPpm = BigInt(Math.floor(limits.maxBudgetStep * 1_000_000));
  let next = current + current * stepPpm / 1_000_000n;
  if (input.proposedBudgetMicros !== undefined) {
    const proposed = parseMicros(input.proposedBudgetMicros);
    if (proposed < next) next = proposed;
  }
  if (next <= current) reasons.push('현재 예산보다 큰 증액이 아닙니다.');
  const pending = parseMicros(input.pendingBudgetMicros);
  if (parseMicros(input.spentTodayMicros) >= parseMicros(limits.maxDailySpendMicros)) reasons.push('오늘 지출이 일일 한도에 도달했습니다.');
  if (next + pending > parseMicros(limits.maxDailySpendMicros)) reasons.push('대기 예약을 포함한 일일 예산이 일일 지출 한도를 넘습니다.');
  if (parseMicros(input.spentTotalMicros) + pending + next > parseMicros(limits.maxTotalSpendMicros)) reasons.push('누적 지출과 대기 예약을 포함하면 누적 지출 한도를 넘습니다.');
  return reasons.length ? { allowed: false, budgetMicros: null, reasons } : { allowed: true, budgetMicros: next.toString(), reasons };
}

/** 중지(pause)는 ads-stop 위임이 있거나 위임이 끝난(만료·중지·기간 종료) 경우 안전 중지로 허용한다. */
export function planStop(input: { mandate: OperationMandate; now: Date }): { allowed: boolean; reasons: string[] } {
  const { mandate, now } = input;
  if (mandate.actions.includes('ads-stop')) return { allowed: true, reasons: [] };
  if (mandate.status === 'expired' || mandate.status === 'stopped' || now.getTime() >= Date.parse(mandate.endsAt)) {
    return { allowed: true, reasons: ['위임이 끝나 안전 중지로 허용합니다.'] };
  }
  return { allowed: false, reasons: ['중지(ads-stop)가 위임 범위에 없습니다.'] };
}
