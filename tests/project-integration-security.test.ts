import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyIntegration, previewIntegration, rollbackIntegration, recoverIncomplete, withIntegrationStorage, type IntegrationRequest } from '../packages/project-integration/index.js';
import { readJournal, writeJournal } from '../packages/project-integration/journal.js';

async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'appops-sdk-safety-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=join(dir,'project'),storage=join(dir,'controller','sdk');await mkdir(join(root,'app/src/main'),{recursive:true});
 await writeFile(join(root,'settings.gradle'),"include ':app'\n");
 await writeFile(join(root,'app/build.gradle'),"plugins { id 'com.android.application' }\nandroid { namespace 'com.appops.demo' }\ndependencies { }\n");
 await writeFile(join(root,'app/src/main/AndroidManifest.xml'),'<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application>\n</application></manifest>');
 const request:IntegrationRequest={projectRoot:root,engine:'android',platform:'android',provider:'admob',appId:'ca-app-pub-3940256099942544~3347511713',adUnits:[{adUnitId:'ca-app-pub-3940256099942544/5224354917',adFormat:'REWARD'}]};
 const run=<T>(fn:()=>Promise<T>)=>withIntegrationStorage(root,storage,fn);
 return {dir,root,storage,request,run};
}

test('untrusted project journal and symlink cannot supply or redirect SDK instructions',async t=>{
 const f=await fixture(t);const outside=join(f.dir,'outside');await mkdir(outside);
 await mkdir(join(f.root,'.appops'));await symlink(outside,join(f.root,'.appops/integration'));
 const preview=await f.run(()=>previewIntegration(f.request));
 assert.ok(preview.supported);assert.ok(preview.journalPath.startsWith(f.storage));
 await writeFile(join(outside,'journal.json'),JSON.stringify({applyId:preview.previewId,status:'committed',files:[{path:'../outside/sentinel'}]}));
 const applied=await f.run(()=>applyIntegration({previewId:preview.previewId,projectRoot:f.root}));assert.equal(applied.status,'applied');
 assert.equal(await readFile(join(outside,'journal.json'),'utf8'),JSON.stringify({applyId:preview.previewId,status:'committed',files:[{path:'../outside/sentinel'}]}));
 await assert.rejects(()=>withIntegrationStorage(f.root,join(f.root,'.appops'),()=>previewIntegration(f.request)),/경로가 겹칩니다/);
});

test('private storage symlink and forged IDs are rejected before writes',async t=>{
 const f=await fixture(t);const preview=await f.run(()=>previewIntegration(f.request));
 await assert.rejects(()=>f.run(()=>applyIntegration({projectRoot:f.root,previewId:'../../outside'})),/ID/);
 await rm(join(f.storage,'previews'),{recursive:true});await mkdir(join(f.dir,'outside'));await symlink(join(f.dir,'outside'),join(f.storage,'previews'));
 await assert.rejects(()=>f.run(()=>applyIntegration({projectRoot:f.root,previewId:preview.previewId})),/링크/);
});

test('repeat apply and rollback preserve exact originals; later editor changes block rollback',async t=>{
 const f=await fixture(t);const path=join(f.root,'app/build.gradle'),original=await readFile(path,'utf8');
 const preview=await f.run(()=>previewIntegration(f.request));const first=await f.run(()=>applyIntegration({projectRoot:f.root,previewId:preview.previewId}));assert.equal(first.status,'applied');
 const second=await f.run(()=>applyIntegration({projectRoot:f.root,previewId:preview.previewId}));assert.equal(second.applyId,first.applyId);
 const generated=await readFile(path,'utf8');await writeFile(path,generated+'\n// editor change\n');
 const conflict=await f.run(()=>rollbackIntegration(first.applyId,f.root));assert.equal(conflict.status,'conflict');assert.match(await readFile(path,'utf8'),/editor change/);
 await writeFile(path,generated);const rollback=await f.run(()=>rollbackIntegration(first.applyId,f.root));assert.equal(rollback.status,'rolled_back');assert.equal(await readFile(path,'utf8'),original);
 const noop=await f.run(()=>rollbackIntegration(first.applyId,f.root));assert.equal(noop.status,'noop');
});

test('damaged original backup causes no partial rollback',async t=>{
 const f=await fixture(t);const preview=await f.run(()=>previewIntegration(f.request));const applied=await f.run(()=>applyIntegration({projectRoot:f.root,previewId:preview.previewId}));
 const record=(await f.run(()=>readJournal(f.root)))!;const index=record.files.findIndex(file=>file.beforeHash!==null);assert.ok(index>=0);
 await writeFile(join(f.storage,'backups',applied.applyId,index+'.txt'),'tampered backup');
 const before=await Promise.all(record.files.map(file=>readFile(join(f.root,file.path),'utf8')));
 await assert.rejects(()=>f.run(()=>rollbackIntegration(applied.applyId,f.root)),/백업이 손상/);
 assert.deepEqual(await Promise.all(record.files.map(file=>readFile(join(f.root,file.path),'utf8'))),before);
});

test('crash journal is preserved across another preview, stale process lock recovers',async t=>{
 const f=await fixture(t);const path=join(f.root,'app/build.gradle'),original=await readFile(path,'utf8');
 const preview=await f.run(()=>previewIntegration(f.request));const applied=await f.run(()=>applyIntegration({projectRoot:f.root,previewId:preview.previewId}));
 const record=(await f.run(()=>readJournal(f.root)))!;
 await f.run(()=>writeJournal(f.root,{...record,status:'applying'}));
 // A later read/preview must not erase a recoverable application record.
 await f.run(()=>previewIntegration(f.request));assert.equal((await f.run(()=>readJournal(f.root)))?.applyId,applied.applyId);
 await writeFile(join(f.storage,'journal.lock'),JSON.stringify({pid:2147483646,nonce:'terminated-process'}));
 const result=await f.run(()=>recoverIncomplete(f.root));assert.equal(result?.status,'rolled_back');assert.equal(await readFile(path,'utf8'),original);
});
