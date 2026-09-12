import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import { createReadStream, openSync, writeSync, closeSync, chmodSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { crc32 } from 'node:zlib';
import { AppError } from '../domain/errors.js';

export const ZIP_LIMITS={archive:2*1024**3,total:8*1024**3,file:2*1024**3,entries:100_000};
interface Entry { name:string;size:number;directory:boolean;executable:boolean;crc:number }
function pathName(name:string):string {
  if(!name||name.length>2048||name.includes('\\')||name.includes('\0')||name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.replace(/\/$/,'').split('/').some(p=>!p||p==='..'||p==='.'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))||/[<>:"|?*\x00-\x1f]/.test(name))throw new AppError('UNSAFE_ARCHIVE','압축 파일에 안전하지 않은 경로가 있습니다.');
  return name;
}
/** Inspect the central directory before touching the extraction tree. ZIP64 and special files are rejected. */
export async function inspectZip(path:string):Promise<Entry[]> {
 const file=await open(path,'r');try{
  const size=(await file.stat()).size;if(size<22||size>ZIP_LIMITS.archive)throw new AppError('ARCHIVE_LIMIT','설치 압축 파일 크기를 확인해 주세요.');
  const tail=Buffer.alloc(Math.min(size,65557));await file.read(tail,0,tail.length,size-tail.length);
  let end=-1;for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
  if(end<0)throw new AppError('INVALID_ARCHIVE','ZIP 끝 정보를 읽을 수 없습니다.');
  const count=tail.readUInt16LE(end+10),bytes=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
  if(tail.readUInt16LE(end+4)!==0||tail.readUInt16LE(end+6)!==0||tail.readUInt16LE(end+8)!==count||count===0xffff||bytes===0xffffffff||offset===0xffffffff||count>ZIP_LIMITS.entries||bytes>32*1024**2||offset+bytes>size-tail.length+end)throw new AppError('INVALID_ARCHIVE','분할·ZIP64 또는 과도한 압축 파일은 지원하지 않습니다.');
  const central=Buffer.alloc(bytes);const read=await file.read(central,0,bytes,offset);if(read.bytesRead!==bytes)throw new AppError('INVALID_ARCHIVE','ZIP 목록이 잘렸습니다.');
  const entries:Entry[]=[];const paths=new Set<string>();let at=0,total=0;
  for(let i=0;i<count;i++){
   if(at+46>bytes||central.readUInt32LE(at)!==0x02014b50)throw new AppError('INVALID_ARCHIVE','ZIP 목록 형식이 잘못되었습니다.');
   const flags=central.readUInt16LE(at+8),method=central.readUInt16LE(at+10),length=central.readUInt32LE(at+24),n=central.readUInt16LE(at+28),x=central.readUInt16LE(at+30),c=central.readUInt16LE(at+32),mode=central.readUInt32LE(at+38)>>>16;
   if(at+46+n+x+c>bytes||flags&1||![0,8].includes(method)||length>ZIP_LIMITS.file)throw new AppError('INVALID_ARCHIVE','암호화되었거나 지원하지 않는 ZIP 항목입니다.');
   const name=pathName(central.subarray(at+46,at+46+n).toString('utf8'));const directory=name.endsWith('/');const normalized=name.replace(/\/$/,'').normalize('NFC').toLowerCase();
   if(!normalized||paths.has(normalized)||(mode&0o170000)&&!([0o100000,0o040000].includes(mode&0o170000)))throw new AppError('UNSAFE_ARCHIVE','중복 경로·링크·특수 파일이 있는 압축 파일입니다.');
   paths.add(normalized);total+=length;if(total>ZIP_LIMITS.total)throw new AppError('ARCHIVE_LIMIT','압축 해제 크기가 설치 한도를 넘습니다.');
   entries.push({name,size:length,directory,executable:Boolean(mode&0o111),crc:central.readUInt32LE(at+16)});at+=46+n+x+c;
  }
  if(at!==bytes)throw new AppError('INVALID_ARCHIVE','ZIP 목록 크기가 일치하지 않습니다.');
  const byPath=new Map(entries.map(e=>[e.name.replace(/\/$/,'').normalize('NFC').toLowerCase(),e]));
  for(const e of entries){const parts=e.name.replace(/\/$/,'').normalize('NFC').toLowerCase().split('/');for(let i=1;i<parts.length;i++){const parent=parts.slice(0,i).join('/');const found=byPath.get(parent);if(found&&!found.directory)throw new AppError('UNSAFE_ARCHIVE','파일과 디렉터리 경로가 충돌합니다.');}}
  return entries;
 }finally{await file.close();}
}
/** Stream verified official ZIPs into a fresh private directory; no host command executes archive content. */
export async function extractZip(path:string,destination:string,signal?:AbortSignal):Promise<void> {
 const entries=await inspectZip(path);const expected=new Map(entries.map(e=>[e.name,e]));
 try{await lstat(destination);throw new AppError('INSTALL_EXISTS','새 설치 임시 폴더가 이미 존재합니다.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await mkdir(destination,{recursive:true,mode:0o700});const root=await realpath(destination);const descriptors=new Set<number>();let failure:unknown;const seen=new Set<string>();
 const unzip=new Unzip(file=>{
  try{
   signal?.throwIfAborted();const entry=expected.get(file.name);if(!entry||seen.has(file.name))throw new AppError('INVALID_ARCHIVE','압축 내용과 목록이 일치하지 않습니다.');seen.add(file.name);
   const output=resolve(root,pathName(file.name));const rel=relative(root,output);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new AppError('UNSAFE_ARCHIVE','설치 경로를 벗어나는 항목입니다.');
   // All parent directories were created from the validated central directory below.
   if(entry.directory){file.ondata=(error,data)=>{if(error||data.length)failure=error??new Error('Directory payload');};file.start();return;}
   const fd=openSync(output,'wx',0o600);descriptors.add(fd);let bytes=0,checksum=0;
   file.ondata=(error,data,final)=>{
    try{if(error)throw error;signal?.throwIfAborted();bytes+=data.length;checksum=crc32(data,checksum);if(bytes>entry.size)throw new AppError('ARCHIVE_LIMIT','압축 항목 크기가 목록과 다릅니다.');let offset=0;while(offset<data.length)offset+=writeSync(fd,data,offset,data.length-offset);if(final){if(bytes!==entry.size||checksum!==entry.crc)throw new AppError('INVALID_ARCHIVE','압축 항목의 크기 또는 CRC가 일치하지 않습니다.');closeSync(fd);descriptors.delete(fd);chmodSync(output,entry.executable?0o700:0o600);}}catch(e){failure=e;file.terminate();}
   };file.start();
  }catch(e){failure=e;file.terminate();}
 });unzip.register(UnzipInflate);
 try{
  for(const entry of entries){signal?.throwIfAborted();await mkdir(entry.directory?join(root,entry.name):dirname(join(root,entry.name)),{recursive:true,mode:0o700});}
  for await(const chunk of createReadStream(path,{highWaterMark:64*1024})){signal?.throwIfAborted();unzip.push(new Uint8Array(chunk as Buffer),false);if(failure)throw failure;}
  unzip.push(new Uint8Array(),true);if(failure)throw failure;if(seen.size!==expected.size||descriptors.size)throw new AppError('INVALID_ARCHIVE','압축 파일 일부가 누락되거나 잘렸습니다.');
 }finally{for(const fd of descriptors)try{closeSync(fd);}catch{}}
}
