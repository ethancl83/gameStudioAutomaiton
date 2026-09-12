// ARCHIVED: pre-fix assertions intentionally describe the 2026-09-12 audit.
// Current regression coverage lives in tests/operational-fixes.test.ts and tests/imported-artifacts.test.ts.
// One-off review reproduction. Run from the repo root with node --import tsx.
// All provider responses are mocked; data is temporary and removed in finally.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Store } from '../../packages/storage/index.ts';
import { AppService } from '../../apps/controller/service.ts';
import { CredentialVault } from '../../packages/credentials/index.ts';
import { DEFAULT_POLICY } from '../../packages/domain/index.ts';
import { xConnector } from '../../packages/connectors/social.ts';
import { googlePlayConnector } from '../../packages/connectors/google-play.ts';
import { googleAdsConnector } from '../../packages/connectors/google-ads.ts';
import { AutomationScheduler } from '../../apps/controller/automation.ts';
import { SocialAutomation } from '../../apps/controller/social-automation.ts';
import { specFor } from '../../apps/desktop/src/operations.ts';
import { inspectScreenshotBytes } from '../../packages/connectors/apple-media.ts';
import { createRequire } from 'node:module';
const sharp=createRequire(new URL('../../package.json', import.meta.url))('sharp');

const directory = await mkdtemp(join(tmpdir(), 'appops-usage-review-'));
const store = new Store(directory, { heartbeat: false });
let masterKey;
const vault = new CredentialVault(join(directory, 'credentials'), { keyProvider: {name:'review-memory',getKey:async()=>masterKey,setKey:async value=>{masterKey=value;}} });
const requests=[];
let adsRemoved=false;
const mockFetch=async (address, init={})=>{
  const url=new URL(String(address)); requests.push({path:url.pathname,method:init.method??'GET'});
  if(url.origin==='https://oauth2.googleapis.com')return Response.json({access_token:'review-token',expires_in:3600,token_type:'Bearer'});
  if(url.origin==='https://api.x.com'){
    if(url.pathname==='/2/users/me')return Response.json({data:{id:'1234',username:'review'}});
    if(url.pathname==='/2/tweets'&&init.method==='POST')return Response.json({title:'Invalid Request',detail:'Request rejected'}, {status:400});
    throw new Error('Unexpected mock X request '+url.pathname);
  }
  if(url.origin==='https://androidpublisher.googleapis.com'){
    if(url.pathname.endsWith('/oneTimeProducts'))return Response.json({oneTimeProducts:[]});
    if(url.pathname.endsWith('/subscriptions'))return Response.json({subscriptions:[]});
    if(url.pathname.endsWith('/releases'))return Response.json({releases:[]});
  }
  if(url.origin==='https://googleads.googleapis.com'){
    const query=JSON.parse(String(init.body)).query;
    if(query.includes('FROM customer'))return Response.json({results:[{customer:{id:'1234567890',currencyCode:'USD',timeZone:'UTC'}}]});
    if(query.includes('FROM campaign'))return Response.json({results:adsRemoved?[]:[{campaign:{id:'111',name:'Old campaign',status:'PAUSED',appCampaignSetting:{appId:'com.review.a'}},campaignBudget:{amountMicros:'100000000'}}]});
  }
  throw new Error('Unexpected mock request '+url.origin+url.pathname);
};
const service=new AppService(store,vault,{connectors:[xConnector,googlePlayConnector,googleAdsConnector],fetch:mockFetch,scanToolchains:async()=>[]});
const at=new Date().toISOString();
const connection=(id,provider,accountId)=>({id,provider,accountId,label:id,status:'connected',authKind:'review',credentialFields:[],createdAt:at,updatedAt:at,lastCheckedAt:at,lastError:null});
const project=(id,appIdentifier)=>({id,name:id,appIdentifier,rootPath:directory,engine:'android',engineVersion:null,targets:['android'],findings:[],inspectedAt:at,createdAt:at,updatedAt:at,policy:{...DEFAULT_POLICY,autoRelease:true,allowCampaignWrites:true,allowedConnectionIds:['play','ads','x'],maxDailyBudgetMicros:'100000000',currency:'USD'},storeApps:{'google-play':{connectionId:'play',appId:appIdentifier,verifiedAt:at}}});
const report={};
async function settle(id){for(let i=0;i<250;i++){service.queue.tick();const run=store.getRun(id);if(!['queued','running','retry_wait'].includes(run.status))return run;await pause(20);}throw new Error('Run did not settle');}
function errorCode(fn){try{fn();return null;}catch(error){return error.code;}}
try{
  for(const c of [connection('x','x','1234'),connection('play','google-play','review-play'),connection('ads','google-ads','1234567890')])store.put('connection',c.id,c);
  await vault.set('x',{accessToken:'review-token',accessTokenExpiresAt:String(Date.now()+3600000),clientId:'review-client',refreshToken:'review-refresh'});
  await vault.set('play',{packageName:'com.review.a',clientId:'review-client',refreshToken:'review-refresh'});
  await vault.set('ads',{clientId:'review-client',refreshToken:'review-refresh'});
  store.put('project','app-a',project('app-a','com.review.a'));
  store.put('project','app-b',project('app-b','com.review.b'));
  service.social.savePolicy('app-a',{enabled:true,connectionIds:['x'],dailyPostLimit:1,autoReleaseAnnouncements:false,releaseTemplate:'{projectName} {version}',autoReply:false,replyRules:[]});

  const post=service.action('x',{operation:'create-post',projectId:'app-a',input:{text:'Review rejected post'},idempotencyKey:'review-post-400'});
  const rejected=await settle(post.id);
  const reconciliation=await settle(service.reconcile(post.id).id);
  report.rejectedWrite={status:rejected.status,failureCode:rejected.result?.failureCode,effect:store.effectState(post.id),cancel:errorCode(()=>store.cancel(post.id)),retry:errorCode(()=>store.retry(post.id)),reconcileStatus:reconciliation.status,reconcileFailure:reconciliation.result?.failureCode,nextPost:errorCode(()=>service.action('x',{operation:'create-post',projectId:'app-a',input:{text:'A valid different post'},idempotencyKey:'review-next-post'}))};
  assert.equal(report.rejectedWrite.status,'action_required');assert.equal(report.rejectedWrite.nextPost,'SOCIAL_DAILY_LIMIT');

  const scheduler=new AutomationScheduler(store,{build:()=>{throw new Error('Build outside review');},action:(id,input)=>service.action(id,input),reconcile:id=>service.reconcile(id),supported:provider=>provider==='google-play'});
  // Disable release automation for the scheduler-only probe.
  for(const p of store.list('project'))store.put('project',p.id,{...p,policy:{...p.policy,autoRelease:false}});
  requests.length=0;scheduler.start();await scheduler.tick();await scheduler.stop();
  const autoSync=store.runs().find(run=>run.kind==='sync');await settle(autoSync.id);
  const autoPackages=[...new Set(requests.filter(r=>r.path.includes('/applications/')).map(r=>r.path.split('/applications/')[1].split('/')[0]))];
  requests.length=0;await settle(service.action('play',{operation:'list-products',projectId:'app-b',input:{}}).id);
  report.multiAppSync={automaticProjectId:autoSync.projectId,automaticPackages:autoPackages,explicitProjectPackages:[...new Set(requests.filter(r=>r.path.includes('/applications/')).map(r=>r.path.split('/applications/')[1].split('/')[0]))],productListHasProjectSelector:!!specFor('list-products','google-play').needsProject,releaseListHasProjectSelector:!!specFor('list-releases','google-play').needsProject};
  assert.deepEqual(autoPackages,['com.review.a']);assert.deepEqual(report.multiAppSync.explicitProjectPackages,['com.review.b']);

  await settle(service.action('ads',{operation:'list-campaigns',input:{}}).id);
  adsRemoved=true;const refreshed=await settle(service.action('ads',{operation:'list-campaigns',input:{}}).id);
  const stale=store.list('resource').filter(r=>r.kind==='campaign');
  report.deletedCampaign={freshProviderCount:refreshed.result?.campaignCount,cachedCount:stale.length,cachedStatus:stale[0]?.status,newCampaign:errorCode(()=>service.action('ads',{operation:'create-campaign',projectId:'app-a',input:{name:'New campaign',dailyBudgetMicros:'50000000',currency:'USD',targetCpaMicros:'1000000'},idempotencyKey:'review-new-campaign'}))};
  assert.equal(report.deletedCampaign.freshProviderCount,0);assert.equal(report.deletedCampaign.newCampaign,'BUDGET_LIMIT');

  let announcementCount=0;
  const announcementProject={...project('announce','com.review.announce'),policy:{...DEFAULT_POLICY}};store.put('project','announce',announcementProject);
  const social=new SocialAutomation(store,{supported:()=>true,action:()=>{announcementCount++;return {id:'announcement-'+announcementCount};}});
  social.savePolicy('announce',{enabled:true,connectionIds:['x'],dailyPostLimit:5,autoReleaseAnnouncements:true,releaseTemplate:'Released {projectName}',autoReply:false,replyRules:[]});
  store.put('settings','social-enabled-since:announce',{at:0});
  for(const kind of ['promote-release','release-version','set-live']){
    const run=store.createRun({kind,projectId:'announce',connectionId:'play',label:kind,input:{track:'production',branch:'public'}});const claim=store.claim();store.finish(run.id,claim.token,'succeeded',{state:'PUBLISHED'});
  }
  social.cycle();const afterPublicOperations=announcementCount;
  const internalUpload=store.createRun({kind:'upload-build',projectId:'announce',connectionId:'play',label:'upload control',input:{track:'production'}});const claim=store.claim();store.finish(internalUpload.id,claim.token,'succeeded',{versionCode:'3'});social.cycle();
  report.releaseAnnouncements={afterPublicReleaseOperations:afterPublicOperations,afterUploadRun:announcementCount};
  assert.equal(afterPublicOperations,0);assert.equal(announcementCount,1);

  const png=await sharp({create:{width:1290,height:2796,channels:3,background:{r:100,g:100,b:100}}}).png().toBuffer();
  report.validScreenshot=await inspectScreenshotBytes('review.png',png);
  console.log(JSON.stringify(report,null,2));
  await writeFile('/tmp/appops-operational-review-results.json',JSON.stringify(report,null,2)+'\n');
}finally{await service.stop();store.close();await rm(directory,{recursive:true,force:true});}
