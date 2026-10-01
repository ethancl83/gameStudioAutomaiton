// 최근 24시간 묶음 요약. 집계는 서버 digest를 그대로 쓰고, 조치 필요 항목은 해당 기록으로 이동한다.
import { ListChecks } from 'lucide-react';
import type { GrowthDigest, GrowthState } from '../../../../../packages/growth/types';
import { formatDateTime } from '../../format';
import { Card } from '../../components/ui';
import { ReasonList } from './shared';

export type GrowthTab = 'overview' | 'experiments' | 'pricing' | 'community' | 'feedback' | 'knowledge';
type Item = GrowthDigest['actionRequired'][number];

const KIND: Record<Item['kind'], { label: string; tab: GrowthTab; prefix: string }> = {
  mandate: { label: '위임', tab: 'overview', prefix: 'growth-mandate-' },
  experiment: { label: '실험', tab: 'experiments', prefix: 'growth-experiment-' },
  pricing: { label: '가격', tab: 'pricing', prefix: 'growth-pricing-' },
  incident: { label: '답글 사고', tab: 'community', prefix: 'growth-incident-' },
  escalation: { label: '사람 확인', tab: 'community', prefix: 'growth-response-' },
};
const OUTCOME_LABELS: Record<string, string> = { continue: '계속', winner: '승자', no_effect: '효과 없음', inconclusive: '결론 없음', stop_guardrail: '보호 지표 중지', stop_loss: '손실 중지', blocked: '보류', invalidated: '무효화', observational_only: '관찰 비교' };
const PRICING_LABELS: Record<string, string> = { proposed: '제안', approval_required: '승인 필요', queued: '대기열', applied: '적용', observing: '관찰', kept: '유지', rolling_back: '원복 중', rolled_back: '원복', blocked: '차단', failed: '실패', action_required: '조치 필요' };

/** 조치 필요 항목의 이동 대상(탭과 요소 id). */
export function digestTarget(item: Item): { tab: GrowthTab; elementId: string } {
  return { tab: KIND[item.kind].tab, elementId: KIND[item.kind].prefix + item.id };
}

function Counts({ label, counts, names }: { label: string; counts: Record<string, number>; names?: Record<string, string> }) {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  return <div className="small"><strong>{label}</strong> {entries.length ? entries.map(([key, value]) => <span key={key} className="tag">{names?.[key] ?? key} {value}</span>) : <span className="muted">없음</span>}</div>;
}

export function DigestCard({ growth, projectId, onOpen }: { growth: GrowthState; projectId: string; onOpen: (target: { tab: GrowthTab; elementId: string }) => void }) {
  const digest = growth.digest;
  const items = digest.actionRequired.filter(item => item.projectId === projectId);
  const others = digest.actionRequired.length - items.length;
  const mandateIds = new Set(growth.mandates.filter(item => item.projectId === projectId).map(item => item.id));
  const blockers = digest.blockers.filter(item => mandateIds.has(item.mandateId));
  const community = digest.community;
  return <Card title="최근 24시간 요약" icon={ListChecks} actions={<span className="small muted">{formatDateTime(digest.from)} ~ {formatDateTime(digest.to)}</span>}>
    <div className="stack" style={{ gap: 10 }}>
      <p className="small muted" style={{ margin: 0 }}>결정·응대·가격 건수는 전체 프로젝트 집계이며 작성자·원문을 담지 않습니다. 조치 필요 항목은 선택한 프로젝트 것만 표시합니다.</p>
      <Counts label="실험 결정" counts={digest.decisions} names={OUTCOME_LABELS} />
      <div className="small"><strong>고객응대</strong> {community.total}건 · 사람 확인 {community.escalations.open}건{community.escalations.overdue ? ` (기한 초과 ${community.escalations.overdue})` : ''} · 근거 부족 {community.lowEvidence}건</div>
      <Counts label="가격 변경" counts={digest.pricing} names={PRICING_LABELS} />
      {items.length > 0 ? <div className="action-group">
        <span className="action-group__title">조치 필요 {items.length}건{others > 0 ? ` · 다른 프로젝트 ${others}건` : ''}</span>
        <ul style={{ margin: 0, paddingLeft: 18 }}>{items.map(item => <li key={`${item.kind}:${item.id}`} className="small" style={{ marginBottom: 4 }}>
          <button type="button" className="btn btn--xs btn--ghost" onClick={() => onOpen(digestTarget(item))}>{KIND[item.kind].label} 보기</button> {item.reason}
        </li>)}</ul>
      </div> : <div className="small muted">이 프로젝트에 조치가 필요한 항목이 없습니다.{others > 0 ? ` 다른 프로젝트에 ${others}건이 있습니다.` : ''}</div>}
      {blockers.length > 0 && <div className="action-group"><span className="action-group__title">주기 차단 사유</span>
        {blockers.map(blocker => <div key={blocker.mandateId} className="small">
          <button type="button" className="btn btn--xs btn--ghost" onClick={() => onOpen({ tab: 'overview', elementId: 'growth-mandate-' + blocker.mandateId })}>위임 보기</button>
          <ReasonList reasons={blocker.reasons} />
        </div>)}
      </div>}
    </div>
  </Card>;
}
