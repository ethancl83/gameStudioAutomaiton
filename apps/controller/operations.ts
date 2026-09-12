import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupRecord, OperationsSettings, OperationsState, Project, ReadinessCheck, RunnerRegistration } from '../../packages/domain/index.js';
import { AppError, object, prohibitSecrets, text } from '../../packages/domain/errors.js';
import type { Store } from '../../packages/storage/index.js';
import type { AppService } from './service.js';
import { policyValue } from './validation.js';

const defaults:OperationsSettings={retentionDays:90,autoBackup:false,backupHour:3,notifications:true};
const at=()=>new Date().toISOString();
const hash=(body:string)=>createHash('sha256').update(body).digest('hex');
interface ConfigurationBackup { schema:1; mode:'demo'|'live'; installation:string; createdAt:string; projects:Project[]; settings:OperationsSettings }
/** Configuration snapshots never rewind the run/effect ledger or overwrite OAuth rotation. */
export class Operations {
  private timer:ReturnType<typeof setInterval>|undefined;
  private active:Promise<unknown>|undefined;
  constructor(private store:Store,private service:AppService,private mode:'demo'|'live') {}
  start():void { this.timer=setInterval(()=>{void this.cycle();},60_000);this.timer.unref(); }
  async stop():Promise<void> { clearInterval(this.timer);await this.active; }
  private installation():string {
    let identity=this.store.get<{id:string}>('settings','installation');
    if (!identity) {identity={id:randomUUID()};this.store.put('settings','installation',identity);}
    return identity.id;
  }
  settings():OperationsSettings { return this.store.get<OperationsSettings>('settings','operations-settings')??{...defaults}; }
  saveSettings(input:unknown):OperationsSettings {
    const data=object(input);
    if (!Number.isInteger(data.retentionDays)||Number(data.retentionDays)<7||Number(data.retentionDays)>3650||!Number.isInteger(data.backupHour)||Number(data.backupHour)<0||Number(data.backupHour)>23||typeof data.autoBackup!=='boolean'||typeof data.notifications!=='boolean') throw new AppError('INVALID_SETTINGS','보존 기간(7~3650일), 백업 시각(0~23시), 알림 설정을 확인해 주세요.');
    const settings:OperationsSettings={retentionDays:Number(data.retentionDays),backupHour:Number(data.backupHour),autoBackup:data.autoBackup,notifications:data.notifications};
    this.store.writeBatch([{kind:'settings',id:'operations-settings',value:settings}],[],[{kind:'operations.settings',message:'운영 설정을 저장했습니다.',data:{...settings}}]);return settings;
  }
  async state():Promise<OperationsState> {
    const state=await this.service.state();
    const preparation=await this.service.preparation.state(state);
    const readiness:ReadinessCheck[]=preparation.projects.map(p=>({id:p.projectId+':'+p.target,label:p.projectName+' · '+p.target,status:p.status==='ready'?'ready':'action_required',detail:`${p.ready}/${p.total} 준비 완료. `+p.checks.filter(c=>c.status!=='ready').map(c=>c.label).join(', '),destination:'setup'}));
    if(!readiness.length)readiness.push({id:'projects',label:'프로젝트 등록',status:'action_required',detail:'운영할 프로젝트 폴더를 등록해 주세요.',destination:'projects'});
    const local:RunnerRegistration={id:'local',label:this.mode==='demo'?'데모 로컬 러너':'이 컴퓨터',platform:process.platform as RunnerRegistration['platform'],endpoint:'local',status:preparation.isolation.available?'ready':'unavailable',lastCheckedAt:at(),lastError:preparation.isolation.reason??null,createdAt:this.service.startedAt,toolchains:state.toolchains,isolationBackend:preparation.isolation.backend};
    return {settings:this.settings(),runners:[local,...this.store.list<RunnerRegistration>('runner')],backups:await this.backups(),readiness,mode:this.mode};
  }
  private assertIdle():void {
    if (this.store.runs(100_000).some(r=>['queued','running','retry_wait','waiting_external','action_required'].includes(r.status))||this.service.pipelines.list().some(p=>['building','uploading','action_required'].includes(p.status))) throw new AppError('OPERATIONS_BUSY','진행 중인 작업을 완료하거나 취소한 뒤 설정을 복구해 주세요.',409);
  }
  async backup(input:unknown={}):Promise<BackupRecord> {
    const data=object(input);const description=data.description?text(data.description,'백업 설명',200):'프로젝트·정책·운영 설정 백업';
    const createdAt=at();const id=randomUUID();
    const snapshot:ConfigurationBackup={schema:1,mode:this.mode,installation:this.installation(),createdAt,projects:this.store.list<Project>('project'),settings:this.settings()};
    const payload=JSON.stringify(snapshot);prohibitSecrets(snapshot);
    const record:BackupRecord={id,createdAt,size:Buffer.byteLength(payload),projectCount:snapshot.projects.length,description};
    const root=join(this.store.directory,'backups');await mkdir(root,{recursive:true,mode:0o700});
    const tmp=join(root,id+'.tmp');
    try {await writeFile(tmp,JSON.stringify({record,sha256:hash(payload),payload}),{mode:0o600,flag:'wx'});await rename(tmp,join(root,id+'.json'));}
    finally {await rm(tmp,{force:true});}
    this.store.addEvent({kind:'backup.created',message:'프로젝트·정책·운영 설정을 백업했습니다.',data:{backupId:id,projectCount:record.projectCount}});return record;
  }
  private async readBackup(id:string):Promise<{record:BackupRecord;snapshot:ConfigurationBackup}> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError('INVALID_BACKUP','백업을 선택해 주세요.');
    let parsed:Record<string,unknown>;
    try {const path=join(this.store.directory,'backups',id+'.json');if((await stat(path)).size>16*1024*1024)throw new Error('size');parsed=object(JSON.parse(await readFile(path,'utf8')));}
    catch {throw new AppError('BACKUP_INVALID','백업 파일을 읽을 수 없습니다.',422);}
    const payload=text(parsed.payload,'백업 내용',16*1024*1024);
    if(hash(payload)!==parsed.sha256)throw new AppError('BACKUP_DAMAGED','백업 내용이 변경되었거나 손상되었습니다.',422);
    const snapshot=object(JSON.parse(payload)) as unknown as ConfigurationBackup;
    if(snapshot.schema!==1||snapshot.mode!==this.mode||snapshot.installation!==this.installation()||!Array.isArray(snapshot.projects))throw new AppError('BACKUP_MISMATCH','이 운영 공간에서 생성한 백업만 복구할 수 있습니다.',409);
    prohibitSecrets(snapshot);
    return {record:parsed.record as BackupRecord,snapshot};
  }
  async backups():Promise<BackupRecord[]> {
    let names:string[];try{names=await readdir(join(this.store.directory,'backups'));}catch{return [];}
    const list:BackupRecord[]=[];
    for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){try{list.push((await this.readBackup(name.slice(0,-5))).record);}catch{}}
    return list.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async restore(input:unknown):Promise<{restored:true;projectCount:number;automationsPaused:true}> {
    const id=text(object(input).backupId,'백업 ID',100);const {snapshot}=await this.readBackup(id);
    const current=await this.service.state();const projects:Project[]=[];
    for(const item of snapshot.projects){
      const p=object(item) as unknown as Project;
      if(typeof p.id!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(p.id)||typeof p.rootPath!=='string'||!Array.isArray(p.targets)||!['godot','unity','unreal','android','ios','unknown'].includes(p.engine))throw new AppError('BACKUP_INVALID','백업의 프로젝트 형식을 확인해 주세요.',422);
      const allowed=p.policy.allowedConnectionIds.filter(id=>current.connections.some(c=>c.id===id&&c.status!=='disconnected'));
      const policy=policyValue({...p.policy,allowedConnectionIds:allowed,autoBuild:false,autoRelease:false,allowCampaignWrites:false,allowMonetizationWrites:false},current.connections);
      const security=p.buildSecurity?{...p.buildSecurity,androidKeystoreId:current.buildCredentials?.some(k=>k.id===p.buildSecurity?.androidKeystoreId)?p.buildSecurity.androidKeystoreId:undefined,sshDependencies:p.buildSecurity.sshDependencies.filter(d=>current.buildCredentials?.some(k=>k.id===d.credentialId))}:undefined;
      projects.push({...p,policy,buildSecurity:security,socialPolicy:p.socialPolicy?{...p.socialPolicy,enabled:false}:undefined,updatedAt:at()});
    }
    // All validation and I/O precede this final synchronous idle gate + transaction.
    const settings=object(snapshot.settings);
    if(!Number.isInteger(settings.retentionDays)||Number(settings.retentionDays)<7||Number(settings.retentionDays)>3650||!Number.isInteger(settings.backupHour)||Number(settings.backupHour)<0||Number(settings.backupHour)>23||typeof settings.notifications!=='boolean')throw new AppError('BACKUP_INVALID','백업 운영 설정이 올바르지 않습니다.',422);
    this.assertIdle();
    this.store.writeBatch([...projects.map(p=>({kind:'project' as const,id:p.id,value:p})),{kind:'settings' as const,id:'operations-settings',value:{...settings,autoBackup:false}}],[],[{kind:'backup.restored',message:'프로젝트 설정을 복구했습니다. 기존 계정·키·작업 이력을 보존하고 자동 실행은 껐습니다.',data:{backupId:id,projectCount:projects.length}}]);
    return {restored:true,projectCount:projects.length,automationsPaused:true};
  }
  async registerRunner(input:unknown):Promise<RunnerRegistration> {
    const data=object(input);const label=text(data.label,'러너 이름',100);const platform=text(data.platform,'운영체제',10) as RunnerRegistration['platform'];
    if(!['linux','darwin','win32'].includes(platform))throw new AppError('INVALID_RUNNER','러너 운영체제를 선택해 주세요.');
    const endpoint=runnerEndpoint(data.endpoint);
    const previous=this.store.list<RunnerRegistration>('runner').find(r=>r.endpoint===endpoint);
    if(previous)throw new AppError('RUNNER_EXISTS','이미 등록한 러너입니다.',409);
    const runner:RunnerRegistration={id:randomUUID(),label,platform,endpoint,status:'unverified',lastCheckedAt:null,lastError:null,createdAt:at()};
    if(this.mode==='demo' && data.pairingToken)throw new AppError('DEMO_CREDENTIALS','데모에는 실제 러너 연결 코드를 입력하지 않습니다.');
    if(this.mode==='live' && !data.pairingToken)throw new AppError('PAIRING_REQUIRED','러너의 최초 연결 코드를 입력해 주세요.');
    if(data.pairingToken!==undefined){const token=text(data.pairingToken,'러너 연결 코드',500);await this.service.vault.set('runner-'+runner.id,{pairingToken:token});}
    this.store.writeBatch([{kind:'runner',id:runner.id,value:runner}],[],[{kind:'runner.registered',message:label+' 러너를 등록했습니다.'}]);return runner;
  }
  async checkRunner(id:string):Promise<RunnerRegistration> {
    const runner=this.store.get<RunnerRegistration>('runner',id);if(!runner)throw new AppError('NOT_FOUND','등록한 러너가 없습니다.',404);
    let error:string|null=null;let toolchains:RunnerRegistration['toolchains'];let isolationBackend:string|undefined;
    if(this.mode==='live'){
      try{
        const credentials=await this.service.vault.get('runner-'+id);
        const response=await fetch(runner.endpoint+'/health',{headers:{Authorization:'Bearer '+text(credentials.pairingToken,'러너 연결 코드',500)},signal:AbortSignal.timeout(8000),redirect:'error'});
        const body=object(await response.json());
        if(!response.ok||body.protocol!=='appops-runner-v1'||body.platform!==runner.platform||body.ready!==true)throw new Error('protocol');
        if(!Array.isArray(body.toolchains)||body.toolchains.length>100)throw new Error('toolchains');
        toolchains=body.toolchains.map(value=>{const t=object(value);if(typeof t.name!=='string'||t.name.length>100||typeof t.available!=='boolean')throw new Error('toolchain');return {name:t.name,available:t.available,executable:typeof t.executable==='string'?t.executable.slice(0,4096):null,version:typeof t.version==='string'?t.version.slice(0,200):null,reason:typeof t.reason==='string'?t.reason.slice(0,1000):undefined};});
        const isolation=object(body.isolation);if(isolation.available!==true||typeof isolation.backend!=='string')throw new Error('isolation');isolationBackend=isolation.backend;
      }catch{error='러너 주소·연결 코드·운영체제를 확인해 주세요. 원격 러너 서비스가 실행 중이어야 합니다.';}
    }
    const value:RunnerRegistration={...runner,status:error?'unavailable':'ready',lastCheckedAt:at(),lastError:error,toolchains,isolationBackend};
    this.store.writeBatch([{kind:'runner',id,value}],[],[{kind:'runner.checked',message:runner.label+' '+(error?'연결 확인 필요':'연결 확인 완료'),level:error?'warning':'info'}]);return value;
  }
  async removeRunner(id:string):Promise<{deleted:true}> {
    if(this.store.runs(100_000).some(r=>r.input.runnerId===id&&['queued','running','retry_wait'].includes(r.status)))throw new AppError('RUNNER_IN_USE','빌드가 끝난 뒤 러너를 삭제해 주세요.',409);
    if(!this.store.get('runner',id))throw new AppError('NOT_FOUND','등록한 러너가 없습니다.',404);
    await this.service.vault.remove('runner-'+id);this.store.remove('runner',id);this.store.addEvent({kind:'runner.removed',message:'원격 러너 등록을 해제했습니다.'});return {deleted:true};
  }
  async diagnostics():Promise<Record<string,unknown>> {
    const state=await this.service.state();
    return {createdAt:at(),mode:this.mode,version:state.runtime.version,platform:process.platform,projects:state.projects.map(p=>({name:p.name,engine:p.engine,targets:p.targets,findings:p.findings.map(f=>({code:f.code,severity:f.severity}))})),connections:state.connections.map(c=>({provider:c.provider,status:c.status,lastCheckedAt:c.lastCheckedAt})),toolchains:state.toolchains.map(t=>({name:t.name,available:t.available,version:t.version})),runs:state.runs.map(r=>({kind:r.kind,status:r.status,attempt:r.attempt})),vault:{available:state.vault.available,backend:state.vault.backend}};
  }
  private cycle():Promise<unknown> {
    if(this.active)return this.active;
    this.active=(async()=>{const settings=this.settings();const date=new Date();const today=date.toISOString().slice(0,10);if(settings.autoBackup&&date.getHours()>=settings.backupHour&&this.store.get<{date:string}>('settings','last-auto-backup')?.date!==today){await this.backup();this.store.put('settings','last-auto-backup',{date:today});}
      const cutoff=Date.now()-settings.retentionDays*86_400_000;
      for(const record of await this.backups())if(Date.parse(record.createdAt)<cutoff)await rm(join(this.store.directory,'backups',record.id+'.json'),{force:true});
    })().catch(()=>{this.store.addEvent({kind:'operations.error',message:'자동 백업 상태를 확인해 주세요.',level:'warning'});}).finally(()=>{this.active=undefined;});return this.active;
  }
}
export function runnerEndpoint(input:unknown):string {
  let url:URL;try{url=new URL(text(input,'러너 주소',2048));}catch{throw new AppError('INVALID_RUNNER','러너의 HTTPS 주소를 입력해 주세요.');}
  if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new AppError('INVALID_RUNNER','HTTPS 주소 또는 로컬 터널 주소를 사용해 주세요.');
  return url.href.replace(/\/$/,'');
}
