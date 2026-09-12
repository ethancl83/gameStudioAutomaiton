import { backup, DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, lstat, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CredentialVault, type Credentials } from '../credentials/index.js';
import { AppError } from '../domain/errors.js';
import type { Store } from '../storage/index.js';
import { BACKUP_LIMITS, backupPath, readBackup, writeBackup, type BackupEntry } from './archive.js';

const DATA_ROOTS = new Set(['artifacts','media','project-integrations','restored-history']);
interface Manifest {schema:1;version:string;mode:'demo'|'live';createdAt:string;sourceDirectory:string;fileCount:number;credentialCount:number}
export interface PortableBackupSummary {createdAt:string;files:number;credentials:number;bytes:number}
export interface RestoreSummary extends PortableBackupSummary {stage:string;projects:number;automationsPaused:true;requiresProjectRelink:true}

async function collect(root:string,directory:string):Promise<{path:string;file:string}[]> {
  const files:{path:string;file:string}[]=[];
  let entries;
  try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return files;throw error;}
  for(const item of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    const file=join(directory,item.name),info=await lstat(file),path=relative(root,file).split(sep).join('/');backupPath(path);
    if(info.isSymbolicLink()||!info.isDirectory()&&!info.isFile())throw new AppError('BACKUP_UNSAFE_FILE','백업 대상에 링크·특수 파일이 있습니다. 원본을 확인해 주세요.');
    if(await realpath(file)!==file)throw new AppError('BACKUP_UNSAFE_FILE','백업 경로가 변경되었습니다.');
    if(info.isDirectory())files.push(...await collect(root,file));else files.push({path,file});
    if(files.length>BACKUP_LIMITS.entries)throw new AppError('BACKUP_LIMIT','백업 파일 수가 한도를 넘습니다.');
  }return files;
}

/** Call while controller mutations and background jobs are quiescent. SQLite's
 * online backup captures WAL state; vault records only enter encrypted frames. */
export async function createPortableSnapshot(store:Store,vault:CredentialVault,destination:string,password:string,mode:'demo'|'live'='live',options:{signal?:AbortSignal}={}):Promise<PortableBackupSummary>{
  const work=await mkdtemp(join(store.directory,'.backup-'));
  try{
    options.signal?.throwIfAborted();
    const db=join(work,'operations.sqlite');await backup(store.db,db,{rate:100,progress:()=>options.signal?.throwIfAborted()});
    const files:{path:string;file:string}[]=[];for(const name of DATA_ROOTS)files.push(...await collect(store.directory,join(store.directory,name)));
    const records=await vault.snapshotRecords();const credentialIds=Object.keys(records).sort();
    const manifest:Manifest={schema:1,version:'0.1.0',mode,createdAt:new Date().toISOString(),sourceDirectory:store.directory,fileCount:files.length+1,credentialCount:credentialIds.length};
    async function* entries():AsyncGenerator<BackupEntry>{
      yield {kind:'manifest',path:'manifest.json',data:Buffer.from(JSON.stringify(manifest))};
      yield {kind:'database',path:'operations.sqlite',file:db};
      for(const item of files)yield {kind:'data',...item};
      for(const id of credentialIds){const data=Buffer.from(JSON.stringify(records[id]));
        if(data.length>16*1024**2)throw new AppError('BACKUP_LIMIT','보관함 항목이 백업 크기 한도를 넘습니다.');
        try{yield {kind:'vault',path:'vault/'+id,data};}finally{data.fill(0);delete records[id];}
      }
    }
    const result=await writeBackup(destination,password,entries(),options);
    return {createdAt:manifest.createdAt,files:manifest.fileCount,credentials:manifest.credentialCount,bytes:result.bytes};
  }finally{await rm(work,{recursive:true,force:true});}
}

function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('BACKUP_INVALID','백업 데이터 구조가 올바르지 않습니다.',422);return value as Record<string,unknown>;}
function rebase(value:unknown,source:string,target:string,depth=0):unknown{
  if(depth>64)throw new AppError('BACKUP_INVALID','백업 데이터 중첩이 한도를 넘습니다.',422);
  if(typeof value==='string'){
    for(const delimiter of ['/', '\\'])if(value.startsWith(source+delimiter)){
      const suffix=value.slice(source.length+1).replaceAll('\\','/');
      if(DATA_ROOTS.has(suffix.split('/')[0]!)){backupPath(suffix);return join(target,...suffix.split('/'));}
    }
    return value;
  }
  if(Array.isArray(value))return value.map(v=>rebase(v,source,target,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rebase(v,source,target,depth+1)]));
  return value;
}

/** No Store is constructed until every restored job and automation is fenced. */
function fenceDatabase(path:string,manifest:Manifest,target:string):number{
  const db=new DatabaseSync(path,{allowExtension:false});
  try{
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version=db.prepare('PRAGMA user_version').get() as {user_version:number};
    if(version.user_version!==1)throw new AppError('BACKUP_VERSION','지원하지 않는 데이터베이스 버전입니다.',422);
    const objects=db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as {type:string;name:string}[];
    const tables=['controller','documents','runs','effects','events'];
    if(objects.some(x=>!['table','index'].includes(x.type)||x.type==='table'&&!tables.includes(x.name))||tables.some(name=>!objects.some(x=>x.type==='table'&&x.name===name)))throw new AppError('BACKUP_INVALID','백업 데이터베이스 스키마가 올바르지 않습니다.',422);
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if(integrity.length!==1||Object.values(integrity[0]!)[0]!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new AppError('BACKUP_INVALID','데이터베이스 무결성 확인에 실패했습니다.',422);
    const at=new Date().toISOString();let projects=0;
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec('DELETE FROM controller');
      db.prepare("UPDATE runs SET status='action_required',owner_token=NULL,lease_until=NULL,updated_at=?,error=? WHERE status NOT IN ('succeeded','failed','cancelled')")
        .run(at,'백업에서 복원한 작업입니다. 외부 반영 여부를 확인한 뒤 재개해 주세요. 자동으로 다시 실행하지 않았습니다.');
      db.prepare("UPDATE effects SET state='action_required',updated_at=? WHERE run_id IN (SELECT id FROM runs WHERE status='action_required') AND state IN ('prepared','dispatched')").run(at);
      const update=db.prepare('UPDATE documents SET payload=?,updated_at=? WHERE kind=? AND id=?');
      const rows=db.prepare('SELECT kind,id,payload FROM documents').iterate();
      for(const row of rows){
        if(String(row.payload).length>16*1024**2)throw new AppError('BACKUP_INVALID','백업 레코드가 한도를 넘습니다.',422);
        const kind=String(row.kind),id=String(row.id),parsed=JSON.parse(String(row.payload));
        if(kind==='settings'&&(id.startsWith('integration:')||id.startsWith('integration-recovery:'))){
          db.prepare('INSERT INTO documents(kind,id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run('settings','restored-'+id,JSON.stringify(parsed),at);
          db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id);continue;
        }
        if(kind==='settings'&&Array.isArray(parsed)){
          if(['tool-installations','demo-tool-installations'].includes(id))for(const job of parsed){if(job&&typeof job==='object'&&!['succeeded','failed','cancelled'].includes(job.status)){job.status='failed';job.message='백업 복원으로 설치가 중단되었습니다. 다시 설치해 주세요.';}}
          update.run(JSON.stringify(rebase(parsed,manifest.sourceDirectory,target)),at,kind,id);continue;
        }
        if(kind==='connection-commit'){
          db.prepare('INSERT INTO documents(kind,id,payload,updated_at) VALUES(?,?,?,?)').run('settings','restored-connection-commit:'+id,JSON.stringify(parsed),at);
          db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id);continue;
        }
        const value=object(parsed);
        if(kind==='project'){
          projects++;value.relinkRequired=manifest.mode!=='demo';
          if(manifest.mode==='demo'){if(typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value.id))throw new AppError('BACKUP_INVALID','데모 프로젝트 ID가 올바르지 않습니다.',422);value.rootPath=join(dirname(target),'projects',value.id);}
          const policy=object(value.policy);for(const key of Object.keys(policy))if(key.startsWith('auto')&&typeof policy[key]==='boolean')policy[key]=false;
          if(value.socialPolicy){const social=object(value.socialPolicy);social.enabled=false;social.autoReply=false;social.autoReleaseAnnouncements=false;}
          if(value.storeApps)for(const mapping of Object.values(object(value.storeApps)))delete object(mapping).verifiedAt;
        }else if(kind==='connection'){value.status='action_required';value.lastCheckedAt=null;value.lastError='복원한 계정의 연결을 확인해 주세요. 저장한 인증 정보를 사용합니다.';
        }else if(kind==='runner'){value.status='unverified';delete value.lastCheckedAt;delete value.toolchains;delete value.isolationBackend;
        }else if(kind==='social-schedule'&&['scheduled','queued'].includes(String(value.status))){value.status='cancelled';value.restoredPaused=true;
        }else if(kind==='pipeline'&&!['succeeded','failed','cancelled'].includes(String(value.status))){value.status='action_required';value.restoredPaused=true;value.error='복원 후 배포 이력을 확인해 주세요.';
        }else if(kind==='settings'){
          if(id==='operations-settings')value.autoBackup=false;
          if(id==='tool-settings'){for(const key of Object.keys(value))delete value[key];}
          if(id.startsWith('preparation:')){delete value.runnerId;}
          if(id.startsWith('build-profile:')){delete value.engineExecutable;delete value.toolPaths;delete value.runnerId;}
        }
        const changed=kind==='project'?value:rebase(value,manifest.sourceDirectory,target);
        update.run(JSON.stringify(changed),at,kind,id);
      }
      const updateRun=db.prepare('UPDATE runs SET result_json=? WHERE id=?');
      for(const row of db.prepare('SELECT id,result_json FROM runs WHERE result_json IS NOT NULL').iterate())updateRun.run(JSON.stringify(rebase(JSON.parse(String(row.result_json)),manifest.sourceDirectory,target)),String(row.id));
      db.prepare('INSERT INTO events(project_id,run_id,kind,message,level,data_json,created_at) VALUES(NULL,NULL,?,?,?,?,?)')
        .run('backup.restored','전체 백업을 복원했습니다. 프로젝트 경로·계정·러너를 확인할 때까지 자동화를 중지했습니다.','warning',JSON.stringify({sourceCreatedAt:manifest.createdAt,automationsPaused:true}),at);
      db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
    }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
    return projects;
  }finally{db.close();}
}

export async function restorePortableSnapshot(archive:string,password:string,stage:string,target:string,
  options:{vaultFactory?:(directory:string)=>CredentialVault;expectedMode?:'demo'|'live';signal?:AbortSignal}={}):Promise<RestoreSummary>{
  const parent=dirname(resolve(stage));
  if(![dirname(resolve(target)),resolve(target)+'.recovery'].includes(parent)||resolve(stage)===resolve(target))throw new AppError('RESTORE_PATH','복구에는 운영 데이터 옆의 새 임시 폴더가 필요합니다.');
  await mkdir(stage,{mode:0o700});const handles=new Set<FileHandle>();let manifest:Manifest|undefined,credentials=0,files=0,complete=false;
  const vault=(options.vaultFactory??(directory=>new CredentialVault(directory)))(join(stage,'credentials'));
  try{
    options.signal?.throwIfAborted();
    const result=await readBackup(archive,password,async meta=>{
      if(meta.kind==='manifest'||meta.kind==='vault'){
        const limit=meta.kind==='manifest'?BACKUP_LIMITS.metadata:16*1024**2;if(meta.size>limit)throw new AppError('BACKUP_LIMIT','백업 메타데이터가 한도를 넘습니다.');
        const chunks:Buffer[]=[];
        return {write:async data=>{chunks.push(Buffer.from(data));},finish:async()=>{
          const bytes=Buffer.concat(chunks);
          try{
            let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw new AppError('BACKUP_INVALID','백업 메타데이터를 읽을 수 없습니다.',422);}
            if(meta.kind==='manifest'){
              const m=object(value);if(m.schema!==1||typeof m.sourceDirectory!=='string'||!(isAbsolute(m.sourceDirectory)||/^[A-Za-z]:\\/.test(m.sourceDirectory))||typeof m.createdAt!=='string'||!Number.isFinite(Date.parse(m.createdAt))||!Number.isSafeInteger(m.fileCount)||Number(m.fileCount)<1||!Number.isSafeInteger(m.credentialCount)||Number(m.credentialCount)<0||Number(m.credentialCount)>10_000)throw new AppError('BACKUP_INVALID','백업 명세가 올바르지 않습니다.',422);
              manifest=m as unknown as Manifest;
              if(manifest.mode!==(options.expectedMode??'live'))throw new AppError('BACKUP_MODE','데모와 실제 모드 사이에 보관함·운영 데이터를 복원할 수 없습니다.',422);
            }else{
              if(!/^vault\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(meta.path)||meta.path.includes('..'))throw new AppError('BACKUP_INVALID','보관함 항목 ID가 올바르지 않습니다.',422);
              const record=object(value);if(Object.values(record).some(v=>typeof v!=='string'))throw new AppError('BACKUP_INVALID','보관함 값 형식이 올바르지 않습니다.',422);
              await vault.set(meta.path.slice(6),record as Credentials);credentials++;
            }
          }finally{bytes.fill(0);for(const chunk of chunks)chunk.fill(0);}
        }};
      }
      if(meta.kind==='data'&&(meta.path.split('/').length<2||!DATA_ROOTS.has(meta.path.split('/')[0]!)))throw new AppError('BACKUP_INVALID','허용되지 않은 백업 데이터 경로입니다.',422);
      const path=join(stage,...meta.path.split('/'));await mkdir(dirname(path),{recursive:true,mode:0o700});
      const file=await open(path,'wx',0o600);handles.add(file);files++;
      return {write:async data=>{let offset=0;while(offset<data.length){const written=await file.write(data,offset,data.length-offset);if(!written.bytesWritten)throw new Error('write failed');offset+=written.bytesWritten;}},finish:async()=>{await file.sync();await file.close();handles.delete(file);await chmod(path,meta.executable?0o700:0o600);}};
    },options);
    if(!manifest||files!==manifest.fileCount||credentials!==manifest.credentialCount)throw new AppError('BACKUP_INVALID','백업 명세와 복원한 항목 수가 일치하지 않습니다.',422);
    options.signal?.throwIfAborted();
    const projects=fenceDatabase(join(stage,'operations.sqlite'),manifest,resolve(target));
    if(!(await vault.status()).available)throw new AppError('VAULT_UNAVAILABLE','새 장비의 보관함 키를 확인할 수 없습니다. 기존 데이터는 보존했습니다.');
    for(const id of await vault.listIds())await vault.get(id);
    complete=true;
    return {stage,projects,createdAt:manifest.createdAt,files,credentials,bytes:result.bytes,automationsPaused:true,requiresProjectRelink:true};
  }finally{await Promise.allSettled([...handles].map(file=>file.close()));if(!complete)await rm(stage,{recursive:true,force:true});}
}
