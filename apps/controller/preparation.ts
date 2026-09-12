import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, parse } from 'node:path';
import type { AppState, BuildTarget, Project, RunnerRegistration, ToolPathSettings } from '../../packages/domain/index.js';
import { AppError, object, prohibitSecrets, text } from '../../packages/domain/errors.js';
import type { Store } from '../../packages/storage/index.js';
import { TOOL_CATALOG } from '../../packages/setup/catalog.js';
import { ToolInstaller } from '../../packages/setup/installer.js';
import { evaluatePreparation, storeForTarget } from '../../packages/setup/readiness.js';
import type { PreparationPreferences, PreparationState, ToolId, ToolInstall, ToolSettings } from '../../packages/setup/types.js';
import { probeIsolation } from '../runner/sandbox.js';
import { targetValue, within } from './validation.js';
import type { AppService } from './service.js';
import { createBuildPlan } from '../../packages/engines/index.js';

const settingKeys = new Set(['godot','godotData','javaHome','androidSdk','gradleCache','unity','unreal','xcode','steamcmd']);
const fileKeys = new Set(['godot','unity','unreal','xcode','steamcmd']);
const now = () => new Date().toISOString();

/** Saved per-installation paths are trusted host inputs, never mutable process-wide environment variables. */
export class Preparation {
  readonly installer: ToolInstaller;
  private readonly demoJobs: ToolInstall[];
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: Store, private readonly service: AppService, private readonly mode: 'demo'|'live') {
    this.demoJobs = store.get<ToolInstall[]>('settings','demo-tool-installations') ?? [];
    this.installer = new ToolInstaller({ root: store.directory + '.tools', getSettings: () => this.settings(),
      saveSettings: async settings => { await this.saveTools(settings); },
      persist: jobs => store.put('settings','tool-installations',jobs),
      initialJobs: store.get<ToolInstall[]>('settings','tool-installations') ?? [] });
  }
  settings(): ToolSettings { return this.store.get<ToolSettings>('settings','tool-settings') ?? {}; }
  toolPaths(): ToolPathSettings { return { ...this.settings(), managedRoot: this.store.directory + '.tools' }; }
  async close(): Promise<void> { await this.installer.close(); await this.mutation.catch(() => {}); }
  async rescan(): Promise<PreparationState> { await this.service.refreshTools(); return this.state(); }
  async saveTools(input: unknown): Promise<ToolSettings> {
    const apply = async () => {
      const data = object(input); prohibitSecrets(data);
      if (Object.keys(data).some(k => !settingKeys.has(k))) throw new AppError('INVALID_TOOL_SETTINGS','지원하지 않는 도구 설정입니다.');
      const settings = { ...this.settings() };
      for (const [key, value] of Object.entries(data)) {
        if (value === '' || value === null) { delete settings[key as keyof ToolSettings]; continue; }
        const path = text(value,'도구 경로',4096);
        if (!isAbsolute(path)) throw new AppError('INVALID_TOOL_PATH','도구의 절대 경로를 선택해 주세요.');
        if (this.mode === 'demo') { settings[key as keyof ToolSettings] = path; continue; }
        let canonical: string;
        try { canonical = await realpath(path); } catch { throw new AppError('TOOL_PATH_MISSING','선택한 도구 경로를 찾을 수 없습니다.'); }
        if (canonical === parse(canonical).root || canonical === homedir() || within(this.store.directory,canonical) || within(canonical,this.store.directory)) throw new AppError('PROTECTED_TOOL_PATH','운영 데이터나 사용자 홈 전체는 도구 경로로 사용할 수 없습니다.');
        if (this.store.list<Project>('project').some(p => within(p.rootPath,canonical) || within(canonical,p.rootPath))) throw new AppError('PROTECTED_TOOL_PATH','원본 프로젝트와 겹치지 않는 도구 경로를 선택해 주세요.');
        const info = await lstat(canonical);
        if (fileKeys.has(key) ? !info.isFile() : !info.isDirectory()) throw new AppError('INVALID_TOOL_PATH',fileKeys.has(key)?'도구 실행 파일을 선택해 주세요.':'도구의 설치 폴더를 선택해 주세요.');
        settings[key as keyof ToolSettings] = canonical;
      }
      this.store.writeBatch([{kind:'settings',id:'tool-settings',value:settings}],[],[{kind:'setup.tools.saved',message:'엔진·SDK 경로를 저장했습니다. 새 빌드부터 이 설정을 사용합니다.'}]);
      await this.service.refreshTools(); return settings;
    };
    const work = this.mutation.catch(() => {}).then(apply); this.mutation = work; return work;
  }
  preferences(project: Project, target?: BuildTarget): PreparationPreferences {
    const selected = target ?? project.targets[0] ?? 'android';
    return this.store.get<PreparationPreferences>('settings',`preparation:${project.id}:${selected}`) ?? {projectId:project.id,target:selected};
  }
  savePreferences(id: string, input: unknown): PreparationPreferences {
    const project = this.project(id); const data = object(input); prohibitSecrets(data);
    const target = targetValue(data.target);
    if (!project.targets.includes(target)) throw new AppError('UNSUPPORTED_TARGET','프로젝트에서 지원하는 대상을 선택해 주세요.');
    const prefs: PreparationPreferences = {...this.preferences(project,target),projectId:id,target};
    for (const key of ['runnerId','connectionId','engineExecutable','exportPreset','scheme'] as const) {
      if (data[key] === '' || data[key] === null) delete prefs[key];
      else if (data[key] !== undefined) prefs[key] = text(data[key],key,key==='engineExecutable'?4096:200);
    }
    if (prefs.runnerId === 'local') delete prefs.runnerId;
    if (prefs.runnerId && !this.store.get<RunnerRegistration>('runner',prefs.runnerId)) throw new AppError('RUNNER_REQUIRED','등록한 빌드 장비를 선택해 주세요.');
    if (prefs.connectionId) {
      const connection = this.store.get<{provider:string}>('connection',prefs.connectionId);
      if (connection?.provider !== storeForTarget(target)) throw new AppError('CONNECTION_MISMATCH','선택한 배포 대상의 계정을 연결해 주세요.');
    }
    if (data.sdkRequired !== undefined) {
      if (typeof data.sdkRequired !== 'boolean') throw new AppError('INVALID_INPUT','광고·결제 준비 여부를 확인해 주세요.');
      prefs.sdkRequired = data.sdkRequired;
    }
    const profileKey = `build-profile:${id}:${target}`;
    const profile: Record<string,unknown> = {...this.store.get<Record<string,unknown>>('settings',profileKey),target};
    for (const key of ['runnerId','engineExecutable','exportPreset','scheme'] as const) {
      if (prefs[key]) profile[key] = prefs[key]; else delete profile[key];
    }
    this.store.writeBatch([{kind:'settings',id:`preparation:${id}:${target}`,value:prefs},{kind:'settings',id:profileKey,value:profile}],[],[{projectId:id,kind:'setup.project.saved',message:'프로젝트 빌드·배포 준비 설정을 저장했습니다.'}]);
    return prefs;
  }
  startInstall(input: unknown): ToolInstall {
    const data = object(input); const toolId = text(data.toolId,'설치 도구',50) as ToolId;
    if (!TOOL_CATALOG.some(t => t.id === toolId && t.installable)) throw new AppError('MANUAL_INSTALL','공식 설치 프로그램으로 준비한 도구의 경로를 연결해 주세요.');
    if (data.acceptLicense !== undefined && typeof data.acceptLicense !== 'boolean') throw new AppError('INVALID_INPUT','라이선스 확인 값이 올바르지 않습니다.');
    if (this.mode === 'demo') {
      const job:ToolInstall={id:randomUUID(),toolId,status:'succeeded',progress:100,message:'데모 설치와 검증을 완료했습니다.',bytes:0,totalBytes:0,createdAt:now(),updatedAt:now()};
      this.demoJobs.unshift(job);this.store.put('settings','demo-tool-installations',this.demoJobs.slice(0,100)); return job;
    }
    if(data.androidPackages!==undefined&&(!Array.isArray(data.androidPackages)||data.androidPackages.length>50||data.androidPackages.some(v=>typeof v!=='string')))throw new AppError('INVALID_INPUT','설치할 Android SDK 구성 요소를 확인해 주세요.');
    return this.installer.start(toolId,{acceptLicense:data.acceptLicense as boolean|undefined,androidPackages:data.androidPackages as string[]|undefined});
  }
  cancelInstall(id: string) { return this.installer.cancel(id); }
  isInstalling():boolean{return this.installer.list().some(job=>['queued','downloading','verifying','installing'].includes(job.status));}
  async state(existing?: AppState): Promise<PreparationState> {
    const state = existing ?? await this.service.state();
    const isolation = this.mode === 'demo' ? {available:true,backend:'demo'} : await probeIsolation();
    const runners = this.store.list<RunnerRegistration>('runner');
    const preferences = state.projects.flatMap(p => (p.targets.length?p.targets:['android'] as BuildTarget[]).map(t => this.preferences(p,t)));
    const projects = await Promise.all(preferences.map(async p => {
      const project=state.projects.find(project=>project.id===p.projectId)!;
      const plan=this.mode==='live'&&!p.runnerId?await createBuildPlan(project,{...p,outputPath:join(this.store.directory,'preflight',project.id,p.target),toolPaths:this.toolPaths()}):undefined;
      return evaluatePreparation(project,{preferences:p,state,runners,isolation,runnerTools:runners.find(r=>r.id===p.runnerId)?.toolchains,planFindings:plan?.findings});
    }));
    return {mode:this.mode,settings:this.settings(),tools:state.toolchains,catalog:TOOL_CATALOG,installations:this.mode==='demo'?this.demoJobs:this.installer.list(),preferences,projects,isolation};
  }
  private project(id: string): Project { const p=this.store.get<Project>('project',id); if(!p)throw new AppError('NOT_FOUND','등록한 프로젝트가 없습니다.',404);return p; }
}
