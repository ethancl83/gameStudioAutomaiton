import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../domain/errors.js';
import { combineHashes, sha256File, sha256Text } from './hashes.js';
import { backupDir, readApply, readJournal, readPreview, withProjectLock, writeJournal, writePreview } from './journal.js';
import { assertSafeRelative, PathGuardError, resolveProjectRoot, writeTextAtomic, readTextNoFollow } from './paths.js';
import { previewIntegration, type StoredPreview } from './preview.js';
import type { IntegrationApplyResult, IntegrationFinding, IntegrationRequest, IntegrationRollbackResult, JournalRecord, PlannedFileChange } from './types.js';
import { wiringChecks } from './wiring.js';
import { detectProjectSdks } from './detect.js';

const now=()=>new Date().toISOString();
const finding=(code:string,message:string):IntegrationFinding=>({code,severity:'error',message});
async function currentHash(root:string,files:{path:string}[]):Promise<string>{
 const entries=[];for(const f of files)entries.push({path:f.path,hash:await sha256File(await assertSafeRelative(root,f.path))});return combineHashes(entries);
}
function validateStored(root:string,stored:StoredPreview):void{
 if(stored.request.projectRoot!==root||!Array.isArray(stored.changes)||stored.changes.length>1000)throw new AppError('INTEGRATION_INVALID','SDK 변경 기록과 프로젝트가 일치하지 않습니다.');
 const paths=new Set<string>();for(const f of stored.changes){
  if(paths.has(f.path)||!['create','patch','skip'].includes(f.action)||f.content!==undefined&&(f.content.length>8*1024*1024||sha256Text(f.content)!==f.contentHash))throw new AppError('INTEGRATION_INVALID','SDK 변경 기록의 무결성이 손상되었습니다.');paths.add(f.path);
 }
 if(combineHashes(stored.changes.map(f=>({path:f.path,hash:f.previousHash??null})))!==stored.preview.beforeHash)throw new AppError('INTEGRATION_INVALID','SDK 변경 이전 해시가 일치하지 않습니다.');
}
async function backupFiles(root:string,record:JournalRecord):Promise<void>{
 const dir=backupDir(root,record.applyId!);await mkdir(dir,{mode:0o700});
 for(let i=0;i<record.files.length;i++){
  const file=record.files[i]!;if(file.beforeHash===null)continue;
  const abs=await assertSafeRelative(root,file.path);const content=await readTextNoFollow(abs);
  if(sha256Text(content)!==file.beforeHash)throw new AppError('INTEGRATION_CONFLICT','백업 중 원본 파일이 변경되었거나 지원하지 않는 문자 인코딩입니다.');
  // Flat controller-owned paths prevent untrusted project names from shaping the backup tree.
  await writeTextAtomic(join(dir,i+'.txt'),content,dir);
 }
}
/** Check every current file and every backup before changing any source file. */
async function restoreFiles(root:string,record:JournalRecord):Promise<boolean>{
 const changes:{path:string;content:string|null;expected:string|null}[]=[];const dir=backupDir(root,record.applyId!);
 for(let i=0;i<record.files.length;i++){
  const f=record.files[i]!;if(f.action==='skip')continue;
  const path=await assertSafeRelative(root,f.path);const current=await sha256File(path);
  if(current===f.beforeHash)continue;
  if(current!==f.afterHash)return false;
  const content=f.beforeHash===null?null:await readTextNoFollow(await assertSafeRelative(dir,i+'.txt'));
  if(content!==null&&sha256Text(content)!==f.beforeHash)throw new AppError('INTEGRATION_BACKUP_DAMAGED','SDK 원본 백업이 손상되어 복구를 중단했습니다.');
  changes.push({path,content,expected:current});
 }
 for(const change of changes){
  if(await sha256File(change.path)!==change.expected)return false;
  if(change.content===null){const fs=await import('node:fs/promises');await fs.rm(change.path);}
  else await writeTextAtomic(change.path,change.content,root);
 }
 return await currentHash(root,record.files)===record.beforeHash;
}
function failed(stored:StoredPreview,status:IntegrationApplyResult['status'],reason?:IntegrationFinding):IntegrationApplyResult{
 return {applyId:stored.preview.previewId,previewId:stored.preview.previewId,status,afterHash:stored.preview.beforeHash,journalPath:stored.preview.journalPath,filesWritten:[],wiring:stored.preview.wiring,findings:[...stored.preview.findings,...(reason?[reason]:[])]};
}
export async function applyIntegration(input:IntegrationRequest|{previewId:string;projectRoot?:string}):Promise<IntegrationApplyResult>{
 const root=await resolveProjectRoot(input.projectRoot??'');
 const previewId='previewId' in input?input.previewId:(await previewIntegration(input)).previewId;
 const stored=await readPreview<StoredPreview&{result?:IntegrationApplyResult}>(root,previewId);
 if(!stored||stored.preview.previewId!==previewId)throw new AppError('NOT_FOUND','이 프로젝트에서 만든 SDK 미리보기를 찾을 수 없습니다.');
 validateStored(root,stored);
 if(!stored.preview.supported||stored.preview.findings.some(f=>f.severity==='error'))return failed(stored,stored.preview.supported?'failed':'unsupported');
 if(stored.request.options?.dryRun)return failed(stored,'failed',finding('apply.preview_only','미리보기 전용 요청입니다. 적용할 변경을 새로 확인해 주세요.'));
 try{return await withProjectLock(root,async()=>{
  if(stored.result){
   const record=await readApply(root,stored.result.applyId);
   if(record?.status==='committed'&&await currentHash(root,record.files)===record.afterHash)return stored.result;
   return failed(stored,'conflict',finding('apply.already_used','이미 사용한 미리보기입니다. 현재 파일로 새 미리보기를 만들어 주세요.'));
  }
  const pending=await readJournal(root);
  if(pending&&['applying','rolling_back'].includes(pending.status))return failed(stored,'conflict',finding('apply.recovery_required','중단된 SDK 적용을 먼저 복구해 주세요.'));
  if(await currentHash(root,stored.changes)!==stored.preview.beforeHash)return failed(stored,'conflict',finding('apply.concurrent_edit','미리보기 이후 원본 파일이 변경되었습니다. 새 미리보기를 확인해 주세요.'));
  const applyId=randomUUID();
  let record:JournalRecord={schema:1,previewId,applyId,status:'backing_up',projectRoot:root,engine:stored.preview.engine,platform:stored.preview.platform,provider:stored.preview.provider,beforeHash:stored.preview.beforeHash,files:stored.changes.map(f=>({path:f.path,action:f.action,beforeHash:f.previousHash??null,afterHash:f.action==='skip'?f.previousHash??undefined:f.contentHash})),createdAt:now(),updatedAt:now()};
  const journalPath=await writeJournal(root,record);
  try{
   await backupFiles(root,record);
   record={...record,status:'applying',updatedAt:now()};await writeJournal(root,record);
   for(const f of stored.changes){
    if(f.action==='skip'||f.content===undefined)continue;
    const path=await assertSafeRelative(root,f.path);
    if(await sha256File(path)!==(f.previousHash??null))throw new AppError('INTEGRATION_CONFLICT','적용 중 원본 파일이 변경되었습니다.');
    await writeTextAtomic(path,f.content,root);
   }
   const afterHash=await currentHash(root,record.files);
   if(afterHash!==combineHashes(record.files.map(f=>({path:f.path,hash:f.afterHash??f.beforeHash}))))throw new AppError('INTEGRATION_CONFLICT','적용 직후 파일 변경을 확인했습니다.');
   record={...record,status:'committed',afterHash,updatedAt:now()};await writeJournal(root,record);
   const wiring=wiringChecks({supported:true,catalog:stored.preview.catalog,changes:stored.changes,findings:stored.preview.findings},await detectProjectSdks(root),stored.preview.adUnits,stored.preview.products,['admob','applovin-max'].includes(stored.preview.provider),stored.preview.products.length>0||['play-billing','app-store'].includes(stored.preview.provider));
   const result:IntegrationApplyResult={applyId,previewId,status:'applied',afterHash:record.afterHash!,backupPath:backupDir(root,applyId),journalPath,filesWritten:stored.changes.filter(f=>f.action!=='skip').map(f=>f.path),wiring,findings:stored.preview.findings};
   await writePreview(root,previewId,{...stored,result});return result;
  }catch(error){
   // No source writes happen before all backups are complete. Do not overwrite an editor's subsequent changes.
   const wasWriting=record.status==='applying'||record.status==='committed';let restored=!wasWriting;
   if(wasWriting){record={...record,status:'rolling_back',updatedAt:now()};await writeJournal(root,record);restored=await restoreFiles(root,record);}
   record={...record,status:restored?'failed':'rollback_conflict',updatedAt:now()};await writeJournal(root,record);
   return {...failed(stored,'failed',finding(restored?'apply.failed_rolled_back':'apply.rollback_conflict',restored?'적용에 실패해 원본을 보존하거나 복구했습니다. '+(error as Error).message:'적용 중 외부 편집을 발견했습니다. 원본 백업을 보존하고 자동 덮어쓰기를 중단했습니다.')),applyId,journalPath,backupPath:backupDir(root,applyId)};
  }
 });}catch(error){if(error instanceof PathGuardError&&error.code==='apply.locked')return failed(stored,'conflict',finding(error.code,error.message));throw error;}
}
export async function rollbackIntegration(applyId:string,projectRoot:string):Promise<IntegrationRollbackResult>{
 const root=await resolveProjectRoot(projectRoot);
 return withProjectLock(root,async()=>{
  const record=await readApply(root,applyId);
  if(!record||record.projectRoot!==root||record.applyId!==applyId)return {applyId,status:'failed',findings:[finding('rollback.not_found','이 프로젝트의 SDK 적용 기록을 찾을 수 없습니다.')]};
  if(record.status==='rolled_back')return {applyId,status:'noop',restoredHash:record.beforeHash,findings:[]};
  if(record.status==='backing_up'){await writeJournal(root,{...record,status:'failed',updatedAt:now()});return {applyId,status:'noop',restoredHash:record.beforeHash,findings:[]};}
  await writeJournal(root,{...record,status:'rolling_back',updatedAt:now()});
  const restored=await restoreFiles(root,record);
  await writeJournal(root,{...record,status:restored?'rolled_back':'rollback_conflict',updatedAt:now()});
  return restored?{applyId,status:'rolled_back',restoredHash:record.beforeHash,findings:[]}:{applyId,status:'conflict',findings:[finding('rollback.concurrent_edit','적용 후 변경한 파일은 덮어쓰지 않습니다. 보존된 백업과 현재 파일을 확인해 주세요.')]};
 });
}
export async function recoverIncomplete(projectRoot:string):Promise<IntegrationRollbackResult|null>{
 const root=await resolveProjectRoot(projectRoot);const record=await readJournal(root);
 if(!record?.applyId||!['applying','backing_up','rolling_back','rollback_conflict'].includes(record.status))return null;
 return rollbackIntegration(record.applyId,root);
}
