import test,{type TestContext}from'node:test';
import assert from'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,chmod}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join}from'node:path';
import {startController}from'../apps/controller/server.js';
import {CredentialVault}from'../packages/credentials/index.js';
import type{AppState,ApiResult,Run,ReleasePipeline,BackupRecord,OperationsState,MediaAsset,ImportedArtifact}from'../packages/domain/index.js';
import {request as httpRequest} from 'node:http';
import {isAllowedApiPath}from'../apps/desktop/electron/security.js';

async function setup(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'appops-demo-test-'));let key:Buffer|undefined;
 const vault=new CredentialVault(join(root,'credentials'),{keyProvider:{name:'test-memory',getKey:async()=>key,setKey:async value=>{key=value;}}});
 let controller=await startController({directory:root,port:0,vault,connectors:[],scanToolchains:async()=>[],fetch:async()=>{throw new Error('Live network must not execute');}});
 t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true});await rm(root+'.demo',{recursive:true,force:true});});
 const raw=async<T>(path:string,method='GET',body?:unknown)=>{const r=await fetch(`http://127.0.0.1:${controller.port}/api${path}`,{method,headers:{Authorization:'Bearer '+controller.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()as ApiResult<T>};};
 const api=async<T>(path:string,method='GET',body?:unknown)=>{const r=await raw<T>(path,method,body);assert.equal(r.body.ok,true,JSON.stringify(r));return(r.body as{ok:true;data:T}).data;};
 const done=async(id:string)=>{for(let i=0;i<120;i++){const state=await api<AppState>('/demo/state');const run=state.runs.find(r=>r.id===id);if(run&&!['queued','running','retry_wait'].includes(run.status))return run;await new Promise(r=>setTimeout(r,60));}throw new Error('run timed out '+id);};
 return {root,raw,api,done,controller,restart:async()=>{await controller.close();controller=await startController({directory:root,port:0,vault,connectors:[],scanToolchains:async()=>[]});}};
}
test('demo seeds every service and engine, isolates live state and persists through controller restart',async t=>{
 const{api,raw,restart}=await setup(t);const demo=await api<AppState>('/demo/state');
 assert.equal(demo.runtime.mode,'demo');assert.equal(demo.connections.length,9);assert.equal(demo.projects.length,5);assert.ok(demo.resources.length>30);assert.ok(demo.metricFacts!.length>200);
 assert.equal((await api<AppState>('/state')).projects.length,0);
 assert.equal((await raw('/projects/demo-project-godot/build','POST',{target:'android'})).status,404);
 assert.equal((await raw('/demolition/state')).status,404);assert.equal((await raw('/demo/demo/state')).status,404);
 assert.equal((await raw('/demo/connections','POST',{provider:'x',credentials:{accessToken:'do-not-store-real-secret'}})).status,400);
 await api('/demo/projects/demo-project-godot/policy','PUT',{...demo.projects.find(p=>p.engine==='godot')!.policy,maxDailyBudgetMicros:'900000000'});
 await restart();assert.equal((await api<AppState>('/demo/state')).projects.find(p=>p.engine==='godot')!.policy.maxDailyBudgetMicros,'900000000');assert.equal((await api<AppState>('/state')).connections.length,0);
});
test('five engines publish via common inspection/build/artifact/upload pipeline and deduplicate intent',async t=>{
 const{api,done,controller}=await setup(t);await api('/demo/state');
 for(const[engine,target,provider]of[['godot','android','google-play'],['unity','ios','app-store'],['unreal','windows','steam'],['android','android','google-play'],['ios','ios','app-store']]){
  const input={target,connectionId:'demo-'+provider,track:'internal',version:'1.3.0',idempotencyKey:'publish-'+engine};
  const p=await api<ReleasePipeline>('/demo/projects/demo-project-'+engine+'/publish','POST',input);
  assert.equal((await api<ReleasePipeline>('/demo/projects/demo-project-'+engine+'/publish','POST',input)).id,p.id);
  const build=await done(p.buildRunId);assert.equal(build.status,'succeeded',JSON.stringify(build));assert.equal(build.result!.demo,true);
  let settled:ReleasePipeline|undefined;
  for(let i=0;i<80;i++){settled=(await api<AppState>('/demo/state')).pipelines!.find(x=>x.id===p.id);if(settled?.status==='succeeded'||settled?.status==='failed')break;await new Promise(r=>setTimeout(r,60));}
  assert.equal(settled?.status,'succeeded',JSON.stringify(settled));assert.ok(settled!.uploadRunId);
 }
 const state=await api<AppState>('/demo/state');assert.equal(state.runs.filter(r=>r.kind==='upload-build').length,5);assert.equal(controller.service.store.runs().length,0);
});
test('demo writes update marketing, monetization and community resources, with policy guards',async t=>{
 const{api,raw,done}=await setup(t);await api('/demo/state');
 const actions:[string,string,Record<string,unknown>][]=[['google-ads','create-campaign',{name:'신규 설치 캠페인',dailyBudgetMicros:'10000000',currency:'USD',appId:'com.orbitgames.starlight',appStore:'GOOGLE_APP_STORE',countryCodes:['KR'],languageIds:['1000'],biddingStrategy:'TARGET_CPA',targetCpaMicros:'1000000'}],['google-play','create-product',{externalId:'demo-premium-new',name:'Premium Plus',priceMicros:'7990000',currency:'USD',description:'All content',language:'ko-KR',productType:'inapp'}],['x','create-post',{text:'새로운 데모 출시 소식입니다.'}],['threads','create-post',{text:'Threads 데모 출시 소식입니다.'}]];
 for(const[provider,operation,input]of actions){const r=await api<Run>('/demo/connections/demo-'+provider+'/actions','POST',{operation,projectId:'demo-project-godot',input,idempotencyKey:'new-'+provider+'-action'});const result=await done(r.id);assert.equal(result.status,'succeeded',JSON.stringify(result));}
 const state=await api<AppState>('/demo/state');assert.ok(state.resources.some(r=>r.name==='신규 설치 캠페인'));assert.ok(state.resources.some(r=>r.data.text==='Threads 데모 출시 소식입니다.'));
 assert.equal((await raw('/demo/connections/demo-google-ads/actions','POST',{operation:'create-campaign',projectId:'demo-project-godot',input:{name:'과다 예산',dailyBudgetMicros:'999999999999',currency:'USD'},idempotencyKey:'over-budget-demo'})).status,403);
});
test('network retry and credential recovery reuse prepared work without duplicates',async t=>{
 const{api,done}=await setup(t);await api('/demo/state');
 await api('/demo/scenario','POST',{scenario:'network-error'});
 let r=await api<Run>('/demo/connections/demo-x/actions','POST',{operation:'sync',input:{}});r=await done(r.id);assert.equal(r.status,'succeeded');assert.equal(r.attempt,2);
 await api('/demo/scenario','POST',{scenario:'auth-expired'});
 const post=await api<Run>('/demo/connections/demo-x/actions','POST',{operation:'create-post',projectId:'demo-project-godot',input:{text:'인증 복구 후 발행'},idempotencyKey:'auth-recovery-demo'});
 assert.equal((await done(post.id)).status,'action_required');
 await api('/demo/connections/demo-x/check','POST',{});assert.equal((await done(post.id)).status,'succeeded');
 assert.equal((await api<AppState>('/demo/state')).resources.filter(r=>r.data.text==='인증 복구 후 발행').length,1);
});
test('review rejection fails one pipeline and reset cannot erase active work',async t=>{
 const{api,raw,done}=await setup(t);await api('/demo/state');await api('/demo/scenario','POST',{scenario:'review-rejected'});
 const p=await api<ReleasePipeline>('/demo/projects/demo-project-godot/publish','POST',{target:'android',connectionId:'demo-google-play'});
 assert.equal((await raw('/demo/reset','POST',{})).status,409);await done(p.buildRunId);
 let state:AppState|undefined;for(let i=0;i<70;i++){state=await api<AppState>('/demo/state');if(state.pipelines!.find(x=>x.id===p.id)?.status==='failed')break;await new Promise(r=>setTimeout(r,60));}
 assert.equal(state!.pipelines!.find(x=>x.id===p.id)?.status,'failed');assert.ok(state!.resources.some(r=>r.status==='rejected'));
 await api('/demo/reset','POST',{});assert.equal((await api<AppState>('/demo/state')).pipelines!.length,0);assert.equal((await api<AppState>('/state')).projects.length,0);
});
test('configuration backup validates hashes, preserves ledgers and pauses restored automation',async t=>{
 const{api,raw,root}=await setup(t);let state=await api<AppState>('/demo/state');
 const backup=await api<BackupRecord>('/demo/operations/backup','POST',{description:'출시 전 설정'});assert.equal(backup.projectCount,5);assert.equal(backup.description,'출시 전 설정');
 const r=await api<Run>('/demo/projects/demo-project-godot/build','POST',{target:'linux'});
 assert.equal((await raw('/demo/operations/restore','POST',{backupId:backup.id})).status,409);
 await api('/demo/runs/'+r.id+'/cancel','POST',{});
 await api('/demo/projects/demo-project-godot/policy','PUT',{...state.projects.find(p=>p.engine==='godot')!.policy,maxDailyBudgetMicros:'100000000'});
 await new Promise(r=>setTimeout(r,300));
 await api('/demo/operations/restore','POST',{backupId:backup.id});state=await api<AppState>('/demo/state');
 const p=state.projects.find(p=>p.engine==='godot')!;assert.equal(p.policy.maxDailyBudgetMicros,'1000000000');assert.equal(p.policy.autoRelease,false);assert.equal(p.socialPolicy!.enabled,false);assert.ok(state.runs.some(x=>x.id===r.id));assert.equal(state.connections.length,9);
 assert.equal((await raw('/operations/restore','POST',{backupId:backup.id})).status,422);
 const file=join(root+'.demo','data','backups',backup.id+'.json');const envelope=JSON.parse(await readFile(file,'utf8'));envelope.payload=envelope.payload.replace('1000000000','1234000000');await writeFile(file,JSON.stringify(envelope));assert.equal((await raw('/demo/operations/restore','POST',{backupId:backup.id})).status,422);
 const ops=await api<OperationsState>('/demo/operations');assert.equal(ops.mode,'demo');assert.ok(ops.readiness.length>=10);
});
test('Electron permits only exact mode-qualified routes, including demo-only reset',()=>{
 for(const path of ['/demo/state','/demo/projects/test/publish','/demo/operations/backup','/demo/pipelines/test/cancel'])assert.equal(isAllowedApiPath(path.endsWith('state')?'GET':'POST',path),true,path);
 assert.equal(isAllowedApiPath('POST','/demo/reset'),true);assert.equal(isAllowedApiPath('POST','/reset'),false);assert.equal(isAllowedApiPath('POST','/demo/demo/reset'),false);assert.equal(isAllowedApiPath('GET','/demo/../state'),false);
});
test('listing images are project-scoped, verified before dispatch and isolated from live mode',async t=>{
 const {api,raw,done,root}=await setup(t);await api('/demo/state');
 const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=';
 const media=await api<MediaAsset>('/demo/media','POST',{projectId:'demo-project-godot',name:'icon.png',base64});
 assert.equal(media.mimeType,'image/png');assert.equal((await api<AppState>('/state')).mediaAssets!.length,0);
 for(const bad of [{name:'../icon.png',base64},{name:'icon.jpg',base64},{name:'icon.png',base64:'not-an-image'}])assert.equal((await raw('/demo/media','POST',{projectId:'demo-project-godot',...bad})).status,400);
 const upload=async(projectId:string,key:string)=>done((await api<Run>('/demo/connections/demo-google-play/actions','POST',{operation:'upload-listing-image',projectId,input:{language:'ko-KR',imageType:'icon',mediaAssetId:media.id},idempotencyKey:key})).id);
 assert.equal((await upload('demo-project-godot','media-valid')).status,'succeeded');
 const mismatch=await upload('demo-project-android','media-other-project');assert.equal(mismatch.result?.failureCode,'MEDIA_MISMATCH');
 const file=join(root+'.demo','data','media',media.id,media.name);await chmod(file,0o600);await writeFile(file,'changed');
 assert.equal((await upload('demo-project-godot','media-tampered')).result?.failureCode,'MEDIA_CHANGED');
});
test('new action contracts handle store reads, review checks, SDK output, moderation and manual platform actions',async t=>{
 const{api,raw,done}=await setup(t);let state=await api<AppState>('/demo/state');
 const action=async(provider:string,operation:string,input:Record<string,unknown>,projectId='demo-project-godot')=>done((await api<Run>('/demo/connections/demo-'+provider+'/actions','POST',{operation,projectId,input,idempotencyKey:'extensions-'+operation+'-'+provider})).id);
 const appleRead=await api<Run>('/demo/connections/demo-app-store/actions','POST',{operation:'list-listings',projectId:'demo-project-godot',input:{}});assert.equal((await done(appleRead.id)).status,'succeeded');
 assert.equal((await raw('/demo/connections/demo-google-play/actions','POST',{operation:'list-listings',projectId:'demo-project-godot',input:{}})).status,400);
 const campaign=state.resources.find(r=>r.connectionId==='demo-google-ads'&&r.projectId==='demo-project-godot'&&r.kind==='campaign')!;
 const creative=await action('google-ads','create-creative',{externalId:campaign.externalId,headlines:'["Play now","New worlds"]',descriptions:'["Explore the valley"]'});assert.equal(creative.status,'succeeded');
 assert.equal((await raw('/demo/connections/demo-google-ads/actions','POST',{operation:'create-creative',projectId:'demo-project-ios',input:{externalId:campaign.externalId},idempotencyKey:'cross-project-creative'})).status,409);
 const post=state.resources.find(r=>r.connectionId==='demo-x'&&r.projectId==='demo-project-godot'&&r.kind==='post')!;
 assert.equal((await action('x','delete-post',{postId:post.externalId})).status,'succeeded');
 state=await api<AppState>('/demo/state');assert.equal(state.resources.find(r=>r.id===post.id)?.status,'deleted');
 const sdk=await action('applovin-max','sdk-integration-config',{});assert.equal(sdk.status,'succeeded');assert.equal(sdk.result?.installsSdk,false);assert.ok(Array.isArray(sdk.result?.adUnits));
 const review=await action('app-store','submit-review',{appStoreVersionId:'demo-version-1'});assert.equal(review.status,'waiting_external');
 const check=await api<Run>('/demo/runs/'+review.id+'/reconcile','POST',{});await done(check.id);assert.equal((await api<AppState>('/demo/state')).runs.find(r=>r.id===review.id)?.status,'succeeded');
 const manual=await action('steam','prepare-news',{},'demo-project-unreal');assert.equal(manual.status,'action_required');assert.equal(manual.result?.published,false);
 assert.equal((await api<Run>('/demo/runs/'+manual.id+'/cancel','POST',{})).status,'cancelled');
});

test('wire paths cannot normalize across the demo and live service boundary',async t=>{
 const{controller,api}=await setup(t);await api('/demo/state');
 for(const path of ['/api/demo/../state','/api/demo/%2e%2e/state','/api/demo/.%2E/state','/api/demo/..\\state','/api//demo/state','/api/%64emo/state','http://127.0.0.1/api/state']){
  const result=await new Promise<{status:number;body:string}>((resolve,reject)=>{const req=httpRequest({hostname:'127.0.0.1',port:controller.port,path,headers:{Authorization:'Bearer '+controller.token}},res=>{let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.end();});
  assert.equal(result.status,400,path);assert.equal(JSON.parse(result.body).error.code,'INVALID_PATH',path);
 }
 assert.equal((await api<AppState>('/state')).projects.length,0);assert.equal((await api<AppState>('/demo/state')).projects.length,5);
});

test('external import API publishes without build history and demo never reads the supplied file path',async t=>{
 const {api,raw,done}=await setup(t);await api('/demo/state');
 const artifact=await api<ImportedArtifact>('/demo/projects/demo-project-android/artifacts','POST',{path:'/does-not-exist/private-file.aab',target:'android'});
 assert.equal(artifact.target,'android');assert.equal((await api<AppState>('/state')).importedArtifacts!.length,0);
 assert.equal((await raw('/projects/demo-project-android/artifacts','POST',{path:'/does-not-exist/private-file.aab',target:'android'})).status,404);
 const pipeline=await api<ReleasePipeline>('/demo/projects/demo-project-android/publish','POST',{target:'android',connectionId:'demo-google-play',importedArtifactId:artifact.id,track:'internal',idempotencyKey:'demo-import-publish'});
 assert.equal(pipeline.buildRunId,'');assert.equal((await done(pipeline.uploadRunId!)).status,'succeeded');
 assert.ok((await api<AppState>('/demo/state')).runs.every(run=>run.kind!=='build'));
});
