// 위임(OperationMandate) 목록·확정·중지·지금 실행과 화면 양식 위임. 양식은 검토 요약을 본 뒤에만 확정한다.
import { useId, useState } from 'react';
import { ClipboardList, Play, Plus, ShieldCheck } from 'lucide-react';
import { MANDATE_ACTIONS, WRITE_ACTIONS, type MandateAction, type OperationMandate, type RevenueBasis } from '../../../../../packages/growth/types';
import { formatDateTime, formatMicros, majorToMicros } from '../../format';
import { Badge, Card, EmptyState, Field, Modal, Notice } from '../../components/ui';
import {
  ACTION_LABELS, ActionFeedback, AskAi, BASIS_LABELS, Dl, MANDATE_STATUS, ReasonAction, ReasonList, StatusBadge,
  connectionLabel, intInput, localToIso, pct, percentInput, useGrowthAction, type SectionProps,
} from './shared';

const SOURCE_LABELS: Record<OperationMandate['origin']['source'], string> = { chat: 'AI 대화 제안', 'screen-button': '화면 AI 요청', form: '화면 양식' };

export function MandatesCard(props: SectionProps) {
  const { state, growth, projectId, reload } = props;
  const act = useGrowthAction(reload);
  const [creating, setCreating] = useState(false);
  const policy = growth.policies.find(item => item.projectId === projectId);
  const order: OperationMandate['status'][] = ['proposed', 'active', 'stopped', 'expired'];
  const mandates = growth.mandates.filter(item => item.projectId === projectId).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.createdAt.localeCompare(a.createdAt));
  return <Card title="운영 위임" icon={ClipboardList} actions={<button className="btn btn--sm btn--primary" disabled={!policy} title={policy ? undefined : '통계·신선도 정책을 먼저 저장하세요.'} onClick={() => setCreating(true)}><Plus size={14} />새 위임</button>}>
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>주기 작업은 확정한 위임의 계정·동작·기간·한도 안에서만 실행됩니다. AI 대화를 클리어해도 위임은 멈추지 않으므로 끝내려면 여기서 중지하세요.</p>
      {!policy && <Notice tone="info">위임을 만들기 전에 아래 통계·신선도 정책을 저장하세요.</Notice>}
      <ActionFeedback act={act} />
      {mandates.length === 0 ? <EmptyState icon={ClipboardList} title="위임이 없습니다" description="AI 대화에서 운영 범위와 기간을 요청하거나, 새 위임 양식으로 직접 확정할 수 있습니다." />
        : <div className="item-list">{mandates.map(mandate => <MandateRow key={mandate.id} {...props} mandate={mandate} act={act} />)}</div>}
    </div>
    {creating && <MandateForm {...props} onClose={() => setCreating(false)} />}
  </Card>;
}

function limitsText(mandate: OperationMandate): Array<[string, string]> {
  const { limits } = mandate;
  const rows: Array<[string, string]> = [
    ['일일 지출 상한', formatMicros(limits.maxDailySpendMicros, limits.currency)],
    ['누적 지출 상한', formatMicros(limits.maxTotalSpendMicros, limits.currency)],
    ['누적 손실 상한', formatMicros(limits.maxLossMicros, limits.currency)],
  ];
  if (mandate.actions.includes('ads-scale') || mandate.actions.includes('ads-rebalance')) rows.push(['1회 예산 변경 폭', pct(limits.maxBudgetStep)], ['예산 변경 간격', `${limits.cooldownHours}시간`]);
  if (limits.campaignStopRoasBelow !== undefined) rows.push(['캠페인 중지 기준', `ROAS ${pct(limits.campaignStopRoasBelow, 0)} 미만`]);
  if (limits.minDecisionSpendMicros !== undefined) rows.push(['판단 최소 광고비', formatMicros(limits.minDecisionSpendMicros, limits.currency)]);
  if (mandate.actions.includes('community-reply')) rows.push(['일일 자동 답글', `${limits.maxDailyReplies}건`]);
  if (limits.pricing) rows.push(['가격 변경 범위', `${limits.pricing.regions.join(', ')} · 1회 ${pct(limits.pricing.maxStep)} · 간격 ${limits.pricing.cooldownHours}시간 · 동시 ${limits.pricing.maxConcurrentExperiments}개 · ${limits.pricing.bounds.map(bound => `${bound.productId} ${formatMicros(bound.floorMicros, bound.currency)}~${formatMicros(bound.ceilingMicros, bound.currency)}`).join(', ')}`]);
  return rows;
}
const windowText = (days: number) => days === 0 ? '공급자 기본 창' : `${days}일`;
function goalsText(mandate: OperationMandate): string {
  const parts: string[] = [];
  if (mandate.goals.roas) parts.push(`ROAS ${pct(mandate.goals.roas.target, 0)} 이상 (분자: ${BASIS_LABELS[mandate.goals.roas.basis]}, 귀속 ${windowText(mandate.goals.roas.windowDays)})`);
  if (mandate.goals.netRoi) parts.push(`순이익 ROI ${pct(mandate.goals.netRoi.target, 0)} 이상 (귀속 ${windowText(mandate.goals.netRoi.windowDays)}, 고정비 제외)`);
  return parts.join(' · ') || '목표 없음(관찰만)';
}

function MandateRow({ state, growth, projectId, mandate, act }: SectionProps & { mandate: OperationMandate; act: ReturnType<typeof useGrowthAction> }) {
  const [reviewed, setReviewed] = useState(false);
  const cycle = growth.cycles.find(item => item.mandateId === mandate.id);
  const overdue = mandate.status === 'active' && Date.parse(mandate.endsAt) <= Date.now();
  const label = `위임 ${formatDateTime(mandate.startsAt)}~${formatDateTime(mandate.endsAt)}`;
  return <div className="item-row" id={`growth-mandate-${mandate.id}`} tabIndex={-1}>
    <div className="item-row__main stack" style={{ gap: 8 }}>
      <div className="item-row__title row" style={{ gap: 8 }}>
        <StatusBadge map={MANDATE_STATUS} value={mandate.status} />
        <span>{formatDateTime(mandate.startsAt)} ~ {formatDateTime(mandate.endsAt)}</span>
        <span className="small muted">{SOURCE_LABELS[mandate.origin.source]} · v{mandate.version} · 정책 v{mandate.policyVersion}</span>
        {overdue && <Badge tone="warn">기간 종료 — 새 외부 변경 없음</Badge>}
      </div>
      {mandate.status === 'proposed' && <Notice tone="warn" title="확정 전 위임안입니다">아래 계정·동작·기간·한도를 확인한 뒤 확정해야 주기 작업이 시작됩니다. 범위를 바꾸려면 새로 요청하세요.</Notice>}
      <blockquote className="small" style={{ margin: 0, paddingLeft: 10, borderLeft: '3px solid var(--border)', whiteSpace: 'pre-wrap' }}>{mandate.origin.requestText}</blockquote>
      <Dl items={[
        ['계정·채널', mandate.connectionIds.map(id => connectionLabel(state, id)).join(', ')],
        ['허용 동작', <span key="a">{mandate.actions.map(action => <span key={action} className={`tag${WRITE_ACTIONS.includes(action) ? ' tag--bad' : ''}`} title={WRITE_ACTIONS.includes(action) ? '외부 상태를 바꾸는 동작' : '외부 쓰기 없음'}>{ACTION_LABELS[action]}{WRITE_ACTIONS.includes(action) ? ' · 외부 쓰기' : ''}</span>)}</span>],
        ['목표', goalsText(mandate)],
        ...limitsText(mandate),
        ['주기', `${mandate.cadenceMinutes}분마다`],
        ['마지막 실행', formatDateTime(cycle?.lastRunAt ?? mandate.lastCycleAt)],
        ['다음 실행', formatDateTime(cycle?.nextDueAt ?? mandate.nextDueAt)],
        cycle && Object.keys(cycle.watermarks).length > 0 && ['수집 기준점', Object.entries(cycle.watermarks).map(([key, value]) => `${key}: ${formatDateTime(value)}`).join(' · ')],
        mandate.stopReason && ['중지 사유', `${mandate.stopReason} (${formatDateTime(mandate.stoppedAt)})`],
      ]} />
      {cycle?.blockers.length ? <Notice tone="warn" title="주기 작업 차단 사유"><ReasonList reasons={cycle.blockers} /></Notice> : null}
      {cycle?.lastError && <Notice tone="error" title="마지막 주기 오류">{cycle.lastError}</Notice>}
      {mandate.reuseEvidence.length > 0 && <div className="small"><strong>기존 승인값 재사용 근거</strong><ReasonList reasons={mandate.reuseEvidence} /></div>}
      {mandate.status === 'proposed' && <label className="checkbox-row"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />위 범위·기간·한도를 확인했고 이 범위 안의 반복 작업을 위임합니다.</label>}
    </div>
    <div className="item-row__actions">
      {mandate.status === 'proposed' && <button className="btn btn--sm btn--primary" disabled={!reviewed || !!act.pending} onClick={() => void act.run('confirm-mandate', { id: mandate.id, version: mandate.version }, '위임을 확정했습니다. 기간 안에서만 주기 작업을 실행합니다.')}><ShieldCheck size={14} />확정</button>}
      {mandate.status === 'active' && <button className="btn btn--sm" disabled={!!act.pending || overdue} onClick={() => void act.run('run-cycle', { id: mandate.id }, '위임 범위 안에서 주기 작업을 한 번 실행했습니다.')}><Play size={14} />지금 실행</button>}
      {(mandate.status === 'active' || mandate.status === 'proposed') && <ReasonAction label={mandate.status === 'proposed' ? '거절' : '중지'} placeholder="중지 사유(선택)" danger disabled={!!act.pending}
        onSubmit={reason => act.run('stop-mandate', { id: mandate.id, ...(reason ? { reason } : {}) }, '위임을 중지했습니다. 이후 새 외부 변경을 만들지 않습니다.')} />}
      <AskAi projectId={projectId} kind="mandate" id={mandate.id} label={label} record={mandate} />
    </div>
  </div>;
}

interface Bound { productId: string; currency: string; floor: string; ceiling: string }

function MandateForm({ state, projectId, reload, onClose }: SectionProps & { onClose: () => void }) {
  const uid = useId();
  const act = useGrowthAction(reload);
  const project = state.projects.find(item => item.id === projectId)!;
  const allowed = [...new Set([...project.policy.allowedConnectionIds, ...(project.socialPolicy?.connectionIds ?? [])])].filter(id => state.connections.some(conn => conn.id === id));
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [actions, setActions] = useState<MandateAction[]>(['observe']);
  const [startsAt, setStartsAt] = useState(''); const [endsAt, setEndsAt] = useState(''); const [cadence, setCadence] = useState('');
  const [currency, setCurrency] = useState(''); const [daily, setDaily] = useState(''); const [total, setTotal] = useState(''); const [loss, setLoss] = useState('');
  const [step, setStep] = useState(''); const [cooldown, setCooldown] = useState(''); const [replies, setReplies] = useState('');
  const [regions, setRegions] = useState(''); const [priceStep, setPriceStep] = useState(''); const [priceCooldown, setPriceCooldown] = useState(''); const [concurrent, setConcurrent] = useState('');
  const [bounds, setBounds] = useState<Bound[]>([{ productId: '', currency: project.policy.currency, floor: '', ceiling: '' }]);
  const [roasTarget, setRoasTarget] = useState(''); const [roasBasis, setRoasBasis] = useState<RevenueBasis | ''>(''); const [roasWindow, setRoasWindow] = useState('');
  const [roiTarget, setRoiTarget] = useState(''); const [roiWindow, setRoiWindow] = useState('');
  const [memo, setMemo] = useState('');
  const [review, setReview] = useState<{ payload: Record<string, unknown>; lines: string[] } | null>(null);
  const [formError, setFormError] = useState('');
  const has = (action: MandateAction) => actions.includes(action);
  const spends = has('ads-experiment') || has('ads-scale') || has('ads-rebalance');
  const budgetMoves = has('ads-scale') || has('ads-rebalance');
  const campaignRules = has('ads-stop') || has('ads-rebalance');
  const [stopRoas, setStopRoas] = useState(''); const [minSpend, setMinSpend] = useState('');
  const toggle = (action: MandateAction) => setActions(current => current.includes(action) ? current.filter(item => item !== action) : [...current, action]);

  function build(): { payload: Record<string, unknown>; lines: string[] } | string {
    const money = (value: string, label: string): string | undefined | Error => { if (!value.trim()) return undefined; const micros = majorToMicros(value); return micros === null ? new Error(`${label} 금액 형식을 확인하세요.`) : micros; };
    const limits: Record<string, unknown> = {}; const lines: string[] = [];
    const cur = currency.trim().toUpperCase() || project.policy.currency;
    if (currency.trim()) limits.currency = cur;
    for (const [key, value, label] of [['maxDailySpendMicros', daily, '일일 지출 상한'], ['maxTotalSpendMicros', total, '누적 지출 상한'], ['maxLossMicros', loss, '누적 손실 상한']] as const) {
      const micros = money(value, label); if (micros instanceof Error) return micros.message; if (micros !== undefined) { limits[key] = micros; lines.push(`${label}: ${formatMicros(micros, cur)}`); }
    }
    if (!endsAt) return '종료 시각을 입력하세요.';
    if (budgetMoves) { const ratio = percentInput(step); if (ratio !== undefined) { limits.maxBudgetStep = ratio; lines.push(`1회 예산 변경 폭: ${step}%`); } if (cooldown) { limits.cooldownHours = intInput(cooldown); lines.push(`예산 변경 간격: ${cooldown}시간`); } }
    if (campaignRules && stopRoas.trim()) { limits.campaignStopRoasBelow = percentInput(stopRoas); lines.push(`캠페인 중지 기준: ROAS ${stopRoas}% 미만`); }
    if (campaignRules && minSpend.trim()) { const micros = money(minSpend, '판단 최소 광고비'); if (micros instanceof Error) return micros.message; limits.minDecisionSpendMicros = micros; lines.push(`판단 최소 광고비: ${formatMicros(micros!, cur)}`); }
    if (replies) { limits.maxDailyReplies = intInput(replies); lines.push(`일일 자동 답글 상한: ${replies}건`); }
    if (has('pricing-change')) {
      const parsed: Array<Record<string, unknown>> = [];
      for (const bound of bounds.filter(item => item.productId.trim())) {
        const floor = money(bound.floor, '최저 가격'); const ceiling = money(bound.ceiling, '최고 가격');
        if (floor instanceof Error) return floor.message; if (ceiling instanceof Error) return ceiling.message;
        if (!floor || !ceiling) return '상품별 최저·최고 가격을 입력하세요.';
        parsed.push({ productId: bound.productId.trim(), currency: bound.currency.trim().toUpperCase(), floorMicros: floor, ceilingMicros: ceiling });
      }
      limits.pricing = { regions: regions.split(',').map(item => item.trim()).filter(Boolean), bounds: parsed, maxStep: percentInput(priceStep), cooldownHours: intInput(priceCooldown), ...(concurrent ? { maxConcurrentExperiments: intInput(concurrent) } : {}) };
      lines.push(`가격 변경: 지역 ${regions || '(없음)'} · 1회 ${priceStep || '?'}% · 간격 ${priceCooldown || '?'}시간 · 상품 ${parsed.map(item => item.productId).join(', ') || '(없음)'}`);
    }
    const goals: Record<string, unknown> = {};
    if (roasTarget || roasBasis || roasWindow) { goals.roas = { target: percentInput(roasTarget), basis: roasBasis || undefined, windowDays: intInput(roasWindow) }; lines.push(`목표 ROAS: ${roasTarget || '?'}% (분자: ${roasBasis ? BASIS_LABELS[roasBasis] : '?'}, 귀속 ${roasWindow === '0' ? '공급자 기본 창' : `${roasWindow || '?'}일`})`); }
    if (roiTarget || roiWindow) { goals.netRoi = { target: percentInput(roiTarget), windowDays: intInput(roiWindow) }; lines.push(`목표 순이익 ROI: ${roiTarget || '?'}% (귀속 ${roiWindow === '0' ? '공급자 기본 창' : `${roiWindow || '?'}일`}, 고정비 제외)`); }
    const summary = [
      `계정·채널: ${connectionIds.length ? connectionIds.map(id => connectionLabel(state, id)).join(', ') : '프로젝트 정책이 허용한 연결 전체(재사용 근거 기록)'}`,
      `허용 동작: ${actions.map(action => ACTION_LABELS[action] + (WRITE_ACTIONS.includes(action) ? '(외부 쓰기)' : '')).join(', ')}`,
      `기간: ${startsAt ? formatDateTime(localToIso(startsAt)) : '확정 즉시'} ~ ${formatDateTime(localToIso(endsAt))}`,
      `주기: ${cadence ? `${cadence}분` : '미입력(제안 기본값 60분, 근거 기록)'}`,
      `통화: ${cur}${currency.trim() ? '' : '(프로젝트 정책 통화 재사용)'}`,
      ...lines,
    ];
    const requestText = ['화면 양식으로 요청한 성장 운영 위임', ...summary, ...(memo.trim() ? [`메모: ${memo.trim()}`] : [])].join('\n').slice(0, 4000);
    const payload: Record<string, unknown> = {
      projectId, source: 'form', requestText, actions,
      ...(connectionIds.length ? { connectionIds } : {}), ...(startsAt ? { startsAt: localToIso(startsAt) } : {}), endsAt: localToIso(endsAt),
      ...(cadence ? { cadenceMinutes: intInput(cadence) } : {}), limits, goals,
    };
    return { payload, lines: summary };
  }
  async function submit(confirm: boolean) {
    if (!review) return;
    const result = await act.run('propose-mandate', { ...review.payload, confirm }, confirm ? '위임을 확정하고 시작했습니다.' : '위임안을 저장했습니다. 목록에서 확인 후 확정하세요.');
    if (result) onClose();
  }
  const f = (name: string) => `${uid}-${name}`;
  return <Modal title="새 운영 위임" wide onClose={onClose} footer={review
    ? <><button className="btn" onClick={() => setReview(null)} disabled={!!act.pending}>수정</button><button className="btn" onClick={() => void submit(false)} disabled={!!act.pending}>위임안으로 저장</button><button className="btn btn--primary" onClick={() => void submit(true)} disabled={!!act.pending}><ShieldCheck size={14} />확인했고 위임 시작</button></>
    : <><button className="btn" onClick={onClose}>취소</button><button className="btn btn--primary" onClick={() => { const result = build(); if (typeof result === 'string') setFormError(result); else { setFormError(''); setReview(result); } }}>검토</button></>}>
    {review ? <div className="stack">
      <Notice tone="warn" title="위임 내용을 확인하세요">확정하면 이 범위·기간·한도 안의 반복 작업을 매 주기 사람 확인 없이 진행합니다. 범위 확대·새 계정·기간 연장은 새 요청이 필요합니다. 빠진 값은 기존 승인값으로 유일하게 정할 수 있을 때만 서버가 채우고 근거를 기록하며, 정할 수 없으면 거부합니다.</Notice>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>{review.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <ActionFeedback act={act} />
    </div> : <div className="stack">
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
        <legend className="field__label">계정·채널</legend>
        {allowed.length === 0 ? <Notice tone="warn">프로젝트 실행 정책·커뮤니티 정책에서 허용한 연결이 없습니다. 프로젝트 화면에서 먼저 허용하세요.</Notice>
          : allowed.map(id => <label key={id} className="checkbox-row"><input type="checkbox" checked={connectionIds.includes(id)} onChange={() => setConnectionIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])} />{connectionLabel(state, id)}</label>)}
        <span className="field__hint">선택하지 않으면 프로젝트 정책이 허용한 연결 전체를 재사용하고 그 근거를 기록합니다.</span>
      </fieldset>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 0 }}>
        <legend className="field__label">허용 동작</legend>
        {MANDATE_ACTIONS.map(action => <label key={action} className="checkbox-row"><input type="checkbox" checked={has(action)} disabled={action === 'observe'} onChange={() => toggle(action)} />
          <span>{ACTION_LABELS[action]} {WRITE_ACTIONS.includes(action) ? <span className="tag tag--bad">외부 쓰기</span> : <span className="tag">외부 쓰기 없음</span>}</span></label>)}
      </fieldset>
      <div className="grid grid--split">
        <Field label="시작 시각" htmlFor={f('starts')} hint="비우면 확정 시각부터"><input id={f('starts')} className="input" type="datetime-local" value={startsAt} onChange={event => setStartsAt(event.target.value)} /></Field>
        <Field label="종료 시각" required htmlFor={f('ends')} hint="한 번의 위임은 1년 이내"><input id={f('ends')} className="input" type="datetime-local" value={endsAt} onChange={event => setEndsAt(event.target.value)} /></Field>
        <Field label="주기(분)" htmlFor={f('cadence')} hint="15분~7일. 비우면 60분 제안값과 근거를 기록"><input id={f('cadence')} className="input" type="number" min={15} value={cadence} onChange={event => setCadence(event.target.value)} /></Field>
        <Field label="통화" htmlFor={f('currency')} hint={`비우면 프로젝트 정책 통화 ${project.policy.currency}`}><input id={f('currency')} className="input" maxLength={3} value={currency} onChange={event => setCurrency(event.target.value)} placeholder={project.policy.currency} /></Field>
        <Field label="일일 지출 상한" htmlFor={f('daily')} hint={`비우면 프로젝트 일일 광고 예산 ${formatMicros(project.policy.maxDailyBudgetMicros, project.policy.currency)} 재사용`}><input id={f('daily')} className="input" inputMode="decimal" value={daily} onChange={event => setDaily(event.target.value)} /></Field>
        <Field label="누적 지출 상한" required={spends} htmlFor={f('total')}><input id={f('total')} className="input" inputMode="decimal" value={total} onChange={event => setTotal(event.target.value)} /></Field>
        <Field label="누적 손실 상한" required={spends} htmlFor={f('loss')} hint="지출 − 귀속 순수익. 넘으면 신규 지출 중지"><input id={f('loss')} className="input" inputMode="decimal" value={loss} onChange={event => setLoss(event.target.value)} /></Field>
        {budgetMoves && <>
          <Field label="1회 예산 변경 폭(%)" required htmlFor={f('step')} hint="승자 증액·재배분 한 번에 바꿀 수 있는 예산 비율"><input id={f('step')} className="input" type="number" min={1} max={100} value={step} onChange={event => setStep(event.target.value)} /></Field>
          <Field label="예산 변경 간격(시간)" required htmlFor={f('cooldown')}><input id={f('cooldown')} className="input" type="number" min={1} value={cooldown} onChange={event => setCooldown(event.target.value)} /></Field>
        </>}
        {campaignRules && <>
          <Field label="캠페인 중지 ROAS 기준(%)" htmlFor={f('stoproas')} hint="이 ROAS 미만 캠페인을 중지·재배분 대상으로 봅니다. 비우면 규칙 없음"><input id={f('stoproas')} className="input" type="number" min={0} value={stopRoas} onChange={event => setStopRoas(event.target.value)} /></Field>
          <Field label="판단 최소 광고비" htmlFor={f('minspend')} hint="이 금액 미만으로 쓴 캠페인은 성과로 판단하지 않습니다"><input id={f('minspend')} className="input" inputMode="decimal" value={minSpend} onChange={event => setMinSpend(event.target.value)} /></Field>
        </>}
        {(has('community-reply') || replies) && <Field label="일일 자동 답글 상한" htmlFor={f('replies')} hint="비우면 프로젝트 커뮤니티 일일 한도 재사용"><input id={f('replies')} className="input" type="number" min={0} max={100} value={replies} onChange={event => setReplies(event.target.value)} /></Field>}
      </div>
      {has('pricing-change') && <fieldset className="action-group"><legend className="action-group__title">가격 변경 범위</legend>
        <div className="grid grid--split">
          <Field label="지역(쉼표 구분)" required htmlFor={f('regions')}><input id={f('regions')} className="input" value={regions} onChange={event => setRegions(event.target.value)} placeholder="KR, US" /></Field>
          <Field label="1회 가격 변화 폭(%)" required htmlFor={f('pstep')}><input id={f('pstep')} className="input" type="number" min={1} max={50} value={priceStep} onChange={event => setPriceStep(event.target.value)} /></Field>
          <Field label="가격 변경 간격(시간)" required htmlFor={f('pcool')} hint="24시간 이상"><input id={f('pcool')} className="input" type="number" min={24} value={priceCooldown} onChange={event => setPriceCooldown(event.target.value)} /></Field>
          <Field label="동시 가격 실험 수" htmlFor={f('pconc')}><input id={f('pconc')} className="input" type="number" min={1} max={5} value={concurrent} onChange={event => setConcurrent(event.target.value)} /></Field>
        </div>
        {bounds.map((bound, index) => <div key={index} className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="상품 ID" htmlFor={f(`bp${index}`)}><input id={f(`bp${index}`)} className="input" value={bound.productId} onChange={event => setBounds(current => current.map((item, i) => i === index ? { ...item, productId: event.target.value } : item))} /></Field>
          <Field label="통화" htmlFor={f(`bc${index}`)}><input id={f(`bc${index}`)} className="input" style={{ width: 70 }} maxLength={3} value={bound.currency} onChange={event => setBounds(current => current.map((item, i) => i === index ? { ...item, currency: event.target.value } : item))} /></Field>
          <Field label="최저 가격" htmlFor={f(`bf${index}`)}><input id={f(`bf${index}`)} className="input" inputMode="decimal" value={bound.floor} onChange={event => setBounds(current => current.map((item, i) => i === index ? { ...item, floor: event.target.value } : item))} /></Field>
          <Field label="최고 가격" htmlFor={f(`bh${index}`)}><input id={f(`bh${index}`)} className="input" inputMode="decimal" value={bound.ceiling} onChange={event => setBounds(current => current.map((item, i) => i === index ? { ...item, ceiling: event.target.value } : item))} /></Field>
          {bounds.length > 1 && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setBounds(current => current.filter((_, i) => i !== index))}>삭제</button>}
        </div>)}
        <button type="button" className="btn btn--sm" onClick={() => setBounds(current => [...current, { productId: '', currency: project.policy.currency, floor: '', ceiling: '' }])}>상품 추가</button>
      </fieldset>}
      <fieldset className="action-group"><legend className="action-group__title">목표 (선택 — ROAS와 순이익 ROI는 서로 다른 지표입니다)</legend>
        <div className="grid grid--split">
          <Field label="목표 ROAS(%)" htmlFor={f('roas')} hint="150 = 광고비 1당 귀속 수익 1.5"><input id={f('roas')} className="input" type="number" min={1} value={roasTarget} onChange={event => setRoasTarget(event.target.value)} /></Field>
          <Field label="ROAS 분자 기준" htmlFor={f('basis')}><select id={f('basis')} className="select" value={roasBasis} onChange={event => setRoasBasis(event.target.value as RevenueBasis | '')}><option value="">선택</option>{(Object.keys(BASIS_LABELS) as RevenueBasis[]).map(basis => <option key={basis} value={basis}>{BASIS_LABELS[basis]}</option>)}</select></Field>
          <Field label="ROAS 귀속 창(일)" htmlFor={f('rwin')} hint="0 = 공급자 기본 귀속 창"><input id={f('rwin')} className="input" type="number" min={0} max={365} value={roasWindow} onChange={event => setRoasWindow(event.target.value)} /></Field>
          <Field label="목표 순이익 ROI(%)" htmlFor={f('roi')} hint="(순수익 − 광고비 − 가변비용) ÷ (광고비 + 가변비용), 고정비 제외"><input id={f('roi')} className="input" type="number" value={roiTarget} onChange={event => setRoiTarget(event.target.value)} /></Field>
          <Field label="ROI 귀속 창(일)" htmlFor={f('iwin')} hint="0 = 공급자 기본 귀속 창"><input id={f('iwin')} className="input" type="number" min={0} max={365} value={roiWindow} onChange={event => setRoiWindow(event.target.value)} /></Field>
        </div>
      </fieldset>
      <Field label="메모(선택)" htmlFor={f('memo')} hint="요청 기록에 함께 남습니다. 비밀값은 넣지 마세요."><textarea id={f('memo')} className="textarea" rows={2} maxLength={1000} value={memo} onChange={event => setMemo(event.target.value)} /></Field>
      {formError && <Notice tone="error">{formError}</Notice>}
    </div>}
  </Modal>;
}
