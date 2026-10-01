import { randomUUID } from 'node:crypto';
import type { ExternalResource, Run } from '../../packages/domain/index.js';
import { AppError, object, text } from '../../packages/domain/errors.js';
import type { Store } from '../../packages/storage/index.js';
import { parseMicros } from '../../packages/metrics/index.js';
import { pricingGuardrails, rollbackSnapshot, validatePricingProposal } from '../../packages/growth/pricing.js';
import { currentFacts } from '../../packages/growth/attribution.js';
import type { AttributionFact, Guardrail, GrowthPolicy, MandateAction, MetricKey, OperationMandate, PricingChange } from '../../packages/growth/types.js';

export interface PricingDeps {
  iso(): string; clock(): number;
  mandate(id: string): OperationMandate;
  policy(projectId: string): GrowthPolicy;
  active(mandate: OperationMandate): boolean;
  queueWrite(mandate: OperationMandate, action: MandateAction, connectionId: string, operation: string, input: Record<string, unknown>, identity: string, safety?: boolean): Run;
}
const DAY = 86_400_000;
const GUARDRAIL_METRICS: MetricKey[] = ['refund_rate', 'crash_free_rate', 'retention_d1', 'conversion_rate'];

/** Play 상품 동기화 결과에서 지역 가격을 마이크로 단위로 읽는다. 다른 공급자는 확인할 수 없으면 null이다. */
export function storePrice(resource: ExternalResource, region: string): { micros: string; currency: string } | null {
  const variants = resource.data.variants;
  if (!Array.isArray(variants) || variants.length !== 1) return null;
  const variant = variants[0] as Record<string, unknown>;
  const prices = (variant.regionalPricingAndAvailabilityConfigs ?? variant.regionalConfigs) as Array<{ regionCode?: string; price?: { currencyCode?: string; units?: string | number; nanos?: number } }> | undefined;
  const price = prices?.find(item => item.regionCode === region)?.price;
  if (!price?.currencyCode) return null;
  const micros = BigInt(String(price.units ?? '0')) * 1_000_000n + BigInt(Math.trunc((price.nanos ?? 0) / 1000));
  return { micros: micros.toString(), currency: price.currencyCode };
}

/** 가격 guardrail 지표. 같은 기간·프로젝트의 귀속 fact 합으로 계산하며, 분모가 없으면 값을 만들지 않는다. */
export function guardrailMetrics(facts: AttributionFact[], from: number, to: number): Partial<Record<MetricKey, number>> {
  const scoped = currentFacts(facts).facts.filter(fact => { const at = Date.parse(fact.eventDate.slice(0, 10) + 'T00:00:00Z'); return at >= from && at < to; });
  const count = (kind: AttributionFact['kind']) => scoped.reduce((total, fact) => fact.kind === kind ? total + (fact.count ?? 0) : total, 0);
  const currencies = new Set(scoped.filter(fact => fact.amountMicros !== undefined && ['revenue', 'refund'].includes(fact.kind)).map(fact => fact.currency));
  const money = (kind: AttributionFact['kind']) => scoped.reduce((total, fact) => fact.kind === kind && fact.amountMicros ? total + parseMicros(fact.amountMicros) : total, 0n);
  const result: Partial<Record<MetricKey, number>> = {};
  if (currencies.size === 1 && money('revenue') > 0n) result.refund_rate = Number(money('refund')) / Number(money('revenue'));
  if (count('sessions') > 0) result.crash_free_rate = 1 - count('crashes') / count('sessions');
  if (count('installs') > 0) result.retention_d1 = count('retained_d1') / count('installs');
  if (count('clicks') > 0) result.conversion_rate = count('conversions') / count('clicks');
  return result;
}

/**
 * 가격 제안·적용·관찰·원복. 가격 변경은 위임 envelope와 guardrail 기준선이 모두 있을 때만 실행하고,
 * 기존 구독자 가격 인상처럼 되돌리기 어려운 변경은 운영자 승인 전에는 보내지 않는다.
 */
export class GrowthPricing {
  constructor(private store: Store, private deps: PricingDeps) {}
  private change(id: string): PricingChange {
    const change = this.store.get<PricingChange>('pricing-change', id);
    if (!change) throw new AppError('NOT_FOUND', '가격 변경 기록을 찾을 수 없습니다.', 404);
    return change;
  }
  private save(change: PricingChange, event?: Parameters<Store['addEvent']>[0]): PricingChange {
    const value = { ...change, updatedAt: this.deps.iso() };
    this.store.writeBatch([{ kind: 'pricing-change', id: value.id, value }], [], event ? [event] : []);
    return value;
  }
  propose(data: Record<string, unknown>): PricingChange {
    const mandate = this.deps.mandate(text(data.mandateId, '위임 ID', 100));
    const connectionId = text(data.connectionId, '스토어 계정', 100);
    if (!mandate.connectionIds.includes(connectionId)) throw new AppError('MANDATE_DENIED', '위임에 포함된 스토어 계정만 사용할 수 있습니다.', 403);
    if (!mandate.actions.includes('pricing-proposal') && !mandate.actions.includes('pricing-change')) throw new AppError('MANDATE_DENIED', '위임 범위에 가격 제안이 없습니다.', 403);
    const externalId = text(data.productExternalId, '상품', 300);
    const resource = this.store.list<ExternalResource>('resource').find(item => item.kind === 'product' && item.connectionId === connectionId && item.externalId === externalId);
    if (!resource || resource.projectId !== mandate.projectId) throw new AppError('RESOURCE_SYNC_REQUIRED', '이 프로젝트의 상품을 먼저 동기화해 주세요.');
    const region = text(data.region, '지역', 2).toUpperCase();
    const current = storePrice(resource, region);
    const policy = this.deps.policy(mandate.projectId);
    const proposed = parseMicros(data.proposedPriceMicros).toString();
    const guardrails: Guardrail[] = Array.isArray(data.guardrails) ? data.guardrails.map(item => { const g = object(item);
      if (!GUARDRAIL_METRICS.includes(g.metric as MetricKey) || !['min', 'max'].includes(String(g.direction)) || typeof g.threshold !== 'number') throw new AppError('INVALID_INPUT', '가격 보호 지표를 확인해 주세요.');
      return { metric: g.metric as MetricKey, direction: g.direction as 'min' | 'max', threshold: g.threshold }; }) : [];
    const observeDays = Number.isSafeInteger(data.observeDays) && Number(data.observeDays) >= 1 && Number(data.observeDays) <= 90 ? Number(data.observeDays) : undefined;
    if (!observeDays) throw new AppError('INVALID_INPUT', '가격 변경 후 관찰 기간(1~90일)을 입력해 주세요.');
    const now = new Date(this.deps.clock());
    const facts = this.store.documents<AttributionFact>('attribution-fact', { projectId: mandate.projectId });
    const baseline = guardrailMetrics(facts, now.getTime() - observeDays * DAY, now.getTime());
    const productType = String(resource.data.productType ?? '') as PricingChange['productType'];
    const history = this.store.list<PricingChange>('pricing-change').filter(item => item.productExternalId === externalId && item.region === region);
    const reasons = current ? validatePricingProposal({ mandate, policy, product: { productId: String(resource.data.productId ?? externalId), region, currency: current.currency, currentPriceMicros: current.micros },
      proposedPriceMicros: proposed, lastChangeAt: history.map(item => item.appliedAt).filter(Boolean).sort().at(-1), activePricingExperiments: this.store.list<PricingChange>('pricing-change').filter(item => item.mandateId === mandate.id && ['queued', 'applied', 'observing', 'approval_required'].includes(item.status)).length, now }).reasons
      : ['동기화한 상품에서 이 지역의 현재 가격을 확인할 수 없어 변화 폭을 검사할 수 없습니다.'];
    if (!guardrails.length) reasons.push('환불·크래시·잔존 등 고객경험 보호 지표 없이 가격을 바꾸지 않습니다.');
    for (const guardrail of guardrails) if (baseline[guardrail.metric] === undefined) reasons.push(`${guardrail.metric} 기준선 데이터가 없어 변경 후 악화를 판단할 수 없습니다.`);
    if (current && data.currency && String(data.currency).toUpperCase() !== current.currency) reasons.push('상품의 기존 통화와 다른 통화입니다.');
    const change: PricingChange = {
      id: randomUUID(), projectId: mandate.projectId, mandateId: mandate.id, connectionId, provider: resource.provider, productExternalId: externalId,
      productType: ['one-time', 'subscription'].includes(productType) ? productType : 'unknown', region, currency: current?.currency ?? String(data.currency ?? '').toUpperCase(),
      previousPriceMicros: current?.micros ?? '0', proposedPriceMicros: proposed, status: 'proposed', guardrails, baseline, observeDays, reasons,
      createdAt: this.deps.iso(), updatedAt: this.deps.iso(),
    };
    if (reasons.length) return this.save({ ...change, status: mandate.actions.includes('pricing-change') ? 'blocked' : 'proposed' });
    if (!mandate.actions.includes('pricing-change')) return this.save(change, { projectId: change.projectId, kind: 'growth.pricing.proposed', message: '가격 변경 제안을 기록했습니다. 위임에 가격 변경이 없어 실행하지 않습니다.' });
    // 기존 구독자에게 영향을 주는 인상은 되돌리기 어렵고 고지 의무가 따르므로 사람 승인 게이트를 둔다.
    if (change.productType !== 'one-time' && parseMicros(proposed) > parseMicros(change.previousPriceMicros))
      return this.save({ ...change, status: 'approval_required', reasons: ['구독 가격 인상은 기존 구독자 고지·동의 절차가 필요해 운영자 승인 후 실행합니다.'] });
    return this.apply(change, mandate);
  }
  approve(id: string, note: string): PricingChange {
    const change = this.change(id);
    if (change.status !== 'approval_required') throw new AppError('INVALID_STATE', '승인이 필요한 가격 변경만 승인할 수 있습니다.', 409);
    if (note.length < 5) throw new AppError('INVALID_INPUT', '고지·동의 절차를 확인한 내용을 기록해 주세요.');
    return this.apply({ ...change, approvedAt: this.deps.iso(), reasons: [...change.reasons, '운영자 승인: ' + note] }, this.deps.mandate(change.mandateId));
  }
  private apply(change: PricingChange, mandate: OperationMandate): PricingChange {
    return this.store.transaction(() => {
      const run = this.deps.queueWrite(mandate, 'pricing-change', change.connectionId, 'update-product',
        { externalId: change.productExternalId, priceMicros: change.proposedPriceMicros, currency: change.currency, country: change.region }, 'price:' + change.id);
      return this.save({ ...change, status: 'queued', runId: run.id }, { projectId: change.projectId, kind: 'growth.pricing.queued', message: '위임 범위 안의 가격 변경을 큐에 넣었습니다. 원래 가격은 원복용으로 보존했습니다.', data: { pricingChangeId: change.id, runId: run.id } });
    });
  }
  /** 원복은 수동으로 언제든, 자동으로는 guardrail 위반 시 실행한다. 만료된 위임에서도 고객 보호를 위한 원복은 허용한다. */
  rollback(id: string, reason: string): PricingChange {
    const change = this.change(id);
    if (!['applied', 'observing', 'kept'].includes(change.status)) throw new AppError('INVALID_STATE', '적용이 확인된 가격만 원복할 수 있습니다.', 409);
    const snapshot = rollbackSnapshot({ productId: change.productExternalId, region: change.region, currency: change.currency, currentPriceMicros: change.previousPriceMicros }, change.runId ?? '');
    const mandate = this.deps.mandate(change.mandateId);
    const input = { externalId: change.productExternalId, priceMicros: snapshot.priceMicros, currency: snapshot.currency, country: snapshot.region };
    return this.store.transaction(() => {
      const run = this.deps.queueWrite(mandate, 'pricing-change', change.connectionId, 'update-product', input, 'price-rollback:' + change.id, true);
      return this.save({ ...change, status: 'rolling_back', rollbackRunId: run.id, reasons: [...change.reasons, '원복: ' + reason] },
        { projectId: change.projectId, kind: 'growth.pricing.rollback', message: '가격을 원래 값으로 되돌리는 작업을 큐에 넣었습니다: ' + reason, level: 'warning', data: { pricingChangeId: change.id } });
    });
  }
  cycle(projectId: string): void {
    const now = this.deps.clock();
    for (const change of this.store.documents<PricingChange>('pricing-change', { projectId })) {
      if (change.status === 'queued' && change.runId) {
        const run = this.store.getRun(change.runId); if (!run) continue;
        if (run.status === 'succeeded') this.save({ ...change, status: 'observing', appliedAt: run.finishedAt ?? this.deps.iso() }, { projectId, kind: 'growth.pricing.applied', message: '가격 변경을 공급자에서 확인했습니다. 보호 지표를 관찰합니다.' });
        else if (run.status === 'failed' || run.status === 'cancelled') this.save({ ...change, status: 'failed', reasons: [...change.reasons, run.error ?? '가격 변경이 적용되지 않았습니다.'] });
        else if (run.status === 'action_required') this.save({ ...change, status: 'action_required', reasons: [...change.reasons, run.error ?? '가격 변경 결과를 확인해야 합니다. 다시 보내지 않았습니다.'] });
      } else if (change.status === 'rolling_back' && change.rollbackRunId) {
        const run = this.store.getRun(change.rollbackRunId);
        if (run?.status === 'succeeded') this.save({ ...change, status: 'rolled_back', decidedAt: this.deps.iso() }, { projectId, kind: 'growth.pricing.rolled_back', message: '원래 가격으로 되돌린 것을 확인했습니다.' });
        else if (run && ['failed', 'action_required', 'cancelled'].includes(run.status)) this.save({ ...change, status: 'action_required', reasons: [...change.reasons, run.error ?? '원복 결과를 확인해야 합니다.'] });
      } else if (change.status === 'observing' && change.appliedAt) {
        const applied = Date.parse(change.appliedAt);
        const facts = this.store.documents<AttributionFact>('attribution-fact', { projectId });
        const after = guardrailMetrics(facts, applied, Math.min(now, applied + change.observeDays * DAY));
        const metrics = Object.fromEntries(change.guardrails.map(guardrail => [guardrail.metric, { before: change.baseline[guardrail.metric] ?? NaN, after: after[guardrail.metric] ?? NaN }]));
        const known = change.guardrails.filter(guardrail => after[guardrail.metric] !== undefined);
        const violations = pricingGuardrails(Object.fromEntries(Object.entries(metrics).filter(([metric]) => known.some(item => item.metric === metric))), known);
        if (violations.length) { this.rollback(change.id, violations.join(' ')); continue; }
        if (now >= applied + change.observeDays * DAY) {
          if (known.length < change.guardrails.length) this.rollback(change.id, '관찰 기간이 끝났지만 보호 지표를 확인할 수 없어 원래 가격으로 되돌립니다.');
          else this.save({ ...change, status: 'kept', decidedAt: this.deps.iso() }, { projectId, kind: 'growth.pricing.kept', message: '관찰 기간 동안 보호 지표가 유지되어 새 가격을 유지합니다.' });
        }
      }
    }
  }
}
