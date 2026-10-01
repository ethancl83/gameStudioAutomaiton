import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeBuild, probeIsolation } from '../apps/runner/index.js';
import type { BuildOutput, BuildPlan, CommandSpec } from '../packages/domain/index.js';

const skip = process.platform === 'darwin' ? false : 'macOS Seatbelt 격리 검사는 darwin에서만 실행합니다.';

type Cleanup = { after: (fn: () => void | Promise<void>) => void };

async function tempDir(t: Cleanup, parent: string, prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(parent, prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A snapshot dir, an output dir and a sibling host area the build must not touch. */
async function workspace(t: Cleanup) {
  const root = await tempDir(t, tmpdir(), 'appops-mac-iso-');
  const source = join(root, 'snapshot');
  const output = join(root, 'output');
  await mkdir(source);
  await mkdir(output);
  return { root, source, output };
}

async function nodeTool(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

function plan(command: Omit<CommandSpec, 'label'>, source: string, output: string, expectedArtifacts: string[] = []): BuildPlan {
  return {
    engine: 'godot',
    target: 'linux',
    sourcePath: source,
    outputPath: output,
    commands: [{ ...command, label: 'mac-isolation' }],
    expectedArtifacts,
    findings: [],
  };
}

async function run(buildPlan: BuildPlan, signal?: AbortSignal) {
  const logs: BuildOutput[] = [];
  const result = await executeBuild(buildPlan, { signal, onOutput: (o) => logs.push(o) });
  const stdout = logs.filter((o) => o.stream === 'stdout').map((o) => o.text).join('');
  const all = logs.map((o) => o.text).join('');
  return { result, stdout, all };
}

function lastJson(stdout: string): Record<string, string> {
  const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(line, `JSON 출력이 없습니다: ${stdout}`);
  return JSON.parse(line) as Record<string, string>;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('probeIsolation verifies and reports the seatbelt backend', { skip }, async () => {
  const probe = await probeIsolation();
  assert.equal(probe.available, true, probe.reason);
  assert.equal(probe.backend, 'seatbelt');
  assert.equal(probe.executable, '/usr/bin/sandbox-exec');
  assert.match(probe.version ?? '', /Seatbelt.*macOS \d+/);
});

test('seatbelt denies home, app data, ssh and sibling host files but reads the snapshot', { skip }, async (t) => {
  const { root, source, output } = await workspace(t);
  const homeDir = await tempDir(t, homedir(), 'appops-mac-iso-home-');
  const homeSecret = join(homeDir, 'secret.txt');
  await writeFile(homeSecret, 'HOME_SECRET');
  const dataDir = await tempDir(t, tmpdir(), 'appops-mac-iso-data-');
  await writeFile(join(dataDir, 'controller.json'), 'DATA_SECRET');
  const sibling = join(root, 'host-secret.txt');
  await writeFile(sibling, 'SIBLING_SECRET');
  await writeFile(join(source, 'input.txt'), 'SNAPSHOT_INPUT');
  const previousData = process.env.APPOPS_DATA_DIR;
  process.env.APPOPS_DATA_DIR = dataDir;
  t.after(() => { if (previousData === undefined) delete process.env.APPOPS_DATA_DIR; else process.env.APPOPS_DATA_DIR = previousData; });

  const targets = {
    home: homeSecret,
    homeListing: homedir(),
    ssh: join(homedir(), '.ssh'),
    keychains: join(homedir(), 'Library/Keychains'),
    data: join(dataDir, 'controller.json'),
    sibling,
    snapshot: join(source, 'input.txt'),
  };
  const tool = await nodeTool(source, 'peek', `
const fs = require('node:fs');
const targets = ${JSON.stringify(targets)};
const out = {};
for (const [name, target] of Object.entries(targets)) {
  try {
    const st = fs.statSync(target);
    const value = st.isDirectory() ? fs.readdirSync(target).join(',') : fs.readFileSync(target, 'utf8');
    out[name] = 'READ:' + value.length;
  } catch (error) { out[name] = 'DENIED:' + error.code; }
}
console.log(JSON.stringify(out));
`);
  const { result, stdout, all } = await run(plan({ executable: tool, args: [], cwd: source }, source, output));
  assert.equal(result.exitCode, 0, all);
  const seen = lastJson(stdout);
  t.diagnostic(JSON.stringify(seen));
  for (const name of ['home', 'homeListing', 'data', 'sibling']) assert.match(seen[name], /^DENIED:EPERM$/, `${name}: ${seen[name]}`);
  // ~/.ssh or the keychain directory may not exist on a host; either way nothing is read.
  for (const name of ['ssh', 'keychains']) assert.match(seen[name], /^DENIED:(EPERM|ENOENT)$/, `${name}: ${seen[name]}`);
  assert.equal(seen.snapshot, 'READ:14');
  assert.equal(all.includes('HOME_SECRET') || all.includes('DATA_SECRET') || all.includes('SIBLING_SECRET'), false);
});

test('a snapshot inside an app data dir under home is usable while the rest of it stays denied', { skip }, async (t) => {
  const dataDir = await tempDir(t, homedir(), 'appops-mac-iso-appdata-');
  await writeFile(join(dataDir, 'controller.json'), 'DATA_SECRET');
  const source = join(dataDir, 'snapshots', 'run-1');
  const output = join(dataDir, 'outputs', 'run-1');
  await mkdir(source, { recursive: true });
  await mkdir(output, { recursive: true });
  const previousData = process.env.APPOPS_DATA_DIR;
  process.env.APPOPS_DATA_DIR = dataDir;
  t.after(() => { if (previousData === undefined) delete process.env.APPOPS_DATA_DIR; else process.env.APPOPS_DATA_DIR = previousData; });
  const artifact = join(output, 'game.bin');
  const tool = await nodeTool(source, 'build', `
const fs = require('node:fs');
const out = { cwd: process.cwd() };
try { fs.readFileSync(${JSON.stringify(join(dataDir, 'controller.json'))}, 'utf8'); out.data = 'READ'; } catch (error) { out.data = 'DENIED:' + error.code; }
try { fs.readdirSync(${JSON.stringify(join(dataDir, 'snapshots'))}); out.siblings = 'LISTED'; } catch (error) { out.siblings = 'DENIED:' + error.code; }
fs.writeFileSync(${JSON.stringify(artifact)}, 'built');
console.log(JSON.stringify(out));
`);
  const { result, stdout, all } = await run(plan({ executable: tool, args: [], cwd: source }, source, output, [artifact]));
  assert.equal(result.exitCode, 0, all);
  const seen = lastJson(stdout);
  t.diagnostic(JSON.stringify(seen));
  assert.equal(seen.cwd, source);
  assert.equal(seen.data, 'DENIED:EPERM');
  assert.equal(seen.siblings, 'DENIED:EPERM');
  assert.deepEqual(result.artifacts, [artifact]);
});

test('seatbelt denies network: remote TCP, a host loopback listener and binding', { skip }, async (t) => {
  const { source, output } = await workspace(t);
  let accepted = 0;
  const server = createServer((socket) => { accepted++; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const tool = await nodeTool(source, 'net', `
const net = require('node:net');
function attempt(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3000 });
    socket.once('connect', () => { socket.destroy(); resolve('CONNECTED'); });
    socket.once('timeout', () => { socket.destroy(); resolve('TIMEOUT'); });
    socket.once('error', (error) => resolve('DENIED:' + error.code));
  });
}
function bind() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => resolve('DENIED:' + error.code));
    server.listen(0, '127.0.0.1', () => { server.close(); resolve('LISTENING'); });
  });
}
(async () => {
  console.log(JSON.stringify({ remote: await attempt('1.1.1.1', 443), loopback: await attempt('127.0.0.1', ${port}), bind: await bind() }));
})();
`);
  const { result, stdout, all } = await run(plan({ executable: tool, args: [], cwd: source }, source, output));
  assert.equal(result.exitCode, 0, all);
  const seen = lastJson(stdout);
  t.diagnostic(JSON.stringify(seen));
  assert.match(seen.remote, /^DENIED:/, seen.remote);
  assert.match(seen.loopback, /^DENIED:/, seen.loopback);
  assert.match(seen.bind, /^DENIED:/, seen.bind);
  assert.equal(accepted, 0);
});

test('seatbelt allows writes only to snapshot, output and per-run HOME/TMPDIR', { skip }, async (t) => {
  const { root, source, output } = await workspace(t);
  const homeDir = await tempDir(t, homedir(), 'appops-mac-iso-write-');
  const targets = {
    output: join(output, 'artifact.bin'),
    snapshot: join(source, 'generated.txt'),
    sibling: join(root, 'escaped.txt'),
    home: join(homeDir, 'escaped.txt'),
    privateTmp: `/private/tmp/appops-mac-iso-${process.pid}.txt`,
  };
  const tool = await nodeTool(source, 'writer', `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const targets = ${JSON.stringify(targets)};
targets.runHome = path.join(os.homedir(), 'state.txt');
targets.runTmp = path.join(os.tmpdir(), 'scratch.txt');
const out = {};
for (const [name, target] of Object.entries(targets)) {
  try { fs.writeFileSync(target, 'payload'); out[name] = 'WROTE'; }
  catch (error) { out[name] = 'DENIED:' + error.code; }
}
console.log(JSON.stringify(out));
`);
  const { result, stdout, all } = await run(plan({ executable: tool, args: [], cwd: source }, source, output, [targets.output]));
  assert.equal(result.exitCode, 0, all);
  const seen = lastJson(stdout);
  t.diagnostic(JSON.stringify(seen));
  for (const name of ['output', 'snapshot', 'runHome', 'runTmp']) assert.equal(seen[name], 'WROTE', `${name}: ${seen[name]}`);
  for (const name of ['sibling', 'home', 'privateTmp']) assert.match(seen[name], /^DENIED:EPERM$/, `${name}: ${seen[name]}`);
  assert.deepEqual(result.artifacts, [targets.output]);
  for (const name of ['sibling', 'home', 'privateTmp'] as const) {
    await assert.rejects(access(targets[name]), `${name} must not exist on the host`);
  }
});

test('seatbelt clears host credentials from the environment and points HOME/TMPDIR per run', { skip }, async (t) => {
  const { source, output } = await workspace(t);
  const injected = {
    GITHUB_TOKEN: 'ghp_leak', AWS_ACCESS_KEY_ID: 'AKIA_LEAK', APPOPS_BEARER: 'bearer_leak',
    SSH_AUTH_SOCK: '/private/tmp/agent.sock', NPM_PASSWORD: 'pw_leak', GOOGLE_APPLICATION_CREDENTIALS: '/x.json',
  };
  const previous = Object.fromEntries(Object.keys(injected).map((k) => [k, process.env[k]]));
  Object.assign(process.env, injected);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const tool = await nodeTool(source, 'env', `
const os = require('node:os');
console.log(JSON.stringify({ ...process.env, NODE_HOMEDIR: os.homedir(), NODE_TMPDIR: os.tmpdir() }));
`);
  const { result, stdout, all } = await run(plan({ executable: tool, args: [], cwd: source, env: { PLAIN_FLAG: 'kept' } }, source, output));
  assert.equal(result.exitCode, 0, all);
  const env = lastJson(stdout);
  for (const key of Object.keys(injected)) assert.equal(key in env, false, `${key} leaked`);
  assert.equal(Object.values(env).some((v) => v.includes('_leak')), false);
  assert.equal(env.PLAIN_FLAG, 'kept');
  const runRoot = join(output, '.appops-task-cache', 'sandbox');
  assert.equal(env.HOME, join(runRoot, 'home'));
  assert.equal(env.NODE_HOMEDIR, join(runRoot, 'home'));
  assert.equal(env.NODE_TMPDIR, join(runRoot, 'tmp'));
  assert.equal(env.USER, undefined);
  assert.ok((await stat(join(runRoot, 'home'))).isDirectory());
});

test('cancelling a seatbelt build kills the whole process tree, including a setsid child', { skip }, async (t) => {
  const { source, output } = await workspace(t);
  const pidsFile = join(output, 'pids.json');
  const tool = await nodeTool(source, 'tree', `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const sleeper = spawn('/bin/sleep', ['300'], { stdio: 'ignore' });
const shell = spawn('/bin/sh', ['-c', '/bin/sleep 301 & wait'], { stdio: 'ignore' });
const escaped = spawn('/bin/sleep', ['302'], { stdio: 'ignore', detached: true });
fs.writeFileSync(process.env.PIDS_FILE, JSON.stringify([process.pid, sleeper.pid, shell.pid, escaped.pid]));
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const running = run(plan({ executable: tool, args: [], cwd: source, env: { PIDS_FILE: pidsFile } }, source, output), controller.signal);
  let pids: number[] = [];
  for (let i = 0; i < 100 && pids.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
    pids = await readFile(pidsFile, 'utf8').then((text) => JSON.parse(text) as number[]).catch(() => []);
  }
  assert.equal(pids.length, 4, 'process tree did not start');
  // The sandbox cannot inspect processes outside itself, so the host finds the shell's grandchild.
  for (let i = 0; i < 40 && pids.length === 4; i++) {
    const grandchild = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim().split(/\s+/).map(Number)).find(([, ppid]) => ppid === pids[2]);
    if (grandchild) pids.push(grandchild[0]);
    else await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pids.length, 5, 'shell grandchild did not start');
  assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 0 && alive(pid)), `not all alive: ${pids}`);
  controller.abort();
  const { result } = await running;
  assert.equal(result.cancelled, true);
  const deadline = Date.now() + 4000;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(pids.filter(alive), [], 'processes survived cancellation');
});

function findGodot(): string | null {
  const candidates = [
    process.env.APPOPS_GODOT_PATH,
    '/Applications/Godot.app/Contents/MacOS/Godot',
    '/Applications/Godot_mono.app/Contents/MacOS/Godot',
  ];
  try { candidates.push(execFileSync('/usr/bin/which', ['godot'], { encoding: 'utf8' }).trim()); } catch { /* not on PATH */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      execFileSync('/bin/test', ['-x', candidate]);
      return candidate;
    } catch { /* next */ }
  }
  return null;
}

const godot = process.platform === 'darwin' ? findGodot() : null;
const godotSkip = skip || (godot ? false : 'Godot 실행 파일이 없어 실제 Godot 샌드박스 검사를 건너뜁니다.');

test('real Godot runs headless inside seatbelt', { skip: godotSkip, timeout: 240_000 }, async (t) => {
  const executable = godot!;
  const { source, output } = await workspace(t);
  await writeFile(join(source, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Seatbelt Verify"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  await writeFile(join(source, 'main.tscn'), '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n');
  await writeFile(join(source, 'main.gd'), 'extends Node\nfunc _ready():\n\tprint("AppOps seatbelt Godot OK ", OS.get_environment("HOME"))\n\tget_tree().quit()\n');

  const version = await run(plan({ executable, args: ['--headless', '--version'], cwd: source }, source, output));
  assert.equal(version.result.exitCode, 0, version.all);
  const versionText = version.stdout.trim().split('\n').pop() ?? '';
  assert.match(versionText, /^\d+\.\d+(\.\d+)?\.\w+/);
  t.diagnostic(`godot --version: ${versionText}`);

  const imported = await run(plan({ executable, args: ['--headless', '--path', source, '--import'], cwd: source }, source, output));
  assert.equal(imported.result.exitCode, 0, imported.all);
  assert.ok((await stat(join(source, '.godot'))).isDirectory(), 'import cache is written inside the snapshot');

  const played = await run(plan({ executable, args: ['--headless', '--path', source], cwd: source }, source, output));
  assert.equal(played.result.exitCode, 0, played.all);
  assert.match(played.stdout, new RegExp(`AppOps seatbelt Godot OK ${join(output, '.appops-task-cache', 'sandbox', 'home')}`));

  await t.test('export-pack with export templates', async (sub) => {
    const templateVersion = versionText.replace(/\.official\..*$|\.custom_build\..*$/, '');
    const dataDirs = [process.env.APPOPS_GODOT_DATA_DIR, join(homedir(), 'Library/Application Support/Godot')];
    let templates: string | null = null;
    for (const dir of dataDirs) {
      if (!dir) continue;
      try {
        await access(join(dir, 'export_templates', templateVersion, 'macos.zip'));
        templates = dir;
        break;
      } catch { /* next */ }
    }
    if (!templates) {
      sub.skip(`export_templates/${templateVersion}/macos.zip 템플릿이 없어 --export-pack 단계를 건너뜁니다.`);
      return;
    }
    await writeFile(join(source, 'export_presets.cfg'), '[preset.0]\nname="macOS"\nplatform="macOS"\nrunnable=true\nexport_filter="all_resources"\nexport_path="game.zip"\n[preset.0.options]\napplication/bundle_identifier="com.appops.seatbelt"\n');
    const pck = join(output, 'game.pck');
    const exported = await run(plan({
      executable,
      args: ['--headless', '--path', source, '--export-pack', 'macOS', pck],
      cwd: source,
      env: { XDG_DATA_HOME: join(output, '.appops-task-cache', 'xdg-data'), GODOT_TEMPLATES_SOURCE: templates },
    }, source, output, [pck]));
    assert.equal(exported.result.exitCode, 0, exported.all);
    assert.deepEqual(exported.result.artifacts, [pck]);
    sub.diagnostic(`export-pack ${pck}: ${(await stat(pck)).size} bytes (templates ${templates})`);
  });
});
