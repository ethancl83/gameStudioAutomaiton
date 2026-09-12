import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CredentialVault, DirectoryKeyProvider, type KeyProvider } from '../packages/credentials/index.js';
import { readBackup, writeBackup } from '../packages/backup/archive.js';
import { createPortableSnapshot, restorePortableSnapshot } from '../packages/backup/snapshot.js';
import { Store } from '../packages/storage/index.js';
import { DEFAULT_POLICY, type Project } from '../packages/domain/index.js';

function providers(){
  const keys=new Map<string,Buffer>();
  const factory=(account='legacy'):KeyProvider=>({name:'test-slots',getKey:async()=>keys.get(account),setKey:async key=>{keys.set(account,Buffer.from(key));}});
  return {keys,factory,vault:(path:string)=>new CredentialVault(path,{keyProvider:new DirectoryKeyProvider(path,factory)})};
}
async function temporary(t:{after(fn:()=>Promise<void>):void}){const dir=await mkdtemp(join(tmpdir(),'appops-full-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('encrypted archive streams multiple frames, rejects wrong passwords, corruption and truncation',async t=>{
  const root=await temporary(t),archive=join(root,'test.appopsbackup'),password=randomBytes(24).toString('base64url');
  const artifact=randomBytes(2*1024*1024+77),secret='fixture-portable-credential-only';
  await writeBackup(archive,password,[{kind:'manifest',path:'manifest.json',data:Buffer.from('{}')},{kind:'database',path:'operations.sqlite',data:Buffer.from('db-fixture')},{kind:'data',path:'artifacts/run/large.bin',data:artifact},{kind:'vault',path:'vault/account',data:Buffer.from(secret)}]);
  const encoded=await readFile(archive);assert.equal(encoded.includes(Buffer.from(secret)),false);
  const restored=new Map<string,Buffer>();let largest=0;
  await readBackup(archive,password,async meta=>{const chunks:Buffer[]=[];return {write:async bytes=>{largest=Math.max(largest,bytes.length);chunks.push(bytes);},finish:async()=>{restored.set(meta.path,Buffer.concat(chunks));}};});
  assert.deepEqual(restored.get('artifacts/run/large.bin'),artifact);assert.ok(largest<=1024*1024);
  let entries=0;
  await assert.rejects(()=>readBackup(archive,randomBytes(24).toString('base64url'),async()=>{entries++;throw Error('must not run');}),/암호/);assert.equal(entries,0);
  for(const [name,bytes] of [['truncated',encoded.subarray(0,-7)],['tampered',Buffer.from(encoded)]] as const){
    if(name==='tampered')bytes[Math.floor(bytes.length/2)]!^=1;
    const path=join(root,name);await writeFile(path,bytes);
    await assert.rejects(()=>readBackup(path,password,async()=>({write:async()=>{},finish:async()=>{}})));
  }
});

test('writeBackup writes schema 2 (p=3), enforces reader structure, and honors cancellation',async t=>{
  const root=await temporary(t),password=randomBytes(24).toString('base64url');
  const archive=join(root,'s2.appopsbackup');
  await writeBackup(archive,password,[{kind:'manifest',path:'manifest.json',data:Buffer.from('{}')},{kind:'database',path:'operations.sqlite',data:Buffer.from('db-fixture')}]);
  const buf=await readFile(archive);const header=JSON.parse(buf.subarray(12,12+buf.readUInt32BE(8)).toString('utf8'));
  assert.equal(header.schema,2);assert.equal(header.kdf.p,3);
  // F3: a caller that omits the database entry fails loudly at write time, not silently at restore.
  await assert.rejects(()=>writeBackup(join(root,'bad.appopsbackup'),password,[{kind:'manifest',path:'manifest.json',data:Buffer.from('{}')}]),/구조가 올바르지 않습니다/);
  // Cancellation surfaces as a BACKUP_CANCELLED AppError and leaves no file behind.
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>writeBackup(join(root,'cancelled.appopsbackup'),password,[{kind:'manifest',path:'manifest.json',data:Buffer.from('{}')}],{signal:controller.signal}),(e:{code?:string})=>e.code==='BACKUP_CANCELLED');
});

test('fresh vaults have independent key slots and legacy encrypted records remain readable',async t=>{
  const root=await temporary(t),p=providers(),a=p.vault(join(root,'a')),b=p.vault(join(root,'b'));
  await a.set('account',{token:'fixture-a'});await b.set('account',{token:'fixture-b'});
  assert.equal(p.keys.size,2);assert.notEqual((await readFile(join(root,'a/key-slot.json'),'utf8')),(await readFile(join(root,'b/key-slot.json'),'utf8')));
  const legacyPath=join(root,'legacy');const old=new CredentialVault(legacyPath,{keyProvider:p.factory()});await old.set('old',{token:'fixture-legacy'});
  assert.deepEqual(await p.vault(legacyPath).get('old'),{token:'fixture-legacy'});
  assert.deepEqual(await p.vault(join(root,'a')).get('account'),{token:'fixture-a'});
});

test('full snapshot restores WAL history, effects, files and credentials, fencing replay before Store opens',async t=>{
  const root=await temporary(t),p=providers(),source=join(root,'source'),target=join(root,'target'),stage=join(root,'stage');
  const store=new Store(source,{heartbeat:false});t.after(async()=>store.close());const vault=p.vault(join(source,'credentials'));
  await vault.set('store-account',{refreshToken:'fixture-refresh',privateKey:'fixture-signing-key'});
  const project:Project={id:'project-one',name:'Restored game',rootPath:join(root,'external-source'),engine:'godot',engineVersion:'4.3',targets:['linux'],appIdentifier:'com.example.restore',findings:[],inspectedAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),policy:{...DEFAULT_POLICY,autoBuild:true,autoRelease:true,allowedConnectionIds:['store-account']}};
  store.put('project',project.id,project);
  store.put('connection','store-account',{id:'store-account',status:'connected',lastCheckedAt:'2026-09-11'});
  store.put('settings','tool-settings',{javaHome:'/old/jdk'});store.put('settings','tool-installations',[{id:'install-old',status:'installing'}]);
  const run=store.createRun({kind:'upload-build',connectionId:'store-account',projectId:project.id,label:'Fixture release',input:{appId:'123'},writeEffect:true,idempotencyKey:'backup_fixture_request'});
  const claimed=store.claim()!;store.markDispatched(run.id,claimed.token);
  store.put('pipeline','pipeline-one',{id:'pipeline-one',projectId:project.id,status:'uploading',buildRunId:'completed-build',input:{}});
  const asset=join(source,'artifacts','run-one','game.bin');await mkdir(join(source,'artifacts','run-one'),{recursive:true});await writeFile(asset,'immutable artifact');
  await mkdir(target);const oldVault=p.vault(join(target,'credentials'));await oldVault.set('existing',{token:'existing-target-secret'});
  const oldSlot=await readFile(join(target,'credentials/key-slot.json'),'utf8');
  const password=randomBytes(24).toString('base64url'),archive=join(root,'portable.appopsbackup');
  await createPortableSnapshot(store,vault,archive,password);
  const summary=await restorePortableSnapshot(archive,password,stage,target,{vaultFactory:p.vault});
  assert.equal(summary.projects,1);assert.equal(summary.credentials,1);
  assert.equal(await readFile(join(stage,'artifacts/run-one/game.bin'),'utf8'),'immutable artifact');
  assert.deepEqual(await p.vault(join(stage,'credentials')).get('store-account'),{refreshToken:'fixture-refresh',privateKey:'fixture-signing-key'});
  assert.equal(await readFile(join(target,'credentials/key-slot.json'),'utf8'),oldSlot);assert.deepEqual(await oldVault.get('existing'),{token:'existing-target-secret'});
  const db=new DatabaseSync(join(stage,'operations.sqlite'));try{
    assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(run.id)!.status,'action_required');
    assert.equal(db.prepare('SELECT state FROM effects WHERE run_id=?').get(run.id)!.state,'action_required');
    assert.equal(db.prepare('SELECT count(*) AS n FROM controller').get()!.n,0);
    const restored=JSON.parse(String(db.prepare("SELECT payload FROM documents WHERE kind='project'").get()!.payload));assert.equal(restored.relinkRequired,true);assert.equal(restored.policy.autoBuild,false);assert.equal(restored.policy.autoRelease,false);
    assert.equal(JSON.parse(String(db.prepare("SELECT payload FROM documents WHERE kind='pipeline'").get()!.payload)).restoredPaused,true);
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT payload FROM documents WHERE kind='settings' AND id='tool-settings'").get()!.payload)),{});
    assert.equal(db.prepare('SELECT dedupe_key FROM runs WHERE id=?').get(run.id)!.dedupe_key,'backup_fixture_request');
  }finally{db.close();}
});
