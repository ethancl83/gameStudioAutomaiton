import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signDockerAndroidArtifact } from '../packages/build-credentials/docker.js';
import { runDockerKeyHelper } from '../packages/build-credentials/docker-runtime.js';

// A transport fault model, not a replacement for the opt-in actual-image positive tests.
async function fixture(mode: 'daemon-switch' | 'environment-switch', callback: (root: string, statePath: string, endpoint: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'appops-key-daemon-fault-')); const statePath = join(root, 'state.json');
  const socket = join(root, 'socket'); await writeFile(socket, ''); const endpoint = 'unix://' + await realpath(socket);
  const marker = join(root, 'switch');
  await writeFile(join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs'); const statePath = ${JSON.stringify(statePath)}; const marker = ${JSON.stringify(marker)};
const fullArgs = process.argv.slice(2); const args = fullArgs[0] === '--host' ? fullArgs.slice(2) : fullArgs;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { daemon: 'A', exists: false, commands: [] };
state.commands.push({ args: fullArgs, hostEnvironment: process.env.DOCKER_HOST, contextEnvironment: process.env.DOCKER_CONTEXT });
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'info') { save(); process.stdout.write('daemon-' + state.daemon); }
else if (args[0] === 'create') {
  state.id = 'a'.repeat(64); state.exists = true;
  state.labels = Object.fromEntries(args.flatMap((arg, i) => arg === '--label' ? [args[i + 1].split('=')] : []));
  fs.writeFileSync(args[args.indexOf('--cidfile') + 1], state.id); save(); process.stdout.write(state.id);
} else if (args[0] === 'container' && args[1] === 'inspect') {
  save(); if (state.exists) process.stdout.write(JSON.stringify(state.labels));
  else { process.stderr.write('Error: No such container: ' + state.id); process.exitCode = 1; }
} else if (args[0] === 'start') {
  let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
    const request = JSON.parse(input);
    if (${JSON.stringify(mode)} === 'daemon-switch') {
      state.daemon = 'B'; save(); process.stdout.write(JSON.stringify({ ok: true, result: { fingerprint: request.reference.fingerprint, keyId: request.reference.id, version: request.reference.version, format: request.format } }));
    } else { save(); fs.writeFileSync(marker, 'ready'); setTimeout(() => { process.stdout.write('{"ok":false,"code":"KEY_TOOL_FAILED"}'); process.exitCode = 1; }, 150); }
  });
} else if (args[0] === 'kill') { save(); }
else if (args[0] === 'rm') { state.exists = false; save(); }
else { save(); process.exitCode = 2; }
`, { mode: 0o700 });
  const saved = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  process.env.PATH = root; process.env.DOCKER_HOST = endpoint; delete process.env.DOCKER_CONTEXT;
  const timer = mode === 'environment-switch' ? setInterval(() => {
    try { readFileSync(marker); process.env.PATH = '/unavailable'; process.env.DOCKER_HOST = 'unix:///different-daemon'; process.env.DOCKER_CONTEXT = 'different'; } catch {}
  }, 5) : undefined;
  try { await callback(root, statePath, endpoint); }
  finally {
    clearInterval(timer);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}

test('different healthy daemon cannot prove cleanup or commit a signature', async () => {
  await fixture('daemon-switch', async (root, statePath, endpoint) => {
    const artifact = join(root, 'original.aab'); const original = Buffer.from('original artifact'); await writeFile(artifact, original);
    const reference = { id: randomUUID(), version: 1, fingerprint: 'captured-fingerprint' };
    const manager = { credentials: async () => ({ keystoreBase64: 'YQ==', storePassword: 'fixture-pass', keyPassword: 'fixture-pass', keyAlias: 'release' }) };
    await assert.rejects(signDockerAndroidArtifact(manager, reference, artifact, new AbortController().signal), (error: unknown) => {
      const failure = error as { code: string; details: { containerId: string; operationId: string } };
      assert.equal(failure.code, 'DOCKER_KEY_CLEANUP_FAILED'); assert.equal(failure.details.containerId, 'a'.repeat(64)); assert.ok(failure.details.operationId);
      return true;
    });
    assert.deepEqual(await readFile(artifact), original);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.exists, true, 'the fixture models the original daemon becoming unavailable');
    assert.ok(state.commands.every((command: { args: string[] }) => command.args[0] === '--host' && command.args[1] === endpoint));
    assert.ok(!state.commands.some((command: { args: string[] }) => ['kill', 'rm'].includes(command.args[2]!)), 'must not mutate a different daemon');
  });
});
test('lifecycle uses captured endpoint and PATH despite process environment changes', async () => {
  await fixture('environment-switch', async (_root, statePath, endpoint) => {
    await assert.rejects(runDockerKeyHelper({ operation: 'validate', kind: 'ssh', credentials: { host: 'example.test', port: '22', username: 'git', privateKey: 'fixture', passphrase: '', knownHosts: 'fixture' } }), { code: 'KEY_TOOL_FAILED' });
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(state.exists, false);
    assert.ok(state.commands.every((command: { args: string[]; hostEnvironment?: string; contextEnvironment?: string }) =>
      command.args[0] === '--host' && command.args[1] === endpoint && command.hostEnvironment === undefined && command.contextEnvironment === undefined));
    assert.ok(state.commands.some((command: { args: string[] }) => command.args[2] === 'rm'));
  });
});
test('remote Docker endpoints are refused before sending key material', async () => {
  const previousHost = process.env.DOCKER_HOST; const previousContext = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = 'tcp://example.invalid:2375'; delete process.env.DOCKER_CONTEXT;
  try { await assert.rejects(runDockerKeyHelper({ operation: 'validate', kind: 'ssh', credentials: {} }), { code: 'KEY_RUNTIME_UNAVAILABLE' }); }
  finally {
    if (previousHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previousHost;
    if (previousContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = previousContext;
  }
});
