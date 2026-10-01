// 고객응대: 응답 대기열(사람 확인 우선), 사고·회수, 플랫폼 승인 근거, 개인정보 없는 요약.
import { useId, useState } from 'react';
import { AlertOctagon, BadgeCheck, MessagesSquare, ShieldCheck } from 'lucide-react';
import { OPEN_RESPONSE_STATUSES, type GrowthIncident, type PlatformApproval, type ResponseIntent, type ResponseStatus, type RiskFlag } from '../../../../../packages/growth/types';
import { formatDateTime, formatRelative, providerLabel } from '../../format';
import { Badge, Card, EmptyState, Field, Notice } from '../../components/ui';
import { ActionFeedback, AskAi, RESPONSE_STATUS, ReasonAction, ReasonList, StatusBadge, connectionLabel, localToIso, useGrowthAction, type GrowthAction, type SectionProps } from './shared';

const RISK_LABELS: Record<RiskFlag, string> = {
  personal_data: '개인정보', payment: '결제', refund: '환불', legal: '법적', harassment: '괴롭힘', self_harm: '자해', child_safety: '아동 안전', security: '보안',
  press: '언론', dispute: '분쟁', compensation: '보상 요구', prompt_injection: '지시 주입 시도', spam: '스팸', opt_out: '자동 응답 거부', sensitive_media: '민감 미디어',
};
const INTENT_LABELS: Record<string, string> = { question: '문의', bug_report: '버그 제보', feature_request: '기능 요청', praise: '칭찬', complaint: '불만', other: '기타', unclassified: '미분류' };
// 펼침 여부는 서버가 표시 상한 밖에서도 유지하는 열린 상태(OPEN_RESPONSE_STATUSES)와 같은 기준이다.
const GROUPS: Array<{ title: string; statuses: ResponseStatus[] }> = [
  { title: '사람 확인 필요', statuses: ['escalated'] },
  { title: '초안 준비 — 승인 대기', statuses: ['draft_ready'] },
  { title: '차단됨', statuses: ['blocked'] },
  { title: '발송 경로(대기열·준비·발송 확인 중)', statuses: ['authorized', 'queued', 'prepared', 'dispatched'] },
  { title: '발송 결과', statuses: ['confirmed', 'unresolved'] },
  { title: '수집·분류·종료', statuses: ['ingested', 'classified', 'closed', 'retracted'] },
];
const isOpen = (statuses: ResponseStatus[]) => statuses.some(status => OPEN_RESPONSE_STATUSES.includes(status));

export function CommunitySection(props: SectionProps) {
  const act = useGrowthAction(props.reload);
  return <>
    <DigestCard {...props} />
    <ActionFeedback act={act} />
    <ResponsesCard {...props} act={act} />
    <IncidentsCard {...props} act={act} />
    <ApprovalsCard {...props} />
  </>;
}

/** 서버 digest(최근 24시간, 전체 프로젝트)를 그대로 표시한다. 작성자·원문은 포함되지 않는다. */
function DigestCard({ growth }: SectionProps) {
  const community = growth.digest.community;
  return <Card title="고객응대 요약 · 최근 24시간" icon={MessagesSquare}>
    <div className="stack" style={{ gap: 8 }}>
      <p className="small muted" style={{ margin: 0 }}>서버가 전체 프로젝트를 대상으로 집계한 건수입니다. 작성자·원문은 담지 않습니다.</p>
      <div className="row"><strong>{community.total}건</strong><span>사람 확인 {community.escalations.open}건{community.escalations.overdue ? ` (기한 초과 ${community.escalations.overdue})` : ''} · 근거 부족 {community.lowEvidence}건</span></div>
      <div className="row" style={{ gap: 4 }}>{Object.entries(community.byStatus).map(([key, value]) => <span key={key} className="tag">{RESPONSE_STATUS[key as ResponseStatus]?.[0] ?? key} {value}</span>)}</div>
      {Object.keys(community.byRisk).length > 0 && <div className="row" style={{ gap: 4 }}>{Object.entries(community.byRisk).map(([key, value]) => <span key={key} className="tag tag--bad">{RISK_LABELS[key as RiskFlag] ?? key} {value}</span>)}</div>}
    </div>
  </Card>;
}

function ResponsesCard({ state, growth, projectId, act }: SectionProps & { act: GrowthAction }) {
  const responses = growth.responses.filter(item => item.projectId === projectId);
  return <Card title="응답 대기열" icon={MessagesSquare}>
    <div className="stack">
      <Notice tone="info">승인해도 AI나 화면이 직접 게시하지 않습니다. 모든 답글은 내구성 대기열(승인→대기열→준비→발송→확인)을 거치며, 발송 직전 자동 응답 거부·중복·위임 기간·일일 한도·플랫폼 승인 근거를 다시 검사합니다. 위험·민감 문의는 사람이 직접 응대해야 합니다.</Notice>
      {responses.length === 0 ? <EmptyState icon={MessagesSquare} title="응답할 상호작용이 없습니다" description="커뮤니티 초안 위임이 실행되면 새 멘션·답글을 분류해 여기에 표시합니다." />
        : GROUPS.map(group => { const items = responses.filter(item => group.statuses.includes(item.status)).sort((a, b) => (a.escalation?.dueAt ?? a.createdAt).localeCompare(b.escalation?.dueAt ?? b.createdAt));
          if (!items.length) return null;
          return <details key={group.title} open={isOpen(group.statuses)}><summary><strong>{group.title}</strong> <span className="small muted">{items.length}건</span></summary>
            <div className="item-list">{items.map(item => <ResponseRow key={item.id} state={state} growth={growth} projectId={projectId} response={item} act={act} />)}</div>
          </details>; })}
    </div>
  </Card>;
}

function ResponseRow({ state, growth, projectId, response, act }: Pick<SectionProps, 'state' | 'growth' | 'projectId'> & { response: ResponseIntent; act: GrowthAction }) {
  const revision = (id: string) => growth.knowledge.find(item => item.id === id);
  const overdue = response.escalation && Date.parse(response.escalation.dueAt) < Date.now();
  const canDismiss = ['draft_ready', 'blocked', 'escalated', 'classified', 'ingested'].includes(response.status);
  const canRecall = ['confirmed', 'unresolved', 'dispatched'].includes(response.status);
  return <div className="item-row" id={`growth-response-${response.id}`} tabIndex={-1}>
    <div className="item-row__main stack" style={{ gap: 6 }}>
      <div className="item-row__title row" style={{ gap: 8 }}>
        <StatusBadge map={RESPONSE_STATUS} value={response.status} />
        <span className="small">{connectionLabel(state, response.connectionId)} ({providerLabel(response.provider)})</span>
        {response.classification && <span className="small muted">{INTENT_LABELS[response.classification.intent]} · {response.classification.language} · 신뢰도 {Math.round(response.classification.confidence * 100)}% · {response.classification.source}</span>}
        <span className="small muted">{formatRelative(response.createdAt)}</span>
      </div>
      <blockquote className="small" style={{ margin: 0, paddingLeft: 10, borderLeft: '3px solid var(--border)', whiteSpace: 'pre-wrap' }}>{response.excerpt}</blockquote>
      {response.classification?.risks.length ? <div className="row" style={{ gap: 4 }}>{response.classification.risks.map(risk => <span key={risk} className="tag tag--bad">{RISK_LABELS[risk]}</span>)}</div> : null}
      {response.escalation && <Notice tone={overdue ? 'error' : 'warn'} title={`사람 확인 필요 · 기한 ${formatDateTime(response.escalation.dueAt)}${overdue ? ' (초과)' : ''}`}>{response.escalation.reason} · 담당: {response.escalation.owner}</Notice>}
      {response.draft && <div className="action-group">
        <span className="action-group__title">답글 초안 ({response.draft.language})</span>
        {response.draft.sentences.map((sentence, index) => <div key={index} className="small">
          <div>{sentence.text}</div>
          {sentence.citations.map((citation, i) => { const doc = revision(citation.revisionId); return <div key={i} className="muted" style={{ paddingLeft: 12 }}>근거: {doc ? `${doc.title} v${doc.version}${doc.status !== 'approved' ? ` (${doc.status === 'retired' ? '폐기됨' : '미승인'})` : ''}` : '삭제된 지식'} — &ldquo;{citation.quote}&rdquo;</div>; })}
        </div>)}
      </div>}
      {response.blockReasons.length > 0 && <div className="small"><strong>차단·보류 사유</strong><ReasonList reasons={response.blockReasons} /></div>}
      {response.incidentId && <span className="small">연결된 사고 {response.incidentId.slice(0, 8)}</span>}
    </div>
    <div className="item-row__actions">
      {response.status === 'draft_ready' && <button className="btn btn--sm btn--primary" disabled={!!act.pending} title="내구성 대기열로 보내며 발송 전 검사를 다시 거칩니다" onClick={() => void act.run('authorize-response', { id: response.id }, '답글을 발송 대기열에 넣었습니다. 발송 전 검사를 통과해야 게시됩니다.')}><ShieldCheck size={14} />승인</button>}
      {canDismiss && <ReasonAction label="보류" placeholder="보류 사유(선택)" disabled={!!act.pending} onSubmit={reason => act.run('dismiss-response', { id: response.id, ...(reason ? { reason } : {}) }, '응답을 보류했습니다.')} />}
      <button className="btn btn--sm" disabled={!!act.pending} title="이 작성자에게 자동 답글을 보내지 않도록 기록합니다" onClick={() => void act.run('record-opt-out', { id: response.id }, '이 작성자의 자동 응답 거부를 기록했습니다.')}>자동 응답 거부</button>
      {canRecall && <ReasonAction label="회수" placeholder="회수 사유(필수)" required danger disabled={!!act.pending} onSubmit={reason => act.run('recall-response', { id: response.id, reason }, '회수 사고를 열고 자동 답글 위임을 중지했습니다.')} />}
      <AskAi projectId={projectId} kind="response" id={response.id} label={`${INTENT_LABELS[response.classification?.intent ?? 'unclassified']} 응답 ${response.id.slice(0, 8)}`} record={response} />
    </div>
  </div>;
}

const INCIDENT_STATUS: Record<GrowthIncident['status'], [string, 'error' | 'progress' | 'ok']> = { open: ['열림', 'error'], recalling: ['회수 중', 'progress'], resolved: ['해결됨', 'ok'] };

function IncidentsCard({ growth, projectId, act }: SectionProps & { act: GrowthAction }) {
  const incidents = growth.incidents.filter(item => item.projectId === projectId).sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.createdAt.localeCompare(a.createdAt));
  return <Card title="답글 사고·회수" icon={AlertOctagon}>
    {incidents.length === 0 ? <EmptyState icon={AlertOctagon} title="열린 사고가 없습니다" description="발송된 답글을 회수하면 사고가 열리고 자동 답글 위임이 중지됩니다." />
      : <div className="item-list">{incidents.map(incident => { const [label, tone] = INCIDENT_STATUS[incident.status]; return <div key={incident.id} className="item-row" id={`growth-incident-${incident.id}`} tabIndex={-1}>
        <div className="item-row__main stack" style={{ gap: 6 }}>
          <div className="item-row__title row" style={{ gap: 8 }}><Badge tone={tone}>{label}</Badge><span>{incident.reason}</span><span className="small muted">{formatDateTime(incident.createdAt)}</span></div>
          <div className="small muted">응답 {incident.responseIntentIds.length}건 · 회수 작업 {incident.recallRunIds.length}건 · 중지한 위임 {incident.pausedMandateIds.length}건</div>
          <ReasonList reasons={incident.notes} />
        </div>
        <div className="item-row__actions">
          {incident.status !== 'resolved' && <ReasonAction label="해결" placeholder="처리 메모(선택)" disabled={!!act.pending || incident.status === 'recalling'} onSubmit={note => act.run('resolve-incident', { id: incident.id, ...(note ? { note } : {}) }, '사고를 해결로 표시했습니다.')} />}
          <AskAi projectId={projectId} kind="incident" id={incident.id} label={`답글 사고: ${incident.reason.slice(0, 60)}`} record={incident} />
        </div>
      </div>; })}</div>}
  </Card>;
}

function ApprovalsCard({ state, growth, reload }: SectionProps) {
  const uid = useId(); const f = (name: string) => `${uid}-${name}`;
  const act = useGrowthAction(reload);
  const channels = state.connections.filter(item => item.provider === 'x' || item.provider === 'threads');
  const [connectionId, setConnectionId] = useState(channels[0]?.id ?? '');
  const [evidence, setEvidence] = useState(''); const [approvedAt, setApprovedAt] = useState(''); const [expiresAt, setExpiresAt] = useState('');
  const approvals = growth.approvals.filter(item => channels.some(conn => conn.id === item.connectionId)).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const status = (item: PlatformApproval): [string, 'ok' | 'neutral' | 'warn'] => item.revokedAt ? ['철회됨', 'neutral'] : item.expiresAt && Date.parse(item.expiresAt) < Date.now() ? ['만료됨', 'warn'] : ['유효', 'ok'];
  return <Card title="X·Threads 자동 답글 플랫폼 승인 근거" icon={BadgeCheck}>
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>AI 자동 답글은 플랫폼 정책 승인 근거가 유효할 때만 발송 전 검사를 통과합니다. 승인 문서·심사 결과를 구체적으로 기록하고, 비밀값은 넣지 마세요.</p>
      {channels.length === 0 ? <Notice tone="info">연결된 X 또는 Threads 채널이 없습니다.</Notice> : <form className="stack" onSubmit={event => { event.preventDefault();
        void act.run('record-approval', { connectionId, evidence: evidence.trim(), approvedAt: localToIso(approvedAt), ...(expiresAt ? { expiresAt: localToIso(expiresAt) } : {}) }, '플랫폼 승인 근거를 기록했습니다.').then(result => { if (result) { setEvidence(''); setApprovedAt(''); setExpiresAt(''); } }); }}>
        <div className="grid grid--split">
          <Field label="채널" required htmlFor={f('conn')}><select id={f('conn')} className="select" value={connectionId} onChange={event => setConnectionId(event.target.value)}>{channels.map(conn => <option key={conn.id} value={conn.id}>{conn.label} ({providerLabel(conn.provider)})</option>)}</select></Field>
          <Field label="승인일" required htmlFor={f('at')}><input id={f('at')} className="input" type="datetime-local" value={approvedAt} onChange={event => setApprovedAt(event.target.value)} /></Field>
          <Field label="만료일" htmlFor={f('exp')}><input id={f('exp')} className="input" type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></Field>
        </div>
        <Field label="승인 근거" required htmlFor={f('ev')} hint="10자 이상. 승인 메일·문서 번호·심사 결과 등"><textarea id={f('ev')} className="textarea" rows={2} maxLength={2000} value={evidence} onChange={event => setEvidence(event.target.value)} /></Field>
        <div><button type="submit" className="btn btn--primary btn--sm" disabled={!!act.pending || !connectionId || evidence.trim().length < 10 || !approvedAt}>근거 기록</button></div>
      </form>}
      <ActionFeedback act={act} />
      {approvals.length > 0 && <div className="item-list">{approvals.map(item => { const [label, tone] = status(item); return <div key={item.id} className="item-row">
        <div className="item-row__main"><div className="item-row__title row" style={{ gap: 8 }}><Badge tone={tone}>{label}</Badge>{connectionLabel(state, item.connectionId)} ({providerLabel(item.provider)})</div>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{item.evidence}</div>
          <div className="item-row__meta">승인 {formatDateTime(item.approvedAt)}{item.expiresAt && ` · 만료 ${formatDateTime(item.expiresAt)}`} · 기록 {formatDateTime(item.recordedAt)}{item.revokedAt && ` · 철회 ${formatDateTime(item.revokedAt)}`}</div></div>
        <div className="item-row__actions">{!item.revokedAt && <button className="btn btn--sm btn--danger" disabled={!!act.pending} onClick={() => void act.run('revoke-approval', { id: item.id }, '승인 근거를 철회했습니다. 이후 자동 답글은 발송 전 검사에서 막힙니다.')}>철회</button>}</div>
      </div>; })}</div>}
    </div>
  </Card>;
}
