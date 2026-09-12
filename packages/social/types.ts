// Public contracts for the social/community module.
//
// This module is deliberately self-contained: it does not depend on the
// `Provider` enum in `packages/domain` (which the coordinator extends with
// 'x'/'threads'). Instead it exposes a precise `SocialContext` that mirrors
// the `ConnectorContext` shape in `packages/connectors`, so the controller can
// bridge social adapters onto the existing durable queue, credential vault and
// timeline without this worker touching shared registries.

/**
 * Providers implemented here. Steam news is grafted onto the controller's
 * existing `steam` connector, so it is exported as a supplementary adapter and
 * is NOT part of `NEW_SOCIAL_PROVIDERS` (the ids the coordinator must add to
 * the shared `Provider` enum).
 */
export type SocialProvider = 'x' | 'threads' | 'steam';

/** A single outbound HTTP request, classified for the pre-write journal. */
export interface SocialRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** JSON body; sets Content-Type: application/json. */
  json?: unknown;
  /** application/x-www-form-urlencoded body (used by token/publish calls). */
  form?: Record<string, string>;
  body?: BodyInit;
  /**
   * True for requests that change external state. Non-GET requests MUST set
   * this explicitly; the transport refuses to send an unclassified mutation
   * and journals the first classified write before it reaches the network.
   */
  write?: boolean;
  format?: 'json' | 'text';
}

/** Minimal connection view an adapter needs; the controller owns the record. */
export interface SocialConnectionRef {
  id: string;
  provider: SocialProvider;
  /** The owned account id (X user id / Threads user id / Steam app id). */
  accountId: string;
  label?: string;
}

/** Minimal project view; writes are bound to a project by the controller. */
export interface SocialProjectRef {
  appIdentifier: string | null;
}

/**
 * Execution context injected by the controller. Everything that can touch the
 * network, secrets or durable state is injected so adapters stay pure and
 * testable and never reach for ambient credentials or `fetch`.
 */
export interface SocialContext {
  connection: SocialConnectionRef;
  /** Non-secret connection settings only; secrets are read via accessToken. */
  credentials: Record<string, string>;
  project?: SocialProjectRef;
  signal: AbortSignal;
  /** Journals intent (prepared→dispatched) before the first external write. */
  markDispatched(): void;
  /** Durable pre-write journal hook (e.g. Threads container id). */
  checkpoint(data: Record<string, unknown>): void;
  /** Persists rotated tokens back into the vault. */
  saveCredentials(credentials: Record<string, string>): Promise<void>;
  /** Returns a valid bearer access token, refreshing/rotating as needed. */
  accessToken(scopes?: string[]): Promise<string>;
  /** Pinned-origin transport; throws typed errors, never leaks secrets. */
  request<T = Record<string, unknown>>(url: string, options?: SocialRequest): Promise<T>;
  progress(message: string): void;
  now?(): number;
  /**
   * Injectable abortable delay used only by bounded readiness polling (e.g. the
   * Threads container status wait). Provided by the controller/tests for
   * testability and real cancellation; adapters fall back to a signal-aware
   * timer when it is absent. It is NOT driven by user/operation input.
   */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/** A normalized external object stored by the controller (ids/permalinks only). */
export interface SocialResource {
  kind: 'account' | 'post' | 'reply' | 'mention' | 'news';
  externalId: string;
  permalink?: string;
  createdAt?: string;
  text?: string;
  /** Only metrics the official API returns; no invented analytics. */
  metrics?: Record<string, number | string>;
  data: Record<string, unknown>;
}

export interface SocialResult {
  summary: Record<string, unknown>;
  resources?: SocialResource[];
  /** True while an external write has been dispatched but not confirmed. */
  waitingExternal?: boolean;
  /**
   * True when a dispatched write's outcome is unknown (timeout/unreadable
   * response). The controller maps this to `action_required` and MUST NOT
   * auto-retry or repost. No id is guessed from timing or text.
   */
  unresolved?: boolean;
}

export interface SocialCapabilityField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

/** Mirrors domain OperationField for the generic ActionForm. */
export interface SocialOperationField {
  key: string;
  label?: string;
  type?: 'text' | 'money' | 'select' | 'textarea' | 'date';
  required?: boolean;
  hint?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  remove?: boolean;
}

export interface SocialCapability {
  provider: SocialProvider;
  name: string;
  description: string;
  authKind: string;
  fields: SocialCapabilityField[];
  /** Operations that only read account-level data. */
  readOperations: string[];
  /** Operations that create project-owned content. */
  writeOperations: string[];
  operationFields?: Record<string, SocialOperationField[]>;
  scopes: string[];
  setupUrl: string;
  limitations: string[];
}

export interface SocialAdapter {
  capability: SocialCapability;
  execute(operation: string, input: Record<string, unknown>, context: SocialContext): Promise<SocialResult>;
}

/**
 * Persistence surface for the token manager. A `CredentialVault` from
 * `packages/credentials` satisfies this (get/set), so the controller can inject
 * the real vault or a scoped secret store in tests.
 */
export interface SecretStore {
  get(id: string): Promise<Record<string, string>>;
  set(id: string, value: Record<string, string>): Promise<void>;
}
