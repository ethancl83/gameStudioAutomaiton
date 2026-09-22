import test from'node:test';import assert from'node:assert/strict';
import{chmod,mkdtemp,mkdir,readFile,rm,stat,symlink,writeFile}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
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

test('runner stays on loopback by default and all-interface listening requires an explicit option',async t=>{
 const root=await mkdtemp(join(tmpdir(),'appops-runner-listen-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const host of [undefined,'127.0.0.1','0.0.0.0']){
  const runner=await startRemoteRunner({directory:join(root,host??'default'),port:0,host});
  try{
   assert.equal(runner.host,host??'127.0.0.1');
   const token=await readFile(runner.tokenPath,'utf8');assert.ok(token.length>=24);
   assert.equal((await stat(runner.tokenPath)).mode&0o777,0o600);
   assert.equal((await fetch(`http://127.0.0.1:${runner.port}/health`)).status,401);
   // An authenticated unknown path proves reachability without running a host toolchain probe.
   assert.equal((await fetch(`http://127.0.0.1:${runner.port}/unknown`,{headers:{Authorization:`Bearer ${token}`}})).status,404);
  }finally{await runner.close();}
 }
});

test('runner refuses unsupported listen addresses before creating credentials or directories',async t=>{
 const root=await mkdtemp(join(tmpdir(),'appops-runner-invalid-host-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const host of ['','localhost','::','::1','192.168.1.20','runner.example','0.0.0.0:4320']){
  const directory=join(root,'not-created');
  await assert.rejects(startRemoteRunner({directory,port:0,host}),{code:'INVALID_RUNNER_HOST'});
  await assert.rejects(stat(directory),{code:'ENOENT'});
 }
});

test('runner reuses a private pairing file and refuses exposed or linked files on restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'appops-runner-pairing-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const first=await startRemoteRunner({directory,port:0});const token=await readFile(first.tokenPath,'utf8');await first.close();
 const second=await startRemoteRunner({directory,port:0});
 try{assert.equal(await readFile(second.tokenPath,'utf8'),token);}finally{await second.close();}
 if(process.platform!=='win32'){
  await chmod(first.tokenPath,0o644);
  await assert.rejects(startRemoteRunner({directory,port:0}),{code:'INVALID_RUNNER_AUTH_FILE'});
 }
 await rm(first.tokenPath);await writeFile(join(directory,'other'),token,{mode:0o600});await symlink(join(directory,'other'),first.tokenPath);
 await assert.rejects(startRemoteRunner({directory,port:0}),{code:'INVALID_RUNNER_AUTH_FILE'});
});
