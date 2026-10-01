import type { Store } from '../../packages/storage/index.js';
import type { CredentialVault } from '../../packages/credentials/index.js';
import type { AgentSettings } from '../../packages/agent/types.js';
import type { AppState, Connection, MediaAsset, Project, ReleasePipeline, Run, Toolchain } from '../../packages/domain/index.js';
import type { PreparationState } from '../../packages/setup/types.js';
import type { GrowthOperations } from './growth.js';

// Feature controllers declare the collaborators they consume. The composition
// root can satisfy these interfaces without exposing its entire service type.
export interface ProjectAccess {
  readonly store: Store;
  project(id: string): Project;
}
export interface DevelopmentTaskHooks extends ProjectAccess {
  readonly agent: { settings(): AgentSettings };
}
export interface WebDeploymentHooks extends ProjectAccess {}
export interface DevelopmentHooks extends DevelopmentTaskHooks, WebDeploymentHooks {}
export interface PreparationHooks {
  refreshTools(): Promise<Toolchain[]>;
  state(): Promise<AppState>;
}
export interface PortableBackupHooks {
  readonly vault: CredentialVault;
  withMaintenance<T>(task: () => Promise<T>, retain?: boolean): Promise<T>;
}
export interface IntegrationHooks {
  readonly vault: Pick<CredentialVault, 'get'>;
}
export interface OperationsHooks {
  readonly startedAt: string;
  readonly vault: Pick<CredentialVault, 'get' | 'set' | 'remove'>;
  readonly preparation: { state(existing?: AppState): Promise<PreparationState> };
  readonly pipelines: { list(): ReleasePipeline[] };
  state(): Promise<AppState>;
}
export interface AgentHooks {
  readonly store: Store;
  readonly vault: Pick<CredentialVault, 'directory'>;
  readonly queue: { cancel(id: string): void };
  readonly growth: Pick<GrowthOperations, 'context' | 'proposeMandate' | 'createExperiment'> & {
    community: Pick<GrowthOperations['community'], 'saveKnowledge'>;
  };
  enterMutation(): () => void;
  state(): Promise<AppState>;
  action(id: string, input: unknown, pipeline?: ReleasePipeline): Run;
  checkConnection(id: string): Promise<Connection>;
  beginOAuth(input: unknown, redirectUri: string, id?: string): Promise<{ connectionId: string; authorizationUrl: string }>;
  addConnection(input: unknown): Promise<Connection>;
  updateCredentials(id: string, input: unknown): Promise<Connection>;
  saveStoreApp(id: string, input: unknown): Project;
  verifyStoreApp(id: string, input: unknown): Promise<Project>;
  addMedia(input: unknown): Promise<MediaAsset>;
}
