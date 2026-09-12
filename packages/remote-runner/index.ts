import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { AppError, object, text } from '../domain/errors.js';
import { isSecretFile } from '../../apps/runner/secrets.js';
import { isExcludedDirectory } from '../../apps/runner/excludes.js';

export const MAX_BUNDLE_BYTES=256*1024*1024;
export interface BundleFile { path:string; data:string; executable:boolean; sha256:string }
export interface Bundle { files:BundleFile[] }
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
export function bundlePath(path:string):string {
  if(!path||path.length>4096||path.includes('\\')||path.includes('\0')||path.includes(':')||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.endsWith(' ')||p.endsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw new AppError('INVALID_BUNDLE','전송 파일의 상대 경로가 올바르지 않습니다.');return path;
}
export async function packFiles(root:string,excludeSecrets=true):Promise<Bundle> {
  const files:BundleFile[]=[];let size=0;
  async function visit(path:string):Promise<void> {
    const rel=relative(root,path).split('\\').join('/');const info=await lstat(path);
    if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw new AppError('INVALID_BUNDLE','심볼릭 링크와 특수 파일은 원격 러너에 전송하지 않습니다.');
    if(info.isDirectory()){for(const name of (await readdir(path)).sort()){const r=rel?rel+'/'+name:name;if(excludeSecrets&&(isSecretFile(r)||isExcludedDirectory(r)))continue;await visit(join(path,name));}return;}
    bundlePath(rel);size+=info.size;if(size>MAX_BUNDLE_BYTES||files.length>=100_000)throw new AppError('BUNDLE_LIMIT','원격 전송은 한 작업당 256 MiB·100,000개 파일까지 지원합니다.',413);
    const bytes=await readFile(path);files.push({path:rel,data:bytes.toString('base64'),executable:Boolean(info.mode&0o111),sha256:sha(bytes)});
  }
  await visit(root);return {files};
}
export async function unpackFiles(input:unknown,destination:string,excludeSecrets=true):Promise<void> {
  const bundle=object(input);if(!Array.isArray(bundle.files)||bundle.files.length>100_000)throw new AppError('INVALID_BUNDLE','전송 파일 목록이 올바르지 않습니다.');
  let size=0;const validated:{path:string;bytes:Buffer;executable:boolean}[]=[];const seen=new Set<string>();
  for(const item of bundle.files){const f=object(item);const path=bundlePath(text(f.path,'파일 경로',4096));
    if(seen.has(path.toLowerCase()))throw new AppError('INVALID_BUNDLE','중복된 파일 이름입니다.');seen.add(path.toLowerCase());
    if(excludeSecrets&&(isSecretFile(path)||path.split('/').some((_,i,a)=>isExcludedDirectory(a.slice(0,i+1).join('/')))))throw new AppError('SECRET_IN_BUNDLE','전송 묶음에 비밀 또는 제외 경로가 있습니다.');
    if(typeof f.data!=='string'||f.data.length>MAX_BUNDLE_BYTES*1.4||(f.data.length%4!==0||/[^A-Za-z0-9+/=]/.test(f.data)||f.data.indexOf('=')!==-1&&f.data.indexOf('=')<f.data.length-2))throw new AppError('INVALID_BUNDLE','전송 파일 인코딩이 올바르지 않습니다.');
    const bytes=Buffer.from(f.data,'base64');if(bytes.toString('base64')!==f.data)throw new AppError('INVALID_BUNDLE','전송 파일 인코딩이 올바르지 않습니다.');size+=bytes.length;if(size>MAX_BUNDLE_BYTES)throw new AppError('BUNDLE_LIMIT','원격 전송 크기 한도를 넘었습니다.',413);
    if(sha(bytes)!==f.sha256)throw new AppError('BUNDLE_DAMAGED','전송 파일 해시가 일치하지 않습니다.');
    validated.push({path,bytes,executable:f.executable===true});
  }
  await mkdir(destination,{recursive:true,mode:0o700});
  for(const f of validated){const path=join(destination,f.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,f.bytes,{flag:'wx',mode:f.executable?0o700:0o600});await chmod(path,f.executable?0o700:0o600);}
}
export async function boundedJson(response:Response):Promise<Record<string,unknown>> {
  if(!response.body)throw new AppError('RUNNER_RESPONSE','러너가 응답하지 않았습니다.',502);
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>MAX_BUNDLE_BYTES*1.5){await reader.cancel();throw new AppError('BUNDLE_LIMIT','러너 응답 크기 한도를 넘었습니다.',413);}chunks.push(item.value);}}
  finally{reader.releaseLock();}
  try{return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{throw new AppError('RUNNER_RESPONSE','러너 응답 형식이 올바르지 않습니다.',502);}
}
