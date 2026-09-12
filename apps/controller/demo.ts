import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CredentialVault } from '../../packages/credentials/index.js';
import { connectors } from '../../packages/connectors/index.js';
import { admobSdkConfig, maxSdkConfig } from '../../packages/connectors/sdk-integration.js';
import { isWriteOperation, type Connector, type ConnectorContext, type ConnectorResult, type ResourceInput } from '../../packages/connectors/types.js';
import { DEFAULT_POLICY, type AppState, type BuildCredential, type ImportedArtifact, type Connection, type ExternalResource, type MetricFact, type Project, type Provider, type Run } from '../../packages/domain/index.js';
import { AppError, object, text } from '../../packages/domain/errors.js';
import { Store } from '../../packages/storage/index.js';
import { importedArtifactPath } from './imported-artifacts.js';
import { targetValue } from './validation.js';
import { AppService, attestArtifact } from './service.js';
import type { ExecutionContext } from './queue.js';

const at = () => new Date().toISOString();
const demoKey = createHash('sha256').update('app-operations-public-demo-only-v1').digest();
const demoKeyProvider = { name: 'demo-synthetic', async getKey() { return Buffer.from(demoKey); }, async setKey() { throw new Error('Demo key is fixed'); } };
export const createDemoVault=(directory:string)=>new CredentialVault(directory,{keyProvider:demoKeyProvider});
const noNetwork: typeof fetch = async () => { throw new AppError('DEMO_NETWORK_BLOCKED', '데모에서는 실제 서비스에 요청하지 않습니다.', 403); };
const idFor = (value: string) => createHash('sha256').update(value).digest('hex');

export class DemoService extends AppService {
  constructor(store: Store, readonly demoRoot: string) {
    super(store, new CredentialVault(join(store.directory, 'credentials'), { keyProvider: demoKeyProvider }), {
      mode: 'demo', fetch: noNetwork, backupVaultFactory: createDemoVault, connectors: connectors.map(connector => demoConnector(connector, store)),
      scanToolchains: async () => ['Godot 4.3', 'Unity 6', 'Unreal 5.5', 'Android SDK', 'Xcode 16', 'SteamCMD'].map(name => ({ name, executable: 'demo', version: name.split(' ').slice(1).join(' '), available: true })),
    });
  }
  async seed(): Promise<void> {
    if (this.store.get('settings', 'demo-seeded')) {
      // Add newly supported synthetic resources without replacing demo user work.
      for (const project of this.store.list<Project>('project').filter(p=>/^demo-project-(godot|unity|unreal|android|ios)$/.test(p.id))) {
        const index=['godot','unity','unreal','android','ios'].indexOf(project.engine);
        for (const connection of this.store.list<Connection>('connection')) for (const resource of seededResources(connection.provider,project,index).filter(r=>r.kind==='creative'||r.kind==='news')) {
          const id=idFor(connection.id+':'+resource.kind+':'+resource.externalId);
          if(!this.store.get('resource',id))this.store.put('resource',id,{...resource,id,connectionId:connection.id,projectId:project.id,provider:connection.provider,updatedAt:at()});
        }
      }
      this.seedAppSync();return;
    }
    const stamp = at();
    const connections: Connection[] = [];
    for (const connector of connectors) {
      const provider = connector.capability.provider;
      const connection: Connection = { id: 'demo-' + provider, provider, label: connector.capability.name + ' · Orbit Games', accountId: provider === 'steam' ? '480' : 'demo-orbit-games', status: 'connected', createdAt: stamp, updatedAt: stamp, lastCheckedAt: stamp, lastError: null, authKind: 'demo', credentialFields: [] };
      this.store.put('connection', connection.id, connection);
      await this.vault.set(connection.id, { demo: 'true' });
      connections.push(connection);
      this.store.put('settings', 'auto-sync:' + connection.id, { at: Date.now() });
    }
    const samples: { name: string; engine: Project['engine']; appIdentifier: string; targets: Project['targets']; version: string }[] = [
      { name: 'Starlight Valley', engine: 'godot', appIdentifier: 'com.orbitgames.starlight', targets: ['android','linux','windows','macos','ios'], version: '4.3' },
      { name: 'Pocket Garden', engine: 'unity', appIdentifier: 'com.orbitgames.garden', targets: ['android','ios','windows','macos'], version: '6000.0' },
      { name: 'Neon Frontier', engine: 'unreal', appIdentifier: '480', targets: ['windows','linux'], version: '5.5' },
      { name: 'Focus Timer', engine: 'android', appIdentifier: 'com.orbitapps.focus', targets: ['android'], version: '35' },
      { name: 'Daily Canvas', engine: 'ios', appIdentifier: 'com.orbitapps.canvas', targets: ['ios'], version: '16' },
    ];
    for (const [index, sample] of samples.entries()) {
      const rootPath = join(this.demoRoot, 'projects', sample.engine);
      await mkdir(rootPath, { recursive: true, mode: 0o700 });
      await writeFile(join(rootPath, 'DEMO-PROJECT.txt'), sample.name + '\nSynthetic project for the App Operations demo.\n');
      const project: Project = { ...sample, id: 'demo-project-' + sample.engine, rootPath, engineVersion: sample.version, findings: [{ code: 'DEMO_PROJECT', severity: 'info', message: '데모 프로젝트입니다. 빌드·게시 결과는 이 데모 공간에만 반영됩니다.' }], inspectedAt: stamp, createdAt: stamp, updatedAt: stamp,
        policy: { ...DEFAULT_POLICY, autoBuild: false, autoRelease: true, allowedConnectionIds: connections.map(c => c.id), maxDailyBudgetMicros: '1000000000', currency: 'USD', allowCampaignWrites: true, allowMonetizationWrites: true },
        buildSecurity: { sshDependencies: [], ...(sample.targets.includes('android') ? { androidKeystoreId: 'demo-key-android' } : {}) },
        socialPolicy: { enabled: true, connectionIds: ['demo-x','demo-threads'], dailyPostLimit: 20, autoReleaseAnnouncements: true, releaseTemplate: '{projectName} 새 버전을 출시했습니다! {platform}', autoReply: false, replyRules: [{ id: 'thanks', matchText: '재미있', replyText: '즐겨주셔서 감사합니다! 다음 업데이트도 기대해 주세요.' }] },
      };
      this.store.put('project', project.id, project);
      this.store.put('settings', 'auto-release-since:' + project.id, { at: Date.now() });
      this.store.put('settings', 'social-enabled-since:' + project.id, { at: Date.now() });
      for (const c of connections) {
        const entries = seededResources(c.provider, project, index);
        for (const resource of entries) {
          const id = idFor(c.id + ':' + resource.kind + ':' + resource.externalId);
          this.store.put('resource', id, { ...resource, id, connectionId: c.id, projectId: project.id, provider: c.provider, updatedAt: stamp });
        }
        if (!['google-ads','applovin-ads','google-play','app-store','steam','applovin-max'].includes(c.provider)) continue;
        for (let day = 0; day < 14; day++) {
          const date = new Date(Date.now() - day * 86_400_000).toISOString().slice(0,10);
          const spend = c.provider === 'google-ads' || c.provider === 'applovin-ads';
          const fact: MetricFact = { id: idFor(c.id + project.id + date), connectionId: c.id, projectId: project.id, provider: c.provider, date, currency: 'USD', kind: spend ? 'spend' : 'revenue', amountMicros: String((spend ? 8_000_000 : 12_000_000) + (14-day) * 230_000 + index * 1_800_000), basis: spend ? 'settled' : c.provider === 'applovin-max' ? 'estimated' : 'proceeds', sourceId: `demo:${project.id}:${date}`, collectedAt: stamp, appIdentifier: project.appIdentifier ?? undefined };
          this.store.put('metric', fact.id, fact);
        }
      }
    }
    this.syntheticKey({ kind: 'android-keystore', label: 'Orbit Android 배포 서명' }, 'demo-key-android');
    this.syntheticKey({ kind: 'ssh', label: 'Orbit 저장소 SSH' }, 'demo-key-ssh');
    this.store.put('settings', 'demo-seeded', { version: 1, createdAt: stamp });
    this.seedAppSync();
    this.store.addEvent({ kind: 'demo.ready', message: '9개 서비스와 5개 프로젝트가 연결된 데모 공간을 준비했습니다.' });
  }
  private seedAppSync():void {
    if(this.store.get('settings','demo-app-sync-seeded'))return;
    for(const project of this.store.list<Project>('project'))for(const connection of this.store.list<Connection>('connection')){
      if(['google-play','app-store','steam'].includes(connection.provider))this.store.put('settings','auto-app-sync:'+connection.id+':'+project.id,{at:Date.now()});
    }
    this.store.put('settings','demo-app-sync-seeded',{at:Date.now()});
  }
  override async importArtifact(projectId:string,input:unknown):Promise<ImportedArtifact> {
    const release=this.enterMutation();
    try{const project=this.store.get<Project>('project',projectId);if(!project)throw new AppError('NOT_FOUND','데모 프로젝트를 선택해 주세요.',404);
      const target=targetValue(object(input).target),format=target==='android'?'aab':target==='ios'?'ipa':'directory';
      const artifact:ImportedArtifact={id:'import-'+randomUUID(),projectId,name:'Demo release'+(format==='directory'?'':'.'+format),target,format,size:0,sha256:'',signature:format==='directory'?'not-applicable':'present',...(['android','ios'].includes(target)?{appIdentifier:project.appIdentifier??undefined,version:'1.2.0',buildVersion:'12'}:{}),createdAt:at()};
      const path=importedArtifactPath(this.store.directory,artifact),root=join(this.store.directory,'artifacts',artifact.id);
      await mkdir(format==='directory'?path:root,{recursive:true,mode:0o700});await writeFile(format==='directory'?join(path,'DEMO-GAME.txt'):path,'Synthetic demo artifact; no user files were read.');
      const verified=await attestArtifact(path,root);artifact.sha256=verified.sha256;artifact.size=verified.size;this.store.put('imported-artifact',artifact.id,artifact);return artifact;
    }finally{release();}
  }
  override async addProject(input: unknown): Promise<Project> {
    const data=object(input); const supplied=text(data.path,'데모 프로젝트',4096);
    const engine=['godot','unity','unreal','android','ios'].find(e=>supplied.toLowerCase().includes(e)) ?? 'godot';
    const prototype=this.store.get<Project>('project','demo-project-'+engine);
    if (!prototype) throw new AppError('DEMO_PROJECT','기본 데모 프로젝트를 먼저 초기화해 주세요.');
    const id='demo-project-'+randomUUID();const rootPath=join(this.demoRoot,'projects',id);
    await mkdir(rootPath,{recursive:true,mode:0o700});
    await writeFile(join(rootPath,'DEMO-PROJECT.txt'),'Synthetic demo source.');
    const project={...prototype,id,name:basename(supplied)||prototype.name,rootPath,appIdentifier:'com.demo.p'+id.replaceAll('-',''),createdAt:at(),updatedAt:at(),inspectedAt:at()};
    this.store.put('project',id,project);this.store.addEvent({projectId:id,kind:'project.registered',message:project.name+' 데모 프로젝트를 등록했습니다.'});return project;
  }
  override async inspect(id: string): Promise<Project> {
    const p = this.store.get<Project>('project', id);
    if (p?.id.startsWith('demo-project-')) {
      const project = { ...p, inspectedAt: at(), updatedAt: at() };
      this.store.put('project', id, project);
      this.store.addEvent({ projectId: id, kind: 'project.inspected', message: '데모 검수 완료: 프로젝트·서명·스토어 연결을 확인했습니다.' });
      return project;
    }
    throw new AppError('DEMO_PROJECT','등록된 데모 프로젝트만 검수할 수 있습니다.');
  }
  override async addConnection(input: unknown): Promise<Connection> {
    const data = object(input);
    if (data.credentials && Object.keys(object(data.credentials)).length) throw new AppError('DEMO_CREDENTIALS', '데모에는 실제 인증 정보를 입력하지 않습니다. 실제 운영 모드에서 연결해 주세요.');
    const provider = text(data.provider, '서비스') as Provider;
    const capability = connectors.find(c => c.capability.provider === provider)?.capability;
    if (!capability) throw new AppError('INVALID_PROVIDER', '서비스를 선택해 주세요.');
    const id = 'demo-' + provider;
    const previous = this.store.get<Connection>('connection', id);
    const connection: Connection = { id, provider, accountId: 'demo-orbit-games', label: data.label ? text(data.label,'연결 이름',100) : capability.name + ' · Orbit Games', status: 'connected', createdAt: previous?.createdAt ?? at(), updatedAt: at(), lastCheckedAt: at(), lastError: null, authKind: 'demo', credentialFields: [] };
    await this.vault.set(id, { demo: 'true' }); this.store.put('connection', id, connection);
    this.store.addEvent({ kind: 'connection.authorized', message: connection.label + ' 데모 계정을 연결했습니다.' });
    return connection;
  }
  override async updateCredentials(id: string, input: unknown): Promise<Connection> {
    if (Object.keys(object(object(input).credentials ?? {})).length) throw new AppError('DEMO_CREDENTIALS', '실제 인증 정보는 실제 운영 모드에 보관해 주세요.');
    return this.checkConnection(id);
  }
  override async beginOAuth(): Promise<{ connectionId: string; authorizationUrl: string }> { throw new AppError('DEMO_AUTH', '데모 연결은 로그인 없이 사용할 수 있습니다. 실제 계정 연결은 실제 운영 모드에서 시작해 주세요.'); }
  override async beginSocialOAuth(): Promise<{ connectionId: string; authorizationUrl: string }> { throw new AppError('DEMO_AUTH', '데모 채널은 로그인 없이 사용할 수 있습니다.'); }
  override async saveBuildCredential(input: unknown, id?: string): Promise<BuildCredential> {
    const data = object(input);
    if (data.credentials && Object.keys(object(data.credentials)).length) throw new AppError('DEMO_CREDENTIALS', '데모 키에는 실제 비밀을 입력하지 않습니다.');
    return this.syntheticKey(data, id);
  }
  private syntheticKey(data: Record<string, unknown>, id = 'demo-key-' + randomUUID()): BuildCredential {
    const previous = this.store.get<BuildCredential>('build-credential', id);
    const kind = previous?.kind ?? data.kind;
    if (kind !== 'ssh' && kind !== 'android-keystore') throw new AppError('INVALID_KEY_KIND','빌드 키 종류를 선택해 주세요.');
    const version = (previous?.version ?? 0) + 1;
    const value: BuildCredential = { id, kind, label: data.label ? text(data.label,'키 이름',100) : previous!.label, version, fingerprint: 'SHA256:' + idFor(id + version).slice(0,43), createdAt: previous?.createdAt ?? at(), updatedAt: at(), details: kind === 'ssh' ? { host: 'git.demo.invalid', port: '22', username: 'git', type: 'ed25519', demo: 'true' } : { alias: 'orbit-release', validFrom: '2025-01-01T00:00:00.000Z', validTo: '2055-01-01T00:00:00.000Z', demo: 'true' } };
    this.store.writeBatch([{ kind:'build-credential', id, value }], [], [{ kind:'build-key.saved', message: value.label + ' 데모 키 ' + version + '버전을 저장했습니다.' }]);
    return value;
  }
  scenario(input: unknown): { scenario: string } {
    const scenario = text(object(input).scenario,'데모 상황');
    if (!['normal','network-error','auth-expired','review-rejected'].includes(scenario)) throw new AppError('INVALID_SCENARIO','지원하는 데모 상황을 선택해 주세요.');
    this.store.put('settings','demo-scenario',{ scenario });
    this.store.addEvent({ kind:'demo.scenario', message:'데모 상황을 변경했습니다: ' + scenario });
    return { scenario };
  }
  protected override async executeBuild(run: Run, execution: ExecutionContext): Promise<{ result: Record<string, unknown> }> {
    const project = this.store.get<Project>('project', run.projectId!);
    if (!project) throw new AppError('NOT_FOUND','프로젝트를 찾을 수 없습니다.',404);
    for (const message of ['프로젝트 구조와 내보내기 설정 검수', '소스 스냅샷 준비', `${project.engine} ${run.input.target} 빌드`, '서명과 결과물 검증']) {
      execution.progress('데모 · ' + message); await delay(180, undefined, { signal: execution.signal });
    }
    const output = join(this.store.directory,'artifacts',run.id);
    await mkdir(output,{ recursive:true, mode:0o700 });
    const ext = run.input.target === 'android' ? 'aab' : run.input.target === 'ios' ? 'ipa' : run.input.target === 'windows' ? 'exe' : 'demo';
    const path = join(output, 'DEMO-' + project.engine + '.' + ext);
    await writeFile(path, JSON.stringify({ demo:true, warning:'Synthetic demo artifact; not an installable or publishable application.', project:project.name, target:run.input.target, runId:run.id }));
    const artifact = await attestArtifact(path, output);
    return { result:{ demo:true, artifacts:[artifact], target:run.input.target, snapshotHash:idFor(project.id+run.id), signatures:project.buildSecurity?.androidKeystoreId ? [{ demo:true, credentialId:project.buildSecurity.androidKeystoreId }] : [], startedAt:run.startedAt, finishedAt:at() } };
  }
}

function seededResources(provider: Provider, project: Project, index: number): ResourceInput[] {
  const base = { appIdentifier: project.appIdentifier, packageName: project.appIdentifier, currency:'USD', demo:true };
  const ext = project.engine + '-' + index;
  if (['google-play','app-store','steam'].includes(provider)) {
    if (provider === 'google-play' && !project.targets.includes('android') || provider === 'app-store' && !project.targets.includes('ios') || provider === 'steam' && !project.targets.some(t=>['windows','linux','macos'].includes(t))) return [];
    const resources:ResourceInput[] = [{ kind:'release', externalId:'demo-release-'+ext, name:project.name+' 1.2.0', status:'published', data:{ ...base, track:'production', branch:'default', version:'1.2.0', versionCode:'12', buildId:'demo-build-'+ext } }, { kind:'product',externalId:'demo-product-'+ext,name:project.name+' Premium',status:'active',data:{ ...base, priceMicros:'4990000', productType:'inapp', description:'프리미엄 기능과 광고 제거' } }];
    if (provider!=='steam') resources.push({kind:'creative',externalId:'demo-listing-'+ext,name:project.name+' 스토어 설명',status:'LIVE',data:{...base,locale:provider==='app-store'?'ko':'ko-KR',language:'ko-KR',appStoreVersionId:'demo-release-'+ext,localizationId:'demo-listing-'+ext,title:project.name,description:'매일 새로운 즐거움을 만나보세요.'}});
    if (provider==='steam') resources.push({kind:'news',externalId:'demo-news-'+ext,name:project.name+' 업데이트 안내',status:'published',data:{...base,appId:project.appIdentifier,text:'새로운 챕터와 성능 개선을 만나보세요.',contents:'업데이트 내역: 신규 콘텐츠, 밸런스 조정, 오류 수정',owned:true,createdAt:at()}});
    return resources;
  }
  if (provider === 'google-ads' || provider === 'applovin-ads') return [{ kind:'campaign',externalId:'demo-campaign-'+ext,name:project.name+' · 글로벌 설치',status:index%2?'PAUSED':'ENABLED',data:{ ...base, dailyBudgetMicros:'20000000', targetCountries:['US','KR','JP'], clicks:1280+index*311, impressions:24800+index*1230, installs:340+index*40, campaignId:'demo-campaign-'+ext, appId:project.appIdentifier } }];
  if (provider === 'admob' || provider === 'applovin-max') return [{ kind:'ad-unit',externalId:'demo-ad-unit-'+ext,name:project.name+' · 보상형 광고',status:'active',data:{ ...base, adFormat:'REWARDED', format:'REWARDED', network:provider, platform:project.targets.includes('android')?'android':'ios', requests:24310, impressions:19820, fillRate:81.53 } }];
  return [{ kind:'post',externalId:'demo-post-'+ext,name:project.name+' 신규 업데이트 소식',status:'published',data:{ ...base,text:project.name+' 새 업데이트가 도착했습니다. 새로운 콘텐츠를 만나보세요!', likes:124+index*27, replies:8+index, views:3840+index*513, owned:true, createdAt:at() } }, { kind:'mention',externalId:'demo-mention-'+ext,name:'다음 업데이트가 기대돼요!',status:'unread',data:{ ...base,text:'정말 재미있어요! 다음 업데이트 일정이 궁금합니다.', authorId:'demo-fan-'+index, authorName:'플레이어 '+(index+1), createdAt:at(), owned:false, conversationId:'demo-post-'+ext } }];
}

function demoConnector(actual: Connector, store: Store): Connector {
  return { capability:{ ...actual.capability, authKind:'demo', fields:[], description:actual.capability.description, limitations:actual.capability.limitations },
    async execute(operation:string,input:Record<string,unknown>,ctx:ConnectorContext):Promise<ConnectorResult> {
      const scenario = store.get<{scenario:string}>('settings','demo-scenario')?.scenario;
      const write = isWriteOperation(operation, ctx.connection.provider);
      if (scenario === 'network-error' && operation !== 'check') { store.put('settings','demo-scenario',{scenario:'normal'}); throw new AppError('TEMPORARY','데모 네트워크 연결이 일시 중단되었습니다. 자동 재시도를 진행합니다.',503); }
      if (scenario === 'auth-expired' && write) { store.put('settings','demo-scenario',{scenario:'normal'}); throw new AppError('AUTH_REVOKED','데모 계정 권한이 만료되었습니다. 계정 연결에서 상태 확인을 누르면 복구됩니다.',401); }
      const all = store.list<ExternalResource>('resource').filter(r=>r.connectionId===ctx.connection.id && (!ctx.project || r.projectId===ctx.project.id));
      const resourceInputs = (items:ExternalResource[]):ResourceInput[] => items.map(({kind,externalId,name,status,data})=>({kind,externalId,name,status,data}));
      if (operation==='check') return { summary:{ demo:true, connected:true, accountId:ctx.connection.accountId } };
      if (operation==='create-app' || ctx.connection.provider==='steam' && ['prepare-news','create-announcement'].includes(operation)) return {unresolved:true,summary:{demo:true,published:false,requiredAction:operation==='create-app'?'최초 앱 등록은 해당 스토어 콘솔에서 진행해 주세요. 등록 이후 이 앱에서 동기화하고 관리합니다.':'Steam 공지는 공개 쓰기 API가 없어 Steamworks에서 게시해야 합니다.',consoleUrl:ctx.connection.provider==='steam'?'https://partner.steamgames.com':ctx.connection.provider==='app-store'?'https://appstoreconnect.apple.com':'https://play.google.com/console'}};
      if (operation==='sdk-integration-config') {
        const units=resourceInputs(all.filter(r=>r.kind==='ad-unit'));
        return {summary:{demo:true,...(ctx.connection.provider==='admob'?admobSdkConfig(units.map(unit=>({...unit,kind:'product' as const,externalId:'demo-admob-app-'+unit.externalId,data:{...unit.data,admobAppId:'demo-ca-app-pub-'+unit.externalId}})),units):maxSdkConfig(units,'demo-public-sdk-key'))}};
      }
      if (!write) {
        const filters:Record<string,ExternalResource['kind'][]> = { 'list-campaigns':['campaign'], 'list-products':['product'], 'list-ad-units':['ad-unit'], 'list-releases':['release'], 'list-posts':['post'], 'list-replies':['reply'], 'list-mentions':['mention'], 'list-news':['news'], 'list-creatives':['creative'], 'list-listings':['creative'] };
        const items=filters[operation]?all.filter(r=>filters[operation]!.includes(r.kind)):all;
        return { summary:{ demo:true, count:items.length, ...(operation==='reconcile'?{status:'PUBLISHED',state:'COMPLETE',confirmed:true}:{}) }, resources:resourceInputs(items) };
      }
      if (operation==='list-listings') {ctx.markDispatched();return{summary:{demo:true,count:all.filter(r=>r.kind==='creative').length},resources:resourceInputs(all.filter(r=>r.kind==='creative'))};}
      // Validate the very same public input requirements the live action form consumes.
      for (const field of actual.capability.operationFields?.[operation] ?? []) if (field.required && !field.remove && (input[field.key]===undefined || input[field.key]==='')) throw new AppError('INVALID_INPUT', `${field.label ?? field.key} 값을 입력해 주세요.`);
      if (operation === 'upload-build' && !ctx.artifact) throw new AppError('ARTIFACT_REQUIRED','완료된 빌드가 필요합니다.');
      if (operation === 'upload-listing-image' && !ctx.artifact) throw new AppError('ARTIFACT_REQUIRED','등록한 이미지가 필요합니다.');
      if ((operation==='reply' || operation==='create-post' && (!input.mediaType || input.mediaType==='TEXT')) && !String(input.text??'').trim()) throw new AppError('INVALID_INPUT','게시할 내용을 입력해 주세요.');
      const identifier = operation==='create-creative'?undefined:input.externalId ?? input.campaignId ?? input.productId ?? input.versionId ?? input.postId ?? input.replyId;
      const previous = identifier ? all.find(r=>r.externalId===identifier) : undefined;
      if ((operation.startsWith('update-') || operation.startsWith('pause-') || operation.startsWith('delete-')) && identifier && !previous) throw new AppError('RESOURCE_NOT_FOUND','선택한 데모 자원을 찾을 수 없습니다. 먼저 동기화해 주세요.',404);
      const rejected=scenario==='review-rejected' && actual.capability.category==='store';
      if (rejected) store.put('settings','demo-scenario',{scenario:'normal'});
      ctx.markDispatched(); ctx.progress('데모 · '+actual.capability.name+' 작업 반영 중');
      await delay(240,undefined,{signal:ctx.signal});
      if (rejected) {
        return { failed:true, summary:{ demo:true,status:'rejected',reason:'데모 심사: 스토어 설명에 지원 연락처를 추가해 주세요.' }, resources:[{ kind:'release',externalId:previous?.externalId??'demo-rejected-'+randomUUID(),name:ctx.project?.name+' 심사',status:'rejected',data:{ demo:true, appIdentifier:ctx.project?.appIdentifier,reason:'지원 연락처가 필요합니다.' } }] };
      }
      const kind:ExternalResource['kind'] = previous?.kind ?? (operation.includes('campaign')?'campaign':operation.includes('product')?'product':operation.includes('ad-unit')?'ad-unit':operation.includes('creative')||['update-listing','upload-listing-image','update-app-info'].includes(operation)?'creative':operation==='reply'?'reply':operation.includes('post')||operation.includes('announcement')?'post':'release');
      const externalId = previous?.externalId ?? (typeof identifier==='string'?identifier:'demo-'+kind+'-'+randomUUID());
      let status = operation==='hide-reply'?(input.hide===true||input.hide==='true'?'hidden':'published'):operation.startsWith('pause-')?'PAUSED':operation.startsWith('delete-')?'deleted':operation.startsWith('activate-')?'ENABLED':operation==='submit-review'?'WAITING_FOR_REVIEW':operation==='upload-build'?(input.track==='production'||input.track==='default'?'published':'testing'):operation==='set-live'?'live:'+String(input.branch??'public'):operation==='create-campaign'?(ctx.connection.provider==='applovin-ads'?'LIVE':'PAUSED'):typeof input.status==='string'?input.status:kind==='post'||kind==='reply'?'published':previous?.status??'active';
      if(ctx.connection.provider==='google-play'&&['upload-build','promote-release'].includes(operation))status='RELEASE_LIFECYCLE_STATE_PUBLISHED';
      if(ctx.connection.provider==='app-store'&&operation==='release-version')status='READY_FOR_DISTRIBUTION';
      const releaseData:Record<string,unknown>={};
      if(kind==='release'&&ctx.connection.provider==='google-play')Object.assign(releaseData,{track:operation==='promote-release'?input.track??'production':input.track??'internal',versionCodes:Array.isArray(input.versionCodes)?input.versionCodes.map(String):[String(input.versionCode??'13')],...(operation==='promote-release'?{requestedVersionCodes:Array.isArray(input.versionCodes)?input.versionCodes.map(String):[String(input.versionCode??'13')]}:{})});
      if(kind==='release'&&ctx.connection.provider==='app-store')Object.assign(releaseData,{appStoreVersionId:input.versionId??previous?.data.appStoreVersionId??externalId,versionString:input.version??previous?.data.versionString??'1.3.0'});
      const data = { ...previous?.data, ...input, demo:true, appIdentifier:ctx.project?.appIdentifier, createdAt:at(), owned:kind==='post'||kind==='reply', ...(kind==='release'?{ buildId:input.buildRunId,version:input.version??'1.3.0',track:input.track??'internal' }:{}),...releaseData };
      ctx.checkpoint({demo:true,externalId,status});
      return { waitingExternal:operation==='submit-review', summary:{ demo:true,externalId,status,track:input.track??'internal',...(operation==='upload-build'&&ctx.connection.provider==='google-play'?{versionCode:String(input.versionCode??'13')}:{}),...(operation==='submit-review'?{reviewSubmissionId:externalId}:{}),...(operation==='create-creative'?{createdCreative:true,campaignId:input.externalId}:{}) }, resources:[{kind,externalId,name:String(input.name??input.title??input.text??previous?.name??(ctx.project?.name+' '+operation)).slice(0,180),status,data}] };
    } };
}
