import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderGit2,
  FolderKanban,
  GitBranch,
  GitPullRequest,
  Link2,
  ListTodo,
  Play,
  RefreshCw,
  Square,
  TerminalSquare,
} from "lucide-react";
import type { AppState } from "../../../../packages/domain";
import type {
  CliConnection,
  DevelopmentPolicy,
  DevelopmentState,
  DevelopmentTask,
  GitFile,
  GitState,
  GithubItem,
} from "../../../../packages/development/types";
import { api } from "../api";
import { formatDateTime, formatRelative } from "../format";
import type { ViewKey } from "../App";
import { Badge, Card, EmptyState, Notice, Spinner } from "../components/ui";
import { StudioTerminal, TerminalSetupButton, useTerminalWatch } from "../components/StudioTerminal";
import { CliToolRow } from "../components/CliToolRow";
import "../components/studio.css";

type Tab = "git" | "issue" | "pr" | "tasks";
type Tone = "ok" | "warn" | "error" | "info" | "neutral" | "progress";
type Status = DevelopmentTask["status"];

const statusInfo: Record<Status, [string, Tone]> = {
  imported: ["가져옴", "neutral"],
  analyzing: ["분석 중", "progress"],
  planned: ["계획 준비됨", "info"],
  implementing: ["구현 중", "progress"],
  reviewing: ["리뷰 중", "progress"],
  verifying: ["검증 중", "progress"],
  ready: ["반영 승인 대기", "warn"],
  committed: ["커밋됨", "ok"],
  pushed: ["푸시됨", "ok"],
  failed: ["실패", "error"],
  cancelled: ["중지됨", "neutral"],
  action_required: ["확인 필요", "warn"],
};
const RUNNING: Status[] = ["analyzing", "implementing", "reviewing", "verifying"];
const FINAL: Status[] = ["committed", "pushed"];
const STEPS = ["가져옴", "분석", "계획", "구현·리뷰", "검증", "커밋", "푸시", "PR"];
const DOCS = [
  ["source", "원본"],
  ["plan.md", "계획"],
  ["context.md", "맥락"],
  ["tasks.md", "작업 목록"],
  ["review.json", "리뷰"],
  ["diff", "변경사항"],
] as const;
type DocName = (typeof DOCS)[number][0];

interface ItemList {
  projectId: string;
  kind: "issue" | "pr";
  state: string;
  page: number;
  hasMore: boolean;
  items: GithubItem[];
}
interface TaskDocument {
  taskId: string;
  name: DocName;
  text: string;
}

function nextStep(task: DevelopmentTask, testCommand: string): string {
  switch (task.status) {
    case "imported":
    case "analyzing":
      return "AI가 원본 자료를 분석해 계획·맥락·작업 문서를 만들고 있습니다.";
    case "planned":
      return "계획 문서를 확인한 뒤 구현을 시작하세요.";
    case "implementing":
    case "reviewing":
      return "AI가 구현하고 독립 리뷰를 진행합니다. 끝나면 자동으로 검증합니다.";
    case "verifying":
      return `격리된 환경에서 검증 명령(${testCommand || "미설정"})을 실행하고 있습니다.`;
    case "ready":
      return "검증을 통과했습니다. 변경사항을 확인하고 커밋을 승인하세요.";
    case "committed":
      return "커밋했습니다. 원격 저장소 반영을 승인하세요.";
    case "pushed":
      return task.prUrl ? "PR이 등록되었습니다." : "푸시했습니다. PR 등록을 승인하세요.";
    case "failed":
      return "터미널과 문서를 확인한 뒤 필요한 단계를 다시 실행하세요.";
    case "cancelled":
      return "작업을 중지했습니다. 작업 파일은 보존되어 있어 다시 실행할 수 있습니다.";
    case "action_required":
      return "이전 실행이 중단되었거나 원격 결과 확인이 필요합니다. 상태를 확인한 뒤 다시 실행하세요.";
  }
}

function stepProgress(task: DevelopmentTask): { done: number; current: number } {
  const at: Partial<Record<Status, number>> = {
    imported: 1,
    analyzing: 1,
    planned: 3,
    implementing: 3,
    reviewing: 3,
    verifying: 4,
    ready: 5,
    committed: 6,
    pushed: task.prUrl ? 8 : 7,
  };
  const reached =
    at[task.status] ?? (task.commitSha ? 6 : task.verifiedFingerprint ? 5 : 1);
  return { done: reached, current: reached };
}

function fileLabel(f: GitFile) {
  if (f.index === "?" && f.working === "?") return "새 파일";
  const codes: Record<string, string> = { M: "수정", A: "추가", D: "삭제", R: "이름 변경", C: "복사", U: "충돌" };
  const staged = f.index.trim() && f.index !== "?" ? `스테이징: ${codes[f.index] ?? f.index}` : "";
  const working = f.working.trim() && f.working !== "?" ? `작업 트리: ${codes[f.working] ?? f.working}` : "";
  return [staged, working].filter(Boolean).join(" · ");
}
const isStaged = (f: GitFile) => !!f.index.trim() && f.index !== "?";
const isUnstaged = (f: GitFile) => !!f.working.trim();

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
  const [projectId, setProjectId] = useState(state.projects[0]?.id ?? "");
  const [tab, setTab] = useState<Tab>("issue");
  const [studio, setStudio] = useState<DevelopmentState | null>(null);
  const [checked, setChecked] = useState<Partial<Record<string, CliConnection>>>({});
  const [git, setGit] = useState<GitState | null>(null);
  const [gitError, setGitError] = useState("");
  const [gitDoc, setGitDoc] = useState<{ title: string; text: string } | null>(null);
  const [list, setList] = useState<ItemList | null>(null);
  const listSeq = useRef(0);
  const [filter, setFilter] = useState("");
  const [itemState, setItemState] = useState("open");
  const [selected, setSelected] = useState("");
  const [terminal, setTerminal] = useState("");
  const autoOpened = useRef(new Set<string>());
  const { watch, settle } = useTerminalWatch();
  // 비동기 응답은 요청을 보낸 프로젝트가 아직 선택되어 있을 때만 화면 상태에 반영한다.
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const pendingSeq = useRef(0);
  const [doc, setDoc] = useState<TaskDocument | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [pending, setPending] = useState("");
  const [policy, setPolicy] = useState<DevelopmentPolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<DevelopmentPolicy | null>(null);
  const [policyFor, setPolicyFor] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [repos, setRepos] = useState<Array<{ full_name: string; private: boolean }> | null>(null);
  const [selectedRepo, setSelectedRepo] = useState("");

  const project = state.projects.find((p) => p.id === projectId);
  const tasks = (studio?.tasks ?? []).filter((t) => t.projectId === projectId);
  const task = tasks.find((t) => t.id === selected);
  const policyDirty = !!policy && !!savedPolicy && JSON.stringify(policy) !== JSON.stringify(savedPolicy);
  const githubConnection =
    checked.github ?? studio?.connections.find((c) => c.tool === "github");

  // scoped 동작의 응답은 프로젝트가 바뀐 뒤 도착하면 버린다. 저장소 목록·Clone처럼 프로젝트와 무관한
  // 동작은 scoped=false로 호출해 완료 결과를 잃지 않는다.
  async function act<T = unknown>(
    action: string,
    input: Record<string, unknown> = {},
    scoped = true,
  ): Promise<T | undefined> {
    const requested = projectId;
    const token = ++pendingSeq.current;
    setPending(action);
    setError("");
    setInfo("");
    try {
      const r = await api.studio<T>(action, { projectId: requested, ...input });
      if (scoped && projectRef.current !== requested) return;
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      return r.data;
    } finally {
      if (pendingSeq.current === token) setPending("");
    }
  }
  const reloadStudio = useCallback(async () => {
    const r = await api.studio<DevelopmentState>("state");
    if (r.ok) setStudio(r.data);
  }, []);
  const loadGit = useCallback(async () => {
    if (!projectId || demo) return;
    const r = await api.studio<GitState>("git-state", { projectId });
    if (projectRef.current !== projectId) return;
    if (r.ok) {
      setGit(r.data);
      setGitError("");
    } else {
      setGit(null);
      setGitError(r.error.message);
    }
  }, [projectId, demo]);
  const loadPolicy = useCallback(async () => {
    if (!projectId) return;
    const r = await api.studio<DevelopmentPolicy>("policy", { projectId });
    if (projectRef.current !== projectId || !r.ok) return;
    setPolicy(r.data);
    setSavedPolicy(r.data);
    setPolicyFor(projectId);
  }, [projectId]);

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
  // 프로젝트가 바뀌면 이전 프로젝트의 목록·문서·정책이 새 프로젝트에 쓰이지 않도록 모두 비운다.
  useEffect(() => {
    listSeq.current++;
    setList(null);
    setGit(null);
    setGitError("");
    setGitDoc(null);
    setSelected("");
    setDoc(null);
    setPolicy(null);
    setSavedPolicy(null);
    setPolicyFor("");
    setRepos(null);
    setSelectedRepo("");
    void loadGit();
    void loadPolicy();
  }, [loadGit, loadPolicy]);
  // 진행 중인 작업의 터미널은 나중에 생길 수 있으므로 상태 갱신 때마다 확인해 한 번만 자동으로 연다.
  useEffect(() => {
    const id = task?.terminalId;
    if (!id || !RUNNING.includes(task.status) || autoOpened.current.has(id)) return;
    autoOpened.current.add(id);
    setTerminal(id);
  }, [task?.terminalId, task?.status]);
  function selectProject(next: string) {
    projectRef.current = next;
    setProjectId(next);
    // 이전 프로젝트의 안내·오류는 새 프로젝트에 남기지 않는다(호출한 쪽이 새 안내를 이어서 설정할 수 있다).
    setError("");
    setInfo("");
  }

  function switchTab(next: Tab) {
    // 진행 중인 목록 요청의 응답이 다른 탭(이슈↔PR)에 표시되지 않게 한다.
    listSeq.current++;
    setTab(next);
    setFilter("");
    setGitDoc(null);
    setError("");
    setInfo("");
    if (next === "git") void loadGit();
  }
  async function loadItems(kind: "issue" | "pr", page = 1) {
    const token = ++listSeq.current;
    const result = await act<{ items: GithubItem[]; hasMore: boolean }>("items", {
      kind,
      state: itemState,
      page,
    });
    if (!result || token !== listSeq.current) return;
    setList({ projectId, kind, state: itemState, page, hasMore: result.hasMore, items: result.items });
  }
  function openTerminal(id: string, after?: () => void) {
    autoOpened.current.add(id);
    if (after) watch(id, after);
    setTerminal(id);
  }
  async function taskAction(action: string, input: Record<string, unknown> = {}) {
    if (!task) return;
    const r = await act<DevelopmentTask>(action, { id: task.id, ...input });
    await reloadStudio();
    if (r && action === "cleanup") {
      setSelected("");
      setDoc(null);
      setInfo(`작업을 정리했습니다. 브랜치 ${task.branch}는 저장소에 남아 있습니다.`);
    }
    return r;
  }
  async function loadDocument(name: DocName) {
    if (!task) return;
    const taskId = task.id;
    const r =
      name === "diff"
        ? await act<{ diff: string }>("git-diff", { id: taskId }).then((v) => v && { text: v.diff })
        : await act<{ text: string }>("document", { id: taskId, name });
    if (r) setDoc({ taskId, name, text: r.text });
  }

  const listVisible = list && list.projectId === projectId && list.kind === tab ? list : null;
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
        <>
          <Card
            title="Git 상태와 변경사항"
            icon={GitBranch}
            actions={
              <button
                className="btn btn--sm"
                disabled={demo || !!pending}
                onClick={() => void loadGit()}
              >
                <RefreshCw size={13} aria-hidden />
                새로고침
              </button>
            }
          >
            {demo ? (
              <p className="muted">실제 운영 모드에서 Git 상태를 조회합니다.</p>
            ) : gitError ? (
              <Notice
                tone="warn"
                title="Git 저장소를 읽지 못했습니다"
                action={
                  <button
                    className="btn btn--sm btn--primary"
                    disabled={!!pending}
                    onClick={async () => {
                      const r = await act<GitState>("git-init");
                      if (r) {
                        setGit(r);
                        setGitError("");
                        setInfo("Git 저장소를 만들었습니다. 첫 커밋 후 브랜치를 만들 수 있습니다.");
                      }
                    }}
                  >
                    이 폴더에서 Git 시작
                  </button>
                }
              >
                <span className="small">{gitError}</span>
              </Notice>
            ) : !git ? (
              <Spinner />
            ) : (
              <GitPanel
                git={git}
                pending={pending}
                commitMessage={commitMessage}
                setCommitMessage={setCommitMessage}
                newBranch={newBranch}
                setNewBranch={setNewBranch}
                act={act}
                onGit={setGit}
                showDiff={(title, text) => setGitDoc({ title, text })}
              />
            )}
            {gitDoc && (
              <div style={{ marginTop: 14 }}>
                <div className="row row--between">
                  <strong className="small">{gitDoc.title}</strong>
                  <button className="btn btn--xs btn--ghost" onClick={() => setGitDoc(null)}>
                    닫기
                  </button>
                </div>
                <DiffView text={gitDoc.text || "변경 없음"} />
              </div>
            )}
          </Card>
          <Card title="GitHub 저장소" icon={Link2}>
            {git?.repository && (
              <div className="row" style={{ marginBottom: 10 }}>
                <span>
                  origin: <strong>{git.repository}</strong>
                </span>
                <button
                  className="btn btn--xs"
                  onClick={() => void api.openExternal(`https://github.com/${git.repository}`)}
                >
                  <ExternalLink size={12} aria-hidden />
                  GitHub에서 보기
                </button>
              </div>
            )}
            <p className="small muted" style={{ marginTop: 0 }}>
              로그인한 GitHub 계정의 저장소를 이 프로젝트의 origin으로 연결하거나, 새 폴더에 Clone해
              프로젝트로 등록합니다.
            </p>
            <div className="row">
              <button
                className="btn"
                disabled={demo || !!pending}
                onClick={async () => {
                  const r = await act<Array<{ full_name: string; private: boolean }>>("repositories", {}, false);
                  if (r) {
                    setRepos(r);
                    if (!r.length) setInfo("접근 가능한 저장소가 없습니다.");
                  }
                }}
              >
                {pending === "repositories" ? <Spinner /> : <RefreshCw size={13} aria-hidden />}
                내 저장소 불러오기
              </button>
              {repos && repos.length > 0 && (
                <select
                  className="select"
                  aria-label="GitHub 저장소"
                  value={selectedRepo}
                  onChange={(e) => setSelectedRepo(e.target.value)}
                  style={{ minWidth: 260 }}
                >
                  <option value="">저장소 선택 ({repos.length}개)</option>
                  {repos.map((r) => (
                    <option key={r.full_name} value={r.full_name}>
                      {r.full_name}
                      {r.private ? " (비공개)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {selectedRepo && (
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn btn--primary"
                  disabled={!!pending || !!gitError || !git}
                  title={gitError ? "먼저 Git 저장소를 만드세요." : undefined}
                  onClick={async () => {
                    const r = await act<GitState>("git-remote", { repository: selectedRepo });
                    if (r) {
                      setGit(r);
                      setInfo(`${selectedRepo}를 origin으로 연결했습니다.`);
                    }
                  }}
                >
                  {project?.name}의 origin으로 연결
                </button>
                <button
                  className="btn"
                  disabled={!!pending}
                  onClick={async () => {
                    const directory = await api.selectFolder();
                    if (!directory) return;
                    const repository = selectedRepo;
                    const r = await act<{ directory: string }>("git-clone", { repository, directory }, false);
                    if (!r) return;
                    const added = await api.addProject(r.directory);
                    if (!added.ok) return setError(`Clone은 완료했지만 프로젝트 등록에 실패했습니다: ${added.error.message}`);
                    await refresh();
                    selectProject(added.data.id);
                    setInfo(`${repository}를 ${r.directory}에 Clone하고 프로젝트로 등록했습니다.`);
                  }}
                >
                  폴더를 골라 Clone·프로젝트 등록
                </button>
              </div>
            )}
          </Card>
        </>
      )}

      {(tab === "issue" || tab === "pr") && (
        <Card
          title={tab === "pr" ? "프로젝트 PR" : "프로젝트 이슈"}
          icon={tab === "pr" ? GitPullRequest : ListTodo}
        >
          {!demo && git && !git.repository && (
            <Notice
              tone="warn"
              title="GitHub 저장소 연결이 필요합니다"
              action={
                <button className="btn btn--sm" onClick={() => switchTab("git")}>
                  Git 탭에서 연결
                </button>
              }
            >
              이 프로젝트의 origin이 GitHub 저장소가 아닙니다.
            </Notice>
          )}
          <div className="row" style={{ marginTop: 4 }}>
            <select
              className="select"
              aria-label="상태"
              value={itemState}
              onChange={(e) => {
                listSeq.current++;
                setItemState(e.target.value);
                setList(null);
              }}
              style={{ width: 110 }}
            >
              <option value="open">열림</option>
              <option value="closed">닫힘</option>
              <option value="all">전체</option>
            </select>
            <input
              className="input"
              aria-label="제목 검색"
              placeholder="불러온 목록에서 제목 검색"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ flex: 1, minWidth: 180 }}
            />
            <button
              className="btn btn--primary"
              disabled={!!pending || demo || !git?.repository}
              onClick={() => void loadItems(tab)}
            >
              {pending === "items" ? <Spinner /> : <RefreshCw size={13} aria-hidden />}
              {tab === "pr" ? "PR 불러오기" : "이슈 불러오기"}
            </button>
          </div>
          <p className="small muted">
            가져오면 전용 작업 브랜치와 worktree를 만들고 원본을 문서로 저장한 뒤, 분석용 AI가 계획·맥락·작업
            문서를 작성합니다. 원본 저장소 파일은 바꾸지 않습니다.
          </p>
          {!listVisible ? (
            <p className="muted small">
              {pending === "items" ? "불러오는 중…" : "목록을 불러오면 여기에 표시됩니다."}
            </p>
          ) : listVisible.items.length === 0 ? (
            <EmptyState
              icon={tab === "pr" ? GitPullRequest : ListTodo}
              title={tab === "pr" ? "PR이 없습니다" : "이슈가 없습니다"}
            />
          ) : (
            <div className="item-list">
              {listVisible.items
                .filter((i) => i.title.toLowerCase().includes(filter.toLowerCase()))
                .map((item) => {
                  const existing = tasks.find(
                    (t) => t.kind === listVisible.kind && t.number === item.number,
                  );
                  return (
                    <div key={item.number} className="item-row">
                      <div className="item-row__main">
                        <div className="item-row__title">
                          #{item.number} {item.title}
                        </div>
                        <div className="item-row__meta">
                          <Badge tone={item.state === "open" ? "ok" : "neutral"}>
                            {item.state === "open" ? "열림" : "닫힘"}
                          </Badge>
                          {item.user?.login && <span>{item.user.login}</span>}
                          <span>갱신 {formatRelative(item.updated_at)}</span>
                        </div>
                        {item.body && (
                          <details>
                            <summary>본문 보기</summary>
                            <pre>{item.body}</pre>
                          </details>
                        )}
                      </div>
                      <div className="item-row__actions">
                        <button className="btn btn--sm btn--ghost" onClick={() => void api.openExternal(item.url)}>
                          <ExternalLink size={12} aria-hidden />
                          GitHub
                        </button>
                        {existing ? (
                          <button
                            className="btn btn--sm"
                            onClick={() => {
                              setSelected(existing.id);
                              switchTab("tasks");
                            }}
                          >
                            작업 보기 · {statusInfo[existing.status][0]}
                          </button>
                        ) : (
                          <button
                            className="btn btn--sm btn--primary"
                            disabled={!!pending || demo}
                            onClick={async () => {
                              const kind = listVisible.kind;
                              const t = await act<DevelopmentTask>("import", { number: item.number, kind });
                              if (!t) return;
                              await reloadStudio();
                              if (!policyDirty) void loadPolicy();
                              setSelected(t.id);
                              setDoc(null);
                              switchTab("tasks");
                              if (t.terminalId) openTerminal(t.terminalId);
                            }}
                          >
                            {pending === "import" ? <Spinner /> : <Play size={12} aria-hidden />}
                            가져와서 분석
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
          {listVisible && (listVisible.page > 1 || listVisible.hasMore) && (
            <div className="row" style={{ marginTop: 12, justifyContent: "center" }}>
              <button
                className="btn btn--sm"
                disabled={listVisible.page <= 1 || !!pending}
                onClick={() => void loadItems(listVisible.kind, listVisible.page - 1)}
              >
                이전
              </button>
              <span className="small muted">{listVisible.page}쪽</span>
              <button
                className="btn btn--sm"
                disabled={!listVisible.hasMore || !!pending}
                onClick={() => void loadItems(listVisible.kind, listVisible.page + 1)}
              >
                다음
              </button>
            </div>
          )}
        </Card>
      )}

      {tab === "tasks" && (
        <div className="task-layout">
          <Card title="가져온 작업" icon={ListTodo}>
            {!studio ? (
              <Spinner />
            ) : tasks.length === 0 ? (
              <EmptyState
                icon={ListTodo}
                title="가져온 작업이 없습니다"
                description="이슈 또는 PR 탭에서 작업을 가져오세요."
              />
            ) : (
              <div className="stack" style={{ gap: 4 }}>
                {tasks.map((t) => (
                  <button
                    key={t.id}
                    className="task-pick"
                    aria-current={selected === t.id}
                    onClick={() => {
                      setSelected(t.id);
                      setDoc(null);
                    }}
                  >
                    <div className="task-pick__title">
                      {t.kind === "pr" ? "PR" : "이슈"} #{t.number} {t.title}
                    </div>
                    <div className="item-row__meta">
                      <Badge tone={statusInfo[t.status][1]}>{statusInfo[t.status][0]}</Badge>
                      <span>{formatRelative(t.updatedAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
          {task ? (
            <TaskDetail
              task={task}
              policy={savedPolicy}
              pending={pending}
              doc={doc && doc.taskId === task.id ? doc : null}
              onDocument={loadDocument}
              onCloseDocument={() => setDoc(null)}
              onAction={taskAction}
              onTerminal={openTerminal}
            />
          ) : (
            <Card>
              <EmptyState
                icon={FileText}
                title="작업을 선택하세요"
                description="작업을 선택하면 진행 단계, 문서, 변경사항과 반영 승인을 확인할 수 있습니다."
              />
            </Card>
          )}
        </div>
      )}

      {tab !== "git" && (
        <PolicyCard
          policy={policyFor === projectId ? policy : null}
          dirty={policyDirty}
          pending={pending}
          onChange={setPolicy}
          onReset={() => setPolicy(savedPolicy)}
          onSave={async () => {
            // 불러온 프로젝트와 현재 프로젝트가 같을 때만 저장한다(다른 프로젝트 정책 덮어쓰기 방지).
            if (!policy || policyFor !== projectId) return;
            const r = await act<DevelopmentPolicy>("policy-save", { policy });
            if (r) {
              setPolicy(r);
              setSavedPolicy(r);
              setInfo("자동화 설정을 저장했습니다.");
            }
          }}
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

function GitPanel({
  git,
  pending,
  commitMessage,
  setCommitMessage,
  newBranch,
  setNewBranch,
  act,
  onGit,
  showDiff,
}: {
  git: GitState;
  pending: string;
  commitMessage: string;
  setCommitMessage: (v: string) => void;
  newBranch: string;
  setNewBranch: (v: string) => void;
  act: <T>(action: string, input?: Record<string, unknown>) => Promise<T | undefined>;
  onGit: (git: GitState) => void;
  showDiff: (title: string, text: string) => void;
}) {
  const busy = !!pending;
  const staged = git.files.filter(isStaged);
  const dirty = git.files.length > 0;
  const run = async (action: string, input: Record<string, unknown> = {}) => {
    const r = await act<GitState>(action, input);
    if (r && "branch" in r) onGit(r);
    return r;
  };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row">
        <span className="small muted">브랜치</span>
        {git.branches.length > 0 ? (
          <select
            className="select"
            aria-label="브랜치 전환"
            value={git.branch}
            disabled={busy || dirty}
            title={dirty ? "변경사항을 커밋한 뒤 브랜치를 바꿀 수 있습니다." : undefined}
            onChange={(e) => void run("git-branch", { branch: e.target.value })}
            style={{ width: 220 }}
          >
            {!git.branches.includes(git.branch) && <option value={git.branch}>{git.branch}</option>}
            {git.branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        ) : (
          <strong>{git.branch}</strong>
        )}
        <input
          className="input"
          aria-label="새 브랜치 이름"
          placeholder="새 브랜치 이름"
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          style={{ width: 200 }}
        />
        <button
          className="btn btn--sm"
          disabled={busy || !newBranch.trim() || dirty || !git.head}
          title={!git.head ? "첫 커밋 후 브랜치를 만들 수 있습니다." : dirty ? "변경사항을 먼저 커밋하세요." : undefined}
          onClick={async () => {
            if (await run("git-branch", { branch: newBranch.trim(), create: true })) setNewBranch("");
          }}
        >
          브랜치 만들어 전환
        </button>
      </div>
      {dirty && <p className="small muted" style={{ margin: "-10px 0 0" }}>변경사항이 있으면 브랜치를 바꿀 수 없습니다.</p>}

      <div>
        <div className="row row--between">
          <strong className="small">변경 파일 {git.files.length}개 · 스테이징 {staged.length}개</strong>
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn btn--xs"
              disabled={busy || !dirty}
              onClick={async () => {
                const r = await act<{ diff: string }>("git-diff");
                if (r) showDiff("작업 트리 변경", r.diff);
              }}
            >
              Diff
            </button>
            <button
              className="btn btn--xs"
              disabled={busy || !staged.length}
              onClick={async () => {
                const r = await act<{ diff: string }>("git-diff", { staged: true });
                if (r) showDiff("스테이징한 변경", r.diff);
              }}
            >
              Staged diff
            </button>
          </div>
        </div>
        {git.files.length === 0 ? (
          <p className="small muted">작업 트리가 깨끗합니다.</p>
        ) : (
          <div className="git-files">
            {git.files.map((f) => (
              <div className="git-file" key={f.path}>
                <span className="git-file__path">{f.path}</span>
                <span className="small muted">{fileLabel(f)}</span>
                {isUnstaged(f) && (
                  <button className="btn btn--xs" disabled={busy} onClick={() => void run("git-stage", { paths: [f.path] })}>
                    Stage
                  </button>
                )}
                {isStaged(f) && (
                  <button className="btn btn--xs" disabled={busy} onClick={() => void run("git-unstage", { paths: [f.path] })}>
                    Unstage
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="input"
            aria-label="커밋 메시지"
            placeholder={staged.length ? "커밋 메시지" : "먼저 변경 파일을 Stage하세요"}
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            className="btn btn--primary"
            disabled={busy || !commitMessage.trim() || !staged.length}
            onClick={async () => {
              if (await run("git-commit", { message: commitMessage.trim() })) setCommitMessage("");
            }}
          >
            스테이징 {staged.length}개 커밋
          </button>
        </div>
      </div>

      <div className="action-group">
        <span className="action-group__title">원격 동기화 · origin {git.remote ? "" : "(연결 안 됨)"}</span>
        <div className="row">
          <button className="btn btn--sm" disabled={busy || !git.remote} onClick={() => void run("git-fetch")}>
            {pending === "git-fetch" && <Spinner />}Fetch
          </button>
          <button
            className="btn btn--sm"
            disabled={busy || !git.remote}
            title="fast-forward만 허용합니다."
            onClick={() => void run("git-pull")}
          >
            {pending === "git-pull" && <Spinner />}Pull (fast-forward)
          </button>
        </div>
        <div className="approval">
          <span className="approval__desc">
            현재 브랜치 <strong>{git.branch}</strong>의 커밋을 origin({git.repository ?? git.remote ?? "없음"})에 푸시합니다.
          </span>
          <button
            className="btn btn--sm btn--primary"
            disabled={busy || !git.remote || !git.head}
            onClick={() => void run("git-push", { approved: true })}
          >
            {pending === "git-push" && <Spinner />}승인하고 푸시
          </button>
        </div>
      </div>

      {git.log.trim() && (
        <div>
          <strong className="small">최근 커밋</strong>
          <pre className="doc-view doc-view--code" style={{ maxHeight: 220, marginTop: 6 }}>
            {git.log.trim()}
          </pre>
        </div>
      )}
    </div>
  );
}

function TaskDetail({
  task,
  policy,
  pending,
  doc,
  onDocument,
  onCloseDocument,
  onAction,
  onTerminal,
}: {
  task: DevelopmentTask;
  policy: DevelopmentPolicy | null;
  pending: string;
  doc: TaskDocument | null;
  onDocument: (name: DocName) => void;
  onCloseDocument: () => void;
  onAction: (action: string, input?: Record<string, unknown>) => Promise<unknown>;
  onTerminal: (id: string) => void;
}) {
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  useEffect(() => setConfirmCleanup(false), [task.id]);
  const running = RUNNING.includes(task.status);
  // 커밋이 생긴 작업과 백업에서 복원된 기록은 AI를 다시 실행할 수 없다.
  const final = FINAL.includes(task.status) || !!task.commitSha || !!task.restored;
  const busy = !!pending || !!task.restored;
  const forkRestricted = task.kind === 'pr' && task.forkPr !== false;
  const progress = stepProgress(task);
  const failed = ["failed", "cancelled", "action_required"].includes(task.status);
  const [label, tone] = statusInfo[task.status];
  const testCommand = policy?.testCommand ?? "";
  const canImplement = !running && !final && task.status !== "imported" && task.status !== "analyzing";
  return (
    <div className="stack">
      <Card
        title={
          <>
            {task.kind === "pr" ? "PR" : "이슈"} #{task.number} {task.title}
          </>
        }
        actions={<Badge tone={tone}>{label}</Badge>}
      >
        <div className="stepper" aria-label="진행 단계">
          {STEPS.map((step, i) => (
            <span
              key={step}
              className={`stepper__step${
                i < progress.done ? " stepper__step--done" : i === progress.current ? (failed ? " stepper__step--failed" : " stepper__step--current") : ""
              }`}
            >
              {step}
            </span>
          ))}
        </div>
        {task.restored ? (
          <Notice tone="warn" title="백업에서 복원된 작업 기록입니다">
            <span className="small">
              복원한 소스·문서는 읽을 수 있습니다. 실행하려면 원본 프로젝트를 다시 연결하고 새 작업으로 가져오세요. 정리는 기록만 제거하고 복원 파일은 남깁니다.
            </span>
          </Notice>
        ) : (
          <Notice tone={task.status === "failed" ? "error" : failed ? "warn" : "info"} title={nextStep(task, testCommand)}>
            <span className="small">{task.message}</span>
          </Notice>
        )}
        <dl className="dl" style={{ gridTemplateColumns: "110px 1fr", marginTop: 12 }}>
          <dt>작업 브랜치</dt>
          <dd className="mono small">{task.branch}</dd>
          <dt>기준 커밋</dt>
          <dd className="mono small">{task.base.slice(0, 10)}</dd>
          <dt>AI</dt>
          <dd>
            {task.provider}
            {task.model && ` · ${task.model}`}
          </dd>
          {task.verifiedCommand && (
            <>
              <dt>검증 명령</dt>
              <dd className="mono small">{task.verifiedCommand}</dd>
            </>
          )}
          {task.commitSha && (
            <>
              <dt>커밋</dt>
              <dd className="mono small">{task.commitSha.slice(0, 10)}</dd>
            </>
          )}
          <dt>갱신</dt>
          <dd>{formatDateTime(task.updatedAt)}</dd>
        </dl>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn--sm btn--ghost" onClick={() => void api.openExternal(task.url)}>
            <ExternalLink size={12} aria-hidden />
            원본 {task.kind === "pr" ? "PR" : "이슈"}
          </button>
          {task.terminalId && (
            <button className="btn btn--sm" onClick={() => onTerminal(task.terminalId!)}>
              <TerminalSquare size={13} aria-hidden />
              {running ? "실행 터미널 열기" : "마지막 실행 로그"}
            </button>
          )}
          {task.prUrl && (
            <button className="btn btn--sm" onClick={() => void api.openExternal(task.prUrl!)}>
              <GitPullRequest size={13} aria-hidden />
              등록된 PR 열기
            </button>
          )}
        </div>
      </Card>

      {forkRestricted && <Notice tone="warn" title="fork 또는 출처를 확인할 수 없는 PR입니다">분석·구현·검증은 가능하며 원본 저장소 브랜치로의 커밋·푸시는 제한됩니다.</Notice>}
      <Card title="AI 실행">
        <div className="row">
          <button
            className={`btn btn--sm${task.status === "planned" ? " btn--primary" : ""}`}
            disabled={busy || !canImplement}
            title={!canImplement && !running && !final ? "분석이 끝나 계획 문서가 생긴 뒤 구현할 수 있습니다." : undefined}
            onClick={() => void onAction("implement")}
          >
            <Play size={12} aria-hidden />
            {task.status === "planned" ? "구현 시작" : "다시 구현"}
          </button>
          <button className="btn btn--sm" disabled={busy || running || final} onClick={() => void onAction("analyze")}>
            다시 분석
          </button>
          <button
            className="btn btn--sm"
            disabled={busy || running || final || !testCommand}
            title={!testCommand ? "자동화 설정에서 검증 명령을 입력하세요." : `검증 명령: ${testCommand}`}
            onClick={() => void onAction("verify")}
          >
            <CheckCircle2 size={12} aria-hidden />
            검증만 실행
          </button>
          <button className="btn btn--sm btn--danger" disabled={!running || pending === "cancel"} onClick={() => void onAction("cancel")}>
            <Square size={11} aria-hidden />
            중지
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          AI는 인증 정보가 없는 격리 환경의 작업 worktree에서만 실행되며 커밋·푸시·배포를 하지 않습니다.
        </p>
      </Card>

      <Card title="반영 승인">
        <p className="small muted" style={{ marginTop: 0 }}>
          아래 버튼은 각 단계의 실행을 사용자 승인으로 기록합니다. 자동화 설정에서 켠 단계는 승인 없이 진행됩니다.
        </p>
        <div className="approval">
          <span className="approval__desc">
            검증을 통과한 변경을 작업 브랜치 <strong>{task.branch}</strong>에 커밋합니다.
          </span>
          <button
            className="btn btn--sm btn--primary"
            disabled={busy || forkRestricted || task.status !== "ready"}
            onClick={() => void onAction("commit", { approved: true })}
          >
            {pending === "commit" && <Spinner />}승인하고 커밋
          </button>
        </div>
        <div className="approval">
          <span className="approval__desc">
            커밋 {task.commitSha ? <span className="mono">{task.commitSha.slice(0, 8)}</span> : "(아직 없음)"}을{" "}
            <strong>{task.repository}</strong>의 {task.branch} 브랜치로 푸시합니다.
          </span>
          <button
            className="btn btn--sm btn--primary"
            disabled={busy || forkRestricted || task.status !== "committed"}
            onClick={() => void onAction("push", { approved: true })}
          >
            {pending === "push" && <Spinner />}승인하고 푸시
          </button>
        </div>
        <div className="approval">
          <span className="approval__desc">
            <strong>{task.repository}</strong>에 {task.branch} 브랜치의 PR을 등록합니다.
          </span>
          <button
            className="btn btn--sm btn--primary"
            disabled={busy || forkRestricted || task.status !== "pushed" || !!task.prUrl}
            onClick={() => void onAction("pr", { approved: true })}
          >
            {pending === "pr" && <Spinner />}승인하고 PR 등록
          </button>
        </div>
        <div className="approval">
          <span className="approval__desc">
            푸시 결과가 불확실하면 GitHub의 {task.branch} 브랜치가 이 커밋을 가리키는지 확인합니다. 원격에는 쓰지 않습니다.
          </span>
          <button
            className="btn btn--sm"
            disabled={busy || running || !task.commitSha || !["committed", "action_required", "pushed"].includes(task.status)}
            onClick={() => void onAction("reconcile-push")}
          >
            {pending === "reconcile-push" && <Spinner />}원격 반영 확인
          </button>
        </div>
        <div className="approval">
          <span className="approval__desc">
            Git 연동 배포 서비스가 푸시한 커밋으로 만든 Preview 결과를 GitHub에서 조회합니다.
            {task.previews && task.previews.length === 0 && " 아직 Preview가 없습니다."}
          </span>
          <button
            className="btn btn--sm"
            disabled={busy || task.status !== "pushed"}
            onClick={() => void onAction("preview-check")}
          >
            {pending === "preview-check" && <Spinner />}Preview 확인
          </button>
        </div>
        {task.previews && task.previews.length > 0 && (
          <div className="session-chips">
            {task.previews.map((p) => (
              <button key={p.url} className="btn btn--xs" onClick={() => void api.openExternal(p.url)}>
                <ExternalLink size={12} aria-hidden />
                {p.environment} · {p.state}
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="작업 정리">
        <div className="approval">
          <span className="approval__desc">
            {task.restored
              ? "복원된 작업 기록을 목록에서 지웁니다."
              : `작업 worktree와 기록을 지웁니다. 브랜치 ${task.branch}는 저장소에 남습니다. 커밋하지 않은 변경이 있으면 정리를 멈춥니다.`}
          </span>
          {confirmCleanup ? (
            <span className="row" style={{ gap: 6 }}>
              <button
                className="btn btn--sm btn--danger"
                disabled={!!pending || running}
                onClick={() => void onAction("cleanup")}
              >
                {pending === "cleanup" && <Spinner />}정리 확정
              </button>
              <button className="btn btn--sm btn--ghost" onClick={() => setConfirmCleanup(false)}>
                취소
              </button>
            </span>
          ) : (
            <button
              className="btn btn--sm"
              disabled={!!pending || running}
              title={running ? "실행을 중지한 뒤 정리할 수 있습니다." : undefined}
              onClick={() => setConfirmCleanup(true)}
            >
              작업 정리
            </button>
          )}
        </div>
      </Card>

      <Card title="문서·변경사항" icon={FileText}>
        <div className="tabs" role="tablist" aria-label="작업 문서" style={{ marginBottom: 12 }}>
          {DOCS.map(([name, label]) => (
            <button
              key={name}
              className="tab"
              role="tab"
              aria-selected={doc?.name === name}
              disabled={!!pending || (!!task.restored && name === "diff")}
              title={task.restored && name === "diff" ? "복원된 작업은 작업 폴더가 없어 변경사항을 볼 수 없습니다." : undefined}
              onClick={() => (doc?.name === name ? onCloseDocument() : onDocument(name))}
            >
              {label}
            </button>
          ))}
        </div>
        {!doc ? (
          <p className="small muted">문서를 선택하세요. 계획 문서는 분석이 끝난 뒤 생성됩니다.</p>
        ) : doc.name === "diff" ? (
          <DiffView text={doc.text || "기준 커밋 대비 변경이 없습니다."} />
        ) : doc.name === "review.json" ? (
          <ReviewView text={doc.text} />
        ) : doc.name === "source" ? (
          <SourceView text={doc.text} />
        ) : (
          <pre className="doc-view">{doc.text}</pre>
        )}
      </Card>
    </div>
  );
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="doc-view doc-view--code">
      {text.split("\n").map((line, i) => {
        const cls = line.startsWith("diff --git")
          ? "diff-file"
          : line.startsWith("@@")
            ? "diff-hunk"
            : line.startsWith("+") && !line.startsWith("+++")
              ? "diff-add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-del"
                : undefined;
        return cls ? (
          <span key={i} className={cls}>
            {line}
          </span>
        ) : (
          <span key={i}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function ReviewView({ text }: { text: string }) {
  let review: { passed?: unknown; findings?: unknown } | null = null;
  try {
    review = JSON.parse(text);
  } catch {
    review = null;
  }
  if (!review || typeof review !== "object")
    return (
      <Notice tone="warn" title="리뷰 결과 형식을 읽지 못했습니다">
        <pre className="doc-view">{text}</pre>
      </Notice>
    );
  const findings = Array.isArray(review.findings) ? review.findings.map(String) : [];
  const passed = review.passed === true && findings.length === 0;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <Badge tone={passed ? "ok" : "error"}>{passed ? "리뷰 통과" : "보완 필요"}</Badge>
      </div>
      {findings.length > 0 ? (
        <div>
          {findings.map((f, i) => (
            <div key={i} className="finding">
              <span className="finding__body finding__msg">{f}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="small muted">차단 문제가 없습니다.</p>
      )}
    </div>
  );
}

// 원본 문서의 GitHub API 첨부(JSON)는 요약해서 보여 준다.
function SourceView({ text }: { text: string }) {
  const marker = "\n## 댓글·리뷰·변경 파일";
  const at = text.indexOf(marker);
  const head = at >= 0 ? text.slice(0, at) : text;
  const match = at >= 0 ? /```json\n([\s\S]*)\n```/.exec(text.slice(at)) : null;
  let data: { comments?: unknown; reviews?: unknown; files?: unknown } | null = null;
  try {
    data = match ? JSON.parse(match[1]!) : null;
  } catch {
    data = null;
  }
  const flat = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? v.flatMap((x) => (Array.isArray(x) ? x : [x])).filter((x) => x && typeof x === "object") : [];
  const comments = flat(data?.comments);
  const reviews = flat(data?.reviews);
  const files = flat(data?.files);
  const who = (c: Record<string, unknown>) =>
    String((c.user as { login?: string } | undefined)?.login ?? "알 수 없음");
  return (
    <div className="stack" style={{ gap: 12 }}>
      <pre className="doc-view">{head.trim()}</pre>
      {data ? (
        <>
          {files.length > 0 && (
            <Section title={`변경 파일 ${files.length}개`}>
              {files.map((f, i) => (
                <div key={i} className="git-file">
                  <span className="git-file__path">{String(f.filename ?? "")}</span>
                  <span className="small" style={{ color: "var(--ok)" }}>+{String(f.additions ?? 0)}</span>
                  <span className="small" style={{ color: "var(--error)" }}>-{String(f.deletions ?? 0)}</span>
                </div>
              ))}
            </Section>
          )}
          <Section title={`댓글 ${comments.length}개`}>
            {comments.map((c, i) => (
              <div key={i} className="finding">
                <div className="finding__body">
                  <div className="finding__meta">{who(c)}</div>
                  <div className="small" style={{ whiteSpace: "pre-wrap" }}>{String(c.body ?? "")}</div>
                </div>
              </div>
            ))}
          </Section>
          {reviews.length > 0 && (
            <Section title={`코드 리뷰 댓글 ${reviews.length}개`}>
              {reviews.map((c, i) => (
                <div key={i} className="finding">
                  <div className="finding__body">
                    <div className="finding__meta">
                      {who(c)}
                      {c.path ? ` · ${String(c.path)}` : ""}
                    </div>
                    <div className="small" style={{ whiteSpace: "pre-wrap" }}>{String(c.body ?? "")}</div>
                  </div>
                </div>
              ))}
            </Section>
          )}
        </>
      ) : (
        at >= 0 && (
          <details>
            <summary className="small">첨부 자료 원문</summary>
            <pre className="doc-view doc-view--code">{text.slice(at)}</pre>
          </details>
        )
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}

function PolicyCard({
  policy,
  dirty,
  pending,
  onChange,
  onReset,
  onSave,
}: {
  policy: DevelopmentPolicy | null;
  dirty: boolean;
  pending: string;
  onChange: (p: DevelopmentPolicy) => void;
  onReset: () => void;
  onSave: () => void;
}) {
  const options = [
    ["autoImplement", "분석 후 자동 구현", "계획 문서가 만들어지면 바로 구현·리뷰·검증을 진행합니다."],
    ["autoCommit", "검증 통과 시 자동 커밋", "검증 설정·테스트 파일이 바뀐 경우에는 멈추고 승인을 요청합니다."],
    ["autoPush", "자동 커밋 후 자동 푸시", "Git 배포 연동이 켜진 저장소는 푸시가 Preview 빌드를 시작할 수 있습니다."],
    ["autoPr", "푸시 후 자동 PR 등록", ""],
    [
      "autoPreview",
      "푸시 후 Git 연동 Preview 결과 조회",
      "GitHub에 기록된 Netlify·Vercel Git 연동 Preview의 상태와 URL만 읽어 옵니다. 이 앱이 따로 배포하지는 않습니다.",
    ],
  ] as const;
  return (
    <details className="card">
      <summary className="card__head" style={{ cursor: "pointer" }}>
        <h2 className="card__title">프로젝트 자동화 설정</h2>
        {policy && (
          <span className="small muted" style={{ marginLeft: "auto" }}>
            {dirty
              ? "저장하지 않은 변경"
              : options.filter(([k]) => policy[k]).length
                ? `자동 ${options.filter(([k]) => policy[k]).length}단계 켜짐`
                : "모든 단계 승인 필요"}
          </span>
        )}
      </summary>
      <div className="card__body">
        {!policy ? (
          <Spinner />
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {options.map(([key, label, hint]) => {
              const blocked = key === "autoPush" && !policy.autoCommit;
              return (
                <label className="checkbox-row" key={key} style={{ opacity: blocked ? 0.6 : 1 }}>
                  <input
                    type="checkbox"
                    checked={policy[key]}
                    disabled={blocked}
                    onChange={(e) =>
                      onChange({
                        ...policy,
                        [key]: e.target.checked,
                        ...(key === "autoCommit" && !e.target.checked ? { autoPush: false } : {}),
                      })
                    }
                  />
                  <span>
                    {label}
                    {(hint || blocked) && (
                      <span className="small muted" style={{ display: "block" }}>
                        {blocked ? "자동 커밋을 켜야 사용할 수 있습니다." : hint}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            <label className="field" style={{ marginTop: 6 }}>
              <span className="field__label">검증 명령</span>
              <input
                className="input"
                value={policy.testCommand}
                placeholder="예: npm test (가져올 때 package.json에서 자동으로 채웁니다)"
                onChange={(e) => onChange({ ...policy, testCommand: e.target.value })}
              />
              <span className="field__hint">인증 정보가 없는 격리 환경의 작업 worktree에서 실행합니다.</span>
            </label>
            <div className="row">
              <button className="btn btn--primary" disabled={!dirty || !!pending || api.isDemo()} onClick={onSave}>
                자동화 설정 저장
              </button>
              {dirty && (
                <button className="btn btn--ghost" onClick={onReset}>
                  되돌리기
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
