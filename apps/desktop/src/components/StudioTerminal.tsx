import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Square, X } from "lucide-react";
import { api } from "../api";
import { Badge } from "./ui";
import "./studio.css";
import type {
  DevelopmentState,
  TerminalOutput,
  TerminalSession,
} from "../../../../packages/development/types";

// 로그인·설치·연결처럼 끝난 뒤 후속 검사가 필요한 세션을 추적한다. 패널을 닫아도 세션 종료를 놓치지 않도록
// 대기 중인 세션이 있을 때만 제어 서비스 상태를 폴링하고, 패널의 종료 감지와 합쳐 콜백을 한 번만 실행한다.
export function useTerminalWatch() {
  const watchers = useRef(new Map<string, () => void>());
  const [count, setCount] = useState(0);
  const settle = useCallback((id: string) => {
    const after = watchers.current.get(id);
    if (!after) return;
    watchers.current.delete(id);
    setCount(watchers.current.size);
    after();
  }, []);
  const watch = useCallback((id: string, after: () => void) => {
    watchers.current.set(id, after);
    setCount(watchers.current.size);
  }, []);
  useEffect(() => {
    if (!count) return;
    let live = true;
    const timer = setInterval(async () => {
      const result = await api.studio<DevelopmentState>("state");
      if (!live || !result.ok) return;
      for (const session of result.data.terminals)
        if (session.status === "exited") settle(session.id);
    }, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [count, settle]);
  return { watch, settle };
}

// 터미널 호스트(tmux)가 없어서 실패한 경우에만 설치 버튼을 보여 준다.
export function TerminalSetupButton({
  error,
  onTerminal,
}: {
  error: string;
  onTerminal: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  if (!/tmux/i.test(error)) return null;
  return (
    <span className="row" style={{ gap: 6 }}>
      <button
        className="btn btn--sm"
        disabled={pending || api.isDemo()}
        onClick={async () => {
          setPending(true);
          setFailure("");
          try {
            const result = await api.studio<TerminalSession>("terminal-setup");
            if (result.ok) onTerminal(result.data.id);
            else setFailure(result.error.message);
          } finally {
            setPending(false);
          }
        }}
      >
        터미널(tmux) 설치
      </button>
      {failure && <span className="small">{failure}</span>}
    </span>
  );
}

// 패널을 닫으면 화면만 분리된다. tmux 세션은 제어 서비스에서 계속 실행되며 같은 id로 다시 열면
// 버퍼 전체를 다시 받아 이어서 보여준다.
export function StudioTerminal({
  id,
  onClose,
  onExit,
}: {
  id: string;
  onClose: () => void;
  onExit?: (code: number | undefined) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const [error, setError] = useState("");
  const [session, setSession] = useState<TerminalSession | null>(null);
  useEffect(() => {
    section.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [id]);
  useEffect(() => {
    if (!element.current) return;
    let disposed = false;
    let cursor = 0;
    let exited = false;
    let timer: ReturnType<typeof setTimeout>;
    setError("");
    setSession(null);
    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'SF Mono', Menlo, Consolas, monospace",
      theme: { background: "#111827" },
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    const resize = () => {
      if (disposed || exited || !element.current?.offsetWidth) return;
      fit.fit();
      void api.studio("terminal-resize", {
        id,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    resize();
    const input = terminal.onData((data) => {
      // 버퍼를 다시 재생할 때 xterm이 장치 속성·커서 위치 질의에 자동 응답한다. 이 응답이 실행 중인
      // 프로그램의 입력으로 들어가지 않게 사용자 입력만 보낸다.
      if (exited || /^(\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R|\x1b\[[IO])+$/.test(data)) return;
      void api.studio("terminal-input", { id, data }).then((result) => {
        if (!result.ok && !disposed) setError(result.error.message);
      });
    });
    const poll = async () => {
      const result = await api.studio<TerminalOutput>("terminal-read", {
        id,
        cursor,
      });
      if (disposed) return;
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") {
          setError(
            "이 세션의 기록이 남아 있지 않습니다. 앱을 다시 시작하면 로그인·설치 터미널은 정리됩니다.",
          );
          return;
        }
        // 일시적인 연결 오류는 잠시 뒤 다시 읽는다.
        setError(result.error.message);
        timer = setTimeout(poll, 2500);
        return;
      }
      setError("");
      if (result.data.reset) terminal.reset();
      terminal.write(result.data.data);
      cursor = result.data.cursor;
      setSession(result.data.session);
      if (result.data.session.status === "exited") {
        if (!exited) {
          exited = true;
          terminal.options.disableStdin = true;
          exitRef.current?.(result.data.session.exitCode);
          // 종료 감지 직후 도착한 마지막 출력을 한 번 더 받는다.
          timer = setTimeout(poll, 700);
        }
        return;
      }
      timer = setTimeout(poll, 250);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [id]);
  const running = session?.status === "running";
  return (
    <section className="studio-terminal" aria-label="작업 터미널" ref={section}>
      <div className="studio-terminal__head">
        <span className="studio-terminal__title">
          {session?.title ?? "터미널"}
        </span>
        {session &&
          (running ? (
            <Badge tone="progress">실행 중</Badge>
          ) : (
            <Badge tone={session.exitCode === 0 ? "ok" : "warn"}>
              종료{session.exitCode !== undefined && ` (코드 ${session.exitCode})`}
            </Badge>
          ))}
        <span style={{ marginLeft: "auto" }} />
        <button
          className="btn btn--sm"
          disabled={!running}
          title="실행 중인 명령을 종료합니다. 작업 파일은 보존됩니다."
          onClick={async () => {
            const result = await api.studio("terminal-stop", { id });
            if (!result.ok) setError(result.error.message);
          }}
        >
          <Square size={12} aria-hidden />
          실행 중지
        </button>
        <button className="btn btn--sm" onClick={onClose}>
          <X size={13} aria-hidden />
          패널 닫기
        </button>
      </div>
      <p className="studio-terminal__hint">
        {running
          ? "패널을 닫아도 실행은 계속됩니다. 같은 세션을 다시 열어 이어서 볼 수 있습니다."
          : "종료된 세션의 출력입니다."}
      </p>
      <div ref={element} className="studio-terminal__screen" />
      {error && (
        <div className="studio-terminal__error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
