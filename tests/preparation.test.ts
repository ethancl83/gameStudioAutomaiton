import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startController } from '../apps/controller/server.js';
import { CredentialVault } from '../packages/credentials/index.js';
import type { ApiResult, AppState, Project, ToolPathSettings } from '../packages/domain/index.js';
import type { PreparationState } from '../packages/setup/types.js';
import { evaluatePreparation } from '../packages/setup/readiness.js';
import type { IntegrationApplyResult, IntegrationPreview, IntegrationRollbackResult } from '../packages/project-integration/index.js';

async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'appops-setup-'));let key:Buffer|undefined;const scans:ToolPathSettings[]=[];
 const vault=new CredentialVault(join(root,'credentials'),{keyProvider:{name:'test-memory',getKey:async()=>key,setKey:async value=>{key=value;}}});
 let controller=await startController({directory:join(root,'data'),port:0,vault,connectors:[],scanToolchains:async paths=>{scans.push(paths??{});return [];},fetch:async()=>{throw new Error('Unexpected real network');}});
 t.after(async()=>{await controller.close();await rm(root,{recursive:true,force:true});});
 const raw=async<T>(path:string,method='GET',input?:unknown)=>{
  const response=await fetch(`http://127.0.0.1:${controller.port}/api${path}`,{method,headers:{Authorization:'Bearer '+controller.token,'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});
  return {status:response.status,body:await response.json() as ApiResult<T>};
 };
 const api=async<T>(path:string,method='GET',input?:unknown):Promise<T>=>{const r=await raw<T>(path,method,input);assert.ok(r.body.ok,JSON.stringify(r));return r.body.data;};
 const restart=async()=>{await controller.close();controller=await startController({directory:join(root,'data'),port:0,vault,connectors:[],scanToolchains:async paths=>{scans.push(paths??{});return [];}});};
 return {root,api,raw,scans,restart,get controller(){return controller;}};
}

test('tool settings persist per service and untrusted managedRoot or data roots cannot be saved',async t=>{
 const f=await fixture(t);const sdk=join(f.root,'public-sdk');await mkdir(sdk);
 await f.api('/setup/tools','PUT',{androidSdk:sdk});assert.equal(f.scans.at(-1)?.androidSdk,sdk);assert.equal(f.scans.at(-1)?.managedRoot,join(f.root,'data.tools'));
 assert.equal((await f.raw('/setup/tools','PUT',{managedRoot:'/'})).status,400);
 assert.equal((await f.raw('/setup/tools','PUT',{androidSdk:join(f.root,'data')})).status,400);
 await f.restart();assert.equal((await f.api<PreparationState>('/setup')).settings.androidSdk,sdk);
 assert.equal((await f.api<PreparationState>('/demo/setup')).settings.androidSdk,undefined);
});

test('project readiness cannot be satisfied by an unrelated engine, key, account, or runner OS',async t=>{
 const f=await fixture(t);const state=await f.api<AppState>('/demo/state');state.runtime.mode='live';
 const project=state.projects.find(p=>p.engine==='android')!;
 state.toolchains=[{name:'godot',available:true,version:'4.3',executable:'/tmp/godot'}];
 project.buildSecurity={sshDependencies:[],androidKeystoreId:'missing-project-key'};
 const result=evaluatePreparation(project,{state,preferences:{projectId:project.id,target:'android'},runners:[],isolation:{available:false,reason:'no sandbox'}});
 for(const id of ['tool:jdk-home','tool:android-sdk-validated','tool:gradle-offline-cache','android-key','runner','store-app','build-verified'])assert.equal(result.checks.find(c=>c.id===id)?.status,'required',id);
 assert.equal(result.status,'required');
 const ios=state.projects.find(p=>p.engine==='ios')!;
 const wrong=evaluatePreparation(ios,{state,preferences:{projectId:ios.id,target:'ios',runnerId:'win'},runners:[{id:'win',platform:'win32',status:'ready',label:'wrong OS',endpoint:'http://127.0.0.1:8',createdAt:new Date().toISOString(),lastCheckedAt:new Date().toISOString(),lastError:null}],runnerTools:[],isolation:{available:true}});
 assert.equal(wrong.checks.find(c=>c.id==='macos')?.status,'required');assert.equal(wrong.checks.find(c=>c.id==='tool:xcodebuild')?.status,'required');
});

test('separate Steam mapping verifies without overwriting the mobile package identifier',async t=>{
 const f=await fixture(t);const state=await f.api<AppState>('/demo/state');const p=state.projects.find(p=>p.engine==='godot')!;
 const mapped=await f.api<Project>('/demo/projects/'+p.id+'/store-app','PUT',{provider:'steam',connectionId:'demo-steam',appId:'123456'});
 assert.equal(mapped.appIdentifier,p.appIdentifier);assert.equal(mapped.storeApps?.steam?.appId,'123456');assert.equal(mapped.storeApps?.steam?.verifiedAt,undefined);
 const checked=await f.api<Project>('/demo/projects/'+p.id+'/store-app/check','POST',{provider:'steam'});assert.ok(checked.storeApps?.steam?.verifiedAt);
 assert.equal((await f.api<AppState>('/state')).projects.length,0);
 assert.equal((await f.raw('/demo/projects/'+p.id+'/store-app','PUT',{provider:'google-play',connectionId:'demo-steam',appId:'com.wrong.app'})).status,400);
});

test('demo SDK applies and rolls back through authenticated routes using only project-owned resource IDs',async t=>{
 const f=await fixture(t);const state=await f.api<AppState>('/demo/state');const p=state.projects.find(p=>p.engine==='android')!;
 const selected=state.resources.find(r=>r.projectId===p.id&&r.provider==='admob'&&r.kind==='ad-unit')!;
 await f.api('/demo/projects/'+p.id+'/integration');
 const original=await readFile(join(p.rootPath,'app/build.gradle'),'utf8');
 const preview=await f.api<IntegrationPreview>('/demo/projects/'+p.id+'/integration/preview','POST',{provider:'admob',platform:'android',connectionId:'demo-admob',adUnitIds:[selected.id]});assert.ok(preview.supported,JSON.stringify(preview.findings));
 const applied=await f.api<IntegrationApplyResult>('/demo/projects/'+p.id+'/integration/apply','POST',{previewId:preview.previewId});assert.equal(applied.status,'applied',JSON.stringify(applied.findings));assert.notEqual(await readFile(join(p.rootPath,'app/build.gradle'),'utf8'),original);
 await f.restart();const result=await f.api<IntegrationRollbackResult>('/demo/projects/'+p.id+'/integration/rollback','POST',{applyId:applied.applyId});assert.equal(result.status,'rolled_back');assert.equal(await readFile(join(p.rootPath,'app/build.gradle'),'utf8'),original);
 const other=state.resources.find(r=>r.projectId!==p.id&&r.provider==='admob'&&r.kind==='ad-unit')!;
 assert.equal((await f.raw('/demo/projects/'+p.id+'/integration/preview','POST',{provider:'admob',platform:'android',connectionId:'demo-admob',adUnitIds:[other.id]})).status,400);
 assert.equal((await f.raw('/projects/'+p.id+'/integration/apply','POST',{previewId:preview.previewId})).status,404);
});
