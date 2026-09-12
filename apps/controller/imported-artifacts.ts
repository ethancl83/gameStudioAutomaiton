import { constants } from 'node:fs';
import { open, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BuildTarget, ImportedArtifact, Project } from '../../packages/domain/index.js';
import { AppError } from '../../packages/domain/errors.js';
import { readIpaMetadata, readZipEntry } from '../../packages/connectors/store-tools.js';
import type { VerifiedArtifact } from '../../packages/connectors/types.js';
import { androidArtifactMetadata } from '../../packages/inspection/android-artifact.js';
import { isSecretFile } from '../runner/secrets.js';
import { within } from './validation.js';

export function importedArtifactPath(directory:string,artifact:ImportedArtifact):string {
  if(!/^import-[a-f0-9-]{36}$/.test(artifact.id)||!['aab','apk','ipa','directory'].includes(artifact.format))throw new AppError('INVALID_ARTIFACT','가져온 결과물 정보가 올바르지 않습니다.');
  return join(directory,'artifacts',artifact.id,artifact.format==='directory'?'content':'content.'+artifact.format);
}

async function apkSignatureBlock(path:string):Promise<boolean> {
  const file=await open(path,'r');
  try{const {size}=await file.stat(),tail=Buffer.alloc(Math.min(size,65557));await file.read(tail,0,tail.length,size-tail.length);
    for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){
      const directory=tail.readUInt32LE(i+16);if(directory<32||directory>size)return false;const footer=Buffer.alloc(24);await file.read(footer,0,24,directory-24);
      if(footer.subarray(8).toString('ascii')!=='APK Sig Block 42')return false;const length=Number(footer.readBigUInt64LE(0));if(!Number.isSafeInteger(length)||length<24||length+8>directory)return false;
      const head=Buffer.alloc(8);await file.read(head,0,8,directory-length-8);return head.readBigUInt64LE(0)===BigInt(length);
    }return false;
  }finally{await file.close();}
}

/** Never executes imported content; inspect a managed copy and let the store validate signing certificates. */
export async function inspectImportedFile(path:string,target:BuildTarget):Promise<Pick<ImportedArtifact,'appIdentifier'|'version'|'buildVersion'|'signature'>> {
  if(!['android','ios'].includes(target))return {signature:'not-applicable'};
  const names=new Set<string>();await readZipEntry(path,name=>{names.add(name);return false;});
  if(target==='ios'){
    const metadata=await readIpaMetadata(path);
    const root=[...names].find(name=>/^Payload\/[^/]+\.app\/Info\.plist$/.test(name))!.slice(0,-'Info.plist'.length);
    if(!names.has(root+'_CodeSignature/CodeResources')||!names.has(root+'embedded.mobileprovision'))throw new AppError('SIGNATURE_REQUIRED','배포용으로 서명된 IPA를 선택해 주세요. 서명 정보와 프로비저닝 프로파일이 필요합니다.');
    return {appIdentifier:metadata.bundleId,version:metadata.shortVersion,buildVersion:metadata.buildVersion,signature:'present'};
  }
  const bundle=extname(path)==='.aab';const manifest=await readZipEntry(path,name=>name===(bundle?'base/manifest/AndroidManifest.xml':'AndroidManifest.xml'));
  if(!manifest)throw new AppError('INVALID_ARTIFACT','Android manifest가 없는 결과물입니다.');
  const jarSignature=[...names].some(name=>/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name)&&names.has(name.replace(/\.(RSA|DSA|EC)$/i,'.SF')));
  if(!jarSignature&&(bundle||!await apkSignatureBlock(path)))throw new AppError('SIGNATURE_REQUIRED','배포용으로 서명된 AAB 또는 APK를 선택해 주세요.');
  return {...androidArtifactMetadata(manifest.data,bundle),signature:'present'};
}

export function assertArtifactApp(artifact:ImportedArtifact,project:Project):void {
  const mapping=project.storeApps?.[artifact.target==='android'?'google-play':'app-store'];
  // Apple mappings hold the numeric App Store ID, not the binary's bundle identifier.
  const expected=artifact.target==='android'?(mapping?.appId??project.appIdentifier):project.appIdentifier;
  if(['android','ios'].includes(artifact.target)&&(!expected||artifact.appIdentifier!==expected))throw new AppError('ARTIFACT_MISMATCH','결과물의 앱 식별자가 이 프로젝트와 다릅니다. 올바른 프로젝트와 파일을 선택해 주세요.');
}

export async function importArtifact(directory:string,source:string,target:BuildTarget,project:Project,protectedRoots:string[],attest:(path:string,root:string)=>Promise<VerifiedArtifact>):Promise<ImportedArtifact> {
  const info=await lstat(source);if(info.isSymbolicLink())throw new AppError('ARTIFACT_ESCAPE','링크 대신 실제 결과물 파일 또는 폴더를 선택해 주세요.');
  const root=await realpath(source);
  if(protectedRoots.some(path=>within(resolve(path),root)||within(root,resolve(path))))throw new AppError('PROTECTED_DIRECTORY','운영 데이터 폴더는 결과물로 가져올 수 없습니다.');
  const format=target==='android'&&info.isFile()&&/\.(aab|apk)$/i.test(source)?extname(source).slice(1).toLowerCase():target==='ios'&&info.isFile()&&/\.ipa$/i.test(source)?'ipa':!['android','ios'].includes(target)&&info.isDirectory()?'directory':null;
  if(!format)throw new AppError('ARTIFACT_MISMATCH','Android는 AAB/APK, iOS는 IPA, Steam은 콘텐츠 폴더를 선택해 주세요.');
  const artifact:ImportedArtifact={id:'import-'+randomUUID(),projectId:project.id,name:basename(root),target,format:format as ImportedArtifact['format'],size:0,sha256:'',signature:'not-applicable',createdAt:new Date().toISOString()};
  const destination=importedArtifactPath(directory,artifact),container=join(directory,'artifacts',artifact.id);
  await mkdir(container,{recursive:true,mode:0o700});let total=0,count=0;
  const visiting=new Set<string>();
  const copy=async(from:string,to:string):Promise<void>=>{
    if(++count>200_000)throw new AppError('ARTIFACT_TOO_LARGE','결과물의 파일 수가 20만 개를 초과합니다.');
    const stat=await lstat(from);
    if(stat.isSymbolicLink()){const actual=await realpath(from);if(!within(root,actual)||visiting.has(actual))throw new AppError('ARTIFACT_ESCAPE','결과물 밖을 가리키거나 순환하는 링크가 있습니다.');await copy(actual,to);return;}
    if((!stat.isFile()&&!stat.isDirectory())||!within(root,await realpath(from)))throw new AppError('ARTIFACT_ESCAPE','결과물 폴더에 링크나 특수 파일이 있습니다. 실제 파일로 구성된 배포 폴더를 선택해 주세요.');
    if(format==='directory'&&isSecretFile(from))throw new AppError('ARTIFACT_SECRET','결과물 폴더에 인증 파일이나 개발 설정이 있습니다. 배포 콘텐츠만 들어 있는 폴더를 선택해 주세요.');
    if(stat.isDirectory()){const actual=await realpath(from);if(visiting.has(actual))throw new AppError('ARTIFACT_ESCAPE','결과물에 순환하는 폴더 링크가 있습니다.');visiting.add(actual);try{await mkdir(to,{mode:0o700});for(const name of await readdir(from))await copy(join(from,name),join(to,name));}finally{visiting.delete(actual);}return;}
    total+=stat.size;if(total>512*1024**3)throw new AppError('ARTIFACT_TOO_LARGE','결과물은 512 GiB 이하만 가져올 수 있습니다.');
    const input=await open(from,constants.O_RDONLY|constants.O_NOFOLLOW);const output=await open(to,'wx',stat.mode&0o111?0o700:0o600).catch(async error=>{await input.close();throw error;});
    try{const before=await input.stat();if(!before.isFile()||before.ino!==stat.ino||before.dev!==stat.dev||before.size!==stat.size)throw new AppError('ARTIFACT_CHANGED','복사 중 결과물이 변경되었습니다.');
      const buffer=Buffer.alloc(1024*1024);let position=0;
      while(position<before.size){const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,before.size-position),position);if(!bytesRead)throw new AppError('ARTIFACT_CHANGED','복사 중 결과물이 변경되었습니다.');let written=0;while(written<bytesRead){const result=await output.write(buffer,written,bytesRead-written,position+written);if(!result.bytesWritten)throw new AppError('COPY_FAILED','결과물을 저장하지 못했습니다.');written+=result.bytesWritten;}position+=bytesRead;}
      const after=await input.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new AppError('ARTIFACT_CHANGED','복사 중 결과물이 변경되었습니다.');await output.sync();
    }finally{await input.close();await output.close();}
  };
  try{await copy(root,destination);Object.assign(artifact,await inspectImportedFile(destination,target));assertArtifactApp(artifact,project);const verified=await attest(destination,container);artifact.size=verified.size;artifact.sha256=verified.sha256;return artifact;}
  catch(error){await rm(container,{recursive:true,force:true});throw error;}
}
