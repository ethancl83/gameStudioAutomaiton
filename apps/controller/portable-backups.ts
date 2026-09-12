import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CredentialVault } from '../../packages/credentials/index.js';
import type { Store } from '../../packages/storage/index.js';
import { AppError, object, text } from '../../packages/domain/errors.js';
import { createPortableSnapshot, restorePortableSnapshot } from '../../packages/backup/snapshot.js';
import { recoveryRoot, readPendingRestore, requestRestoreActivation, restoreStage, stageRestoreActivation } from '../../packages/backup/activation.js';
import type { PortableBackupRecord, PortableBackupState, PortableRestoreRecord } from '../../packages/backup/types.js';
import type { AppService } from './service.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMIT=512*1024**3;
const at=()=>new Date().toISOString();
const message=(error:unknown)=>error instanceof AppError?error.message:'백업·복구 처리에 실패했습니다. 기존 데이터는 보존했습니다.';
function password(input:unknown):string{const value=object(input).passphrase;if(typeof value!=='string'||value.length<12||value.length>1024)throw new AppError('BACKUP_PASSWORD','백업 암호를 12~1024자로 입력해 주세요. 암호는 저장하지 않습니다.');return value;}

export class PortableBackups {
  readonly directory:string;
  private active:Promise<void>|undefined;
  private activeId:string|undefined;
  private stopped=false;
  private abort:AbortController|undefined;
  constructor(private readonly store:Store,private readonly service:AppService,private readonly mode:'demo'|'live',private readonly vaultFactory?:(directory:string)=>CredentialVault){this.directory=store.directory+'.portable-backups';}
  private id(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))throw new AppError('BACKUP_ID','백업 ID를 확인해 주세요.');return value;}
  private async root():Promise<void>{await mkdir(this.directory,{recursive:true,mode:0o700});if((await lstat(this.directory)).isSymbolicLink()||await realpath(this.directory)!==resolve(this.directory))throw new AppError('BACKUP_PATH','백업 저장소의 실제 경로가 변경되었습니다.');}
  private async save(name:string,value:unknown):Promise<void>{await this.root();const path=join(this.directory,name),temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});try{await rename(temp,path);}finally{await rm(temp,{force:true});}}
  private async json<T>(name:string):Promise<T|undefined>{
    try{const file=await open(join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!(await file.stat()).isFile()||(await file.stat()).size>64*1024)throw new Error('invalid metadata');return JSON.parse(await file.readFile('utf8')) as T;}finally{await file.close();}}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw new AppError('BACKUP_METADATA','백업 이력 파일을 확인할 수 없습니다.');}
  }
  private available():void{if(this.stopped||this.activeId)throw new AppError('BACKUP_BUSY','진행 중인 백업·복구가 끝난 뒤 다시 시도해 주세요.',409);}
  async state():Promise<PortableBackupState>{
    await this.root();const backups:PortableBackupRecord[]=[];
    for(const name of await readdir(this.directory)){
      if(!name.endsWith('.json')||!UUID.test(name.slice(0,-5)))continue;
      const record=await this.json<PortableBackupRecord>(name);if(!record||record.id!==name.slice(0,-5))continue;
      if(record.status==='creating'&&this.activeId!==record.id){record.status='failed';record.error='제어 서비스 종료로 백업을 완료하지 못했습니다. 다시 만들어 주세요.';record.updatedAt=at();await this.save(name,record);}
      backups.push(record);
    }
    let restore=await this.json<PortableRestoreRecord>('restore.json')??null;
    const pending=await readPendingRestore(this.store.directory);
    if(restore){
      if(pending?.id===restore.id&&pending.phase==='committed')restore={...restore,status:'committed'};
      else if(pending?.id===restore.id&&pending.phase==='rolled-back')restore={...restore,status:'failed',error:pending.error};
      else if(restore.status==='preparing'&&this.activeId!==restore.id&&pending?.id!==restore.id)restore={...restore,status:'failed',error:'복원 준비가 중단되었습니다. 다시 준비해 주세요.'};
    }
    return {backups:backups.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),restore,busy:Boolean(this.activeId||pending&&['requested','old-moved','installed'].includes(pending.phase))};
  }
  async create(input:unknown):Promise<PortableBackupRecord>{
    this.available();const passphrase=password(input),id=randomUUID();
    const record:PortableBackupRecord={id,createdAt:at(),updatedAt:at(),status:'creating',size:0,fileCount:0,credentialCount:0,origin:'created'};
    this.activeId=id;const abort=this.abort=new AbortController();
    this.active=this.service.withMaintenance(async()=>{
      await this.save(id+'.json',record);abort.signal.throwIfAborted();
        const path=join(this.directory,id+'.appopsbackup');
        const result=await createPortableSnapshot(this.store,this.service.vault,path,passphrase,this.mode,{signal:abort.signal});
        const info=await stat(path);if(info.size>LIMIT)throw new AppError('BACKUP_LIMIT','전체 백업 파일이 크기 한도를 넘습니다.');
        const digest=await this.digest(path,abort.signal);
        await this.save(id+'.json',{...record,status:'ready',updatedAt:at(),size:info.size,fileCount:result.files,credentialCount:result.credentials,sha256:digest});
        this.store.addEvent({kind:'backup.full.created',message:'이력·산출물·암호화 보관함을 포함한 전체 백업을 만들었습니다.',data:{backupId:id,fileCount:result.files,credentialCount:result.credentials}});
    }).catch(async error=>{await rm(join(this.directory,id+'.appopsbackup'),{force:true});await this.save(id+'.json',{...record,status:'failed',updatedAt:at(),error:message(error)});}).finally(()=>{this.active=undefined;this.activeId=undefined;this.abort=undefined;});
    // A failure to write the progress index must still be observed by close().
    void this.active.catch(()=>{});
    return record;
  }
  private async digest(path:string,signal?:AbortSignal):Promise<string>{const hash=createHash('sha256'),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{for await(const chunk of file.createReadStream({autoClose:false})){signal?.throwIfAborted();hash.update(chunk as Buffer);}return hash.digest('hex');}finally{await file.close();}}
  async download(rawId:string){
    const id=this.id(rawId),record=await this.json<PortableBackupRecord>(id+'.json');
    if(!record||record.status!=='ready'||!record.sha256)throw new AppError('BACKUP_NOT_READY','완료한 백업 파일을 선택해 주세요.',409);
    const file=await open(join(this.directory,id+'.appopsbackup'),constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await file.stat();if(!info.isFile()||info.size!==record.size||info.size>LIMIT){await file.close();throw new AppError('BACKUP_CHANGED','백업 파일이 이력과 일치하지 않습니다.',409);}return {record,file};
  }
  async import(stream:AsyncIterable<Uint8Array>,length?:number):Promise<{id:string;size:number}>{
    this.available();if(length!==undefined&&(!Number.isSafeInteger(length)||length<12||length>LIMIT))throw new AppError('BACKUP_LIMIT','전체 백업 파일 크기를 확인해 주세요.');
    const id=randomUUID();this.activeId=id;const abort=this.abort=new AbortController();
    const operation=this.importFile(id,stream,length,abort.signal);
    this.active=operation.then(()=>{},()=>{}).finally(()=>{this.active=undefined;this.activeId=undefined;this.abort=undefined;});
    return operation;
  }
  private async importFile(id:string,stream:AsyncIterable<Uint8Array>,length:number|undefined,signal:AbortSignal):Promise<{id:string;size:number}>{
    await this.root();const path=join(this.directory,id+'.appopsbackup'),temp=path+'.partial';const file=await open(temp,'wx',0o600);
    const hash=createHash('sha256');let size=0,prefix=Buffer.alloc(0),complete=false;
    try{
      for await(const data of stream){const bytes=Buffer.from(data);size+=bytes.length;if(this.stopped||signal.aborted||size>LIMIT)throw new AppError('BACKUP_LIMIT','백업 가져오기가 중단되었거나 크기 한도를 넘습니다.');
        if(prefix.length<8){prefix=Buffer.concat([prefix,bytes.subarray(0,8-prefix.length)]);if(prefix.length===8&&!prefix.equals(Buffer.from('APPOPSB1')))throw new AppError('BACKUP_INVALID','App Operations 전체 백업 파일을 선택해 주세요.');}
        hash.update(bytes);let offset=0;while(offset<bytes.length){const r=await file.write(bytes,offset,bytes.length-offset);if(!r.bytesWritten)throw new Error('write failed');offset+=r.bytesWritten;}
      }
      if(size<12||length!==undefined&&size!==length)throw new AppError('BACKUP_INVALID','가져온 백업 파일이 중간에 잘렸습니다.');
      await file.sync();await file.close();await rename(temp,path);complete=true;
      await this.save(id+'.json',{id,createdAt:at(),updatedAt:at(),status:'ready',size,fileCount:0,credentialCount:0,sha256:hash.digest('hex'),origin:'imported'} satisfies PortableBackupRecord);
      return {id,size};
    }finally{try{await file.close();}catch{}if(!complete)await rm(temp,{force:true});}
  }
  async prepare(rawId:string,input:unknown):Promise<PortableRestoreRecord>{
    this.available();const backupId=this.id(rawId),passphrase=password(input),id=randomUUID();
    const stage=restoreStage(this.store.directory,id),record:PortableRestoreRecord={id,backupId,createdAt:at(),updatedAt:at(),status:'preparing',projectCount:0,fileCount:0,credentialCount:0};
    this.activeId=id;const abort=this.abort=new AbortController();
    this.active=(async()=>{
      await this.save('restore.json',record);abort.signal.throwIfAborted();
      const source=await this.download(backupId);await source.file.close();
      const root=recoveryRoot(this.store.directory);await mkdir(root,{recursive:true,mode:0o700});if(await realpath(root)!==root)throw new AppError('RESTORE_PATH','복구 저장소의 실제 위치를 확인해 주세요.');
      const previous=await readPendingRestore(this.store.directory);if(previous&&['requested','old-moved','installed'].includes(previous.phase))throw new AppError('RESTORE_PENDING','이전 복원 활성화를 먼저 마쳐 주세요.',409);
      if(previous?.phase==='ready')await rm(restoreStage(this.store.directory,previous.id),{recursive:true,force:true});
      const result=await restorePortableSnapshot(join(this.directory,backupId+'.appopsbackup'),passphrase,stage,this.store.directory,{vaultFactory:this.vaultFactory,expectedMode:this.mode,signal:abort.signal});
      abort.signal.throwIfAborted();await stageRestoreActivation(this.store.directory,id,backupId,result,{signal:abort.signal});
      await this.save('restore.json',{...record,status:'ready',updatedAt:at(),projectCount:result.projects,fileCount:result.files,credentialCount:result.credentials});
    })().catch(async error=>{await rm(stage,{recursive:true,force:true});await this.save('restore.json',{...record,status:'failed',updatedAt:at(),error:message(error)});}).finally(()=>{this.active=undefined;this.activeId=undefined;this.abort=undefined;});
    void this.active.catch(()=>{});return record;
  }
  async commit(input:unknown):Promise<{restartRequired:boolean}>{
    this.available();const id=this.id(object(input).restoreId);
    await this.service.withMaintenance(()=>requestRestoreActivation(this.store.directory,id),true);
    return {restartRequired:this.mode==='live'};
  }
  async close():Promise<void>{this.stopped=true;this.abort?.abort();await this.active?.catch(()=>{});}
}
