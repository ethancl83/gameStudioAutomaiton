import { useCallback, useEffect, useRef, useState } from "react";
import { FolderGit2, FolderKanban, GitBranch, TerminalSquare } from "lucide-react";
import type { AppState } from "../../../../packages/domain";
import type { CliConnection, DevelopmentState } from "../../../../packages/development/types";
import { api } from "../api";
import type { ViewKey } from "../App";
import { Card, EmptyState, Notice, Spinner } from "../components/ui";
import { StudioTerminal, TerminalSetupButton, useTerminalWatch } from "../components/StudioTerminal";
import { CliToolRow } from "../components/CliToolRow";
import { GitTab, useGitWorkspace } from "./development/Git";
import { ItemsTab, useGithubItems, type ItemKind } from "./development/Items";
import { PolicyCard, useDevelopmentPolicy } from "./development/Policy";
import { TasksTab, useTaskWorkspace } from "./development/Tasks";
import { RUNNING } from "./development/taskStatus";
import { useDevelopmentRequests } from "./development/useDevelopmentRequests";
import "../components/studio.css";

type Tab = "git" | "issue" | "pr" | "tasks";

// 개발 화면 조립: 프로젝트 선택·탭 전환·개발 상태 폴링·터미널 패널을 소유하고, Git·이슈/PR·작업·자동화
// 설정은 각 책임 단위(views/development)에 맡긴다. 탭을 넘나드는 흐름(가져오기→작업 탭)만 여기서 잇는다.
export function DevelopmentView({
  state,
  refresh,
  goTo,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  goTo: (view: ViewKey) => void;
}) {
  const demo = api.isDemo();
  const requests = useDevelopmentRequests(state.projects[0]?.id ?? "");
  const { projectId, pending, error, info } = requests;
  const [tab, setTab] = useState<Tab>("issue");
  const [studio, setStudio] = useState<DevelopmentState | null>(null);
  const [checked, setChecked] = useState<Partial<Record<string, CliConnection>>>({});
  const [terminal, setTerminal] = useState("");
  const autoOpened = useRef(new Set<string>());
  const { watch, settle } = useTerminalWatch();

  const reloadStudio = useCallback(async () => {
    const r = await api.studio("state");
    if (r.ok) setStudio(r.data);
  }, []);
  const repo = useGitWorkspace(requests, demo);
  const items = useGithubItems(requests);
  const policy = useDevelopmentPolicy(requests);
  const tasks = (studio?.tasks ?? []).filter((t) => t.projectId === projectId);
  const work = useTaskWorkspace(requests, tasks, reloadStudio);
  const task = work.task;
  const project = state.projects.find((p) => p.id === projectId);
  const githubConnection = checked.github ?? studio?.connections.find((c) => c.tool === "github");
  const { git, gitError } = repo;

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const r = await api.studio("state");
      if (live && r.ok) setStudio(r.data);
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  // 진행 중인 작업의 터미널은 나중에 생길 수 있으므로 상태 갱신 때마다 확인해 한 번만 자동으로 연다.
  useEffect(() => {
    const id = task?.terminalId;
    if (!id || !RUNNING.includes(task.status) || autoOpened.current.has(id)) return;
    autoOpened.current.add(id);
    setTerminal(id);
  }, [task?.terminalId, task?.status]);

  function switchTab(next: Tab) {
    // 진행 중인 목록 요청의 응답이 다른 탭(이슈↔PR)에 표시되지 않게 한다.
    items.invalidate();
    setTab(next);
    items.setFilter("");
    repo.closeDiff();
    requests.clearNotices();
    if (next === "git") void repo.load();
  }
  function openTerminal(id: string, after?: () => void) {
    autoOpened.current.add(id);
    if (after) watch(id, after);
    setTerminal(id);
  }
  async function importItem(number: number, kind: ItemKind) {
    const t = await requests.act("import", { number, kind });
    if (!t) return;
    await reloadStudio();
    if (!policy.dirty) void policy.load();
    work.select(t.id);
    switchTab("tasks");
    if (t.terminalId) openTerminal(t.terminalId);
  }

  const runningTerminals = (studio?.terminals ?? []).filter(
    (t) => t.status === "running" && t.id !== terminal,
  );

  if (!state.projects.length)
    return (
      <Card>
        <EmptyState
          icon={FolderKanban}
          title="등록된 프로젝트가 없습니다"
          description="프로젝트 폴더를 먼저 등록하면 Git 관리와 GitHub 이슈·PR 작업을 시작할 수 있습니다."
          action={
            <button className="btn btn--primary" onClick={() => goTo("projects")}>
              프로젝트 등록하기
            </button>
          }
        />
      </Card>
    );

  return (
    <div className="stack">
      <Card
        title="개발 프로젝트"
        icon={FolderGit2}
        actions={
          <select
            className="select"
            aria-label="개발 프로젝트"
            value={projectId}
            onChange={(e) => requests.selectProject(e.target.value)}
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
        <dl className="dl" style={{ gridTemplateColumns: "90px 1fr" }}>
          <dt>폴더</dt>
          <dd className="mono small">{project?.rootPath ?? "—"}</dd>
          <dt>Git</dt>
          <dd>
            {demo ? (
              <span className="muted">데모에서는 조회하지 않습니다.</span>
            ) : git ? (
              <span className="row" style={{ gap: 6 }}>
                <GitBranch size={13} aria-hidden />
                <strong>{git.branch}</strong>
                <span className="muted">
                  {git.repository ?? git.remote ?? "원격 저장소 없음"}
                  {git.files.length > 0 && ` · 변경 ${git.files.length}개`}
                </span>
              </span>
            ) : gitError ? (
              <span className="muted">Git 저장소가 아니거나 상태를 읽지 못했습니다.</span>
            ) : (
              <Spinner />
            )}
          </dd>
        </dl>
        <CliToolRow
          tool="github"
          connection={githubConnection}
          onConnection={(c) => setChecked((v) => ({ ...v, [c.tool]: c }))}
          onTerminal={openTerminal}
          description="이슈·PR 조회, 저장소 목록, Clone, 푸시와 PR 등록에 사용합니다."
        />
        {runningTerminals.length > 0 && (
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <span className="small muted">실행 중인 세션</span>
            <div className="session-chips">
              {runningTerminals.map((t) => (
                <button key={t.id} className="btn btn--xs" onClick={() => openTerminal(t.id)}>
                  <TerminalSquare size={12} aria-hidden />
                  {t.title}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="tabs studio-tabs" role="tablist" aria-label="개발 탭">
          {(
            [
              ["issue", "이슈"],
              ["pr", "PR"],
              ["tasks", `가져온 작업${tasks.length ? ` ${tasks.length}` : ""}`],
              ["git", "Git"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className="tab"
              role="tab"
              aria-selected={tab === key}
              onClick={() => switchTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {demo && (
        <Notice tone="info">
          데모에서는 화면만 둘러볼 수 있습니다. 저장소·로그인·터미널·AI 작업은 실제 운영 모드에서
          시작하세요.
        </Notice>
      )}
      {error && (
        <Notice tone="error" action={<TerminalSetupButton error={error} onTerminal={(id) => openTerminal(id)} />}>
          {error}
        </Notice>
      )}
      {info && <Notice tone="info">{info}</Notice>}

      {tab === "git" && (
        <GitTab workspace={repo} requests={requests} demo={demo} projectName={project?.name} refresh={refresh} />
      )}

      {(tab === "issue" || tab === "pr") && (
        <ItemsTab
          kind={tab}
          items={items}
          requests={requests}
          tasks={tasks}
          git={git}
          demo={demo}
          onGitTab={() => switchTab("git")}
          onOpenTask={(id) => {
            work.show(id);
            switchTab("tasks");
          }}
          onImport={importItem}
        />
      )}

      {tab === "tasks" && (
        <TasksTab
          loaded={!!studio}
          tasks={tasks}
          workspace={work}
          policy={policy.saved}
          pending={pending}
          onTerminal={openTerminal}
        />
      )}

      {tab !== "git" && (
        <PolicyCard
          policy={policy.policy}
          dirty={policy.dirty}
          pending={pending}
          onChange={policy.change}
          onReset={policy.reset}
          onSave={() => void policy.save()}
        />
      )}

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
