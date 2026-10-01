// 실험: 가설·대조군·arm·중지 규칙 사전 등록, 시작·중지, 결정 이력 drill-down.
import { useId, useMemo, useState } from 'react';
import { FlaskConical, Play, Plus, Lock } from 'lucide-react';
import type { DecisionOutcome, DecisionSnapshot, Experiment, ExperimentKind, GrowthDecisionCursor, Guardrail, MetricKey, RevenueBasis, StoppingRule } from '../../../../../packages/growth/types';
import { api } from '../../api';
import { formatDateTime, formatMicros, providerLabel } from '../../format';
import { Badge, Card, EmptyState, Field, Modal, Notice } from '../../components/ui';
import {
  ActionFeedback, AskAi, BASIS_LABELS, Dl, EXPERIMENT_STATUS, METRICS, METRIC_LABELS, ReasonAction, ReasonList, RUNNING_EXPERIMENTS, StatusBadge,
  connectionLabel, intInput, localToIso, num, pct, percentInput, useGrowthAction, type GrowthAction, type SectionProps, type Tone,
} from './shared';
import { QualityFlags } from './Overview';

const KIND_LABELS: Record<ExperimentKind, string> = { ads: '광고', monetization: '수익화', pricing: '가격', product: '제품' };
const OUTCOME: Record<DecisionOutcome, [string, Tone]> = {
  continue: ['계속 관찰', 'progress'], winner: ['승자', 'ok'], no_effect: ['효과 없음', 'neutral'], inconclusive: ['결론 없음', 'neutral'],
  stop_guardrail: ['보호 지표 위반 중지', 'error'], stop_loss: ['손실 한도 중지', 'error'], blocked: ['판단 보류', 'warn'], invalidated: ['무효화', 'warn'], observational_only: ['관찰 비교(판정 없음)', 'info'],
};
const DECISION_KIND: Record<DecisionSnapshot['kind'], string> = { quality_check: '품질 점검', efficacy: '효능 평가', guardrail: '보호 지표', invalidation: '무효화' };

export function ExperimentsSection(props: SectionProps) {
  const { growth, projectId, reload } = props;
  const act = useGrowthAction(reload);
  const [creating, setCreating] = useState(false);
  const experiments = growth.experiments.filter(item => item.projectId === projectId).sort((a, b) => Number(RUNNING_EXPERIMENTS.includes(b.status)) - Number(RUNNING_EXPERIMENTS.includes(a.status)) || b.createdAt.localeCompare(a.createdAt));
  const mandates = growth.mandates.filter(item => item.projectId === projectId && ['proposed', 'active'].includes(item.status));
  return <Card title="실험" icon={FlaskConical} actions={<button className="btn btn--sm btn--primary" disabled={!mandates.length} title={mandates.length ? undefined : '진행 중인 위임이 있어야 실험을 준비할 수 있습니다.'} onClick={() => setCreating(true)}><Plus size={14} />실험 준비</button>}>
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>실험은 하나의 검증 가능한 가설과 대조군을 가집니다. 사전 등록 뒤에는 가설·주 지표·중지 규칙을 바꿀 수 없고, 바꾸려면 새 실험을 만들어야 합니다.</p>
      <ActionFeedback act={act} />
      {experiments.length === 0 ? <EmptyState icon={FlaskConical} title="실험이 없습니다" description={mandates.length ? '실험 준비로 가설과 대조군을 등록하세요.' : '먼저 개요·위임에서 위임을 만들거나 확정하세요.'} />
        : <div className="item-list">{experiments.map(experiment => <ExperimentRow key={experiment.id} {...props} experiment={experiment} act={act} />)}</div>}
    </div>
    {creating && <ExperimentForm {...props} onClose={() => setCreating(false)} />}
  </Card>;
}

function stoppingText(stopping: StoppingRule): string {
  return stopping.kind === 'fixed_horizon' ? '고정 기간 — 종료 시점에 한 번 판정' : `순차 검정(${stopping.spending === 'pocock' ? 'Pocock' : "O'Brien–Fleming"}) — look ${stopping.looks.map(look => formatDateTime(look)).join(', ')}`;
}

function ExperimentRow({ state, growth, projectId, experiment, act }: SectionProps & { experiment: Experiment; act: GrowthAction }) {
  const [registering, setRegistering] = useState(false);
  const history = useDecisionHistory(projectId, experiment.id, growth.decisions, Boolean(growth.decisionsNext));
  const decisions = history.decisions;
  const observational = experiment.design === 'observational_comparison';
  const h = experiment.hypothesis;
  const label = `${KIND_LABELS[experiment.kind]} 실험: ${h.change.slice(0, 60)}`;
  return <div className="item-row" id={`growth-experiment-${experiment.id}`} tabIndex={-1}>
    <div className="item-row__main stack" style={{ gap: 8 }}>
      <div className="item-row__title row" style={{ gap: 8 }}>
        <StatusBadge map={EXPERIMENT_STATUS} value={experiment.status} />
        <span>{KIND_LABELS[experiment.kind]} · {h.change}</span>
        {observational ? <Badge tone="warn">관찰 비교 — A/B 아님, 자동 확대 없음</Badge> : <Badge tone="info">공급자 native A/B</Badge>}
        {experiment.registeredAt && <span className="small muted"><Lock size={11} aria-hidden /> 사전 등록 {formatDateTime(experiment.registeredAt)}</span>}
      </div>
      {experiment.statusReason && <div className="small">{experiment.statusReason}</div>}
      {!observational && experiment.provider === 'google-ads' && <div className="small muted">Google Ads App 캠페인 실험은 promote가 없어, 승자는 위임 한도 안의 예산 단계 증액으로만 확대합니다.</div>}
      <Dl items={[
        ['계정', `${connectionLabel(state, experiment.connectionId)} (${providerLabel(experiment.provider)})${experiment.providerExperimentId ? ` · 공급자 실험 ${experiment.providerExperimentId}` : ''}`],
        ['대상 집단', h.cohort],
        ['주 지표', `${METRIC_LABELS[h.primaryMetric]}${h.revenueBasis ? ` (분자: ${BASIS_LABELS[h.revenueBasis]})` : ''} · 최소 실질 효과 ${pct(h.minimumEffect)}`],
        ['보호 지표', h.guardrails.length ? h.guardrails.map(g => `${METRIC_LABELS[g.metric]} ${g.direction === 'min' ? '≥' : '≤'} ${g.threshold}`).join(', ') : '없음'],
        ['기간·표본', `최소 ${h.minDurationDays}일 · 최대 ${h.maxDurationDays}일 · 귀속 창 ${h.attributionWindowDays}일 · arm별 최소 ${h.minSamplePerArm}`],
        ['중지 규칙', stoppingText(experiment.stopping)],
        ['통계', `α ${experiment.alpha} · ${experiment.multiplicity === 'holm' ? 'Holm' : 'BH'} 보정 · 정책 v${experiment.policyVersion} · look ${experiment.looksUsed}회 사용`],
        ['arm', experiment.arms.map(arm => `${arm.role === 'control' ? '대조군' : '실험군'} ${arm.label}${arm.campaignId ? ` [캠페인 ${arm.campaignId}]` : ''}${arm.externalId ? ` [${arm.externalId}]` : ''}${arm.trafficShare !== undefined ? ` ${pct(arm.trafficShare, 0)}` : ''}`).join(' / ')],
        (experiment.startedAt || experiment.horizonAt) && ['시작·판정 시점', `${formatDateTime(experiment.startedAt)} → ${formatDateTime(experiment.horizonAt)}`],
        experiment.runIds.length > 0 && ['외부 작업', `${experiment.runIds.length}건 (이력 화면에서 확인)`],
        experiment.supersedes && ['이전 실험', experiment.supersedes.slice(0, 8)],
        experiment.providerConfig && ['공급자 설정', <code key="c" className="small" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(experiment.providerConfig)}</code>],
      ]} />
      {registering && <Notice tone="warn" title="사전 등록하면 되돌릴 수 없습니다" action={<div className="row" style={{ gap: 6 }}>
        <button className="btn btn--sm btn--primary" disabled={!!act.pending} onClick={() => void act.run('register-experiment', { id: experiment.id, version: experiment.version }, '실험을 사전 등록했습니다. 가설·주 지표·중지 규칙이 고정되었습니다.').then(() => setRegistering(false))}>등록</button>
        <button className="btn btn--sm btn--ghost" onClick={() => setRegistering(false)}>취소</button></div>}>
        가설·주 지표·보호 지표·중지 규칙이 고정되고, 이후 변경은 새 실험으로만 가능합니다. 최대 관찰 기간과 귀속 창이 위임 기간 안에 끝나야 합니다.
      </Notice>}
      {decisions.length > 0 && <details><summary>결정 이력 {decisions.length}건{history.hasMore ? ' 이상' : ''} · 최근 {OUTCOME[decisions[0]!.outcome][0]}</summary>
        <div className="stack" style={{ marginTop: 8 }}>{decisions.map(decision => <DecisionDetail key={decision.id} decision={decision} experiment={experiment} />)}
          <DecisionMore history={history} label="이전 결정 더 보기" /></div>
      </details>}
      {decisions.length === 0 && <DecisionMore history={history} label="이전 결정 이력 불러오기" />}
    </div>
    <div className="item-row__actions">
      {experiment.status === 'draft' && !registering && <button className="btn btn--sm btn--primary" disabled={!!act.pending} onClick={() => setRegistering(true)}><Lock size={14} />사전 등록</button>}
      {experiment.status === 'action_required' && <ReasonAction label="확인 후 재개" placeholder="공급자에서 확인한 내용(필수)" required disabled={!!act.pending}
        onSubmit={note => act.run('resume-experiment', { id: experiment.id, note }, '운영자 확인 후 실험 관찰을 재개했습니다.')} />}
      {experiment.status === 'scheduled' && <button className="btn btn--sm btn--primary" disabled={!!act.pending} onClick={() => void act.run('start-experiment', { id: experiment.id }, observational ? '관찰 비교를 시작했습니다.' : '실험 시작을 요청했습니다. 공급자 작업은 내구성 큐를 거칩니다.')}><Play size={14} />시작</button>}
      {!['completed', 'inconclusive', 'stopped', 'failed'].includes(experiment.status) && <ReasonAction label="중지" placeholder="중지 사유(선택)" danger disabled={!!act.pending}
        onSubmit={reason => act.run('stop-experiment', { id: experiment.id, ...(reason ? { reason } : {}) }, '실험을 중지했습니다.')} />}
      <AskAi projectId={projectId} kind="experiment" id={experiment.id} label={label} record={experiment} />
    </div>
  </div>;
}

const newestFirst = (a: DecisionSnapshot, b: DecisionSnapshot) => a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.id === b.id ? 0 : a.id < b.id ? 1 : -1;

/**
 * 서버 상태의 최근 결정(상한 있음)에 이 실험의 이전 결정을 keyset 페이지로 이어 붙인다. 불러온 시점의 최근 목록도 함께
 * 보관해, 이후 폴링에서 다른 실험 결정으로 최근 범위가 밀려도 이어 본 구간과 사이가 비지 않게 한다.
 */
function useDecisionHistory(projectId: string, experimentId: string, recent: DecisionSnapshot[], truncated: boolean) {
  const [kept, setKept] = useState<DecisionSnapshot[]>([]);
  const [next, setNext] = useState<GrowthDecisionCursor | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const decisions = useMemo(() => {
    const byId = new Map<string, DecisionSnapshot>();
    for (const item of [...kept, ...recent]) if (item.experimentId === experimentId) byId.set(item.id, item);
    return [...byId.values()].sort(newestFirst);
  }, [kept, recent, experimentId]);
  const load = async () => {
    const last = decisions.at(-1);
    setPending(true); setError('');
    const result = await api.growthDecisions({ projectId, experimentId, ...(last ? { before: { at: last.at, id: last.id } } : {}) });
    setPending(false);
    if (!result.ok) { setError(result.error.message); return; }
    setKept(current => [...current, ...decisions, ...result.data.decisions]);
    setNext(result.data.next);
  };
  // 아직 이어 보지 않았으면 서버 상태가 상한으로 잘렸는지로, 이어 본 뒤에는 마지막 페이지 커서로 판단한다.
  return { decisions, hasMore: next === undefined ? truncated : next !== null, pending, error, load };
}

function DecisionMore({ history, label }: { history: ReturnType<typeof useDecisionHistory>; label: string }) {
  if (!history.hasMore && !history.error) return null;
  return <div className="stack" style={{ gap: 6 }}>
    {history.error && <Notice tone="error">{history.error}</Notice>}
    {history.hasMore && <button type="button" className="btn btn--sm btn--ghost" disabled={history.pending} onClick={() => void history.load()}>{history.pending ? '불러오는 중…' : label}</button>}
  </div>;
}

function DecisionDetail({ decision, experiment }: { decision: DecisionSnapshot; experiment: Experiment }) {
  const armLabel = (id: string) => experiment.arms.find(arm => arm.id === id)?.label ?? id;
  return <div className="action-group">
    <div className="row" style={{ gap: 8 }}>
      <Badge tone={OUTCOME[decision.outcome][1]}>{OUTCOME[decision.outcome][0]}</Badge>
      <strong>{DECISION_KIND[decision.kind]} · look {decision.look}</strong>
      <span className="small muted">{formatDateTime(decision.at)} · 실험 v{decision.experimentVersion} · 정책 v{decision.policyVersion} · 알고리즘 {decision.algorithmVersion}{decision.agentTaskId ? ` · AI 작업 ${decision.agentTaskId.slice(0, 8)}` : ''}</span>
    </div>
    {decision.winnerArmId && <div className="small">승자: <strong>{armLabel(decision.winnerArmId)}</strong></div>}
    <ReasonList reasons={decision.reasons} />
    <QualityFlags quality={decision.quality} />
    {decision.guardrailViolations.length > 0 && <Notice tone="error" title="보호 지표 위반"><ReasonList reasons={decision.guardrailViolations} /></Notice>}
    <div className="table__scroll"><table className="table">
      <caption className="sr-caption">arm별 지표</caption>
      <thead><tr><th>arm</th><th>표본</th><th>성공/시행</th><th>추정값</th><th>지출</th><th>수익</th></tr></thead>
      <tbody>{decision.arms.map(arm => <tr key={arm.armId}><td>{armLabel(arm.armId)}</td><td>{arm.samples}</td><td>{arm.successes !== undefined ? `${arm.successes}/${arm.trials ?? '—'}` : '—'}</td><td>{num(arm.estimate)}</td>
        <td>{arm.spendMicros && arm.currency ? formatMicros(arm.spendMicros, arm.currency) : '—'}</td><td>{arm.revenueMicros && arm.currency ? formatMicros(arm.revenueMicros, arm.currency) : '—'}</td></tr>)}</tbody>
    </table></div>
    {decision.comparisons.length > 0 && <div className="table__scroll"><table className="table">
      <caption className="sr-caption">대조군 대비 비교</caption>
      <thead><tr><th>실험군</th><th>효과</th><th>신뢰구간</th><th>p</th><th>보정 p</th><th>경계 p</th><th>유의</th></tr></thead>
      <tbody>{decision.comparisons.map(item => <tr key={item.armId}><td>{armLabel(item.armId)}</td><td>{pct(item.effect, 2)}</td><td>{item.ciLow === null || item.ciHigh === null ? '—' : `${pct(item.ciLow, 2)} ~ ${pct(item.ciHigh, 2)}`}</td>
        <td>{num(item.pValue)}</td><td>{num(item.adjustedP)}</td><td>{num(item.boundaryP)}</td><td>{item.significant ? <Badge tone="ok">유의</Badge> : <Badge tone="neutral">아님</Badge>}</td></tr>)}</tbody>
    </table></div>}
    <span className="small muted">근거 사실 {decision.factIds.length}건 · 위임 {decision.mandateId.slice(0, 8)}</span>
  </div>;
}

interface ArmInput { role: 'control' | 'treatment'; label: string; campaignId: string; externalId: string; share: string }
interface GuardInput { metric: MetricKey; direction: Guardrail['direction']; threshold: string }

function ExperimentForm({ state, growth, projectId, reload, onClose }: SectionProps & { onClose: () => void }) {
  const uid = useId(); const f = (name: string) => `${uid}-${name}`;
  const act = useGrowthAction(reload);
  const mandates = growth.mandates.filter(item => item.projectId === projectId && ['proposed', 'active'].includes(item.status));
  const policy = growth.policies.find(item => item.projectId === projectId);
  const [mandateId, setMandateId] = useState(mandates[0]?.id ?? '');
  const mandate = mandates.find(item => item.id === mandateId);
  const [connectionId, setConnectionId] = useState(mandate?.connectionIds[0] ?? '');
  const [kind, setKind] = useState<ExperimentKind>('ads');
  const [design, setDesign] = useState<Experiment['design']>('native_ab');
  const [providerExperimentId, setProviderExperimentId] = useState('');
  const [change, setChange] = useState(''); const [cohort, setCohort] = useState('');
  const [metric, setMetric] = useState<MetricKey | ''>(''); const [basis, setBasis] = useState<RevenueBasis | ''>('');
  const [effect, setEffect] = useState(''); const [attrWindow, setAttrWindow] = useState(''); const [minDays, setMinDays] = useState(''); const [maxDays, setMaxDays] = useState(''); const [minSample, setMinSample] = useState('');
  const [guards, setGuards] = useState<GuardInput[]>([]);
  const [arms, setArms] = useState<ArmInput[]>([{ role: 'control', label: '대조군', campaignId: '', externalId: '', share: '' }, { role: 'treatment', label: '실험군 A', campaignId: '', externalId: '', share: '' }]);
  const [stopping, setStopping] = useState<StoppingRule['kind']>(policy?.defaultStopping ?? 'fixed_horizon');
  const [looks, setLooks] = useState<string[]>(['', '']);
  const [spending, setSpending] = useState<'obrien_fleming' | 'pocock'>('obrien_fleming');
  const [providerConfig, setProviderConfig] = useState('');
  const [configError, setConfigError] = useState('');
  const provider = state.connections.find(item => item.id === connectionId)?.provider;
  const updateArm = (index: number, patch: Partial<ArmInput>) => setArms(current => current.map((arm, i) => i === index ? { ...arm, ...patch } : arm));
  const updateGuard = (index: number, patch: Partial<GuardInput>) => setGuards(current => current.map((guard, i) => i === index ? { ...guard, ...patch } : guard));
  async function submit() {
    let config: Record<string, unknown> | undefined;
    if (providerConfig.trim()) {
      try { const parsed: unknown = JSON.parse(providerConfig); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); config = parsed as Record<string, unknown>; }
      catch { setConfigError('공급자 설정은 JSON 객체여야 합니다.'); return; }
    }
    setConfigError('');
    const payload = {
      ...(config ? { providerConfig: config } : {}),
      mandateId, kind, connectionId, design, ...(providerExperimentId.trim() ? { providerExperimentId: providerExperimentId.trim() } : {}),
      hypothesis: { change: change.trim(), cohort: cohort.trim(), primaryMetric: metric, ...(basis ? { revenueBasis: basis } : {}), minimumEffect: percentInput(effect),
        attributionWindowDays: intInput(attrWindow), minDurationDays: intInput(minDays), maxDurationDays: intInput(maxDays), minSamplePerArm: intInput(minSample),
        guardrails: guards.map(guard => ({ metric: guard.metric, direction: guard.direction, threshold: Number(guard.threshold) })) },
      arms: arms.map(arm => ({ role: arm.role, label: arm.label.trim(), ...(arm.campaignId.trim() ? { campaignId: arm.campaignId.trim() } : {}), ...(arm.externalId.trim() ? { externalId: arm.externalId.trim() } : {}), ...(arm.share ? { trafficShare: percentInput(arm.share) } : {}) })),
      stopping: stopping === 'sequential' ? { kind: 'sequential', looks: looks.map(localToIso).filter(Boolean), spending } : { kind: 'fixed_horizon' },
    };
    const result = await act.run('create-experiment', payload, '실험 초안을 만들었습니다. 내용을 확인한 뒤 사전 등록하세요.');
    if (result) onClose();
  }
  return <Modal title="실험 준비" wide onClose={onClose} footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn btn--primary" disabled={!!act.pending || !mandateId || !connectionId || !change.trim() || !cohort.trim() || !metric} onClick={() => void submit()}>초안 만들기</button></>}>
    <div className="stack">
      <Notice tone="info">초안은 외부에 아무것도 만들지 않습니다. 사전 등록과 시작은 목록에서 따로 진행하며, 공급자가 무작위 배정을 보장하지 않으면 서버가 관찰 비교로 기록합니다.</Notice>
      <div className="grid grid--split">
        <Field label="위임" required htmlFor={f('mandate')}><select id={f('mandate')} className="select" value={mandateId} onChange={event => { setMandateId(event.target.value); setConnectionId(mandates.find(item => item.id === event.target.value)?.connectionIds[0] ?? ''); }}>
          {mandates.map(item => <option key={item.id} value={item.id}>{item.status === 'proposed' ? '[확정 대기] ' : ''}{formatDateTime(item.startsAt)} ~ {formatDateTime(item.endsAt)}</option>)}</select></Field>
        <Field label="실험 계정" required htmlFor={f('conn')} hint="위임에 포함된 계정만 선택할 수 있습니다."><select id={f('conn')} className="select" value={connectionId} onChange={event => setConnectionId(event.target.value)}>
          {(mandate?.connectionIds ?? []).map(id => <option key={id} value={id}>{connectionLabel(state, id)}</option>)}</select></Field>
        <Field label="종류" required htmlFor={f('kind')}><select id={f('kind')} className="select" value={kind} onChange={event => setKind(event.target.value as ExperimentKind)}>{(Object.keys(KIND_LABELS) as ExperimentKind[]).map(key => <option key={key} value={key}>{KIND_LABELS[key]}</option>)}</select></Field>
        <Field label="설계" required htmlFor={f('design')} hint={design === 'observational_comparison' ? '관찰 비교는 A/B가 아니며 승자 자동 확대를 하지 않습니다.' : '공급자가 native 실험을 지원할 때만 A/B로 기록됩니다.'}>
          <select id={f('design')} className="select" value={design} onChange={event => setDesign(event.target.value as Experiment['design'])}><option value="native_ab">공급자 native A/B</option><option value="observational_comparison">관찰 비교(A/B 아님)</option></select></Field>
        <Field label="기존 공급자 실험 ID" htmlFor={f('pid')} hint="이미 공급자에서 만든 실험을 관찰할 때만 입력"><input id={f('pid')} className="input" value={providerExperimentId} onChange={event => setProviderExperimentId(event.target.value)} /></Field>
      </div>
      {provider === 'applovin-max' && <Field label="MAX 실험 설정(JSON, 선택)" htmlFor={f('pconf')} hint="adNetworkSettings·frequencyCappingSettings·bidFloors 등 MAX 실험 그룹 설정. 비밀값은 넣을 수 없습니다.">
        <textarea id={f('pconf')} className="textarea mono" rows={4} value={providerConfig} onChange={event => setProviderConfig(event.target.value)} placeholder='{"bidFloors": []}' /></Field>}
      {configError && <Notice tone="error">{configError}</Notice>}
      <fieldset className="action-group"><legend className="action-group__title">가설 (사전 등록 후 고정)</legend>
        <Field label="주 변경" required htmlFor={f('change')}><input id={f('change')} className="input" maxLength={500} value={change} onChange={event => setChange(event.target.value)} placeholder="예: 새 동영상 소재로 교체" /></Field>
        <Field label="대상 집단" required htmlFor={f('cohort')}><input id={f('cohort')} className="input" maxLength={300} value={cohort} onChange={event => setCohort(event.target.value)} placeholder="예: KR Android 신규 설치" /></Field>
        <div className="grid grid--split">
          <Field label="주 지표" required htmlFor={f('metric')}><select id={f('metric')} className="select" value={metric} onChange={event => setMetric(event.target.value as MetricKey)}><option value="">선택</option>{METRICS.map(key => <option key={key} value={key}>{METRIC_LABELS[key]}</option>)}</select></Field>
          <Field label="수익 기준" htmlFor={f('basis')} hint="ROAS·수익 지표일 때 분자 기준"><select id={f('basis')} className="select" value={basis} onChange={event => setBasis(event.target.value as RevenueBasis | '')}><option value="">없음</option>{(Object.keys(BASIS_LABELS) as RevenueBasis[]).map(key => <option key={key} value={key}>{BASIS_LABELS[key]}</option>)}</select></Field>
          <Field label="최소 실질 효과(%)" required htmlFor={f('effect')}><input id={f('effect')} className="input" type="number" step="0.1" value={effect} onChange={event => setEffect(event.target.value)} /></Field>
          <Field label="귀속 창(일)" required htmlFor={f('window')}><input id={f('window')} className="input" type="number" min={0} value={attrWindow} onChange={event => setAttrWindow(event.target.value)} /></Field>
          <Field label="최소 관찰 기간(일)" required htmlFor={f('min')}><input id={f('min')} className="input" type="number" min={1} value={minDays} onChange={event => setMinDays(event.target.value)} /></Field>
          <Field label="최대 관찰 기간(일)" required htmlFor={f('max')}><input id={f('max')} className="input" type="number" min={1} value={maxDays} onChange={event => setMaxDays(event.target.value)} /></Field>
          <Field label="arm별 최소 표본" required htmlFor={f('sample')}><input id={f('sample')} className="input" type="number" min={1} value={minSample} onChange={event => setMinSample(event.target.value)} /></Field>
        </div>
      </fieldset>
      <fieldset className="action-group"><legend className="action-group__title">보호 지표(guardrail)</legend>
        {guards.map((guard, index) => <div key={index} className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="지표" htmlFor={f(`gm${index}`)}><select id={f(`gm${index}`)} className="select" value={guard.metric} onChange={event => updateGuard(index, { metric: event.target.value as MetricKey })}>{METRICS.map(key => <option key={key} value={key}>{METRIC_LABELS[key]}</option>)}</select></Field>
          <Field label="방향" htmlFor={f(`gd${index}`)}><select id={f(`gd${index}`)} className="select" value={guard.direction} onChange={event => updateGuard(index, { direction: event.target.value as Guardrail['direction'] })}><option value="min">이 값 아래면 위반</option><option value="max">이 값 위면 위반</option></select></Field>
          <Field label="기준값" htmlFor={f(`gt${index}`)}><input id={f(`gt${index}`)} className="input" type="number" step="any" value={guard.threshold} onChange={event => updateGuard(index, { threshold: event.target.value })} /></Field>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setGuards(current => current.filter((_, i) => i !== index))}>삭제</button>
        </div>)}
        <button type="button" className="btn btn--sm" onClick={() => setGuards(current => [...current, { metric: 'crash_free_rate', direction: 'min', threshold: '' }])}>보호 지표 추가</button>
      </fieldset>
      <fieldset className="action-group"><legend className="action-group__title">arm (대조군 정확히 1개 + 실험군 1~5개)</legend>
        {arms.map((arm, index) => <div key={index} className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="역할" htmlFor={f(`ar${index}`)}><select id={f(`ar${index}`)} className="select" value={arm.role} onChange={event => updateArm(index, { role: event.target.value as ArmInput['role'] })}><option value="control">대조군</option><option value="treatment">실험군</option></select></Field>
          <Field label="이름" htmlFor={f(`al${index}`)}><input id={f(`al${index}`)} className="input" value={arm.label} onChange={event => updateArm(index, { label: event.target.value })} /></Field>
          <Field label="캠페인 ID" htmlFor={f(`ac${index}`)}><input id={f(`ac${index}`)} className="input" value={arm.campaignId} onChange={event => updateArm(index, { campaignId: event.target.value })} /></Field>
          <Field label="공급자 arm/그룹 ID" htmlFor={f(`ae${index}`)}><input id={f(`ae${index}`)} className="input" value={arm.externalId} onChange={event => updateArm(index, { externalId: event.target.value })} /></Field>
          <Field label="트래픽(%)" htmlFor={f(`as${index}`)}><input id={f(`as${index}`)} className="input" style={{ width: 80 }} type="number" min={1} max={99} value={arm.share} onChange={event => updateArm(index, { share: event.target.value })} /></Field>
          {arms.length > 2 && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setArms(current => current.filter((_, i) => i !== index))}>삭제</button>}
        </div>)}
        {arms.length < 6 && <button type="button" className="btn btn--sm" onClick={() => setArms(current => [...current, { role: 'treatment', label: `실험군 ${String.fromCharCode(64 + current.length)}`, campaignId: '', externalId: '', share: '' }])}>실험군 추가</button>}
      </fieldset>
      <fieldset className="action-group"><legend className="action-group__title">중지 규칙 (사전 등록 후 고정)</legend>
        <Field label="규칙" htmlFor={f('stop')} hint={policy ? `정책 기본값: ${policy.defaultStopping === 'sequential' ? '순차 검정' : '고정 기간'}` : undefined}>
          <select id={f('stop')} className="select" value={stopping} onChange={event => setStopping(event.target.value as StoppingRule['kind'])}><option value="fixed_horizon">고정 기간 — 종료 시점 1회 판정</option><option value="sequential">순차 검정 — 사전 등록 look마다 판정</option></select></Field>
        {stopping === 'sequential' && <>
          <Field label="alpha-spending" htmlFor={f('spend')}><select id={f('spend')} className="select" value={spending} onChange={event => setSpending(event.target.value as 'obrien_fleming' | 'pocock')}><option value="obrien_fleming">O&apos;Brien–Fleming(초기 판정에 엄격)</option><option value="pocock">Pocock(look마다 같은 경계)</option></select></Field>
          {looks.map((look, index) => <div key={index} className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={`look ${index + 1} 시각`} htmlFor={f(`look${index}`)}><input id={f(`look${index}`)} className="input" type="datetime-local" value={look} onChange={event => setLooks(current => current.map((item, i) => i === index ? event.target.value : item))} /></Field>
            {looks.length > 2 && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setLooks(current => current.filter((_, i) => i !== index))}>삭제</button>}
          </div>)}
          {looks.length < 10 && <button type="button" className="btn btn--sm" onClick={() => setLooks(current => [...current, ''])}>look 추가</button>}
          <span className="field__hint">2~10개, 증가 순서. 최소 관찰 기간 이후·최대 기간 이전이어야 등록할 수 있습니다.</span>
        </>}
      </fieldset>
      <ActionFeedback act={act} />
    </div>
  </Modal>;
}
