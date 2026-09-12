// 대시보드: 초기 화면. 프로젝트·출시·활동·수익을 한 화면에서 조밀하게 개괄한다.
// 모든 값은 제어 서비스 /state 에서 오며 화면이 임의로 만들지 않는다. 미수집은 0이 아니라 미수집으로 표시한다.
import {
  Activity,
  BadgeDollarSign,
  FolderKanban,
  Megaphone,
  PlugZap,
  Rocket,
  TrendingDown,
  TrendingUp,
  UploadCloud,
  Wallet,
} from 'lucide-react';
import { TARGET_LABELS, formatMicros, formatRelative, providerLabel } from '../format';
import { Badge, Card, EmptyState, Stat } from '../components/ui';
import { PIPELINE_STATUS_META } from './pipelineMeta';
import type { ViewKey } from '../App';
import type { AppState } from '../../../../packages/domain';

export function DashboardView({
  state,
  goTo,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
}) {
  const demo = state.runtime.mode === 'demo';

  const activeRuns = state.runs.filter(
    (r) => r.status === 'queued' || r.status === 'running' || r.status === 'retry_wait' || r.status === 'waiting_external',
  );
  const actionRuns = state.runs.filter((r) => r.status === 'action_required');
  const attentionConns = state.connections.filter(
    (c) => c.status === 'action_required' || c.status === 'permission_required',
  );
  const pipelines = state.pipelines ?? [];
  const activePipelines = pipelines.filter(
    (p) => p.status === 'building' || p.status === 'uploading' || p.status === 'action_required',
  );
  const releases = state.resources.filter((r) => r.kind === 'release');
  // 진짜 활성 캠페인만 센다(일시중지·종료·삭제·초안 제외).
  const activeCampaigns = state.resources.filter((r) => r.kind === 'campaign' && isActiveCampaignStatus(r.status));

  // 활동: 최근 이벤트와 작업을 시간순으로 합쳐 상위 항목을 보여준다.
  const recentEvents = [...state.events].sort((a, b) => b.id - a.id).slice(0, 8);
  const recentRuns = [...state.runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 6);

  return (
    <div className="stack">
      <div className="grid grid--stats">
        <Stat label="프로젝트" value={state.projects.length} icon={FolderKanban} sub="등록된 게임·앱" />
        <Stat
          label="연결된 계정"
          value={state.connections.length}
          icon={PlugZap}
          sub={attentionConns.length > 0 ? `${attentionConns.length}건 조치 필요` : '모두 정상'}
        />
        <Stat
          label="진행 중 작업"
          value={activeRuns.length}
          icon={Activity}
          sub={actionRuns.length > 0 ? `${actionRuns.length}건 조치 필요` : '대기·실행 중'}
        />
        <Stat
          label="출시 파이프라인"
          value={activePipelines.length}
          icon={Rocket}
          sub={`전체 ${pipelines.length}건`}
        />
        <Stat label="활성 캠페인" value={activeCampaigns.length} icon={Megaphone} sub="집행 중(일시중지 제외)" />
      </div>

      <div className="grid grid--split-wide">
        <div className="stack">
          <Card
            title="출시 파이프라인"
            icon={Rocket}
            actions={
              <button className="btn btn--sm" onClick={() => goTo('releases')}>
                <UploadCloud size={13} /> 배포로 이동
              </button>
            }
            flush
          >
            {pipelines.length === 0 ? (
              <div style={{ padding: '8px 0' }}>
                <EmptyState
                  icon={Rocket}
                  title="진행 중인 출시가 없습니다"
                  description="프로젝트에서 출시를 시작하면 결과물 확인→스토어 업로드 진행이 여기에 표시됩니다."
                />
              </div>
            ) : (
              <div className="table__scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>프로젝트</th>
                      <th>타깃</th>
                      <th>상태</th>
                      <th>갱신</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipelines.slice(0, 6).map((p) => {
                      const project = state.projects.find((x) => x.id === p.projectId);
                      const meta = PIPELINE_STATUS_META[p.status];
                      return (
                        <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => goTo('releases')}>
                          <td style={{ fontWeight: 550 }}>{project?.name ?? p.projectId}</td>
                          <td>
                            <span className="tag">{TARGET_LABELS[p.target] ?? p.target}</span>
                          </td>
                          <td>
                            <Badge tone={meta.tone}>{meta.label}</Badge>
                          </td>
                          <td className="small nowrap">{formatRelative(p.updatedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="최근 활동" icon={Activity} flush>
            {recentEvents.length === 0 && recentRuns.length === 0 ? (
              <div style={{ padding: '8px 0' }}>
                <EmptyState icon={Activity} title="활동 기록이 없습니다" description="작업·외부 변경·알림이 발생하면 시간순으로 누적됩니다." />
              </div>
            ) : (
              <ul className="activity">
                {recentEvents.map((e) => (
                  <li key={`e-${e.id}`} className="activity__row">
                    <span className="activity__dot" data-level={e.level} aria-hidden />
                    <span className="activity__msg">{e.message}</span>
                    <span className="activity__time small nowrap">{formatRelative(e.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="stack">
          <RevenueOverview state={state} goTo={goTo} />

          <Card
            title="스토어 출시 현황"
            icon={UploadCloud}
            actions={
              <button className="btn btn--sm" onClick={() => goTo('releases')}>
                자세히
              </button>
            }
          >
            {releases.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                가져온 출시 항목이 없습니다. 스토어 연결에서 출시 상태를 조회하세요.
              </p>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {releases.slice(0, 5).map((r) => (
                  <div key={r.id} className="row row--between" style={{ gap: 8 }}>
                    <span className="small" style={{ fontWeight: 550, minWidth: 0 }}>
                      <span className="truncate" style={{ display: 'inline-block', maxWidth: 180 }} title={r.name}>
                        {r.name}
                      </span>
                      <span className="muted"> · {providerLabel(r.provider)}</span>
                    </span>
                    <Badge tone="neutral">{r.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="최근 작업" icon={Activity} flush>
            {recentRuns.length === 0 ? (
              <p className="small muted" style={{ margin: 0, padding: '12px 18px' }}>
                실행한 작업이 없습니다.
              </p>
            ) : (
              <ul className="activity">
                {recentRuns.map((r) => (
                  <li key={`r-${r.id}`} className="activity__row" style={{ cursor: 'pointer' }} onClick={() => goTo('history')}>
                    <span className="activity__msg small">{r.label || r.kind}</span>
                    <RunDot status={r.status} />
                    <span className="activity__time small nowrap">{formatRelative(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {demo && (
        <p className="small faint" style={{ margin: 0 }}>
          데모 미리보기입니다. 표시된 연결·프로젝트·지표는 시드 데이터이며 실제 공급자에 전송되지 않습니다. 머리말의
          모드 전환으로 실제 계정 모드로 바꿀 수 있습니다.
        </p>
      )}
    </div>
  );
}

function RunDot({ status }: { status: string }) {
  const ok = status === 'succeeded';
  const bad = status === 'failed' || status === 'action_required';
  const label = ok ? '성공' : bad ? '주의' : '진행';
  return <span className={`tag ${ok ? 'tag--ok' : bad ? 'tag--bad' : ''}`}>{label}</span>;
}

function RevenueOverview({ state, goTo }: { state: AppState; goTo: (v: ViewKey) => void }) {
  const metrics = state.metrics;
  if (metrics.length === 0) {
    return (
      <Card title="수익 개요" icon={Wallet}>
        <p className="small muted" style={{ margin: 0 }}>
          아직 수집된 집계가 없습니다. 값이 없는 항목은 0이 아니라 <strong>미수집</strong>입니다. 수익화 화면에서 계정을
          동기화하면 통화별 수익·광고비가 표시됩니다.
        </p>
        <div style={{ marginTop: 12 }}>
          <button className="btn btn--sm" onClick={() => goTo('monetization')}>
            <BadgeDollarSign size={13} /> 수익화로 이동
          </button>
        </div>
      </Card>
    );
  }
  return (
    <Card title="수익 개요 (통화별)" icon={Wallet}>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        기여이익 = 수익 − 광고비(같은 기준). 통화가 다른 값은 합산하지 않습니다.
      </p>
      <div className="stack" style={{ gap: 14 }}>
        {metrics.map((m) => (
          <div key={m.currency}>
            <div className="row row--between">
              <span className="section-title" style={{ margin: 0 }}>
                {m.currency}
                {m.estimated && <span className="tag" style={{ marginLeft: 8 }}>추정 포함</span>}
              </span>
              <span className="small row" style={{ gap: 5 }}>
                <span className="muted">기여이익</span>
                <strong>{formatMicros(m.contributionMicros, m.currency)}</strong>
              </span>
            </div>
            <div className="row" style={{ gap: 18, marginTop: 6 }}>
              <span className="small row" style={{ gap: 5, color: 'var(--ok)' }}>
                <TrendingUp size={13} /> <span className="muted">수익</span> {formatMicros(m.revenueMicros, m.currency)}
              </span>
              <span className="small row" style={{ gap: 5, color: 'var(--warn)' }}>
                <TrendingDown size={13} /> <span className="muted">광고비</span> {formatMicros(m.spendMicros, m.currency)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// 캠페인 상태가 '집행 중'인가. 공급자마다 문자열이 다르므로 활성 신호와 비활성 신호로 판정한다.
export function isActiveCampaignStatus(status: string): boolean {
  if (/paus|remov|stop|end|archiv|disabl|draft|pending|reject/i.test(status)) return false;
  return /enabl|activ|serv|run|live|공개|활성|집행/i.test(status);
}
