// 가격 변경 위임 envelope 검사와 고객경험 guardrail·원복 snapshot. 순수 함수다.
import { parseMicros } from '../metrics/index.js';
import type { Guardrail, GrowthPolicy, MetricKey, OperationMandate } from './types.js';

export interface PricingProduct { productId: string; region: string; currency: string; currentPriceMicros: string }

export interface PricingProposalInput {
  mandate: OperationMandate; policy: GrowthPolicy; product: PricingProduct;
  proposedPriceMicros: string; lastChangeAt?: string;
  /** 진행 중인 가격 실험 수. */
  activePricingExperiments: number;
  now: Date;
}

export function validatePricingProposal(input: PricingProposalInput): { allowed: boolean; reasons: string[] } {
  const { mandate, policy, product, now } = input;
  const reasons: string[] = [];
  if (!policy.allowPricingExperiments) reasons.push('프로젝트 정책에서 가격 실험을 허용하지 않았습니다.');
  if (mandate.status !== 'active' || now.getTime() < Date.parse(mandate.startsAt) || now.getTime() >= Date.parse(mandate.endsAt)) reasons.push('활성 위임 기간 밖입니다.');
  if (!mandate.actions.includes('pricing-change')) reasons.push('가격 변경(pricing-change)이 위임 범위에 없습니다.');
  const envelope = mandate.limits.pricing;
  if (!envelope) return { allowed: false, reasons: [...reasons, '가격 변경 envelope이 없어 실행하지 않습니다.'] };
  if (!envelope.productIds.includes(product.productId)) reasons.push('위임 envelope에 없는 상품입니다.');
  if (!envelope.regions.includes(product.region)) reasons.push('위임 envelope에 없는 지역입니다.');
  const current = parseMicros(product.currentPriceMicros), proposed = parseMicros(input.proposedPriceMicros);
  const bound = envelope.bounds.find(item => item.productId === product.productId && item.currency === product.currency);
  if (!bound) reasons.push('이 상품·통화의 가격 floor/ceiling이 없습니다.');
  else if (proposed < parseMicros(bound.floorMicros) || proposed > parseMicros(bound.ceilingMicros)) reasons.push('제안 가격이 floor/ceiling 범위를 벗어납니다.');
  if (proposed === current) reasons.push('현재 가격과 같습니다.');
  if (current <= 0n) reasons.push('현재 가격을 확인할 수 없어 변화 폭을 계산할 수 없습니다.');
  else {
    const change = proposed > current ? proposed - current : current - proposed;
    if (change * 1_000_000n > current * BigInt(Math.floor(envelope.maxStep * 1_000_000))) reasons.push(`한 번의 가격 변화 폭 상한(${envelope.maxStep})을 넘습니다.`);
  }
  if (input.lastChangeAt && now.getTime() < Date.parse(input.lastChangeAt) + envelope.cooldownHours * 3_600_000) reasons.push(`직전 가격 변경 후 cooldown ${envelope.cooldownHours}시간이 지나지 않았습니다.`);
  if (input.activePricingExperiments >= envelope.maxConcurrentExperiments) reasons.push(`동시 가격 실험 수 상한(${envelope.maxConcurrentExperiments})에 도달했습니다.`);
  return { allowed: reasons.length === 0, reasons };
}

/** 변경 후 값이 guardrail 한계를 넘으면 위반이다. 값을 확인할 수 없는 guardrail도 안전을 증명하지 못하므로 위반으로 본다. */
export function pricingGuardrails(metrics: Partial<Record<MetricKey, { before: number; after: number }>>, guardrails: Guardrail[]): string[] {
  return guardrails.flatMap(guardrail => {
    const value = metrics[guardrail.metric];
    if (!value || !Number.isFinite(value.after)) return [`${guardrail.metric} 값을 확인할 수 없어 가격 변경을 유지할 수 없습니다.`];
    const violated = guardrail.direction === 'min' ? value.after < guardrail.threshold : value.after > guardrail.threshold;
    return violated ? [`${guardrail.metric}이(가) ${value.before}에서 ${value.after}로 바뀌어 ${guardrail.direction === 'min' ? '하한' : '상한'} ${guardrail.threshold}을(를) 넘었습니다.`] : [];
  });
}

export interface PricingRollback { productId: string; region: string; currency: string; priceMicros: string; providerRevision: string }

/** 원복에 필요한 원래 가격과 공급자 revision. 원복도 외부 쓰기이므로 idempotent run 입력으로 쓴다. */
export function rollbackSnapshot(product: PricingProduct, providerRevision: string): PricingRollback {
  return { productId: product.productId, region: product.region, currency: product.currency, priceMicros: parseMicros(product.currentPriceMicros).toString(), providerRevision };
}
