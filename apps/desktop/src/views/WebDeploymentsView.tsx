import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Globe, History, Link2, RefreshCw, Rocket, TerminalSquare } from "lucide-react";
import type { AppState } from "../../../../packages/domain";
import type {
  CliConnection,
  DevelopmentState,
  GitState,
  TerminalSession,
  WebDeployment,
} from "../../../../packages/development/types";
import { api } from "../api";
import { formatRelative } from "../format";
import type { ViewKey } from "../App";
import { Badge, Card, ConfirmIcon, EmptyState, Notice, Spinner } from "../components/ui";
import { StudioTerminal, TerminalSetupButton, useTerminalWatch } from "../components/StudioTerminal";
import { CliToolRow } from "../components/CliToolRow";
import "../components/studio.css";

type Provider = "netlify" | "vercel";
interface Inspection {
  root: string;
  framework: string;
  buildCommand: string;
  output: string;
  bindings: Array<{ file: string; data: Record<string, unknown> | null }>;
  // Netlify 업로드에서 공개할 폴더를 안전하게 정할 수 없을 때의 안내(서버 소스·문서가 섞인 루트 등).
  publicationError?: string;
}
const PROVIDERS: Record<Provider, string> = { vercel: "Vercel", netlify: "Netlify" };
const deployStatus: Record<WebDeployment["status"], [string, "ok" | "error" | "warn" | "progress"]> = {
  running: ["진행 중", "progress"],
  succeeded: ["완료", "ok"],
  failed: ["실패", "error"],
  action_required: ["결과 확인 필요", "warn"],
};

function binding(inspection: Inspection | null, provider: Provider) {
  const data = inspection?.bindings.find((b) => b.file.startsWith(`.${provider}/`))?.data;
  if (!data) return null;
  const valid =
    provider === "netlify"
      ? typeof data.siteId === "string"
      : typeof data.projectId === "string" && typeof data.orgId === "string";
  return valid ? data : null;
}

export function WebDeploymentsView({ state, goTo }: { state: AppState; goTo: (view: ViewKey) => void }) {
  const demo = api.isDemo();
  const [projectId, setProjectId] = useState(state.projects[0]?.id ?? "");
  const [provider, setProvider] = useState<Provider>("vercel");
  const [studio, setStudio] = useState<DevelopmentState | null>(null);
  const [checked, setChecked] = useState<Partial<Record<string, CliConnection>>>({});
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [inspectError, setInspectError] = useState("");
  const [git, setGit] = useState<GitState | null>(null);
  const [gitError, setGitError] = useState("");
  // 현재 프로젝트의 설정 감지와 Git 조회가 모두 성공했을 때만 배포를 허용한다.
  const [loadedFor, setLoadedFor] = useState("");
  const [production, setProduction] = useState(false);
  const [terminal, setTerminal] = useState("");
  const autoOpened = useRef(new Set<string>());
  const { watch, settle } = useTerminalWatch();
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const inspectSeq = useRef(0);
  const pendingSeq = useRef(0);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [pending, setPending] = useState("");

  const reloadStudio = useCallback(async () => {
    const r = await api.studio<DevelopmentState>("state");
    if (r.ok) setStudio(r.data);
  }, []);
  const inspect = useCallback(async () => {
    if (!projectId || demo) return;
    const token = ++inspectSeq.current;
    setLoadedFor("");
    const [i, g] = await Promise.all([
      api.studio<Inspection>("web-inspect", { projectId }),
      api.studio<GitState>("git-state", { projectId }),
    ]);
    // 다른 프로젝트로 바뀌었거나 더 새로운 조회가 시작됐다면 이 응답은 버린다.
    if (token !== inspectSeq.current || projectRef.current !== projectId) return;
    if (i.ok && g.ok) setLoadedFor(projectId);
    if (i.ok) {
      setInspection(i.data);
      setInspectError("");
    } else {
      setInspection(null);
      setInspectError(i.error.message);
    }
    if (g.ok) {
      setGit(g.data);
      setGitError("");
    } else {
      setGit(null);
      setGitError(g.error.message);
    }
  }, [projectId, demo]);
  const inspectRef = useRef(inspect);
  inspectRef.current = inspect;

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const r = await api.studio<DevelopmentState>("state");
      if (live && r.ok) setStudio(r.data);
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    setInspection(null);
    setInspectError("");
    setGit(null);
    setGitError("");
    setInfo("");
    setError("");
    void inspect();
  }, [inspect]);

  const deployments = (studio?.deployments ?? []).filter((d) => d.projectId === projectId);
  // 배포 터미널은 준비 뒤에 생기고(빌드→업로드로) 바뀔 수 있으므로 상태 갱신 때마다 확인한다.
  const activeTerminal = deployments.find((d) => d.status === "running" && d.terminalId)?.terminalId;
  useEffect(() => {
    if (!activeTerminal || autoOpened.current.has(activeTerminal)) return;
    autoOpened.current.add(activeTerminal);
    setTerminal(activeTerminal);
  }, [activeTerminal]);

  // 응답이 도착했을 때 프로젝트가 바뀌었다면 결과를 화면에 반영하지 않는다.
  async function act<T>(action: string, input: Record<string, unknown> = {}): Promise<T | undefined> {
    const requested = projectId;
    const token = ++pendingSeq.current;
    setPending(action);
    setError("");
    setInfo("");
    try {
      const r = await api.studio<T>(action, { projectId: requested, provider, ...input });
      if (projectRef.current !== requested) return;
      if (r.ok) return r.data;
      setError(r.error.message);
    } finally {
      if (pendingSeq.current === token) setPending("");
    }
  }
  function openTerminal(id: string, after?: () => void) {
    autoOpened.current.add(id);
    if (after) watch(id, after);
    setTerminal(id);
  }
  function selectProject(next: string) {
    projectRef.current = next;
    setProjectId(next);
  }

  if (!state.projects.length)
    return (
      <Card>
        <EmptyState
          icon={Globe}
          title="등록된 프로젝트가 없습니다"
          description="웹 프로젝트 폴더를 등록하면 Vercel·Netlify로 배포할 수 있습니다."
          action={
            <button className="btn btn--primary" onClick={() => goTo("projects")}>
              프로젝트 등록하기
            </button>
          }
        />
      </Card>
    );

  const connection = checked[provider] ?? studio?.connections.find((c) => c.tool === provider);
  const linked = binding(inspection, provider);
  const clean = !!git && !!git.head && git.files.length === 0;
  const unresolved = deployments.find(
    (d) => d.status === "running" || (d.status === "action_required" && !d.resolved),
  );
  const ready = loadedFor === projectId && !!inspection && !!git;
  const nextServer = provider === "netlify" && inspection?.framework === "Next.js";
  const publication = provider === "netlify" ? inspection?.publicationError : undefined;
  const buildNote =
    provider === "vercel"
      ? "커밋된 파일만 업로드하고 Vercel 클라우드에서 빌드합니다."
      : nextServer
        ? "Next.js 서버 빌드는 이 화면의 Netlify 업로드로 배포할 수 없습니다. Vercel을 쓰거나 Netlify의 Git 연동 빌드를 사용하세요."
        : publication
          ? `${publication} 공개할 폴더(public 또는 dist)를 준비하거나 Netlify의 Git 연동 빌드를 사용하세요.`
          : inspection?.buildCommand
            ? `인증 정보가 없는 격리 환경에서 npm ci 후 ${inspection.buildCommand}를 실행하고 ${inspection.output} 폴더만 공개합니다. package-lock.json이 필요합니다.`
            : `빌드 없이 ${inspection?.output ?? "."} 폴더만 공개합니다.`;
  const blockers = [
    !connection?.executable && `${PROVIDERS[provider]} CLI 설치가 필요합니다.`,
    !ready &&
      (inspectError || gitError
        ? "배포 준비 상태를 확인하지 못했습니다. 위 안내를 확인한 뒤 다시 확인하세요."
        : "배포 준비 상태를 확인하는 중입니다."),
    ready && !linked && "배포 프로젝트를 먼저 연결하세요.",
    ready && !clean && "커밋하지 않은 변경이 없어야 합니다.",
    nextServer && "Netlify 업로드는 Next.js 서버 빌드를 지원하지 않습니다.",
    publication && "Netlify에 공개할 폴더를 정할 수 없습니다.",
    unresolved &&
      (unresolved.status === "running"
        ? "진행 중인 배포가 끝난 뒤 배포할 수 있습니다."
        : "이전 배포 결과를 확인하거나, 서비스에서 확인한 뒤 배포 이력에서 잠금을 해제하세요."),
  ].filter(Boolean) as string[];
  const sessions = (studio?.terminals ?? [])
    .filter((t: TerminalSession) => t.title.toLowerCase().includes(provider))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6);

  return (
    <div className="stack">
      <Card
        title="배포 대상"
        icon={Rocket}
        actions={
          <select
            className="select"
            aria-label="웹 프로젝트"
            value={projectId}
            onChange={(e) => selectProject(e.target.value)}
            style={{ minWidth: 200 }}
          >
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        }
      >
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="small muted">배포 서비스</span>
          <div className="pill-group" role="group" aria-label="배포 서비스">
            {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
              <button key={p} aria-pressed={provider === p} onClick={() => setProvider(p)}>
                {PROVIDERS[p]}
              </button>
            ))}
          </div>
        </div>
        <CliToolRow
          tool={provider}
          connection={connection}
          onConnection={(c) => setChecked((v) => ({ ...v, [c.tool]: c }))}
          onTerminal={openTerminal}
        />
      </Card>

      {demo && <Notice tone="info">데모에서는 화면만 둘러볼 수 있습니다. 실제 운영 모드에서 서비스를 연결하세요.</Notice>}
      {error && (
        <Notice tone="error" action={<TerminalSetupButton error={error} onTerminal={(id) => openTerminal(id)} />}>
          {error}
        </Notice>
      )}
      {info && <Notice tone="info">{info}</Notice>}

      <Card
        title="배포 준비"
        actions={
          <button className="btn btn--sm" disabled={demo || !!pending} onClick={() => void inspect()}>
            <RefreshCw size={13} aria-hidden />
            다시 확인
          </button>
        }
      >
        {demo ? (
          <p className="muted small">실제 운영 모드에서 프로젝트 설정을 자동으로 감지합니다.</p>
        ) : !ready && !inspectError && !gitError ? (
          <Spinner />
        ) : (
          <div className="checklist">
            <Check
              ok={!!connection?.executable}
              label={`${PROVIDERS[provider]} CLI`}
              desc={
                connection?.status === "connected"
                  ? "로그인을 확인했습니다."
                  : connection?.executable
                    ? "설치됨 · 로그인 상태는 연결 검사로 확인하세요."
                    : "위에서 CLI를 설치하고 브라우저로 로그인하세요."
              }
            />
            <Check
              ok={!!linked}
              label="배포 프로젝트 연결"
              desc={
                linked
                  ? `연결됨 · ${provider === "netlify" ? `사이트 ${linked.siteId}` : `프로젝트 ${linked.projectId}`}. 연결 파일은 Git에서 제외하세요.`
                  : inspectError || "CLI에서 기존 팀·프로젝트를 고르거나 새로 만듭니다."
              }
              action={
                <button
                  className={`btn btn--sm${linked ? "" : " btn--primary"}`}
                  disabled={demo || !!pending || !connection?.executable}
                  onClick={async () => {
                    const r = await act<TerminalSession>("web-link");
                    // 패널을 닫아도 연결 CLI가 끝나면 현재 프로젝트 설정을 다시 확인한다.
                    if (r) openTerminal(r.id, () => void inspectRef.current());
                  }}
                >
                  <Link2 size={13} aria-hidden />
                  {linked ? "다시 연결" : "프로젝트 연결"}
                </button>
              }
            />
            <Check
              ok={clean}
              label="커밋된 소스"
              desc={
                gitError
                  ? "Git 저장소가 아닙니다. 커밋된 파일만 배포하므로 개발 작업 화면에서 Git을 시작하고 커밋하세요."
                  : !git
                    ? "확인 중"
                    : !git.head
                      ? "아직 커밋이 없습니다."
                      : git.files.length
                        ? `커밋하지 않은 변경 ${git.files.length}개가 있습니다. 커밋한 뒤 배포하세요.`
                        : `${git.branch} · ${git.head.slice(0, 8)} 스냅샷을 배포합니다.`
              }
              action={
                !clean && (
                  <button className="btn btn--sm" onClick={() => goTo("development")}>
                    개발 작업에서 커밋
                  </button>
                )
              }
            />
            <Check
              ok={!nextServer && !publication}
              label={`빌드 방식 · ${inspection?.framework ?? "확인 중"}`}
              desc={buildNote}
            />
          </div>
        )}
      </Card>

      <Card title="배포 실행">
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="small muted">배포 환경</span>
          <div className="pill-group" role="group" aria-label="배포 환경">
            <button aria-pressed={!production} onClick={() => setProduction(false)}>
              Preview
            </button>
            <button aria-pressed={production} onClick={() => setProduction(true)}>
              Production
            </button>
          </div>
        </div>
        <div className="approval">
          <span className="approval__desc">
            {git?.head ? (
              <>
                커밋 <span className="mono">{git.head.slice(0, 8)}</span>의 소스 스냅샷을 {PROVIDERS[provider]}{" "}
                {production ? <strong>Production(공개 사이트)</strong> : "Preview"}로 배포합니다.
              </>
            ) : (
              `커밋된 소스 스냅샷을 ${PROVIDERS[provider]} ${production ? "Production(공개 사이트)" : "Preview"}로 배포합니다.`
            )}
            {blockers.length > 0 && !demo && (
              <span style={{ display: "block", color: "var(--warn)", marginTop: 4 }}>{blockers.join(" ")}</span>
            )}
          </span>
          <button
            className={`btn ${production ? "btn--danger" : "btn--primary"}`}
            disabled={demo || !!pending || blockers.length > 0 || !git?.head}
            onClick={async () => {
              const requested = projectId;
              // 화면에서 확인한 커밋만 배포한다. 그사이 HEAD가 바뀌면 서비스가 거부한다.
              const r = await act<WebDeployment>("deploy", { production, approved: true, expectedHead: git?.head });
              if (!r) {
                if (projectRef.current === requested) void inspect();
                return;
              }
              await reloadStudio();
              if (r.terminalId) openTerminal(r.terminalId);
              setInfo("배포를 시작했습니다. 진행 로그가 아래 터미널에 표시됩니다.");
            }}
          >
            {pending === "deploy" && <Spinner />}
            {production ? "승인하고 Production 배포" : "승인하고 Preview 배포"}
          </button>
        </div>
      </Card>

      <Card title="배포 이력" icon={History}>
        {deployments.length === 0 ? (
          <p className="muted small">이 프로젝트의 배포 이력이 없습니다.</p>
        ) : (
          <div className="item-list">
            {deployments.map((d) => {
              const [label, tone] = deployStatus[d.status];
              return (
                <div key={d.id} className="item-row">
                  <div className="item-row__main">
                    <div className="item-row__title">
                      {PROVIDERS[d.provider]} · {d.production ? "Production" : "Preview"}
                    </div>
                    <div className="item-row__meta">
                      <Badge tone={tone}>{d.resolved && d.status === "action_required" ? "사용자 확인 완료" : label}</Badge>
                      <span>{formatRelative(d.createdAt)}</span>
                      {d.sourceSha && <span className="mono">{d.sourceSha.slice(0, 8)}</span>}
                      {d.url && <span className="mono">{d.url}</span>}
                    </div>
                    <p className="small muted" style={{ margin: "4px 0 0" }}>
                      {d.message}
                    </p>
                    {d.status === "action_required" && !d.resolved && (
                      <div className="approval" style={{ marginTop: 6 }}>
                        <span className="approval__desc">
                          결과 확인으로 판단할 수 없으면 {PROVIDERS[d.provider]} 대시보드에서 이 배포를 직접 확인하세요.
                          확인했다면 새 배포를 막는 잠금을 해제할 수 있습니다. 중복 배포는 자동으로 재시도하지 않습니다.
                        </span>
                        <button
                          className="btn btn--sm"
                          disabled={demo || !!pending}
                          onClick={async () => {
                            const r = await act<WebDeployment>("web-resolve", { id: d.id, approved: true });
                            await reloadStudio();
                            if (r) setInfo("배포 잠금을 해제했습니다. 필요하면 다시 배포할 수 있습니다.");
                          }}
                        >
                          서비스에서 확인함 · 잠금 해제 승인
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="item-row__actions">
                    {d.terminalId && (
                      <button className="btn btn--sm" onClick={() => openTerminal(d.terminalId)}>
                        <TerminalSquare size={12} aria-hidden />
                        로그
                      </button>
                    )}
                    <button
                      className={`btn btn--sm${d.status === "action_required" ? " btn--primary" : ""}`}
                      disabled={demo || !!pending || d.status === "running" || !d.dispatched}
                      title={!d.dispatched ? "서비스로 전송되지 않은 배포입니다." : "서비스의 배포 상태와 사이트 응답을 조회합니다."}
                      onClick={async () => {
                        const r = await act<WebDeployment>("web-check", { id: d.id });
                        await reloadStudio();
                        if (r) setInfo(r.message);
                      }}
                    >
                      {pending === "web-check" && <Spinner />}결과 확인
                    </button>
                    {d.url && (
                      <button className="btn btn--sm" onClick={() => void api.openExternal(d.url!)}>
                        <ExternalLink size={12} aria-hidden />
                        사이트 열기
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {sessions.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="section-title">{PROVIDERS[provider]} CLI 세션</div>
            <div className="session-chips" style={{ marginTop: 6 }}>
              {sessions.map((t) => (
                <button key={t.id} className="btn btn--xs" onClick={() => openTerminal(t.id)}>
                  <TerminalSquare size={12} aria-hidden />
                  {t.title} · {t.status === "running" ? "실행 중" : formatRelative(t.createdAt)}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {terminal && (
        <StudioTerminal
          id={terminal}
          onClose={() => setTerminal("")}
          onExit={() => {
            settle(terminal);
            void reloadStudio();
          }}
        />
      )}
    </div>
  );
}

function Check({
  ok,
  label,
  desc,
  action,
}: {
  ok: boolean;
  label: string;
  desc: string;
  action?: ReactNode;
}) {
  return (
    <div className="checklist__item">
      <ConfirmIcon tone={ok ? "ok" : "error"} />
      <div className="checklist__body">
        <div className="checklist__label">{label}</div>
        <p className="checklist__desc">{desc}</p>
      </div>
      {action}
    </div>
  );
}
