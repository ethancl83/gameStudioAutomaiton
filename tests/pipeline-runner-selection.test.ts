import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../packages/storage/index.js';
import {ReleasePipelines} from '../apps/controller/pipelines.js';
import {DEFAULT_POLICY,type Project,type Connection,type Run,type RunnerRegistration} from '../packages/domain/index.js';

test('iOS pipeline waives only the local Mac requirement for a ready Mac runner',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pipeline-runner-'));const store=new Store(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const now=new Date().toISOString();
 const project:Project={id:'project',name:'iOS',engine:'ios',engineVersion:null,rootPath:dir,appIdentifier:'com.example.ios',targets:['ios'],findings:[{code:'ios.requires_macos',severity:'error',message:'Mac required'}],policy:{...DEFAULT_POLICY,autoRelease:true,allowedConnectionIds:['apple']},inspectedAt:now,createdAt:now,updatedAt:now};
 const connection:Connection={id:'apple',provider:'app-store',label:'Apple',accountId:'account',status:'connected',authKind:'test',credentialFields:[],lastError:null,lastCheckedAt:now,createdAt:now,updatedAt:now};
 const runner:RunnerRegistration={id:'mac',label:'Mac',platform:'darwin',endpoint:'https://runner.example',status:'ready',lastCheckedAt:now,lastError:null,createdAt:now};
 store.put('project',project.id,project);store.put('connection',connection.id,connection);store.put('runner',runner.id,runner);
 let builds=0;
 const pipelines=new ReleasePipelines(store,{inspect:async()=>project,action:()=>{throw new Error('unexpected upload');},cancel:()=>{throw new Error('unexpected cancel');},build:(_id,_input,pipeline)=>{builds++;store.put('pipeline',pipeline!.id,{...pipeline,buildRunId:'build'});return{id:'build'} as Run;}});
 const input={target:'ios',connectionId:'apple'};
 await assert.rejects(pipelines.publish(project.id,input),{code:'INSPECTION_FAILED'});
 store.put('runner',runner.id,{...runner,status:'unavailable'});await assert.rejects(pipelines.publish(project.id,{...input,runnerId:'mac'}),{code:'INSPECTION_FAILED'});
 store.put('runner',runner.id,{...runner,platform:'linux'});await assert.rejects(pipelines.publish(project.id,{...input,runnerId:'mac'}),{code:'INSPECTION_FAILED'});
 store.put('runner',runner.id,runner);
 project.findings.push({code:'source.invalid',severity:'error',message:'Invalid source'});await assert.rejects(pipelines.publish(project.id,{...input,runnerId:'mac'}),{code:'INSPECTION_FAILED'});project.findings.pop();
 const result=await pipelines.publish(project.id,{...input,runnerId:'mac'});assert.equal(result.buildRunId,'build');assert.equal(builds,1);
});
