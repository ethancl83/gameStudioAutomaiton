// 전체(포터블) 암호화 백업 패널.
// - 설정 백업(프로젝트·정책·설정)과 별개로, 자격 증명·산출물·이력까지 담은 암호화 아카이브를 다룬다.
// - 생성/진행/실패/재시도·내보내기·가져오기·복원 준비·덮어쓰기 복원을 한 화면에서 제공한다.
// - 대용량 파일은 데스크톱에서 main이 loopback+bearer로 스트리밍한다(renderer는 바이트·경로·토큰을
//   만지지 않는다). 브라우저(데모/미리보기)는 인증 세션으로 파일 입력·다운로드 폴백을 제공한다.
// - 암호는 각 작업마다 입력하며 요청 직후 비운다. 저장·기록·오류 표시에 남기지 않는다.
// - 데모는 격리 저장공간에서만 복원하며 실제 제어 서비스를 절대 재시작하지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Download, KeyRound, Lock, RefreshCcw, RotateCw, ShieldCheck, Upload } from 'lucide-react';
import { api } from '../api';
import type {
  PortableBackupRecord,
  PortableBackupState,
  PortableRestoreRecord,
} from '../../../../packages/backup/types';
import { formatDateTime, formatRelative } from '../format';
import { Badge, Card, Field, Modal, Notice, Spinner } from './ui';

type Phase = 'loading' | 'ready' | 'error';
type PanelNotice = { tone: 'ok' | 'warn' | 'error'; text: string } | null;

const PASS_MIN = 12;
const PASS_MAX = 1024;

const STATUS_META: Record<PortableBackupRecord['status'], { label: string; tone: 'ok' | 'warn' | 'error' | 'info' }> = {
  creating: { label: '생성 중', tone: 'info' },
  ready: { label: '준비됨', tone: 'ok' },
  failed: { label: '실패', tone: 'error' },
};

function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function passphraseValid(p: string): boolean {
  return p.length >= PASS_MIN && p.length <= PASS_MAX;
}

function hasActiveWork(state: PortableBackupState | null): boolean {
  if (!state) return false;
  if (state.busy) return true;
  if (state.backups.some((b) => b.status === 'creating')) return true;
  return state.restore?.status === 'preparing';
}

export function PortableBackupPanel({ refresh }: { refresh: () => Promise<void> }) {
  const electron = api.isElectron;
  const [state, setState] = useState<PortableBackupState | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<PanelNotice>(null);
  const [busy, setBusy] = useState<string | null>(null); // 'create' | 'import' | `save:${id}`
  const [restoreTarget, setRestoreTarget] = useState<PortableBackupRecord | null>(null);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await api.getPortableBackups();
    if (!mounted.current) return;
    if (res.ok) {
      setState(res.data);
      setPhase('ready');
      setError(null);
    } else {
      setError(res.error.message);
      setPhase((prev) => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // 진행 중 작업이 있는 동안만 주기적으로 상태를 폴링한다(생성·준비·서버 busy). 없으면 멈춘다.
  const active = hasActiveWork(state);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [active, load]);

  // --- 생성 ---
  const [createPass, setCreatePass] = useState('');
  const doCreate = useCallback(async () => {
    if (!passphraseValid(createPass) || busy) return;
    setBusy('create');
    setNotice(null);
    const pass = createPass;
    setCreatePass(''); // 요청 후 즉시 비운다.
    const res = await api.createPortableBackup(pass);
    if (!mounted.current) return;
    if (res.ok) {
      setNotice({ tone: 'ok', text: '전체 백업을 생성하기 시작했습니다. 진행 상태는 아래 목록에서 갱신됩니다.' });
      await load();
    } else {
      setNotice({ tone: 'error', text: res.error.message });
    }
    setBusy(null);
  }, [createPass, busy, load]);

  // --- 내보내기(다운로드→디스크) ---
  const doSave = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(`save:${id}`);
      setNotice(null);
      const res = await api.savePortableBackup(id);
      if (!mounted.current) return;
      if (res.ok) setNotice({ tone: 'ok', text: '전체 백업을 파일로 저장했습니다.' });
      else if (res.canceled) setNotice(null);
      else setNotice({ tone: 'error', text: res.error ?? '내보내기에 실패했습니다.' });
      setBusy(null);
    },
    [busy],
  );

  // --- 가져오기(파일→업로드) ---
  const doImportNative = useCallback(async () => {
    if (busy) return;
    setBusy('import');
    setNotice(null);
    const res = await api.importPortableBackupNative();
    if (!mounted.current) return;
    if (res.ok) {
      setNotice({ tone: 'ok', text: `백업을 가져왔습니다(${bytes(res.data.size)}). 복원하려면 목록에서 복원 준비를 진행하세요.` });
      await load();
    } else if (res.error.code !== 'canceled') {
      setNotice({ tone: 'error', text: res.error.message });
    }
    setBusy(null);
  }, [busy, load]);

  const onImportClick = useCallback(() => {
    if (busy) return;
    if (electron) void doImportNative();
    else fileInput.current?.click();
  }, [busy, electron, doImportNative]);

  const onFileChosen = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // 같은 파일 재선택 허용 + 참조 정리
      if (!file) return;
      setBusy('import');
      setNotice(null);
      const res = await api.importPortableBackupFromFile(file);
      if (!mounted.current) return;
      if (res.ok) {
        setNotice({ tone: 'ok', text: `백업을 가져왔습니다(${bytes(res.data.size)}). 복원하려면 목록에서 복원 준비를 진행하세요.` });
        await load();
      } else {
        setNotice({ tone: 'error', text: res.error.message });
      }
      setBusy(null);
    },
    [load],
  );

  const createValid = passphraseValid(createPass);

  return (
    <Card
      title="전체 백업(암호화 아카이브)"
      icon={ShieldCheck}
      actions={
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--sm" onClick={() => void load()} disabled={busy !== null} aria-label="새로고침">
            <RefreshCcw size={14} /> 새로고침
          </button>
          <button className="btn btn--sm" onClick={onImportClick} disabled={busy !== null}>
            {busy === 'import' ? <Spinner /> : <Upload size={14} />} 가져오기
          </button>
        </div>
      }
    >
      {!electron && (
        <input
          ref={fileInput}
          type="file"
          accept=".appopsbackup,application/vnd.appops.backup"
          onChange={(e) => void onFileChosen(e)}
          hidden
        />
      )}

      <div className="stack" style={{ gap: 12 }}>
        <Notice tone="info" title="설정 백업과 다릅니다">
          전체 백업은 프로젝트·정책·설정에 더해 <strong>계정 자격 증명·빌드 산출물·작업 이력</strong>까지 하나의
          <strong> 암호로 보호되는 아카이브</strong>로 담습니다. 다른 기기로 옮기거나 전체 복구에 사용합니다. 암호는 각
          작업마다 입력하며 저장하지 않습니다 — <strong>암호를 잃어버리면 복호화할 수 없습니다.</strong>
        </Notice>

        {/* 생성 */}
        <div className="stack pb-form" style={{ gap: 8 }}>
          <Field
            label="백업 암호(12자 이상)"
            required
            htmlFor="pb-pass"
            hint="이 암호로 아카이브를 암호화합니다. 복원 시 같은 암호가 필요합니다. 저장·표시되지 않습니다."
          >
            <input
              id="pb-pass"
              className="input"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={createPass}
              maxLength={PASS_MAX}
              onChange={(e) => setCreatePass(e.target.value)}
              placeholder="긴 암호구절을 권장합니다"
            />
          </Field>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <button className="btn btn--primary" onClick={() => void doCreate()} disabled={!createValid || busy !== null}>
              {busy === 'create' ? <Spinner /> : <Archive size={15} />} 전체 백업 생성
            </button>
            {createPass.length > 0 && !createValid && (
              <span className="small muted">암호는 {PASS_MIN}–{PASS_MAX}자여야 합니다.</span>
            )}
          </div>
        </div>

        {notice && <Notice tone={notice.tone === 'ok' ? 'info' : notice.tone}>{notice.text}</Notice>}
        {phase === 'error' && !state && (
          <Notice tone="warn" title="전체 백업 상태를 불러올 수 없습니다">
            {error ?? '제어 서비스에서 상태를 받지 못했습니다.'}
          </Notice>
        )}

        {/* 목록 */}
        {phase === 'loading' ? (
          <div className="row" style={{ gap: 8 }}>
            <Spinner /> 전체 백업 상태를 확인하는 중…
          </div>
        ) : state && state.backups.length > 0 ? (
          <div className="table__scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>생성</th>
                  <th>상태</th>
                  <th>크기</th>
                  <th>파일</th>
                  <th>자격 증명</th>
                  <th aria-label="동작" />
                </tr>
              </thead>
              <tbody>
                {state.backups.map((b) => (
                  <BackupRow key={b.id} b={b} busy={busy} onSave={doSave} onRestore={() => setRestoreTarget(b)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            아직 전체 백업이 없습니다. 위에서 암호를 입력해 생성하거나, 다른 기기의 백업 파일을 가져오세요.
          </p>
        )}
      </div>

      {restoreTarget && state && (
        <RestoreModal
          target={restoreTarget}
          restore={state.restore && state.restore.backupId === restoreTarget.id ? state.restore : null}
          onClose={() => setRestoreTarget(null)}
          reload={load}
          refresh={refresh}
        />
      )}
    </Card>
  );
}

function BackupRow({
  b,
  busy,
  onSave,
  onRestore,
}: {
  b: PortableBackupRecord;
  busy: string | null;
  onSave: (id: string) => void;
  onRestore: () => void;
}) {
  const meta = b.origin === 'imported' && b.status === 'ready' ? { label: '암호 검증 대기', tone: 'warn' as const } : STATUS_META[b.status];
  const saving = busy === `save:${b.id}`;
  return (
    <tr>
      <td className="small nowrap" title={formatDateTime(b.createdAt)}>{formatRelative(b.createdAt)}</td>
      <td>
        <span className="row" style={{ gap: 6 }}>
          {b.status === 'creating' && <Spinner />}
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </span>
        {b.status === 'failed' && b.error && <div className="small" style={{ color: 'var(--error)', marginTop: 4 }}>{b.error}</div>}
      </td>
      <td className="small nowrap">{b.status === 'ready' ? bytes(b.size) : '—'}</td>
      <td className="mono small">{b.origin === 'imported' ? '복원 준비에서 확인' : b.fileCount}</td>
      <td className="mono small">{b.origin === 'imported' ? '복원 준비에서 확인' : b.credentialCount}</td>
      <td>
        {b.status === 'ready' ? (
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button className="btn btn--sm" disabled={busy !== null} onClick={() => onSave(b.id)}>
              {saving ? <Spinner /> : <Download size={13} />} 내보내기
            </button>
            <button className="btn btn--sm btn--danger" disabled={busy !== null} onClick={onRestore}>
              <RotateCw size={13} /> 복원 준비
            </button>
          </div>
        ) : b.status === 'failed' ? (
          <span className="small muted">새 백업으로 다시 시도하세요.</span>
        ) : (
          <span className="small muted">생성 중…</span>
        )}
      </td>
    </tr>
  );
}

function RestoreModal({
  target,
  restore,
  onClose,
  reload,
  refresh,
}: {
  target: PortableBackupRecord;
  restore: PortableRestoreRecord | null;
  onClose: () => void;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [pass, setPass] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [committed, setCommitted] = useState<{ restartRequired: boolean; confirmed: boolean } | null>(null);
  const [restarting, setRestarting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const passValid = passphraseValid(pass);
  const ready = restore?.status === 'ready';
  const preparing = restore?.status === 'preparing' || (pending && !restore);
  const failed = restore?.status === 'failed';

  const doPrepare = useCallback(async () => {
    if (!passValid || pending) return;
    setPending(true);
    setErr(null);
    const p = pass;
    setPass(''); // 요청 후 즉시 비운다.
    const res = await api.preparePortableRestore(target.id, p);
    if (!mounted.current) return;
    if (!res.ok) setErr(res.error.message);
    setPending(false);
    await reload();
  }, [pass, passValid, pending, target.id, reload]);

  const doCommit = useCallback(async () => {
    if (!restore || restore.status !== 'ready' || pending) return;
    setPending(true);
    setErr(null);
    const res = await api.commitPortableRestore(restore.id);
    if (!mounted.current) return;
    if (res.ok) {
      if (res.data.restartRequired) {
        // 실제 복원: 복원된 데이터를 적재하도록 제어 서비스를 명시적으로 재시작한다(IPC).
        setCommitted({ restartRequired: true, confirmed: false });
        setRestarting(true);
        const restarted = await api.restartController();
        if (!restarted.ok) setErr(restarted.error.message + ' 복원 전환은 대기 중입니다. 데스크톱 앱에서 제어 서비스를 다시 시작해 주세요.');
        else {
          const checked = await api.getPortableBackups();
          if (checked.ok && checked.data.restore?.id === restore.id && checked.data.restore.status === 'committed') setCommitted({restartRequired:true,confirmed:true});
          else setErr(checked.ok ? checked.data.restore?.error ?? '복원이 완료되었는지 확인하지 못했습니다. 운영·복구 화면에서 상태를 확인해 주세요.' : checked.error.message);
        }
        if (mounted.current) setRestarting(false);
        await refresh().catch(() => {});
      } else if (res.data.restored === true) {
        // 데모 복원: 격리 데모 재활성 성공(restored:true)일 때만 완료로 확정한다.
        setCommitted({ restartRequired: false, confirmed: true });
        await refresh().catch(() => {});
      } else {
        // 커밋은 반환됐지만 restored:true가 없다 — 완료로 표시하지 않고 재시도를 안내한다.
        setErr('데모 복원이 완료되었는지 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
    } else {
      setErr(res.error.message);
    }
    setPending(false);
    await reload();
  }, [restore, pending, reload, refresh]);

  const title = '전체 백업에서 복원';

  if (committed) {
    return (
      <Modal
        title={title}
        onClose={onClose}
        footer={<button className="btn btn--primary" onClick={onClose}>닫기</button>}
      >
        {err && <Notice tone="error" title="복원 상태 확인 필요">{err}</Notice>}
        {committed.restartRequired && !committed.confirmed ? (
          <Notice tone="warn" title={restarting ? '복원 후 재시작 중…' : '복원 전환 확인 대기'}>검증한 백업을 선택했습니다. 제어 서비스가 복원한 데이터로 시작했는지 확인한 뒤 완료로 표시합니다.</Notice>
        ) : committed.restartRequired ? (
          <Notice tone="info" title={restarting ? '복원 후 재시작 중…' : '복원 완료 — 제어 서비스를 다시 시작했습니다'}>
            전체 백업을 복원하고 제어 서비스를 다시 시작했습니다. 프로젝트는 <strong>원본 폴더 연결</strong>이 필요할 수
            있고, 복원된 자동화는 <strong>일시중지</strong> 상태이며, 계정 자격 증명은 <strong>보존</strong>되었습니다. 화면을
            새로고침해 최신 상태를 확인하세요.
          </Notice>
        ) : (
          <Notice tone="info" title="데모 복원 완료">
            데모 저장공간에만 복원했습니다. 실제 제어 서비스는 재시작하지 않았습니다.
          </Notice>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        ready ? (
          <>
            <button className="btn" onClick={onClose} disabled={pending}>취소</button>
            <button className="btn btn--danger" onClick={() => void doCommit()} disabled={pending}>
              {pending ? <Spinner /> : <RotateCw size={15} />} 덮어쓰기 복원 실행
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose} disabled={pending}>취소</button>
            <button className="btn btn--primary" onClick={() => void doPrepare()} disabled={!passValid || pending || preparing}>
              {pending || preparing ? <Spinner /> : <KeyRound size={15} />} 복원 준비
            </button>
          </>
        )
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        {ready && restore ? (
          <>
            <Notice tone="warn" title="복원하면 현재 데이터를 덮어씁니다">
              이 백업으로 <strong>프로젝트 {restore.projectCount}개</strong>, 파일 {restore.fileCount}개, 자격 증명{' '}
              {restore.credentialCount}개를 복원합니다. 계속하면 현재 데이터를 <strong>덮어씁니다</strong>. 복원 후:
              <ul className="pb-restore-list">
                <li>프로젝트는 <strong>원본 폴더 연결</strong>이 필요할 수 있습니다.</li>
                <li>복원된 자동화(빌드·배포·광고·커뮤니티)는 <strong>일시중지</strong> 상태로 시작합니다.</li>
                <li>계정 자격 증명·키는 <strong>보존</strong>됩니다.</li>
              </ul>
            </Notice>
            <p className="small muted" style={{ margin: 0 }}>
              아래 <strong>덮어쓰기 복원 실행</strong>을 눌러야 실제로 적용됩니다.
            </p>
          </>
        ) : preparing ? (
          <div className="row" style={{ gap: 8 }}>
            <Spinner /> 백업을 열고 복원 내용을 확인하는 중…
          </div>
        ) : (
          <>
            <Notice tone="info">
              <span className="row" style={{ gap: 6 }}>
                <Lock size={14} /> 이 백업을 만들 때 사용한 암호를 입력하면 복원 내용을 미리 확인합니다. 확인 후 별도의 명시적
                버튼을 눌러야 덮어쓰기가 실행됩니다.
              </span>
            </Notice>
            <Field label="백업 암호" required htmlFor="pb-restore-pass">
              <input
                id="pb-restore-pass"
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={pass}
                maxLength={PASS_MAX}
                onChange={(e) => setPass(e.target.value)}
              />
            </Field>
            {failed && restore?.error && <Notice tone="error">{restore.error}</Notice>}
          </>
        )}
        {err && <Notice tone="error">{err}</Notice>}
      </div>
    </Modal>
  );
}
