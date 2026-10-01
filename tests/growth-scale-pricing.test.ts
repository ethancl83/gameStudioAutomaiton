import test from 'node:test';
import assert from 'node:assert/strict';
import { planBudgetStep, planStop, type BudgetStepInput } from '../packages/growth/scale.js';
import { pricingGuardrails, rollbackSnapshot, validatePricingProposal, type PricingProposalInput } from '../packages/growth/pricing.js';
import type { DecisionSnapshot, GrowthPolicy, OperationMandate } from '../packages/growth/types.js';

const now = new Date('2026-09-24T12:00:00Z');
const mandate = { id: 'm', projectId: 'p', status: 'active', actions: ['observe', 'ads-scale', 'pricing-change'],
  limits: { currency: 'USD', maxDailySpendMicros: '200000000', maxTotalSpendMicros: '5000000000', maxLossMicros: '1000000000', maxBudgetStep: 0.2, cooldownHours: 24, maxDailyReplies: 0,
    pricing: { productIds: ['gems_100'], regions: ['KR'], bounds: [{ productId: 'gems_100', currency: 'KRW', floorMicros: '1000000000', ceilingMicros: '2000000000' }], maxStep: 0.1, cooldownHours: 72, maxConcurrentExperiments: 1 } },
  startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' } as OperationMandate;
const decision = { mandateId: 'm', outcome: 'winner', quality: { fresh: true } } as DecisionSnapshot;
const step: BudgetStepInput = { mandate, currentBudgetMicros: '100000000', spentTodayMicros: '50000000', spentTotalMicros: '1000000000', pendingBudgetMicros: '0', now, decision };

test('budget scaling moves one bounded step and respects the proposal', () => {
  assert.deepEqual(planBudgetStep(step), { allowed: true, budgetMicros: '120000000', reasons: [] });
  assert.equal(planBudgetStep({ ...step, proposedBudgetMicros: '500000000' }).budgetMicros, '120000000');
  assert.equal(planBudgetStep({ ...step, proposedBudgetMicros: '110000000' }).budgetMicros, '110000000');
  assert.equal(planBudgetStep({ ...step, proposedBudgetMicros: '90000000' }).allowed, false);
});

test('budget scaling requires a fresh winner, delegated action, active period and elapsed cooldown', () => {
  const refused = (input: Partial<BudgetStepInput>, pattern: RegExp) => {
    const result = planBudgetStep({ ...step, ...input });
    assert.equal(result.allowed, false);
    assert.equal(result.budgetMicros, null);
    assert.ok(result.reasons.some(reason => pattern.test(reason)), result.reasons.join(' | '));
  };
  refused({ decision: { ...decision, outcome: 'continue' } }, /승자 결정이 아니면/);
  refused({ decision: { ...decision, quality: { ...decision.quality, fresh: false } } }, /신선하지 않은/);
  refused({ mandate: { ...mandate, actions: ['observe'] } }, /ads-scale/);
  refused({ mandate: { ...mandate, status: 'stopped' } }, /활성 상태/);
  refused({ now: new Date('2026-10-02T00:00:00Z') }, /기간 밖/);
  refused({ lastScaleAt: '2026-09-24T00:00:00Z' }, /cooldown 24시간/);
  assert.equal(planBudgetStep({ ...step, lastScaleAt: '2026-09-23T11:00:00Z' }).allowed, true);
});

test('daily and total limits include pending reservations', () => {
  assert.equal(planBudgetStep({ ...step, pendingBudgetMicros: '80000000' }).allowed, true);
  const daily = planBudgetStep({ ...step, pendingBudgetMicros: '80000001' });
  assert.ok(!daily.allowed && daily.reasons.some(reason => /일일 지출 한도/.test(reason)));
  const total = planBudgetStep({ ...step, spentTotalMicros: '4800000000', pendingBudgetMicros: '80000001' });
  assert.ok(total.reasons.some(reason => /누적 지출 한도/.test(reason)));
  assert.ok(planBudgetStep({ ...step, spentTodayMicros: '200000000' }).reasons.some(reason => /일일 한도에 도달/.test(reason)));
});

test('stopping is allowed when delegated or once the mandate has ended', () => {
  assert.equal(planStop({ mandate, now }).allowed, false);
  assert.equal(planStop({ mandate: { ...mandate, actions: ['ads-stop'] }, now }).allowed, true);
  assert.equal(planStop({ mandate: { ...mandate, status: 'expired' }, now }).allowed, true);
  assert.equal(planStop({ mandate, now: new Date('2026-10-01T00:00:00Z') }).allowed, true);
});

const policy = { allowPricingExperiments: true } as GrowthPolicy;
const product = { productId: 'gems_100', region: 'KR', currency: 'KRW', currentPriceMicros: '1500000000' };
const proposal: PricingProposalInput = { mandate, policy, product, proposedPriceMicros: '1650000000', activePricingExperiments: 0, now };

test('pricing proposals must stay inside the delegated envelope', () => {
  assert.deepEqual(validatePricingProposal(proposal), { allowed: true, reasons: [] });
  const refused = (input: Partial<PricingProposalInput>, pattern: RegExp) => {
    const result = validatePricingProposal({ ...proposal, ...input });
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.some(reason => pattern.test(reason)), result.reasons.join(' | '));
  };
  refused({ policy: { ...policy, allowPricingExperiments: false } }, /가격 실험을 허용하지/);
  refused({ mandate: { ...mandate, actions: ['pricing-proposal'] } }, /pricing-change/);
  refused({ mandate: { ...mandate, limits: { ...mandate.limits, pricing: undefined } } }, /envelope이 없어/);
  refused({ product: { ...product, productId: 'gems_500' } }, /없는 상품/);
  refused({ product: { ...product, region: 'US' } }, /없는 지역/);
  refused({ product: { ...product, currency: 'USD' } }, /floor\/ceiling이 없습니다/);
  refused({ proposedPriceMicros: '1650000001' }, /변화 폭 상한/);
  refused({ product: { ...product, currentPriceMicros: '1950000000' }, proposedPriceMicros: '2100000000' }, /floor\/ceiling 범위/);
  refused({ lastChangeAt: '2026-09-22T12:00:00Z' }, /cooldown 72시간/);
  refused({ activePricingExperiments: 1 }, /동시 가격 실험/);
  refused({ proposedPriceMicros: '1500000000' }, /현재 가격과 같습니다/);
  assert.equal(validatePricingProposal({ ...proposal, proposedPriceMicros: '1350000000', lastChangeAt: '2026-09-21T11:00:00Z' }).allowed, true);
});

test('pricing guardrails flag worsening or unknown metrics and rollback keeps the original price', () => {
  const guardrails = [{ metric: 'retention_d1' as const, direction: 'min' as const, threshold: 0.3 }, { metric: 'refund_rate' as const, direction: 'max' as const, threshold: 0.05 }];
  assert.deepEqual(pricingGuardrails({ retention_d1: { before: 0.35, after: 0.33 }, refund_rate: { before: 0.02, after: 0.03 } }, guardrails), []);
  const violations = pricingGuardrails({ retention_d1: { before: 0.35, after: 0.28 } }, guardrails);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /retention_d1.*0\.35에서 0\.28/);
  assert.match(violations[1], /refund_rate 값을 확인할 수 없어/);
  assert.deepEqual(rollbackSnapshot(product, 'rev-7'), { productId: 'gems_100', region: 'KR', currency: 'KRW', priceMicros: '1500000000', providerRevision: 'rev-7' });
});
