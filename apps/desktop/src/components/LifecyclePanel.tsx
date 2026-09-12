// 앱/제어 서비스 수명주기 패널.
// - 제어 서비스는 화면(창)과 독립 실행된다. 창을 닫아도 인가된 자동화는 계속 실행된다.
// - 중지/재시작은 명시적 조치이며 IPC로 동작하므로 HTTP(/state)가 끊겨도 사용할 수 있다.
// - 데모 모드는 실제 제어 서비스·OS 자동 시작을 절대 바꾸지 않는다(변경 버튼 비활성, 상태는 읽기 전용).
// - 브라우저(비 Electron)에서는 데스크톱 전용 제어임을 안내하고 조작을 노출하지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleStop, Power, RefreshCw, ServerCog, ShieldAlert, Sunrise } from 'lucide-react';
import { api } from '../api';
import type { AutostartStatusView, LifecycleStatus } from '../../electron/preload';
import { Badge, Card, Notice, Spinner } from './ui';
import { formatRelative } from '../format';

type Phase = 'loading' | 'ready' | 'browser' | 'error';

export function LifecyclePanel() {
  const demo = api.isDemo();
  const electron = api.isElectron;
  const [status, setStatus] = useState<LifecycleStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState<null | 'stop' | 'restart' | 'autostart'>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const [stopped, setStopped] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const res = await api.lifecycleStatus();
    if (!mounted.current) return;
    if (res.ok) {
      setStatus(res.data);
      setPhase('ready');
      if (res.data.controller.running) setStopped(false);
    } else if (res.error.code === 'desktop_only') {
      setPhase('browser');
    } else {
      // 제어 서비스가 내려가 있어도 IPC status는 응답한다. running:false로 처리되므로 여기 도달은 드물다.
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    // 배경 엔진 상태를 주기적으로 갱신한다(조작 중에는 건너뛴다).
    const timer = setInterval(() => {
      if (!busyRef.current) void load();
    }, 8000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // busy를 인터벌 콜백에서 참조하기 위한 ref.
  const busyRef = useRef<typeof busy>(null);
  busyRef.current = busy;

  const doStop = useCallback(async () => {
    setBusy('stop');
    setMessage(null);
    const res = await api.stopController();
    if (!mounted.current) return;
    if (res.ok) {
      setStopped(true);
      setMessage({
        tone: res.data.wasRunning ? 'ok' : 'warn',
        text: res.data.wasRunning
          ? '제어 서비스를 중지했습니다. 자동화가 멈췄습니다. 아래에서 다시 시작할 수 있습니다.'
          : '실행 중인 제어 서비스가 확인되지 않아 아무 것도 중지하지 않았습니다.',
      });
      setStatus((prev) => (prev ? { ...prev, controller: { ...prev.controller, running: false } } : prev));
    } else {
      setMessage({ tone: 'error', text: res.error.message });
    }
    setBusy(null);
  }, []);

  const doRestart = useCallback(async () => {
    setBusy('restart');
    setMessage(null);
    const res = await api.restartController();
    if (!mounted.current) return;
    if (res.ok) {
      setStopped(false);
      setMessage({ tone: 'ok', text: '제어 서비스를 다시 시작했습니다.' });
      await load();
    } else {
      setMessage({ tone: 'error', text: res.error.message });
    }
    setBusy(null);
  }, [load]);

  const toggleAutostart = useCallback(
    async (enable: boolean) => {
      setBusy('autostart');
      setMessage(null);
      const res = enable ? await api.autostartEnable() : await api.autostartDisable();
      if (!mounted.current) return;
      if (res.ok) {
        setStatus((prev) => (prev ? { ...prev, autostart: res.data } : prev));
        setMessage({
          tone: 'ok',
          text: enable ? '로그인 시 자동 시작을 켰습니다.' : '로그인 시 자동 시작을 껐습니다.',
        });
      } else {
        setMessage({ tone: res.error.code === 'autostart_unstable_path' ? 'warn' : 'error', text: res.error.message });
      }
      setBusy(null);
    },
    [],
  );

  if (phase === 'browser') {
    return (
      <Card title="앱·제어 서비스 수명주기" icon={ServerCog}>
        <Notice tone="info" title="데스크톱 전용 제어">
          제어 서비스 중지·재시작과 로그인 자동 시작은 데스크톱 앱에서만 조작할 수 있습니다. 브라우저 미리보기에서는
          이 제어를 제공하지 않습니다.
        </Notice>
      </Card>
    );
  }

  return (
    <Card
      title="앱·제어 서비스 수명주기"
      icon={ServerCog}
      actions={
        <button className="btn btn--sm btn--ghost" onClick={() => void load()} disabled={busy !== null} aria-label="상태 새로고침">
          <RefreshCw size={14} /> 새로고침
        </button>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          제어 서비스는 창과 별개로 실행됩니다. 앱(창)을 닫아도 인가된 자동화는 계속 실행되며, 중지·재시작은 명시적
          조치입니다.
        </p>

        {demo && (
          <Notice tone="info" title="데모 모드">
            데모에서는 실제 제어 서비스나 OS 자동 시작을 바꾸지 않습니다. 아래 상태는 실제 데스크톱 제어 서비스를 읽기
            전용으로 보여 줍니다.
          </Notice>
        )}

        {phase === 'loading' ? (
          <div className="row" style={{ gap: 8 }}>
            <Spinner /> 상태를 확인하는 중…
          </div>
        ) : status ? (
          <ControllerStatusRow status={status} stopped={stopped} />
        ) : (
          <Notice tone="warn">수명주기 상태를 확인할 수 없습니다.</Notice>
        )}

        {message && <Notice tone={message.tone === 'ok' ? 'info' : message.tone}>{message.text}</Notice>}

        {electron && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn--sm"
              onClick={() => void doStop()}
              disabled={demo || busy !== null || (status ? !status.controller.running : false)}
              title={demo ? '데모에서는 실제 제어 서비스를 중지하지 않습니다.' : '자동화 중지(명시적)'}
            >
              {busy === 'stop' ? <Spinner /> : <CircleStop size={14} />} 자동화 중지
            </button>
            <button
              className="btn btn--sm btn--primary"
              onClick={() => void doRestart()}
              disabled={demo || busy !== null}
              title={demo ? '데모에서는 실제 제어 서비스를 다시 시작하지 않습니다.' : '제어 서비스 다시 시작(IPC)'}
            >
              {busy === 'restart' ? <Spinner /> : <Power size={14} />} 다시 시작
            </button>
          </div>
        )}

        {stopped && electron && !demo && (
          <Notice
            tone="warn"
            title="제어 서비스가 중지되었습니다"
            action={
              <button className="btn btn--sm btn--primary" onClick={() => void doRestart()} disabled={busy !== null}>
                {busy === 'restart' ? <Spinner /> : <Power size={14} />} 지금 다시 시작
              </button>
            }
          >
            자동화가 멈췄고 화면의 실시간 데이터(HTTP)도 끊깁니다. 이 다시 시작 버튼은 HTTP 없이 IPC로 동작합니다.
          </Notice>
        )}

        {status?.sandbox && !status.sandbox.ok && (
          <Notice tone="warn" title="네이티브 샌드박스 준비 필요">
            <span className="row" style={{ gap: 6 }}>
              <ShieldAlert size={14} /> {status.sandbox.detail}
            </span>
          </Notice>
        )}

        {electron && status && (
          <AutostartRow
            autostart={status.autostart}
            installable={status.autostartInstallable}
            demo={demo}
            busy={busy === 'autostart'}
            disabled={busy !== null}
            onToggle={toggleAutostart}
          />
        )}
      </div>
    </Card>
  );
}

function ControllerStatusRow({ status, stopped }: { status: LifecycleStatus; stopped: boolean }) {
  const running = status.controller.running && !stopped;
  return (
    <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
      <Badge tone={running ? 'ok' : 'neutral'}>{running ? '제어 서비스 실행 중' : '제어 서비스 중지됨'}</Badge>
      {running && status.controller.adopted && <span className="muted">기존 인스턴스 인수</span>}
      {running && status.controller.port !== undefined && <span className="muted">포트 {status.controller.port}</span>}
      {running && status.controller.startedAt && (
        <span className="muted">기동 {formatRelative(status.controller.startedAt)}</span>
      )}
    </div>
  );
}

function AutostartRow({
  autostart,
  installable,
  demo,
  busy,
  disabled,
  onToggle,
}: {
  autostart: AutostartStatusView;
  installable: boolean;
  demo: boolean;
  busy: boolean;
  disabled: boolean;
  onToggle: (enable: boolean) => void;
}) {
  return (
    <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 6, fontWeight: 600 }}>
          <Sunrise size={15} aria-hidden /> 로그인 자동 시작
        </span>
        <Badge tone={autostart.enabled ? 'ok' : 'neutral'}>{autostart.enabled ? '켜짐' : '꺼짐'}</Badge>
        <span className="muted">{autostart.method}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        로그인 시 제어 서비스를 백그라운드로 시작해 화면 없이도 예약된 자동화(빌드·게시·SNS)를 실행합니다.
      </p>
      {!installable && (
        <Notice tone="info">
          안정된 설치 경로에서 실행 중이 아닙니다(개발·임시 실행). 앱을 설치한 뒤 자동 시작을 설정할 수 있습니다.
        </Notice>
      )}
      <div className="row" style={{ gap: 8 }}>
        {autostart.enabled ? (
          <button
            className="btn btn--sm"
            onClick={() => onToggle(false)}
            disabled={demo || disabled}
            title={demo ? '데모에서는 실제 자동 시작을 바꾸지 않습니다.' : undefined}
          >
            {busy ? <Spinner /> : null} 자동 시작 끄기
          </button>
        ) : (
          <button
            className="btn btn--sm"
            onClick={() => onToggle(true)}
            disabled={demo || disabled || !installable}
            title={demo ? '데모에서는 실제 자동 시작을 바꾸지 않습니다.' : undefined}
          >
            {busy ? <Spinner /> : null} 자동 시작 켜기
          </button>
        )}
      </div>
    </div>
  );
}
