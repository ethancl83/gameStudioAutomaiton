import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { AppError } from '../domain/errors.js';
import { attribute, type JsonApiResource } from './store-jsonapi.js';
import type { VerifiedArtifact } from './types.js';

export interface AppleUploadOperation {method:'PUT'|'POST';url:string;offset:number;length:number;requestHeaders:Record<string,string>}
export function parseAppleUploadOperations(resource:JsonApiResource,size:number):AppleUploadOperation[]{
  const raw=attribute(resource,'uploadOperations');
  const invalid=()=>new AppError('INVALID_PROVIDER_RESPONSE','업로드 지시의 메서드·범위·파일 크기가 올바르지 않습니다.',502);
  if(!Number.isSafeInteger(size)||size<=0||!Array.isArray(raw)||!raw.length||raw.length>4096)throw invalid();
  const result:AppleUploadOperation[]=raw.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
    const item=value as Record<string,unknown>,offset=Number(item.offset),length=Number(item.length);
    if(!['PUT','POST'].includes(String(item.method))||typeof item.url!=='string'||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<=0||offset+length>size)throw invalid();
    const url=new URL(item.url);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443')throw invalid();
    const requestHeaders:Record<string,string>={},names=new Set<string>();
    if(!Array.isArray(item.requestHeaders)||item.requestHeaders.length>64)throw invalid();
    for(const header of item.requestHeaders){
      if(!header||typeof header!=='object'||typeof header.name!=='string'||typeof header.value!=='string'||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)||/[\r\n\0]/.test(header.value)||header.value.length>8192)throw invalid();
      const name=header.name.toLowerCase();if(names.has(name)||['authorization','proxy-authorization','cookie','host'].includes(name))throw invalid();
      if(name==='content-length'&&Number(header.value)!==length)throw invalid();
      names.add(name);requestHeaders[header.name]=header.value;
    }
    return {method:item.method as 'PUT'|'POST',url:item.url,offset,length,requestHeaders};
  });
  let position=0;for(const part of [...result].sort((a,b)=>a.offset-b.offset)){if(part.offset!==position)throw invalid();position+=part.length;}
  if(position!==size)throw invalid();return result;
}

export async function openVerifiedAppleArtifact(artifact:VerifiedArtifact,signal:AbortSignal):Promise<FileHandle>{
  const file=await open(artifact.path,constants.O_RDONLY|constants.O_NOFOLLOW);let valid=false;
  try{
    const info=await file.stat();if(!info.isFile()||!Number.isSafeInteger(artifact.size)||artifact.size<=0||info.size!==artifact.size||artifact.size>64*1024**3)throw new AppError('ARTIFACT_CHANGED','등록한 결과물의 크기나 파일 형식이 변경되었습니다.',409);
    const hash=createHash('sha256');let read=0;
    for await(const chunk of file.createReadStream({autoClose:false,start:0})){signal.throwIfAborted();read+=(chunk as Buffer).length;hash.update(chunk as Buffer);}
    if(read!==artifact.size||hash.digest('hex')!==artifact.sha256)throw new AppError('ARTIFACT_CHANGED','등록한 결과물의 해시가 일치하지 않습니다.',409);
    valid=true;return file;
  }finally{if(!valid)await file.close();}
}
export async function applePartBody(file:FileHandle,part:AppleUploadOperation):Promise<BodyInit>{
  if(part.length>16*1024**2)return Readable.toWeb(file.createReadStream({start:part.offset,end:part.offset+part.length-1,autoClose:false})) as unknown as ReadableStream;
  const bytes=Buffer.alloc(part.length);let offset=0;
  while(offset<bytes.length){const read=await file.read(bytes,offset,bytes.length-offset,part.offset+offset);if(!read.bytesRead)throw new AppError('ARTIFACT_CHANGED','결과물 파일이 업로드 도중 잘렸습니다.',409);offset+=read.bytesRead;}
  return new Uint8Array(bytes);
}
