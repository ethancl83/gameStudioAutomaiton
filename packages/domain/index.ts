export type EngineKind = 'godot' | 'unity' | 'unreal' | 'android' | 'ios' | 'unknown';
export type BuildTarget = 'android' | 'ios' | 'windows' | 'macos' | 'linux';
export type Provider = 'google-play' | 'app-store' | 'steam' | 'google-ads' | 'applovin-ads' | 'applovin-max' | 'admob' | 'x' | 'threads';
export type Severity = 'error' | 'warning' | 'info';
export type ConnectionStatus = 'connected' | 'recovering' | 'permission_required' | 'action_required' | 'disconnected' | 'unverified';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'retry_wait' | 'waiting_external' | 'action_required' | 'failed' | 'cancelled';

export interface Finding { code: string; severity: Severity; message: string; path?: string; fixHint?: string }
export interface ProjectInspection {
  rootPath: string; name: string; engine: EngineKind; engineVersion: string | null;
  appIdentifier: string | null; targets: BuildTarget[]; findings: Finding[]; inspectedAt: string;
}
export interface AutomationPolicy {
  autoBuild: boolean; autoRelease: boolean; allowedConnectionIds: string[];
  maxDailyBudgetMicros: string; currency: string; allowCampaignWrites: boolean;
  allowMonetizationWrites: boolean;
}
export interface BuildSshDependency { credentialId: string; repositoryUrl: string; revision: string; relativePath: string }
export interface ProjectBuildSecurity { androidKeystoreId?: string; sshDependencies: BuildSshDependency[] }
export interface BuildCredential {
  id: string; kind: 'ssh' | 'android-keystore'; label: string; version: number; fingerprint: string;
  publicKey?: string; details: Record<string, string>; createdAt: string; updatedAt: string;
}
export interface ProjectSocialPolicy {
  enabled: boolean; connectionIds: string[]; dailyPostLimit: number; autoReleaseAnnouncements: boolean;
  releaseTemplate: string; autoReply: boolean; replyRules: { id: string; matchText: string; replyText: string }[];
}
export interface SocialSchedule {
  id: string; projectId: string; connectionIds: string[]; text: string; scheduledAt: string;
  status: 'scheduled' | 'queued' | 'cancelled'; runIds: Record<string, string>; createdAt: string; updatedAt: string;
}
export interface StoreAppMapping { connectionId: string; appId: string; verifiedAt?: string }
export interface Project extends ProjectInspection { id: string; createdAt: string; updatedAt: string; policy: AutomationPolicy; buildSecurity?: ProjectBuildSecurity; socialPolicy?: ProjectSocialPolicy; storeApps?: Partial<Record<'google-play'|'app-store'|'steam', StoreAppMapping>>; relinkRequired?: boolean }
export interface Toolchain { name: string; executable: string | null; version: string | null; available: boolean; reason?: string }
export interface CommandSpec { executable: string; args: string[]; cwd: string; env?: Record<string, string>; label: string }
export interface BuildPlan {
  engine: EngineKind; target: BuildTarget; sourcePath: string; outputPath: string;
  commands: CommandSpec[]; expectedArtifacts: string[]; findings: Finding[]; managedToolRoot?: string;
}
export interface ToolPathSettings { godot?: string; godotData?: string; javaHome?: string; androidSdk?: string; gradleCache?: string; unity?: string; unreal?: string; xcode?: string; steamcmd?: string; managedRoot?: string }
export interface BuildOptions { toolPaths?: ToolPathSettings; target: BuildTarget; outputPath: string; configuration?: string; engineExecutable?: string; exportPreset?: string; scheme?: string }
export interface BuildOutput { stream: 'stdout' | 'stderr' | 'system'; text: string; at: string }
export interface BuildExecutionResult { exitCode: number; artifacts: string[]; startedAt: string; finishedAt: string; cancelled: boolean }
export interface Snapshot { path: string; hash: string; fileCount: number; totalBytes: number; createdAt: string }

export interface Connection {
  id: string; provider: Provider; label: string; accountId: string; status: ConnectionStatus;
  createdAt: string; updatedAt: string; lastCheckedAt: string | null; lastError: string | null;
  authKind: string; credentialFields: string[];
}
export interface CredentialField { key: string; label: string; secret?: boolean; multiline?: boolean; required?: boolean; placeholder?: string }
export interface OperationField {
  key: string; label?: string; type?: 'text' | 'money' | 'select' | 'textarea' | 'date'; required?: boolean;
  hint?: string; placeholder?: string; options?: { value: string; label: string }[]; remove?: boolean;
}
export interface Capability {
  provider: Provider; name: string; category: 'store' | 'marketing' | 'monetization' | 'community';
  description: string; authKind: string; fields: CredentialField[]; operations: string[];
  setupUrl: string; limitations: string[];
  operationFields?: Record<string, OperationField[]>;
}
export interface Run {
  writeEffect?: boolean;
  id: string; projectId: string | null; connectionId: string | null; kind: string; status: RunStatus;
  label: string; input: Record<string, unknown>; result: Record<string, unknown> | null;
  error: string | null; attempt: number; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface TimelineEvent {
  id: number; projectId: string | null; runId: string | null; kind: string; message: string;
  level: Severity; data: Record<string, unknown> | null; createdAt: string;
}
export interface ExternalResource {
  id: string; connectionId: string; projectId: string | null; provider: Provider;
  kind: 'campaign' | 'product' | 'ad-unit' | 'release' | 'creative' | 'post' | 'reply' | 'mention' | 'news'; externalId: string;
  name: string; status: string; data: Record<string, unknown>; updatedAt: string;
}
export interface MetricFact {
  id: string; connectionId: string; projectId: string | null; provider: Provider;
  date: string; currency: string; kind: 'revenue' | 'spend'; amountMicros: string;
  basis: 'estimated' | 'proceeds' | 'settled'; sourceId: string; collectedAt: string;
  appIdentifier?: string;
}
export interface ReleaseObservation { id:string;projectId:string;connectionId:string;provider:Provider;version:string;published:boolean;publishedAt:string|null }
export interface MetricsSummary { currency: string; revenueMicros: string; spendMicros: string; contributionMicros: string; estimated: boolean; warnings?: string[] }
export interface AppState {
  projects: Project[]; connections: Connection[]; runs: Run[]; events: TimelineEvent[];
  buildCredentials?: BuildCredential[];
  socialSchedules?: SocialSchedule[];
  pipelines?: ReleasePipeline[];
  mediaAssets?: MediaAsset[];
  importedArtifacts?: ImportedArtifact[];
  capabilities: Capability[]; toolchains: Toolchain[]; resources: ExternalResource[];
  metrics: MetricsSummary[]; vault: { available: boolean; backend: string; reason?: string };
  metricFacts?: MetricFact[];
  runtime: { version: string; platform: string; dataDirectory: string; startedAt: string; mode?: 'demo' | 'live'; notificationsEnabled?: boolean };
}
export interface ReleasePipeline {
  restoredPaused?: boolean;
  id: string; projectId: string; connectionId: string; target: BuildTarget;
  status: 'building' | 'uploading' | 'succeeded' | 'failed' | 'action_required' | 'cancelled';
  buildRunId: string; uploadRunId?: string; input: Record<string, unknown>;
  error: string | null; createdAt: string; updatedAt: string;
}
export interface MediaAsset { id:string;projectId:string;name:string;mimeType:string;size:number;sha256:string;createdAt:string }
export interface ImportedArtifact { id:string;projectId:string;name:string;target:BuildTarget;format:'aab'|'apk'|'ipa'|'directory';size:number;sha256:string;appIdentifier?:string;version?:string;buildVersion?:string;signature:'present'|'not-applicable';createdAt:string }
export interface RunnerRegistration {
  id: string; label: string; platform: 'linux' | 'darwin' | 'win32';
  endpoint: string; status: 'unverified' | 'ready' | 'unavailable';
  lastCheckedAt: string | null; lastError: string | null; createdAt: string;
  toolchains?: Toolchain[]; isolationBackend?: string;
}
export interface OperationsSettings { retentionDays: number; autoBackup: boolean; backupHour: number; notifications: boolean }
export interface BackupRecord { id: string; createdAt: string; size: number; projectCount: number; description: string }
export interface ReadinessCheck { id: string; label: string; status: 'ready' | 'action_required' | 'unavailable'; detail: string; destination: string }
export interface OperationsState {
  settings: OperationsSettings; runners: RunnerRegistration[]; backups: BackupRecord[];
  readiness: ReadinessCheck[]; mode: 'demo' | 'live';
}
export interface ApiError { code: string; message: string; details?: unknown }
export interface HistoryPage { runs: Run[]; events: TimelineEvent[]; nextCursor: number | null }
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
export const DEFAULT_POLICY: AutomationPolicy = {
  autoBuild: false, autoRelease: false, allowedConnectionIds: [], maxDailyBudgetMicros: '0', currency: 'USD',
  allowCampaignWrites: false, allowMonetizationWrites: false,
};
export const PROVIDERS: Provider[] = ['google-play','app-store','steam','google-ads','applovin-ads','applovin-max','admob','x','threads'];
