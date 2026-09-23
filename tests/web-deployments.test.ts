import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {WebDeployments} from '../apps/controller/web-deployments.js';
import {StudioTerminals} from '../packages/development/terminal.js';
import {git} from '../packages/development/git.js';
import type {AppService} from '../apps/controller/service.js';
import type {WebDeployment} from '../packages/development/types.js';

for(const provider of ['netlify','vercel'] as const) test(`${provider}: snapshot upload, provider verification and HTTP response are distinct evidence`,async t=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'web-fixture-')));const source=join(dir,'project');await mkdir(source);await mkdir(join(dir,'data'));
  await writeFile(join(source,'index.html'),'<h1>fixture</h1>');await writeFile(join(source,'.gitignore'),'.netlify\n.vercel\n');
  await git(source,['init']);await git(source,['config','user.name','Fixture']);await git(source,['config','user.email','fixture@example.test']);await git(source,['add','.']);await git(source,['commit','-m','initial']);
  await mkdir(join(source,'.netlify'));await mkdir(join(source,'.vercel'));await writeFile(join(source,'.netlify/state.json'),JSON.stringify({siteId:'fixture-site'}));await writeFile(join(source,'.vercel/project.json'),JSON.stringify({projectId:'fixture-project',orgId:'fixture-team'}));
  const cli=join(dir,'provider-cli');const url=`https://fixture.${provider==='netlify'?'netlify':'vercel'}.app`;
  const output=provider==='netlify'?JSON.stringify({deploy_url:url,deploy_id:'fixture-deploy'}):url;
  await writeFile(cli,`#!/bin/sh\nprintf '%s\\n' '${output}'\n`,{mode:0o700});
  const records=new Map<string,unknown>();const service={store:{directory:join(dir,'data'),list:()=>[...records.values()],put:(_kind:string,id:string,value:unknown)=>records.set(id,value)},project:()=>({id:'project',rootPath:source})} as unknown as AppService;
  const terminals=new StudioTerminals(join(dir,'terminal'),false);let queried=false;let status=200;
  const deployments=new WebDeployments(service,terminals,{requireTool:async()=>cli,command:async(_file,args)=>{queried=true;assert.equal(args[0],'api');return JSON.stringify(provider==='netlify'?{state:'ready'}:{readyState:'READY',id:'fixture-deploy'});},fetch:async(input,options)=>{assert.equal(String(input),url);assert.equal(options?.redirect,'manual');return new Response('fixture',{status});}});
  t.after(async()=>{await terminals.close();await deployments.close();await rm(dir,{recursive:true,force:true});});
  const head=(await git(source,['rev-parse','HEAD'])).trim();
  await assert.rejects(deployments.deploy('project',provider,false,'0'.repeat(40)),/커밋이 변경/);
  const started=await deployments.deploy('project',provider,false,head);
  for(let i=0;i<100&&deployments.list()[0]?.status==='running';i++)await delay(30);
  let saved=deployments.list()[0]!;assert.equal(saved.status,'succeeded',saved.message);assert.equal(saved.url,url);assert.ok(saved.sourceSha);assert.equal(queried,true);
  assert.equal(await readFile(join(dir,'data','web-deployments',started.id,'source','index.html'),'utf8'),'<h1>fixture</h1>');
  status=401;saved=await deployments.check(started.id);assert.equal(saved.status,'action_required','protected URL must not be reported as publicly verified');
  await assert.rejects(deployments.deploy('project',provider,false,head),/이전 배포 결과/);
  deployments.resolve(started.id);assert.equal(deployments.list()[0]?.resolved,true);
  if(provider==='netlify'){
    await writeFile(join(source,'server.js'),'private-server-source');await git(source,['add','.']);await git(source,['commit','-m','server']);
    const next=(await git(source,['rev-parse','HEAD'])).trim();await assert.rejects(deployments.deploy('project',provider,false,next),/public 폴더/);
    assert.match((await deployments.inspect('project')).publicationError,/public/);
  }
  await writeFile(join(source,'index.html'),'changed');await assert.rejects(deployments.deploy('project',provider,true,head),/먼저 커밋/);
});
