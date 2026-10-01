import {randomUUID,createHash}from'node:crypto';import{mkdir,writeFile,rm,open,lstat,realpath,chmod}from'node:fs/promises';import{join,extname,isAbsolute,basename,sep}from'node:path';
import type{MediaAsset}from'../../packages/domain/index.js';import{AppError,object,text}from'../../packages/domain/errors.js';import type{Store}from'../../packages/storage/index.js';import type{VerifiedArtifact}from'../../packages/connectors/types.js';
const MAX=15*1024*1024;
function mime(bytes:Buffer):string{
 if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0)return'image/png';
 if(bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9)return'image/jpeg';
 if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return'image/webp';
 if(bytes.length>=6&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return'image/gif';
 // ISO BMFF: 첫 box가 ftyp이어야 한다. QuickTime 브랜드만 MOV로, 나머지는 MP4로 본다.
 if(bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp')return bytes.toString('ascii',8,12)==='qt  '?'video/quicktime':'video/mp4';
 throw new AppError('INVALID_IMAGE','PNG·JPEG·WebP·GIF 이미지 또는 MP4·MOV 동영상을 선택해 주세요.');
}
/** 앱 프리뷰처럼 JSON 본문 한도(15 MiB)를 넘는 동영상은 사용자가 고른 로컬 파일 경로에서 스트리밍 복사한다. */
const VIDEO_MAX=500*1024*1024;
async function addMediaFromPath(store:Store,projectId:string,raw:unknown,protectedRoots:string[]):Promise<MediaAsset>{
 const source=text(raw,'미디어 파일 경로',4096);if(!isAbsolute(source))throw new AppError('INVALID_IMAGE','미디어 파일의 전체 경로를 입력해 주세요.');
 const real=await realpath(source).catch(()=>source);if(protectedRoots.some(root=>real===root||real.startsWith(root+sep)))throw new AppError('PROTECTED_DIRECTORY','앱 운영 데이터·보관함·백업 폴더의 파일은 등록할 수 없습니다.');
 const info=await lstat(source).catch(()=>{throw new AppError('NOT_FOUND','미디어 파일을 찾을 수 없습니다.',404);});
 if(info.isSymbolicLink()||!info.isFile())throw new AppError('INVALID_IMAGE','일반 미디어 파일만 등록할 수 있습니다.');
 const name=basename(source);if(/[\\/\x00-\x1f:]/.test(name))throw new AppError('INVALID_IMAGE','미디어 파일 이름을 확인해 주세요.');
 const handle=await open(source,'r');
 try{
  const head=Buffer.alloc(Math.min(64,info.size));await handle.read(head,0,head.length,0);
  const mimeType=head.length>=12&&head.toString('ascii',4,8)==='ftyp'?(head.toString('ascii',8,12)==='qt  '?'video/quicktime':'video/mp4'):'';
  const ext=extname(name).toLowerCase();
  if(!(mimeType==='video/mp4'&&['.mp4','.m4v'].includes(ext)||mimeType==='video/quicktime'&&ext==='.mov'))throw new AppError('INVALID_IMAGE','경로 등록은 MP4·MOV 동영상만 지원합니다. 이미지는 파일 선택으로 등록해 주세요.');
  if(info.size>VIDEO_MAX)throw new AppError('INVALID_IMAGE','동영상은 500 MiB 이하만 등록할 수 있습니다.');
  const asset:MediaAsset={id:randomUUID(),projectId,name,mimeType,size:0,sha256:'',createdAt:new Date().toISOString()};
  const root=join(store.directory,'media',asset.id);await mkdir(root,{recursive:true,mode:0o700});
  const hash=createHash('sha256');let size=0;
  try{
   const target=await open(join(root,name),'wx',0o600);
   try{for await(const chunk of handle.createReadStream({autoClose:false,start:0})){const bytes=chunk as Buffer;size+=bytes.length;if(size>VIDEO_MAX)throw new AppError('INVALID_IMAGE','복사 중 파일이 커졌습니다.');hash.update(bytes);await target.write(bytes);}await target.sync();}finally{await target.close();}
   await chmod(join(root,name),0o400);
   const value={...asset,size,sha256:hash.digest('hex')};
   store.writeBatch([{kind:'media',id:value.id,value}],[],[{projectId,kind:'media.imported',message:name+' 동영상을 등록했습니다.',data:{assetId:value.id,size}}]);return value;
  }catch(error){await rm(root,{recursive:true,force:true});throw error;}
 }finally{await handle.close();}
}
export async function addMedia(store:Store,input:unknown,protectedRoots:string[]=[]):Promise<MediaAsset>{
 const body=object(input);
 if(body.path!==undefined){const projectId=text(body.projectId,'프로젝트 ID',100);if(!store.get('project',projectId))throw new AppError('NOT_FOUND','프로젝트를 찾을 수 없습니다.',404);return addMediaFromPath(store,projectId,body.path,protectedRoots);}const projectId=text(body.projectId,'프로젝트 ID',100);if(!store.get('project',projectId))throw new AppError('NOT_FOUND','프로젝트를 찾을 수 없습니다.',404);
 const name=text(body.name,'이미지 이름',200);if(/[\\/\x00-\x1f:]/.test(name)||name==='.'||name==='..')throw new AppError('INVALID_IMAGE','이미지 파일 이름을 확인해 주세요.');
 const encoded=text(body.base64,'이미지',MAX*1.4);const bytes=Buffer.from(encoded,'base64');if(bytes.length>MAX||bytes.toString('base64')!==encoded)throw new AppError('INVALID_IMAGE','이미지 크기(15 MiB 이하)와 인코딩을 확인해 주세요.');
 const mimeType=mime(bytes);const ext=extname(name).toLowerCase();if(!(mimeType==='image/png'&&ext==='.png'||mimeType==='image/jpeg'&&['.jpg','.jpeg'].includes(ext)||mimeType==='image/webp'&&ext==='.webp'||mimeType==='image/gif'&&ext==='.gif'||mimeType==='video/mp4'&&['.mp4','.m4v'].includes(ext)||mimeType==='video/quicktime'&&ext==='.mov'))throw new AppError('INVALID_IMAGE','미디어 확장자와 파일 형식이 일치하지 않습니다.');
 const asset:MediaAsset={id:randomUUID(),projectId,name,mimeType,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:new Date().toISOString()};
 const root=join(store.directory,'media',asset.id);await mkdir(root,{recursive:true,mode:0o700});
 try{await writeFile(join(root,name),bytes,{mode:0o400,flag:'wx'});store.writeBatch([{kind:'media',id:asset.id,value:asset}],[],[{projectId,kind:'media.imported',message:name+' 미디어를 등록했습니다.',data:{assetId:asset.id,size:asset.size}}]);}catch(error){await rm(root,{recursive:true,force:true});throw error;}return asset;
}
export async function mediaArtifact(store:Store,projectId:string|null,id:unknown):Promise<VerifiedArtifact>{
 const asset=store.get<MediaAsset>('media',text(id,'등록 이미지',100));if(!asset||asset.projectId!==projectId)throw new AppError('MEDIA_MISMATCH','이 프로젝트에 등록한 이미지를 선택해 주세요.');
 const path=join(store.directory,'media',asset.id,asset.name);const hash=createHash('sha256');let size=0;const file=await open(path,'r');try{for await(const chunk of file.createReadStream({autoClose:false})){size+=(chunk as Buffer).length;hash.update(chunk as Buffer);}}finally{await file.close();}if(size!==asset.size||hash.digest('hex')!==asset.sha256)throw new AppError('MEDIA_CHANGED','등록 이후 이미지가 변경되었습니다. 다시 등록해 주세요.',409);
 return{path,name:asset.name,size:asset.size,sha256:asset.sha256,kind:'file'};
}
