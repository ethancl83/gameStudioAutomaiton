// 피드백 이슈: 설명 가능한 묶음 키·후보·우선순위 차원(단일 점수 없음), 확인·병합·분리, 제품 개선 연결.
import { useId, useState } from 'react';
import { Bug, Lightbulb } from 'lucide-react';
import type { FeedbackItem, GrowthState, IssueCluster, IssuePriority, ProductExperimentLink } from '../../../../../packages/growth/types';
import { formatDateTime, formatMicros, providerLabel } from '../../format';
import { Badge, Card, EmptyState, Notice } from '../../components/ui';
import { ActionFeedback, AskAi, Dl, ReasonAction, useGrowthAction, type GrowthAction, type SectionProps, type Tone } from './shared';

const CLUSTER_STATUS: Record<IssueCluster['status'], [string, Tone]> = { candidate: ['확인 대기', 'warn'], confirmed: ['확인됨', 'ok'], merged: ['병합됨', 'neutral'], split: ['분리됨', 'neutral'], closed: ['종료', 'neutral'] };
const LINK_STATUS: Record<ProductExperimentLink['status'], [string, Tone]> = { proposed: ['제안', 'warn'], approved: ['승인', 'info'], released: ['출시됨', 'progress'], observing: ['관찰 중', 'progress'], concluded: ['결론', 'ok'], rolled_back: ['원복', 'neutral'] };
const SEVERITY: Record<IssuePriority['severity'], [string, Tone]> = { low: ['낮음', 'neutral'], medium: ['보통', 'info'], high: ['높음', 'warn'], critical: ['치명적', 'error'] };
const TREND: Record<IssuePriority['trend'], string> = { rising: '증가', stable: '유지', falling: '감소', new: '신규' };
const FIT: Record<IssuePriority['strategicFit'], string> = { unknown: '미평가', low: '낮음', medium: '보통', high: '높음' };
const SENTIMENT: Record<FeedbackItem['sentiment'], string> = { negative: '부정', neutral: '중립', positive: '긍정' };
const AUDIT: Record<IssueCluster['audit'][number]['action'], string> = { created: '생성', added: '추가', merged: '병합', split: '분리', confirmed: '확인', closed: '종료' };

export function FeedbackSection(props: SectionProps) {
  const { growth, projectId, reload } = props;
  const act = useGrowthAction(reload);
  const [showMerged, setShowMerged] = useState(false);
  const all = growth.clusters.filter(item => item.projectId === projectId);
  const order: IssueCluster['status'][] = ['candidate', 'confirmed', 'split', 'closed', 'merged'];
  const clusters = all.filter(item => showMerged || item.status !== 'merged').sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.priority.frequency - a.priority.frequency);
  return <>
    <Card title="피드백 이슈" icon={Bug} actions={<label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={showMerged} onChange={event => setShowMerged(event.target.checked)} />병합된 이슈 표시</label>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>같은 오류 코드·증상·버전·플랫폼처럼 설명 가능한 키로만 자동으로 묶고, 애매한 유사 이슈는 후보로만 보여 줍니다. 우선순위는 하나의 점수로 합치지 않고 차원별로 표시합니다.</p>
        <ActionFeedback act={act} />
        {clusters.length === 0 ? <EmptyState icon={Bug} title="이슈가 없습니다" description="피드백 정리 위임이 실행되면 수집한 피드백을 이슈 후보로 묶어 표시합니다." />
          : <div className="item-list">{clusters.map(cluster => <ClusterRow key={cluster.id} {...props} cluster={cluster} act={act} />)}</div>}
      </div>
    </Card>
    <LinksCard {...props} act={act} />
  </>;
}

function Priority({ priority, currency }: { priority: IssuePriority; currency?: string }) {
  return <Dl items={[
    ['빈도', `${priority.frequency}건`],
    ['영향 사용자', `${priority.affectedUsers}명(작성자 기준)`],
    ['수익 영향', priority.revenueImpactMicros === null ? '추정 불가' : formatMicros(priority.revenueImpactMicros, currency ?? 'USD')],
    ['심각도', <Badge key="s" tone={SEVERITY[priority.severity][1]}>{SEVERITY[priority.severity][0]}</Badge>],
    ['재현 신뢰도', `${Math.round(priority.reproConfidence * 100)}%`],
    ['추세', TREND[priority.trend]],
    ['전략 적합도', FIT[priority.strategicFit]],
  ]} />;
}

function ClusterRow({ state, growth, projectId, cluster, act }: SectionProps & { cluster: IssueCluster; act: GrowthAction }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [hypothesis, setHypothesis] = useState('');
  const items = growth.feedback.filter(item => cluster.itemIds.includes(item.id));
  const title = (id: string) => growth.clusters.find(item => item.id === id)?.title ?? id.slice(0, 8);
  const keyParts = Object.entries(cluster.keyParts).filter(([, value]) => value).map(([key, value]) => `${{ symptomKey: '증상', errorCode: '오류 코드', appVersion: '버전', platform: '플랫폼' }[key] ?? key}: ${value}`);
  const currency = state.projects.find(item => item.id === projectId)?.policy.currency;
  const editable = cluster.status !== 'merged' && cluster.status !== 'closed';
  return <div className="item-row">
    <div className="item-row__main stack" style={{ gap: 8 }}>
      <div className="item-row__title row" style={{ gap: 8 }}>
        <Badge tone={CLUSTER_STATUS[cluster.status][1]}>{CLUSTER_STATUS[cluster.status][0]}</Badge><span>{cluster.title}</span>
        <span className="small muted">피드백 {cluster.itemIds.length}건 · {formatDateTime(cluster.updatedAt)}</span>
        {cluster.mergedInto && <span className="small muted">→ {title(cluster.mergedInto)}에 병합</span>}
      </div>
      <div className="small">묶음 키: {keyParts.length ? keyParts.join(' · ') : <span className="muted">없음(설명 가능한 키가 부족해 자동 병합하지 않음)</span>}</div>
      <Priority priority={cluster.priority} currency={currency} />
      {cluster.candidates.length > 0 && editable && <div className="action-group"><span className="action-group__title">유사 이슈 후보 — 자동 병합하지 않았습니다</span>
        {cluster.candidates.map(candidate => <div key={candidate.clusterId} className="row row--between">
          <span className="small">{title(candidate.clusterId)} · 유사도 {Math.round(candidate.similarity * 100)}% · {candidate.reason}</span>
          <ReasonAction label="이 이슈로 병합" placeholder="병합 사유(필수)" required disabled={!!act.pending} onSubmit={reason => act.run('merge-clusters', { targetId: cluster.id, sourceId: candidate.clusterId, reason }, '이슈를 병합했습니다.')} />
        </div>)}
      </div>}
      <details><summary>피드백 {items.length}건{selected.length ? ` · ${selected.length}건 선택` : ''}</summary>
        <div className="stack" style={{ gap: 4, marginTop: 6 }}>{items.map(item => <label key={item.id} className="checkbox-row">
          {editable && <input type="checkbox" checked={selected.includes(item.id)} onChange={() => setSelected(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])} aria-label="분리할 피드백 선택" />}
          <span className="small"><span className={item.deletedAt ? 'muted' : undefined} style={item.deletedAt ? { textDecoration: 'line-through' } : undefined}>{item.excerpt}</span>
            <span className="muted"> · {SENTIMENT[item.sentiment]} · {item.language}{item.appVersion ? ` · v${item.appVersion}` : ''}{item.platform ? ` · ${item.platform}` : ''}{item.errorCode ? ` · ${item.errorCode}` : ''} · {formatDateTime(item.occurredAt)}{item.deletedAt ? ' · 원문 삭제됨' : ''}</span></span>
        </label>)}</div>
        {editable && selected.length > 0 && selected.length < items.length && <ReasonAction label="선택 항목 분리" placeholder="분리 사유(필수)" required disabled={!!act.pending} onSubmit={reason => act.run('split-cluster', { id: cluster.id, itemIds: selected, reason }, '선택한 피드백을 새 이슈로 분리했습니다.').then(result => { if (result) setSelected([]); return result; })} />}
      </details>
      <details><summary>감사 기록 {cluster.audit.length}건</summary><ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{cluster.audit.map((entry, index) => <li key={index}>{formatDateTime(entry.at)} · {AUDIT[entry.action]} · {entry.reason}{entry.itemIds?.length ? ` (${entry.itemIds.length}건)` : ''}</li>)}</ul></details>
      {cluster.status === 'confirmed' && <form className="row" onSubmit={event => { event.preventDefault(); if (hypothesis.trim()) void act.run('propose-product-link', { clusterId: cluster.id, hypothesis: hypothesis.trim() }, '제품 개선 가설을 제안했습니다. 승인 메모와 함께 승인하세요.').then(result => { if (result) setHypothesis(''); }); }}>
        <input className="input" style={{ flex: 1, minWidth: 240 }} aria-label="제품 개선 가설" placeholder="제품 개선 가설: 예) 로그인 재시도 로직을 고치면 부정 피드백이 줄어든다" maxLength={1000} value={hypothesis} onChange={event => setHypothesis(event.target.value)} />
        <button type="submit" className="btn btn--sm" disabled={!!act.pending || !hypothesis.trim()}><Lightbulb size={14} />가설 제안</button>
      </form>}
    </div>
    <div className="item-row__actions">
      {cluster.status === 'candidate' && <ReasonAction label="이슈 확인" placeholder="확인 사유(선택)" disabled={!!act.pending} onSubmit={reason => act.run('confirm-cluster', { id: cluster.id, ...(reason ? { reason } : {}) }, '이슈를 확인했습니다.')} />}
      <AskAi projectId={projectId} kind="cluster" id={cluster.id} label={`이슈: ${cluster.title}`} record={cluster} />
    </div>
  </div>;
}

function LinksCard({ growth, projectId, act }: SectionProps & { act: GrowthAction }) {
  const links = growth.productLinks.filter(item => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cluster = (id: string) => growth.clusters.find(item => item.id === id);
  return <Card title="제품 개선 연결" icon={Lightbulb}>
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>확인한 이슈의 개선 가설을 승인하고, 공개가 확인된 출시와 연결해 출시 전후 피드백을 비교합니다. 다른 출시가 섞인 기간은 인과 판단에 쓰지 않습니다.</p>
      {links.length === 0 ? <EmptyState icon={Lightbulb} title="제품 개선 연결이 없습니다" description="확인된 이슈에서 개선 가설을 제안하세요." />
        : <div className="item-list">{links.map(link => { const source = cluster(link.clusterId); return <div key={link.id} className="item-row">
          <div className="item-row__main stack" style={{ gap: 6 }}>
            <div className="item-row__title row" style={{ gap: 8 }}><Badge tone={LINK_STATUS[link.status][1]}>{LINK_STATUS[link.status][0]}</Badge><span>{link.hypothesis}</span></div>
            <Dl items={[
              ['이슈', source?.title ?? link.clusterId.slice(0, 8)],
              link.approvalNote && ['승인 메모', `${link.approvalNote} (${formatDateTime(link.approvedAt)})`],
              link.releaseVersion && ['출시', `${link.releaseVersion} · ${formatDateTime(link.releasedAt)} · 관측 ${link.releaseObservationId?.slice(0, 12)}`],
              link.baseline && ['출시 전 기간', `${formatDateTime(link.baseline.from)} ~ ${formatDateTime(link.baseline.to)}`],
              link.observation && ['출시 후 기간', `${formatDateTime(link.observation.from)} ~ ${formatDateTime(link.observation.to)}`],
              link.result && ['부정 피드백', `${link.result.negativeFeedbackBefore}건 → ${link.result.negativeFeedbackAfter}건`],
              link.experimentId && ['연결 실험', link.experimentId.slice(0, 8)],
              link.previousLinkId && ['이전 연결', link.previousLinkId.slice(0, 8)],
            ]} />
            {link.result?.mixedCohort && <Notice tone="warn" title="다른 출시가 섞인 기간">관찰 기간에 다른 출시가 있어 이 개선의 효과로 단정할 수 없습니다.</Notice>}
            {link.result?.note && <div className="small">{link.result.note}</div>}
          </div>
          <div className="item-row__actions">
            {link.status === 'proposed' && <ReasonAction label="승인" placeholder="승인 메모(필수)" required disabled={!!act.pending} onSubmit={note => act.run('approve-product-link', { id: link.id, note }, '제품 개선 가설을 승인했습니다.')} />}
            {link.status === 'approved' && <ReleasePicker link={link} releases={growth.releases} act={act} />}
            <AskAi projectId={projectId} kind="product-link" id={link.id} label={`제품 개선: ${link.hypothesis.slice(0, 60)}`} record={link} />
          </div>
        </div>; })}</div>}
      {links.some(link => link.status === 'approved') && <span className="small muted">공개가 확인된 이 프로젝트의 출시 중 승인 이후에 나간 것만 연결할 수 있습니다.</span>}
    </div>
  </Card>;
}

/** 공개가 확인되고 승인 이후에 나간 같은 프로젝트 출시만 고를 수 있다(서버 규칙과 같음). */
function ReleasePicker({ link, releases, act }: { link: ProductExperimentLink; releases: GrowthState['releases']; act: GrowthAction }) {
  const uid = useId();
  const candidates = releases.filter(item => item.projectId === link.projectId && item.published && item.publishedAt && (!link.approvedAt || item.publishedAt >= link.approvedAt))
    .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!));
  const [releaseId, setReleaseId] = useState('');
  if (!candidates.length) return <span className="small muted">승인 이후 공개된 출시가 아직 없습니다.</span>;
  return <form className="row" style={{ gap: 6 }} onSubmit={event => { event.preventDefault(); if (releaseId) void act.run('attach-release', { id: link.id, releaseObservationId: releaseId }, '출시를 연결했습니다. 출시 전후 피드백을 관찰합니다.'); }}>
    <label className="sr-caption" htmlFor={`${uid}-release`}>연결할 출시</label>
    <select id={`${uid}-release`} className="select" value={releaseId} onChange={event => setReleaseId(event.target.value)}>
      <option value="">출시 선택</option>
      {candidates.map(item => <option key={item.id} value={item.id}>{item.version} · {providerLabel(item.provider)} · {formatDateTime(item.publishedAt)}</option>)}
    </select>
    <button type="submit" className="btn btn--sm" disabled={!!act.pending || !releaseId}>출시 연결</button>
  </form>;
}
