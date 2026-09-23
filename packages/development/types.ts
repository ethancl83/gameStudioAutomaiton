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
