import type { AgentProvider, AgentChoice, AgentPurpose } from "../agent/types.js";
export type StudioTool = AgentProvider | "github" | "netlify" | "vercel";
export interface CliConnection {
  tool: StudioTool;
  executable: string | null;
  status: "missing" | "connected" | "login_required" | "unchecked";
  message: string;
}
export interface TerminalSession {
  id: string;
  title: string;
  status: "running" | "exited";
  exitCode?: number;
  createdAt: string;
}
export interface TerminalOutput {
  data: string;
  cursor: number;
  reset: boolean;
  session: TerminalSession;
}
export interface GitFile {
  path: string;
  index: string;
  working: string;
}
export interface GitState {
  root: string;
  branch: string;
  head: string;
  remote: string | null;
  repository: string | null;
  files: GitFile[];
  branches: string[];
  log: string;
}
export interface GithubItem {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  updated_at: string;
  pull_request?: { url: string };
  user?: { login: string };
}
export interface DevelopmentPolicy {
  autoImplement: boolean;
  autoCommit: boolean;
  autoPush: boolean;
  autoPr: boolean;
  autoPreview: boolean;
  testCommand: string;
}
export const DEFAULT_DEV_POLICY: DevelopmentPolicy = {
  autoImplement: false,
  autoCommit: false,
  autoPush: false,
  autoPr: false,
  autoPreview: false,
  testCommand: "",
};
export interface DevelopmentTask {
  id: string;
  projectId: string;
  repository: string;
  number: number;
  kind: "issue" | "pr";
  title: string;
  url: string;
  worktree: string;
  branch: string;
  base: string;
  sourceSha: string;
  documentPath: string;
  restored?: boolean;
  forkPr?: boolean;
  cancelledAfterCommit?: boolean;
  terminalId?: string;
  status:
    | "imported"
    | "analyzing"
    | "planned"
    | "implementing"
    | "reviewing"
    | "verifying"
    | "ready"
    | "committed"
    | "pushed"
    | "failed"
    | "cancelled"
    | "action_required";
  provider: AgentProvider;
  model?: string;
  choices?: Partial<Record<AgentPurpose, AgentChoice>>;
  message: string;
  createdAt: string;
  updatedAt: string;
  verifiedFingerprint?: string;
  verifiedCommand?: string;
  commitSha?: string;
  prUrl?: string;
  previews?: Array<{ environment: string; state: string; url: string }>;
}
export interface WebDeployment {
  resolved?: boolean;
  sourceSha?: string;
  deploymentId?: string;
  dispatched?: boolean;
  id: string;
  projectId: string;
  provider: "netlify" | "vercel";
  production: boolean;
  status: "running" | "succeeded" | "failed" | "action_required";
  terminalId: string;
  url?: string;
  message: string;
  createdAt: string;
}
export interface DevelopmentState {
  tasks: DevelopmentTask[];
  terminals: TerminalSession[];
  connections: CliConnection[];
  deployments: WebDeployment[];
}
// GitHub 저장소 목록 응답(github.ts repositories()).
export interface GithubRepository {
  id: number;
  full_name: string;
  clone_url: string;
  private: boolean;
}
// 이슈·PR 목록 한 페이지(github.ts listItems()).
export interface GithubItemPage {
  items: GithubItem[];
  hasMore: boolean;
  page: number;
}
// POST /development action별 응답(apps/controller/development.ts). 등록한 action은 renderer에서 응답 타입을 추론하고,
// 등록하지 않은 action은 호출자가 타입을 지정한다. 서버가 허용하는 action 목록과는 무관하다.
export interface DevelopmentResponses {
  state: DevelopmentState;
  repositories: GithubRepository[];
  "git-state": GitState;
  "git-init": GitState;
  "git-remote": GitState;
  "git-clone": { directory: string };
  "git-diff": { diff: string };
  "git-stage": GitState;
  "git-unstage": GitState;
  "git-fetch": GitState;
  "git-pull": GitState;
  "git-push": GitState;
  "git-commit": GitState;
  "git-branch": GitState;
  items: GithubItemPage;
  policy: DevelopmentPolicy;
  "policy-save": DevelopmentPolicy;
  import: DevelopmentTask;
  analyze: DevelopmentTask;
  implement: DevelopmentTask;
  verify: DevelopmentTask;
  commit: DevelopmentTask;
  push: DevelopmentTask;
  pr: DevelopmentTask;
  cancel: DevelopmentTask;
  "reconcile-push": DevelopmentTask;
  "preview-check": { previews: NonNullable<DevelopmentTask["previews"]> };
  cleanup: { cleaned: boolean; preserved?: boolean; branch?: string };
  document: { text: string };
}
export type DevelopmentAction = keyof DevelopmentResponses;
