export type AgentProvider = 'codex' | 'opencode';
export interface AgentSettings { provider: AgentProvider | 'auto' }
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
  sessionId?: string;
  sessionStarted?: boolean;
  sessionGeneration: string;
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
export type AgentScreen = 'agent' | 'dashboard' | 'setup' | 'projects' | 'connections' | 'releases' | 'marketing' | 'monetization' | 'community' | 'operations' | 'history' | 'settings';
export interface AgentRequestContext { screen: AgentScreen; projectId?: string; connectionId?: string }
export interface AgentState { settings: AgentSettings; runtimes: AgentRuntime[]; tasks: AgentTask[] }
