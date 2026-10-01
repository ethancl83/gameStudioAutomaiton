import type { Capability, Connection, ExternalResource, MetricFact, Project } from '../domain/index.js';
import type { AttributionFact } from '../growth/types.js';

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
/** 캠페인·실험 arm·cohort 단위 귀속 fact. 프로젝트·연결·수집 시각은 제어 서비스가 채운다. */
export type AttributionInput = Omit<AttributionFact, 'id' | 'projectId' | 'provider' | 'connectionId' | 'collectedAt'> & { appIdentifier?: string };
export interface ConnectorResult {
  summary: Record<string, unknown>;
  attribution?: AttributionInput[];
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

export { isWriteOperation } from '../domain/operations.js';
