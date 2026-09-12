// 운영 준비 화면: 엔진·SDK 설치/연결, 프로젝트별 준비 점검, 스토어 앱 매핑, 광고/결제 연동,
// 앱·제어 서비스 수명주기를 한 화면에서 다룬다. 데모/실제 모두 같은 논리 API를 쓴다(모드는 불변 클라이언트).
// 점검 항목의 조치 링크는 기존 화면(프로젝트·계정·키·러너)으로 이동한다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Download,
  FolderOpen,
  Loader2,
  PackageCheck,
  Rocket,
  Store,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { ViewKey } from '../App';
import { api } from '../api';
import type { AppState, BuildTarget, Connection, Provider } from '../../../../packages/domain';
import type {
  PreparationCheck,
  PreparationPreferences,
  PreparationState,
  PreparationStatus,
  ProjectPreparation,
  ToolCatalogItem,
  ToolId,
  ToolInstall,
} from '../../../../packages/setup/types';
import { Badge, Card, Field, LoadingBlock, Notice, Spinner, Stat } from '../components/ui';
import { RunnerSelect } from '../components/RunnerSelect';
import { IntegrationPanel } from '../components/IntegrationPanel';
import { LifecyclePanel } from '../components/LifecyclePanel';
import { useAction } from '../useAction';

const FILE_TOOLS = new Set<ToolId>(['godot', 'unity', 'unreal', 'xcode', 'steamcmd']);
const ACTIVE_INSTALL = new Set<ToolInstall['status']>(['queued', 'downloading', 'verifying', 'installing']);
const TOOL_PROBE: Record<ToolId, string> = {
  godot: 'godot', 'godot-templates': 'godot-export-templates', 'android-sdk': 'android-sdk-validated',
  jdk: 'jdk-home', 'gradle-cache': 'gradle-offline-cache', unity: 'unity', unreal: 'unreal-engine-root',
  xcode: 'xcodebuild', steamcmd: 'steamcmd',
};
const STORE_PROVIDERS: { id: 'google-play' | 'app-store' | 'steam'; label: string }[] = [
  { id: 'google-play', label: 'Google Play' },
  { id: 'app-store', label: 'App Store' },
  { id: 'steam', label: 'Steam' },
];

function storeForTarget(target: BuildTarget): 'google-play' | 'app-store' | 'steam' {
  return target === 'android' ? 'google-play' : target === 'ios' ? 'app-store' : 'steam';
}

const STATUS_META: Record<PreparationStatus, { tone: 'ok' | 'warn' | 'error' | 'neutral'; label: string }> = {
  ready: { tone: 'ok', label: '준비됨' },
  required: { tone: 'warn', label: '설정 필요' },
  blocked: { tone: 'error', label: '차단됨' },
  checking: { tone: 'neutral', label: '확인 중' },
};

const CHECK_LINK: Partial<Record<PreparationCheck['action'], ViewKey>> = {
  project: 'projects',
  connection: 'connections',
  key: 'settings',
  runner: 'operations',
  policy: 'projects',
};

export function SetupView({
  state,
  refresh,
  goTo,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
}) {
  const [setup, setSetup] = useState<PreparationState | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const res = await api.getSetup();
    if (!mounted.current) return;
    if (res.ok) {
      setSetup(res.data);
      setPhase('ready');
    } else {
      setErrorMsg(res.error.message);
      setPhase((p) => (p === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  // 설치가 진행 중이면 자주 폴링해 실시간 진행률을 반영한다.
  const hasActiveInstall = useMemo(
    () => (setup ? setup.installations.some((j) => ACTIVE_INSTALL.has(j.status)) : false),
    [setup],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!hasActiveInstall) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [hasActiveInstall, load]);

  if (phase === 'loading' && !setup) return <LoadingBlock label="준비 상태를 불러오는 중…" />;
  if (phase === 'error' && !setup) {
    return (
      <Notice tone="error" title="준비 상태를 불러오지 못했습니다" action={<button className="btn btn--sm" onClick={() => void load()}>다시 시도</button>}>
        {errorMsg}
      </Notice>
    );
  }
  if (!setup) return <LoadingBlock />;

  const readyProjects = setup.projects.filter((p) => p.status === 'ready').length;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="운영 준비 개요" icon={Rocket}>
        <div className="grid grid--stats">
          <Stat label="실행 모드" value={setup.mode === 'demo' ? '데모' : '실제'} icon={CircleDot} />
          <Stat
            label="프로젝트 준비"
            value={`${readyProjects}/${setup.projects.length}`}
            sub="대상별 준비 완료 수"
            icon={PackageCheck}
          />
          <Stat
            label="빌드 격리"
            value={setup.isolation.available ? '사용 가능' : '불가'}
            sub={setup.isolation.backend + (setup.isolation.reason ? ` · ${setup.isolation.reason}` : '')}
          />
        </div>
        {errorMsg && phase === 'ready' && <Notice tone="warn">최근 갱신 실패: {errorMsg}</Notice>}
      </Card>

      <LifecyclePanel />

      <ToolsSection setup={setup} reload={load} />

      <ProjectPreparationSection state={state} setup={setup} reload={load} refresh={refresh} goTo={goTo} />
    </div>
  );
}

// --- 도구(엔진/SDK) 설치·연결 ---
function ToolsSection({ setup, reload }: { setup: PreparationState; reload: () => Promise<void> }) {
  const rescan = useAction<PreparationState>(reload);
  return (
    <Card
      title="엔진 · SDK 준비"
      icon={Wrench}
      actions={
        <button className="btn btn--sm" disabled={rescan.pending} onClick={() => void rescan.run(() => api.rescanSetup())}>
          {rescan.pending ? <Spinner /> : null} 다시 검사
        </button>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          검증된 공식 설치본을 내려받아 설치하거나, 이미 설치한 도구의 경로를 연결합니다. 설치 경로는 신뢰하는 호스트
          입력이며, 시스템 환경 변수를 바꾸지 않습니다.
        </p>
        {setup.catalog.map((item) => (
          <ToolRow
            key={item.id}
            item={item}
            settings={setup.settings}
            job={setup.installations.filter((j) => j.toolId === item.id)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]}
            available={setup.tools.find((t) => t.name === TOOL_PROBE[item.id])?.available ?? false}
            reload={reload}
          />
        ))}
      </div>
    </Card>
  );
}

function ToolRow({
  item,
  settings,
  job,
  available,
  reload,
}: {
  item: ToolCatalogItem;
  settings: PreparationState['settings'];
  job?: ToolInstall;
  available: boolean;
  reload: () => Promise<void>;
}) {
  const currentPath = item.settingsKey ? settings[item.settingsKey] : undefined;
  const isFile = FILE_TOOLS.has(item.id);
  const [pathInput, setPathInput] = useState(currentPath ?? '');
  const [accepted, setAccepted] = useState(false);
  const save = useAction(reload);
  const install = useAction<ToolInstall>(reload);
  const cancel = useAction(reload);
  const electron = api.isElectron;
  const active = job && ACTIVE_INSTALL.has(job.status);

  useEffect(() => {
    setPathInput(currentPath ?? '');
  }, [currentPath]);

  const pickFolder = async () => {
    const picked = await api.selectFolder();
    if (picked) setPathInput(picked);
  };

  return (
    <div className="stack" style={{ gap: 8, padding: '12px 0', borderTop: '1px solid var(--border)' }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{item.name}</strong>
        {item.version && <Badge tone="neutral">{item.version}</Badge>}
        {currentPath ? (
          <Badge tone={available ? 'ok' : 'warn'}>{available ? '연결됨' : '경로 있음(미확인)'}</Badge>
        ) : (
          <Badge tone="neutral">미설정</Badge>
        )}
        <a href={item.documentation} target="_blank" rel="noreferrer" className="muted" style={{ marginLeft: 'auto' }}>
          공식 문서
        </a>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {item.description}
      </p>

      {item.settingsKey && (
        <div className="stack" style={{ gap: 6 }}>
          <Field
            label={isFile ? '실행 파일 경로(절대 경로)' : '설치 폴더 경로(절대 경로)'}
            htmlFor={`tool-${item.id}`}
          >
            <div className="row" style={{ gap: 8 }}>
              <input
                id={`tool-${item.id}`}
                type="text"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                placeholder={isFile ? '/경로/실행파일' : '/경로/폴더'}
                style={{ flex: 1 }}
              />
              {electron && !isFile && (
                <button className="btn btn--sm" onClick={() => void pickFolder()} type="button">
                  <FolderOpen size={14} /> 폴더 선택
                </button>
              )}
            </div>
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn--sm btn--primary"
              disabled={save.pending || pathInput.trim() === (currentPath ?? '')}
              onClick={() => void save.run(() => api.saveTools({ [item.settingsKey!]: pathInput.trim() }))}
            >
              {save.pending ? <Spinner /> : null} 경로 저장
            </button>
            {currentPath && (
              <button
                className="btn btn--sm"
                disabled={save.pending}
                onClick={() => {
                  setPathInput('');
                  void save.run(() => api.saveTools({ [item.settingsKey!]: '' }));
                }}
              >
                연결 해제
              </button>
            )}
          </div>
          {save.error && <Notice tone="error">{save.error.message}</Notice>}
        </div>
      )}

      {item.installable && (
        <div className="stack" style={{ gap: 6 }}>
          {item.licenseUrl && (
            <label className="row" style={{ gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>
                <a href={item.licenseUrl} target="_blank" rel="noreferrer">
                  라이선스
                </a>
                에 동의합니다(설치당 1회).
              </span>
            </label>
          )}
          {active && job ? (
            <div className="stack" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <Loader2 size={14} className="spin" aria-hidden />
                <span>{job.message || job.status}</span>
                <span className="muted">{job.progress}%</span>
                <button
                  className="btn btn--xs"
                  style={{ marginLeft: 'auto' }}
                  disabled={cancel.pending}
                  onClick={() => void cancel.run(() => api.cancelToolInstall(job.id))}
                >
                  취소
                </button>
              </div>
              <div className="progress" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}>
                <div className="progress__bar" style={{ width: `${Math.max(2, Math.min(100, job.progress))}%` }} />
              </div>
            </div>
          ) : (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn--sm"
                disabled={install.pending || (!!item.licenseUrl && !accepted)}
                onClick={() =>
                  void install.run(() => api.startToolInstall({ toolId: item.id, acceptLicense: item.licenseUrl ? accepted : undefined }))
                }
              >
                {install.pending ? <Spinner /> : <Download size={14} />} 설치
              </button>
              {job?.status === 'failed' && <span className="badge badge--error">이전 설치 실패: {job.message}</span>}
            </div>
          )}
          {install.error && <Notice tone="error">{install.error.message}</Notice>}
          {cancel.error && <Notice tone="error">{cancel.error.message}</Notice>}
        </div>
      )}
    </div>
  );
}

// --- 프로젝트별 준비: 대상 전환 · 점검 · 준비 설정 · 스토어 앱 · 연동 ---
function ProjectPreparationSection({
  state,
  setup,
  reload,
  refresh,
  goTo,
}: {
  state: AppState;
  setup: PreparationState;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
}) {
  const projects = state.projects;
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const project = projects.find((p) => p.id === projectId) ?? projects[0];
  const targets = (project?.targets.length ? project.targets : (['android'] as BuildTarget[]));
  const [target, setTarget] = useState<BuildTarget>(targets[0]);

  useEffect(() => {
    if (project && !project.targets.includes(target) && project.targets.length) setTarget(project.targets[0]);
  }, [project, target]);

  if (!project) {
    return (
      <Card title="프로젝트 준비" icon={FolderOpen}>
        <Notice tone="info" title="등록된 프로젝트가 없습니다" action={<button className="btn btn--sm" onClick={() => goTo('projects')}>프로젝트 등록</button>}>
          먼저 프로젝트 폴더를 등록하면 대상별 준비 상태를 점검할 수 있습니다.
        </Notice>
      </Card>
    );
  }

  const prep = setup.projects.find((p) => p.projectId === project.id && p.target === target);
  const prefs = setup.preferences.find((p) => p.projectId === project.id && p.target === target);

  return (
    <Card title="프로젝트 준비" icon={FolderOpen}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <Field label="프로젝트" htmlFor="prep-project">
            <select id="prep-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="배포 대상" htmlFor="prep-target">
            <select id="prep-target" value={target} onChange={(e) => setTarget(e.target.value as BuildTarget)}>
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          {prep && (
            <div style={{ alignSelf: 'flex-end' }}>
              <Badge tone={STATUS_META[prep.status].tone}>
                {STATUS_META[prep.status].label} · {prep.ready}/{prep.total}
              </Badge>
            </div>
          )}
        </div>

        {prep && <CheckList checks={prep.checks} goTo={goTo} />}

        <PreparationForm project={project} target={target} prefs={prefs} reload={reload} state={state} />

        <StoreAppSection project={project} target={target} state={state} reload={reload} refresh={refresh} />

        <IntegrationPanel projectId={project.id} connections={state.connections} resources={state.resources} />
      </div>
    </Card>
  );
}

function CheckList({ checks, goTo }: { checks: PreparationCheck[]; goTo: (v: ViewKey) => void }) {
  if (checks.length === 0) return null;
  return (
    <ul className="stack" style={{ gap: 6, listStyle: 'none', margin: 0, padding: 0 }}>
      {checks.map((c) => {
        const link = CHECK_LINK[c.action];
        const Icon = c.status === 'ready' ? CheckCircle2 : c.status === 'blocked' ? XCircle : c.status === 'checking' ? Loader2 : CircleAlert;
        const color = c.status === 'ready' ? 'var(--ok)' : c.status === 'blocked' ? 'var(--error)' : 'var(--warn)';
        return (
          <li key={c.id} className="row" style={{ gap: 8, alignItems: 'flex-start', padding: '6px 0' }}>
            <Icon size={16} style={{ color, flex: 'none', marginTop: 1 }} aria-hidden />
            <div className="stack" style={{ gap: 2, flex: 1 }}>
              <span>{c.label}</span>
              <span className="muted">{c.detail}</span>
            </div>
            {c.url ? (
              <a className="btn btn--xs" href={c.url} target="_blank" rel="noreferrer">
                안내
              </a>
            ) : link ? (
              <button className="btn btn--xs" onClick={() => goTo(link)}>
                이동
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PreparationForm({
  project,
  target,
  prefs,
  reload,
  state,
}: {
  project: AppState['projects'][number];
  target: BuildTarget;
  prefs?: PreparationPreferences;
  reload: () => Promise<void>;
  state: AppState;
}) {
  const [runnerId, setRunnerId] = useState(prefs?.runnerId ?? '');
  const [connectionId, setConnectionId] = useState(prefs?.connectionId ?? '');
  const [engineExecutable, setEngineExecutable] = useState(prefs?.engineExecutable ?? '');
  const [exportPreset, setExportPreset] = useState(prefs?.exportPreset ?? '');
  const [scheme, setScheme] = useState(prefs?.scheme ?? '');
  const [sdkRequired, setSdkRequired] = useState(prefs?.sdkRequired ?? false);
  const save = useAction<PreparationPreferences>(reload);
  const storeProvider = storeForTarget(target);
  const eligibleConnections = state.connections.filter((c) => c.provider === storeProvider);

  useEffect(() => {
    setRunnerId(prefs?.runnerId ?? '');
    setConnectionId(prefs?.connectionId ?? '');
    setEngineExecutable(prefs?.engineExecutable ?? '');
    setExportPreset(prefs?.exportPreset ?? '');
    setScheme(prefs?.scheme ?? '');
    setSdkRequired(prefs?.sdkRequired ?? false);
  }, [prefs, target]);

  return (
    <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>{target} 빌드·배포 준비 설정</h3>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 220 }}>
          <RunnerSelect id={`prep-runner-${project.id}-${target}`} value={runnerId} onChange={setRunnerId} />
        </div>
        <Field label="배포 계정" htmlFor="prep-conn" hint={eligibleConnections.length === 0 ? `${storeProvider} 계정을 먼저 연결하세요.` : undefined}>
          <select id="prep-conn" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">선택 안 함</option>
            {eligibleConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Field label="엔진 실행 파일(선택)" htmlFor="prep-engine">
          <input id="prep-engine" type="text" value={engineExecutable} onChange={(e) => setEngineExecutable(e.target.value)} placeholder="비우면 연결된 엔진 사용" />
        </Field>
        {target === 'ios' ? (
          <Field label="Xcode scheme(선택)" htmlFor="prep-scheme">
            <input id="prep-scheme" type="text" value={scheme} onChange={(e) => setScheme(e.target.value)} />
          </Field>
        ) : (
          <Field label="내보내기 프리셋(선택)" htmlFor="prep-preset">
            <input id="prep-preset" type="text" value={exportPreset} onChange={(e) => setExportPreset(e.target.value)} />
          </Field>
        )}
      </div>
      <label className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={sdkRequired} onChange={(e) => setSdkRequired(e.target.checked)} />
        <span>이 대상에 광고·결제 SDK 연동이 필요합니다(준비 점검에 포함).</span>
      </label>
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn btn--sm btn--primary"
          disabled={save.pending}
          onClick={() =>
            void save.run(() =>
              api.savePreparation(project.id, {
                target,
                runnerId: runnerId || undefined,
                connectionId: connectionId || undefined,
                engineExecutable: engineExecutable.trim() || undefined,
                exportPreset: target === 'ios' ? undefined : exportPreset.trim() || undefined,
                scheme: target === 'ios' ? scheme.trim() || undefined : undefined,
                sdkRequired,
              }),
            )
          }
        >
          {save.pending ? <Spinner /> : null} 준비 설정 저장
        </button>
      </div>
      {save.error && <Notice tone="error">{save.error.message}</Notice>}
    </div>
  );
}

function StoreAppSection({
  project,
  target,
  state,
  reload,
  refresh,
}: {
  project: AppState['projects'][number];
  target: BuildTarget;
  state: AppState;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [provider, setProvider] = useState<'google-play' | 'app-store' | 'steam'>(storeForTarget(target));
  useEffect(() => setProvider(storeForTarget(target)), [target]);
  const mapping = project.storeApps?.[provider];
  const [connectionId, setConnectionId] = useState(mapping?.connectionId ?? '');
  const [appId, setAppId] = useState(mapping?.appId ?? '');
  const eligibleConnections = state.connections.filter((c) => c.provider === (provider as Provider));
  const save = useAction(async () => {
    await reload();
    await refresh();
  });
  const check = useAction(async () => {
    await reload();
    await refresh();
  });

  useEffect(() => {
    setConnectionId(mapping?.connectionId ?? '');
    setAppId(mapping?.appId ?? '');
  }, [mapping?.connectionId, mapping?.appId, provider]);

  return (
    <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h3 className="row" style={{ margin: 0, fontSize: 14, gap: 6 }}>
        <Store size={15} aria-hidden /> 스토어 앱 매핑
      </h3>
      <p className="muted" style={{ margin: 0 }}>
        프로젝트를 스토어의 실제 앱과 연결합니다. 저장하면 해당 계정이 이 프로젝트의 정책에 부여됩니다. 저장만으로
        확인됨이 되지는 않으며, 연결 확인은 실제 읽기 전용 조회(데모는 시뮬레이션)로만 표시됩니다.
      </p>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Field label="스토어" htmlFor="store-provider">
          <select id="store-provider" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
            {STORE_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="계정" htmlFor="store-conn" hint={eligibleConnections.length === 0 ? '해당 스토어 계정을 먼저 연결하세요.' : undefined}>
          <select id="store-conn" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">계정 선택</option>
            {eligibleConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={provider === 'google-play' ? '패키지 이름' : provider === 'app-store' ? 'App Store 앱 ID(숫자)' : 'Steam App ID(숫자)'}
          htmlFor="store-appid"
          hint={provider === 'google-play' ? '예: com.example.game' : '숫자 ID'}
        >
          <input id="store-appid" type="text" value={appId} onChange={(e) => setAppId(e.target.value)} />
        </Field>
      </div>
      {mapping && (
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge tone={mapping.verifiedAt ? 'ok' : 'neutral'}>{mapping.verifiedAt ? '확인됨' : '미확인'}</Badge>
          <code className="muted">{mapping.appId}</code>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn btn--sm btn--primary"
          disabled={save.pending || !connectionId || !appId.trim()}
          onClick={() => void save.run(() => api.saveStoreApp(project.id, { provider, connectionId, appId: appId.trim() }))}
        >
          {save.pending ? <Spinner /> : null} 앱 매핑 저장
        </button>
        <button
          className="btn btn--sm"
          disabled={check.pending || !mapping}
          onClick={() => void check.run(() => api.checkStoreApp(project.id, { provider }))}
        >
          {check.pending ? <Spinner /> : null} 연결 확인
        </button>
      </div>
      {save.error && <Notice tone="error">{save.error.message}</Notice>}
      {check.error && <Notice tone="error">{check.error.message}</Notice>}
    </div>
  );
}
