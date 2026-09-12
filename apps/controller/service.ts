import { createHash, randomUUID } from 'node:crypto';
import { PortableBackups } from './portable-backups.js';
import { importArtifact, importedArtifactPath, assertArtifactApp } from './imported-artifacts.js';
import { observeReleases } from './release-observations.js';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join, relative, dirname } from 'node:path';
import { CredentialVault, TokenManager, GoogleOAuthBroker } from '../../packages/credentials/index.js';
import { DEFAULT_POLICY, type AppState, type ImportedArtifact, type Connection, type ExternalResource, type MetricFact, type Project, type Provider, type ReleasePipeline, type RunnerRegistration, type Run, type Toolchain } from '../../packages/domain/index.js';
import { AppError, object, prohibitSecrets, redact, text } from '../../packages/domain/errors.js';
import { Store } from '../../packages/storage/index.js';
import { inspectProject } from '../../packages/inspection/index.js';
import { createBuildPlan, scanToolchains } from '../../packages/engines/index.js';
import { createSnapshot, executeBuild } from '../runner/index.js';
import { connectors as builtinConnectors } from '../../packages/connectors/index.js';
import { createTransport } from '../../packages/connectors/transport.js';
import { resolveAppleApp } from '../../packages/connectors/store-jsonapi.js';
import { isWriteOperation, type Connector, type ConnectorContext, type ConnectorResult, type VerifiedArtifact } from '../../packages/connectors/types.js';
import { summarizeMetrics } from '../../packages/metrics/index.js';
import { enforceCampaignBudget } from './campaign-budget.js';
import { JobQueue, type ExecutionContext } from './queue.js';
import { credentialValues, enforcePolicy, normalizeError, policyValue, providerValue, targetValue, within } from './validation.js';
import { AutomationScheduler } from './automation.js';
import { BuildKeyManager, type BuildSecuritySelection } from '../../packages/build-credentials/index.js';
import { buildInputHash, prepareSshDependencies, signAndroidArtifact } from '../../packages/build-credentials/build.js';
import { SocialAutomation, isSocialWrite } from './social-automation.js';
import { SocialTokenManager, ThreadsOAuthBroker, XOAuthBroker } from '../../packages/social/index.js';
import { ReleasePipelines } from './pipelines.js';
import { Operations } from './operations.js';
import { remoteBuild } from './remote-build.js';
import { addMedia, mediaArtifact } from './media.js';
import { Preparation } from './preparation.js';
import { ProjectIntegrations } from './project-integrations.js';

const now = () => new Date().toISOString();
const activeStatuses = new Set(['queued', 'running', 'retry_wait']);
const GOOGLE_SCOPES: Partial<Record<Provider, string[]>> = {
  'google-play': ['https://www.googleapis.com/auth/androidpublisher', 'https://www.googleapis.com/auth/devstorage.read_only'],
  'google-ads': ['https://www.googleapis.com/auth/adwords'],
  admob: ['https://www.googleapis.com/auth/admob.readonly', 'https://www.googleapis.com/auth/admob.report'],
};
interface PendingOAuth {
  connection: Connection; credentials: Record<string, string>; expiresAt: number; existing: boolean;
}
interface ConnectionCommit { connection: Connection; marker: string; event: Parameters<Store['addEvent']>[0] }
const commitField = '_appOpsCommit';
const publicCredentialFields = (credentials: Record<string, string>) => Object.keys(credentials).filter(key => key !== commitField);
export interface ServiceOptions {
  connectors?: Connector[]; fetch?: typeof fetch; scanToolchains?: typeof scanToolchains;
  mode?: 'demo' | 'live';
  backupVaultFactory?: (directory: string) => CredentialVault;
}

export class AppService {
  readonly queue: JobQueue;
  readonly scheduler: AutomationScheduler;
  readonly buildKeys: BuildKeyManager;
  readonly social: SocialAutomation;
  readonly pipelines: ReleasePipelines;
  readonly operations: Operations;
  readonly startedAt = now();
  readonly preparation: Preparation;
  readonly integrations: ProjectIntegrations;
  readonly backups: PortableBackups;
  private readonly connectors: Connector[];
  private readonly tokens: TokenManager;
  private readonly broker: GoogleOAuthBroker;
  private readonly socialTokens: SocialTokenManager;
  private readonly socialBrokers: { x: XOAuthBroker; threads: ThreadsOAuthBroker };
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly oauth = new Map<string, PendingOAuth>();
  private readonly socialOAuth = new Map<string, PendingOAuth>();
  private toolchains: Toolchain[] = [];
  private maintenance=false;
  private mutations=0;
  private closing=false;
  enterMutation():()=>void{
    if(this.maintenance||this.closing)throw new AppError('MAINTENANCE_BUSY','백업·복구가 데이터를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.',409);
    this.mutations++;let released=false;return()=>{if(!released){released=true;this.mutations--;}};
  }
  async withMaintenance<T>(task:()=>Promise<T>,retain=false):Promise<T>{
    if(this.maintenance||this.mutations>1||this.locks.size||this.queue.activeCount||this.store.list<Project>('project').some(p=>this.integrations.isBusy(p.id))||this.preparation.isInstalling())throw new AppError('MAINTENANCE_BUSY','진행 중인 작업이나 설치가 끝난 뒤 백업·복구를 시작해 주세요.',409);
    this.maintenance=true;this.queue.pause();this.pipelines.stop();
    let keep=false;
    try{await this.scheduler.stop();await this.operations.stop();const result=await task();keep=retain;return result;}
    finally{if(!keep&&!this.closing){this.maintenance=false;this.queue.start();this.pipelines.start();this.operations.start();this.scheduler.start();}}
  }

  private protectedProjectRoots(): string[] {
    return [this.store.directory, this.vault.directory, this.store.directory + '.tools',this.store.directory+'.recovery',this.store.directory+'.portable-backups'];
  }

  constructor(readonly store: Store, readonly vault: CredentialVault, private readonly options: ServiceOptions = {}) {
    this.connectors = options.connectors ?? builtinConnectors;
    this.buildKeys = new BuildKeyManager(store, vault);
    this.operations = new Operations(store, this, options.mode ?? 'live');
    this.preparation = new Preparation(store, this, options.mode ?? 'live');
    this.integrations = new ProjectIntegrations(store, this, options.mode ?? 'live');
    this.backups = new PortableBackups(store, this, options.mode ?? 'live', options.backupVaultFactory);
    this.tokens = new TokenManager(vault, { fetch: options.fetch });
    this.broker = new GoogleOAuthBroker({ fetch: options.fetch });
    this.socialTokens = new SocialTokenManager(vault, { fetch: options.fetch });
    this.socialBrokers = { x: new XOAuthBroker({ fetch: options.fetch }), threads: new ThreadsOAuthBroker({ fetch: options.fetch }) };
    this.queue = new JobQueue(store, (run, context) => this.execute(run, context));
    this.pipelines = new ReleasePipelines(store, { build: (id, input, pipeline) => this.build(id, input, pipeline), action: (id, input, pipeline) => this.action(id, input, pipeline), inspect: id => this.inspect(id), cancel: id => this.queue.cancel(id) });
    this.social = new SocialAutomation(store, { action: (id, input) => this.action(id, input), supported: (provider, operation) => this.connectors.some(c => c.capability.provider === provider && c.capability.operations.includes(operation)) });
    this.scheduler = new AutomationScheduler(store, { build: (id, input) => this.build(id, input), action: (id, input) => this.action(id, input),
      reconcile: id => this.reconcile(id), socialCycle: () => this.social.cycle(), supported: (provider, operation) => this.connectors.some(c => c.capability.provider === provider && c.capability.operations.includes(operation)) });
  }
  async start(): Promise<void> {
    await this.buildKeys.cleanup();
    await this.recoverConnectionCommits();
    await this.integrations.recover();
    await this.refreshTools();
    this.queue.start();
    this.pipelines.start();
    this.operations.start();
    this.scheduler.start();
    this.store.addEvent({ kind: 'controller.started', message: '운영 제어 서비스를 시작했습니다.' });
  }
  async stop(): Promise<void> { this.closing=true;this.pipelines.stop(); await this.backups.close(); await this.preparation.close(); await this.operations.stop(); await this.scheduler.stop(); await this.queue.stop(); }
  async refreshTools(): Promise<Toolchain[]> {
    this.toolchains = await (this.options.scanToolchains ?? scanToolchains)(this.preparation.toolPaths());
    return this.toolchains;
  }
  saveStoreApp(id: string, input: unknown): Project {
    const project = this.project(id); const data = object(input); prohibitSecrets(data);
    const provider = providerValue(data.provider);
    if (!['google-play','app-store','steam'].includes(provider)) throw new AppError('INVALID_PROVIDER','연결할 스토어를 선택해 주세요.');
    const storeProvider = provider as 'google-play'|'app-store'|'steam';
    const connection = this.connection(text(data.connectionId,'스토어 계정',100));
    if (connection.provider !== provider) throw new AppError('CONNECTION_MISMATCH','스토어와 계정 종류가 다릅니다.');
    if (this.store.runs(100_000).some(r=>r.projectId===id&&!['succeeded','failed','cancelled'].includes(r.status))) throw new AppError('PROJECT_BUSY','진행 중인 프로젝트 작업을 완료하거나 취소한 뒤 앱 연결을 바꿔 주세요.',409);
    const appId = text(data.appId,'스토어 앱 ID',200);
    if (provider === 'google-play' ? !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId) : !/^\d{1,20}$/.test(appId)) throw new AppError('INVALID_APP_ID','스토어 앱 ID 형식을 확인해 주세요.');
    if (provider === 'google-play' && project.appIdentifier && project.appIdentifier !== appId) throw new AppError('APP_MISMATCH','프로젝트 패키지 이름과 같은 Google Play 앱을 연결해 주세요.');
    const updated:Project={...project,storeApps:{...project.storeApps,[storeProvider]:{connectionId:connection.id,appId}},policy:{...project.policy,allowedConnectionIds:[...new Set([...project.policy.allowedConnectionIds,connection.id])]},updatedAt:now()};
    this.store.writeBatch([{kind:'project',id,value:updated}],[],[{projectId:id,kind:'store-app.saved',message:'프로젝트와 스토어 앱을 연결했습니다. 연결 확인 후 배포에 사용합니다.',data:{provider,appId,connectionId:connection.id}}]);
    return updated;
  }
  async verifyStoreApp(id: string, input: unknown): Promise<Project> {
    const data=object(input);const provider=providerValue(data.provider);
    if(!['google-play','app-store','steam'].includes(provider))throw new AppError('INVALID_PROVIDER','확인할 스토어를 선택해 주세요.');
    const key=provider as 'google-play'|'app-store'|'steam';
    const project=this.project(id);const mapping=project.storeApps?.[key];
    if(!mapping)throw new AppError('APP_MAPPING_REQUIRED','프로젝트에서 사용할 스토어 앱을 먼저 연결해 주세요.');
    return this.lock(mapping.connectionId,async()=>{
      const connection=this.connection(mapping.connectionId);
      if(connection.provider!==provider||!this.project(id).policy.allowedConnectionIds.includes(connection.id))throw new AppError('CONNECTION_MISMATCH','프로젝트에 연결된 스토어 계정을 확인해 주세요.');
      if(this.options.mode!=='demo'){
        const context=await this.connectorContext(connection,project);
        try{
          if(provider==='app-store'){
            const app=await resolveAppleApp(context);if(app.id!==mapping.appId)throw new AppError('APP_MISMATCH','조회한 Apple 앱 ID가 저장한 앱과 다릅니다.');
          }else if(provider==='steam'){
            const result=await this.connector(provider).execute('list-apps',{},context);
            const apps=result.summary.apps;
            if(!Array.isArray(apps)||!apps.some(a=>String(object(a).appid)===mapping.appId))throw new AppError('APP_PERMISSION_REQUIRED','이 Steam 파트너 키로 접근할 수 있는 앱인지 확인해 주세요.');
          }else await this.connector(provider).execute('list-releases',{},context);
        }finally{await rm(context.workDirectory,{recursive:true,force:true});}
      }
      const latest=this.project(id);const current=latest.storeApps?.[key];
      if(current?.appId!==mapping.appId||current.connectionId!==mapping.connectionId)throw new AppError('APP_MAPPING_CHANGED','확인 중 앱 연결이 바뀌었습니다. 다시 확인해 주세요.',409);
      const updated:Project={...latest,storeApps:{...latest.storeApps,[key]:{...current,verifiedAt:now()}},updatedAt:now()};
      this.store.writeBatch([{kind:'project',id,value:updated}],[],[{projectId:id,kind:'store-app.verified',message:'연결한 계정에서 프로젝트의 스토어 앱을 확인했습니다.',data:{provider,appId:mapping.appId}}]);return updated;
    });
  }
  private connector(provider: Provider): Connector {
    const connector = this.connectors.find(item => item.capability.provider === provider);
    if (!connector) throw new AppError('PROVIDER_UNAVAILABLE', '아직 실행 가능한 연결 모듈이 없습니다.');
    return connector;
  }
  private project(id: string): Project {
    const project = this.store.get<Project>('project', id);
    if (!project) throw new AppError('NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
    return project;
  }
  private connection(id: string): Connection {
    const connection = this.store.get<Connection>('connection', id);
    if (!connection || connection.status === 'disconnected') throw new AppError('NOT_FOUND', '연결된 계정을 찾을 수 없습니다.', 404);
    return connection;
  }
  private async lock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(callback);
    this.locks.set(id, pending);
    try { return await pending; } finally { if (this.locks.get(id) === pending) this.locks.delete(id); }
  }
  async state(): Promise<AppState> {
    await this.recoverConnectionCommits();
    return {
      projects: this.store.list<Project>('project'), connections: this.store.list<Connection>('connection'),
      runs: this.store.runs(), events: this.store.events(), capabilities: this.connectors.map(c => c.capability),
      toolchains: this.toolchains, resources: this.store.list<ExternalResource>('resource'),
      buildCredentials: this.buildKeys.list(),
      socialSchedules: this.social.listSchedules(),
      pipelines: this.pipelines.list(),
      mediaAssets: this.store.list('media'),
      importedArtifacts: this.store.list('imported-artifact'),
      metrics: summarizeMetrics(this.store.list<MetricFact>('metric')), metricFacts: this.store.list<MetricFact>('metric'), vault: await this.vault.status(),
      runtime: { version: '0.1.0', platform: process.platform, dataDirectory: this.store.directory, startedAt: this.startedAt, mode: this.options.mode ?? 'live', notificationsEnabled: this.operations.settings().notifications },
    };
  }
  async importArtifact(projectId:string,input:unknown):Promise<ImportedArtifact> {
    const release=this.enterMutation();
    try{return await this.lock('artifact:'+projectId,async()=>{
      const project=this.project(projectId),data=object(input);
      const artifact=await importArtifact(this.store.directory,text(data.path,'결과물 경로',4096),targetValue(data.target),project,this.protectedProjectRoots(),attestArtifact);
      try{assertArtifactApp(artifact,this.project(projectId));
        this.store.writeBatch([{kind:'imported-artifact',id:artifact.id,value:artifact}],[],[{projectId,kind:'artifact.imported',message:artifact.name+' 외부 결과물을 가져왔습니다.',data:{artifactId:artifact.id,sha256:artifact.sha256}}]);
        return artifact;
      }catch(error){await rm(join(this.store.directory,'artifacts',artifact.id),{recursive:true,force:true});throw error;}
    });}finally{release();}
  }
  async addProject(input: unknown): Promise<Project> {
    const directory = text(object(input).path, '프로젝트 폴더', 4096);
    const inspection = await inspectProject(directory);
    if (this.protectedProjectRoots().some(root => within(inspection.rootPath, root) || within(root, inspection.rootPath))) {
      throw new AppError('PROTECTED_DIRECTORY', '앱의 운영 데이터 폴더를 포함하는 경로는 프로젝트로 등록할 수 없습니다.');
    }
    const existing = this.store.list<Project>('project').find(p => p.rootPath === inspection.rootPath);
    if (existing) return existing;
    const at = now();
    const project: Project = { ...inspection, id: randomUUID(), createdAt: at, updatedAt: at,
      policy: { ...DEFAULT_POLICY, allowedConnectionIds: [] } };
    this.store.put('project', project.id, project);
    this.store.addEvent({ projectId: project.id, kind: 'project.registered', message: project.name + ' 프로젝트를 등록하고 검사했습니다.' });
    return project;
  }
  async inspect(id: string): Promise<Project> {
    this.integrations.assertAvailable(id);
    const project = this.project(id); const result = await inspectProject(project.rootPath);
    if (result.rootPath !== project.rootPath) throw new AppError('PROJECT_MOVED', '프로젝트 폴더의 실제 경로가 바뀌었습니다. 새 위치를 등록해 주세요.');
    const updated = { ...project, ...result, updatedAt: now() };
    this.store.put('project', id, updated);
    this.store.addEvent({ projectId: id, kind: 'project.inspected', message: `${project.name} 검사: 오류 ${result.findings.filter(f => f.severity === 'error').length}건` });
    return updated;
  }
  async relinkProject(id: string, input: unknown): Promise<Project> {
    const project = this.project(id);
    if (!project.relinkRequired) throw new AppError('PROJECT_ALREADY_LINKED', '이미 연결된 프로젝트입니다.', 409);
    if (this.integrations.isBusy(id)) throw new AppError('PROJECT_BUSY', '프로젝트 작업이 끝난 뒤 연결해 주세요.', 409);
    const result = await inspectProject(text(object(input).path, '원본 프로젝트 폴더', 4096));
    if (this.protectedProjectRoots().some(root => within(result.rootPath, root) || within(root, result.rootPath))) throw new AppError('PROTECTED_DIRECTORY', '운영 데이터와 보관함을 포함하는 폴더는 프로젝트로 연결할 수 없습니다.');
    if (result.engine !== project.engine || project.appIdentifier && result.appIdentifier !== project.appIdentifier) throw new AppError('PROJECT_MISMATCH', '복원한 프로젝트와 엔진·앱 식별자가 일치하는 원본 폴더를 선택해 주세요.', 409);
    if (this.store.list<Project>('project').some(p => p.id !== id && !p.relinkRequired && p.rootPath === result.rootPath)) throw new AppError('PROJECT_DUPLICATE', '다른 프로젝트에 연결된 폴더입니다.', 409);
    const updated: Project = { ...project, ...result, relinkRequired: false, updatedAt: now() };
    this.store.writeBatch([{kind:'project',id,value:updated}],[],[{projectId:id,kind:'project.relinked',message:'복원한 프로젝트의 원본 폴더를 연결하고 검수했습니다. 자동화는 기존의 중지 상태를 유지합니다.'}]);
    return updated;
  }
  async removeProject(id: string): Promise<{ deleted: true }> {
    if (!this.project(id).relinkRequired) this.integrations.assertAvailable(id);
    this.project(id);
    this.requireResolvedEffects(run => run.projectId === id);
    for (const run of this.store.runs(10_000).filter(r => r.projectId === id && activeStatuses.has(r.status))) this.queue.cancel(run.id);
    for (const schedule of this.social.listSchedules().filter(schedule => schedule.projectId === id && schedule.status === 'scheduled')) {
      this.store.put('social-schedule', schedule.id, { ...schedule, status: 'cancelled', updatedAt: now() });
    }
    this.store.remove('project', id);
    this.store.addEvent({ projectId: id, kind: 'project.removed', message: '프로젝트 등록을 해제했습니다. 원본 폴더는 보존했습니다.' });
    return { deleted: true };
  }
  savePolicy(id: string, input: unknown): Project {
    const project = this.project(id); const policy = policyValue(input, this.store.list<Connection>('connection'));
    if (project.relinkRequired && (policy.autoBuild || policy.autoRelease)) throw new AppError('PROJECT_RELINK_REQUIRED', '원본 프로젝트를 연결한 뒤 자동화를 켜 주세요.', 409);
    const updated = { ...project, policy, updatedAt: now() };
    if (policy.autoRelease && !project.policy.autoRelease) this.store.put('settings', 'auto-release-since:' + id, { at: Date.now() });
    this.store.put('project', id, updated);
    this.store.addEvent({ projectId: id, kind: 'policy.changed', message: '프로젝트 자동화 정책을 저장했습니다.', data: { policy } });
    return updated;
  }
  build(id: string, input: unknown, pipeline?: ReleasePipeline): Run {
    this.integrations.assertAvailable(id);
    const project = this.project(id); const data = object(input); const target = targetValue(data.target);
    if (!project.targets.includes(target)) throw new AppError('UNSUPPORTED_TARGET', '검사한 프로젝트에서 이 빌드 대상을 지원하지 않습니다.');
    const profileKey = `build-profile:${id}:${target}`;
    const options: Record<string, unknown> = { ...this.store.get<Record<string, unknown>>('settings', profileKey), target };
    for (const key of ['configuration', 'engineExecutable', 'exportPreset', 'scheme', 'runnerId']) {
      if (data[key] !== undefined && data[key] !== '') options[key] = text(data[key], key, key === 'engineExecutable' ? 4096 : 200);
    }
    if (options.runnerId && !this.store.get<RunnerRegistration>('runner', String(options.runnerId))) throw new AppError('RUNNER_REQUIRED', '등록한 원격 러너를 선택해 주세요.');
    this.store.put('settings', profileKey, options);
    const run = this.store.createRun({ projectId: id, kind: 'build', label: `${project.name} · ${target} 빌드`, input: { ...options, toolPaths: this.preparation.toolPaths(), ...(pipeline ? { pipelineId: pipeline.id } : {}), buildSecurity: this.buildKeys.capture(project) }, pipeline });
    this.queue.tick(); return run;
  }
  async addMedia(input: unknown) { return addMedia(this.store, input); }
  async publish(id: string, input: unknown) { return this.lock('publish:' + id, () => this.pipelines.publish(id, input)); }
  saveBuildSecurity(id: string, input: unknown): Project {
    const project = this.project(id); const buildSecurity = this.buildKeys.policy(input);
    const updated = { ...project, buildSecurity, updatedAt: now() };
    this.store.put('project', id, updated);
    this.store.addEvent({ projectId: id, kind: 'build-security.saved', message: '프로젝트 빌드 키와 SSH 의존성 연결을 저장했습니다.' });
    return updated;
  }
  async saveBuildCredential(input: unknown, id?: string) { return this.lock('build-keys', () => this.buildKeys.save(input, id)); }
  async removeBuildCredential(id: string) { return this.lock('build-keys', () => this.buildKeys.remove(id)); }
  private newConnection(data: Record<string, unknown>, id = randomUUID()): Connection {
    const provider = providerValue(data.provider); const connector = this.connector(provider); const at = now();
    return { id, provider, label: text(data.label, '연결 이름', 100), accountId: text(data.accountId, '계정 ID', 200),
      authKind: connector.capability.authKind, credentialFields: [], status: 'unverified', lastCheckedAt: null, lastError: null,
      createdAt: at, updatedAt: at };
  }
  private validateCredentialFields(connection: Connection, credentials: Record<string, string>, oauth = false): void {
    const capability = this.connector(connection.provider).capability;
    for (const field of capability.fields) {
      if (field.required && !credentials[field.key] && !(oauth && ['refreshToken', 'serviceAccountJson'].includes(field.key))) {
        throw new AppError('INVALID_CREDENTIALS', `${field.label} 항목을 입력해 주세요.`);
      }
    }
    if (GOOGLE_SCOPES[connection.provider] && !oauth && !credentials.serviceAccountJson && !(credentials.clientId && credentials.refreshToken)) {
      throw new AppError('INVALID_CREDENTIALS', 'Google 계정을 브라우저로 연결하거나 서비스 계정 정보를 입력해 주세요.');
    }
  }
  private async commitConnection(connection: Connection, credentials: Record<string, string>, event: ConnectionCommit['event']): Promise<void> {
    const registered = [...this.store.list<Connection>('connection'), ...this.store.list<ConnectionCommit>('connection-commit').map(item => item.connection)];
    if (registered.some(item => item.id !== connection.id && item.provider === connection.provider && item.accountId === connection.accountId)) throw new AppError('CONNECTION_EXISTS', '이미 연결 중이거나 등록된 계정입니다. 기존 연결을 재사용해 주세요.', 409);
    const pending: ConnectionCommit = { connection, marker: randomUUID(), event };
    // The intent contains public metadata only. The matching marker is authenticated
    // inside the ciphertext, so recovery cannot publish metadata for an older secret.
    this.store.put('connection-commit', connection.id, pending);
    await this.vault.set(connection.id, { ...credentials, [commitField]: pending.marker });
    this.store.writeBatch([{ kind: 'connection', id: connection.id, value: connection }], [{ kind: 'connection-commit', id: connection.id }], [event]);
    this.tokens.invalidate(connection.id); this.socialTokens.reset(connection.id);
  }
  private async recoverConnectionCommits(): Promise<void> {
    const entries = this.store.list<ConnectionCommit>('connection-commit');
    if (!entries.length || !(await this.vault.status()).available) return;
    for (const entry of entries) {
      const id = entry.connection.id;
      if (this.locks.has(id)) continue;
      await this.lock(id, async () => {
        const pending = this.store.get<ConnectionCommit>('connection-commit', id); if (!pending) return;
        const current = this.store.get<Connection>('connection', id);
        if (current?.status === 'disconnected') return; // deletion owns its tombstone
        if (await this.vault.has(id)) {
          const credentials = await this.vault.get(id);
          if (credentials[commitField] === pending.marker) {
            this.store.writeBatch([{ kind: 'connection', id, value: pending.connection }], [{ kind: 'connection-commit', id }], [pending.event]);
            this.tokens.invalidate(id); this.socialTokens.reset(id); this.store.resumeConnection(id);
            return;
          }
        }
        this.store.remove('connection-commit', id);
      });
    }
  }
  async addConnection(input: unknown): Promise<Connection> {
    const data = object(input); const connection = this.newConnection(data); const credentials = credentialValues(data.credentials);
    if (this.store.list<Connection>('connection').some(existing => existing.provider === connection.provider && existing.accountId === connection.accountId)) {
      throw new AppError('CONNECTION_EXISTS', '이 서비스 계정은 이미 연결되어 있습니다. 기존 연결을 프로젝트에서 재사용해 주세요.', 409);
    }
    this.validateCredentialFields(connection, credentials);
    connection.credentialFields = publicCredentialFields(credentials);
    await this.lock(connection.id, () => this.commitConnection(connection, credentials, { kind: 'connection.saved', message: connection.label + ' 계정을 연결했습니다.' }));
    return connection;
  }
  async updateCredentials(id: string, input: unknown): Promise<Connection> {
    return this.lock(id, async () => {
      const connection = this.connection(id); const next = credentialValues(object(input).credentials);
      let previous: Record<string, string> = {};
      try { previous = await this.vault.get(id); } catch (error) { if ((error as { code?: string }).code !== 'credential_not_found') throw error; }
      const credentials = { ...previous, ...next }; this.validateCredentialFields(connection, credentials);
      const updated: Connection = { ...connection, credentialFields: publicCredentialFields(credentials), status: 'unverified', lastError: null, updatedAt: now() };
      await this.commitConnection(updated, credentials, { kind: 'connection.repaired', message: connection.label + ' 연결 정보를 갱신했습니다.' });
      return updated;
    });
  }
  async removeConnection(id: string): Promise<{ deleted: true }> {
    // A failed vault cleanup leaves this explicit tombstone so DELETE can resume.
    const connection = this.store.get<Connection>('connection', id);
    if (!connection) throw new AppError('NOT_FOUND', '연결된 계정을 찾을 수 없습니다.', 404);
    this.requireResolvedEffects(run => run.connectionId === id);
    this.store.put('connection', id, { ...connection, status: 'disconnected', updatedAt: now() });
    for (const run of this.store.runs(10_000).filter(r => r.connectionId === id && activeStatuses.has(r.status))) this.queue.cancel(run.id);
    await this.lock(id, async () => {
      await this.vault.remove(id); this.tokens.invalidate(id); this.socialTokens.reset(id);
      this.store.writeBatch([], [{ kind: 'connection', id }, { kind: 'connection-commit', id }]);
      for (const project of this.store.list<Project>('project')) {
        if (project.policy.allowedConnectionIds.includes(id) || project.socialPolicy?.connectionIds.includes(id)) this.store.put('project', project.id, {
          ...project, policy: { ...project.policy, allowedConnectionIds: project.policy.allowedConnectionIds.filter(value => value !== id) }, updatedAt: now(),
          ...(project.socialPolicy ? { socialPolicy: { ...project.socialPolicy, connectionIds: project.socialPolicy.connectionIds.filter(value => value !== id) } } : {}),
        });
      }
      for (const schedule of this.social.listSchedules().filter(schedule => schedule.status === 'scheduled' && schedule.connectionIds.includes(id))) {
        this.store.put('social-schedule', schedule.id, { ...schedule, status: 'cancelled', updatedAt: now() });
      }
      this.store.addEvent({ kind: 'connection.removed', message: connection.label + ' 연결과 보관된 인증 정보를 삭제했습니다.' });
    });
    return { deleted: true };
  }
  private requireResolvedEffects(matches: (run: Run) => boolean): void {
    const unresolved = this.store.runs(100_000).filter(run => matches(run) &&
      ['running', 'waiting_external', 'action_required'].includes(run.status) &&
      ['dispatched', 'action_required'].includes(this.store.effectState(run.id) ?? ''));
    if (unresolved.length) throw new AppError('UNRESOLVED_EXTERNAL_EFFECT',
      '외부 반영을 확인 중인 작업이 있어 아직 삭제할 수 없습니다. 이력에서 상태 확인을 완료해 주세요.', 409,
      { runIds: unresolved.map(run => run.id) });
  }
  async checkConnection(id: string): Promise<Connection> {
    return this.lock(id, async () => {
      const connection = this.connection(id);
      try {
        const context = await this.connectorContext(connection, undefined, undefined);
        try {
          await this.connector(connection.provider).execute('check', {}, context);
        } catch (error) {
          if (normalizeError(error).code !== 'AUTH_REQUIRED' || (!GOOGLE_SCOPES[connection.provider] && !['x', 'threads'].includes(connection.provider))) throw error;
          this.tokens.invalidate(connection.id); this.socialTokens.invalidate(connection.id);
          await this.connector(connection.provider).execute('check', {}, context);
        }
        return this.saveConnectionStatus(id, 'connected', null);
      } catch (error) { this.recordConnectionError(id, error); throw normalizeError(error); }
    });
  }
  private saveConnectionStatus(id: string, status: Connection['status'], lastError: string | null): Connection {
    const connection = this.connection(id);
    const updated = { ...connection, status, lastError, lastCheckedAt: now(), updatedAt: now() };
    this.store.put('connection', id, updated);
    if (status === 'connected') this.store.resumeConnection(id);
    return updated;
  }
  private recordConnectionError(id: string, error: unknown): void {
    const normalized = normalizeError(error);
    if (!['TEMPORARY', 'PERMISSION_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REVOKED', 'VAULT_LOCKED', 'VAULT_UNAVAILABLE', 'KEY_MISSING'].includes(normalized.code)) return;
    const status = ['TEMPORARY', 'VAULT_LOCKED', 'VAULT_UNAVAILABLE'].includes(normalized.code) ? 'recovering' : normalized.code === 'PERMISSION_REQUIRED' ? 'permission_required' : 'action_required';
    try { this.saveConnectionStatus(id, status, normalized.message); } catch {}
  }
  action(id: string, input: unknown, pipeline?: ReleasePipeline): Run {
    const connection = this.connection(id); const data = object(input); const operation = text(data.operation, '작업', 80);
    if (!this.connector(connection.provider).capability.operations.includes(operation)) throw new AppError('UNSUPPORTED_OPERATION', '이 연결에서 지원하지 않는 작업입니다.');
    const project = data.projectId ? this.project(text(data.projectId, '프로젝트 ID')) : undefined;
    if (operation === 'sync-app' && !project) throw new AppError('PROJECT_REQUIRED', '동기화할 프로젝트를 선택해 주세요.');
    const actionInput = object(data.input ?? {}); prohibitSecrets(actionInput);
    if ('artifactPath' in actionInput || 'credentials' in actionInput) throw new AppError('INVALID_INPUT', '작업 입력에 파일 경로나 인증 정보를 직접 지정할 수 없습니다.');
    enforcePolicy(project, connection, operation, actionInput);
    this.social.enforceWrite(project, connection, operation, actionInput);
    this.requireResourceScope(project, connection, operation, actionInput);
    enforceCampaignBudget(project, connection, operation, actionInput, this.store.list<ExternalResource>('resource'), project ? this.store.pendingCampaigns(project.id) : []);
    if (operation === 'upload-build') {
      if(actionInput.importedArtifactId){
        if(actionInput.buildRunId)throw new AppError('INVALID_INPUT','가져온 결과물과 내부 빌드 중 하나만 선택해 주세요.');
        const artifact=this.store.get<ImportedArtifact>('imported-artifact',text(actionInput.importedArtifactId,'결과물 ID',100));
        if(!artifact||!project||artifact.projectId!==project.id)throw new AppError('ARTIFACT_REQUIRED','이 프로젝트에서 가져온 결과물을 선택해 주세요.');
        assertArtifactApp(artifact,project);assertArtifactTarget(artifact.target,connection.provider);
        if(pipeline&&pipeline.target!==artifact.target)throw new AppError('ARTIFACT_MISMATCH','출시 대상과 결과물의 플랫폼이 다릅니다.');
      }else{
        const build = this.store.getRun(text(actionInput.buildRunId, '완료된 빌드 ID'));
        if (!build || build.kind !== 'build' || build.status !== 'succeeded' || build.projectId !== project?.id) throw new AppError('BUILD_REQUIRED', '외부 결과물을 가져오거나 이 프로젝트에서 성공한 빌드를 선택해 주세요.');
      }
    }
    const run = this.store.createRun({ connectionId: id, projectId: project?.id, kind: operation,
      label: `${connection.label} · ${operation}`, input: actionInput, writeEffect: isWriteOperation(operation, connection.provider),
      idempotencyKey: data.idempotencyKey === undefined ? undefined : text(data.idempotencyKey, '요청 키', 128), pipeline });
    this.queue.tick(); return run;
  }
  private requireResourceScope(project: Project | undefined, connection: Connection, operation: string, input: Record<string, unknown>): void {
    if (project && ['create-campaign','create-ad-unit'].includes(operation) && ['google-ads','applovin-ads','applovin-max'].includes(connection.provider)) {
      if (!project.appIdentifier) throw new AppError('APP_IDENTIFIER_REQUIRED', '프로젝트 앱 식별자를 검수한 뒤 설정해 주세요.');
      for (const field of ['packageName','appId']) {
        const candidate = input[field];
        if (candidate === undefined || candidate === project.appIdentifier) continue;
        if (field === 'appId' && connection.provider === 'google-ads' && typeof candidate === 'string' && /^\d{8,12}$/.test(candidate)) continue; // Verified against Apple before dispatch.
        throw new AppError('RESOURCE_MISMATCH', '선택한 프로젝트와 다른 앱의 광고·광고 단위를 만들 수 없습니다.', 409);
      }
    }
    if (project && operation === 'create-creative') {
      const campaign = this.store.list<ExternalResource>('resource').find(item => item.connectionId === connection.id && item.kind === 'campaign' && item.externalId === String(input.externalId));
      if (!campaign || campaign.projectId !== project.id) throw new AppError('RESOURCE_MISMATCH', '선택한 프로젝트의 캠페인을 먼저 동기화해 주세요.', 409);
      return;
    }
    if (project && ['delete-post','hide-reply'].includes(operation)) {
      const target = input.postId ?? input.replyId ?? input.externalId;
      const resource = this.store.list<ExternalResource>('resource').find(item => item.connectionId === connection.id && item.externalId === target && ['post','reply','mention'].includes(item.kind));
      if (!resource || resource.projectId !== project.id) throw new AppError('RESOURCE_MISMATCH', '선택한 프로젝트에 귀속된 게시물·답글을 먼저 동기화해 주세요.', 409);
      if (operation === 'delete-post' && resource.data.owned !== true) throw new AppError('RESOURCE_MISMATCH', '연결된 계정이 작성한 게시물만 삭제할 수 있습니다.', 409);
      return;
    }
    if (!project || !['update-product', 'update-ad-unit'].includes(operation)) return;
    const kind = operation === 'update-product' ? 'product' : 'ad-unit';
    const resource = this.store.list<ExternalResource>('resource').find(item => item.kind === kind && item.connectionId === connection.id && item.externalId === input.externalId);
    if (!resource) throw new AppError('RESOURCE_SYNC_REQUIRED', '변경할 상품·광고 단위를 먼저 동기화해 주세요.');
    const identifier = resource.data.packageName ?? resource.data.bundleId ?? resource.data.appIdentifier;
    if (resource.projectId !== project.id && identifier !== project.appIdentifier) throw new AppError('RESOURCE_MISMATCH', '선택한 프로젝트에 연결된 상품·광고 단위만 변경할 수 있습니다.');
  }
  private async verifyMarketingIdentity(run: Run, connection: Connection, project: Project | undefined, context: ConnectorContext): Promise<void> {
    if (!project || !['create-campaign','create-ad-unit'].includes(run.kind) || !['google-ads','applovin-ads','applovin-max'].includes(connection.provider)) return;
    this.requireResourceScope(project, connection, run.kind, run.input);
    const input = run.input; const credentials = context.credentials;
    const candidate = connection.provider === 'google-ads'
      ? credentials.itunesId || input.itunesId || input.appId || project.appIdentifier
      : String(input.platform ?? credentials.platform).toUpperCase() === 'IOS' && connection.provider === 'applovin-ads'
        ? input.itunesId || credentials.itunesId : undefined;
    if (candidate === undefined || candidate === project.appIdentifier || !/^\d{8,12}$/.test(String(candidate))) return;
    // iTunes IDs differ from bundle IDs. Resolve them through a connected Apple account,
    // then retain only the public, verified mapping for future unattended operations.
    const cache = this.store.get<{bundleId: string; appleAppId: string}>('settings', 'apple-identity:' + project.id);
    if (cache?.bundleId === project.appIdentifier && cache.appleAppId === candidate) return;
    if (this.options.mode === 'demo') return;
    for (const apple of this.store.list<Connection>('connection').filter(item => item.provider === 'app-store' && item.status !== 'disconnected')) {
      let app;
      try { app = await resolveAppleApp(await this.connectorContext(apple, project)); } catch { continue; }
      context.signal.throwIfAborted();
      if (app.id !== candidate) throw new AppError('RESOURCE_MISMATCH', 'iTunes 앱 ID가 선택한 프로젝트의 bundle ID와 다릅니다.', 409);
      this.store.put('settings', 'apple-identity:' + project.id, {bundleId: app.bundleId, appleAppId: app.id});
      return;
    }
    throw new AppError('MISSING_REQUIREMENT', 'iOS 광고 대상 확인을 위해 App Store 계정을 연결해 주세요. 연결된 계정에서 bundle ID와 iTunes ID를 자동 대조합니다.');
  }
  reconcile(id: string): Run {
    const original = this.store.getRun(id);
    if (!original?.connectionId || !isWriteOperation(original.kind, this.connection(original.connectionId).provider) || !['waiting_external', 'action_required'].includes(original.status)) {
      throw new AppError('RECONCILIATION_UNAVAILABLE', '외부 반영을 기다리는 작업만 상태를 다시 확인할 수 있습니다.', 409);
    }
    const pending = this.store.runs(10_000).find(run => run.kind === 'reconcile' && run.input.targetRunId === id && activeStatuses.has(run.status));
    if (pending) return pending;
    const run = this.store.createRun({ connectionId: original.connectionId, projectId: original.projectId,
      kind: 'reconcile', label: original.label + ' 상태 확인', input: { targetRunId: id } });
    this.queue.tick(); return run;
  }
  resolveRun(id: string, input: unknown): Run {
    const data = object(input); prohibitSecrets(data);
    const original = this.store.getRun(id);
    if (!original?.connectionId || !['action_required','waiting_external'].includes(original.status) || !['dispatched','action_required'].includes(this.store.effectState(id) ?? '')) throw new AppError('RECONCILIATION_UNAVAILABLE', '외부 반영을 기다리는 변경 작업만 확인 결과를 기록할 수 있습니다.', 409);
    if (data.confirmed !== true || !['succeeded','failed'].includes(String(data.outcome))) throw new AppError('CONFIRMATION_REQUIRED', '해당 서비스에서 실제 반영 여부를 확인한 결과를 선택해 주세요.');
    const note = text(data.note, '서비스에서 확인한 내용', 1000);
    if (note.length < 5) throw new AppError('INVALID_INPUT', '확인한 내용과 근거를 구체적으로 입력해 주세요.');
    const expected = text(data.expectedUpdatedAt, '확인한 작업 시각', 100);
    if (this.store.runs(100_000).some(run => run.kind === 'reconcile' && run.input.targetRunId === id && activeStatuses.has(run.status))) throw new AppError('RECONCILIATION_BUSY', '진행 중인 상태 확인이 끝난 뒤 기록해 주세요.', 409);
    return this.store.reconcile(id, expected, data.outcome as 'succeeded'|'failed', {
      method:'operator-confirmed', note, checkedAt:now(),
      ...(data.externalId ? {externalId:text(data.externalId,'서비스의 리소스 ID',200)} : {}),
    });
  }
  async beginOAuth(input: unknown, redirectUri: string, id?: string): Promise<{ connectionId: string; authorizationUrl: string }> {
    const data = object(input);
    const connection = id ? this.connection(id) : this.newConnection(data);
    const scopes = GOOGLE_SCOPES[connection.provider];
    if (!scopes) throw new AppError('UNSUPPORTED_AUTH', 'Google OAuth로 연결하는 서비스가 아닙니다.');
    const status = await this.vault.status();
    if (!status.available) throw new AppError('VAULT_UNAVAILABLE', status.reason ?? 'OS 보관함을 사용할 수 없습니다.');
    const credentials = id ? await this.vault.get(id) : credentialValues(data.credentials);
    this.validateCredentialFields(connection, credentials, true);
    const clientId = text(credentials.clientId, 'Google OAuth 클라이언트 ID', 500);
    for (const [state, pending] of this.oauth) if (pending.expiresAt <= Date.now()) this.oauth.delete(state);
    if (this.oauth.size >= 100) throw new AppError('TOO_MANY_AUTH_REQUESTS', '진행 중인 계정 연결을 먼저 완료해 주세요.');
    const begun = this.broker.begin({ clientId, clientSecret: credentials.clientSecret, redirectUri, scopes });
    this.oauth.set(begun.state, { connection, credentials, expiresAt: Date.now() + 600_000, existing: Boolean(id) });
    return { connectionId: connection.id, authorizationUrl: begun.authorizationUrl };
  }
  async beginSocialOAuth(provider: 'x' | 'threads', input: unknown, redirectUri: string, id?: string): Promise<{ connectionId: string; authorizationUrl: string }> {
    const data = object(input);
    const connection = id ? this.connection(id) : this.newConnection({ ...data, provider, accountId: data.accountId || 'auto' });
    if (connection.provider !== provider) throw new AppError('PROVIDER_MISMATCH', '선택한 연결 서비스가 일치하지 않습니다.');
    const status = await this.vault.status(); if (!status.available) throw new AppError('VAULT_UNAVAILABLE', status.reason ?? 'OS 보관함을 사용할 수 없습니다.');
    const credentials = { ...(id ? await this.vault.get(id) : {}), ...(data.credentials ? credentialValues(data.credentials) : {}) };
    for (const [state, pending] of this.socialOAuth) if (pending.expiresAt <= Date.now()) this.socialOAuth.delete(state);
    if (this.socialOAuth.size >= 100) throw new AppError('TOO_MANY_AUTH_REQUESTS', '진행 중인 연결을 먼저 완료해 주세요.');
    const begun = this.socialBrokers[provider].begin({ clientId: text(credentials.clientId, 'OAuth 앱 ID', 500), clientSecret: credentials.clientSecret, redirectUri });
    this.socialOAuth.set(begun.state, { connection, credentials, expiresAt: Date.now() + 600_000, existing: Boolean(id) });
    return { connectionId: connection.id, authorizationUrl: begun.authorizationUrl };
  }
  async completeSocialOAuth(state: string, code: string): Promise<Connection> {
    const pending = this.socialOAuth.get(state); this.socialOAuth.delete(state);
    if (!pending || pending.expiresAt < Date.now()) throw new AppError('OAUTH_EXPIRED', '계정 연결 요청이 만료되었습니다.');
    const provider = pending.connection.provider as 'x' | 'threads';
    const authorized = await this.socialBrokers[provider].complete({ state, code });
    const accountId = text(provider === 'x' ? authorized.userId : authorized.threadsUserId, '인증한 계정 ID', 100);
    return this.lock('social-oauth', () => this.lock(pending.connection.id, async () => {
      if (pending.existing) this.connection(pending.connection.id);
      if (pending.connection.accountId !== 'auto' && pending.connection.accountId !== accountId) throw new AppError('ACCOUNT_MISMATCH', '등록한 계정과 인증한 계정이 다릅니다.');
      const existing = this.store.list<Connection>('connection').find(item => item.provider === provider && item.accountId === accountId && item.id !== pending.connection.id);
      if (existing) throw new AppError('CONNECTION_EXISTS', '이미 연결한 계정입니다. 기존 연결을 재사용해 주세요.', 409);
      const credentials = { ...pending.credentials, ...authorized };
      const connection: Connection = { ...pending.connection, accountId, credentialFields: publicCredentialFields(credentials), status: 'connected', lastError: null, lastCheckedAt: now(), updatedAt: now() };
      await this.commitConnection(connection, credentials, { kind: 'connection.authorized', message: connection.label + ' 채널을 연결했습니다. 이후 인증은 자동으로 갱신합니다.' });
      this.store.resumeConnection(connection.id);
      return connection;
    }));
  }
  async completeOAuth(state: string, code: string): Promise<Connection> {
    const pending = this.oauth.get(state); this.oauth.delete(state);
    if (!pending || pending.expiresAt < Date.now()) throw new AppError('OAUTH_EXPIRED', '계정 연결 요청이 만료되었습니다.');
    const authorized = await this.broker.complete({ state, code });
    return this.lock(pending.connection.id, async () => {
      if (pending.existing) this.connection(pending.connection.id);
      const credentials = { ...pending.credentials, ...authorized };
      delete credentials.serviceAccountJson;
      const connection: Connection = { ...pending.connection, credentialFields: publicCredentialFields(credentials), status: 'unverified', lastError: null, updatedAt: now() };
      await this.commitConnection(connection, credentials, { kind: 'connection.authorized', message: connection.label + ' Google 연결을 완료했습니다. 이후 인증은 자동 갱신합니다.' });
      return connection;
    });
  }
  private async connectorContext(connection: Connection, project?: Project, execution?: ExecutionContext, run?: Run): Promise<ConnectorContext> {
    const credentials = await this.vault.get(connection.id);
    const mapping = project?.storeApps?.[connection.provider as 'google-play'|'app-store'|'steam'];
    if (mapping && mapping.connectionId !== connection.id) throw new AppError('APP_ACCOUNT_MISMATCH','이 프로젝트에 연결한 스토어 계정을 선택해 주세요.',409);
    if (mapping && connection.provider === 'app-store') credentials.appleAppId = mapping.appId;
    if (connection.provider === 'steam' && this.preparation.settings().steamcmd) credentials.steamcmdPath = this.preparation.settings().steamcmd!;
    const providerProject = project && mapping && ['steam','google-play'].includes(connection.provider) ? {...project,appIdentifier:mapping.appId} : project;
    const signal = execution?.signal ?? AbortSignal.timeout(120_000);
    let dispatched = false; let directDispatch=false;
    const markDispatched = () => {
      if (!execution || !run || !isWriteOperation(run.kind, connection.provider)) throw new AppError('UNEXPECTED_WRITE', '조회 작업에서는 외부 상태를 변경할 수 없습니다.');
      signal.throwIfAborted();
      if (project && this.project(project.id).appIdentifier !== project.appIdentifier) throw new AppError('RESOURCE_MISMATCH', '작업 준비 중 프로젝트 앱 식별자가 변경되었습니다. 최신 검수 결과를 확인해 주세요.', 409);
      if (project && JSON.stringify(this.project(project.id).storeApps?.[connection.provider as 'google-play'|'app-store'|'steam']) !== JSON.stringify(mapping)) throw new AppError('APP_MAPPING_CHANGED','작업 준비 중 스토어 앱 연결이 바뀌었습니다.',409);
      enforcePolicy(project ? this.project(project.id) : undefined, this.connection(connection.id), run.kind, run.input);
      this.social.enforceWrite(project ? this.project(project.id) : undefined, this.connection(connection.id), run.kind, run.input, run.id);
      this.requireResourceScope(project ? this.project(project.id) : undefined, this.connection(connection.id), run.kind, run.input);
      enforceCampaignBudget(project ? this.project(project.id) : undefined, this.connection(connection.id), run.kind, run.input,
        this.store.list<ExternalResource>('resource'), project ? this.store.pendingCampaigns(project.id) : [], run.id);
      if (!dispatched) { execution.markDispatched(); dispatched = true; }
    };
    const workDirectory = join(this.store.directory, 'operations', run?.id ?? randomUUID());
    await mkdir(workDirectory, { recursive: true, mode: 0o700 });
    const request = createTransport({ provider: connection.provider, signal, markDispatched,
      markRejected: () => { if(directDispatch)return false; execution?.markRejected?.(); dispatched = false; return true; }, fetch: this.options.fetch });
    return {
      connection, credentials, project: providerProject, signal, workDirectory, markDispatched:()=>{markDispatched();directDispatch=true;},
      checkpoint: data => execution?.checkpoint(data),
      saveCredentials: async values => { await this.vault.set(connection.id, values); this.tokens.invalidate(connection.id); },
      accessToken: scopes => connection.provider === 'x' || connection.provider === 'threads' ? this.socialTokens.getAccessToken({ id: connection.id, provider: connection.provider }) : this.tokens.getAccessToken(connection, scopes),
      request, progress: message => execution?.progress(redact(message, Object.values(credentials))),
    };
  }
  private async execute(run: Run, execution: ExecutionContext): Promise<{ result: Record<string, unknown>; status?: Run['status']; effectResolved?: boolean }> {
    try {
      if (run.kind === 'build') return await this.executeBuild(run, execution);
      if (!run.connectionId) throw new AppError('CONNECTION_REQUIRED', '작업에 연결된 계정이 없습니다.');
      return await this.lock(run.connectionId, async () => {
        const connection = this.connection(run.connectionId!);
        const project = run.projectId ? this.project(run.projectId) : undefined;
        enforcePolicy(project, connection, run.kind, run.input);
        this.social.enforceWrite(project, connection, run.kind, run.input, run.id);
        const context = await this.connectorContext(connection, project, execution, run);
        await this.verifyMarketingIdentity(run, connection, project, context);
        if (run.kind === 'reconcile') return this.executeReconciliation(run, connection, context);
        if (run.kind === 'upload-build') context.artifact = await this.verifiedArtifact(run, connection.provider);
        if (run.kind === 'upload-listing-image') context.artifact = await mediaArtifact(this.store, run.projectId, run.input.mediaAssetId);
        let result: ConnectorResult;
        try {
          result = await this.connector(connection.provider).execute(run.kind, run.input, context);
        } catch (error) {
          // A rejected read may use a stale token. Refresh once, without another user login.
          if (!isWriteOperation(run.kind, connection.provider) && normalizeError(error).code === 'AUTH_REQUIRED' && (GOOGLE_SCOPES[connection.provider] || ['x', 'threads'].includes(connection.provider))) {
            this.tokens.invalidate(connection.id); this.socialTokens.invalidate(connection.id);
            result = await this.connector(connection.provider).execute(run.kind, run.input, context);
          } else throw error;
        }
        execution.signal.throwIfAborted();
        this.connection(connection.id);
        this.persistResult(run, connection, result);
        this.saveConnectionStatus(connection.id, 'connected', null);
        return { result: result.summary, status: result.unresolved ? 'action_required' : result.failed ? 'failed' : result.waitingExternal ? 'waiting_external' : 'succeeded', effectResolved: result.failed === true && !result.unresolved };
      });
    } catch (error) {
      if (run.connectionId) this.recordConnectionError(run.connectionId, error);
      throw normalizeError(error);
    }
  }
  private matchesProjectIdentifier(project: Project, identifier: unknown, provider: Provider): boolean {
    if (project.appIdentifier === identifier) return true;
    if (project.storeApps?.[provider as 'google-play'|'app-store'|'steam']?.appId === identifier) return true;
    if (provider !== 'google-ads') return false;
    const apple = this.store.get<{bundleId:string;appleAppId:string}>('settings', 'apple-identity:' + project.id);
    return !!apple && apple.bundleId === project.appIdentifier && apple.appleAppId === identifier;
  }
  private persistResult(run: Run, connection: Connection, result: ConnectorResult): void {
    prohibitSecrets(result);
    const projects = this.store.list<Project>('project');
    const updates: { kind: 'resource' | 'metric'; id: string; value: ExternalResource | MetricFact }[] = [];
    if (!result.unresolved && !result.failed && ['delete-post','hide-reply'].includes(run.kind)) {
      const target = run.input.postId ?? run.input.replyId ?? run.input.externalId;
      for (const resource of this.store.list<ExternalResource>('resource').filter(item => item.connectionId === connection.id && item.externalId === target && item.projectId === run.projectId)) {
        const hidden = run.input.hide === true || run.input.hide === 'true';
        updates.push({ kind: 'resource', id: resource.id, value: { ...resource, status: run.kind === 'delete-post' ? 'deleted' : hidden ? 'hidden' : 'published', data: { ...resource.data, ...(run.kind === 'hide-reply' ? { hidden } : {}) }, updatedAt: now() } });
      }
    }
    for (const resource of result.resources ?? []) {
      const identity = resource.kind === 'news' ? `${connection.id}:news:${resource.data.appId ?? 'unassigned'}:${resource.externalId}` : connection.id + ':' + resource.kind + ':' + resource.externalId;
      const id = createHash('sha256').update(identity).digest('hex');
      const previous = this.store.get<ExternalResource>('resource', id);
      const identifier = resource.data.packageName ?? resource.data.bundleId ?? resource.data.appIdentifier ?? resource.data.appId;
      const matching = identifier ? projects.filter(project => this.matchesProjectIdentifier(project, identifier, connection.provider)) : [];
      let projectId = matching.length === 1 ? matching[0].id : identifier ? null : previous?.projectId ?? (isWriteOperation(run.kind, connection.provider) ? run.projectId : null);
      let resourceData = matching.length === 1 && resource.kind === 'campaign' ? {...resource.data, appIdentifier: matching[0]!.appIdentifier} : resource.data;
      if (['post', 'reply', 'mention', 'news'].includes(resource.kind)) {
        const channelProjects = projects.filter(project => project.socialPolicy?.connectionIds.includes(connection.id));
        const parentId = resource.data.conversationId ?? resource.data.replyToId;
        const parent = parentId ? this.store.list<ExternalResource>('resource').find(item => item.connectionId === connection.id && item.externalId === parentId && item.projectId) : undefined;
        projectId = identifier ? (matching.length === 1 ? matching[0]!.id : null) : (isSocialWrite(run.kind) ? run.projectId : null) ?? previous?.projectId ?? parent?.projectId ?? (channelProjects.length === 1 ? channelProjects[0]!.id : null);
        resourceData = { ...resource.data, owned: isSocialWrite(run.kind) || previous?.data.owned === true || resource.data.owned === true || resource.data.authorId === connection.accountId || resource.data.is_owned_by_me === true };
      }
      updates.push({ kind: 'resource', id, value: { ...resource, data: resourceData, id, provider: connection.provider,
        connectionId: connection.id, projectId, updatedAt: now() } });
    }
    for (const metric of result.metrics ?? []) {
      const id = createHash('sha256').update([connection.id, metric.kind, metric.sourceId, metric.date, metric.currency].join(':')).digest('hex');
      const matching = metric.appIdentifier ? projects.filter(project => this.matchesProjectIdentifier(project, metric.appIdentifier, connection.provider)) : [];
      updates.push({ kind: 'metric', id, value: { ...metric, id, provider: connection.provider, connectionId: connection.id,
        projectId: matching.length === 1 ? matching[0].id : null, collectedAt: now() } });
    }
    const removals: Array<{kind: 'metric' | 'resource'; id: string}> = (result.metricSourcePrefixes?.length ? this.store.list<MetricFact>('metric') : [])
      .filter(metric => metric.connectionId === connection.id && result.metricSourcePrefixes!.some(prefix => metric.sourceId.startsWith(prefix)))
      .map(metric => ({ kind: 'metric' as const, id: metric.id }));
    if (!result.failed && !result.unresolved && result.resourceSnapshots?.length) {
      const kinds = new Set(result.resourceSnapshots.map(scope => scope.kind));
      const present = new Set(updates.filter(item => item.kind === 'resource').map(item => item.id));
      for (const resource of this.store.list<ExternalResource>('resource')) {
        if (resource.connectionId === connection.id && kinds.has(resource.kind) && !present.has(resource.id)) removals.push({kind:'resource',id:resource.id});
      }
    }
    const observations = !result.failed && !result.unresolved ? observeReleases(this.store,run,connection,updates.filter(item=>item.kind==='resource').map(item=>item.value as ExternalResource),result.summary,now()) : [];
    this.store.writeBatch([...updates,...observations], removals);
  }
  private async executeReconciliation(run: Run, connection: Connection, context: ConnectorContext): Promise<{ result: Record<string, unknown> }> {
    const original = this.store.getRun(text(run.input.targetRunId, '원래 작업 ID'));
    if (!original || original.connectionId !== connection.id || !['waiting_external', 'action_required'].includes(original.status)) {
      throw new AppError('RECONCILIATION_UNAVAILABLE', '원래 작업이 이미 완료되었거나 이 계정의 작업이 아닙니다.');
    }
    let result: ConnectorResult; let status: 'succeeded' | 'failed' | 'waiting_external' | 'action_required' = 'action_required';
    if (connection.provider === 'google-play' && original.result?.editId && (original.kind === 'list-listings' || (['update-listing','upload-listing-image','promote-release'].includes(original.kind) && original.result.phase === 'edit-cleanup-required'))) {
      result = await this.connector(connection.provider).execute('reconcile', { listingsEditId: original.result.editId }, context);
      if (result.summary.failed === true) status = 'failed';
    } else if (original.kind === 'upload-build' && connection.provider === 'google-play') {
      if (!original.result?.versionCode) throw new AppError('RECONCILIATION_REQUIRED', '업로드 버전 응답을 받지 못해 자동으로 반영 여부를 확정할 수 없습니다. Play Console의 빌드 목록을 확인해 주세요.', 409);
      result = await this.connector(connection.provider).execute('list-releases', { track: original.result.track ?? original.input.track ?? 'internal' }, context);
      const release = result.resources?.find(item => (item.data.versionCodes as string[] | undefined)?.includes(String(original.result!.versionCode)));
      if (release?.status === 'RELEASE_LIFECYCLE_STATE_PUBLISHED') status = 'succeeded';
      else if (release?.status === 'RELEASE_LIFECYCLE_STATE_NOT_APPROVED') status = 'failed';
      else if (release) status = 'waiting_external';
      result.summary = { ...result.summary, versionCode: original.result.versionCode, state: release?.status ?? 'NOT_CONFIRMED' };
    } else if (original.kind === 'upload-listing-image' && connection.provider === 'app-store') {
      const appScreenshotId = original.result?.appScreenshotId;
      if (!appScreenshotId) throw new AppError('RECONCILIATION_REQUIRED', '스크린샷 예약 응답을 받지 못했습니다. App Store Connect에서 반영 여부를 확인해 주세요.', 409);
      result = await this.connector(connection.provider).execute('reconcile', { appScreenshotId }, context);
      if (result.summary.failed === true) status = 'failed';
      else if (result.summary.confirmed === true) status = 'succeeded';
      else if (result.waitingExternal) status = 'waiting_external';
    } else if (original.kind === 'upload-build' && connection.provider === 'app-store') {
      const externalId = original.result?.appleBuildUploadId;
      if (!externalId) throw new AppError('RECONCILIATION_REQUIRED', 'Apple 업로드 ID 응답을 받지 못해 자동으로 반영 여부를 확정할 수 없습니다.', 409);
      result = await this.connector(connection.provider).execute('reconcile', { externalId }, context);
      if (result.summary.failed === true) status = 'failed';
      else if (result.summary.confirmed === true) status = 'succeeded';
      else if (result.waitingExternal) status = 'waiting_external';
    } else if (original.kind === 'upload-build' && connection.provider === 'steam') {
      const externalId = original.result?.steamBuildId;
      if (!externalId) throw new AppError('RECONCILIATION_REQUIRED', 'Steam 빌드 ID 응답을 받지 못해 자동으로 반영 여부를 확정할 수 없습니다.', 409);
      result = await this.connector(connection.provider).execute('list-releases', {}, context);
      const release = result.resources?.find(item => item.externalId === String(externalId));
      const track = original.input.track ?? 'internal';
      if (release && (track === 'internal' || release.status === 'live:' + track)) status = 'succeeded';
      else if (release) status = 'waiting_external';
    } else if (original.kind === 'submit-review' && connection.provider === 'app-store') {
      const reviewSubmissionId = original.result?.reviewSubmissionId ?? original.result?.appleReviewSubmissionId;
      if (!reviewSubmissionId) throw new AppError('RECONCILIATION_REQUIRED', '심사 제출 ID를 받지 못했습니다. App Store Connect의 심사 목록을 확인해 주세요.', 409);
      result = await this.connector(connection.provider).execute('reconcile', { reviewSubmissionId }, context);
      if (result.summary.failed === true) status = 'failed';
      else if (result.summary.confirmed === true) status = 'succeeded';
      else if (result.waitingExternal) status = 'waiting_external';
    } else if (original.kind === 'set-live' && connection.provider === 'steam') {
      const buildId = original.result?.steamBuildId ?? original.result?.buildId ?? original.input.buildId;
      result = await this.connector(connection.provider).execute('reconcile', { buildId, branch: original.result?.steamTrack ?? original.result?.branch ?? original.input.branch }, context);
      if (result.summary.confirmed === true) status = 'succeeded';
      else if (result.waitingExternal) status = 'waiting_external';
    } else if (isSocialWrite(original.kind) && connection.provider === 'threads' && original.result?.containerId) {
      result = await this.connector(connection.provider).execute('reconcile', { containerId: original.result.containerId }, context);
      if (result.summary.status === 'PUBLISHED') status = 'succeeded';
      else if (['ERROR', 'EXPIRED'].includes(String(result.summary.status))) status = 'failed';
      else status = 'action_required';
    } else if (original.kind === 'create-product' && connection.provider === 'app-store' && original.result?.failureCode === 'PRICE_POINT_REQUIRED' && original.result.appleInAppPurchaseId) {
      result = await this.connector(connection.provider).execute('list-products', {}, context);
      if (result.resources?.some(item => item.externalId === original.result!.appleInAppPurchaseId)) {
        status = 'failed'; result.summary = { ...result.summary, partialProductCreated: true, externalId: original.result.appleInAppPurchaseId,
          nextAction: '상품은 생성됐지만 요청한 가격이 지원되지 않았습니다. 동기화된 상품에서 사용 가능한 가격을 설정해 주세요.' };
      }
    } else {
      throw new AppError('RECONCILIATION_REQUIRED', '이 변경의 결과를 확정할 응답을 받지 못했습니다. 해당 서비스에서 반영 여부를 확인해 주세요. 중복 변경은 보내지 않습니다.', 409);
    }
    context.signal.throwIfAborted();
    this.persistResult(run, connection, result);
    this.store.reconcile(original.id, original.updatedAt, status, { ...result.summary, checkedAt: now() });
    return { result: { targetRunId: original.id, status, ...result.summary } };
  }
  protected async executeBuild(run: Run, execution: ExecutionContext): Promise<{ result: Record<string, unknown> }> {
    this.integrations.assertAvailable(run.projectId!);
    const project = this.project(run.projectId!); const target = targetValue(run.input.target);
    if (await realpath(project.rootPath) !== project.rootPath) throw new AppError('PROJECT_MOVED', '프로젝트 경로가 변경되었습니다.');
    if (this.protectedProjectRoots().some(root => within(project.rootPath, root) || within(root, project.rootPath))) throw new AppError('PROTECTED_DIRECTORY', '운영 데이터·보관함·관리형 도구를 포함하는 폴더는 빌드할 수 없습니다.');
    const snapshotPath = join(this.store.directory, 'snapshots', run.id);
    const outputPath = join(this.store.directory, 'artifacts', run.id);
    await rm(snapshotPath, { recursive: true, force: true });
    await rm(outputPath, { recursive: true, force: true });
    await mkdir(outputPath, { recursive: true, mode: 0o700 });
    execution.progress('원본을 보존하고 검사할 빌드 스냅샷을 만듭니다.');
    const snapshot = await createSnapshot(project.rootPath, snapshotPath, { excludedRoots: this.protectedProjectRoots() });
    const selection = run.input.buildSecurity as BuildSecuritySelection | undefined ?? { sshDependencies: [] };
    const dependencies = await prepareSshDependencies(this.buildKeys, selection, snapshot.path, join(this.store.directory, 'operations', run.id), this.store.directory, execution.signal);
    const snapshotHash = buildInputHash(snapshot.hash, dependencies);
    execution.checkpoint({ snapshotHash, sourceSnapshotHash: snapshot.hash, snapshotFileCount: snapshot.fileCount, dependencies });
    execution.signal.throwIfAborted();
    let result;
    if (run.input.runnerId) {
      const runner = this.store.get<RunnerRegistration>('runner', String(run.input.runnerId));
      if (!runner) throw new AppError('RUNNER_UNAVAILABLE', '원격 러너 등록이 해제되었습니다.', 409);
      result = await remoteBuild(runner, run, snapshot.path, outputPath, this.vault, execution);
    } else {
      const inspection = await inspectProject(snapshot.path);
      const plan = await createBuildPlan(inspection, { ...run.input, target, outputPath });
      if (plan.findings.some(finding => finding.severity === 'error')) {
        execution.checkpoint({ findings: plan.findings });
        throw new AppError('BUILD_PREREQUISITES', plan.findings.filter(f => f.severity === 'error').map(f => f.message).join(' '), 422);
      }
      result = await executeBuild(plan, { signal: execution.signal, onOutput: output => execution.progress(output.text) });
    }
    if (result.cancelled) throw new AppError('CANCELLED', '빌드 작업을 취소했습니다.');
    if (result.exitCode !== 0 || !result.artifacts.length) throw new AppError('BUILD_FAILED', `빌드가 실패했습니다 (종료 코드 ${result.exitCode}). 작업 로그를 확인해 주세요.`, 422);
    const artifacts: VerifiedArtifact[] = [];
    const signatures: Record<string, unknown>[] = [];
    for (const [index, path] of result.artifacts.entries()) {
      const resolved = await realpath(path);
      if (!within(snapshot.path, resolved) && !within(outputPath, resolved)) throw new AppError('ARTIFACT_ESCAPE', '빌드 결과물이 작업 폴더 밖을 가리킵니다.');
      const destination = within(outputPath, resolved) ? resolved : join(outputPath, `${index}-${basename(resolved)}`);
      if (destination !== resolved) await cp(resolved, destination, { recursive: true, dereference: false, force: false, errorOnExist: true });
      if (target === 'android' && selection.android) {
        execution.progress('등록된 Android 키로 빌드 결과물을 서명하고 인증서를 확인합니다.');
        signatures.push(await signAndroidArtifact(this.buildKeys, selection.android, destination, this.store.directory, execution.signal));
      }
      artifacts.push(await attestArtifact(destination, outputPath));
    }
    execution.checkpoint({ artifacts });
    return { result: { artifacts, signatures, snapshotHash, dependencies, target, startedAt: result.startedAt, finishedAt: result.finishedAt } };
  }
  private async verifiedArtifact(run: Run, provider: Provider): Promise<VerifiedArtifact> {
    if(run.input.importedArtifactId){
      const artifact=this.store.get<ImportedArtifact>('imported-artifact',text(run.input.importedArtifactId,'결과물 ID',100));
      if(!artifact||artifact.projectId!==run.projectId)throw new AppError('ARTIFACT_REQUIRED','이 프로젝트에서 가져온 결과물이 필요합니다.');
      assertArtifactApp(artifact,this.project(run.projectId!));assertArtifactTarget(artifact.target,provider);
      const verified=await attestArtifact(importedArtifactPath(this.store.directory,artifact),join(this.store.directory,'artifacts',artifact.id));
      if(verified.sha256!==artifact.sha256||verified.size!==artifact.size)throw new AppError('ARTIFACT_CHANGED','가져온 이후 결과물이 변경되었습니다. 원본에서 다시 가져와 주세요.');
      return verified;
    }
    const build = this.store.getRun(text(run.input.buildRunId, '빌드 ID'));
    if (!build || build.kind !== 'build' || build.status !== 'succeeded' || build.projectId !== run.projectId) throw new AppError('BUILD_REQUIRED', '이 프로젝트에서 성공한 빌드가 필요합니다.');
    const target = build.result?.target;
    if (provider === 'google-play' && target !== 'android') throw new AppError('ARTIFACT_MISMATCH', 'Google Play에는 Android 빌드가 필요합니다.');
    if (provider === 'app-store' && !['ios', 'macos'].includes(String(target))) throw new AppError('ARTIFACT_MISMATCH', 'App Store에는 Apple 플랫폼 빌드가 필요합니다.');
    if (provider === 'steam' && !['windows', 'macos', 'linux'].includes(String(target))) throw new AppError('ARTIFACT_MISMATCH', 'Steam에는 데스크톱 빌드가 필요합니다.');
    const artifacts = build.result?.artifacts as VerifiedArtifact[] | undefined;
    if (provider === 'steam') {
      if (!artifacts?.length) throw new AppError('ARTIFACT_REQUIRED', 'Steam에 업로드할 빌드 결과물이 없습니다.');
      return stageSteamArtifacts(artifacts, join(this.store.directory, 'artifacts', build.id), join(this.store.directory, 'operations', run.id, 'steam-content'));
    }
    const selected = artifacts?.find(item => provider === 'google-play' ? /\.(aab|apk)$/i.test(item.name) : provider === 'app-store' ? /\.(ipa|pkg)$/i.test(item.name) : true);
    if (!selected) throw new AppError('ARTIFACT_REQUIRED', '업로드할 수 있는 빌드 결과물이 없습니다.');
    const verified = await attestArtifact(selected.path, join(this.store.directory, 'artifacts', build.id));
    if (verified.sha256 !== selected.sha256 || verified.size !== selected.size) throw new AppError('ARTIFACT_CHANGED', '검증 이후 빌드 파일이 변경되었습니다. 다시 빌드해 주세요.');
    return verified;
  }
}

function assertArtifactTarget(target:string,provider:Provider):void {
  const eligible=provider==='google-play'?['android']:provider==='app-store'?['ios']:provider==='steam'?['windows','macos','linux']:[];
  if(!eligible.includes(target))throw new AppError('ARTIFACT_MISMATCH','결과물 플랫폼과 업로드할 스토어가 일치하지 않습니다.');
}

export async function stageSteamArtifacts(artifacts: VerifiedArtifact[], root: string, destination: string): Promise<VerifiedArtifact> {
  const verified: VerifiedArtifact[] = [];
  for (const artifact of artifacts) {
    const item = await attestArtifact(artifact.path, root);
    if (item.sha256 !== artifact.sha256 || item.size !== artifact.size) throw new AppError('ARTIFACT_CHANGED', '검증 이후 빌드 결과물이 변경되었습니다. 다시 빌드해 주세요.');
    verified.push(item);
  }
  if (verified.length === 1 && verified[0].kind === 'directory') return verified[0];
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const artifact of verified) {
    const target = join(destination, relative(root, artifact.path));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await cp(artifact.path, target, { recursive: true, dereference: false, force: false, errorOnExist: true });
    const copied = await attestArtifact(target, destination);
    if (copied.sha256 !== artifact.sha256 || copied.size !== artifact.size) throw new AppError('ARTIFACT_CHANGED', '배포 파일 준비 중 결과물이 변경되었습니다. 다시 빌드해 주세요.');
  }
  return attestArtifact(destination, destination);
}

export async function attestArtifact(path: string, root: string): Promise<VerifiedArtifact> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !within(await realpath(root), await realpath(path))) throw new AppError('ARTIFACT_ESCAPE', '결과물의 경로가 허용된 폴더를 벗어납니다.');
  const hash = createHash('sha256'); let size = 0;
  const visit = async (current: string): Promise<void> => {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new AppError('ARTIFACT_ESCAPE', '결과물에 심볼릭 링크 또는 특수 파일이 있습니다.');
    if (stat.isDirectory()) {
      const names = (await readdir(current)).sort();
      if (!names.length && current === path) throw new AppError('EMPTY_ARTIFACT', '빌드 결과물 폴더가 비어 있습니다.');
      for (const name of names) { hash.update(name + '\0'); await visit(join(current, name)); }
    } else {
      size += stat.size;
      for await (const chunk of createReadStream(current)) hash.update(chunk);
      await chmod(current, stat.mode & 0o111 ? 0o500 : 0o400);
    }
  };
  await visit(path);
  if (!size) throw new AppError('EMPTY_ARTIFACT', '빌드 결과물 파일이 비어 있습니다.');
  return { path, name: basename(path), size, sha256: hash.digest('hex'), kind: info.isDirectory() ? 'directory' : 'file' };
}
