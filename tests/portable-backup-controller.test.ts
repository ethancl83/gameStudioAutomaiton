import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startController, type RunningController } from '../apps/controller/server.js';
import { Store } from '../packages/storage/index.js';
import { CredentialVault, DirectoryKeyProvider, type KeyProvider } from '../packages/credentials/index.js';
import { createPortableSnapshot, restorePortableSnapshot } from '../packages/backup/snapshot.js';
import { activatePendingRestore, readPendingRestore, requestRestoreActivation, restoreStage, stageRestoreActivation } from '../packages/backup/activation.js';
import type { PortableBackupState } from '../packages/backup/types.js';
import type { Connector } from '../packages/connectors/types.js';

async function fixture(t:{after(fn:()=>Promise<void>):void}){
  const root=await mkdtemp(join(tmpdir(),'appops-backup-api-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const keys=new Map<string,Buffer>();
  const provider=(account='legacy'):KeyProvider=>({name:'test-slots',getKey:async()=>keys.get(account),setKey:async key=>{keys.set(account,Buffer.from(key));}});
  const vault=(directory:string)=>new CredentialVault(directory,{keyProvider:new DirectoryKeyProvider(directory,provider)});
  return {root,vault};
}
async function request(controller:RunningController,path:string,method='GET',body?:unknown){
  const response=await fetch(`http://127.0.0.1:${controller.port}/api${path}`,{method,headers:{authorization:'Bearer '+controller.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json() as {ok:boolean;data:any;error?:{message:string;code:string}};
  assert.equal(value.ok,true,value.error?.message);return value.data;
}
async function waitFor(controller:RunningController,predicate:(s:PortableBackupState)=>boolean,prefix=''){
  for(let i=0;i<300;i++){
    const state=await request(controller,prefix+'/operations/portable-backups') as PortableBackupState;
    if(state.backups.some(b=>b.status==='failed')||state.restore?.status==='failed')throw new Error(state.restore?.error??state.backups.find(b=>b.status==='failed')?.error);
    if(predicate(state))return state;
    await new Promise(resolve=>setTimeout(resolve,20));
  }throw new Error('Backup operation did not settle');
}
async function prepared(root:string,vault:(directory:string)=>CredentialVault){
  const data=join(root,'target'),source=join(root,'source'),store=new Store(source,{heartbeat:false}),old=new Store(data,{heartbeat:false});
  await vault(join(source,'credentials')).set('new-account',{token:'fixture-new'});
  await vault(join(data,'credentials')).set('old-account',{token:'fixture-old'});
  store.put('settings','fixture',{value:'new'});old.put('settings','fixture',{value:'old'});old.close();
  const password=randomBytes(24).toString('base64url'),archive=join(root,'backup.appopsbackup');
  try{await createPortableSnapshot(store,vault(join(source,'credentials')),archive,password);}finally{store.close();}
  await mkdir(data+'.recovery',{mode:0o700});const id=randomUUID(),stage=restoreStage(data,id);
  const summary=await restorePortableSnapshot(archive,password,stage,data,{vaultFactory:vault});
  await stageRestoreActivation(data,id,randomUUID(),summary);await requestRestoreActivation(data,id);
  return {data,id,stage};
}

test('restore refuses a running controller and preserves its data and pending intent',async t=>{
  const {root,vault}=await fixture(t),{data}=await prepared(root,vault);
  const running=new Store(data,{heartbeat:false});
  try{await assert.rejects(()=>activatePendingRestore(data),/중지/);assert.equal((await readPendingRestore(data))?.phase,'requested');assert.equal(running.get<{value:string}>('settings','fixture')?.value,'old');}
  finally{running.close();}
});

test('restore verifies staged bytes and rolls back startup failures with both key slots preserved',async t=>{
  const {root,vault}=await fixture(t),{data,id}=await prepared(root,vault);
  const oldSlot=await readFile(join(data,'credentials/key-slot.json'),'utf8');
  const activation=await activatePendingRestore(data);assert.ok(activation);
  assert.deepEqual(await vault(join(data,'credentials')).get('new-account'),{token:'fixture-new'});
  await activation.rollback();
  assert.equal(await readFile(join(data,'credentials/key-slot.json'),'utf8'),oldSlot);
  assert.deepEqual(await vault(join(data,'credentials')).get('old-account'),{token:'fixture-old'});
  assert.deepEqual(await vault(join(data+'.recovery','failed-'+id,'credentials')).get('new-account'),{token:'fixture-new'});
  assert.equal((await readPendingRestore(data))?.phase,'rolled-back');
});

test('modified staged files never replace the current database',async t=>{
  const {root,vault}=await fixture(t),{data,stage}=await prepared(root,vault);
  await writeFile(join(stage,'unexpected-file'),'changed after prepare');
  await assert.rejects(()=>activatePendingRestore(data),/바뀌었습니다/);
  const store=new Store(data,{heartbeat:false});try{assert.equal(store.get<{value:string}>('settings','fixture')?.value,'old');}finally{store.close();}
});

test('controller boot health failure restores and restarts the previous database',async t=>{
  const {root,vault}=await fixture(t),{data}=await prepared(root,vault);let attempts=0;
  const controller=await startController({directory:data,port:0,backupVaultFactory:vault,scanToolchains:async()=>{if(attempts++===0)throw new Error('fixture startup failure');return [];}});t.after(()=>controller.close());
  assert.equal(attempts,2);assert.equal((await readPendingRestore(data))?.phase,'rolled-back');
  assert.equal(controller.service.store.get<{value:string}>('settings','fixture')?.value,'old');
  assert.deepEqual(await controller.service.vault.get('old-account'),{token:'fixture-old'});
});

test('a process exit after either rename boundary recovers the authenticated transaction',async t=>{
  for(const phase of ['old-moved','installed']){
    const {root,vault}=await fixture(t),{data}=await prepared(root,vault);
    const code=`import {activatePendingRestore} from './packages/backup/activation.ts';await activatePendingRestore(process.env.APPOPS_TEST_DATA,{afterPhase:async phase=>{if(phase===process.env.APPOPS_TEST_PHASE)process.exit(23)}});`;
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,APPOPS_TEST_DATA:data,APPOPS_TEST_PHASE:phase},stdio:'ignore'});
    const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(exit,23);
    const resumed=await activatePendingRestore(data);assert.ok(resumed);await resumed.commit();
    assert.equal((await readPendingRestore(data))?.phase,'committed');assert.deepEqual(await vault(join(data,'credentials')).get('new-account'),{token:'fixture-new'});
  }
});

test('HTTP full backup restores credentials and history across controller restart with zero provider calls',async t=>{
  const {root,vault}=await fixture(t),directory=join(root,'live');let calls=0;
  const connector:Connector={capability:{provider:'google-ads',name:'Fixture',category:'marketing',description:'Fixture',authKind:'OAuth',fields:[],operations:['sync'],setupUrl:'https://developers.google.com/google-ads/api/docs/start',limitations:[]},execute:async()=>{calls++;return {summary:{}};}};
  const options={directory,port:0,backupVaultFactory:vault,connectors:[connector],scanToolchains:async()=>[]};
  let controller=await startController(options);t.after(()=>controller.close());
  const store=controller.service.store;
  await controller.service.vault.set('account',{refreshToken:'fixture-restored-token'});
  store.put('connection','account',{id:'account',provider:'google-ads',status:'connected',credentialFields:['refreshToken']});
  store.put('settings','auto-sync:account',{at:Date.now()+86_400_000});
  store.put('settings','history-fixture',{value:'before-backup'});
  const password=randomBytes(24).toString('base64url');
  const created=await request(controller,'/operations/portable-backups','POST',{passphrase:password});
  await waitFor(controller,s=>s.backups.some(b=>b.id===created.id&&b.status==='ready'));
  store.put('settings','after-backup',{value:'not in archive'});
  const restored=await request(controller,`/operations/portable-backups/${created.id}/prepare-restore`,'POST',{passphrase:password});
  await waitFor(controller,s=>s.restore?.id===restored.id&&s.restore?.status==='ready');
  assert.deepEqual(await request(controller,'/operations/portable-backups/commit-restore','POST',{restoreId:restored.id}),{restartRequired:true});
  await controller.close();controller=await startController(options);
  assert.deepEqual(await controller.service.vault.get('account'),{refreshToken:'fixture-restored-token'});
  assert.equal(controller.service.store.get('settings','after-backup'),undefined);
  assert.equal(controller.service.store.get<{value:string}>('settings','history-fixture')?.value,'before-backup');
  assert.equal(controller.service.store.get<{status:string}>('connection','account')?.status,'action_required');
  await controller.service.scheduler.tick();assert.equal(calls,0);
  assert.equal((await request(controller,'/operations/portable-backups')).restore.status,'committed');
  const metadata=await readFile(join(directory+'.portable-backups',created.id+'.json'),'utf8');assert.equal(metadata.includes(password),false);
});

test('demo binary export/import/restore stays isolated from the live store',async t=>{
  const {root,vault}=await fixture(t),directory=join(root,'live');
  const controller=await startController({directory,port:0,backupVaultFactory:vault,scanToolchains:async()=>[]});t.after(()=>controller.close());
  controller.service.store.put('settings','live-marker',{value:'preserved'});
  const state=await request(controller,'/demo/state');assert.equal(state.projects.length,5);
  const password=randomBytes(24).toString('base64url'),created=await request(controller,'/demo/operations/portable-backups','POST',{passphrase:password});
  await waitFor(controller,s=>s.backups.some(b=>b.id===created.id&&b.status==='ready'),'/demo');
  const headers={authorization:'Bearer '+controller.token};
  const url=`http://127.0.0.1:${controller.port}/api/demo/operations/portable-backups`;
  const download=await fetch(`${url}/${created.id}/download`,{headers});assert.equal(download.status,200);
  const bytes=Buffer.from(await download.arrayBuffer());assert.equal(Number(download.headers.get('content-length')),bytes.length);assert.equal(bytes.subarray(0,8).toString(),'APPOPSB1');
  const imported=await fetch(url+'/import',{method:'POST',headers:{...headers,'content-type':'application/octet-stream'},body:bytes});
  const result=await imported.json() as {ok:boolean;data:{id:string;size:number}};assert.equal(result.ok,true);assert.equal(result.data.size,bytes.length);
  const restored=await request(controller,`/demo/operations/portable-backups/${result.data.id}/prepare-restore`,'POST',{passphrase:password});
  await waitFor(controller,s=>s.restore?.id===restored.id&&s.restore?.status==='ready','/demo');
  assert.deepEqual(await request(controller,'/demo/operations/portable-backups/commit-restore','POST',{restoreId:restored.id}),{restartRequired:false,restored:true});
  assert.equal((await request(controller,'/demo/state')).projects.length,5);
  assert.equal(controller.service.store.get<{value:string}>('settings','live-marker')?.value,'preserved');
  assert.equal(controller.service.store.list('project').length,0);
});
