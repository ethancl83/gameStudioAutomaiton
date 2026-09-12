export type IntegrationEngine = 'android' | 'ios' | 'unity' | 'godot' | 'unreal';
export type IntegrationPlatform = 'android' | 'ios';
export type IntegrationProvider = 'admob' | 'applovin-max' | 'play-billing' | 'app-store';
export type IntegrationSeverity = 'error' | 'warning' | 'info';
export type FileAction = 'create' | 'patch' | 'skip';
export type ApplyStatus = 'applied' | 'conflict' | 'failed' | 'unsupported';
export type RollbackStatus = 'rolled_back' | 'noop' | 'conflict' | 'failed';
export type WiringEvent = 'ad.initialize' | 'ad.show' | 'ad.reward' | 'purchase' | 'restore';
export type WiringStatus = 'wired' | 'installed_unwired' | 'missing' | 'conflict' | 'unsupported';
export type ProductType = 'inapp' | 'subs' | 'consumable' | 'nonConsumable';
export type AdFormat = 'BANNER' | 'INTER' | 'REWARD' | 'MREC' | 'APPOPEN' | 'NATIVE';

export interface VerifiedAdUnit {
  adUnitId: string;
  name?: string;
  adFormat?: string;
  platform?: string;
}

export interface VerifiedProduct {
  productId: string;
  name?: string;
  productType?: ProductType | string;
}

export interface IntegrationOptions {
  includePurchases?: boolean;
  /** MAX SDK key is bound at runtime; never accepted or written. */
  maxSdkKeyBound?: boolean;
  dryRun?: boolean;
}

export interface IntegrationRequest {
  projectRoot: string;
  engine: IntegrationEngine;
  platform: IntegrationPlatform;
  provider: IntegrationProvider;
  appId?: string;
  adUnits?: VerifiedAdUnit[];
  products?: VerifiedProduct[];
  options?: IntegrationOptions;
}

export interface IntegrationFinding {
  code: string;
  severity: IntegrationSeverity;
  message: string;
  path?: string;
  fixHint?: string;
}

export interface PlannedFileChange {
  path: string;
  action: FileAction;
  reason: string;
  content?: string;
  previousHash?: string | null;
  contentHash?: string;
}

export interface SdkCatalogEntry {
  id: string;
  artifact: string;
  version: string;
  documentation: string;
  source: string;
  kind: 'ads' | 'iap' | 'plugin';
}

export interface WiringCheck {
  event: WiringEvent;
  status: WiringStatus;
  detail: string;
  path?: string;
}

export interface DetectedSdk {
  id: string;
  evidence: string;
  version?: string;
}

export interface SdkDetection {
  root: string;
  engine: IntegrationEngine | 'unknown';
  engineEvidence: string[];
  sdks: DetectedSdk[];
  findings: IntegrationFinding[];
}

export interface IntegrationPreview {
  previewId: string;
  supported: boolean;
  engine: IntegrationEngine | 'unknown';
  platform: IntegrationPlatform;
  provider: IntegrationProvider;
  catalog: SdkCatalogEntry[];
  plannedChanges: Omit<PlannedFileChange, 'content'>[];
  wiring: WiringCheck[];
  beforeHash: string;
  journalPath: string;
  findings: IntegrationFinding[];
  appId?: string;
  adUnits: VerifiedAdUnit[];
  products: VerifiedProduct[];
  maxSdkKeyBound: boolean;
}

export interface IntegrationApplyResult {
  applyId: string;
  previewId: string;
  status: ApplyStatus;
  afterHash: string;
  backupPath?: string;
  journalPath: string;
  filesWritten: string[];
  wiring: WiringCheck[];
  findings: IntegrationFinding[];
}

export interface IntegrationRollbackResult {
  applyId: string;
  status: RollbackStatus;
  restoredHash?: string;
  findings: IntegrationFinding[];
}

export interface JournalRecord {
  schema: 1;
  previewId: string;
  applyId?: string;
  status: 'previewed' | 'backing_up' | 'applying' | 'committed' | 'failed' | 'rolled_back' | 'rolling_back' | 'rollback_conflict';
  projectRoot: string;
  engine: IntegrationEngine | 'unknown';
  platform: IntegrationPlatform;
  provider: IntegrationProvider;
  beforeHash: string;
  afterHash?: string;
  files: { path: string; action: FileAction; beforeHash: string | null; afterHash?: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateContext {
  root: string;
  engine: IntegrationEngine;
  platform: IntegrationPlatform;
  provider: IntegrationProvider;
  appId?: string;
  adUnits: VerifiedAdUnit[];
  products: VerifiedProduct[];
  maxSdkKeyBound: boolean;
  detection: SdkDetection;
}

export interface TemplatePlan {
  supported: boolean;
  catalog: SdkCatalogEntry[];
  changes: PlannedFileChange[];
  findings: IntegrationFinding[];
  pluginRequired?: { name: string; documentation: string };
}
