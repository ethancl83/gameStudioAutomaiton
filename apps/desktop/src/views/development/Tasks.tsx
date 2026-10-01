// 가져온 개발 작업의 선택·진행 단계·AI 실행·반영 승인·정리·문서 열람.
import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, FileText, GitPullRequest, ListTodo, Play, Square, TerminalSquare } from "lucide-react";
import type { DevelopmentPolicy, DevelopmentTask } from "../../../../../packages/development/types";
import { api } from "../../api";
import { formatDateTime, formatRelative } from "../../format";
import { Badge, Card, EmptyState, Notice, Spinner } from "../../components/ui";
import { TaskDocumentView } from "./Documents";
import {
  DOCS,
  FINAL,
  RUNNING,
  STEPS,
  nextStep,
  statusInfo,
  stepProgress,
  type DocName,
  type TaskAction,
  type TaskDocument,
} from "./taskStatus";
import type { DevelopmentRequests } from "./useDevelopmentRequests";

export type TaskWorkspace = ReturnType<typeof useTaskWorkspace>;

// tasks는 선택한 프로젝트의 작업만 담는다. 프로젝트가 바뀌면 선택과 열어 둔 문서를 비운다.
export function useTaskWorkspace(
  { projectId, act, setInfo }: DevelopmentRequests,
  tasks: DevelopmentTask[],
  reloadStudio: () => Promise<void>,
) {
  const [selected, setSelected] = useState("");
  const [doc, setDoc] = useState<TaskDocument | null>(null);
  const task = tasks.find((t) => t.id === selected);

  useEffect(() => {
    setSelected("");
    setDoc(null);
  }, [projectId]);

  function select(id: string) {
    setSelected(id);
    setDoc(null);
  }
  async function runAction(action: TaskAction, input: Record<string, unknown> = {}) {
    if (!task) return;
    const r = await act(action, { id: task.id, ...input });
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
        ? await act("git-diff", { id: taskId }).then((v) => v && { text: v.diff })
        : await act("document", { id: taskId, name });
    if (r) setDoc({ taskId, name, text: r.text });
  }
  return {
    selected,
    task,
    // 선택이 바뀌면 이전 작업의 문서는 표시하지 않는다.
    doc: doc && task && doc.taskId === task.id ? doc : null,
    select,
    // 이슈/PR 목록의 "작업 보기"는 열어 둔 문서를 유지한 채 선택만 바꾼다.
    show: setSelected,
    closeDocument: () => setDoc(null),
    runAction,
    loadDocument,
  };
}

export function TasksTab({
  loaded,
  tasks,
  workspace,
  policy,
  pending,
  onTerminal,
}: {
  loaded: boolean;
  tasks: DevelopmentTask[];
  workspace: TaskWorkspace;
  policy: DevelopmentPolicy | null;
  pending: string;
  onTerminal: (id: string) => void;
}) {
  const { selected, task } = workspace;
  return (
    <div className="task-layout">
      <Card title="가져온 작업" icon={ListTodo}>
        {!loaded ? (
          <Spinner />
        ) : tasks.length === 0 ? (
          <EmptyState icon={ListTodo} title="가져온 작업이 없습니다" description="이슈 또는 PR 탭에서 작업을 가져오세요." />
        ) : (
          <div className="stack" style={{ gap: 4 }}>
            {tasks.map((t) => (
              <button key={t.id} className="task-pick" aria-current={selected === t.id} onClick={() => workspace.select(t.id)}>
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
          policy={policy}
          pending={pending}
          doc={workspace.doc}
          onDocument={workspace.loadDocument}
          onCloseDocument={workspace.closeDocument}
          onAction={workspace.runAction}
          onTerminal={onTerminal}
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
  onAction: (action: TaskAction, input?: Record<string, unknown>) => Promise<unknown>;
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
        ) : (
          <TaskDocumentView doc={doc} />
        )}
      </Card>
    </div>
  );
}
