import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentSettings, agentChoice } from "../packages/agent/settings.js";
import { command } from "../packages/development/process.js";
import {
  git,
  gitState,
  fingerprint,
  githubRepository,
} from "../packages/development/git.js";
import { StudioTerminals } from "../packages/development/terminal.js";
import {
  sandboxLaunch,
  cleanEnvironment,
} from "../packages/development/sandbox.js";

test("CLI settings validate choices and preserve purpose overrides when old clients save provider", () => {
  const before = {
    provider: "codex" as const,
    model: "model-a",
    purposes: {
      coding: { provider: "opencode" as const, model: "openai/model-b" },
    },
  };
  const after = agentSettings({ provider: "opencode" }, before);
  assert.equal(agentChoice(after, "coding").model, "openai/model-b");
  assert.equal(agentChoice(after, "analysis").provider, "opencode");
  assert.throws(() => agentSettings({ provider: "api" }, before));
  assert.throws(() =>
    agentSettings(
      { provider: "codex", model: "model; touch /tmp/attack" },
      before,
    ),
  );
});
test("Git status and fingerprints track staged, unstaged and untracked changes with unusual paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "studio-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.name", "Fixture"]);
  await git(dir, ["config", "user.email", "fixture@example.test"]);
  await writeFile(join(dir, "a.txt"), "one");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial"]);
  const before = await fingerprint(dir);
  await writeFile(join(dir, "a.txt"), "two");
  await writeFile(join(dir, "공백 파일.txt"), "new");
  const state = await gitState(dir);
  assert.equal(state.files.length, 2);
  assert.notEqual(await fingerprint(dir), before);
  assert.equal(githubRepository("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(
    githubRepository("https://token@github.com/owner/repo.git"),
    null,
  );
});
test("real tmux terminal input, output, exit and service cleanup", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "studio-pty-"));
  const terminals = new StudioTerminals(dir, false);
  t.after(async () => {
    await terminals.close();
    await rm(dir, { recursive: true, force: true });
  });
  const session = await terminals.open("fixture", dir, "/bin/sh", [
    "-c",
    'read value; printf "받음:%s\\n" "$value"',
  ]);
  terminals.resize(session.id, 90, 25);
  terminals.input(session.id, "hello\r");
  assert.equal(await terminals.wait(session.id), 0);
  const output = terminals.read(session.id);
  assert.match(output.data, /받음:hello/);
  assert.equal(terminals.read(session.id, output.cursor).data, "");
});
test("sandbox blocks sibling secret reads, writes and network while permitting the worktree", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "studio-sandbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktree = join(dir, "worktree");
  await mkdir(worktree);
  const secret = join(dir, "secret");
  await writeFile(secret, "sensitive-fixture");
  const marker = join(dir, "outside");
  const launch = await sandboxLaunch({
    directory: join(dir, "control"),
    worktree,
    executable: "/bin/sh",
    args: [
      "-c",
      `test ! -r '${secret}' && ! touch '${marker}' 2>/dev/null && printf safe > ok.txt`,
    ],
  });
  await command(launch.file, launch.args, { cwd: worktree, env: launch.env });
  assert.equal(await readFile(join(worktree, "ok.txt"), "utf8"), "safe");
  const old = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "fixture";
  assert.equal(cleanEnvironment().GH_TOKEN, undefined);
  if (old === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = old;
});

test('sandbox blocks direct TCP, provider-disallowed HTTPS, Unix sockets and Git metadata writes', async t => {
  const { createServer } = await import('node:http');
  const dir = await mkdtemp(join(tmpdir(), 'studio-network-')); const worktree=join(dir,'worktree'); await mkdir(worktree);
  const server=createServer((_req,res)=>res.end('host-secret'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const unix=createServer((_req,res)=>res.end('socket-secret')); const socket=join(dir,'service.sock');
  await new Promise<void>(resolve=>unix.listen(socket,resolve));
  t.after(async()=>{await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>unix.close(()=>resolve()))]);await rm(dir,{recursive:true,force:true});});
  await writeFile(join(worktree,'.git'),'gitdir: /fixture');
  const launch=await sandboxLaunch({directory:join(dir,'control'),worktree,executable:'/bin/sh',args:['-c',`! /usr/bin/curl -sS --max-time 3 --noproxy '*' http://127.0.0.1:${port}/ && ! /usr/bin/curl -sS --max-time 3 --unix-socket '${socket}' http://localhost/ && ! /usr/bin/curl -fsS --max-time 3 https://github.com && ! (printf corrupt > .git) && printf ISOLATED` ]});
  try { assert.match(await command(launch.file,launch.args,{cwd:worktree,env:launch.env}),/ISOLATED/); assert.equal(await readFile(join(worktree,'.git'),'utf8'),'gitdir: /fixture'); }
  finally { await launch.cleanup(); }
});

test('macOS sandbox denies Keychain IPC even when the host can read a fixture item', {skip: process.platform !== 'darwin'}, async t => {
  const dir=await mkdtemp(join(tmpdir(),'studio-keychain-'));const worktree=join(dir,'worktree');await mkdir(worktree);const path=join(dir,'fixture.keychain-db');
  t.after(async()=>{await command('/usr/bin/security',['delete-keychain',path]).catch(()=>{});await rm(dir,{recursive:true,force:true});});
  await command('/usr/bin/security',['create-keychain','-p','fixture-only',path]);
  await command('/usr/bin/security',['unlock-keychain','-p','fixture-only',path]);
  await command('/usr/bin/security',['add-generic-password','-a','fixture','-s','appops-fixture','-w','fixture-only',path]);
  assert.equal((await command('/usr/bin/security',['find-generic-password','-a','fixture','-s','appops-fixture','-w',path])).trim(),'fixture-only');
  const launch=await sandboxLaunch({directory:join(dir,'control'),worktree,executable:'/usr/bin/security',args:['find-generic-password','-a','fixture','-s','appops-fixture','-w',path],extraRead:[path]});
  try{await assert.rejects(command(launch.file,launch.args,{cwd:worktree,env:launch.env}),/CLI_FAILED|interaction|parameter|keychain|Keychain|권한|허용|specified|available|AppError/i);}finally{await launch.cleanup();}
});

test('sandboxed STDIO MCP reaches only its scoped HTTP bridge through the proxy',async t=>{
  const {createServer}=await import('node:http');const {createRequire}=await import('node:module');const {fileURLToPath}=await import('node:url');const require=createRequire(import.meta.url);
  const root=fileURLToPath(new URL('../',import.meta.url));const dir=await mkdtemp(join(tmpdir(),'studio-mcp-'));const worktree=join(dir,'work');await mkdir(worktree);
  let calls=0;const server=createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-token');calls++;for await(const _ of req){}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,scoped:true}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});});
  const launch=await sandboxLaunch({directory:join(dir,'control'),worktree,executable:process.execPath,args:['--import',require.resolve('tsx'),join(root,'packages/agent/mcp.ts')],provider:'codex',extraRead:[join(root,'packages'),join(root,'node_modules'),join(root,'package.json'),join(root,'tsconfig.json')],extraDomains:[new URL(endpoint).host]});Object.assign(launch.env,{APPOPS_AGENT_ENDPOINT:endpoint,APPOPS_AGENT_TOKEN:'fixture-token',APPOPS_AGENT_SANDBOXED:'1'});
  try{const output=await command(launch.file,launch.args,{cwd:worktree,env:launch.env,input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'context'}})+'\n'});assert.equal(calls,1);assert.match(output,/scoped/);assert.doesNotMatch(output,/fixture-token/);}finally{await launch.cleanup();}
});

test('live terminal and persisted logs redact split credentials before renderer reads',async t=>{
  const {setTimeout:delay}=await import('node:timers/promises');
  const dir=await mkdtemp(join(tmpdir(),'studio-redact-'));const terminals=new StudioTerminals(dir,false);
  t.after(async()=>{await terminals.close();await rm(dir,{recursive:true,force:true});});
  const session=await terminals.open('redaction',dir,'/bin/sh',['-c','printf fixture-; sleep 1; printf "token\\n"; printf "access_token=secret-unlisted\\n"'],{...cleanEnvironment(),APPOPS_AGENT_TOKEN:'fixture-token'});
  await delay(150);assert.doesNotMatch(terminals.read(session.id).data,/fixture-/);
  await terminals.wait(session.id);const output=terminals.read(session.id);assert.doesNotMatch(output.data,/fixture-token|secret-unlisted/);assert.match(output.data,/REDACTED/);
  await terminals.close();const saved=await readFile(join(dir,'logs',session.id+'.json'),'utf8');assert.doesNotMatch(saved,/fixture-token|secret-unlisted/);
});

test('OpenCode task home excludes global data and unrelated provider credentials',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-opencode-'));const work=join(dir,'work');await mkdir(work);
  const originalData=process.env.XDG_DATA_HOME;const originalConfig=process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME=join(dir,'global-data');process.env.XDG_CONFIG_HOME=join(dir,'global-config');
  await mkdir(join(process.env.XDG_DATA_HOME,'opencode'),{recursive:true});await mkdir(join(process.env.XDG_CONFIG_HOME,'opencode'),{recursive:true});
  await writeFile(join(process.env.XDG_DATA_HOME,'opencode/auth.json'),JSON.stringify({openai:{key:'fixture-openai-key'},other:{key:'fixture-unrelated-key'}}));
  await writeFile(join(process.env.XDG_CONFIG_HOME,'opencode/opencode.json'),JSON.stringify({model:'openai/fixture'}));
  t.after(async()=>{if(originalData===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=originalData;if(originalConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=originalConfig;await rm(dir,{recursive:true,force:true});});
  const globalAuth=join(process.env.XDG_DATA_HOME,'opencode/auth.json');
  const launch=await sandboxLaunch({directory:join(dir,'control'),worktree:work,executable:'/bin/sh',provider:'opencode',args:['-c',`test ! -r '${globalAuth}' && test -r "$XDG_DATA_HOME/opencode/auth.json" && printf ISOLATED`]});
  try{assert.match(await command(launch.file,launch.args,{cwd:work,env:launch.env}),/ISOLATED/);const auth=await readFile(join(launch.env.XDG_DATA_HOME!,'opencode/auth.json'),'utf8');assert.match(auth,/fixture-openai-key/);assert.doesNotMatch(auth,/unrelated/);}
  finally{await launch.cleanup();}
});
