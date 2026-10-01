// 수익화·가격: 위임 envelope 안의 가격 제안·승인(구독 인상)·원복과 관찰 결과.
import { useId, useState } from 'react';
import { Plus, Tags } from 'lucide-react';
import type { Guardrail, MetricKey, PricingChange } from '../../../../../packages/growth/types';
import { formatDateTime, formatMicros, majorToMicros } from '../../format';
import { Badge, Card, EmptyState, Field, Modal, Notice } from '../../components/ui';
import { ActionFeedback, AskAi, METRIC_LABELS, ReasonAction, ReasonList, connectionLabel, intInput, num, useGrowthAction, type GrowthAction, type SectionProps, type Tone } from './shared';

const STATUS: Record<PricingChange['status'], [string, Tone]> = {
  proposed: ['제안(실행 안 함)', 'neutral'], approval_required: ['운영자 승인 필요', 'warn'], queued: ['변경 대기열', 'progress'], applied: ['적용됨', 'progress'],
  observing: ['관찰 중', 'progress'], kept: ['유지', 'ok'], rolling_back: ['원복 중', 'progress'], rolled_back: ['원복됨', 'neutral'], blocked: ['차단', 'warn'], failed: ['실패', 'error'], action_required: ['조치 필요', 'error'],
};
const TYPE: Record<PricingChange['productType'], string> = { 'one-time': '일회성 상품', subscription: '구독', unknown: '종류 미확인' };
const GUARD_METRICS: MetricKey[] = ['refund_rate', 'crash_free_rate', 'retention_d1', 'conversion_rate'];

export function PricingSection(props: SectionProps) {
  const { state, growth, projectId, reload } = props;
  const act = useGrowthAction(reload);
  const [creating, setCreating] = useState(false);
  const mandates = growth.mandates.filter(item => item.projectId === projectId && ['proposed', 'active'].includes(item.status) && (item.actions.includes('pricing-proposal') || item.actions.includes('pricing-change')));
  const policy = growth.policies.find(item => item.projectId === projectId);
  const changes = growth.pricing.filter(item => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return <Card title="가격 변경" icon={Tags} actions={<button className="btn btn--sm btn--primary" disabled={!mandates.length} title={mandates.length ? undefined : '가격 제안 또는 가격 변경을 포함한 위임이 필요합니다.'} onClick={() => setCreating(true)}><Plus size={14} />가격 제안</button>}>
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>가격은 위임의 가격 범위(상품·지역·최저/최고·1회 변화 폭·간격) 안에서만 바꾸며, 고객경험 보호 지표 기준선이 있어야 합니다. 관찰 중 보호 지표가 나빠지거나 확인할 수 없으면 원래 가격으로 되돌립니다. 기존 구독자 가격 인상은 고지·동의 확인 후 운영자 승인이 필요합니다.</p>
      {policy && !policy.allowPricingExperiments && <Notice tone="info">정책에서 가격 실험을 허용하지 않아, 제안은 차단 사유와 함께 기록될 뿐 실행되지 않습니다.</Notice>}
      <ActionFeedback act={act} />
      {changes.length === 0 ? <EmptyState icon={Tags} title="가격 변경 기록이 없습니다" description="가격 제안 위임이 있으면 상품·지역별 가격을 제안할 수 있습니다." />
        : <div className="item-list">{changes.map(change => <PricingRow key={change.id} change={change} projectId={projectId} label={connectionLabel(state, change.connectionId)} act={act} />)}</div>}
    </div>
    {creating && <PricingForm {...props} onClose={() => setCreating(false)} />}
  </Card>;
}

function PricingRow({ change, projectId, label, act }: { change: PricingChange; projectId: string; label: string; act: GrowthAction }) {
  return <div className="item-row" id={`growth-pricing-${change.id}`} tabIndex={-1}>
    <div className="item-row__main stack" style={{ gap: 6 }}>
      <div className="item-row__title row" style={{ gap: 8 }}>
        <Badge tone={STATUS[change.status][1]}>{STATUS[change.status][0]}</Badge>
        <span>{change.productExternalId} · {change.region}</span>
        <span className="small muted">{TYPE[change.productType]} · {label} · {formatDateTime(change.createdAt)}</span>
      </div>
      <div className="small">가격 {formatMicros(change.previousPriceMicros, change.currency)} → <strong>{formatMicros(change.proposedPriceMicros, change.currency)}</strong> · 관찰 {change.observeDays}일</div>
      <div className="small">보호 지표: {change.guardrails.map(g => `${METRIC_LABELS[g.metric]} ${g.direction === 'min' ? '≥' : '≤'} ${g.threshold} (기준선 ${num(change.baseline[g.metric])})`).join(' · ') || '없음'}</div>
      <div className="item-row__meta">{change.approvedAt && `승인 ${formatDateTime(change.approvedAt)}`}{change.appliedAt && ` · 적용 ${formatDateTime(change.appliedAt)}`}{change.decidedAt && ` · 결정 ${formatDateTime(change.decidedAt)}`}{change.runId && ` · 작업 ${change.runId.slice(0, 8)}`}{change.rollbackRunId && ` · 원복 작업 ${change.rollbackRunId.slice(0, 8)}`}</div>
      <ReasonList reasons={change.reasons} />
    </div>
    <div className="item-row__actions">
      {change.status === 'approval_required' && <ReasonAction label="승인" placeholder="고지·동의 확인 내용(필수)" required disabled={!!act.pending} onSubmit={note => act.run('approve-price', { id: change.id, note }, '가격 변경을 승인해 대기열에 넣었습니다.')} />}
      {['applied', 'observing', 'kept'].includes(change.status) && <ReasonAction label="원복" placeholder="원복 사유(선택)" danger disabled={!!act.pending} onSubmit={reason => act.run('rollback-price', { id: change.id, ...(reason ? { reason } : {}) }, '원래 가격으로 되돌리는 작업을 대기열에 넣었습니다.')} />}
      <AskAi projectId={projectId} kind="pricing" id={change.id} label={`가격 변경: ${change.productExternalId} ${change.region}`} record={change} />
    </div>
  </div>;
}

interface GuardInput { metric: MetricKey; direction: Guardrail['direction']; threshold: string }

function PricingForm({ state, growth, projectId, reload, onClose }: SectionProps & { onClose: () => void }) {
  const uid = useId(); const f = (name: string) => `${uid}-${name}`;
  const act = useGrowthAction(reload);
  const mandates = growth.mandates.filter(item => item.projectId === projectId && ['proposed', 'active'].includes(item.status) && (item.actions.includes('pricing-proposal') || item.actions.includes('pricing-change')));
  const [mandateId, setMandateId] = useState(mandates[0]?.id ?? '');
  const mandate = mandates.find(item => item.id === mandateId);
  const [connectionId, setConnectionId] = useState(mandate?.connectionIds[0] ?? '');
  const products = state.resources.filter(item => item.kind === 'product' && item.connectionId === connectionId && item.projectId === projectId);
  const [product, setProduct] = useState('');
  const [region, setRegion] = useState(mandate?.limits.pricing?.regions[0] ?? '');
  const [price, setPrice] = useState(''); const [currency, setCurrency] = useState(''); const [observeDays, setObserveDays] = useState('');
  const [guards, setGuards] = useState<GuardInput[]>([{ metric: 'refund_rate', direction: 'max', threshold: '' }]);
  const [error, setError] = useState('');
  const update = (index: number, patch: Partial<GuardInput>) => setGuards(current => current.map((guard, i) => i === index ? { ...guard, ...patch } : guard));
  async function submit() {
    const micros = majorToMicros(price);
    if (!price.trim() || micros === null) { setError('제안 가격 형식을 확인하세요.'); return; }
    if (guards.some(guard => guard.threshold.trim() === '' || !Number.isFinite(Number(guard.threshold)))) { setError('보호 지표 기준값을 입력하세요.'); return; }
    setError('');
    const result = await act.run('propose-price', { mandateId, connectionId, productExternalId: product, region: region.trim().toUpperCase(), proposedPriceMicros: micros, observeDays: intInput(observeDays),
      guardrails: guards.map(guard => ({ metric: guard.metric, direction: guard.direction, threshold: Number(guard.threshold) })), ...(currency.trim() ? { currency: currency.trim().toUpperCase() } : {}) },
      '가격 제안을 기록했습니다. 상태와 사유를 확인하세요.');
    if (result) onClose();
  }
  return <Modal title="가격 제안" wide onClose={onClose} footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn btn--primary" disabled={!!act.pending || !mandateId || !connectionId || !product || region.trim().length !== 2 || !observeDays || !guards.length} onClick={() => void submit()}>제안</button></>}>
    <div className="stack">
      <Notice tone="info">위임에 가격 변경이 있고 모든 검사를 통과하면 바로 변경 대기열에 들어갑니다. 가격 제안만 위임했다면 기록만 합니다.</Notice>
      <div className="grid grid--split">
        <Field label="위임" required htmlFor={f('m')}><select id={f('m')} className="select" value={mandateId} onChange={event => { const next = mandates.find(item => item.id === event.target.value); setMandateId(event.target.value); setConnectionId(next?.connectionIds[0] ?? ''); setProduct(''); }}>
          {mandates.map(item => <option key={item.id} value={item.id}>{item.actions.includes('pricing-change') ? '가격 변경' : '가격 제안만'} · ~{formatDateTime(item.endsAt)}</option>)}</select></Field>
        <Field label="스토어 계정" required htmlFor={f('c')}><select id={f('c')} className="select" value={connectionId} onChange={event => { setConnectionId(event.target.value); setProduct(''); }}>
          {(mandate?.connectionIds ?? []).map(id => <option key={id} value={id}>{connectionLabel(state, id)}</option>)}</select></Field>
        <Field label="상품" required htmlFor={f('p')} hint={products.length ? undefined : '이 계정에서 동기화한 이 프로젝트 상품이 없습니다. 수익화 화면에서 상품을 동기화하세요.'}><select id={f('p')} className="select" value={product} onChange={event => setProduct(event.target.value)}>
          <option value="">선택</option>{products.map(item => <option key={item.id} value={item.externalId}>{item.name} ({item.externalId})</option>)}</select></Field>
        <Field label="지역(2자리)" required htmlFor={f('r')} hint={mandate?.limits.pricing ? `위임 허용 지역: ${mandate.limits.pricing.regions.join(', ')}` : '위임에 가격 변경 범위가 없습니다.'}><input id={f('r')} className="input" maxLength={2} value={region} onChange={event => setRegion(event.target.value)} /></Field>
        <Field label="제안 가격" required htmlFor={f('price')} hint="주 단위(예: 1.99)"><input id={f('price')} className="input" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} /></Field>
        <Field label="통화" htmlFor={f('cur')} hint="비우면 상품의 기존 통화"><input id={f('cur')} className="input" maxLength={3} value={currency} onChange={event => setCurrency(event.target.value)} /></Field>
        <Field label="변경 후 관찰(일)" required htmlFor={f('d')} hint="1~90일"><input id={f('d')} className="input" type="number" min={1} max={90} value={observeDays} onChange={event => setObserveDays(event.target.value)} /></Field>
      </div>
      <fieldset className="action-group"><legend className="action-group__title">고객경험 보호 지표(1개 이상, 기준선 데이터 필요)</legend>
        {guards.map((guard, index) => <div key={index} className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="지표" htmlFor={f(`gm${index}`)}><select id={f(`gm${index}`)} className="select" value={guard.metric} onChange={event => update(index, { metric: event.target.value as MetricKey })}>{GUARD_METRICS.map(key => <option key={key} value={key}>{METRIC_LABELS[key]}</option>)}</select></Field>
          <Field label="방향" htmlFor={f(`gd${index}`)}><select id={f(`gd${index}`)} className="select" value={guard.direction} onChange={event => update(index, { direction: event.target.value as Guardrail['direction'] })}><option value="max">이 값 위면 위반</option><option value="min">이 값 아래면 위반</option></select></Field>
          <Field label="기준값(비율)" htmlFor={f(`gt${index}`)} hint="예: 환불률 0.05"><input id={f(`gt${index}`)} className="input" type="number" step="any" value={guard.threshold} onChange={event => update(index, { threshold: event.target.value })} /></Field>
          {guards.length > 1 && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setGuards(current => current.filter((_, i) => i !== index))}>삭제</button>}
        </div>)}
        {guards.length < GUARD_METRICS.length && <button type="button" className="btn btn--sm" onClick={() => setGuards(current => [...current, { metric: GUARD_METRICS.find(key => !current.some(guard => guard.metric === key)) ?? 'crash_free_rate', direction: 'min', threshold: '' }])}>보호 지표 추가</button>}
      </fieldset>
      {error && <Notice tone="error">{error}</Notice>}
      <ActionFeedback act={act} />
    </div>
  </Modal>;
}
