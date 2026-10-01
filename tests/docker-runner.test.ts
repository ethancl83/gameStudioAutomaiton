import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { prepareRunnerContext, RUNNER_CONTEXT_FILES, RUNNER_SOURCE_DIRECTORIES } from '../scripts/prepare-runner-context.js';
import { packageFor } from '../packages/setup/catalog.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path: string) => readFile(join(root, path), 'utf8');

test('Electron packages the shared seccomp asset at the helper resources path and preserves application files', async () => {
  const config = createRequire(import.meta.url)('../electron-builder.config.cjs');
  assert.deepEqual(config.files, ['dist/**/*', 'package.json', '!dist/**/*.map']);
  const asset = 'docker/runner/seccomp-bwrap.json';
  assert.deepEqual(config.extraResources, [{from: asset, to: asset}]);
  const profile = JSON.parse(await source(config.extraResources[0].from));
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  const helper = await source('packages/build-credentials/docker-runtime.ts');
  assert.match(helper, /join\(resourcesPath, 'docker\/runner\/seccomp-bwrap\.json'\)/);
});

test('Docker A keeps host ingress local and grants only the reviewed bwrap configuration', async () => {
  const compose = await source('docker/runner/compose.yaml');
  assert.match(compose, /image: appops-linux-runner:local/);
  assert.match(compose, /context: ..\/..\/tmp\/docker-runner-context/);
  assert.match(compose, /init: true/);
  assert.match(compose, /user: "0:0"/);
  assert.match(compose, /ports:\n\s+- "127\.0\.0\.1:4320:4320"/);
  assert.match(compose, /APPOPS_RUNNER_HOST: "0\.0\.0\.0"/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /cap_add: \[SYS_ADMIN, SETUID, SETGID, SETFCAP\]/);
  assert.match(compose, /seccomp=\.\/seccomp-bwrap.json/);
  assert.match(compose, /systempaths=unconfined/);
  assert.match(compose, /volumes:\n\s+- runner-data:\/data/);
  assert.doesNotMatch(compose, /privileged|seccomp[=:]unconfined|network_mode|docker\.sock|\/home|\/Users|vault|env_file|TOKEN|PASSWORD/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /driver: "none"/);
  const profileText = await source('docker/runner/seccomp-bwrap.json');
  // Pin the reviewed Moby profile plus pivot_root, not just the presence of that syscall.
  assert.equal(createHash('sha256').update(profileText).digest('hex'), '364196d48927f3fd1640b338eb33810271d3703486638946b6cfeb647fa7cfd6');
  const profile = JSON.parse(profileText);
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  assert.ok(profile.syscalls.some((rule: {names: string[]; action: string}) => rule.names.includes('pivot_root') && rule.action === 'SCMP_ACT_ALLOW'));
});

test('image pins Node and official Godot archives, includes helper tools and avoids host dependencies', async () => {
  const dockerfile = await source('docker/runner/Dockerfile');
  assert.match(dockerfile, /^FROM node:22@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d\n/);
  for (const tool of ['bubblewrap', 'openjdk-17-jdk-headless', 'git', 'openssh-client']) assert.ok(dockerfile.includes(tool));
  assert.match(dockerfile, /npm ci --ignore-scripts/);
  assert.doesNotMatch(dockerfile, /openssh-server|COPY.*node_modules|APPOPS_RUNNER_HOST|TOKEN|PASSWORD/);
  const install = await source('docker/runner/install-godot.sh');
  for (const arch of ['x64', 'arm64']) assert.ok(install.includes(packageFor('godot', 'linux', arch).sha512!));
  assert.ok(install.includes(packageFor('godot-templates', 'linux', 'x64').sha512!));
  assert.match(install, /sha512sum --check --status/);
  assert.match(install, /templates\/linux_release\.\$arch/);
  const start = await source('docker/runner/start.sh');
  assert.match(start, /umask 077/);
  assert.match(start, /exec node --import tsx \/app\/apps\/runner\/remote-main.ts/);
  assert.match(await source('apps/runner/remote-main.ts'), /host:process\.env\.APPOPS_RUNNER_HOST/);
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'appops-context-'));
  for (const path of RUNNER_SOURCE_DIRECTORIES) await mkdir(join(directory, path), {recursive: true});
  for (const path of RUNNER_CONTEXT_FILES) {
    await mkdir(dirname(join(directory, path)), {recursive: true});
    await writeFile(join(directory, path), 'fixture');
  }
  return directory;
}

test('context copies only permitted source, excludes secrets and data, and refuses to merge an existing context', async t => {
  const directory = await fixture();t.after(() => rm(directory, {recursive:true,force:true}));
  const files = ['apps/runner/remote-main.ts', 'apps/runner/.env', 'apps/runner/.env.local',
    'apps/runner/node_modules/rogue.ts', 'apps/runner/tmp/secret.ts', 'apps/runner/.git/config',
    'apps/runner/vault/key.ts', 'packages/domain/index.ts', 'packages/runner/execute.ts', 'packages/runner/secrets.ts', 'packages/runner/.env', 'packages/runner/data/key.ts', 'packages/credentials/key.pem',
    'apps/controller/service.ts', 'tmp/secret.ts', '.env', 'private.key'];
  for (const path of files) {
    await mkdir(dirname(join(directory, path)), {recursive:true});
    await writeFile(join(directory, path), path);
  }
  const destination=join(directory,'out');
  const copied=await prepareRunnerContext(directory,destination);
  assert.ok(copied.includes('apps/runner/remote-main.ts'));
  assert.ok(copied.includes('packages/domain/index.ts'));
  assert.ok(copied.includes('packages/runner/execute.ts'));
  assert.ok(copied.includes('packages/runner/secrets.ts'));
  const ignore = await source('.dockerignore');
  assert.ok(ignore.split('\n').includes('!packages/runner/'));
  assert.ok(ignore.split('\n').includes('!packages/runner/**/*.ts'));
  assert.ok(!ignore.includes('!apps/controller/'));
  for (const path of files.filter(path=>!['apps/runner/remote-main.ts','packages/domain/index.ts','packages/runner/execute.ts','packages/runner/secrets.ts'].includes(path))) assert.ok(!copied.includes(path), path);
  assert.equal(await readFile(join(destination,'apps/runner/remote-main.ts'),'utf8'),'apps/runner/remote-main.ts');
  await assert.rejects(prepareRunnerContext(directory,destination),{code:'EEXIST'});
  assert.deepEqual((await readdir(join(destination,'apps/runner'))).sort(),['remote-main.ts']);
});

test('context refuses source symlinks instead of following them into a home or vault', async t => {
  const directory=await fixture();t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'outside.ts'),'secret');
  await symlink(join(directory,'outside.ts'),join(directory,'apps/runner/linked.ts'));
  await assert.rejects(prepareRunnerContext(directory,join(directory,'out')),/symbolic links/);
});

test('healthcheck succeeds only for authenticated ready health and never logs credentials or response bodies', async t => {
  const directory=await mkdtemp(join(tmpdir(),'appops-health-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const token='healthcheck-test-secret-123456789';await writeFile(join(directory,'pairing-code'),token,{mode:0o600});
  let ready=true;let status=200;let received=0;
  const server=createServer((req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${token}`);received++;
    res.writeHead(status,{'content-type':'application/json'});
    res.end(JSON.stringify({protocol:'appops-runner-v1',ready,privateKey:'must-not-be-logged'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const port=address.port;
  async function check() {
    return new Promise<number|null>((resolve,reject)=>{
      const child=spawn(process.execPath,[join(root,'docker/runner/healthcheck.mjs')],{env:{...process.env,APPOPS_RUNNER_DATA_DIR:directory,APPOPS_RUNNER_PORT:String(port)},stdio:['ignore','pipe','pipe']});
      let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});child.on('error',reject);
      child.on('close',code=>{try{assert.equal(output,'');resolve(code);}catch(error){reject(error);}});
    });
  }
  assert.equal(await check(),0);ready=false;assert.equal(await check(),1);
  ready=true;status=401;assert.equal(await check(),1);assert.equal(received,3);
});
