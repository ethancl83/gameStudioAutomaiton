export type AgentProvider = 'codex' | 'opencode';
export type AgentPurpose = 'analysis' | 'coding' | 'review' | 'operations';
export interface AgentChoice { provider: AgentProvider | 'auto'; model?: string }
export interface AgentSettings extends AgentChoice { purposes?: Partial<Record<AgentPurpose, AgentChoice>> }
export interface AgentRuntime { provider: AgentProvider; executable: string | null }
export interface AgentListing {
  title: string;
  shortDescription: string;
  fullDescription: string;
  language: string;
  category: string;
  evidence: string[];
}
export interface AgentImage {
  mediaAssetId: string;
  name: string;
  purpose: 'icon' | 'feature' | 'screenshot' | 'artwork';
  source: 'project' | 'generated';
  width: number;
  height: number;
}
export interface AgentTask {
  id: string;
  projectId: string | null;
  provider: AgentProvider | null;
  model?: string;
  settingsPinned?: boolean;
  sessionId?: string;
  sessionStarted?: boolean;
  sessionGeneration: string;
  /** clear 전 native 세션 감사 기록. 이 ID들은 다시 resume하지 않는다. */
  clearedSessions?: Array<{ provider: AgentProvider; sessionId: string; clearedAt: string }>;
  requestContext?: AgentRequestContext;
  status: 'idle' | 'queued' | 'running' | 'needs_user' | 'failed' | 'cancelled' | 'completed';
  message: string;
  question?: { message: string; url?: string; kind: 'login' | 'information' | 'tooling' };
  listing?: AgentListing;
  images: AgentImage[];
  runIds: string[];
  conversation: Array<{ role: 'user' | 'assistant'; text: string; at: string; context?: AgentRequestContext }>;
  createdAt: string;
  updatedAt: string;
}
export type AgentScreen = 'agent' | 'dashboard' | 'setup' | 'projects' | 'connections' | 'releases' | 'marketing' | 'monetization' | 'community' | 'operations' | 'history' | 'settings' | 'development' | 'web-deployments' | 'growth';
/** 화면 선택 항목의 표시용 스냅샷. 권한이 아니라 요청 맥락이며, revision이 바뀌었으면 stale로 표시한다. */
export interface AgentSelection { kind: 'project' | 'connection' | 'run' | 'experiment' | 'mandate' | 'response' | 'cluster' | 'resource' | 'knowledge' | 'incident' | 'product-link' | 'pricing'; id: string; label: string; revision?: string }
export interface AgentRequestContext { screen: AgentScreen; projectId?: string; connectionId?: string; selection?: AgentSelection; stale?: boolean; staleReason?: string }
export interface AgentState { settings: AgentSettings; runtimes: AgentRuntime[]; tasks: AgentTask[] }
