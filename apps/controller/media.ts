import {randomUUID,createHash}from'node:crypto';import{mkdir,readFile,writeFile,rm}from'node:fs/promises';import{join,extname}from'node:path';
import type{MediaAsset}from'../../packages/domain/index.js';import{AppError,object,text}from'../../packages/domain/errors.js';import type{Store}from'../../packages/storage/index.js';import type{VerifiedArtifact}from'../../packages/connectors/types.js';
const MAX=15*1024*1024;
function mime(bytes:Buffer):string{
 if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0)return'image/png';
 if(bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9)return'image/jpeg';
 if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return'image/webp';
 throw new AppError('INVALID_IMAGE','PNG·JPEG·WebP 이미지 파일을 선택해 주세요.');
}
export async function addMedia(store:Store,input:unknown):Promise<MediaAsset>{
 const body=object(input);const projectId=text(body.projectId,'프로젝트 ID',100);if(!store.get('project',projectId))throw new AppError('NOT_FOUND','프로젝트를 찾을 수 없습니다.',404);
 const name=text(body.name,'이미지 이름',200);if(/[\\/\x00-\x1f:]/.test(name)||name==='.'||name==='..')throw new AppError('INVALID_IMAGE','이미지 파일 이름을 확인해 주세요.');
 const encoded=text(body.base64,'이미지',MAX*1.4);const bytes=Buffer.from(encoded,'base64');if(bytes.length>MAX||bytes.toString('base64')!==encoded)throw new AppError('INVALID_IMAGE','이미지 크기(15 MiB 이하)와 인코딩을 확인해 주세요.');
 const mimeType=mime(bytes);const ext=extname(name).toLowerCase();if(!(mimeType==='image/png'&&ext==='.png'||mimeType==='image/jpeg'&&['.jpg','.jpeg'].includes(ext)||mimeType==='image/webp'&&ext==='.webp'))throw new AppError('INVALID_IMAGE','이미지 확장자와 파일 형식이 일치하지 않습니다.');
 const asset:MediaAsset={id:randomUUID(),projectId,name,mimeType,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:new Date().toISOString()};
 const root=join(store.directory,'media',asset.id);await mkdir(root,{recursive:true,mode:0o700});
 try{await writeFile(join(root,name),bytes,{mode:0o400,flag:'wx'});store.writeBatch([{kind:'media',id:asset.id,value:asset}],[],[{projectId,kind:'media.imported',message:name+' 스토어 이미지를 등록했습니다.',data:{assetId:asset.id,size:asset.size}}]);}catch(error){await rm(root,{recursive:true,force:true});throw error;}return asset;
}
export async function mediaArtifact(store:Store,projectId:string|null,id:unknown):Promise<VerifiedArtifact>{
 const asset=store.get<MediaAsset>('media',text(id,'등록 이미지',100));if(!asset||asset.projectId!==projectId)throw new AppError('MEDIA_MISMATCH','이 프로젝트에 등록한 이미지를 선택해 주세요.');
 const path=join(store.directory,'media',asset.id,asset.name);const bytes=await readFile(path);if(bytes.length!==asset.size||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new AppError('MEDIA_CHANGED','등록 이후 이미지가 변경되었습니다. 다시 등록해 주세요.',409);
 return{path,name:asset.name,size:asset.size,sha256:asset.sha256,kind:'file'};
}
