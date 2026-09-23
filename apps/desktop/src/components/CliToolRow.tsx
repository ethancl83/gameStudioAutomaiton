import { useState } from "react";
import { Download, LogIn, LogOut, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { Badge, Spinner } from "./ui";
import { TerminalSetupButton } from "./StudioTerminal";
import "./studio.css";
import type {
  CliConnection,
  StudioTool,
  TerminalSession,
} from "../../../../packages/development/types";

export const TOOL_LABELS: Record<StudioTool, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  github: "GitHub CLI",
  netlify: "Netlify CLI",
  vercel: "Vercel CLI",
};

export function CliStatusBadge({ connection }: { connection?: CliConnection }) {
  if (!connection) return <Badge tone="neutral">확인 중</Badge>;
  if (connection.status === "connected") return <Badge tone="ok">로그인됨</Badge>;
  if (connection.status === "missing") return <Badge tone="warn">설치 필요</Badge>;
  if (!connection.executable) return <Badge tone="neutral">조회 안 함</Badge>;
  if (connection.status === "login_required") return <Badge tone="error">로그인 필요</Badge>;
  return <Badge tone="info">설치됨 · 미검사</Badge>;
}

// 설치·로그인·로그아웃은 공식 CLI를 앱 터미널에서 실행한다. 사용자 동의는 CLI가 여는 브라우저
// 화면에서만 받으며, 터미널이 끝나면 연결 상태를 다시 검사한다.
export function CliToolRow({
  tool,
  connection,
  onConnection,
  onTerminal,
  description,
}: {
  tool: StudioTool;
  connection?: CliConnection;
  onConnection: (connection: CliConnection) => void;
  onTerminal: (id: string, after?: () => void) => void;
  description?: string;
}) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const demo = api.isDemo();
  const installed = !!connection?.executable;
  async function check() {
    setPending("connection-check");
    setError("");
    try {
      const result = await api.studio<CliConnection>("connection-check", { tool });
      if (result.ok) onConnection(result.data);
      else setError(result.error.message);
    } finally {
      setPending("");
    }
  }
  async function open(action: "install" | "login" | "logout") {
    setPending(action);
    setError("");
    try {
      const result = await api.studio<TerminalSession>(action, { tool });
      if (result.ok) onTerminal(result.data.id, () => void check());
      else setError(result.error.message);
    } finally {
      setPending("");
    }
  }
  const busy = !!pending || demo;
  return (
    <div className="cli-row">
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="cli-row__name">
          {TOOL_LABELS[tool]}
          <CliStatusBadge connection={connection} />
        </div>
        <p className="cli-row__meta">
          {connection?.message ?? "설치 여부를 확인하고 있습니다."}
          {connection?.executable && ` · ${connection.executable}`}
        </p>
        {description && <p className="cli-row__meta">{description}</p>}
        {error && (
          <p className="cli-row__meta" role="alert" style={{ color: "var(--error)" }}>
            {error} <TerminalSetupButton error={error} onTerminal={(id) => onTerminal(id)} />
          </p>
        )}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {pending && <Spinner />}
        {connection?.status === "missing" && (
          <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void open("install")}>
            <Download size={13} aria-hidden />
            설치
          </button>
        )}
        {installed && (
          <>
            <button className="btn btn--sm" disabled={busy} onClick={() => void check()}>
              <ShieldCheck size={13} aria-hidden />
              연결 검사
            </button>
            <button
              className={`btn btn--sm${connection.status === "login_required" ? " btn--primary" : ""}`}
              disabled={busy}
              title="터미널에서 공식 CLI 로그인을 실행합니다. 동의는 CLI가 여는 브라우저 화면에서 진행합니다."
              onClick={() => void open("login")}
            >
              <LogIn size={13} aria-hidden />
              브라우저 로그인
            </button>
            <button
              className="btn btn--sm btn--ghost"
              disabled={busy || connection.status === "login_required"}
              onClick={() => void open("logout")}
            >
              <LogOut size={13} aria-hidden />
              로그아웃
            </button>
          </>
        )}
      </div>
    </div>
  );
}
