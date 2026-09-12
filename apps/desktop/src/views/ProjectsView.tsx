// 프로젝트: 폴더 등록 → 검수 → 빌드 실행/로그/취소, 실행 정책 저장.
import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  FolderPlus,
  FolderSearch,
  Hammer,
  Info,
  RefreshCcw,
  Rocket,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import { PublishModal, eligibleStoreConnections } from '../components/PublishFlow';
import { RunnerSelect } from '../components/RunnerSelect';
import type { ViewKey } from '../App';
import {
  ENGINE_LABELS,
  TARGET_LABELS,
  formatDateTime,
  microsToMajor,
  majorToMicros,
} from '../format';
import { useAction } from '../useAction';
import { Card, EmptyState, Field, Modal, Notice, Spinner } from '../components/ui';
import { SeverityBadge } from '../components/status';
import { RunsTable } from '../components/runs';
import { BuildSecurityTab } from './BuildSecurityTab';
import type { AppState, AutomationPolicy, Finding, Project } from '../../../../packages/domain';

export function ProjectsView({
  state,
  refresh,
  goTo,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const selected = selectedId ? state.projects.find((p) => p.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <ProjectDetail
        project={selected}
        state={state}
        refresh={refresh}
        goTo={goTo}
        onBack={() => setSelectedId(null)}
        onDeleted={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="stack">
      <div className="row row--between">
        <p className="muted small" style={{ margin: 0 }}>
          폴더를 등록하면 엔진·버전·타깃·앱 식별자를 탐지하고, 검수와 빌드를 실행할 수 있습니다.
        </p>
        <button className="btn btn--primary" onClick={() => setRegisterOpen(true)}>
          <FolderPlus size={15} /> 프로젝트 등록
        </button>
      </div>

      {state.projects.length === 0 ? (
        <Card>
          <EmptyState
            icon={FolderSearch}
            title="등록된 프로젝트가 없습니다"
            description="게임/앱 프로젝트 폴더를 등록하면 여기에서 검수와 빌드를 관리합니다. 원본 폴더는 수정하지 않습니다."
            action={
              <button className="btn btn--primary" onClick={() => setRegisterOpen(true)}>
                <FolderPlus size={15} /> 첫 프로젝트 등록
              </button>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <div className="table__scroll">
            <table className="table table--projects">
              <thead>
                <tr>
                  <th>프로젝트</th>
                  <th>엔진</th>
                  <th>타깃</th>
                  <th className="col-hide-md">앱 식별자</th>
                  <th>검수</th>
                  <th className="col-hide-sm">마지막 검수</th>
                  <th aria-label="동작" />
                </tr>
              </thead>
              <tbody>
                {state.projects.map((p) => (
                  <ProjectRow key={p.id} project={p} onOpen={() => setSelectedId(p.id)} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {registerOpen && (
        <RegisterProjectModal
          state={state}
          refresh={refresh}
          onClose={() => setRegisterOpen(false)}
          onCreated={(p) => {
            setRegisterOpen(false);
            setSelectedId(p.id);
          }}
        />
      )}
    </div>
  );
}

function findingCounts(findings: Finding[]) {
  return {
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

function ProjectRow({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const c = findingCounts(project.findings);
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onOpen}>
      <td>
        <div style={{ fontWeight: 600 }}>{project.name}</div>
        <div className="small muted truncate mono" style={{ maxWidth: 200 }} title={project.rootPath}>
          {project.rootPath}
        </div>
      </td>
      <td>
        {ENGINE_LABELS[project.engine] ?? project.engine}
        {project.engineVersion && <span className="small muted"> · {project.engineVersion}</span>}
      </td>
      <td>
        {project.targets.length === 0 ? (
          <span className="muted small">—</span>
        ) : (
          project.targets.map((t) => (
            <span className="tag" key={t}>
              {TARGET_LABELS[t] ?? t}
            </span>
          ))
        )}
      </td>
      <td className="mono small col-hide-md">{project.appIdentifier ?? '—'}</td>
      <td>
        {project.findings.length === 0 ? (
          <span className="muted small">—</span>
        ) : (
          <span className="row" style={{ gap: 6 }}>
            {c.error > 0 && <SeverityBadge severity="error" />}
            {c.error > 0 && <span className="small">{c.error}</span>}
            {c.warning > 0 && <SeverityBadge severity="warning" />}
            {c.warning > 0 && <span className="small">{c.warning}</span>}
          </span>
        )}
      </td>
      <td className="small nowrap col-hide-sm">{formatDateTime(project.inspectedAt)}</td>
      <td>
        <button className="btn btn--sm" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          열기
        </button>
      </td>
    </tr>
  );
}

// 데모 샘플 엔진: 경로 없이 등록할 수 있는 합성 샘플. 루트가 `/demo/<engine>` 경로의 basename으로
// 합성 프로젝트를 만든다.
const DEMO_SAMPLES: { engine: string; label: string; desc: string }[] = [
  { engine: 'godot', label: 'Godot 샘플', desc: '데스크톱·모바일 멀티타깃' },
  { engine: 'unity', label: 'Unity 샘플', desc: 'Android·iOS·데스크톱' },
  { engine: 'unreal', label: 'Unreal 샘플', desc: 'Windows·Linux' },
  { engine: 'android', label: '네이티브 Android 샘플', desc: 'Android' },
  { engine: 'ios', label: '네이티브 iOS 샘플', desc: 'iOS' },
];

function RegisterProjectModal({
  state,
  refresh,
  onClose,
  onCreated,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const demo = api.isDemo();
  const [path, setPath] = useState('');
  const add = useAction<Project>(refresh);

  async function pickFolder() {
    const picked = await api.selectFolder();
    if (picked) setPath(picked);
  }

  async function register(inputPath: string) {
    if (!inputPath.trim()) return;
    const res = await add.run(() => api.addProject(inputPath.trim()));
    if (res?.ok) onCreated(res.data);
  }

  return (
    <Modal
      title="프로젝트 등록"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {demo ? '닫기' : '취소'}
          </button>
          {!demo && (
            <button className="btn btn--primary" onClick={() => void register(path)} disabled={add.pending || !path.trim()}>
              {add.pending ? <Spinner /> : <FolderPlus size={15} />} 등록하고 검수
            </button>
          )}
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        {demo ? (
          <>
            <Notice tone="info" title="데모 샘플 프로젝트">
              폴더 경로 없이 엔진 샘플을 선택하면 루트가 합성 프로젝트를 만들어 탐지·검수·빌드·출시 흐름을 실제와 동일하게
              보여줍니다. 실제 파일을 읽거나 수정하지 않습니다.
            </Notice>
            <div className="stack" style={{ gap: 8 }}>
              {DEMO_SAMPLES.map((s) => (
                <button
                  key={s.engine}
                  className="btn"
                  style={{ justifyContent: 'space-between', width: '100%' }}
                  disabled={add.pending}
                  onClick={() => void register(`/demo/${s.engine}`)}
                >
                  <span className="row" style={{ gap: 8 }}>
                    <FolderPlus size={15} /> <strong>{s.label}</strong>
                  </span>
                  <span className="small muted">{s.desc}</span>
                </button>
              ))}
            </div>
            {add.pending && (
              <p className="small muted row" style={{ gap: 8 }}>
                <Spinner /> 샘플을 등록하는 중…
              </p>
            )}
            {add.error && <Notice tone="error" title="등록 실패">{add.error.message}</Notice>}
          </>
        ) : (
          <>
            <Notice tone="info">
              폴더를 선택하면 제어 서비스가 읽기 전용으로 프로젝트를 탐지합니다. 빌드 스크립트를 실행하거나 원본을 수정하지
              않습니다.
            </Notice>
            <Field label="프로젝트 폴더 경로" required htmlFor="proj-path" hint={api.isElectron ? '폴더 선택 버튼을 사용하거나 경로를 직접 입력하세요.' : '브라우저 개발 모드에서는 경로를 직접 입력하세요.'}>
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <input
                  id="proj-path"
                  className="input mono"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/project"
                  spellCheck={false}
                />
                {api.isElectron && (
                  <button className="btn" onClick={() => void pickFolder()} type="button">
                    <FolderSearch size={15} /> 폴더 선택
                  </button>
                )}
              </div>
            </Field>
            {add.error && <Notice tone="error" title="등록 실패">{add.error.message}</Notice>}
            {state.projects.length > 0 && (
              <p className="small muted">이미 {state.projects.length}개 프로젝트가 등록되어 있습니다. 같은 폴더의 중복 등록은 제어 서비스가 검사합니다.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

type DetailTab = 'overview' | 'inspection' | 'build' | 'buildSecurity' | 'policy';

function ProjectDetail({
  project,
  state,
  refresh,
  goTo,
  onBack,
  onDeleted,
}: {
  project: Project;
  state: AppState;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>('overview');
  const inspect = useAction<Project>(refresh);
  const del = useAction<{ deleted: true }>(refresh);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [relinkPath, setRelinkPath] = useState('');
  const relink = useAction<Project>(refresh);
  const hasStore = eligibleStoreConnections(state).length > 0;

  const projectRuns = useMemo(() => state.runs.filter((r) => r.projectId === project.id), [state.runs, project.id]);
  const c = findingCounts(project.findings);

  async function doDelete() {
    const res = await del.run(() => api.deleteProject(project.id));
    if (res?.ok) onDeleted();
  }

  return (
    <div className="stack">
      <div className="row row--between">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          <ArrowLeft size={15} /> 프로젝트 목록
        </button>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn--sm btn--primary"
            onClick={() => setPublishOpen(true)}
            disabled={!hasStore || project.relinkRequired}
            title={!hasStore ? '먼저 스토어 계정을 연결하세요.' : '검수→빌드→업로드 출시 파이프라인을 시작합니다.'}
          >
            <Rocket size={14} /> 출시
          </button>
          <button className="btn btn--sm" onClick={() => void inspect.run(() => api.inspectProject(project.id))} disabled={inspect.pending || project.relinkRequired}>
            {inspect.pending ? <Spinner /> : <RefreshCcw size={14} />} 다시 검수
          </button>
          <button className="btn btn--sm btn--danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} /> 등록 해제
          </button>
        </div>
      </div>

      <div>
        <h2 style={{ margin: '0 0 2px', fontSize: 20 }}>{project.name}</h2>
        <div className="small muted mono">{project.rootPath}</div>
      </div>

      {inspect.error && <Notice tone="error" title="검수 실패">{inspect.error.message}</Notice>}
      {project.relinkRequired && <Notice tone="warn" title="원본 프로젝트 폴더를 연결해 주세요">
        <p>백업에는 빌드 이력·산출물·키가 포함됩니다. 이 장비의 원본 폴더를 연결하면 빌드를 다시 준비할 수 있습니다.</p>
        <div className="row">
          <input className="input mono" aria-label="다시 연결할 프로젝트 폴더" value={relinkPath} onChange={event => setRelinkPath(event.target.value)} placeholder="/path/to/project" />
          {api.isElectron && <button className="btn" onClick={() => void api.selectFolder().then(result => { if (result) setRelinkPath(result); })}>폴더 선택</button>}
          <button className="btn btn--primary" disabled={!relinkPath.trim() || relink.pending} onClick={() => void relink.run(() => api.relinkProject(project.id, relinkPath))}>{relink.pending ? <Spinner /> : '폴더 연결'}</button>
        </div>
        {relink.error && <p role="alert">{relink.error.message}</p>}
      </Notice>}

      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>
          개요
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'inspection'} onClick={() => setTab('inspection')}>
          검수 {project.findings.length > 0 && `(${c.error + c.warning})`}
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'build'} onClick={() => setTab('build')}>
          빌드 {projectRuns.length > 0 && `(${projectRuns.length})`}
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'buildSecurity'} onClick={() => setTab('buildSecurity')}>
          빌드 보안
        </button>
        <button className="tab" role="tab" aria-selected={tab === 'policy'} onClick={() => setTab('policy')}>
          실행 정책
        </button>
      </div>

      {tab === 'overview' && <OverviewTab project={project} />}
      {tab === 'inspection' && <InspectionTab project={project} />}
      {tab === 'build' && <BuildTab project={project} runs={projectRuns} state={state} refresh={refresh} />}
      {tab === 'buildSecurity' && <BuildSecurityTab project={project} state={state} refresh={refresh} />}
      {tab === 'policy' && <PolicyTab project={project} state={state} refresh={refresh} />}

      {confirmDelete && (
        <Modal
          title="프로젝트 등록 해제"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                취소
              </button>
              <button className="btn btn--danger" onClick={() => void doDelete()} disabled={del.pending}>
                {del.pending ? <Spinner /> : <Trash2 size={15} />} 등록 해제
              </button>
            </>
          }
        >
          <Notice tone="warn">
            이 앱에서 프로젝트 등록만 해제합니다. 원본 폴더와 파일은 삭제하지 않습니다. 진행 중인 이 프로젝트의 작업은
            정지될 수 있습니다.
          </Notice>
          {del.error && <div style={{ marginTop: 12 }}><Notice tone="error">{del.error.message}</Notice></div>}
        </Modal>
      )}

      {publishOpen && (
        <PublishModal
          project={project}
          state={state}
          refresh={refresh}
          onClose={() => setPublishOpen(false)}
          onPublished={() => {
            setPublishOpen(false);
            goTo('releases');
          }}
        />
      )}
    </div>
  );
}

function OverviewTab({ project }: { project: Project }) {
  return (
    <Card title="프로젝트 개요" icon={Info}>
      <dl className="dl">
        <dt>엔진</dt>
        <dd>
          {ENGINE_LABELS[project.engine] ?? project.engine}
          {project.engineVersion ? ` · ${project.engineVersion}` : ''}
        </dd>
        <dt>앱 식별자</dt>
        <dd className="mono">{project.appIdentifier ?? '— (미탐지)'}</dd>
        <dt>배포 타깃</dt>
        <dd>
          {project.targets.length === 0
            ? '탐지된 타깃 없음'
            : project.targets.map((t) => TARGET_LABELS[t] ?? t).join(', ')}
        </dd>
        <dt>폴더</dt>
        <dd className="mono">{project.rootPath}</dd>
        <dt>등록</dt>
        <dd>{formatDateTime(project.createdAt)}</dd>
        <dt>마지막 검수</dt>
        <dd>{formatDateTime(project.inspectedAt)}</dd>
      </dl>
    </Card>
  );
}

function InspectionTab({ project }: { project: Project }) {
  if (project.findings.length === 0) {
    return (
      <Card>
        <EmptyState icon={ShieldCheck} title="검수 지적 사항이 없습니다" description="마지막 검수에서 발견된 오류·경고가 없습니다. 코드나 설정을 변경했다면 다시 검수하세요." />
      </Card>
    );
  }
  return (
    <Card title="검수 결과" icon={ShieldCheck}>
      <div>
        {project.findings.map((f, i) => (
          <div className="finding" key={`${f.code}-${i}`}>
            <SeverityBadge severity={f.severity} />
            <div className="finding__body">
              <div className="finding__msg">{f.message}</div>
              <div className="finding__meta">
                <span className="mono">{f.code}</span>
                {f.path && <span> · {f.path}</span>}
              </div>
              {f.fixHint && (
                <div className="small" style={{ marginTop: 4, color: 'var(--teal-600)' }}>
                  수정 방법: {f.fixHint}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function BuildTab({
  project,
  runs,
  state,
  refresh,
}: {
  project: Project;
  runs: AppState['runs'];
  state: AppState;
  refresh: () => Promise<void>;
}) {
  const build = useAction(refresh);
  const [target, setTarget] = useState<string>(project.targets[0] ?? '');
  const [configuration, setConfiguration] = useState('');
  const [engineExecutable, setEngineExecutable] = useState('');
  const [exportPreset, setExportPreset] = useState('');
  const [scheme, setScheme] = useState('');
  const [runnerId, setRunnerId] = useState('');

  const blockingErrors = project.findings.filter((f) => f.severity === 'error');
  const isGodot = project.engine === 'godot';
  const isIos = target === 'ios' || project.engine === 'ios';

  async function launch() {
    if (!target) return;
    await build.run(() =>
      api.build(project.id, {
        target,
        configuration: configuration.trim() || undefined,
        engineExecutable: engineExecutable.trim() || undefined,
        exportPreset: exportPreset.trim() || undefined,
        scheme: scheme.trim() || undefined,
        runnerId: runnerId || undefined,
      }),
    );
  }

  return (
    <div className="stack">
      <Card title="빌드 실행" icon={Hammer}>
        {project.targets.length === 0 && (
          <div style={{ marginBottom: 12 }}>
            <Notice tone="warn">이 프로젝트에서 배포 타깃을 찾지 못했습니다. 엔진의 내보내기 설정을 저장한 뒤 프로젝트를 다시 검수해 주세요.</Notice>
          </div>
        )}
        {blockingErrors.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Notice tone="error" title="검수 오류가 있습니다">
              필수 검사에서 {blockingErrors.length}건의 오류가 있습니다. 배포 빌드 전에 검수 탭에서 확인하세요. 실제 빌드
              가능 여부는 제어 서비스가 최종 판단합니다.
            </Notice>
          </div>
        )}
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 200, flex: 1 }}>
            <Field label="타깃" required htmlFor="build-target">
              <select id="build-target" className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">타깃 선택</option>
                {project.targets.map((t) => (
                  <option key={t} value={t}>
                    {TARGET_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ minWidth: 200, flex: 1 }}>
            <Field label="빌드 구성" htmlFor="build-config" hint="예: release, debug. 비우면 어댑터 기본값.">
              <input id="build-config" className="input" value={configuration} onChange={(e) => setConfiguration(e.target.value)} placeholder="release" />
            </Field>
          </div>
        </div>
        <Field label="엔진 실행 파일 경로" htmlFor="build-engine" hint="설치된 엔진 CLI 경로. 비우면 제어 서비스가 탐지한 도구를 사용합니다.">
          <input id="build-engine" className="input mono" value={engineExecutable} onChange={(e) => setEngineExecutable(e.target.value)} placeholder="자동 탐지" spellCheck={false} />
        </Field>
        {isGodot && (
          <Field label="내보내기 프리셋" htmlFor="build-preset" hint="Godot export_presets.cfg 의 프리셋 이름.">
            <input id="build-preset" className="input" value={exportPreset} onChange={(e) => setExportPreset(e.target.value)} placeholder="예: Android" />
          </Field>
        )}
        {isIos && (
          <Field label="Xcode Scheme" htmlFor="build-scheme" hint="iOS archive에 사용할 scheme.">
            <input id="build-scheme" className="input" value={scheme} onChange={(e) => setScheme(e.target.value)} />
          </Field>
        )}
        <RunnerSelect id="build-runner" value={runnerId} onChange={setRunnerId} />
        {build.error && <div style={{ marginBottom: 12 }}><Notice tone="error" title="빌드 요청 실패">{build.error.message}</Notice></div>}
        <button className="btn btn--primary" onClick={() => void launch()} disabled={build.pending || !target}>
          {build.pending ? <Spinner /> : <Hammer size={15} />} 빌드 시작
        </button>
        <p className="small muted" style={{ marginTop: 10 }}>
          빌드는 원본을 건드리지 않는 스냅샷에서 실행됩니다. 필요한 엔진·도구가 없으면 성공으로 처리하지 않고, 무엇을 준비해야 하는지 오류로 안내합니다.
        </p>
      </Card>

      <Card title="이 프로젝트의 작업" flush>
        <RunsTable runs={runs} state={state} refresh={refresh} emptyLabel="아직 실행한 빌드 작업이 없습니다." />
      </Card>
    </div>
  );
}

function PolicyTab({ project, state, refresh }: { project: Project; state: AppState; refresh: () => Promise<void> }) {
  const [policy, setPolicy] = useState<AutomationPolicy>(project.policy);
  const [budgetInput, setBudgetInput] = useState(microsToMajor(project.policy.maxDailyBudgetMicros));
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const save = useAction<Project>(refresh);

  function update<K extends keyof AutomationPolicy>(key: K, value: AutomationPolicy[K]) {
    setPolicy((p) => ({ ...p, [key]: value }));
  }

  function toggleConnection(id: string) {
    setPolicy((p) => ({
      ...p,
      allowedConnectionIds: p.allowedConnectionIds.includes(id)
        ? p.allowedConnectionIds.filter((x) => x !== id)
        : [...p.allowedConnectionIds, id],
    }));
  }

  async function submit() {
    const micros = majorToMicros(budgetInput);
    if (micros === null) {
      setBudgetError('올바른 금액을 입력하세요(최대 소수 6자리).');
      return;
    }
    setBudgetError(null);
    await save.run(() => api.setPolicy(project.id, { ...policy, maxDailyBudgetMicros: micros }));
  }

  return (
    <Card title="실행 정책" icon={ShieldCheck}>
      <Notice tone="info">
        저장한 범위 안의 반복 작업에는 매번 확인을 요청하지 않습니다. 새 비용 발생이나 범위 확대는 이 정책을 다시
        저장해야 허용됩니다.
      </Notice>

      <div style={{ marginTop: 16 }}>
        <div className="section-title">자동 실행</div>
        <label className="checkbox-row">
          <input type="checkbox" checked={policy.autoBuild} onChange={(e) => update('autoBuild', e.target.checked)} />
          <span>
            <strong>자동 빌드</strong>
            <div className="small muted">검수 통과 후 저장된 타깃으로 빌드를 자동 실행합니다.</div>
          </span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={policy.autoRelease} onChange={(e) => update('autoRelease', e.target.checked)} />
          <span>
            <strong>자동 배포</strong>
            <div className="small muted">빌드 성공 후 시험 트랙/브랜치 업로드를 자동 실행합니다. 실제 공개는 별도입니다.</div>
          </span>
        </label>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="section-title">수익화·마케팅 쓰기 허용</div>
        <label className="checkbox-row">
          <input type="checkbox" checked={policy.allowCampaignWrites} onChange={(e) => update('allowCampaignWrites', e.target.checked)} />
          <span>
            <strong>캠페인 변경 허용</strong>
            <div className="small muted">저장된 한도 안에서 캠페인 생성·수정·중지를 허용합니다.</div>
          </span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={policy.allowMonetizationWrites} onChange={(e) => update('allowMonetizationWrites', e.target.checked)} />
          <span>
            <strong>수익화 변경 허용</strong>
            <div className="small muted">광고 단위·상품·가격 설정 변경을 허용합니다.</div>
          </span>
        </label>
      </div>

      <div className="row" style={{ marginTop: 16, gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <Field label="일일 예산 한도" htmlFor="policy-budget" hint="이 앱이 요청하는 예산 변경이 넘지 않도록 검증하는 상한입니다.">
            <input
              id="policy-budget"
              className="input"
              value={budgetInput}
              onChange={(e) => setBudgetInput(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 120 }}>
          <Field label="통화" htmlFor="policy-currency">
            <input id="policy-currency" className="input" value={policy.currency} onChange={(e) => update('currency', e.target.value.toUpperCase())} maxLength={3} />
          </Field>
        </div>
      </div>
      {budgetError && <Notice tone="error">{budgetError}</Notice>}

      <div style={{ marginTop: 16 }}>
        <div className="section-title">허용 연결</div>
        {state.connections.length === 0 ? (
          <p className="small muted">연결된 계정이 없습니다. 먼저 계정을 연결하세요.</p>
        ) : (
          state.connections.map((conn) => (
            <label className="checkbox-row" key={conn.id}>
              <input
                type="checkbox"
                checked={policy.allowedConnectionIds.includes(conn.id)}
                onChange={() => toggleConnection(conn.id)}
              />
              <span>
                <strong>{conn.label}</strong>
                <span className="small muted"> · {conn.accountId}</span>
              </span>
            </label>
          ))
        )}
      </div>

      {save.error && <div style={{ marginTop: 12 }}><Notice tone="error" title="정책 저장 실패">{save.error.message}</Notice></div>}
      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={save.pending}>
          {save.pending ? <Spinner /> : <ShieldCheck size={15} />} 정책 저장
        </button>
        {save.result && <span className="small" style={{ color: 'var(--ok)' }}>저장되었습니다.</span>}
      </div>
    </Card>
  );
}
