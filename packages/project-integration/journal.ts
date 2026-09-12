import { constants } from 'node:fs';
import { link, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { JournalRecord } from './types.js';
import { integrationHome, openFileNoFollow, PathGuardError, writeTextAtomic, resolveSafeRelative } from './paths.js';

const held=new Set<string>();
const uuid=(value:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new PathGuardError('SDK 이력 ID 형식이 잘못되었습니다.','journal.id');return value;};
export async function ensureHome(rootReal:string):Promise<string>{
 const home=integrationHome(rootReal);
 for(const name of ['previews','applies','backups']){
  const path=await resolveSafeRelative(home,name);await mkdir(path,{recursive:true,mode:0o700});
  const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink())throw new PathGuardError('SDK 이력 하위 경로에 링크가 있습니다.','path.symlink');
 }
 return home;
}
async function safeRead<T>(home:string,rel:string):Promise<T|null>{
 const path=await resolveSafeRelative(home,rel);
 let handle;try{handle=await openFileNoFollow(path,constants.O_RDONLY);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
 try{const st=await handle.stat();if(!st.isFile()||st.size>16*1024*1024)throw new PathGuardError('SDK 이력 파일이 너무 크거나 일반 파일이 아닙니다.','journal.invalid');return JSON.parse(await handle.readFile('utf8')) as T;}finally{await handle.close();}
}
export async function withProjectLock<T>(rootReal:string,fn:()=>Promise<T>):Promise<T>{
 const home=await ensureHome(rootReal);const path=join(home,'journal.lock');
 if(held.has(path))throw new PathGuardError('다른 SDK 적용이 진행 중입니다.','apply.locked');
 held.add(path);const nonce=randomUUID();const prepared=join(home,'.lock-'+nonce);let acquired=false;
 try{
  const handle=await openFileNoFollow(prepared,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY);
  try{await handle.writeFile(JSON.stringify({pid:process.pid,nonce,createdAt:new Date().toISOString()}));await handle.sync();}finally{await handle.close();}
  // The public lock is atomically linked only after its owner record is durable.
  for(let attempt=0;attempt<3;attempt++){
   try{await link(prepared,path);acquired=true;break;}
   catch(e){
    if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
    const owner=await safeRead<{pid:number;nonce:string}>(home,'journal.lock');
    if(!owner||!Number.isSafeInteger(owner.pid)||owner.pid<1)throw new PathGuardError('SDK 적용 잠금 기록을 확인해 주세요.','journal.invalid');
    let live=true;try{process.kill(owner.pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')live=false;}
    if(live)throw new PathGuardError('다른 SDK 적용이 진행 중입니다.','apply.locked');
    const latest=await safeRead<typeof owner>(home,'journal.lock');if(latest?.nonce===owner.nonce)await rm(path,{force:true});
   }
  }
  if(!acquired)throw new PathGuardError('SDK 적용 잠금을 얻지 못했습니다.','apply.locked');
  return await fn();
 }finally{
  if(acquired){const owner=await safeRead<{nonce:string}>(home,'journal.lock').catch(()=>null);if(owner?.nonce===nonce)await rm(path,{force:true});}
  await rm(prepared,{force:true});held.delete(path);
 }
}

export async function writePreview(root:string,id:string,body:unknown):Promise<string>{const home=await ensureHome(root);const path=join(home,'previews',uuid(id)+'.json');await writeTextAtomic(path,JSON.stringify(body),home);return path;}
export async function readPreview<T>(root:string,id:string):Promise<T|null>{const home=await ensureHome(root);return safeRead(home,'previews/'+uuid(id)+'.json');}
export async function writeJournal(root:string,record:JournalRecord):Promise<string>{
 const home=await ensureHome(root);const path=join(home,'journal.json');await writeTextAtomic(path,JSON.stringify(record),home);
 if(record.applyId)await writeTextAtomic(join(home,'applies',uuid(record.applyId)+'.json'),JSON.stringify(record),home);return path;
}
export async function readJournal(root:string):Promise<JournalRecord|null>{const home=await ensureHome(root);return safeRead(home,'journal.json');}
export async function readApply(root:string,id:string):Promise<JournalRecord|null>{const home=await ensureHome(root);return safeRead(home,'applies/'+uuid(id)+'.json');}
export function backupDir(root:string,id:string):string{return join(integrationHome(root),'backups',uuid(id));}
export async function writeFileSafe(abs:string,content:string):Promise<void>{await writeTextAtomic(abs,content);}
export { writeFile };
