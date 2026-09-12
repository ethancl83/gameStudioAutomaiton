// 운영 준비: 러너 등록·검사·삭제, 준비 상태(링크), 백업 생성·복원, 설정 저장, 진단 묶음 표시·내려받기.
// 모든 값은 GET /operations(OperationsState)에서 오고 변경은 각 API로 위임한다. 서버가 저장·검증·이력을
// 기록하며, 화면은 지원 여부를 근거 없이 성공으로 표시하지 않는다.
import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Archive,
  CheckCircle2,
  Download,
  ExternalLink,
  HardDrive,
  Plus,
  RefreshCcw,
  RotateCw,
  Save,
  ServerCog,
  Stethoscope,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api, type DiagnosticsReport, type RestoreResult } from '../api';
import type { ViewKey } from '../App';
import { formatDateTime, formatRelative } from '../format';
import { useAction } from '../useAction';
import { DemoControls } from '../components/DemoControls';
import { PortableBackupPanel } from '../components/PortableBackupPanel';
import { Badge, Card, EmptyState, Field, Modal, Notice, Spinner } from '../components/ui';
import type {
  AppState,
  BackupRecord,
  OperationsSettings,
  OperationsState,
  ReadinessCheck,
  RunnerRegistration,
} from '../../../../packages/domain';

const PLATFORM_LABELS: Record<RunnerRegistration['platform'], string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
};
const RUNNER_STATUS_META: Record<RunnerRegistration['status'], { label: string; tone: 'ok' | 'warn' | 'error' | 'info' | 'neutral' }> = {
  ready: { label: '준비됨', tone: 'ok' },
  unverified: { label: '미검증', tone: 'info' },
  unavailable: { label: '사용 불가', tone: 'error' },
};
const READINESS_STATUS_META: Record<ReadinessCheck['status'], { label: string; tone: 'ok' | 'warn' | 'error' }> = {
  ready: { label: '준비됨', tone: 'ok' },
  action_required: { label: '조치 필요', tone: 'warn' },
  unavailable: { label: '사용 불가', tone: 'error' },
};

function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function OperationsView({ state, refresh, goTo }: { state: AppState; refresh: () => Promise<void>; goTo: (view: ViewKey) => void }) {
  const [ops, setOps] = useState<OperationsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    const res = await api.getOperations();
    if (res.ok) setOps(res.data);
    else setError(res.error.message);
    setLoading(false);
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  if (loading && !ops) {
    return (
      <div className="loading-block">
        <Spinner large /> 운영 상태를 불러오는 중…
      </div>
    );
  }

  if (!ops) {
    return (
      <Card>
        <EmptyState
          icon={ServerCog}
          title="운영 상태를 불러올 수 없습니다"
          description={error ?? '제어 서비스에서 운영 상태를 받지 못했습니다.'}
          action={
            <button className="btn btn--sm" onClick={() => void reload()}>
              <RefreshCcw size={14} /> 다시 시도
            </button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="stack">
      {state.runtime.mode === 'demo' && (
        <Notice tone="info">
          데모 운영 상태입니다. 러너·백업·진단은 데모 저장공간에서 동작하며 실제 기기·자원에 영향을 주지 않습니다.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      <ReadinessCard checks={ops.readiness} goTo={goTo} />

      <div className="grid grid--split">
        <RunnersCard runners={ops.runners} reload={reload} />
        <SettingsCard settings={ops.settings} reload={reload} />
      </div>

      <BackupsCard backups={ops.backups} reload={reload} refresh={refresh} />

      <PortableBackupPanel refresh={refresh} />

      <DiagnosticsCard />
      {state.runtime.mode === 'demo' && <DemoControls state={state} refresh={refresh} />}
    </div>
  );
}

function ReadinessCard({ checks, goTo }: { checks: ReadinessCheck[]; goTo: (view: ViewKey) => void }) {
  return (
    <Card title="운영 준비 상태" icon={Activity}>
      {checks.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>준비 항목이 없습니다.</p>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {checks.map((c) => {
            const meta = READINESS_STATUS_META[c.status];
            return (
              <div key={c.id} className="row row--between" style={{ gap: 10, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <strong className="small">{c.label}</strong>
                  </div>
                  <div className="small muted" style={{ marginTop: 4 }}>{c.detail}</div>
                </div>
                {c.destination && (
                  <button className="btn btn--sm" onClick={() => {if (['connections','projects','settings','setup'].includes(c.destination)) goTo(c.destination as ViewKey); else if (c.destination.startsWith('https://')) void api.openExternal(c.destination);}}>
                    <ExternalLink size={13} /> 안내 열기
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function RunnersCard({ runners, reload }: { runners: RunnerRegistration[]; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      title="빌드 러너"
      icon={HardDrive}
      actions={
        <button className="btn btn--sm btn--primary" onClick={() => setOpen(true)}>
          <Plus size={13} /> 러너 등록
        </button>
      }
    >
      {runners.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          등록된 러너가 없습니다. macOS·Windows 빌드 등 다른 OS 작업에는 해당 OS 러너를 등록하고 검사하세요.
        </p>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {runners.map((r) => (
            <RunnerRow key={r.id} runner={r} reload={reload} />
          ))}
        </div>
      )}
      {open && <RegisterRunnerModal reload={reload} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function RunnerRow({ runner, reload }: { runner: RunnerRegistration; reload: () => Promise<void> }) {
  const check = useAction<RunnerRegistration>(reload);
  const del = useAction<{ deleted: true }>(reload);
  const [confirm, setConfirm] = useState(false);
  const meta = RUNNER_STATUS_META[runner.status];
  return (
    <div className="card" style={{ boxShadow: 'none' }}>
      <div className="card__body">
        <div className="row row--between" style={{ gap: 8 }}>
          <span className="row" style={{ gap: 8 }}>
            <strong>{runner.label}</strong>
            <span className="tag">{PLATFORM_LABELS[runner.platform]}</span>
          </span>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
        <dl className="dl" style={{ gridTemplateColumns: '100px 1fr', marginTop: 8 }}>
          <dt>엔드포인트</dt>
          <dd className="mono small" style={{ wordBreak: 'break-all' }}>{runner.endpoint}</dd>
          <dt>마지막 검사</dt>
          <dd className="small">{formatRelative(runner.lastCheckedAt)}</dd>
        </dl>
        {runner.lastError && (
          <div style={{ marginTop: 8 }}>
            <Notice tone="warn"><span className="small">{runner.lastError}</span></Notice>
          </div>
        )}
        {runner.id !== 'local' && <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <button className="btn btn--sm" disabled={check.pending} onClick={() => void check.run(() => api.checkRunner(runner.id))}>
            {check.pending ? <Spinner /> : <RefreshCcw size={13} />} 연결 검사
          </button>
          <button className="btn btn--sm btn--danger" onClick={() => setConfirm(true)}>
            <Trash2 size={13} /> 삭제
          </button>
        </div>}
        {(check.error || del.error) && (
          <div style={{ marginTop: 8 }}><Notice tone="error">{(check.error ?? del.error)?.message}</Notice></div>
        )}
      </div>
      {confirm && (
        <Modal
          title="러너 삭제"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(false)}>취소</button>
              <button
                className="btn btn--danger"
                disabled={del.pending}
                onClick={async () => {
                  const res = await del.run(() => api.deleteRunner(runner.id));
                  if (res?.ok) setConfirm(false);
                }}
              >
                {del.pending ? <Spinner /> : <Trash2 size={15} />} 삭제
              </button>
            </>
          }
        >
          <Notice tone="warn">
            <strong>{runner.label}</strong> 러너를 삭제하면 이 러너로 예약된 작업은 다른 러너가 필요합니다.
          </Notice>
        </Modal>
      )}
    </div>
  );
}

function RegisterRunnerModal({ reload, onClose }: { reload: () => Promise<void>; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [platform, setPlatform] = useState<RunnerRegistration['platform']>('linux');
  const [endpoint, setEndpoint] = useState('');
  const [pairingToken, setPairingToken] = useState('');
  const add = useAction<RunnerRegistration>(reload);
  // pairingToken은 1회용 결합 비밀이다. 실제 모드에서만 입력하며 필수, 데모에서는 받지 않는다.
  const demo = api.isDemo();
  const blocked = !label.trim() || !endpoint.trim() || (!demo && !pairingToken.trim());

  async function submit() {
    if (blocked) return;
    const res = await add.run(() =>
      api.registerRunner({
        label: label.trim(),
        platform,
        endpoint: endpoint.trim(),
        pairingToken: demo ? undefined : pairingToken.trim(),
      }),
    );
    if (res?.ok) onClose();
  }

  return (
    <Modal
      title="빌드 러너 등록"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={blocked || add.pending}>
            {add.pending ? <Spinner /> : <Plus size={15} />} 등록
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <Notice tone="info">
          등록 후 <strong>연결 검사</strong>로 실제 연결·상태를 확인합니다. 등록만으로 준비됨으로 표시하지 않습니다.
        </Notice>
        <Field label="러너 이름" required htmlFor="rn-label">
          <input id="rn-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="예: Mac mini (사무실)" />
        </Field>
        <Field label="플랫폼" required htmlFor="rn-platform">
          <select id="rn-platform" className="select" value={platform} onChange={(e) => setPlatform(e.target.value as RunnerRegistration['platform'])}>
            <option value="linux">Linux</option>
            <option value="darwin">macOS</option>
            <option value="win32">Windows</option>
          </select>
        </Field>
        <Field label="엔드포인트" required htmlFor="rn-endpoint" hint="러너 제어 서비스의 loopback/내부 주소.">
          <input id="rn-endpoint" className="input mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…" spellCheck={false} />
        </Field>
        {!demo && (
          <Field
            label="결합 토큰(pairing token)"
            required
            htmlFor="rn-token"
            hint="러너에서 발급한 1회용 결합 비밀입니다. 등록 시 한 번만 사용되며 저장·표시되지 않습니다."
          >
            <input
              id="rn-token"
              className="input mono"
              type="password"
              autoComplete="off"
              value={pairingToken}
              onChange={(e) => setPairingToken(e.target.value)}
              spellCheck={false}
            />
          </Field>
        )}
        {add.error && <Notice tone="error" title="등록 실패">{add.error.message}</Notice>}
      </div>
    </Modal>
  );
}

function SettingsCard({ settings, reload }: { settings: OperationsSettings; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<OperationsSettings>(settings);
  // PUT /operations/settings 는 OperationsSettings 를 돌려준다. 이후 reload로 전체 운영 상태를 다시 읽는다.
  const save = useAction<OperationsSettings>(reload);

  function set<K extends keyof OperationsSettings>(key: K, value: OperationsSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  const retentionValid = Number.isInteger(draft.retentionDays) && draft.retentionDays >= 7 && draft.retentionDays <= 3650;
  const hourValid = Number.isInteger(draft.backupHour) && draft.backupHour >= 0 && draft.backupHour <= 23;
  const blocked = !retentionValid || !hourValid;

  return (
    <Card title="운영 설정" icon={Save}>
      <div className="row" style={{ gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 140 }}>
          <Field label="백업 보존 기간(일)" htmlFor="op-retention" hint="설정 백업 파일의 보존 일수(7–3650). 작업 이력과 빌드 결과물은 유지합니다.">
            <input
              id="op-retention"
              className="input"
              type="number"
              min={7}
              max={3650}
              value={String(draft.retentionDays)}
              onChange={(e) => set('retentionDays', Math.floor(Number(e.target.value) || 0))}
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <Field label="백업 시각(시)" htmlFor="op-hour" hint="자동 백업 실행 시각(0–23).">
            <input
              id="op-hour"
              className="input"
              type="number"
              min={0}
              max={23}
              value={String(draft.backupHour)}
              onChange={(e) => set('backupHour', Math.floor(Number(e.target.value) || 0))}
            />
          </Field>
        </div>
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={draft.autoBackup} onChange={(e) => set('autoBackup', e.target.checked)} />
        <span>
          <strong>자동 백업</strong>
          <div className="small muted">지정 시각에 프로젝트·정책·운영 설정을 자동 백업합니다.</div>
        </span>
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={draft.notifications} onChange={(e) => set('notifications', e.target.checked)} />
        <span>
          <strong>앱 내 운영 알림</strong>
          <div className="small muted">앱이 열려 있는 동안 작업 완료·실패와 백업·러너 상태 변화를 표시합니다.</div>
        </span>
      </label>
      {save.error && <div style={{ marginTop: 8 }}><Notice tone="error" title="설정 저장 실패">{save.error.message}</Notice></div>}
      <div className="row" style={{ marginTop: 12, gap: 10 }}>
        <button className="btn btn--primary" disabled={blocked || save.pending} onClick={() => void save.run(() => api.updateOperationsSettings(draft))}>
          {save.pending ? <Spinner /> : <Save size={15} />} 설정 저장
        </button>
        {save.result && <span className="small" style={{ color: 'var(--ok)' }}>저장되었습니다.</span>}
      </div>
    </Card>
  );
}

function BackupsCard({
  backups,
  reload,
  refresh,
}: {
  backups: BackupRecord[];
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [desc, setDesc] = useState('');
  const create = useAction<BackupRecord>(reload);
  const restore = useAction<RestoreResult>(async () => {
    await reload();
    await refresh();
  });
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);

  async function doCreate() {
    const res = await create.run(() => api.createBackup({ description: desc.trim() || undefined }));
    if (res?.ok) setDesc('');
  }

  return (
    <Card title="백업·복원" icon={Archive}>
      <Notice tone="info">
        백업은 <strong>프로젝트·정책·운영 설정</strong>의 논리 백업입니다. 백업 이후 추가한 프로젝트와 현재 계정·키·작업 이력은 보존합니다. 복구한 프로젝트의 자동 빌드·배포·광고·커뮤니티 운영은 꺼진 상태로 돌아옵니다.
      </Notice>
      <div className="row" style={{ gap: 10, alignItems: 'flex-end', marginTop: 12 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Field label="백업 설명(선택)" htmlFor="bk-desc">
            <input id="bk-desc" className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="예: 출시 전 스냅샷" />
          </Field>
        </div>
        <button className="btn btn--primary" disabled={create.pending} onClick={() => void doCreate()}>
          {create.pending ? <Spinner /> : <Archive size={15} />} 백업 생성
        </button>
      </div>
      {create.error && <div style={{ marginTop: 8 }}><Notice tone="error">{create.error.message}</Notice></div>}

      <div style={{ marginTop: 14 }}>
        {backups.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>백업이 없습니다. 복원은 검증된 백업에서만 수행됩니다.</p>
        ) : (
          <div className="table__scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>설명</th>
                  <th>생성</th>
                  <th>프로젝트</th>
                  <th>크기</th>
                  <th aria-label="동작" />
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 550 }}>{b.description || '(설명 없음)'}</td>
                    <td className="small nowrap" title={formatDateTime(b.createdAt)}>{formatRelative(b.createdAt)}</td>
                    <td className="mono small">{b.projectCount}</td>
                    <td className="small nowrap">{bytes(b.size)}</td>
                    <td>
                      <button className="btn btn--sm" onClick={() => setRestoreTarget(b)}>
                        <RotateCw size={13} /> 복원
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {restoreTarget && (
        <Modal
          title="백업에서 복원"
          onClose={() => {
            setRestoreTarget(null);
            restore.reset();
          }}
          footer={
            restore.result ? (
              <button className="btn btn--primary" onClick={() => { setRestoreTarget(null); restore.reset(); }}>
                닫기
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => setRestoreTarget(null)}>취소</button>
                <button
                  className="btn btn--danger"
                  disabled={restore.pending}
                  onClick={() => void restore.run(() => api.restoreBackup(restoreTarget.id))}
                >
                  {restore.pending ? <Spinner /> : <RotateCw size={15} />} 복원 실행
                </button>
              </>
            )
          }
        >
          {restore.result ? (
            <Notice tone="info" title="복원 완료">
              프로젝트 <strong>{restore.result.projectCount}</strong>개를 복원하고 해당 프로젝트의 자동화를 일시중지했습니다. 계정 키와 작업 이력은 그대로
              보존되었습니다. 자동화는 각 화면에서 검토 후 다시 활성화하세요.
            </Notice>
          ) : (
            <>
              <Notice tone="warn">
                <strong>{restoreTarget.description || restoreTarget.id}</strong> 백업에 포함된 프로젝트·정책·운영 설정을 복원합니다.
                백업 이후 추가한 프로젝트, 계정 키와 작업 이력은 유지합니다. 복원된 프로젝트의 자동화는 일시중지됩니다.
              </Notice>
              {restore.error && <div style={{ marginTop: 10 }}><Notice tone="error">{restore.error.message}</Notice></div>}
            </>
          )}
        </Modal>
      )}
    </Card>
  );
}

function DiagnosticsCard() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const run = useAction<DiagnosticsReport>();

  async function generate() {
    const res = await run.run(() => api.runDiagnostics());
    if (res?.ok) setReport(res.data);
  }

  function download() {
    if (!report) return;
    // 로컬 앱: 받은 진단 내용을 파일로 내려받는다(서버가 구성한 값만, 비밀 제거됨).
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagnostics-${report.id ?? Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Card
      title="진단"
      icon={Stethoscope}
      actions={
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--sm" disabled={run.pending} onClick={() => void generate()}>
            {run.pending ? <Spinner /> : <Stethoscope size={13} />} 진단 실행
          </button>
          {report && (
            <button className="btn btn--sm" onClick={download}>
              <Download size={13} /> 내려받기
            </button>
          )}
        </div>
      }
    >
      {run.error && <Notice tone="error" title="진단 실패">{run.error.message}</Notice>}
      {!report ? (
        <p className="small muted" style={{ margin: 0 }}>
          진단을 실행하면 러너·보관함·도구·연결의 상태 묶음을 생성합니다. 비밀 값은 제외되며, 내용을 파일로 내려받아
          지원에 첨부할 수 있습니다.
        </p>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            {report.id && <span className="tag mono">{report.id}</span>}
            {report.createdAt && <span className="small muted">{formatDateTime(report.createdAt)}</span>}
          </div>
          {report.summary && <p className="small" style={{ margin: 0 }}>{report.summary}</p>}
          {Array.isArray(report.checks) && report.checks.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              {report.checks.map((c, i) => (
                <div key={i} className="row" style={{ gap: 8 }}>
                  {/ok|pass|ready/i.test(c.status) ? (
                    <CheckCircle2 size={14} color="var(--ok)" />
                  ) : (
                    <XCircle size={14} color="var(--error)" />
                  )}
                  <span className="small" style={{ fontWeight: 550 }}>{c.label}</span>
                  {c.detail && <span className="small muted">· {c.detail}</span>}
                </div>
              ))}
            </div>
          )}
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>진단 원본 보기</summary>
            <pre className="logbox" style={{ marginTop: 8 }}>{JSON.stringify(report, null, 2)}</pre>
          </details>
        </div>
      )}
    </Card>
  );
}
