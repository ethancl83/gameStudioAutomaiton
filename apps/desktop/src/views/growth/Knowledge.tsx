// 지식 문서(답글 근거)의 판 관리와 환율 스냅샷 기록.
import { useId, useState } from 'react';
import { BookOpen, Coins, FileDown, Plus } from 'lucide-react';
import type { KnowledgeRevision, KnowledgeSource } from '../../../../../packages/growth/types';
import { formatDateTime } from '../../format';
import { Badge, Card, EmptyState, Field, Modal, Notice } from '../../components/ui';
import { ActionFeedback, AskAi, useGrowthAction, type SectionProps, type Tone } from './shared';

const SOURCE_LABELS: Record<KnowledgeSource, string> = { store_listing: '스토어 소개', faq: 'FAQ', support_policy: '지원 정책', changelog: '변경 내역', known_issue: '알려진 문제', analysis: '분석 메모' };
const STATUS: Record<KnowledgeRevision['status'], [string, Tone]> = { draft: ['초안', 'warn'], approved: ['승인(사용 중)', 'ok'], retired: ['폐기', 'neutral'] };

export function KnowledgeSection(props: SectionProps) {
  return <>
    <KnowledgeCard {...props} />
    <FxCard {...props} />
  </>;
}

function KnowledgeCard(props: SectionProps) {
  const { growth, projectId, reload } = props;
  const act = useGrowthAction(reload);
  const [creating, setCreating] = useState<{ documentKey?: string; sourceKind?: KnowledgeSource; title?: string; body?: string } | null>(null);
  const revisions = growth.knowledge.filter(item => item.projectId === projectId);
  const documents = [...new Set(revisions.map(item => item.documentKey))].map(key => revisions.filter(item => item.documentKey === key).sort((a, b) => b.version - a.version));
  return <Card title="지식 문서" icon={BookOpen} actions={<>
    <button className="btn btn--sm" disabled={!!act.pending} title="스토어 소개·README·CHANGELOG 등에서 초안을 만듭니다. 승인 전에는 답글 근거로 쓰지 않습니다." onClick={() => void act.run<KnowledgeRevision[]>('import-knowledge', { projectId }, '프로젝트 문서에서 초안을 가져왔습니다. 승인 전에는 답글 근거로 쓰지 않습니다.')}><FileDown size={14} />프로젝트에서 가져오기</button>
    <button className="btn btn--sm btn--primary" onClick={() => setCreating({})}><Plus size={14} />새 문서</button>
  </>}>
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>답글 초안은 승인된 판의 문장만 근거로 인용합니다. 문서마다 승인된 판은 하나이며, 새 판을 승인하면 이전 판은 자동으로 폐기됩니다.</p>
      <ActionFeedback act={act} />
      {documents.length === 0 ? <EmptyState icon={BookOpen} title="지식 문서가 없습니다" description="프로젝트 문서에서 가져오거나 새 문서를 작성한 뒤 승인하세요." />
        : <div className="item-list">{documents.map(versions => { const latest = versions[0]!; const approved = versions.find(item => item.status === 'approved'); return <div key={latest.documentKey} className="item-row">
          <div className="item-row__main stack" style={{ gap: 6 }}>
            <div className="item-row__title row" style={{ gap: 8 }}><span>{latest.title}</span><span className="tag">{SOURCE_LABELS[latest.sourceKind]}</span>{approved ? <Badge tone="ok">v{approved.version} 사용 중</Badge> : <Badge tone="warn">승인된 판 없음</Badge>}</div>
            <div className="item-row__meta">문서 키 {latest.documentKey}{latest.sourceRef && ` · 출처 ${latest.sourceRef}`}</div>
            {versions.map(revision => <div key={revision.id} className="action-group">
              <div className="row row--between">
                <span className="row" style={{ gap: 8 }}><strong>v{revision.version}</strong><Badge tone={STATUS[revision.status][1]}>{STATUS[revision.status][0]}</Badge><span className="small muted">{formatDateTime(revision.createdAt)}{revision.approvedAt && ` · 승인 ${formatDateTime(revision.approvedAt)}`}{revision.retiredAt && ` · 폐기 ${formatDateTime(revision.retiredAt)}`} · sha {revision.sha256.slice(0, 10)}</span></span>
                <span className="row" style={{ gap: 6 }}>
                  {revision.status === 'draft' && <button className="btn btn--sm btn--primary" disabled={!!act.pending} onClick={() => void act.run('approve-knowledge', { id: revision.id }, `v${revision.version}을 승인했습니다. 이후 초안은 이 판을 근거로 사용합니다.`)}>승인</button>}
                  {revision.status !== 'retired' && <button className="btn btn--sm" disabled={!!act.pending} onClick={() => void act.run('retire-knowledge', { id: revision.id }, `v${revision.version}을 폐기했습니다.`)}>폐기</button>}
                  {revision === latest && <button className="btn btn--sm" onClick={() => setCreating({ documentKey: revision.documentKey, sourceKind: revision.sourceKind, title: revision.title, body: revision.body })}>새 판 작성</button>}
                  <AskAi projectId={projectId} kind="knowledge" id={revision.id} label={`지식 문서: ${revision.title} v${revision.version}`} record={revision} />
                </span>
              </div>
              <details><summary className="small">본문</summary><pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', margin: '6px 0 0' }}>{revision.body}</pre></details>
            </div>)}
          </div>
        </div>; })}</div>}
    </div>
    {creating && <KnowledgeForm {...props} initial={creating} onClose={() => setCreating(null)} />}
  </Card>;
}

function KnowledgeForm({ projectId, reload, initial, onClose }: SectionProps & { initial: { documentKey?: string; sourceKind?: KnowledgeSource; title?: string; body?: string }; onClose: () => void }) {
  const uid = useId(); const f = (name: string) => `${uid}-${name}`;
  const act = useGrowthAction(reload);
  const [documentKey, setDocumentKey] = useState(initial.documentKey ?? '');
  const [sourceKind, setSourceKind] = useState<KnowledgeSource | ''>(initial.sourceKind ?? '');
  const [title, setTitle] = useState(initial.title ?? ''); const [body, setBody] = useState(initial.body ?? ''); const [sourceRef, setSourceRef] = useState('');
  async function submit() {
    const result = await act.run('save-knowledge', { projectId, ...(documentKey.trim() ? { documentKey: documentKey.trim() } : {}), sourceKind, title: title.trim(), body, ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}) }, '초안을 저장했습니다. 승인해야 답글 근거로 사용됩니다.');
    if (result) onClose();
  }
  return <Modal title={initial.documentKey ? '지식 문서 새 판' : '새 지식 문서'} wide onClose={onClose} footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn btn--primary" disabled={!!act.pending || !sourceKind || !title.trim() || !body.trim()} onClick={() => void submit()}>초안 저장</button></>}>
    <div className="stack">
      <div className="grid grid--split">
        <Field label="종류" required htmlFor={f('kind')}><select id={f('kind')} className="select" value={sourceKind} onChange={event => setSourceKind(event.target.value as KnowledgeSource)}><option value="">선택</option>{(Object.keys(SOURCE_LABELS) as KnowledgeSource[]).map(key => <option key={key} value={key}>{SOURCE_LABELS[key]}</option>)}</select></Field>
        <Field label="문서 키" htmlFor={f('key')} hint="같은 키는 같은 문서의 새 판이 됩니다. 비우면 제목을 사용"><input id={f('key')} className="input" maxLength={200} value={documentKey} disabled={!!initial.documentKey} onChange={event => setDocumentKey(event.target.value)} /></Field>
        <Field label="제목" required htmlFor={f('title')}><input id={f('title')} className="input" maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></Field>
        <Field label="출처" htmlFor={f('ref')} hint="파일 경로·URL 등"><input id={f('ref')} className="input" maxLength={500} value={sourceRef} onChange={event => setSourceRef(event.target.value)} /></Field>
      </div>
      <Field label="본문" required htmlFor={f('body')} hint="공개해도 되는 내용만 쓰세요. 답글은 이 문장을 그대로 인용합니다."><textarea id={f('body')} className="textarea" rows={10} maxLength={20000} value={body} onChange={event => setBody(event.target.value)} /></Field>
      <ActionFeedback act={act} />
    </div>
  </Modal>;
}

function FxCard({ growth, projectId, reload }: SectionProps) {
  const uid = useId(); const f = (name: string) => `${uid}-${name}`;
  const act = useGrowthAction(reload);
  const policy = growth.policies.find(item => item.projectId === projectId);
  const [source, setSource] = useState(policy?.fxSource ?? ''); const [date, setDate] = useState(''); const [base, setBase] = useState(''); const [quote, setQuote] = useState(policy?.reportingCurrency ?? ''); const [rate, setRate] = useState('');
  const rows = [...growth.fx].sort((a, b) => b.date.localeCompare(a.date) || b.recordedAt.localeCompare(a.recordedAt)).slice(0, 100);
  const valid = source.trim() && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^[A-Za-z]{3}$/.test(base) && /^[A-Za-z]{3}$/.test(quote) && /^\d{1,12}(\.\d{1,10})?$/.test(rate);
  return <Card title="환율 스냅샷" icon={Coins}>
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>정책의 환율 출처({policy?.fxSource ?? '미설정'})와 허용 기간({policy ? `${policy.fxMaxAgeHours}시간` : '미설정'}) 안의 스냅샷만 통화 환산에 사용합니다. 출처가 없으면 통화를 합산하지 않습니다.</p>
      {policy && !policy.fxSource && <Notice tone="info">정책에 환율 출처가 없어 기록해도 합산에 쓰지 않습니다.</Notice>}
      <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={event => { event.preventDefault(); if (valid) void act.run('record-fx', { source: source.trim(), date, base: base.toUpperCase(), quote: quote.toUpperCase(), rate }, '환율을 기록했습니다.').then(result => { if (result) setRate(''); }); }}>
        <Field label="출처" required htmlFor={f('src')}><input id={f('src')} className="input" maxLength={100} value={source} onChange={event => setSource(event.target.value)} /></Field>
        <Field label="기준일" required htmlFor={f('date')}><input id={f('date')} className="input" type="date" value={date} onChange={event => setDate(event.target.value)} /></Field>
        <Field label="기준 통화" required htmlFor={f('base')}><input id={f('base')} className="input" style={{ width: 80 }} maxLength={3} value={base} onChange={event => setBase(event.target.value)} placeholder="USD" /></Field>
        <Field label="대상 통화" required htmlFor={f('quote')}><input id={f('quote')} className="input" style={{ width: 80 }} maxLength={3} value={quote} onChange={event => setQuote(event.target.value)} placeholder="KRW" /></Field>
        <Field label="환율(기준 1 = ?)" required htmlFor={f('rate')}><input id={f('rate')} className="input" inputMode="decimal" value={rate} onChange={event => setRate(event.target.value)} /></Field>
        <button type="submit" className="btn btn--primary btn--sm" disabled={!!act.pending || !valid}>기록</button>
      </form>
      <ActionFeedback act={act} />
      {rows.length === 0 ? <EmptyState icon={Coins} title="기록한 환율이 없습니다" /> : <div className="table__scroll"><table className="table">
        <caption className="sr-caption">환율 스냅샷</caption>
        <thead><tr><th>기준일</th><th>통화</th><th>환율</th><th>출처</th><th>기록</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}><td>{row.date}</td><td>{row.base} → {row.quote}</td><td className="mono">{row.rate}</td><td>{row.source}</td><td>{formatDateTime(row.recordedAt)}{row.version > 1 && ` · v${row.version}`}</td></tr>)}</tbody>
      </table></div>}
    </div>
  </Card>;
}
