// 작업(Run) 목록·로그·취소·재시도. 프로젝트 상세와 이력에서 공용으로 쓴다.
// 로그는 제어 서비스가 남긴 TimelineEvent(runId 일치)를 근거로 표시한다.
import { Fragment, useEffect, useId, useState } from 'react';
import { AlertTriangle, Ban, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { formatDateTime, formatRelative, isRunActive, isRunReconcilable, isRunRetryable } from '../format';
import { useAction } from '../useAction';
import { RunStatusBadge } from './status';
import { Field, Modal, Notice, Spinner } from './ui';
import type { AppState, Run, TimelineEvent } from '../../../../packages/domain';
import { isWriteOperation } from '../../../../packages/connectors/types';

function levelToStream(level: TimelineEvent['level']): string {
  if (level === 'error') return 'logline__stderr';
  if (level === 'info') return 'logline__system';
  return '';
}

export function RunLog({ run, events }: { run: Run; events: TimelineEvent[] }) {
  const [past, setPast] = useState<TimelineEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  // 이전 로그 로드 실패를 숨기지 않고 그대로 표시한다(빈 로그처럼 보이지 않게 한다).
  const [logError, setLogError] = useState('');
  useEffect(() => {
    let current = true;
    setInitialLoading(true); setLogError('');
    void api.historyQuery({ kind: 'events', runId: run.id }).then(result => {
      if (!current) return;
      if (result.ok) { setPast(result.data.events); setCursor(result.data.nextCursor); }
      else setLogError(result.error.message);
      setInitialLoading(false);
    });
    return () => { current = false; };
  }, [run.id]);
  async function moreLogs() {
    if (!cursor || loading) return; setLoading(true); setLogError('');
    const result = await api.historyQuery({ kind: 'events', runId: run.id, before: cursor });
    if (result.ok) { setPast(previous => [...previous, ...result.data.events]); setCursor(result.data.nextCursor); }
    else setLogError(result.error.message);
    setLoading(false);
  }
  const logs = [...new Map([...past, ...events].map(event => [event.id, event])).values()]
    .filter((e) => e.runId === run.id)
    .sort((a, b) => a.id - b.id);

  return (
    <div className="stack" style={{ gap: 12 }}>
      {run.error && (
        <Notice tone="error" title="실패 원인">
          {run.error}
        </Notice>
      )}
      {run.status === 'action_required' && (
        <Notice tone="warn" title="사용자 조치가 필요합니다">
          이 작업은 외부 처리 결과가 확정되지 않았습니다. 임의 재시도 대신 아래 상태와 로그를 확인하고, 필요한 조치를
          완료한 뒤 이어서 진행하세요.
        </Notice>
      )}
      {logError && (
        <Notice tone="error" title="로그를 불러오지 못했습니다">
          {logError}
        </Notice>
      )}
      {logs.length === 0 ? (
        initialLoading ? (
          <p className="muted small row" style={{ gap: 8 }}>
            <Spinner /> 로그를 불러오는 중…
          </p>
        ) : (
          <p className="muted small">아직 기록된 로그가 없습니다.</p>
        )
      ) : (
        <div className="logbox" role="log" aria-label="작업 로그">
          {logs.map((e) => (
            <div key={e.id} className={levelToStream(e.level)}>
              <span className="logline__time">{formatDateTime(e.createdAt).slice(11)}</span>
              {e.message}
            </div>
          ))}
        </div>
      )}
      {cursor && <button className="btn btn--sm" disabled={loading} onClick={() => void moreLogs()}>{loading && <Spinner />} 이전 로그 더 보기</button>}
      {run.result && Object.keys(run.result).length > 0 && (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>작업 결과</div>
          <ResultSummary result={run.result} />
        </div>
      )}
    </div>
  );
}

// 결과 데이터를 사용자에게 유용한 한국어 항목으로 표시하고, 원본 값은 접이식 기술 상세에 둔다.
const RESULT_LABELS: Record<string, string> = {
  externalId: '외부 리소스 ID',
  resourceId: '리소스 ID',
  url: '링크',
  status: '상태',
  track: '트랙/브랜치',
  version: '버전',
  versionCode: '버전 코드',
  editId: '편집 세션 ID',
  uploadedAt: '업로드 시각',
  submittedAt: '제출 시각',
  message: '메시지',
  name: '이름',
  campaignId: '캠페인 ID',
  productId: '상품 ID',
  adUnitId: '광고 단위 ID',
};

function formatResultValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `${value.length}개 항목`;
  return '세부 항목 (아래 기술 상세 참고)';
}

function ResultSummary({ result }: { result: Record<string, unknown> }) {
  const entries = Object.entries(result);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <dl className="dl" style={{ gridTemplateColumns: '150px 1fr' }}>
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{RESULT_LABELS[k] ?? k}</dt>
            <dd className="small" style={{ wordBreak: 'break-all' }}>{formatResultValue(v)}</dd>
          </Fragment>
        ))}
      </dl>
      <details>
        <summary className="small muted" style={{ cursor: 'pointer' }}>기술 상세 보기</summary>
        <pre className="logbox" style={{ marginTop: 8 }}>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}

export function RunActions({ run, refresh }: { run: Run; refresh: () => Promise<void> }) {
  const [resolveOpen, setResolveOpen] = useState(false);
  const cancel = useAction<Run>(refresh);
  const retry = useAction<Run>(refresh);
  const reconcile = useAction<Run>(refresh);
  const busy = cancel.pending || retry.pending || reconcile.pending;
  // 외부 쓰기 = 연결(외부 공급자)에 대한 작업. 재조정은 이 경우에만 노출한다.
  const isExternalWrite = run.writeEffect ?? (run.connectionId !== null && isWriteOperation(run.kind));

  return (
    <div className="row" style={{ gap: 6 }}>
      {(isRunActive(run.status) || run.status === 'action_required') && (
        <button
          className="btn btn--sm btn--danger"
          disabled={busy}
          onClick={() => void cancel.run(() => api.cancelRun(run.id))}
          title="아직 전송하지 않은 작업을 취소합니다. 외부에 전송한 작업은 상태 확인이 필요합니다."
        >
          {cancel.pending ? <Spinner /> : <Ban size={13} />} 취소
        </button>
      )}
      {isExternalWrite && isRunReconcilable(run.status) && (
        <button
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void reconcile.run(() => api.reconcileRun(run.id))}
          title="외부 공급자의 실제 반영 상태를 다시 확인합니다. 쓰기를 재전송하지 않습니다."
        >
          {reconcile.pending ? <Spinner /> : <RefreshCw size={13} />} 상태 재확인
        </button>
      )}
      {isExternalWrite && isRunReconcilable(run.status) && <button className="btn btn--sm" onClick={() => setResolveOpen(true)}>서비스 확인 결과 기록</button>}
      {resolveOpen && <ResolveRunModal run={run} refresh={refresh} onClose={() => setResolveOpen(false)} />}
      {isRunRetryable(run.status) && (
        <button
          className="btn btn--sm"
          disabled={busy}
          onClick={() => void retry.run(() => api.retryRun(run.id))}
          title="안전하게 재시도 가능한 작업만 재실행합니다."
        >
          {retry.pending ? <Spinner /> : <RotateCcw size={13} />} 재시도
        </button>
      )}
      {(cancel.error || retry.error || reconcile.error) && (
        <span className="small" style={{ color: 'var(--error)' }}>
          <AlertTriangle size={12} /> {(cancel.error ?? retry.error ?? reconcile.error)?.message}
        </span>
      )}
    </div>
  );
}

function ResolveRunModal({run,refresh,onClose}:{run:Run;refresh:()=>Promise<void>;onClose:()=>void}) {
  const fieldId=useId();const [expectedUpdatedAt]=useState(run.updatedAt);
  const [outcome,setOutcome]=useState<'succeeded'|'failed'>('failed');
  const [note,setNote]=useState(''); const [externalId,setExternalId]=useState('');
  const [confirmed,setConfirmed]=useState(false); const action=useAction<Run>(refresh);
  async function save(){const result=await action.run(()=>api.resolveRun(run.id,{outcome,note,externalId:externalId||undefined,confirmed,expectedUpdatedAt}));if(result?.ok)onClose();}
  return <Modal title="서비스에서 확인한 결과" onClose={onClose} footer={<><button className="btn" onClick={onClose}>닫기</button><button className="btn btn--primary" disabled={action.pending||!confirmed||note.trim().length<5} onClick={()=>void save()}>{action.pending&&<Spinner/>}확인 결과 저장</button></>}>
    <div className="stack">
      <Notice tone="info">해당 서비스의 게시물·캠페인·작업 목록에서 실제 결과를 확인한 뒤 기록하세요. 저장하면 확인 대기를 끝내고 예약 한도를 정리합니다. 이 작업을 다시 전송하지 않습니다.</Notice>
      <Field label="확인 결과" htmlFor={fieldId+'-outcome'}><select id={fieldId+'-outcome'} className="select" value={outcome} onChange={e=>setOutcome(e.target.value as typeof outcome)}><option value="failed">변경이 반영되지 않음 (외부 영향 없음)</option><option value="succeeded">요청한 변경이 완료됨</option></select></Field>
      <Field label="서비스 리소스 ID (선택)" htmlFor={fieldId+'-external'}><input id={fieldId+'-external'} className="input" value={externalId} onChange={e=>setExternalId(e.target.value)} maxLength={200}/></Field>
      <Field label="확인한 내용" required htmlFor={fieldId+'-note'}><textarea id={fieldId+'-note'} className="textarea" value={note} onChange={e=>setNote(e.target.value)} maxLength={1000} placeholder="어느 서비스 화면에서 어떤 상태를 확인했는지 입력하세요."/></Field>
      <label className="row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>서비스에서 실제 반영 결과를 확인했습니다.</label>
      {action.error&&<Notice tone="error">{action.error.message}</Notice>}
    </div>
  </Modal>;
}

export function RunsTable({
  runs,
  state,
  refresh,
  emptyLabel = '작업이 없습니다.',
}: {
  runs: Run[];
  state: AppState;
  refresh: () => Promise<void>;
  emptyLabel?: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (runs.length === 0) {
    return <p className="muted small" style={{ padding: '18px' }}>{emptyLabel}</p>;
  }

  const sorted = [...runs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return (
    <div className="table__scroll">
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 28 }} aria-label="펼치기" />
            <th>작업</th>
            <th>상태</th>
            <th>시도</th>
            <th>생성</th>
            <th aria-label="동작" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((run) => {
            const open = expanded === run.id;
            return (
              <Fragment key={run.id}>
                <tr>
                  <td>
                    <button
                      className="btn btn--ghost btn--sm"
                      aria-expanded={open}
                      aria-label={open ? '로그 접기' : '로그 펼치기'}
                      onClick={() => setExpanded(open ? null : run.id)}
                    >
                      <ChevronRight
                        size={15}
                        style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }}
                      />
                    </button>
                  </td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{run.label || run.kind}</div>
                    <div className="small muted mono">{run.kind}</div>
                  </td>
                  <td>
                    <RunStatusBadge status={run.status} />
                  </td>
                  <td className="mono">{run.attempt}</td>
                  <td className="small nowrap" title={formatDateTime(run.createdAt)}>
                    {formatRelative(run.createdAt)}
                  </td>
                  <td>
                    <RunActions run={run} refresh={refresh} />
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--surface-sunken)' }}>
                      <RunLog run={run} events={state.events} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
