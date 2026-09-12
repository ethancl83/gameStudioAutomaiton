import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,stat,chmod,symlink,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
import {zipSync,strToU8} from 'fflate';
import {AppService} from '../apps/controller/service.js';
import {importedArtifactPath} from '../apps/controller/imported-artifacts.js';
import {Store} from '../packages/storage/index.js';
import {CredentialVault} from '../packages/credentials/index.js';
import {DEFAULT_POLICY,type Connection,type Project} from '../packages/domain/index.js';
import type {Connector} from '../packages/connectors/types.js';
import {googlePlayConnector} from '../packages/connectors/google-play.js';
import {androidArtifactMetadata} from '../packages/inspection/android-artifact.js';
import {isAllowedApiPath} from '../apps/desktop/electron/security.js';

const varint=(value:number)=>{const bytes:number[]=[];do{let byte=value%128;value=Math.floor(value/128);if(value)byte|=128;bytes.push(byte);}while(value);return Buffer.from(bytes);};
const field=(id:number,value:string|Buffer)=>{const data=typeof value==='string'?Buffer.from(value):value;return Buffer.concat([varint(id*8+2),varint(data.length),data]);};
function aabManifest(app='com.test.app'){
  const attr=(name:string,value:string,ns='')=>field(4,Buffer.concat([field(1,ns),field(2,name),field(3,value)]));
  return field(1,Buffer.concat([field(3,'manifest'),attr('package',app),attr('versionCode','12','http://schemas.android.com/apk/res/android'),attr('versionName','1.2.0','http://schemas.android.com/apk/res/android')]));
}
function apkManifest(){
  const strings=['manifest','package','com.test.app','http://schemas.android.com/apk/res/android','versionCode','versionName','1.2.0'];
  const bytes=strings.map(value=>Buffer.concat([Buffer.from([value.length,Buffer.byteLength(value)]),Buffer.from(value),Buffer.from([0])]));
  const start=28+strings.length*4,pool=Buffer.alloc(start+bytes.reduce((sum,b)=>sum+b.length,0));pool.writeUInt16LE(1,0);pool.writeUInt16LE(28,2);pool.writeUInt32LE(pool.length,4);pool.writeUInt32LE(strings.length,8);pool.writeUInt32LE(256,16);pool.writeUInt32LE(start,20);let cursor=0;
  bytes.forEach((data,i)=>{pool.writeUInt32LE(cursor,28+i*4);data.copy(pool,start+cursor);cursor+=data.length;});
  const element=Buffer.alloc(96);element.writeUInt16LE(0x102,0);element.writeUInt16LE(16,2);element.writeUInt32LE(96,4);element.writeUInt32LE(0xffffffff,16);element.writeUInt32LE(0,20);element.writeUInt16LE(20,24);element.writeUInt16LE(20,26);element.writeUInt16LE(3,28);
  for(const [i,ns,name,value,type] of [[0,0xffffffff,1,2,3],[1,3,4,12,0x10],[2,3,5,6,3]]){const at=36+i*20;element.writeUInt32LE(ns,at);element.writeUInt32LE(name,at+4);element.writeUInt32LE(0xffffffff,at+8);element.writeUInt16LE(8,at+12);element[at+15]=type;element.writeUInt32LE(value,at+16);}
  const header=Buffer.alloc(8);header.writeUInt16LE(3,0);header.writeUInt16LE(8,2);header.writeUInt32LE(8+pool.length+element.length,4);return Buffer.concat([header,pool,element]);
}
function bundle(app='com.test.app',signed=true){return zipSync({'base/manifest/AndroidManifest.xml':aabManifest(app),...(signed?{'META-INF/CERT.SF':strToU8('Fixture signature metadata'),'META-INF/CERT.RSA':strToU8('Not a real certificate')}:{})});}
const ipa=()=>zipSync({'Payload/Game.app/Info.plist':strToU8('<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.test.app</string><key>CFBundleShortVersionString</key><string>1.2.0</string><key>CFBundleVersion</key><string>12</string></dict></plist>'),'Payload/Game.app/_CodeSignature/CodeResources':strToU8('fixture'),'Payload/Game.app/embedded.mobileprovision':strToU8('fixture')});

async function setup(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'appops-import-tests-')),directory=join(root,'data'),store=new Store(directory,{heartbeat:false});let key:Buffer|undefined;let dispatched=0;
  const vault=new CredentialVault(join(directory,'credentials'),{keyProvider:{name:'memory',getKey:async()=>key,setKey:async value=>{key=value;}}});
  const connector:Connector={capability:googlePlayConnector.capability,async execute(operation,_input,context){assert.equal(operation,'upload-build');assert.ok(context.artifact?.sha256);await context.request('https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.test.app/edits',{method:'POST',write:true,json:{}});return {summary:{uploaded:true}};}};
  const options={connectors:[connector],scanToolchains:async()=>[],fetch:async()=>{dispatched++;return Response.json({id:'uploaded'});}};
  let service=new AppService(store,vault,options);
  const at=new Date().toISOString();const project:Project={id:'project',name:'External build',rootPath:'/nonexistent-source',engine:'android',engineVersion:null,appIdentifier:'com.test.app',targets:[],findings:[{code:'test.source-missing',severity:'error',message:'No build environment'}],inspectedAt:at,createdAt:at,updatedAt:at,policy:{...DEFAULT_POLICY,autoRelease:true,allowedConnectionIds:['play']}};
  store.put('project',project.id,project);store.put('project','other',{...project,id:'other'});
  store.put<Connection>('connection','play',{id:'play',provider:'google-play',label:'Play',accountId:'account',status:'connected',authKind:'fixture',credentialFields:[],createdAt:at,updatedAt:at,lastCheckedAt:at,lastError:null});await vault.set('play',{fixture:'credentials'});
  t.after(async()=>{await service.stop();store.close();await rm(root,{recursive:true,force:true});});
  return {root,directory,store,project,get service(){return service;},sent:()=>dispatched,restart:async()=>{await service.stop();service=new AppService(store,vault,options);},settle:async(id:string)=>{for(let i=0;i<250;i++){service.queue.tick();const run=store.getRun(id)!;if(!['queued','running','retry_wait'].includes(run.status))return run;await pause(10);}throw new Error('Did not settle');}};
}

test('AAB and APK metadata parsers read identity and versions and reject truncated inputs',()=>{
  for(const [bytes,bundle] of [[aabManifest(),true],[apkManifest(),false]] as const){assert.deepEqual(androidArtifactMetadata(bytes,bundle),{appIdentifier:'com.test.app',version:'1.2.0',buildVersion:'12'});for(const length of [0,3,bytes.length-1])assert.throws(()=>androidArtifactMetadata(bytes.subarray(0,length),bundle),{code:'INVALID_ARTIFACT'});}
});

test('external AAB is copied without changing source and published after restart without an engine or build run',async t=>{
  const f=await setup(t),source=join(f.root,'release.AAB');await writeFile(source,bundle(),{mode:0o640});const before=await stat(source);
  const asset=await f.service.importArtifact('project',{path:source,target:'android'});assert.equal(asset.appIdentifier,'com.test.app');assert.equal(asset.signature,'present');assert.equal((await stat(source)).mode,before.mode);
  await rm(source);await f.restart();assert.equal((await f.service.state()).importedArtifacts?.[0].id,asset.id);
  f.service.inspect=async()=>{throw new Error('External publication must not inspect source');};f.service.build=()=>{throw new Error('External publication must not build');};
  const input={target:'android',connectionId:'play',track:'internal',importedArtifactId:asset.id,idempotencyKey:'external-pipeline'};
  const pipeline=await f.service.publish('project',input);assert.equal(pipeline.status,'uploading');assert.equal(pipeline.buildRunId,'');
  assert.equal((await f.service.publish('project',input)).id,pipeline.id);assert.equal((await f.settle(pipeline.uploadRunId!)).status,'succeeded');f.service.pipelines.cycle();assert.equal(f.service.pipelines.list()[0].status,'succeeded');assert.equal(f.sent(),1);assert.ok(f.store.runs().every(run=>run.kind!=='build'));
});

test('import rejects wrong app, unsigned, corrupt and mismatched files and upload rechecks ownership and digest',async t=>{
  const f=await setup(t),source=join(f.root,'release.aab');
  for(const [bytes,code] of [[bundle('com.other.app'),'ARTIFACT_MISMATCH'],[bundle('com.test.app',false),'SIGNATURE_REQUIRED'],[Buffer.from('not a zip'),'INVALID_INPUT']] as const){await writeFile(source,bytes);await assert.rejects(f.service.importArtifact('project',{path:source,target:'android'}),{code});}
  assert.equal(f.store.list('imported-artifact').length,0);assert.deepEqual(await readdir(join(f.directory,'artifacts')),[]);
  await writeFile(source,bundle());const artifact=await f.service.importArtifact('project',{path:source,target:'android'});
  const action=(projectId='project')=>f.service.action('play',{operation:'upload-build',projectId,idempotencyKey:'tampered-upload',input:{importedArtifactId:artifact.id}});
  assert.throws(()=>action('other'),{code:'ARTIFACT_REQUIRED'});
  await assert.rejects(f.service.publish('project',{target:'ios',connectionId:'play',importedArtifactId:artifact.id}),{code:'PROVIDER_MISMATCH'});
  const path=importedArtifactPath(f.directory,artifact);await chmod(path,0o600);await writeFile(path,'tampered');const run=await f.settle(action().id);assert.equal(run.status,'failed');assert.equal(run.result?.failureCode,'ARTIFACT_CHANGED');assert.equal(f.sent(),0);
});

test('IPA and Steam folders import without platform tools; folder secrets, links and operational roots are blocked',async t=>{
  const f=await setup(t),source=join(f.root,'release.ipa');await writeFile(source,ipa());const apple=await f.service.importArtifact('project',{path:source,target:'ios'});assert.equal(apple.buildVersion,'12');assert.equal(apple.appIdentifier,'com.test.app');
  const content=join(f.root,'steam-content');await mkdir(content);await writeFile(join(content,'game.x86_64'),'ELF fixture',{mode:0o755});await writeFile(join(content,'assets.pck'),'game data');const steam=await f.service.importArtifact('project',{path:content,target:'linux'});
  assert.equal(steam.format,'directory');assert.equal(steam.signature,'not-applicable');assert.ok((await stat(join(importedArtifactPath(f.directory,steam),'game.x86_64'))).mode&0o111);assert.equal((await stat(join(content,'game.x86_64'))).mode&0o777,0o755);
  assert.throws(()=>f.service.action('play',{operation:'upload-build',projectId:'project',input:{importedArtifactId:steam.id}}),{code:'ARTIFACT_MISMATCH'});
  await writeFile(join(content,'.env'),'SECRET=fixture');await assert.rejects(f.service.importArtifact('project',{path:content,target:'linux'}),{code:'ARTIFACT_SECRET'});await rm(join(content,'.env'));
  await symlink('assets.pck',join(content,'asset-link'));const linked=await f.service.importArtifact('project',{path:content,target:'linux'});assert.equal(await readFile(join(importedArtifactPath(f.directory,linked),'asset-link'),'utf8'),'game data');
  await symlink(source,join(content,'linked'));await assert.rejects(f.service.importArtifact('project',{path:content,target:'linux'}),{code:'ARTIFACT_ESCAPE'});
  await assert.rejects(f.service.importArtifact('project',{path:f.root,target:'linux'}),{code:'PROTECTED_DIRECTORY'});
  assert.deepEqual(await readFile(source),Buffer.from(ipa()));
  assert.equal(isAllowedApiPath('POST','/projects/project/artifacts'),true);assert.equal(isAllowedApiPath('POST','/demo/projects/project/artifacts'),true);assert.equal(isAllowedApiPath('POST','/runs/run/resolve'),true);
});
