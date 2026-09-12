import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';
import { DatabaseSync } from 'node:sqlite';
import type { RestoreSummary } from './snapshot.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Phase='ready'|'requested'|'old-moved'|'installed'|'committed'|'rolled-back';
export interface PendingRestore {
  schema:1;id:string;backupId:string;phase:Phase;createdAt:string;oldExisted:boolean;
  summary:Omit<RestoreSummary,'stage'>;error?:string;
  stageSha256:string;
}
const failed=(message:string)=>new AppError('RESTORE_RECOVERY',message,409);
const exists=async(path:string)=>{try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
async function privateJson(path:string,limit=32*1024):Promise<unknown>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await file.stat();if(!info.isFile()||info.size>limit)throw failed('복구 기록의 파일 형식이나 크기가 올바르지 않습니다.');return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
}
async function stageDigest(root:string,signal?:AbortSignal):Promise<string>{
  if((await lstat(root)).isSymbolicLink()||await realpath(root)!==resolve(root))throw failed('복구 데이터의 실제 경로가 바뀌었습니다.');
  const hash=createHash('sha256');let count=0,total=0;
  const visit=async(directory:string,prefix:string,depth:number):Promise<void>=>{
    if(depth>256)throw failed('복구 폴더 깊이가 한도를 넘습니다.');
    for(const name of (await readdir(directory)).sort()){
      signal?.throwIfAborted();const path=join(directory,name),relative=prefix+name,info=await lstat(path);
      if(++count>120_000||info.isSymbolicLink())throw failed('복구 데이터의 항목 수나 경로가 올바르지 않습니다.');
      if(info.isDirectory()){hash.update(JSON.stringify(['directory',relative]));await visit(path,relative+'/',depth+1);continue;}
      if(!info.isFile()||info.size>64*1024**3||(total+=info.size)>512*1024**3)throw failed('복구 파일 형식이나 크기가 올바르지 않습니다.');
      hash.update(JSON.stringify(['file',relative,info.size,Boolean(info.mode&0o111)]));
      const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const content=createHash('sha256');let bytes=0;for await(const chunk of file.createReadStream({autoClose:false})){signal?.throwIfAborted();bytes+=(chunk as Buffer).length;content.update(chunk as Buffer);}if(bytes!==info.size)throw failed('복구 검증 중 파일 크기가 바뀌었습니다.');hash.update(content.digest());}finally{await file.close();}
    }
  };await visit(root,'',0);return hash.digest('hex');
}
export const recoveryRoot=(data:string)=>data+'.recovery';
export const restoreStage=(data:string,id:string)=>{if(!UUID.test(id))throw failed('복구 ID가 올바르지 않습니다.');return join(recoveryRoot(data),'stage-'+id);};

async function syncDirectory(path:string):Promise<void>{
  if(process.platform==='win32')return;
  const file=await open(path,'r');try{await file.sync();}finally{await file.close();}
}
async function privateRoot(data:string):Promise<string>{
  const root=recoveryRoot(data);await mkdir(root,{recursive:true,mode:0o700});
  if((await lstat(root)).isSymbolicLink()||await realpath(root)!==resolve(root))throw failed('복구 저장소의 실제 경로가 바뀌었습니다.');return root;
}
async function atomic(path:string,contents:string|Buffer):Promise<void>{
  const temp=path+'.'+randomUUID()+'.tmp';const file=await open(temp,'wx',0o600);
  try{await file.writeFile(contents);await file.sync();}finally{await file.close();}
  try{await rename(temp,path);await syncDirectory(dirname(path));}finally{await rm(temp,{force:true});}
}
async function secret(data:string):Promise<Buffer>{
  const root=await privateRoot(data),path=join(root,'authentication.key');
  if(!await exists(path)){
    const temp=path+'.'+randomUUID();const file=await open(temp,'wx',0o600);
    try{await file.writeFile(randomBytes(32));await file.sync();}finally{await file.close();}
    try{try{await link(temp,path);await syncDirectory(root);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}}finally{await rm(temp,{force:true});}
  }
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if((await file.stat()).size!==32)throw failed('복구 저장소 인증 정보를 확인할 수 없습니다.');return await file.readFile();}finally{await file.close();}
}
function mac(key:Buffer,value:unknown):Buffer{return createHmac('sha256',key).update(JSON.stringify(value)).digest();}
async function writePending(data:string,pending:PendingRestore):Promise<void>{
  const key=await secret(data);try{await atomic(join(recoveryRoot(data),'pending.json'),JSON.stringify({record:pending,signature:mac(key,pending).toString('base64url')}));}finally{key.fill(0);}
}
export async function readPendingRestore(data:string):Promise<PendingRestore|null>{
  const path=join(recoveryRoot(data),'pending.json');if(!await exists(path))return null;
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let parsed;
  try{if((await file.stat()).size>32*1024)throw failed('복구 기록 크기가 올바르지 않습니다.');parsed=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
  const key=await secret(data);
  try{const signature=Buffer.from(typeof parsed.signature==='string'?parsed.signature:'','base64url');if(signature.length!==32||!timingSafeEqual(signature,mac(key,parsed.record)))throw failed('복구 기록 인증에 실패했습니다. 기존 데이터를 보존했습니다.');}finally{key.fill(0);}
  const p=parsed.record as PendingRestore;
  if(p?.schema!==1||!UUID.test(p.id)||!UUID.test(p.backupId)||!['ready','requested','old-moved','installed','committed','rolled-back'].includes(p.phase)||typeof p.oldExisted!=='boolean'||!/^([a-f0-9]{64})$/.test(p.stageSha256))throw failed('복구 기록 형식이 올바르지 않습니다.');
  return p;
}
async function identity(data:string,id:string):Promise<boolean>{
  try{return (await privateJson(join(data,'restore-identity.json'),1024) as {id?:string}).id===id;}catch{return false;}
}
async function requireStopped(data:string):Promise<void>{
  const path=join(data,'operations.sqlite');if(!await exists(path))return;
  let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(path,{readOnly:true,allowExtension:false});
    const row=db.prepare('SELECT expires_at FROM controller WHERE id=1').get();
    if(row&&Number(row.expires_at)>Date.now())throw failed('실행 중인 제어 서비스를 먼저 중지해야 복원할 수 있습니다.');
  }catch(error){
    if(error instanceof AppError)throw error;
    // A damaged database is itself a recovery use case. Never replace it while
    // its recorded process may still own open files.
    try{const owner=JSON.parse(await readFile(join(data,'controller.json'),'utf8'));if(Number.isSafeInteger(owner.pid)&&owner.pid>0){process.kill(owner.pid,0);throw failed('데이터베이스 소유 프로세스를 중지한 뒤 복원해 주세요.');}}
    catch(e){if(e instanceof AppError)throw e;if(!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))throw failed('기존 제어 서비스의 종료 상태를 확인할 수 없습니다.');}
  }finally{db?.close();}
}
async function lock(data:string):Promise<()=>Promise<void>>{
  const root=await privateRoot(data),path=join(root,'activation.lock'),nonce=randomUUID();
  for(let attempt=0;attempt<3;attempt++){
    const temp=path+'.'+nonce;const file=await open(temp,'wx',0o600);
    try{await file.writeFile(JSON.stringify({pid:process.pid,nonce}));await file.sync();}finally{await file.close();}
    try{await link(temp,path);await rm(temp,{force:true});return async()=>{try{const owner=JSON.parse(await readFile(path,'utf8'));if(owner.nonce===nonce)await rm(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};}
    catch(e){await rm(temp,{force:true});if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    let owner;try{owner=JSON.parse(await readFile(path,'utf8'));}catch{throw failed('다른 복구 작업의 잠금을 확인해 주세요.');}
    if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw failed('복구 잠금 소유자를 확인해 주세요.');
    try{process.kill(owner.pid,0);throw failed('다른 제어 서비스가 복구를 진행하고 있습니다.');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
    const current=JSON.parse(await readFile(path,'utf8'));if(current.nonce===owner.nonce)await rm(path);
  }throw failed('복구 잠금을 확보하지 못했습니다.');
}

export async function stageRestoreActivation(data:string,id:string,backupId:string,summary:RestoreSummary,options:{signal?:AbortSignal}={}):Promise<PendingRestore>{
  if(summary.stage!==restoreStage(data,id)||!UUID.test(backupId))throw failed('복구 대상과 준비한 데이터가 일치하지 않습니다.');
  const {stage:_,...publicSummary}=summary;
  await atomic(join(summary.stage,'restore-identity.json'),JSON.stringify({id}));
  const stageSha256=await stageDigest(summary.stage,options.signal);
  const pending:PendingRestore={schema:1,id,backupId,phase:'ready',createdAt:new Date().toISOString(),oldExisted:await exists(data),summary:publicSummary,stageSha256};
  await writePending(data,pending);return pending;
}
export async function requestRestoreActivation(data:string,id:string):Promise<void>{
  const p=await readPendingRestore(data);if(!p||p.id!==id||p.phase!=='ready')throw failed('검증이 끝난 복구 준비를 선택해 주세요.');await writePending(data,{...p,phase:'requested'});
}

export interface RestoreActivation {id:string;commit():Promise<void>;rollback():Promise<void>}
/** Run before opening SQLite. Keep the lock until the new controller passes its
 * startup/health checks, retaining the previous data and key pointer for rollback. */
export async function activatePendingRestore(data:string,options:{afterPhase?:(phase:Phase)=>Promise<void>}={}):Promise<RestoreActivation|null>{
  let pending=await readPendingRestore(data);if(!pending||!['requested','old-moved','installed'].includes(pending.phase))return null;
  const release=await lock(data);pending=await readPendingRestore(data);
  if(!pending||!['requested','old-moved','installed'].includes(pending.phase)){await release();return null;}
  let p=pending;const stage=restoreStage(data,p.id),previous=join(recoveryRoot(data),'previous-'+p.id),discard=join(recoveryRoot(data),'failed-'+p.id);
  let released=false;const finish=async()=>{if(!released){released=true;await release();}};
  const rollback=async()=>{
    try{
      if(await exists(data)&&await identity(data,p.id)){
        if(await exists(discard))throw failed('이전 복구 실패 데이터를 확인해 주세요. 기존 데이터를 덮어쓰지 않았습니다.');
        await rename(data,discard);await syncDirectory(dirname(data));
      }
      if(await exists(previous)){
        if(await exists(data))throw failed('원래 데이터와 현재 데이터가 함께 존재합니다. 자동으로 덮어쓰지 않았습니다.');
        await rename(previous,data);await syncDirectory(dirname(data));
      }else if(p.oldExisted&&!await exists(data))throw failed('원래 데이터 폴더의 위치를 확인해 주세요.');
      p={...p,phase:'rolled-back',error:'복원한 제어 서비스의 시작을 완료하지 못해 이전 데이터로 되돌렸습니다.'};await writePending(data,p);
    }finally{await finish();}
  };
  if(p.phase==='requested'){
    try{await requireStopped(data);}catch(error){await finish();throw error;}
  }
  let verified=false;
  try{
    if(p.phase==='requested'){
      if(!await exists(stage)||!await identity(stage,p.id)||(await lstat(stage)).isSymbolicLink())throw failed('검증한 복구 임시 폴더를 확인할 수 없습니다.');
      if(await stageDigest(stage)!==p.stageSha256)throw failed('준비 이후 복구 파일이 바뀌었습니다. 기존 데이터를 보존했습니다.');
      verified=true;
      if(await exists(data)){
        if(await exists(previous))throw failed('이전 데이터 보존 위치가 이미 존재합니다.');
        await rename(data,previous);await syncDirectory(dirname(data));
      }else if(p.oldExisted&&!await exists(previous))throw failed('원래 데이터 폴더가 없습니다.');
      p={...p,phase:'old-moved'};await writePending(data,p);await options.afterPhase?.(p.phase);
    }
    if(p.phase==='old-moved'){
      if(await exists(stage)){
        if(!verified&&await stageDigest(stage)!==p.stageSha256)throw failed('준비 이후 복구 파일이 바뀌었습니다.');
        verified=true;
        if(await exists(data))throw failed('복구 위치에 다른 데이터가 있습니다.');
        await rename(stage,data);await syncDirectory(dirname(data));
      }else if(!await identity(data,p.id))throw failed('복구 데이터 위치를 확인할 수 없습니다.');
      p={...p,phase:'installed'};await writePending(data,p);await options.afterPhase?.(p.phase);
    }
    if(!await identity(data,p.id))throw failed('활성화한 복구 데이터의 ID가 일치하지 않습니다.');
    if(!verified&&await stageDigest(data)!==p.stageSha256)throw failed('활성화한 복구 데이터의 무결성이 일치하지 않습니다.');
    return {id:p.id,commit:async()=>{try{p={...p,phase:'committed'};await writePending(data,p);}finally{await finish();}},rollback};
  }catch(error){try{await rollback();}catch(rollbackError){await finish();throw rollbackError;}throw error;}
}
