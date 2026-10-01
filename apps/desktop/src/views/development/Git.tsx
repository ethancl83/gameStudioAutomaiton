// 선택한 프로젝트의 로컬 Git 상태·변경 관리와 GitHub 저장소 연결·Clone.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, GitBranch, Link2, RefreshCw } from "lucide-react";
import type { GitFile, GitState } from "../../../../../packages/development/types";
import { api, type GithubRepository } from "../../api";
import { Card, Notice, Spinner } from "../../components/ui";
import { DiffView } from "./Documents";
import type { DevelopmentRequests } from "./useDevelopmentRequests";

export type GitWorkspace = ReturnType<typeof useGitWorkspace>;
type GitMutation = "git-branch" | "git-stage" | "git-unstage" | "git-commit" | "git-fetch" | "git-pull" | "git-push";

function fileLabel(f: GitFile) {
  if (f.index === "?" && f.working === "?") return "새 파일";
  const codes: Record<string, string> = { M: "수정", A: "추가", D: "삭제", R: "이름 변경", C: "복사", U: "충돌" };
  const staged = f.index.trim() && f.index !== "?" ? `스테이징: ${codes[f.index] ?? f.index}` : "";
  const working = f.working.trim() && f.working !== "?" ? `작업 트리: ${codes[f.working] ?? f.working}` : "";
  return [staged, working].filter(Boolean).join(" · ");
}
const isStaged = (f: GitFile) => !!f.index.trim() && f.index !== "?";
const isUnstaged = (f: GitFile) => !!f.working.trim();

// Git 상태는 헤더·이슈/PR 탭도 읽으므로 탭 밖에서 유지한다. 커밋 메시지·새 브랜치 입력은 탭을 오가도 남는다.
export function useGitWorkspace({ projectId, projectRef }: DevelopmentRequests, demo: boolean) {
  const [git, setGit] = useState<GitState | null>(null);
  const [gitError, setGitError] = useState("");
  const [diff, setDiff] = useState<{ title: string; text: string } | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [repos, setRepos] = useState<GithubRepository[] | null>(null);
  const [selectedRepo, setSelectedRepo] = useState("");

  const load = useCallback(async () => {
    if (!projectId || demo) return;
    const r = await api.studio("git-state", { projectId });
    if (projectRef.current !== projectId) return;
    if (r.ok) {
      setGit(r.data);
      setGitError("");
    } else {
      setGit(null);
      setGitError(r.error.message);
    }
  }, [projectId, projectRef, demo]);
  // 프로젝트가 바뀌면 이전 프로젝트의 Git 상태·diff·저장소 선택이 새 프로젝트에 쓰이지 않도록 비운다.
  useEffect(() => {
    setGit(null);
    setGitError("");
    setDiff(null);
    setRepos(null);
    setSelectedRepo("");
    void load();
  }, [load]);

  function apply(next: GitState) {
    setGit(next);
    setGitError("");
  }
  return {
    git,
    gitError,
    load,
    apply,
    diff,
    showDiff: (title: string, text: string) => setDiff({ title, text }),
    closeDiff: () => setDiff(null),
    commitMessage,
    setCommitMessage,
    newBranch,
    setNewBranch,
    repos,
    setRepos,
    selectedRepo,
    setSelectedRepo,
  };
}

export function GitTab({
  workspace,
  requests,
  demo,
  projectName,
  refresh,
}: {
  workspace: GitWorkspace;
  requests: DevelopmentRequests;
  demo: boolean;
  projectName?: string;
  refresh: () => Promise<void>;
}) {
  const { git, gitError, diff, repos, selectedRepo } = workspace;
  const { act, pending, setInfo, setError, selectProject } = requests;
  return (
    <>
      <Card
        title="Git 상태와 변경사항"
        icon={GitBranch}
        actions={
          <button className="btn btn--sm" disabled={demo || !!pending} onClick={() => void workspace.load()}>
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
                  const r = await act("git-init");
                  if (r) {
                    workspace.apply(r);
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
          <GitPanel git={git} workspace={workspace} requests={requests} />
        )}
        {diff && (
          <div style={{ marginTop: 14 }}>
            <div className="row row--between">
              <strong className="small">{diff.title}</strong>
              <button className="btn btn--xs btn--ghost" onClick={workspace.closeDiff}>
                닫기
              </button>
            </div>
            <DiffView text={diff.text || "변경 없음"} />
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
              const r = await act("repositories", {}, false);
              if (r) {
                workspace.setRepos(r);
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
              onChange={(e) => workspace.setSelectedRepo(e.target.value)}
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
                const r = await act("git-remote", { repository: selectedRepo });
                if (r) {
                  workspace.apply(r);
                  setInfo(`${selectedRepo}를 origin으로 연결했습니다.`);
                }
              }}
            >
              {projectName}의 origin으로 연결
            </button>
            <button
              className="btn"
              disabled={!!pending}
              onClick={async () => {
                const directory = await api.selectFolder();
                if (!directory) return;
                const repository = selectedRepo;
                const r = await act("git-clone", { repository, directory }, false);
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
  );
}

function GitPanel({
  git,
  workspace,
  requests,
}: {
  git: GitState;
  workspace: GitWorkspace;
  requests: DevelopmentRequests;
}) {
  const { act, pending } = requests;
  const { commitMessage, setCommitMessage, newBranch, setNewBranch } = workspace;
  const busy = !!pending;
  const staged = git.files.filter(isStaged);
  const dirty = git.files.length > 0;
  const run = async (action: GitMutation, input: Record<string, unknown> = {}) => {
    const r = await act(action, input);
    if (r) workspace.apply(r);
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
                const r = await act("git-diff");
                if (r) workspace.showDiff("작업 트리 변경", r.diff);
              }}
            >
              Diff
            </button>
            <button
              className="btn btn--xs"
              disabled={busy || !staged.length}
              onClick={async () => {
                const r = await act("git-diff", { staged: true });
                if (r) workspace.showDiff("스테이징한 변경", r.diff);
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
