import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AppError } from '../domain/errors.js';

const active = new AsyncLocalStorage<{projectRoot:string;directory:string}>();
const contains=(a:string,b:string)=>a===b||b.startsWith(a+sep);
/** Journal contents are instructions. Keep them in controller-owned storage, outside untrusted projects. */
export async function withIntegrationStorage<T>(projectRoot:string,directory:string,fn:()=>Promise<T>):Promise<T> {
  const project=await realpath(projectRoot);
  if(!isAbsolute(directory))throw new AppError('INTEGRATION_STORAGE','SDK 이력에는 운영 데이터의 절대 경로가 필요합니다.');
  const storage=resolve(directory);
  if(contains(project,storage)||contains(storage,project))throw new AppError('INTEGRATION_STORAGE','SDK 이력과 원본 프로젝트의 경로가 겹칩니다.');
  // Walk before mkdir so even an intermediate symlink cannot create files outside the owned tree.
  const parts=storage.split(sep);let current=storage.startsWith(sep)?sep:parts.shift()!+sep;
  for(const part of parts.filter(Boolean)){
    current=resolve(current,part);
    try{const st=await lstat(current);if(st.isSymbolicLink()||!st.isDirectory())throw new AppError('INTEGRATION_STORAGE','SDK 이력 경로의 링크·특수 파일을 허용하지 않습니다.');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await mkdir(current,{mode:0o700});}
  }
  if(await realpath(storage)!==storage)throw new AppError('INTEGRATION_STORAGE','SDK 이력 경로가 바뀌었습니다.');
  return active.run({projectRoot:project,directory:storage},fn);
}
export function integrationStorage(root:string):string {
  const context=active.getStore();
  if(!context||relative(context.projectRoot,root)!=='')throw new AppError('INTEGRATION_STORAGE','SDK 적용은 프로젝트에 연결된 운영 이력 저장소 안에서 시작해야 합니다.');
  return context.directory;
}
