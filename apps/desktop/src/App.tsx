// 앱 셸: 남색 사이드바 + 상단바 + 콘텐츠. 간단한 상태 기반 라우팅.
import { useMemo, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  BadgeDollarSign,
  ClipboardCheck,
  FolderKanban,
  History,
  LayoutDashboard,
  Megaphone,
  PlugZap,
  RefreshCw,
  Rocket,
  ServerCog,
  Settings2,
  UploadCloud,
  Users,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useAppState } from './appState';
import { formatRelative } from './format';
import { Spinner } from './components/ui';
import { DashboardView } from './views/DashboardView';
import { ProjectsView } from './views/ProjectsView';
import { ConnectionsView } from './views/ConnectionsView';
import { ReleasesView } from './views/ReleasesView';
import { MarketingView } from './views/MarketingView';
import { MonetizationView } from './views/MonetizationView';
import { CommunityView } from './views/CommunityView';
import { OperationsView } from './views/OperationsView';
import { SetupView } from './views/SetupView';
import { OperationNotifications } from './components/OperationNotifications';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { ModeControl } from './components/ModeControl';
import type { AppState } from '../../../packages/domain';

export type ViewKey =
  | 'dashboard'
  | 'setup'
  | 'projects'
  | 'connections'
  | 'releases'
  | 'marketing'
  | 'monetization'
  | 'community'
  | 'operations'
  | 'history'
  | 'settings';

interface NavDef {
  key: ViewKey;
  label: string;
  icon: LucideIcon;
  desc: string;
  count?: (s: AppState) => number;
  alert?: (s: AppState) => number;
}

const NAV: NavDef[] = [
  {
    key: 'dashboard',
    label: '대시보드',
    icon: LayoutDashboard,
    desc: '출시·활동·수익 개요와 조치가 필요한 항목',
  },
  {
    key: 'setup',
    label: '운영 준비',
    icon: ClipboardCheck,
    desc: '엔진·SDK 설치, 프로젝트별 준비 점검, 스토어 앱·연동, 앱·제어 서비스 수명주기',
  },
  {
    key: 'projects',
    label: '프로젝트',
    icon: FolderKanban,
    desc: '폴더 등록·검수·빌드 실행과 실행 정책',
    count: (s) => s.projects.length,
  },
  {
    key: 'connections',
    label: '계정 연결',
    icon: PlugZap,
    desc: '스토어·광고·수익화 계정을 최초 1회 연결하고 상태를 관리',
    count: (s) => s.connections.length,
    alert: (s) =>
      s.connections.filter((c) => c.status === 'action_required' || c.status === 'permission_required').length,
  },
  {
    key: 'releases',
    label: '스토어 배포',
    icon: UploadCloud,
    desc: '빌드 업로드와 스토어 등록·심사·공개 상태',
    count: (s) => s.resources.filter((r) => r.kind === 'release').length,
  },
  {
    key: 'marketing',
    label: '마케팅',
    icon: Megaphone,
    desc: 'Google Ads·AppLovin 캠페인·소재·예산·성과',
    count: (s) => s.resources.filter((r) => r.kind === 'campaign').length,
  },
  {
    key: 'monetization',
    label: '수익화',
    icon: BadgeDollarSign,
    desc: '광고 단위·미디에이션, 상품·구독, 수익 집계',
    count: (s) => s.resources.filter((r) => r.kind === 'ad-unit' || r.kind === 'product').length,
  },
  {
    key: 'community',
    label: '커뮤니티',
    icon: Users,
    desc: 'X · Threads · Steam 게시물·답글·뉴스와 예약·자동화',
    count: (s) => s.resources.filter((r) => r.kind === 'post' || r.kind === 'mention' || r.kind === 'news').length,
  },
  {
    key: 'operations',
    label: '운영·복구',
    icon: ServerCog,
    desc: '러너·준비 상태·백업/복구·설정·진단',
  },
  {
    key: 'history',
    label: '이력',
    icon: History,
    desc: '작업·외부 변경·알림의 전체 타임라인',
    count: (s) => s.runs.length,
  },
  {
    key: 'settings',
    label: '환경·정책',
    icon: Settings2,
    desc: '런타임·보관함·도구 체인·연동 기능 설정',
  },
];

const NAV_BY_KEY = Object.fromEntries(NAV.map((n) => [n.key, n])) as Record<ViewKey, NavDef>;

export function App() {
  // 실행 모드 권한은 네이티브에서 main이 소유하고 부트스트랩으로 확정되며, 이 세션 동안 불변이다
  // (전환=전체 새로고침). mode는 그 확정된 클라이언트 모드(api.getMode())를 반영한다. 전환/확인은
  // ModeControl이 담당하고, 그동안의 오버레이는 로컬 switching으로 표시한다.
  const { state, phase, refresh, refreshing, lastUpdatedAt, error, mode } = useAppState();
  const [view, setView] = useState<ViewKey>('dashboard');
  const [switching, setSwitching] = useState(false);

  const actionRequiredCount = useMemo(() => {
    if (!state) return 0;
    const conn = state.connections.filter(
      (c) => c.status === 'action_required' || c.status === 'permission_required',
    ).length;
    const runs = state.runs.filter((r) => r.status === 'action_required').length;
    return conn + runs;
  }, [state]);

  const current = NAV_BY_KEY[view];

  return (
    <div className="app-shell">
      <OperationNotifications state={state} />
      {switching && (
        <div className="switch-overlay" role="status" aria-live="polite">
          <Spinner large />
          <span>모드 전환 중…</span>
        </div>
      )}
      <aside className="sidebar" aria-label="주 메뉴">
        <div className="sidebar__brand">
          <div className="sidebar__brand-mark" aria-hidden>
            <Rocket size={17} />
          </div>
          <div className="sidebar__brand-text">
            <span className="sidebar__brand-title">gameStudioAutomaiton</span>
            <span className="sidebar__brand-sub">출시 · 마케팅 · 수익화</span>
          </div>
        </div>
        <nav className="sidebar__nav">
          {NAV.map((item) => {
            const count = state && item.count ? item.count(state) : undefined;
            const alert = state && item.alert ? item.alert(state) : 0;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className="nav-item"
                aria-current={view === item.key ? 'page' : undefined}
                onClick={() => setView(item.key)}
              >
                <Icon size={16} aria-hidden />
                <span>{item.label}</span>
                {alert && alert > 0 ? (
                  <span className="nav-item__count nav-item__count--alert" title="사용자 조치 필요">
                    {alert}
                  </span>
                ) : count !== undefined && count > 0 ? (
                  <span className="nav-item__count">{count}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
        <div className="sidebar__footer">
          <ConnectionIndicator phase={phase} />
          {state && (
            <>
              <span>
                {state.runtime.platform} · v{state.runtime.version}
              </span>
              <code title={state.runtime.dataDirectory}>{state.runtime.dataDirectory}</code>
            </>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1 className="topbar__title">{current.label}</h1>
            <p className="topbar__desc">{current.desc}</p>
          </div>
          <div className="topbar__spacer" />
          <div className="topbar__meta">
            <ModeControl mode={mode} serverMode={state?.runtime.mode} setSwitching={setSwitching} />
            {actionRequiredCount > 0 && (
              <span className="badge badge--error" title="사용자 조치가 필요한 항목">
                <AlertOctagon size={13} /> 조치 필요 {actionRequiredCount}
              </span>
            )}
            {lastUpdatedAt && <span className="nowrap">갱신 {formatRelative(new Date(lastUpdatedAt).toISOString())}</span>}
            <button
              className="btn btn--sm"
              onClick={() => void refresh()}
              disabled={refreshing}
              aria-label="새로고침"
            >
              {refreshing ? <Spinner /> : <RefreshCw size={14} />}
              새로고침
            </button>
          </div>
        </header>

        <main className="content">
          <ViewRouter
            view={view}
            state={state}
            phase={phase}
            error={error?.message ?? null}
            refresh={refresh}
            goTo={setView}
          />
        </main>
      </div>
    </div>
  );
}

function ConnectionIndicator({ phase }: { phase: 'connecting' | 'ready' | 'error' }) {
  if (phase === 'ready') {
    return (
      <span className="row" style={{ gap: 7 }}>
        <span className="conn-dot conn-dot--ok" /> <Wifi size={12} /> 제어 서비스 연결됨
      </span>
    );
  }
  if (phase === 'connecting') {
    return (
      <span className="row" style={{ gap: 7 }}>
        <span className="conn-dot conn-dot--wait" /> 제어 서비스 연결 중…
      </span>
    );
  }
  return (
    <span className="row" style={{ gap: 7 }}>
      <span className="conn-dot conn-dot--bad" /> <WifiOff size={12} /> 연결 오류
    </span>
  );
}

function ViewRouter({
  view,
  state,
  phase,
  error,
  refresh,
  goTo,
}: {
  view: ViewKey;
  state: AppState | null;
  phase: 'connecting' | 'ready' | 'error';
  error: string | null;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
}) {
  // 최초 연결/로딩 처리는 각 뷰가 state 유무로 판단한다. 공용 게이트만 여기서 둔다.
  if (!state) {
    return (
      <div className="stack">
        {phase === 'error' ? (
          <div className="notice notice--error" role="alert">
            <AlertOctagon size={18} />
            <div className="notice__body">
              <div className="notice__title">제어 서비스에 연결할 수 없습니다</div>
              {error ?? '알 수 없는 오류입니다.'}
              <div style={{ marginTop: 10 }}>
                <button className="btn btn--sm" onClick={() => void refresh()}>
                  <RefreshCw size={14} /> 다시 시도
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="loading-block">
            <Spinner large /> 제어 서비스에 연결하는 중…
          </div>
        )}
      </div>
    );
  }

  switch (view) {
    case 'dashboard':
      return <DashboardView state={state} refresh={refresh} goTo={goTo} />;
    case 'setup':
      return <SetupView state={state} refresh={refresh} goTo={goTo} />;
    case 'projects':
      return <ProjectsView state={state} refresh={refresh} goTo={goTo} />;
    case 'connections':
      return <ConnectionsView state={state} refresh={refresh} />;
    case 'releases':
      return <ReleasesView state={state} refresh={refresh} goTo={goTo} />;
    case 'marketing':
      return <MarketingView state={state} refresh={refresh} goTo={goTo} />;
    case 'monetization':
      return <MonetizationView state={state} refresh={refresh} goTo={goTo} />;
    case 'community':
      return <CommunityView state={state} refresh={refresh} goTo={goTo} />;
    case 'operations':
      return <OperationsView state={state} refresh={refresh} goTo={goTo} />;
    case 'history':
      return <HistoryView state={state} refresh={refresh} />;
    case 'settings':
      return <SettingsView state={state} refresh={refresh} />;
    default:
      return null;
  }
}
