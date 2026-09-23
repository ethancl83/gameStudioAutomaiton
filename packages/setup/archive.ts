import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import { createReadStream, openSync, writeSync, closeSync, chmodSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import { AppError } from '../domain/errors.js';

export const ZIP_LIMITS={archive:2*1024**3,total:8*1024**3,file:2*1024**3,entries:100_000};
interface Entry { name:string;size:number;directory:boolean;executable:boolean;crc:number; compressedSize:number; dataOffset:number; localOffset:number; method:number }
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
   const compressedSize=central.readUInt32LE(at+20),localOffset=central.readUInt32LE(at+42),crc=central.readUInt32LE(at+16);
   if(compressedSize===0xffffffff||localOffset===0xffffffff||central.readUInt16LE(at+34)!==0||localOffset+30>offset||directory&&length!==0)throw new AppError('INVALID_ARCHIVE','ZIP 항목 범위가 올바르지 않습니다.');
   const local=Buffer.alloc(30);
   if((await file.read(local,0,30,localOffset)).bytesRead!==30||local.readUInt32LE(0)!==0x04034b50||local.readUInt16LE(6)!==flags||local.readUInt16LE(8)!==method)throw new AppError('INVALID_ARCHIVE','ZIP 로컬 헤더와 목록이 일치하지 않습니다.');
   const localNameLength=local.readUInt16LE(26),dataOffset=localOffset+30+localNameLength+local.readUInt16LE(28);
   if(localNameLength!==n||dataOffset+compressedSize>offset)throw new AppError('INVALID_ARCHIVE','ZIP 항목이 목록 범위를 벗어납니다.');
   const localName=Buffer.alloc(localNameLength);
   if((await file.read(localName,0,localNameLength,localOffset+30)).bytesRead!==localNameLength||!localName.equals(central.subarray(at+46,at+46+n)))throw new AppError('INVALID_ARCHIVE','ZIP 파일명이 목록과 다릅니다.');
   // Data-descriptor archives legitimately leave local sizes/CRC at zero.
   if(!(flags&8)&&(local.readUInt32LE(14)!==crc||local.readUInt32LE(18)!==compressedSize||local.readUInt32LE(22)!==length))throw new AppError('INVALID_ARCHIVE','ZIP 항목 크기 또는 CRC 헤더가 다릅니다.');
   if(method===0&&compressedSize!==length)throw new AppError('INVALID_ARCHIVE','저장 ZIP 항목 크기가 다릅니다.');
   entries.push({name,size:length,directory,executable:Boolean(mode&0o111),crc,compressedSize,dataOffset,localOffset,method});at+=46+n+x+c;
  }
  if(at!==bytes)throw new AppError('INVALID_ARCHIVE','ZIP 목록 크기가 일치하지 않습니다.');
  const ranges=[...entries].sort((a,b)=>a.localOffset-b.localOffset);
  for(let i=1;i<ranges.length;i++)if(ranges[i]!.localOffset<ranges[i-1]!.dataOffset+ranges[i-1]!.compressedSize)throw new AppError('INVALID_ARCHIVE','ZIP 항목 범위가 겹칩니다.');
  const byPath=new Map(entries.map(e=>[e.name.replace(/\/$/,'').normalize('NFC').toLowerCase(),e]));
  for(const e of entries){const parts=e.name.replace(/\/$/,'').normalize('NFC').toLowerCase().split('/');for(let i=1;i<parts.length;i++){const parent=parts.slice(0,i).join('/');const found=byPath.get(parent);if(found&&!found.directory)throw new AppError('UNSAFE_ARCHIVE','파일과 디렉터리 경로가 충돌합니다.');}}
  return entries;
 }finally{await file.close();}
}
/** Extract the exact central-directory ranges: streaming header scans can mistake embedded JARs for outer entries. */
export async function extractZip(path: string, destination: string, signal?: AbortSignal): Promise<void> {
  const entries = await inspectZip(path);
  signal?.throwIfAborted();
  try {
    await lstat(destination);
    throw new AppError('INSTALL_EXISTS', '새 설치 임시 폴더가 이미 존재합니다.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const root = await realpath(destination);
  for (const entry of entries) {
    signal?.throwIfAborted();
    const output = resolve(root, entry.name);
    const rel = relative(root, output);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new AppError('UNSAFE_ARCHIVE', '설치 경로를 벗어나는 항목입니다.');
    await mkdir(entry.directory ? output : dirname(output), { recursive: true, mode: 0o700 });
    const fd = entry.directory ? undefined : openSync(output, 'wx', 0o600);
    const source = entry.compressedSize === 0 ? Readable.from([]) : createReadStream(path, {
      start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1, highWaterMark: 64 * 1024,
    });
    const inflate = entry.method === 8 ? createInflateRaw() : undefined;
    let bytes = 0, checksum = 0;
    const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
      try {
        signal?.throwIfAborted();
        bytes += chunk.length;
        if (bytes > entry.size) throw new AppError('ARCHIVE_LIMIT', '압축 항목 크기가 목록과 다릅니다.');
        checksum = crc32(chunk, checksum);
        if (fd !== undefined) {
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
        }
        callback();
      } catch (error) { callback(error as Error); }
    }});
    try {
      if (inflate) await pipeline(source, inflate, sink, { signal });
      else await pipeline(source, sink, { signal });
      if (bytes !== entry.size || checksum !== entry.crc || inflate && inflate.bytesWritten !== entry.compressedSize) {
        throw new AppError('INVALID_ARCHIVE', '압축 항목의 크기 또는 CRC가 일치하지 않습니다.');
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (!entry.directory) chmodSync(output, entry.executable ? 0o700 : 0o600);
  }
}
