import type { Capability, Connection, ExternalResource, MetricFact, Project } from '../domain/index.js';

export interface ProviderRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  write?: boolean;
  format?: 'json' | 'text' | 'bytes';
}
export interface VerifiedArtifact { path: string; name: string; size: number; sha256: string; kind?: 'file' | 'directory' }
export interface ConnectorContext {
  connection: Connection;
  credentials: Record<string, string>;
  project?: Project;
  signal: AbortSignal;
  artifact?: VerifiedArtifact;
  workDirectory: string;
  markDispatched(): void;
  checkpoint(data: Record<string, unknown>): void;
  saveCredentials(credentials: Record<string, string>): Promise<void>;
  accessToken(scopes?: string[]): Promise<string>;
  request<T = Record<string, unknown>>(url: string, options?: ProviderRequest): Promise<T>;
  progress(message: string): void;
}
export type ResourceInput = Pick<ExternalResource, 'kind' | 'externalId' | 'name' | 'status' | 'data'>;
export type MetricInput = Pick<MetricFact, 'date' | 'currency' | 'kind' | 'amountMicros' | 'basis' | 'sourceId' | 'appIdentifier'>;
export interface ConnectorResult {
  summary: Record<string, unknown>;
  resources?: ResourceInput[];
  metrics?: MetricInput[];
  waitingExternal?: boolean;
  unresolved?: boolean;
  /** Provider confirmed terminal failure; no unknown external effect remains. */
  failed?: boolean;
  metricSourcePrefixes?: string[];
  /** Only after a complete, unfiltered inventory; never set for mutations or partial pages. */
  resourceSnapshots?: Array<{ kind: ResourceInput['kind'] }>;
}
export interface Connector {
  capability: Capability;
  execute(operation: string, input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult>;
}

export function isWriteOperation(operation: string, provider?: Connection['provider']): boolean {
  if (operation === 'sync-app') return false;
  // Play listing reads create a temporary edit; Apple's JSON API only performs GETs.
  if (operation === 'list-listings' && provider === 'app-store') return false;
  if (['create-app', 'prepare-news', 'create-announcement'].includes(operation)) return false;
  return !['check', 'sync', 'list-apps', 'list-campaigns', 'list-products', 'list-ad-units', 'list-releases', 'reconcile', 'list-posts', 'list-mentions', 'list-replies', 'list-news', 'list-beta-groups', 'list-review-submissions', 'sdk-integration-config'].includes(operation);
}
