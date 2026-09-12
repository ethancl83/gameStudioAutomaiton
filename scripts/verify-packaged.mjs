import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

if (!process.versions.electron) throw new Error('Run with ELECTRON_RUN_AS_NODE=1 and the packaged app-operations executable.');
const appRoot=resolve(process.argv[2]??'release/linux-unpacked/resources/app');
const {startController}=await import(pathToFileURL(join(appRoot,'dist/apps/controller/server.js')).href);
const directory=await mkdtemp(join(tmpdir(),'appops-packaged-v3-'));
const controller=await startController({directory,port:0,scanToolchains:async()=>[]});
try {
 const base=`http://127.0.0.1:${controller.port}/api`;
 assert.equal((await fetch(base+'/state')).status,401);
 const api=async(path,method='GET',body)=>{
  const response=await fetch(base+path,{method,headers:{Authorization:'Bearer '+controller.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();assert.equal(value.ok,true,JSON.stringify(value));return value.data;
 };
 const live=await api('/state');assert.equal(live.runtime.mode,'live');assert.equal(live.connections.length,0);assert.equal(live.projects.length,0);
 const demo=await api('/demo/state');assert.equal(demo.runtime.mode,'demo');assert.equal(demo.connections.length,9);assert.equal(demo.projects.length,5);
 const pipeline=await api('/demo/projects/demo-project-godot/publish','POST',{target:'android',connectionId:'demo-google-play',track:'internal',idempotencyKey:'packaged-verification'});
 let state,finished;
 for(let i=0;i<100;i++){state=await api('/demo/state');finished=state.pipelines.find(p=>p.id===pipeline.id);if(['succeeded','failed','action_required'].includes(finished?.status))break;await new Promise(r=>setTimeout(r,150));}
 assert.equal(finished?.status,'succeeded');assert.equal((await api('/state')).runs.length,0);
 const backup=await api('/demo/operations/backup','POST',{description:'Packaged controller verification'});assert.ok(backup.id);
 const result={verifiedAt:new Date().toISOString(),electron:process.versions.electron,node:process.versions.node,appRoot,unauthenticatedStatus:401,live:{mode:live.runtime.mode,connections:0,projects:0,vaultAvailable:live.vault.available},demo:{mode:demo.runtime.mode,connections:demo.connections.length,projects:demo.projects.length,pipelineStatus:finished.status,buildRunId:finished.buildRunId,uploadRunId:finished.uploadRunId,backupCreated:true},liveExternalWrites:0};
 await mkdir('docs/verification-assets',{recursive:true});await writeFile('docs/verification-assets/v3-packaged-controller.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
} finally {await controller.close();await rm(directory,{recursive:true,force:true});await rm(directory+'.demo',{recursive:true,force:true});}
