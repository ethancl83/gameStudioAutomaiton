// 공통 출시 파이프라인 UI.
// - PublishModal: 타깃·스토어 연결·트랙/버전/출시 노트를 받아 POST /projects/:id/publish 로 파이프라인을 시작한다.
//   외부 결과물의 업로드 자식 작업을 저장하며, 진행은 AppState.pipelines 로 조회한다.
// - PipelinesCard: 파이프라인 목록과 상태를 보여주고, 각 파이프라인의 자식 작업(빌드·업로드)으로 드릴다운한다.
import { Fragment, useMemo, useRef, useState } from 'react';
import { ChevronRight, Rocket, UploadCloud } from 'lucide-react';
import { api } from '../api';
import { TARGET_LABELS, formatRelative, providerLabel } from '../format';
import { newIdempotencyKey, useAction } from '../useAction';
import { Card, EmptyState, Field, Modal, Notice, Spinner, Badge } from './ui';
import { RunsTable } from './runs';
import { ArtifactPicker } from './ArtifactPicker';
import { PIPELINE_STATUS_META } from '../views/pipelineMeta';
import type { AppState, Connection, Project, ReleasePipeline } from '../../../../packages/domain';

// 출시 대상이 될 수 있는 스토어 연결. capability.category === 'store' 인 공급자.
export function eligibleStoreConnections(state: AppState): Connection[] {
  return state.connections.filter((c) => {
    const cap = state.capabilities.find((cp) => cp.provider === c.provider);
    return !!cap && cap.category === 'store' && cap.operations.includes('upload-build') && c.status !== 'disconnected';
  });
}


export function PublishModal({
  project,
  state,
  refresh,
  onClose,
  onPublished,
  presetConnectionId,
}: {
  project: Project;
  state: AppState;
  refresh: () => Promise<void>;
  onClose: () => void;
  onPublished?: (pipeline: ReleasePipeline) => void;
  presetConnectionId?: string;
}) {
  const act = useAction<ReleasePipeline>(refresh);
  const requestKey = useRef(newIdempotencyKey());

  const targets = ['android','ios','windows','macos','linux'];
  const [target, setTarget] = useState<string>(state.connections.find(c=>c.id===presetConnectionId)?.provider==='app-store'?'ios':state.connections.find(c=>c.id===presetConnectionId)?.provider==='google-play'?'android':project.targets[0]??'android');
  const stores = useMemo(() => eligibleStoreConnections(state).filter(connection => (target==='android'?['google-play']:target==='ios'?['app-store']:target==='macos'?['app-store','steam']:['steam']).includes(connection.provider)), [state, target]);
  const [connectionId, setConnectionId] = useState<string>(presetConnectionId ?? '');
  const [track, setTrack] = useState('internal');
  const [version, setVersion] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [importedArtifactId,setImportedArtifactId]=useState('');
  const done = act.result;

  const blocked = !target || !stores.some(connection => connection.id === connectionId) || !track.trim() || !importedArtifactId;

  async function submit() {
    if (blocked) return;
    await act.run(() =>
      api.publishProject(project.id, {
        target,
        idempotencyKey: requestKey.current,
        connectionId,
        track: track.trim() || undefined,
        version: version.trim() || undefined,
        releaseNotes: releaseNotes.trim() || undefined,
        importedArtifactId,
      }),
    );
  }

  return (
    <Modal
      title={`출시 · ${project.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>{done ? '닫기' : '취소'}</button>
          {!done && (
            <button className="btn btn--primary" onClick={() => void submit()} disabled={blocked || act.pending}>
              {act.pending ? <Spinner /> : <Rocket size={15} />} 출시 시작
            </button>
          )}
          {done && onPublished && (
            <button className="btn btn--primary" onClick={() => onPublished(done)}>
              <UploadCloud size={15} /> 파이프라인 보기
            </button>
          )}
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        {done ? (
          <Notice tone="info" title="출시 파이프라인이 시작되었습니다">
            가져온 결과물을 확인한 뒤 스토어에 업로드합니다. 배포 화면의 파이프라인에서 각 단계의 상태와 로그를 확인하세요.
            업로드 성공, 심사 접수, 실제 공개는 서로 다른 상태로 표시됩니다.
          </Notice>
        ) : (
          <>
            {stores.length === 0 && (
              <Notice tone="warn">
                연결된 스토어 계정이 없습니다. 먼저 Google Play·App Store·Steam 계정을 연결하세요.
              </Notice>
            )}
            <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <Field label="타깃" required htmlFor="pub-target">
                  <select id="pub-target" className="select" value={target} onChange={(e) => { setTarget(e.target.value); setConnectionId(''); setImportedArtifactId(''); }}>
                    <option value="">타깃 선택</option>
                    {targets.map((t) => (
                      <option key={t} value={t}>{TARGET_LABELS[t] ?? t}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <Field label="스토어 연결" required htmlFor="pub-conn">
                  <select id="pub-conn" className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} disabled={stores.length === 0}>
                    <option value="">연결 선택</option>
                    {stores.map((c) => (
                      <option key={c.id} value={c.id}>{c.label} · {providerLabel(c.provider)}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>

            <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <Field label="트랙/브랜치" required htmlFor="pub-track" hint="예: internal, beta, production, testing-branch">
                  <input id="pub-track" className="input" value={track} onChange={(e) => setTrack(e.target.value)} />
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <Field label="버전" htmlFor="pub-version" hint="비우면 빌드가 정한 버전 사용.">
                  <input id="pub-version" className="input mono" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="예: 1.2.0" spellCheck={false} />
                </Field>
              </div>
            </div>

            <Field label="출시 노트" htmlFor="pub-notes" hint="스토어/트랙에 함께 전달할 변경 사항(선택).">
              <textarea id="pub-notes" className="textarea" value={releaseNotes} onChange={(e) => setReleaseNotes(e.target.value)} rows={3} placeholder="이번 업데이트 내용" />
            </Field>

            <ArtifactPicker key={project.id+':'+target} projectId={project.id} target={target} assets={state.importedArtifacts??[]} value={importedArtifactId} onChange={setImportedArtifactId} refresh={refresh} demo={state.runtime.mode==='demo'} />

            <p className="small faint" style={{ margin: 0 }}>
              실제 운영은 저장된 권한·정책과 가져온 결과물을 사용합니다. 업로드 성공이 곧 공개·심사 통과를 뜻하지 않습니다.
            </p>
            {act.error && <Notice tone="error" title="출시 시작 실패">{act.error.message}</Notice>}
          </>
        )}
      </div>
    </Modal>
  );
}

export function PipelinesCard({
  state,
  refresh,
  projectId,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  projectId?: string;
}) {
  const pipelines = (state.pipelines ?? []).filter((p) => !projectId || p.projectId === projectId);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (pipelines.length === 0) {
    return (
      <Card title="출시 파이프라인" icon={Rocket}>
        <EmptyState
          icon={Rocket}
          title="진행 중이거나 완료된 출시가 없습니다"
          description="외부 결과물을 가져와 출시를 시작하면 업로드와 스토어 처리 상태를 여기에서 확인합니다."
        />
      </Card>
    );
  }

  return (
    <Card title="출시 파이프라인" icon={Rocket} flush>
      <div className="table__scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 28 }} aria-label="펼치기" />
              <th>프로젝트 · 타깃</th>
              <th>스토어</th>
              <th>상태</th>
              <th>갱신</th>
            </tr>
          </thead>
          <tbody>
            {[...pipelines]
              .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
              .map((p) => (
                <PipelineRow
                  key={p.id}
                  pipeline={p}
                  state={state}
                  refresh={refresh}
                  open={expanded === p.id}
                  onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
                />
              ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PipelineRow({
  pipeline,
  state,
  refresh,
  open,
  onToggle,
}: {
  pipeline: ReleasePipeline;
  state: AppState;
  refresh: () => Promise<void>;
  open: boolean;
  onToggle: () => void;
}) {
  const project = state.projects.find((x) => x.id === pipeline.projectId);
  const conn = state.connections.find((c) => c.id === pipeline.connectionId);
  const meta = PIPELINE_STATUS_META[pipeline.status];

  // 자식 작업: 빌드·업로드 run을 상태에서 찾아 드릴다운으로 보여준다.
  const childRuns = useMemo(() => {
    const ids = [pipeline.buildRunId, pipeline.uploadRunId].filter((x): x is string => !!x);
    return ids
      .map((id) => state.runs.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => !!r);
  }, [pipeline.buildRunId, pipeline.uploadRunId, state.runs]);

  return (
    <Fragment>
      <tr>
        <td>
          <button className="btn btn--ghost btn--sm" aria-expanded={open} aria-label={open ? '접기' : '펼치기'} onClick={onToggle}>
            <ChevronRight size={15} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
          </button>
        </td>
        <td>
          <div style={{ fontWeight: 550 }}>{project?.name ?? pipeline.projectId}</div>
          <div className="small muted">{TARGET_LABELS[pipeline.target] ?? pipeline.target}</div>
        </td>
        <td className="small">{conn ? `${conn.label} · ${providerLabel(conn.provider)}` : pipeline.connectionId}</td>
        <td><Badge tone={meta.tone}>{meta.label}</Badge></td>
        <td className="small nowrap">{formatRelative(pipeline.updatedAt)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--surface-sunken)' }}>
            <div className="stack" style={{ gap: 12, padding: '4px 0' }}>
              {pipeline.error && <Notice tone="error" title="파이프라인 오류">{pipeline.error}</Notice>}
              {pipeline.status === 'action_required' && (
                <Notice tone="warn" title="사용자 조치 필요">
                  업로드 결과가 확정되지 않았습니다. 자식 작업의 상태를 확인하고 필요한 조치를 완료하세요.
                </Notice>
              )}
              <div>
                <div className="small muted" style={{ marginBottom: 6 }}>{pipeline.input.importedArtifactId?'업로드 작업':'빌드·업로드 작업'}</div>
                <RunsTable runs={childRuns} state={state} refresh={refresh} emptyLabel="자식 작업이 아직 생성되지 않았습니다." />
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
