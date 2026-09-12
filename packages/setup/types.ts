import type { BuildTarget, EngineKind, Provider, Toolchain } from '../domain/index.js';

export type PreparationStatus = 'ready' | 'required' | 'blocked' | 'checking';
export interface PreparationCheck {
  id:string; label:string; status:PreparationStatus; detail:string;
  action:'project'|'connection'|'tool'|'key'|'runner'|'policy'|'sdk'|'verify'|'none';
  toolId?:ToolId; provider?:Provider; url?:string;
}
export type ToolId='godot'|'godot-templates'|'android-sdk'|'jdk'|'gradle-cache'|'unity'|'unreal'|'xcode'|'steamcmd';
export interface ToolSettings {
  godot?:string; godotData?:string; javaHome?:string; androidSdk?:string;
  gradleCache?:string; unity?:string; unreal?:string; xcode?:string; steamcmd?:string;
}
export interface AndroidLicenseAcceptance {
  id:string; hashes:string[];
}
export interface AndroidPackageRevision {
  id:string; revision:string;
}
/** Persisted Android SDK consent + pinned revisions. Hashes are license text digests, never secrets. */
export interface AndroidSdkReceipt {
  licenses:AndroidLicenseAcceptance[];
  packages:AndroidPackageRevision[];
  recordedAt:string;
}
export interface ToolCatalogItem {
  id:ToolId; name:string; description:string; version?:string; documentation:string;
  installable:boolean; licenseUrl?:string; settingsKey?:keyof ToolSettings;
}
export interface ToolInstall {
  id:string; toolId:ToolId; status:'queued'|'downloading'|'verifying'|'installing'|'succeeded'|'failed'|'cancelled';
  progress:number; message:string; bytes:number; totalBytes:number|null;
  createdAt:string; updatedAt:string; destination?:string;
  receipt?:AndroidSdkReceipt;
}
export interface ProjectPreparation {
  projectId:string; projectName:string; engine:EngineKind; target:BuildTarget;
  status:PreparationStatus; ready:number; total:number; checks:PreparationCheck[]; checkedAt:string;
}
export interface PreparationPreferences {
  projectId:string; target:BuildTarget; runnerId?:string;
  connectionId?:string; engineExecutable?:string; exportPreset?:string; scheme?:string;
  sdkRequired?:boolean;
}
export interface PreparationState {
  mode:'demo'|'live'; settings:ToolSettings; tools:Toolchain[]; catalog:ToolCatalogItem[];
  installations:ToolInstall[]; preferences:PreparationPreferences[];
  projects:ProjectPreparation[]; isolation:{available:boolean;backend:string;reason?:string};
}
