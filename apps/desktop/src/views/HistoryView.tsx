// 이력: 작업(Run)과 타임라인 이벤트의 전체 조회. 원인·결과를 한 곳에서 추적한다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, History, ListFilter } from 'lucide-react';
import { RUN_STATUS_META, SEVERITY_META, formatDateTime, formatRelative } from '../format';
import { Card, EmptyState, Notice, Spinner } from '../components/ui';
import { RunsTable } from '../components/runs';
import { SeverityBadge } from '../components/status';
import type { AppState, RunStatus, HistoryPage } from '../../../../packages/domain';
import { api } from '../api';

type Tab = 'runs' | 'timeline';

export function HistoryView({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('runs');
  const [statusFilter, setStatusFilter] = useState<RunStatus | ''>('');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [history, setHistory] = useState<HistoryPage>({ runs: [], events: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // 탭/필터가 바뀔 때마다 증가한다. 진행 중이던 첫 페이지·더보기 요청의 늦은 응답이
  // 새 필터의 결과에 섞이거나 이어붙지 않도록 세대 토큰으로 무효화한다.
  const reqGen = useRef(0);
  useEffect(() => {
    const gen = (reqGen.current += 1);
    setLoading(true); setError('');
    // 탭/필터가 바뀌면 이전 페이지를 즉시 비워 혼합된 목록이 잠깐도 보이지 않게 한다.
    setHistory({ runs: [], events: [], nextCursor: null });
    void api.historyQuery({ kind: tab === 'runs' ? 'runs' : 'events', projectId: projectFilter || undefined, status: statusFilter || undefined }).then(result => {
      if (gen !== reqGen.current) return; // 다른 필터/탭으로 바뀌었으면 이 응답을 버린다.
      if (result.ok) setHistory(result.data); else setError(result.error.message);
      setLoading(false);
    });
  }, [tab, projectFilter, statusFilter]);
  const mergedState = useMemo(() => ({ ...state,
    runs: [...new Map([...history.runs, ...state.runs].map(run => [run.id, run])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    events: [...new Map([...history.events, ...state.events].map(event => [event.id, event])).values()].sort((a, b) => b.id - a.id),
  }), [state, history]);
  async function loadMore() {
    if (!history.nextCursor || loading) return;
    const gen = reqGen.current;
    setLoading(true); setError('');
    const result = await api.historyQuery({ kind: tab === 'runs' ? 'runs' : 'events', before: history.nextCursor, projectId: projectFilter || undefined, status: statusFilter || undefined });
    if (gen !== reqGen.current) return; // 더보기 요청 도중 탭/필터가 바뀌면 이어붙이지 않는다.
    if (result.ok) setHistory(previous => ({ runs: [...previous.runs, ...result.data.runs], events: [...previous.events, ...result.data.events], nextCursor: result.data.nextCursor }));
    else setError(result.error.message);
    setLoading(false);
  }

  const runs = useMemo(() => {
    return mergedState.runs.filter(
      (r) =>
        (statusFilter === '' || r.status === statusFilter) &&
        (projectFilter === '' || r.projectId === projectFilter),
    );
  }, [mergedState.runs, statusFilter, projectFilter]);

  return (
    <div className="stack">
      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>
          작업 ({mergedState.runs.length})
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'timeline'} onClick={() => setTab('timeline')}>
          타임라인 ({mergedState.events.length})
        </button>
      </div>

      {tab === 'runs' && (
        <>
          <div className="row" style={{ gap: 10 }}>
            <span className="small muted row" style={{ gap: 5 }}>
              <ListFilter size={14} /> 필터
            </span>
            <select className="select" style={{ width: 'auto' }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as RunStatus | '')}>
              <option value="">모든 상태</option>
              {(Object.keys(RUN_STATUS_META) as RunStatus[]).map((s) => (
                <option key={s} value={s}>
                  {RUN_STATUS_META[s].label}
                </option>
              ))}
            </select>
            <select className="select" style={{ width: 'auto' }} value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="">모든 프로젝트</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <Card flush>
            {mergedState.runs.length === 0 ? (
              <EmptyState icon={Activity} title="작업 이력이 없습니다" description="빌드·업로드·캠페인 등 작업을 실행하면 여기에 원인·결과·로그가 누적됩니다." />
            ) : (
              <RunsTable runs={runs} state={mergedState} refresh={refresh} emptyLabel="필터 조건에 맞는 작업이 없습니다." />
            )}
          </Card>
        </>
      )}

      {tab === 'timeline' && <TimelineTable state={mergedState} />}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="row">
        {history.nextCursor && <button className="btn" onClick={() => void loadMore()} disabled={loading}>{loading && <Spinner />} 이전 이력 더 보기</button>}
        <span className="small muted">이력은 계속 보관되며 최신 항목부터 100개씩 불러옵니다.</span>
      </div>
    </div>
  );
}

function TimelineTable({ state }: { state: AppState }) {
  const events = useMemo(() => [...state.events].sort((a, b) => b.id - a.id), [state.events]);
  const projectName = (id: string | null) => (id ? state.projects.find((p) => p.id === id)?.name ?? id : null);

  if (events.length === 0) {
    return (
      <Card>
        <EmptyState icon={History} title="타임라인이 비어 있습니다" description="작업·외부 변경·알림이 발생하면 시간순으로 기록됩니다." />
      </Card>
    );
  }

  return (
    <Card flush>
      <div className="table__scroll">
        <table className="table">
          <thead>
            <tr>
              <th>시각</th>
              <th>수준</th>
              <th>종류</th>
              <th>메시지</th>
              <th>연관</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="small nowrap" title={formatDateTime(e.createdAt)}>{formatRelative(e.createdAt)}</td>
                <td>
                  {e.level in SEVERITY_META ? <SeverityBadge severity={e.level} /> : <span className="tag">{e.level}</span>}
                </td>
                <td className="mono small">{e.kind}</td>
                <td>{e.message}</td>
                <td className="small muted">
                  {projectName(e.projectId) && <span className="tag">{projectName(e.projectId)}</span>}
                  {e.runId && <span className="tag mono">run</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
