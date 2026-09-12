import test from'node:test';import assert from'node:assert/strict';
import{mkdtemp,mkdir,readFile,rm,stat,symlink,writeFile}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import{packFiles,unpackFiles}from'../packages/remote-runner/index.js';import{startRemoteRunner}from'../apps/runner/remote.js';
import{runnerEndpoint}from'../apps/controller/operations.js';

test('remote bundles preserve bytes and executable modes, omit secrets, reject traversal/hash/case collisions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'appops-bundle-'));t.after(()=>rm(root,{recursive:true,force:true}));const src=join(root,'source');await mkdir(src);await writeFile(join(src,'run'),'hello',{mode:0o700});await writeFile(join(src,'.env'),'do-not-transfer');await mkdir(join(src,'.git'));await writeFile(join(src,'.git','config'),'private');
 const bundle=await packFiles(src);assert.deepEqual(bundle.files.map(f=>f.path),['run']);await unpackFiles(bundle,join(root,'dest'));assert.equal(await readFile(join(root,'dest','run'),'utf8'),'hello');assert.ok((await stat(join(root,'dest','run'))).mode&0o100);
 await assert.rejects(unpackFiles({files:[{...bundle.files[0],path:'../escape'}]},join(root,'unsafe')),{code:'INVALID_BUNDLE'});
 await assert.rejects(unpackFiles({files:[{...bundle.files[0],sha256:'wrong'}]},join(root,'unsafe')),{code:'BUNDLE_DAMAGED'});
 await assert.rejects(unpackFiles({files:[bundle.files[0],{...bundle.files[0],path:'RUN'}]},join(root,'unsafe')),{code:'INVALID_BUNDLE'});
 await symlink('/etc/passwd',join(src,'link'));await assert.rejects(packFiles(src),{code:'INVALID_BUNDLE'});
});
test('remote runner requires pairing, rejects browser origins, malformed source and arbitrary commands',async t=>{
 const root=await mkdtemp(join(tmpdir(),'appops-remote-'));const token='test-runner-pairing-code-123456789';let executes=0;
 const runner=await startRemoteRunner({directory:root,port:0,token,execute:async()=>{executes++;throw new Error('must not execute');}});
 t.after(async()=>{await runner.close();await rm(root,{recursive:true,force:true});});const base='http://127.0.0.1:'+runner.port;
 assert.equal((await fetch(base+'/health')).status,401);assert.equal((await fetch(base+'/health',{headers:{Authorization:'Bearer '+token,Origin:'https://evil.invalid'}})).status,401);
 const health=await fetch(base+'/health',{headers:{Authorization:'Bearer '+token}});assert.equal(health.status,200);assert.equal((await health.json()).protocol,'appops-runner-v1');
 const r=await fetch(base+'/build',{method:'POST',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({runId:'../escape',target:'linux',source:{files:[]},command:'do not execute'})});assert.equal(r.status,400);assert.equal(executes,0);
});
test('runner endpoints permit private HTTPS or local tunnels and reject credentials and cleartext remote hosts',()=>{
 assert.equal(runnerEndpoint('https://runner.example/agent/'),'https://runner.example/agent');assert.equal(runnerEndpoint('http://127.0.0.1:4320'),'http://127.0.0.1:4320');
 for(const url of['http://remote.example','https://user:password@example.test','file:///tmp/secret','https://runner.example?token=secret','https://runner.example#x'])assert.throws(()=>runnerEndpoint(url));
});
