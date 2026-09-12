import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rm, type FileHandle } from 'node:fs/promises';
import { AppError } from '../domain/errors.js';

const MAGIC = Buffer.from('APPOPSB1');
const CHUNK = 1024 * 1024;
const ENTRY_CONTEXT = Buffer.from('entry');
export const BACKUP_LIMITS = {file:64 * 1024 ** 3,total:512 * 1024 ** 3,entries:100_000,metadata:64 * 1024};
type Kind = 'manifest' | 'database' | 'data' | 'vault';
// `data` and `file` are mutually exclusive: exactly one source per entry (enforced below).
export interface BackupEntry {kind:Kind;path:string;file?:string;data?:Buffer}
export interface BackupEntryMetadata {kind:Kind;path:string;size:number;sha256:string;executable?:boolean}
// `abort` (optional) lets a caller writing to a staging file close its handle and drop the
// partial file when readBackup fails mid-entry; readBackup invokes it from a catch around the loop.
export interface BackupEntrySink {write(data:Buffer):Promise<void>;finish():Promise<void>;abort?():Promise<void>}
export interface ArchiveSummary {entries:number;bytes:number}
// Optional trailing options keep the positional API stable for existing callers.
export interface ArchiveOptions {signal?:AbortSignal}

// scrypt work factors keyed by archive schema. schema 2 is written; schema 1 stays readable so
// pre-release archives keep opening. p is raised (not N) so memory stays at 32 MiB under the 64 MiB
// maxmem cap while the cost clears the OWASP minimum. OWASP Password Storage Cheat Sheet lists the
// scrypt minimum as N=2^17,r=8,p=1 with the equivalent-strength alternative N=2^15,r=8,p=3 (used here).
const KDF: Record<number, {N:number;r:number;p:number}> = {
  1: {N:32768, r:8, p:1},
  2: {N:32768, r:8, p:3},
};
const WRITE_SCHEMA = 2;

function invalid(message='백업 파일의 인증·형식·무결성 확인에 실패했습니다.'):AppError {
  return new AppError('BACKUP_INVALID',message,422);
}
// Never carries a host path: raw filesystem errno from opening a source file would otherwise leak
// an absolute path to the UI and logs.
function unsafeFile(message='백업 대상 파일을 열 수 없거나 안전하지 않습니다.'):AppError {
  return new AppError('BACKUP_UNSAFE_FILE',message,422);
}
function cancelled():AppError {
  return new AppError('BACKUP_CANCELLED','백업 작업이 취소되었습니다.',499);
}
function throwIfAborted(signal?:AbortSignal):void {
  if(signal?.aborted)throw cancelled();
}
export function backupPath(path:string):string {
  if (!path || path.length > 2048 || path.includes('\\') || /[<>:"|?*\x00-\x1f\x7f]/.test(path)
    || path.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||Buffer.byteLength(p,'utf8')>255||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw invalid('백업 항목의 경로가 안전하지 않습니다.');
  return path;
}
// Bounded dedupe key: a 16-byte digest of the exact path caps the dedupe set at ~3 MB even at the
// 100k-entry / 2048-char-path limits. Case-distinct paths (Assets/ vs assets/) stay distinct so a
// case-sensitive source tree remains backupable; restore rejects case collisions on the target.
function pathKey(path:string):string {
  return createHash('sha256').update(path,'utf8').digest().subarray(0,16).toString('base64url');
}
function number(value:number):Buffer {const out=Buffer.alloc(4);out.writeUInt32BE(value);return out;}
function decode(value:unknown,length:number):Buffer {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw invalid();
  const bytes=Buffer.from(value,'base64url');if(bytes.length!==length)throw invalid();return bytes;
}
function passwordValue(value:string):void {
  if(typeof value!=='string'||value.length<12||value.length>1024)throw new AppError('BACKUP_PASSWORD','백업 암호는 12~1024자로 입력해 주세요. 이 암호는 저장하지 않습니다.');
}
async function derive(password:string,salt:Buffer,params:{N:number;r:number;p:number}):Promise<Buffer> {
  passwordValue(password);
  return new Promise((resolve,reject)=>scrypt(password,salt,32,{N:params.N,r:params.r,p:params.p,maxmem:64*1024**2},(error,key)=>error?reject(error):resolve(key)));
}
// Validate the header's schema/KDF triple against the known sets and return the parameters to derive
// with. An altered N/p or an unknown schema is rejected here.
function kdfFor(parsed:{schema?:unknown;kdf?:{name?:unknown;N?:unknown;r?:unknown;p?:unknown}}):{schema:number;N:number;r:number;p:number} {
  const kdf=parsed?.kdf;
  if(!kdf||kdf.name!=='scrypt'||kdf.r!==8)throw invalid('지원하지 않는 백업 암호화 버전입니다.');
  if(parsed.schema===1&&kdf.N===KDF[1].N&&kdf.p===KDF[1].p)return {schema:1,...KDF[1]};
  if(parsed.schema===2&&kdf.N===KDF[2].N&&kdf.p===KDF[2].p)return {schema:2,...KDF[2]};
  throw invalid('지원하지 않는 백업 암호화 버전입니다.');
}
function seal(key:Buffer,nonce:Buffer,aad:Buffer,data:Buffer):{bytes:Buffer;tag:Buffer} {
  const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
  return {bytes:Buffer.concat([cipher.update(data),cipher.final()]),tag:cipher.getAuthTag()};
}
function unseal(key:Buffer,nonce:Buffer,aad:Buffer,data:Buffer,tag:Buffer):Buffer {
  try{const cipher=createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);cipher.setAuthTag(tag);return Buffer.concat([cipher.update(data),cipher.final()]);}
  catch{throw invalid('백업 암호가 일치하지 않거나 백업 파일이 변경되었습니다.');}
}
async function write(file:FileHandle,data:Buffer):Promise<void>{
  let offset=0;while(offset<data.length){const r=await file.write(data,offset,data.length-offset);if(!r.bytesWritten)throw invalid();offset+=r.bytesWritten;}
}
async function read(file:FileHandle,length:number):Promise<Buffer>{
  const bytes=Buffer.alloc(length);let offset=0;while(offset<length){const r=await file.read(bytes,offset,length-offset);if(!r.bytesRead)throw invalid('백업 파일이 중간에 잘렸습니다.');offset+=r.bytesRead;}return bytes;
}
async function* input(entry:BackupEntry):AsyncGenerator<Buffer>{
  // Exactly one source: mixing data+file would produce metadata from one and bytes from the other.
  if(entry.data!==undefined&&entry.file!==undefined)throw invalid('백업 항목에 data와 file을 동시에 지정할 수 없습니다.');
  if(entry.data!==undefined){for(let at=0;at<entry.data.length;at+=CHUNK)yield entry.data.subarray(at,at+CHUNK);return;}
  if(!entry.file)throw invalid();
  let file:FileHandle;
  try{file=await open(entry.file,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch{throw unsafeFile();}
  try{const info=await file.stat();if(!info.isFile()||info.size>BACKUP_LIMITS.file)throw invalid('백업 파일 크기·종류를 확인해 주세요.');
    for await(const chunk of file.createReadStream({autoClose:false,highWaterMark:CHUNK}))yield Buffer.from(chunk as Buffer);
  }finally{await file.close();}
}
async function describe(entry:BackupEntry):Promise<BackupEntryMetadata>{
  if(entry.data!==undefined&&entry.file!==undefined)throw invalid('백업 항목에 data와 file을 동시에 지정할 수 없습니다.');
  backupPath(entry.path);let size=0;const hash=createHash('sha256');
  for await(const bytes of input(entry)){size+=bytes.length;if(size>BACKUP_LIMITS.file)throw invalid();hash.update(bytes);}
  let executable=false;
  if(entry.file){try{executable=Boolean((await lstat(entry.file)).mode&0o111);}catch{throw unsafeFile('백업 대상 파일 정보를 확인할 수 없습니다.');}}
  return {kind:entry.kind,path:entry.path,size,sha256:hash.digest('hex'),executable};
}

/** Streaming envelope encryption: only encrypted frames are written to disk. */
export async function writeBackup(path:string,password:string,entries:AsyncIterable<BackupEntry>|Iterable<BackupEntry>,options:ArchiveOptions={}):Promise<ArchiveSummary>{
  const signal=options.signal;throwIfAborted(signal);
  passwordValue(password);
  const salt=randomBytes(16),prefix=randomBytes(8),wrapNonce=randomBytes(12),key=randomBytes(32);
  let file:FileHandle|undefined,complete=false;
  try{
    const params=KDF[WRITE_SCHEMA];
    const base={schema:WRITE_SCHEMA,kdf:{name:'scrypt',N:params.N,r:params.r,p:params.p,salt:salt.toString('base64url')},fileNonce:prefix.toString('base64url')};
    throwIfAborted(signal);
    const kek=await derive(password,salt,params);let wrapped;
    try{wrapped=seal(kek,wrapNonce,Buffer.from(JSON.stringify(base)),key);}finally{kek.fill(0);}
    const header=Buffer.from(JSON.stringify({...base,wrapped:{nonce:wrapNonce.toString('base64url'),key:wrapped.bytes.toString('base64url'),tag:wrapped.tag.toString('base64url')}}));
    const headerHash=createHash('sha256').update(header).digest();
    throwIfAborted(signal);
    // open() is inside the try but uses 'wx' (exclusive create); on EEXIST `file` stays undefined so
    // the cleanup below never deletes a pre-existing file, only one we created.
    file=await open(path,'wx',0o600);const handle=file;
    let counter=0;const summary={entries:0,bytes:0};const seen=new Set<string>();let hasDatabase=false;
    const frame=async(data:Buffer,context:Buffer)=>{
      throwIfAborted(signal);
      if(counter===0xffffffff)throw invalid('백업 프레임 한도를 넘습니다.');
      const index=number(counter++);const value=seal(key,Buffer.concat([prefix,index]),Buffer.concat([MAGIC,headerHash,index,context]),data);
      await write(handle,Buffer.concat([number(value.bytes.length),value.bytes,value.tag]));
    };
    await write(handle,Buffer.concat([MAGIC,number(header.length),header]));
    for await(const entry of entries){
      throwIfAborted(signal);
      const metadata=await describe(entry);const dedupe=pathKey(metadata.path);
      if(seen.has(dedupe)||++summary.entries>BACKUP_LIMITS.entries)throw invalid('백업 항목이 중복되었거나 너무 많습니다.');seen.add(dedupe);
      summary.bytes+=metadata.size;if(summary.bytes>BACKUP_LIMITS.total)throw invalid('백업 크기가 한도를 넘습니다.');
      // Fail loud at write time on the same structural invariants readBackup enforces: entry 1 is the
      // manifest at manifest.json, no other manifest, and exactly one database at operations.sqlite.
      if(summary.entries===1?(metadata.kind!=='manifest'||metadata.path!=='manifest.json'):metadata.kind==='manifest')throw invalid('백업 구조가 올바르지 않습니다(매니페스트).');
      if(metadata.kind==='database'){if(hasDatabase||metadata.path!=='operations.sqlite')throw invalid('백업 구조가 올바르지 않습니다(데이터베이스).');hasDatabase=true;}
      const encoded=Buffer.from(JSON.stringify({type:'entry',...metadata}));await frame(encoded,ENTRY_CONTEXT);
      const context=createHash('sha256').update(encoded).digest();const hash=createHash('sha256');let size=0,part=0;
      for await(const bytes of input(entry)){size+=bytes.length;hash.update(bytes);await frame(bytes,Buffer.concat([context,number(part++)]));}
      if(size!==metadata.size||hash.digest('hex')!==metadata.sha256)throw invalid('백업 도중 파일이 변경되었습니다. 다시 시도해 주세요.');
    }
    if(!hasDatabase)throw invalid('백업 구조가 올바르지 않습니다(데이터베이스 누락).');
    await frame(Buffer.from(JSON.stringify({type:'end',...summary})),ENTRY_CONTEXT);await handle.sync();complete=true;return summary;
  }finally{key.fill(0);if(file)await file.close();if(file&&!complete)await rm(path,{force:true});}
}

/** Each entry is authenticated before finish(); the caller writes only to a fresh staging tree. */
export async function readBackup(path:string,password:string,onEntry:(metadata:BackupEntryMetadata)=>Promise<BackupEntrySink>,options:ArchiveOptions={}):Promise<ArchiveSummary>{
  const signal=options.signal;throwIfAborted(signal);
  passwordValue(password);const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let key:Buffer|undefined;
  try{
    const info=await file.stat();if(!info.isFile()||info.size>BACKUP_LIMITS.total+BACKUP_LIMITS.entries*BACKUP_LIMITS.metadata)throw invalid();
    if(!(await read(file,8)).equals(MAGIC))throw invalid('지원하는 전체 백업 파일이 아닙니다.');
    const length=(await read(file,4)).readUInt32BE();if(length>16384||length<64)throw invalid();
    const header=await read(file,length);let parsed;
    try{parsed=JSON.parse(header.toString('utf8'));}catch{throw invalid();}
    const params=kdfFor(parsed);const kdf=parsed.kdf;
    const salt=decode(kdf.salt,16),prefix=decode(parsed.fileNonce,8);
    // Reconstruct the wrap AAD byte-for-byte from the validated schema/params (same key order the
    // writer used) so any header tampering breaks the unwrap.
    const base={schema:params.schema,kdf:{name:'scrypt',N:params.N,r:params.r,p:params.p,salt:kdf.salt},fileNonce:parsed.fileNonce};
    throwIfAborted(signal);
    const kek=await derive(password,salt,params);
    try{key=unseal(kek,decode(parsed.wrapped?.nonce,12),Buffer.from(JSON.stringify(base)),decode(parsed.wrapped?.key,32),decode(parsed.wrapped?.tag,16));}finally{kek.fill(0);}
    throwIfAborted(signal);
    const headerHash=createHash('sha256').update(header).digest();let counter=0,position=12+length;
    const frame=async(context:Buffer,max:number)=>{
      throwIfAborted(signal);
      if(counter===0xffffffff)throw invalid();const size=(await read(file,4)).readUInt32BE();if(size>max)throw invalid();
      const encrypted=await read(file,size),tag=await read(file,16),index=number(counter++);position+=4+size+16;
      return unseal(key!,Buffer.concat([prefix,index]),Buffer.concat([MAGIC,headerHash,index,context]),encrypted,tag);
    };
    const summary={entries:0,bytes:0};const seen=new Set<string>();let hasDatabase=false;
    for(;;){
      const encoded=await frame(ENTRY_CONTEXT,BACKUP_LIMITS.metadata);let meta;
      try{meta=JSON.parse(encoded.toString('utf8'));}catch{throw invalid();}
      if(meta?.type==='end'){
        if(meta.entries!==summary.entries||meta.bytes!==summary.bytes||position!==info.size||!hasDatabase)throw invalid();return summary;
      }
      if(meta?.type!=='entry'||!['manifest','database','data','vault'].includes(meta.kind)||typeof meta.path!=='string'||!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>BACKUP_LIMITS.file||typeof meta.sha256!=='string'||!/^[a-f0-9]{64}$/.test(meta.sha256))throw invalid();
      if(meta.executable!==undefined&&typeof meta.executable!=='boolean')throw invalid();
      backupPath(meta.path);const dedupe=pathKey(meta.path);
      if(seen.has(dedupe)||++summary.entries>BACKUP_LIMITS.entries)throw invalid();seen.add(dedupe);summary.bytes+=meta.size;
      if(summary.bytes>BACKUP_LIMITS.total)throw invalid();
      if(summary.entries===1?(meta.kind!=='manifest'||meta.path!=='manifest.json'):meta.kind==='manifest')throw invalid();
      if(meta.kind==='database'){if(hasDatabase||meta.path!=='operations.sqlite')throw invalid();hasDatabase=true;}
      const sink=await onEntry(meta);
      try{
        let remaining=meta.size,part=0;const context=createHash('sha256').update(encoded).digest(),hash=createHash('sha256');
        while(remaining){const bytes=await frame(Buffer.concat([context,number(part++)]),Math.min(CHUNK,remaining));if(!bytes.length)throw invalid();hash.update(bytes);remaining-=bytes.length;await sink.write(bytes);}
        if(hash.digest('hex')!==meta.sha256)throw invalid('백업 항목의 해시가 일치하지 않습니다.');await sink.finish();
      }catch(error){try{await sink.abort?.();}catch{/* best effort: never mask the original failure */}throw error;}
    }
  }finally{key?.fill(0);await file.close();}
}
