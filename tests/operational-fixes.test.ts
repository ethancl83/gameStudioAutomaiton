import test,{type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {Store} from '../packages/storage/index.js';
import {AppService} from '../apps/controller/service.js';
import {CredentialVault} from '../packages/credentials/index.js';
import {DEFAULT_POLICY,type Connection,type ExternalResource,type Project,type ReleaseObservation,type Run} from '../packages/domain/index.js';
import {xConnector} from '../packages/connectors/social.js';
import {googlePlayConnector} from '../packages/connectors/google-play.js';
import {googleAdsConnector} from '../packages/connectors/google-ads.js';
import {AutomationScheduler} from '../apps/controller/automation.js';
import {observeReleases} from '../apps/controller/release-observations.js';
import {specFor} from '../apps/desktop/src/operations.js';
import {createTransport} from '../packages/connectors/transport.js';

const at=new Date().toISOString();
const connection=(id:string,provider:Connection['provider'],accountId=id):Connection=>({id,provider,accountId,label:id,status:'connected',authKind:'fixture',credentialFields:[],createdAt:at,updatedAt:at,lastCheckedAt:at,lastError:null});
const project=(id:string):Project=>({id,name:id,appIdentifier:'com.test.'+id,rootPath:'/unused-project',engine:'android',engineVersion:null,targets:['android'],findings:[],inspectedAt:at,createdAt:at,updatedAt:at,policy:{...DEFAULT_POLICY,autoRelease:false,allowCampaignWrites:true,allowedConnectionIds:['play','ads','x'],maxDailyBudgetMicros:'100000000'},storeApps:{'google-play':{connectionId:'play',appId:'com.test.'+id,verifiedAt:at}}});
async function setup(t:TestContext,fetcher:typeof fetch){
  const directory=await mkdtemp(join(tmpdir(),'appops-operational-fixes-')),store=new Store(directory,{heartbeat:false});let key:Buffer|undefined;
  const vault=new CredentialVault(join(directory,'credentials'),{keyProvider:{name:'test-memory',getKey:async()=>key,setKey:async value=>{key=value;}}});
  const service=new AppService(store,vault,{connectors:[xConnector,googlePlayConnector,googleAdsConnector],fetch:fetcher,scanToolchains:async()=>[]});
  t.after(async()=>{await service.stop();store.close();await rm(directory,{recursive:true,force:true});});
  for(const c of [connection('x','x','1234'),connection('play','google-play'),connection('ads','google-ads','1234567890')])store.put('connection',c.id,c);
  for(const id of ['a','b'])store.put('project',id,project(id));
  await vault.set('x',{accessToken:'fixture',accessTokenExpiresAt:String(Date.now()+3600000),clientId:'fixture',refreshToken:'fixture'});
  await vault.set('play',{packageName:'com.test.a',clientId:'fixture',refreshToken:'fixture'});
  await vault.set('ads',{clientId:'fixture',refreshToken:'fixture'});
  const settle=async(id:string)=>{for(let i=0;i<250;i++){service.queue.tick();const run=store.getRun(id)!;if(!['queued','running','retry_wait'].includes(run.status))return run;await pause(10);}throw new Error('Run did not settle: '+id);};
  return {store,service,vault,settle};
}

test('a definite X rejection releases quota; unknown delivery requires evidence and never resends',async t=>{
  let reject=true,posts=0;
  const {store,service,settle}=await setup(t,async url=>{if(new URL(String(url)).pathname.endsWith('/users/me'))return Response.json({data:{id:'1234'}});posts++;if(reject)return Response.json({},{status:400});throw new Error('connection lost');});
  service.social.savePolicy('a',{enabled:true,connectionIds:['x'],dailyPostLimit:1,autoReleaseAnnouncements:false,releaseTemplate:'{version}',autoReply:false,replyRules:[]});
  const post=()=>service.action('x',{idempotencyKey:randomUUID(),operation:'create-post',projectId:'a',input:{text:'Release '+randomUUID()}});
  const rejected=await settle(post().id);assert.equal(rejected.status,'failed');assert.equal(store.effectState(rejected.id),'prepared');assert.equal(posts,1);
  service.queue.pause();assert.equal(store.retry(rejected.id).status,'queued');store.cancel(rejected.id);service.queue.start();
  reject=false;const unknown=await settle(post().id);assert.equal(unknown.status,'action_required');assert.equal(posts,2);
  assert.throws(post,{code:'SOCIAL_DAILY_LIMIT'});
  const evidence={outcome:'failed',confirmed:true,note:'X 프로필과 게시물 목록에서 미게시 확인',expectedUpdatedAt:unknown.updatedAt};
  assert.throws(()=>service.resolveRun(unknown.id,{...evidence,confirmed:false}),{code:'CONFIRMATION_REQUIRED'});
  assert.throws(()=>service.resolveRun(unknown.id,{...evidence,expectedUpdatedAt:'outdated'}));
  const resolved=service.resolveRun(unknown.id,evidence);assert.equal(resolved.status,'failed');assert.equal(posts,2);
  assert.throws(()=>store.retry(unknown.id)); // An operator's terminal decision cannot replay a partially applied operation.
  service.queue.pause();assert.doesNotThrow(post);
});

test('only first, explicitly rejected HTTP mutations may clear the dispatch journal',async()=>{
  for(const status of [400,401,403,404,409,422,429,408,500]){
    let cleared=0;
    const request=createTransport({provider:'x',signal:new AbortController().signal,markDispatched(){},markRejected(){cleared++;},fetch:async()=>Response.json({},{status})});
    await assert.rejects(request('https://api.x.com/2/tweets',{method:'POST',write:true,json:{}}));
    assert.equal(cleared,[408,500].includes(status)?0:1);
  }
  let attempt=0,cleared=0;
  const request=createTransport({provider:'x',signal:new AbortController().signal,markDispatched(){},markRejected(){cleared++;},fetch:async()=>Response.json({},{status:++attempt===1?200:400})});
  await request('https://api.x.com/2/tweets',{method:'POST',write:true,json:{}});await assert.rejects(request('https://api.x.com/2/tweets',{method:'POST',write:true,json:{}}));assert.equal(cleared,0);
  const guarded=createTransport({provider:'x',signal:new AbortController().signal,markDispatched(){},markRejected:()=>false,fetch:async()=>Response.json({},{status:400})});
  await assert.rejects(guarded('https://api.x.com/2/tweets',{method:'POST',write:true,json:{}}),(error:unknown)=>(error as {externalWriteRejected:boolean}).externalWriteRejected===false);
});

test('one Play connection synchronizes both mapped apps, deduplicates ticks and offers project selectors',async t=>{
  const paths:string[]=[];
  const {store,service,settle}=await setup(t,async address=>{const url=new URL(String(address));paths.push(url.pathname);
    if(url.origin==='https://oauth2.googleapis.com')return Response.json({access_token:'fixture',expires_in:3600});
    if(url.pathname.endsWith('/oneTimeProducts'))return Response.json({oneTimeProducts:[]});if(url.pathname.endsWith('/subscriptions'))return Response.json({subscriptions:[]});if(url.pathname.endsWith('/releases'))return Response.json({releases:[]});throw new Error('Unexpected '+url.pathname);
  });
  const actions={build:()=>{throw new Error('Must not build');},action:(id:string,input:unknown)=>service.action(id,input),reconcile:(id:string)=>service.reconcile(id),supported:(provider:Connection['provider'],operation:string)=>provider==='google-play'&&['sync','sync-app'].includes(operation)};
  const scheduler=new AutomationScheduler(store,actions);scheduler.start();await scheduler.tick();await scheduler.stop();
  for(const run of store.runs())assert.equal((await settle(run.id)).status,'succeeded');
  assert.deepEqual(new Set(paths.filter(path=>path.includes('/applications/')).map(path=>path.split('/applications/')[1].split('/')[0])),new Set(['com.test.a','com.test.b']));
  assert.equal(store.runs().filter(r=>r.kind==='sync-app').length,2);assert.equal(store.runs().filter(r=>r.kind==='sync').length,1);
  const restart=new AutomationScheduler(store,actions);restart.start();await restart.tick();await restart.stop();assert.equal(store.runs().filter(r=>r.kind==='sync-app').length,2);
  for(const operation of ['list-products','list-releases'])assert.equal(specFor(operation,'google-play').needsProject,'required');
});

test('complete campaign inventories remove deleted budgets while failed and partial inventories preserve cache',async t=>{
  let response:'present'|'error'|'empty'='present';
  const {store,service,settle}=await setup(t,async(address,init)=>{
    if(String(address).startsWith('https://oauth2.googleapis.com'))return Response.json({access_token:'fixture',expires_in:3600});
    const query=JSON.parse(String(init?.body)).query as string;
    if(query.includes('FROM customer'))return Response.json({results:[{customer:{id:'1234567890',currencyCode:'USD',timeZone:'UTC'}}]});
    if(response==='error')return Response.json({},{status:400});
    return Response.json({results:response==='empty'?[]:[{campaign:{id:'111',name:'Old campaign',status:'PAUSED',appCampaignSetting:{appId:'com.test.a'}},campaignBudget:{amountMicros:'100000000'}}]});
  });
  const sync=()=>settle(service.action('ads',{operation:'list-campaigns',input:{}}).id);
  assert.equal((await sync()).status,'succeeded');assert.equal(store.list('resource').length,1);
  response='error';assert.equal((await sync()).status,'failed');assert.equal(store.list('resource').length,1);
  const other={...store.list<ExternalResource>('resource')[0],id:'other',projectId:'b',connectionId:'other-ads',data:{...store.list<ExternalResource>('resource')[0].data,appIdentifier:'com.test.b',appId:'com.test.b'}};store.put('resource',other.id,other);
  // A result without the full-inventory marker must leave missing campaigns intact.
  (service as unknown as {persistResult(run:Run,connection:Connection,result:unknown):void}).persistResult({kind:'list-campaigns',input:{}} as Run,connection('ads','google-ads'),{summary:{},resources:[]});assert.equal(store.list('resource').length,2);
  response='empty';assert.equal((await sync()).status,'succeeded');assert.deepEqual(store.list<ExternalResource>('resource').map(r=>r.id),['other']);
  service.queue.pause();assert.doesNotThrow(()=>service.action('ads',{operation:'create-campaign',projectId:'a',idempotencyKey:randomUUID(),input:{name:'New',dailyBudgetMicros:'50000000',currency:'USD',targetCpaMicros:'1000000'}}));
});

test('public release observations baseline old versions and record real Play, Apple and Steam transitions once',async t=>{
  const {store}=await setup(t,async()=>{throw new Error('No network');});
  const record=(provider:Connection['provider'],kind:string,status:string,data:Record<string,unknown>,externalId='version',input:Record<string,unknown>={})=>{
    const resource={id:'release',projectId:'a',connectionId:provider,provider,kind:'release',externalId,name:'Release',status,data,updatedAt:at} as ExternalResource;
    store.writeBatch(observeReleases(store,{projectId:'a',kind,input} as Run,connection(provider,provider),[resource],{},at));
  };
  const announced=()=>store.list<ReleaseObservation>('release-observation').filter(r=>r.publishedAt);
  record('google-play','list-releases','RELEASE_LIFECYCLE_STATE_PUBLISHED',{track:'production',versionCodes:['1']});assert.equal(announced().length,0);
  record('google-play','promote-release','RELEASE_LIFECYCLE_STATE_IN_REVIEW',{track:'production',versionCodes:['2'],requestedVersionCodes:['2']});assert.equal(announced().length,0);
  record('google-play','sync-app','RELEASE_LIFECYCLE_STATE_PUBLISHED',{track:'production',versionCodes:['1','2']});assert.equal(announced().length,1);
  record('google-play','sync-app','RELEASE_LIFECYCLE_STATE_PUBLISHED',{track:'production',versionCodes:['1','2','3']});assert.equal(announced().length,2);
  record('app-store','release-version','PENDING_APPLE_RELEASE',{appStoreVersionId:'apple-v1',versionString:'1.0'});
  record('app-store','sync-app','READY_FOR_DISTRIBUTION',{appStoreVersionId:'apple-v1',versionString:'1.0'});assert.equal(announced().length,3);
  record('steam','set-live','live:beta',{appId:'480'});assert.equal(announced().length,3);
  record('steam','set-live','live:public',{appId:'480'});assert.equal(announced().length,4);
  record('steam','sync-app','live:public',{appId:'480'});record('app-store','sync-app','READY_FOR_DISTRIBUTION',{appStoreVersionId:'apple-v1',versionString:'1.0'});assert.equal(announced().length,4);
});
