// 성장 운영: 사용자가 확정한 위임(범위·기간·한도) 안의 광고 실험·ROAS/순이익 ROI·고객응대·피드백 이슈.
// 화면 진입·새로고침은 조회만 하며 AI나 주기 작업을 시작하지 않는다. 쓰기는 모두 제어 서비스 /growth 계약을 거친다.
import { useEffect, useState } from 'react';
import { FolderKanban, PauseCircle, TrendingUp } from 'lucide-react';
import type { AppState } from '../../../../packages/domain';
import { api, type GrowthState } from '../api';
import type { ViewKey } from '../App';
import { useAgentScope } from '../components/AgentActions';
import { Card, EmptyState, Field, LoadingBlock, Notice, Stat } from '../components/ui';
import { RUNNING_EXPERIMENTS, useGrowthAction, ActionFeedback } from './growth/shared';
import { OverviewSection } from './growth/Overview';
import { ExperimentsSection } from './growth/Experiments';
import { CommunitySection } from './growth/Community';
import { FeedbackSection } from './growth/Feedback';
import { KnowledgeSection } from './growth/Knowledge';
import { PricingSection } from './growth/Pricing';
import { DigestCard, type GrowthTab } from './growth/Digest';
import { growthStateRequests } from './growth/stateRequests';

type Tab = GrowthTab;
const TABS: Array<[Tab, string]> = [['overview', '개요·위임'], ['experiments', '실험·결정'], ['pricing', '수익화·가격'], ['community', '고객응대'], ['feedback', '피드백 이슈'], ['knowledge', '지식·환율']];
const POLL_MS = 5000;

export function GrowthView({ state, goTo }: { state: AppState; goTo: (view: ViewKey) => void }) {
  const [projectId, setProjectId] = useState(state.projects[0]?.id ?? '');
  const [tab, setTab] = useState<Tab>('overview');
  const [loaded, setLoaded] = useState<GrowthState | null>(null);
  const [loadError, setLoadError] = useState('');
  // 폴링·프로젝트 전환·작업 뒤 새로고침의 요청 순서는 growthStateRequests가 관리한다(setState 함수는 안정적이다).
  const [requests] = useState(() => growthStateRequests(target => api.growthState(target), result => {
    if (result.ok) { setLoaded(result.data); setLoadError(''); } else setLoadError(result.error.message);
  }, POLL_MS));
  // 이전 프로젝트 응답이 남아 있어도 선택한 프로젝트 범위 결과만 화면에 쓴다.
  const growth = loaded?.projectId === projectId ? loaded : null;
  // 요약의 조치 필요 항목에서 이동할 기록. 탭 렌더 뒤 해당 행으로 스크롤·포커스한다.
  const [focusId, setFocusId] = useState('');
  useEffect(() => {
    if (!focusId) return;
    const element = document.getElementById(focusId);
    if (element) { element.scrollIntoView({ block: 'center' }); element.focus(); }
    setFocusId('');
  }, [focusId, tab]);
  useAgentScope(projectId || undefined);

  const reload = requests.reload;
  // 선택 프로젝트만 조회·폴링하고, 전환·화면 해제 시 이전 폴링을 멈추고 늦게 온 이전 결과는 버린다.
  useEffect(() => { setLoadError(''); requests.select(projectId); return () => requests.select(''); }, [projectId, requests]);
  useEffect(() => { if (projectId && !state.projects.some(item => item.id === projectId)) setProjectId(state.projects[0]?.id ?? ''); }, [projectId, state.projects]);
  const resume = useGrowthAction(reload);

  if (!state.projects.length) return <Card><EmptyState icon={FolderKanban} title="등록된 프로젝트가 없습니다" description="성장 운영은 프로젝트별 정책과 위임으로 동작합니다. 먼저 프로젝트를 등록하세요."
    action={<button className="btn btn--primary" onClick={() => goTo('projects')}><FolderKanban size={15} /> 프로젝트로 이동</button>} /></Card>;

  const props = growth ? { state, growth, projectId, reload } : null;
  const mandates = growth?.mandates.filter(item => item.projectId === projectId) ?? [];
  const counts: Record<Tab, number> = growth ? {
    overview: mandates.filter(item => item.status === 'proposed').length,
    experiments: growth.experiments.filter(item => item.projectId === projectId && item.status === 'action_required').length,
    pricing: growth.pricing.filter(item => item.projectId === projectId && ['approval_required', 'action_required', 'failed'].includes(item.status)).length,
    community: growth.responses.filter(item => item.projectId === projectId && item.status === 'escalated').length + growth.incidents.filter(item => item.projectId === projectId && item.status !== 'resolved').length,
    feedback: growth.clusters.filter(item => item.projectId === projectId && item.status === 'candidate').length,
    knowledge: growth.knowledge.filter(item => item.projectId === projectId && item.status === 'draft').length,
  } : { overview: 0, experiments: 0, pricing: 0, community: 0, feedback: 0, knowledge: 0 };

  return <div className="stack">
    <div className="row row--between">
      <Field label="프로젝트" htmlFor="growth-project">
        <select id="growth-project" className="select" value={projectId} onChange={event => setProjectId(event.target.value)}>
          {state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </Field>
      {api.isDemo() && <span className="small muted">데모 모드: 데모 저장공간에만 기록하며 실제 계정에는 쓰지 않습니다.</span>}
    </div>

    {growth?.paused && <Notice tone="warn" title="백업 복원 후 성장 자동화가 멈춰 있습니다"
      action={<button className="btn btn--sm btn--primary" disabled={!!resume.pending} onClick={() => void resume.run('resume-growth', {}, '성장 운영 자동화를 다시 허용했습니다. 복원 전 위임은 중지 상태이므로 필요한 범위를 새로 확정하세요.')}><PauseCircle size={14} />다시 허용</button>}>
      복원한 상태에서는 외부 광고·가격·답글 변경을 만들지 않습니다. 계정 재연결과 정책을 확인한 뒤 다시 허용하세요. 다시 허용해도 복원 전 위임은 자동으로 재개되지 않습니다.
    </Notice>}
    <ActionFeedback act={resume} />
    {loadError && <Notice tone="error" title="성장 운영 상태를 불러오지 못했습니다" action={<button className="btn btn--sm" onClick={() => void reload()}>다시 시도</button>}>{loadError}</Notice>}

    {!growth ? !loadError && <LoadingBlock label="성장 운영 상태를 불러오는 중…" /> : <>
      <div className="grid grid--stats">
        <Stat icon={TrendingUp} label="실행 중 위임" value={mandates.filter(item => item.status === 'active').length} sub={`확정 대기 ${counts.overview}건`} />
        <Stat label="진행 중 실험" value={growth.experiments.filter(item => item.projectId === projectId && RUNNING_EXPERIMENTS.includes(item.status)).length} sub={`조치 필요 ${counts.experiments}건`} />
        <Stat label="사람 확인 필요 응답" value={growth.responses.filter(item => item.projectId === projectId && item.status === 'escalated').length} sub={`열린 사고 ${growth.incidents.filter(item => item.projectId === projectId && item.status !== 'resolved').length}건`} />
        <Stat label="확인 대기 이슈" value={counts.feedback} sub={`승인 대기 지식 ${counts.knowledge}건`} />
      </div>
      <DigestCard growth={growth} projectId={projectId} onOpen={target => { setTab(target.tab); setFocusId(target.elementId); }} />
      <div className="tabs" role="tablist" aria-label="성장 운영 영역">
        {TABS.map(([key, label]) => <button key={key} id={`growth-tab-${key}`} role="tab" className="tab" aria-selected={tab === key} aria-controls={`growth-panel-${key}`} tabIndex={tab === key ? 0 : -1}
          onClick={() => setTab(key)} onKeyDown={event => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            const index = TABS.findIndex(([item]) => item === tab); const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]![0];
            setTab(next); document.getElementById(`growth-tab-${next}`)?.focus();
          }}>{label}{counts[key] > 0 && <span className="tag tag--bad" style={{ marginLeft: 6 }} aria-label={`확인 필요 ${counts[key]}건`}>{counts[key]}</span>}</button>)}
      </div>
      <div role="tabpanel" id={`growth-panel-${tab}`} aria-labelledby={`growth-tab-${tab}`} className="stack">
        {props && tab === 'overview' && <OverviewSection {...props} />}
        {props && tab === 'experiments' && <ExperimentsSection {...props} />}
        {props && tab === 'pricing' && <PricingSection {...props} />}
        {props && tab === 'community' && <CommunitySection {...props} />}
        {props && tab === 'feedback' && <FeedbackSection {...props} />}
        {props && tab === 'knowledge' && <KnowledgeSection {...props} />}
      </div>
    </>}
  </div>;
}
