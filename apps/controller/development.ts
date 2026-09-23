import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppService } from "./service.js";
import { AppError, object, text } from "../../packages/domain/errors.js";
import { StudioTerminals } from "../../packages/development/terminal.js";
import {
  STUDIO_TOOLS,
  connection,
  login,
  install, models, logout,
} from "../../packages/development/connections.js";
import type { StudioTool } from "../../packages/development/types.js";
import {
  git,
  gitState,
  checkedPaths,
  repository,
} from "../../packages/development/git.js";
import { repositories, listItems } from "../../packages/development/github.js";
import { requireTool, command } from "../../packages/development/process.js";
import { DevelopmentTasks } from "./development-tasks.js";
import { WebDeployments } from "./web-deployments.js";
export class DevelopmentStudio {
  readonly terminals: StudioTerminals;
  readonly tasks: DevelopmentTasks;
  readonly deployments: WebDeployments;
  private locked = false;
  constructor(
    private service: AppService,
    private mode: "demo" | "live",
  ) {
    const socketRoot = join(
      tmpdir(),
      `appops-${createHash("sha256").update(service.store.directory).digest("hex").slice(0, 16)}`,
    );
    this.terminals = new StudioTerminals(socketRoot, mode === "demo", join(service.store.directory, "terminal-logs"));
    this.tasks = new DevelopmentTasks(
      service,
      this.terminals,
      join(service.store.directory, "development"),
    );
    this.deployments = new WebDeployments(service, this.terminals);
  }
  get busy() {
    return this.tasks.busy || this.terminals.busy || this.deployments.busy;
  }
  async recover() {
    await this.terminals.initialize();
    this.tasks.recover();
    this.deployments.recover();
  }
  async close() {
    await this.tasks.close();
    await this.deployments.close();
  }
  async action(input: unknown): Promise<unknown> {
    const data = object(input);
    const action = text(data.action, "동작", 60);
    const reads = [
      "state",
      "connections",
      "terminal-read",
      "git-state",
      "git-diff",
      "repositories",
      "items",
      "policy",
      "document",
      "web-inspect",
    ];
    if (this.mode === "demo") {
      if (action === "state")
        return {
          tasks: [],
          terminals: [],
          connections: STUDIO_TOOLS.map((tool) => ({
            tool,
            executable: null,
            status: "unchecked",
            message: "데모에서는 실제 CLI를 조회하지 않습니다.",
          })),
          deployments: [],
        };
      if (action === "connections")
        return STUDIO_TOOLS.map((tool) => ({
          tool,
          executable: null,
          status: "unchecked",
          message: "실제 운영 모드에서 연결하세요.",
        }));
      if (action === "policy")
        return this.tasks.policy(text(data.projectId, "프로젝트", 100));
      throw new AppError(
        "DEMO_BLOCKED",
        "Git·터미널·서비스 연동은 실제 운영 모드에서 사용할 수 있습니다.",
      );
    }
    const localTerminal = [
      "terminal-read",
      "terminal-input",
      "terminal-resize",
      "terminal-stop",
    ];
    const mutation = !reads.includes(action) && !localTerminal.includes(action);
    if (mutation && this.locked)
      throw new AppError(
        "BUSY",
        "요청을 처리하고 있습니다. 잠시 후 다시 시도하세요.",
        409,
      );
    if (mutation) this.locked = true;
    try {
      return await this.execute(action, data);
    } finally {
      if (mutation) this.locked = false;
    }
  }
  private async execute(
    action: string,
    data: Record<string, unknown>,
  ): Promise<unknown> {
    const id = () => text(data.id, "작업", 100);
    const project = () =>
      this.service.project(text(data.projectId, "프로젝트", 100));
    const tool = () => {
      if (!STUDIO_TOOLS.includes(data.tool as StudioTool))
        throw new AppError("INVALID_TOOL", "CLI를 선택하세요.");
      return data.tool as StudioTool;
    };
    const provider = () => {
      if (!["netlify", "vercel"].includes(String(data.provider)))
        throw new AppError("INVALID_PROVIDER", "배포 서비스를 선택하세요.");
      return data.provider as "netlify" | "vercel";
    };
    if (action === "state")
      return {
        tasks: this.tasks.list(),
        terminals: this.terminals.list(),
        connections: await Promise.all(STUDIO_TOOLS.map((t) => connection(t))),
        deployments: this.deployments.list(),
      };
    if (action === "connections")
      return Promise.all(STUDIO_TOOLS.map((t) => connection(t)));
    if (action === "connection-check") return connection(tool(), true);
    if (action === "install") return install(tool(), this.terminals, this.service.store.directory);
    if (action === "logout") return logout(tool(), this.terminals, this.service.store.directory);
    if (action === "models") { const t = tool(); if (t !== "codex" && t !== "opencode") throw new AppError("INVALID_TOOL", "AI CLI를 선택하세요."); return models(t); }
    if (action === "login")
      return login(tool(), this.terminals, this.service.store.directory);
    if (action === "terminal-read")
      return this.terminals.read(id(), Number(data.cursor ?? 0));
    if (action === "terminal-input") {
      if (typeof data.data !== "string")
        throw new AppError("INVALID_INPUT", "터미널 입력을 확인하세요.");
      this.terminals.input(id(), data.data);
      return { sent: true };
    }
    if (action === "terminal-resize") {
      this.terminals.resize(id(), Number(data.cols), Number(data.rows));
      return { resized: true };
    }
    if (action === "terminal-stop") {
      const task = this.tasks
        .list()
        .find(
          (t) =>
            t.terminalId === id() &&
            ["analyzing", "implementing", "reviewing", "verifying"].includes(t.status),
        );
      if (task) return this.tasks.cancel(task.id);
      await this.terminals.stop(id());
      return { stopped: true };
    }
    if (action === 'terminal-setup') return this.terminals.installHost(this.service.store.directory);
    if (action === "repositories") return repositories();
    if (action === "git-state") return gitState(project().rootPath);
    if (action === "git-init") {
      const p = project();
      await git(p.rootPath, ["init"]);
      return gitState(p.rootPath);
    }
    if (action === "git-remote") {
      const p = project();
      const repo = repository(text(data.repository, "저장소", 200));
      const state = await gitState(p.rootPath);
      await git(p.rootPath, [
        "remote",
        state.remote ? "set-url" : "add",
        "origin",
        `https://github.com/${repo}.git`,
      ]);
      return gitState(p.rootPath);
    }
    if (action === "git-clone") {
      const repo = repository(text(data.repository, "저장소", 200));
      const parent = text(data.directory, "폴더", 2000);
      const target = join(parent, repo.split("/")[1]!);
      await command(
        await requireTool("github"),
        ["repo", "clone", repo, target],
        { timeout: 120000 },
      );
      return { directory: target };
    }
    if (action === "git-diff") {
      if (data.id) return this.tasks.diff(id(), data.staged === true);
      const root = project().rootPath;
      return {
        diff: await git(root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          ...(data.staged ? ["--cached"] : []),
        ]),
      };
    }
    if (action === "git-stage" || action === "git-unstage") {
      const root = project().rootPath;
      const paths = await checkedPaths(
        root,
        Array.isArray(data.paths) ? data.paths.map(String) : [],
      );
      await git(
        root,
        action === "git-stage"
          ? ["add", "--", ...paths]
          : ["restore", "--staged", "--", ...paths],
      );
      return gitState(root);
    }
    if (
      action === "git-fetch" ||
      action === "git-pull" ||
      action === "git-push"
    ) {
      const root = project().rootPath;
      if (action === "git-push" && data.approved !== true)
        throw new AppError("APPROVAL_REQUIRED", "푸시를 승인하세요.");
      await git(
        root,
        action === "git-fetch"
          ? ["fetch", "origin"]
          : action === "git-pull"
            ? ["pull", "--ff-only"]
            : ["push", "origin", "HEAD"],
      );
      return gitState(root);
    }
    if (action === "git-commit") {
      const root = project().rootPath;
      await git(root, [
        "commit",
        "-m",
        text(data.message, "커밋 메시지", 1000),
      ]);
      return gitState(root);
    }
    if (action === "git-branch") {
      const root = project().rootPath;
      const name = text(data.branch, "브랜치", 200);
      await git(root, ["check-ref-format", "--branch", name]);
      const state = await gitState(root);
      if (state.files.length)
        throw new AppError("DIRTY_TREE", "변경사항을 먼저 커밋하세요.");
      await git(root, ["switch", ...(data.create ? ["-c"] : []), name]);
      return gitState(root);
    }
    if (action === "items") {
      const state = await gitState(project().rootPath);
      if (!state.repository)
        throw new AppError("GITHUB_REQUIRED", "GitHub 저장소를 연결하세요.");
      return listItems(
        state.repository,
        data.kind === "pr" ? "pr" : "issue",
        typeof data.state === "string" ? data.state : "open",
        Number(data.page ?? 1),
      );
    }
    if (action === "policy") return this.tasks.policy(project().id);
    if (action === "policy-save")
      return this.tasks.savePolicy(project().id, object(data.policy));
    if (action === "import")
      return this.tasks.import(
        project().id,
        data.kind === "pr" ? "pr" : "issue",
        Number(data.number),
      );
    if (action === "analyze" || action === "implement")
      return this.tasks.start(
        id(),
        action === "analyze" ? "analyze" : "implement",
      );
    if (action === "verify") return this.tasks.start(id(), "verify");
    if (action === "commit") return this.tasks.commit(id());
    if (action === "push") {
      if (data.approved !== true)
        throw new AppError("APPROVAL_REQUIRED", "푸시를 승인하세요.");
      return this.tasks.push(id());
    }
    if (action === 'reconcile-push') return this.tasks.reconcilePush(id());
    if (action === 'preview-check') return this.tasks.inspectPreview(id());
    if (action === 'cleanup') return this.tasks.cleanup(id());
    if (action === "pr") {
      if (data.approved !== true)
        throw new AppError("APPROVAL_REQUIRED", "PR 등록을 승인하세요.");
      return this.tasks.createPr(id());
    }
    if (action === "cancel") return this.tasks.cancel(id());
    if (action === "document")
      return this.tasks.document(id(), text(data.name, "문서", 100));
    if (action === "web-check") return this.deployments.check(id());
    if (action === 'web-resolve') {
      if (data.approved !== true) throw new AppError('APPROVAL_REQUIRED', '외부 서비스 확인 후 배포 잠금 해제를 승인하세요.');
      return this.deployments.resolve(id());
    }
    if (action === "web-inspect") return this.deployments.inspect(project().id);
    if (action === "web-link")
      return this.deployments.link(project().id, provider());
    if (action === "deploy") {
      if (data.approved !== true)
        throw new AppError("APPROVAL_REQUIRED", "배포를 승인하세요.");
      return this.deployments.deploy(
        project().id,
        provider(),
        data.production === true,
        text(data.expectedHead, '승인한 커밋', 64),
      );
    }
    throw new AppError("INVALID_ACTION", "지원하지 않는 개발 작업입니다.");
  }
}
