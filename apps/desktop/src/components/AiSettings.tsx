import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Bot, ListRestart, RefreshCw, TerminalSquare } from "lucide-react";
import { api } from "../api";
import { Card, Notice, Spinner } from "./ui";
import { StudioTerminal, useTerminalWatch } from "./StudioTerminal";
import { CliToolRow } from "./CliToolRow";
import "./studio.css";
import type {
  AgentChoice,
  AgentProvider,
  AgentPurpose,
  AgentRuntime,
  AgentSettings,
} from "../../../../packages/agent/types";
import type { CliConnection } from "../../../../packages/development/types";

const purposes: [AgentPurpose, string, string][] = [
  ["analysis", "분석·문서", "이슈·PR 분석과 개발 계획 문서"],
  ["coding", "코딩", "계획에 따른 구현"],
  ["review", "리뷰", "구현 결과 독립 리뷰"],
  ["operations", "운영 대화", "AI 운영 화면의 대화"],
];
const AI_TOOLS: AgentProvider[] = ["codex", "opencode"];
const providerLabel = (p: AgentChoice["provider"]) =>
  p === "codex" ? "Codex" : p === "opencode" ? "OpenCode" : "자동 선택";

const settingsKey = (s: AgentSettings) =>
  JSON.stringify([
    s.provider,
    s.model ?? "",
    purposes.map(([key]) => {
      const choice = s.purposes?.[key];
      return choice ? [choice.provider, choice.model ?? ""] : null;
    }),
  ]);

export function AiSettings() {
  const listId = useId();
  const [saved, setSaved] = useState<AgentSettings | null>(null);
  const [settings, setSettings] = useState<AgentSettings>({ provider: "auto" });
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>([]);
  const [connections, setConnections] = useState<CliConnection[]>([]);
  const [models, setModels] = useState<Partial<Record<AgentProvider, string[]>>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState("");
  const [terminal, setTerminal] = useState("");
  const { watch, settle } = useTerminalWatch();
  const demo = api.isDemo();

  const detect = useCallback(async () => {
    const [agent, cli] = await Promise.all([
      api.agentState(),
      api.studio<CliConnection[]>("connections"),
    ]);
    if (agent.ok) setRuntimes(agent.data.runtimes);
    if (cli.ok) setConnections(cli.data.filter((c) => AI_TOOLS.includes(c.tool as AgentProvider)));
    return agent;
  }, []);
  useEffect(() => {
    let live = true;
    // 저장된 설정을 받기 전에는 폼을 표시하지 않아, 늦게 온 응답이 사용자의 변경을 덮어쓰지 않는다.
    void api.agentState().then((agent) => {
      if (!live) return;
      if (agent.ok) {
        setSettings(agent.data.settings);
        setSaved(agent.data.settings);
        setRuntimes(agent.data.runtimes);
      } else setError(agent.error.message);
    });
    void api.studio<CliConnection[]>("connections").then((cli) => {
      if (live && cli.ok) setConnections(cli.data.filter((c) => AI_TOOLS.includes(c.tool as AgentProvider)));
    });
    return () => {
      live = false;
    };
  }, []);

  const autoResolved = runtimes.find((r) => r.executable)?.provider;
  const dirty = !!saved && settingsKey(saved) !== settingsKey(settings);

  async function loadModels(provider: AgentProvider) {
    setPending(`models-${provider}`);
    setError("");
    setMessage("");
    try {
      const r = await api.studio<string[]>("models", { tool: provider });
      if (!r.ok) return setError(r.error.message);
      setModels((v) => ({ ...v, [provider]: r.data }));
      setMessage(
        r.data.length
          ? `${providerLabel(provider)} 모델 ${r.data.length}개를 불러왔습니다. 모델 입력칸에서 선택하세요.`
          : `${providerLabel(provider)} 모델 목록이 아직 없습니다. 비워 두면 CLI 기본 모델을 사용합니다.`,
      );
    } finally {
      setPending("");
    }
  }

  // provider가 바뀌면 이전 CLI의 모델 이름은 맞지 않으므로 비운다.
  const picker = (label: string, value: AgentChoice, onChange: (v: AgentChoice) => void) => {
    const effective = value.provider === "auto" ? autoResolved : value.provider;
    return (
      <div className="choice-picker">
        <select
          aria-label={`${label} AI CLI`}
          className="select"
          value={value.provider}
          onChange={(e) =>
            onChange({ provider: e.target.value as AgentChoice["provider"] })
          }
        >
          <option value="auto">
            자동 선택{autoResolved ? ` (${providerLabel(autoResolved)})` : ""}
          </option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
        </select>
        <input
          className="input"
          list={effective ? `${listId}-${effective}` : undefined}
          aria-label={`${label} 모델`}
          placeholder="비우면 CLI 기본 모델"
          value={value.model ?? ""}
          onChange={(e) =>
            onChange({ ...value, model: e.target.value || undefined })
          }
        />
        {value.provider !== "auto" && (
          <button
            className="btn btn--sm"
            disabled={!!pending || demo}
            title="CLI에 저장된 모델 목록을 읽습니다."
            onClick={() => void loadModels(value.provider as AgentProvider)}
          >
            {pending === `models-${value.provider}` ? <Spinner /> : <ListRestart size={13} aria-hidden />}
            모델 목록
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <Card
        title="앱 내부 AI"
        icon={Bot}
        actions={
          dirty ? <span className="small muted">저장하지 않은 변경</span> : undefined
        }
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          설치된 Codex·OpenCode CLI의 기존 로그인을 그대로 사용합니다. 모델을 비우면 CLI
          설정을 따르며, 변경은 새로 시작하는 작업부터 적용됩니다.
        </p>
        {AI_TOOLS.map((tool) => (
          <datalist key={tool} id={`${listId}-${tool}`}>
            {(models[tool] ?? []).map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
        ))}
        {!saved ? (
          !error && <Spinner />
        ) : (
        <div className="purpose-grid">
          <span className="purpose-grid__label">기본 AI</span>
          {picker("기본", settings, (v) => setSettings({ ...settings, provider: v.provider, model: v.model }))}
          {purposes.map(([key, label, hint]) => {
            const override = settings.purposes?.[key];
            return (
              <PurposeRow
                key={key}
                label={label}
                hint={hint}
                enabled={!!override}
                onToggle={(on) => {
                  const next = { ...settings.purposes };
                  if (on) next[key] = { provider: settings.provider, ...(settings.model ? { model: settings.model } : {}) };
                  else delete next[key];
                  setSettings({ ...settings, purposes: next });
                }}
              >
                {override &&
                  picker(label, override, (v) =>
                    setSettings({ ...settings, purposes: { ...settings.purposes, [key]: v } }),
                  )}
              </PurposeRow>
            );
          })}
        </div>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <button
            className="btn btn--primary"
            disabled={!!pending || !saved || !dirty}
            onClick={async () => {
              setPending("save");
              setError("");
              setMessage("");
              try {
                // 빈 모델은 명시적으로 보내야 이전에 저장한 모델이 지워진다.
                const r = await api.saveAgentSettings({ ...settings, model: settings.model ?? "", purposes: settings.purposes ?? {} });
                if (r.ok) {
                  setSettings(r.data);
                  setSaved(r.data);
                  setMessage("AI 설정을 저장했습니다. 새로 시작하는 작업부터 적용됩니다.");
                } else setError(r.error.message);
              } finally {
                setPending("");
              }
            }}
          >
            AI 설정 저장
          </button>
          {dirty && (
            <button className="btn btn--ghost" disabled={!!pending} onClick={() => saved && setSettings(saved)}>
              되돌리기
            </button>
          )}
        </div>
        {message && <Notice tone="info">{message}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
      </Card>
      <Card
        title="AI CLI 설치·로그인"
        icon={TerminalSquare}
        actions={
          <button
            className="btn btn--sm"
            disabled={!!pending}
            onClick={async () => {
              setPending("detect");
              try {
                await detect();
              } finally {
                setPending("");
              }
            }}
          >
            {pending === "detect" ? <Spinner /> : <RefreshCw size={13} aria-hidden />}
            다시 탐지
          </button>
        }
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          로그인은 공식 CLI를 앱 터미널에서 실행하고, 동의는 CLI가 여는 브라우저 화면에서만 진행합니다.
          앱은 API 키를 따로 저장하지 않습니다.
        </p>
        {AI_TOOLS.map((tool) => (
          <CliToolRow
            key={tool}
            tool={tool}
            connection={connections.find((c) => c.tool === tool)}
            onConnection={(c) => setConnections((cs) => [...cs.filter((v) => v.tool !== c.tool), c])}
            onTerminal={(id, after) => {
              watch(id, () => void detect().then(() => after?.()));
              setTerminal(id);
            }}
          />
        ))}
        {demo && <Notice tone="info">데모에서는 CLI를 설치하거나 로그인하지 않습니다.</Notice>}
      </Card>
      {terminal && (
        <StudioTerminal
          id={terminal}
          onClose={() => setTerminal("")}
          onExit={() => settle(terminal)}
        />
      )}
    </>
  );
}

function PurposeRow({
  label,
  hint,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  hint: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <span className="purpose-grid__label">
        {label}
        <span className="small muted" style={{ display: "block", fontWeight: 400 }}>
          {hint}
        </span>
      </span>
      <div className="stack" style={{ gap: 6 }}>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          {enabled ? "이 용도에 다른 AI 사용" : "기본 AI 사용 (체크하면 따로 선택)"}
        </label>
        {children}
      </div>
    </>
  );
}
