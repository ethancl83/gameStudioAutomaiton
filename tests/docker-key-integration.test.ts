import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { watch, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { zipSync } from 'fflate';
import ssh2, { type Connection as SshConnection } from 'ssh2';
import { Store } from '../packages/storage/index.js';
import { CredentialVault } from '../packages/credentials/index.js';
import { BuildKeyManager, validateBuildCredential, type BuildKeyReference, type BuildSecuritySelection } from '../packages/build-credentials/index.js';
import { signAndroidArtifact, prepareSshDependencies } from '../packages/build-credentials/build.js';
import { dockerKeyRuntimeAvailable, runDockerKeyHelper } from '../packages/build-credentials/docker-runtime.js';
import { KEY_HELPER_LABEL, type KeyHelperRequest } from '../packages/build-credentials/docker-protocol.js';
import { memoryKeyRuntimeAvailable } from '../packages/build-credentials/tools.js';

const enabled = process.env.APPOPS_DOCKER_KEY_TESTS === '1' && process.platform === 'darwin';
const { Server, utils } = ssh2;
function pipeTool(executable: string, args: string[], inputs: Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe', ...inputs.map(() => 'pipe' as const)], env: { PATH: '/usr/bin:/bin' } });
    const chunks: Buffer[] = []; child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk)); child.stderr!.resume();
    inputs.forEach((input, i) => { const pipe = child.stdio[i + 3] as NodeJS.WritableStream; pipe.on('error', () => {}); pipe.end(input); });
    child.on('error', () => reject(new Error('fixture tool unavailable')));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('fixture tool failed')));
  });
}
async function androidFixture(): Promise<Record<string, string>> {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const privateKey = Buffer.from(pair.privateKey); const password = 'fixture-' + randomUUID();
  const certificate = await pipeTool('/usr/bin/openssl', ['req', '-new', '-x509', '-key', '/dev/fd/3', '-subj', '/CN=AppOps Docker Fixture', '-days', '10000', '-sha256'], [privateKey]);
  // Fixture material stays in parent/child pipes; only product metadata appears in test output.
  const keystore = await pipeTool('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', '/dev/fd/3', '-in', '/dev/fd/4', '-passout', 'fd:5', '-name', 'release'], [privateKey, certificate, Buffer.from(password + '\n')]);
  return { keystoreBase64: keystore.toString('base64'), storePassword: password, keyPassword: password, keyAlias: 'release' };
}
function helperContainers(): string[] {
  return execFileSync('docker', ['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=' + KEY_HELPER_LABEL], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
}

async function withTransportFault(root: string, mode: string, controller: AbortController, operation: () => Promise<unknown>, expectedMounts = 1, secrets: string[] = []): Promise<void> {
  const directory = await mkdtemp(join(root, 'transport-'));
  const executable = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim();
  const marker = join(directory, 'abort'); const audit = join(directory, 'audit'); const cid = join(directory, 'cid'); const removed = join(directory, 'removed');
  const source = `#!${process.execPath}
const fs = require('node:fs'); const { spawn, execFile, execFileSync } = require('node:child_process');
const mode = ${JSON.stringify(mode)}, real = ${JSON.stringify(executable)}, marker = ${JSON.stringify(marker)}, audit = ${JSON.stringify(audit)}, cid = ${JSON.stringify(cid)}, removed = ${JSON.stringify(removed)};
const fullArgs = process.argv.slice(2); const args = fullArgs[0] === '--host' ? fullArgs.slice(2) : fullArgs; fs.appendFileSync(audit, JSON.stringify(fullArgs) + '\\n');
if (mode === 'cleanup-fail' && args[0] === 'container' && args[1] === 'inspect' && fs.existsSync(removed)) { process.stderr.write('Cannot connect to the Docker daemon'); process.exit(1); }
const child = spawn(real, fullArgs, { stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; let polling;
if (mode === 'transfer-abort' && args[0] === 'start') fs.writeFileSync(marker, 'ready'); else process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {}); child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
if (mode === 'signing-abort' && args[0] === 'start') polling = setTimeout(() => fs.writeFileSync(marker, 'ready'), 400);
child.on('close', code => {
  clearInterval(polling);
  if (args[0] === 'create' && code === 0) {
    fs.writeFileSync(cid, stdout.trim());
    const inspection = JSON.parse(execFileSync(real, ['inspect', stdout.trim()], { encoding: 'utf8' }))[0];
    fs.writeFileSync(audit + '.inspection', JSON.stringify({ config: inspection.Config, host: inspection.HostConfig, mounts: inspection.Mounts }));
    if (mode === 'cid-loss') { fs.unlinkSync(args[args.indexOf('--cidfile') + 1]); process.exit(1); }
  }
  if (args[0] === 'rm' && code === 0) fs.writeFileSync(removed, 'removed');
  if (args[0] === 'start' && code === 0 && mode === 'partial') stdout = '{"ok":true';
  if (args[0] === 'start' && code === 0 && mode === 'nonzero') code = 2;
  const finish = () => { process.stdout.write(stdout); process.stderr.write(stderr); process.exitCode = code || 0; };
  if (mode === 'precommit-abort' && args[0] === 'info' && fs.existsSync(removed)) { fs.writeFileSync(marker, 'ready'); setTimeout(finish, 200); } else finish();
});
`;
  await writeFile(join(directory, 'docker'), source, { mode: 0o700 });
  const originalPath = process.env.PATH; process.env.PATH = directory + ':' + originalPath;
  const polling = setInterval(() => { try { readFileSync(marker); controller.abort(); } catch {} }, 10);
  try {
    await operation();
    const inspection = JSON.parse(await readFile(audit + '.inspection', 'utf8'));
    assert.equal(inspection.host.LogConfig.Type, 'none'); assert.equal(inspection.host.NetworkMode, 'none');
    assert.equal(inspection.mounts.length, expectedMounts);
    if (expectedMounts) { assert.equal(inspection.mounts[0].Destination, '/work/sign'); assert.ok(inspection.mounts[0].Source.includes('/.appops-sign-')); }
    const serialized = JSON.stringify(inspection);
    for (const secret of secrets) assert.ok(!serialized.includes(secret), 'credential material must not enter container inspection');
    const args = await readFile(audit, 'utf8');
    for (const secret of secrets) assert.ok(!args.includes(secret), 'credential material must not enter CLI arguments');
    assert.ok(!args.includes('keystoreBase64') && !args.includes('storePassword'), 'payload must not enter argv');
  } finally { clearInterval(polling); process.env.PATH = originalPath; await rm(directory, { recursive: true, force: true }); }
}

test('actual Mac Docker helper registers keys, signs AAB, preserves originals on failure, and removes its containers', { skip: !enabled, timeout: 180_000 }, async t => {
  assert.equal(await memoryKeyRuntimeAvailable(), false);
  assert.equal(await dockerKeyRuntimeAvailable(), true, 'Build the actual appops-linux-runner:local image before this opt-in test.');
  const before = helperContainers();
  const root = await mkdtemp(join(tmpdir(), 'appops-docker-key-test-')); const store = new Store(join(root, 'data'), { heartbeat: false });
  let master: Buffer | undefined;
  const vault = new CredentialVault(join(root, 'vault'), { keyProvider: { name: 'memory-test', getKey: async () => master, setKey: async value => { master = value; } } });
  const manager = new BuildKeyManager(store, vault);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await t.test('SSH validation and vault normalization, with wrong-passphrase rejection', async () => {
    const identity = utils.generateKeyPairSync('ed25519', { passphrase: 'docker-test-pass', cipher: 'aes256-cbc', rounds: 2 });
    const host = utils.generateKeyPairSync('ed25519');
    const credentials = { privateKey: identity.private, passphrase: 'docker-test-pass', host: 'EXAMPLE.TEST', port: '00022', knownHosts: 'example.test ' + host.public };
    await assert.rejects(manager.save({ kind: 'ssh', label: 'wrong pass', credentials: { ...credentials, passphrase: 'wrong' } }), { code: 'KEY_TOOL_FAILED' });
    const key = await manager.save({ kind: 'ssh', label: 'docker test', credentials });
    const stored = await manager.credentials({ id: key.id, version: key.version, fingerprint: key.fingerprint });
    assert.equal(stored.host, 'example.test'); assert.equal(stored.port, '22'); assert.equal(stored.username, 'git');
    assert.ok(stored.privateKey === identity.private.trim() + '\n', 'private key normalization mismatch'); assert.equal(stored.knownHosts, credentials.knownHosts.trim() + '\n');
  });
  const credentials = await androidFixture();
  await assert.rejects(manager.save({ kind: 'android-keystore', label: 'wrong', credentials: { ...credentials, storePassword: 'wrong' } }), { code: 'KEY_TOOL_FAILED' });
  const android = await manager.save({ kind: 'android-keystore', label: 'docker Android', credentials });
  const reference: BuildKeyReference = { id: android.id, version: android.version, fingerprint: android.fingerprint };
  await t.test('validation has no host mount, no network, no log driver, and no input secret in inspection or argv', async () => {
    await withTransportFault(root, 'observe', new AbortController(), () => manager.save({ kind: 'android-keystore', label: 'audit', credentials }), 0,
      [credentials.keystoreBase64!, credentials.storePassword!]);
  });
  const artifact = join(root, 'unsigned.aab'); const original = Buffer.from(zipSync({ 'base/manifest/AndroidManifest.xml': Buffer.from('fixture') }));
  await t.test('AAB signature verifies and only the artifact is replaced', async () => {
    await writeFile(artifact, original);
    const result = await signAndroidArtifact(manager, reference, artifact, root, new AbortController().signal);
    assert.equal(result.fingerprint, reference.fingerprint); assert.equal(result.format, 'aab');
    assert.notDeepEqual(await readFile(artifact), original);
    assert.equal((await readdir(root)).some(name => name.startsWith('.appops-sign-')), false);
  });
  await t.test('wrong captured fingerprint, missing APK tools, links, and pre-abort preserve original bytes', async () => {
    await writeFile(artifact, original);
    await assert.rejects(signAndroidArtifact(manager, { ...reference, fingerprint: 'wrong' }, artifact, root, new AbortController().signal));
    assert.deepEqual(await readFile(artifact), original);
    const apk = join(root, 'unsigned.apk'); await writeFile(apk, original);
    await assert.rejects(signAndroidArtifact(manager, reference, apk, root, new AbortController().signal), { code: 'SIGNING_TOOL_REQUIRED' });
    assert.deepEqual(await readFile(apk), original);
    const hardlink = join(root, 'hardlink.aab'); await link(artifact, hardlink);
    await assert.rejects(signAndroidArtifact(manager, reference, artifact, root, new AbortController().signal), { code: 'ARTIFACT_ESCAPE' });
    await rm(hardlink);
    const symbolic = join(root, 'symlink.aab'); await symlink(artifact, symbolic);
    await assert.rejects(signAndroidArtifact(manager, reference, symbolic, root, new AbortController().signal));
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(signAndroidArtifact(manager, reference, artifact, root, aborted.signal), { code: 'CANCELLED' });
    assert.deepEqual(await readFile(artifact), original);
  });
  await t.test('real helper timeout removes exact container and leaves artifact unchanged', async () => {
    const request: KeyHelperRequest = { operation: 'validate', kind: 'android-keystore', credentials };
    await assert.rejects(runDockerKeyHelper(request, { timeoutMs: 1 }), { code: 'KEY_TOOL_TIMEOUT' });
    assert.deepEqual(await readFile(artifact), original);
  });
  await t.test('transport faults and cancellation before commit leave the original and no helper container', async () => {
    for (const [mode, code] of [['transfer-abort', 'CANCELLED'], ['signing-abort', 'CANCELLED'], ['precommit-abort', 'CANCELLED'],
      ['partial', 'DOCKER_KEY_PROTOCOL'], ['nonzero', 'DOCKER_KEY_PROTOCOL'], ['cleanup-fail', 'DOCKER_KEY_CLEANUP_FAILED'], ['cid-loss', 'KEY_RUNTIME_UNAVAILABLE']]) {
      await writeFile(artifact, original); const controller = new AbortController();
      await withTransportFault(root, mode!, controller, async () => {
        await assert.rejects(signAndroidArtifact(manager, reference, artifact, root, controller.signal), (error: unknown) => {
          assert.equal((error as { code: string }).code, code, mode);
          if (mode === 'cleanup-fail') assert.ok((error as { details: { containerId: string; operationId: string } }).details.containerId);
          return true;
        }, mode);
      }, 1, [credentials.keystoreBase64!, credentials.storePassword!]);
      assert.deepEqual(await readFile(artifact), original, mode);
      assert.deepEqual(helperContainers(), before, mode);
    }
  });
  await t.test('cancelling one concurrent helper does not stop the other container or replace its original', async () => {
    const first = join(root, 'concurrent-first.aab'); const second = join(root, 'concurrent-second.aab');
    await writeFile(first, original); await writeFile(second, original);
    const controller = new AbortController();
    const cancelled = signAndroidArtifact(manager, reference, first, root, controller.signal);
    const successful = signAndroidArtifact(manager, reference, second, root, new AbortController().signal);
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      await assert.rejects(cancelled, { code: 'CANCELLED' });
      assert.equal((await successful).fingerprint, reference.fingerprint);
      assert.deepEqual(await readFile(first), original); assert.notDeepEqual(await readFile(second), original);
      assert.deepEqual(helperContainers(), before);
    } finally { clearTimeout(timer); }
  });
  await t.test('abort delivered after atomic replacement reports the committed signature', async () => {
    await writeFile(artifact, original); const controller = new AbortController();
    const watcher = watch(root, (_, filename) => {
      if (filename === 'unsigned.aab') {
        try { if (!readFileSync(artifact).equals(original)) controller.abort(); } catch {}
      }
    });
    try {
      const result = await signAndroidArtifact(manager, reference, artifact, root, controller.signal);
      assert.equal(result.fingerprint, reference.fingerprint); assert.notDeepEqual(await readFile(artifact), original);
      if (!controller.signal.aborted) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture did not observe replacement')), 2000);
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      assert.equal(controller.signal.aborted, true, 'fixture must observe cancellation after replacement');
    } finally { watcher.close(); }
  });
  assert.deepEqual(helperContainers(), before);
});

test('actual Docker SSH fetch distinguishes host loopback, reachable server, and wrong known_hosts', { skip: !enabled, timeout: 120_000 }, async t => {
  assert.equal(await dockerKeyRuntimeAvailable(), true);
  const before = helperContainers();
  const root = await mkdtemp(join(tmpdir(), 'appops-docker-ssh-test-')); const repository = join(root, 'repo'); await mkdir(repository);
  const git = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['init', '-b', 'main']); await writeFile(join(repository, 'dependency.txt'), 'real Docker dependency'); await writeFile(join(repository, '.env'), 'OMIT_FIXTURE=true');
  git(['add', 'dependency.txt', '.env']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  const expectedCommit = git(['rev-parse', 'HEAD']);
  const identity = utils.generateKeyPairSync('ed25519', { passphrase: 'fetch-test-pass', cipher: 'aes256-cbc', rounds: 2 });
  const host = utils.generateKeyPairSync('ed25519'); const allowed = utils.parseKey(identity.public); assert.ok(!(allowed instanceof Error));
  const clients = new Set<SshConnection>(); let authentications = 0;
  const server = new Server({ hostKeys: [host.private] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.username !== 'git' || context.method !== 'publickey' || !context.key.data.equals(allowed.getPublicSSH()) ||
        (context.signature && (!context.blob || !allowed.verify(context.blob, context.signature, context.hashAlgo)))) return context.reject();
      if (context.signature) authentications++; context.accept();
    });
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (acceptExec, reject, info) => {
        if (info.command !== "git-upload-pack '/repo.git'") return reject();
        const channel = acceptExec(); const child = spawn('/usr/bin/git-upload-pack', [repository], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['pipe', 'pipe', 'pipe'] });
        channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr);
        child.on('close', code => { channel.exit(code ?? 1); channel.end(); }); channel.on('close', () => child.kill());
      });
    }));
  });
  // Docker Desktop reaches this listener through host.docker.internal; no production URL rewriting exists.
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  t.after(async () => { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const reference: BuildKeyReference = { id: randomUUID(), version: 1, fingerprint: 'fixture-selected-key' };
  async function fetch(hostname: string, publicKey: string, name: string) {
    const credentials = { privateKey: identity.private, passphrase: 'fetch-test-pass', host: hostname, port: String(port), username: 'git', knownHosts: `[${hostname}]:${port} ${publicKey}` };
    const manager = { credentials: async (selected: BuildKeyReference) => { assert.deepEqual(selected, reference); return credentials; } };
    const selection: BuildSecuritySelection = { sshDependencies: [{ key: reference, repositoryUrl: `ssh://git@${hostname}:${port}/repo.git`, revision: 'main', relativePath: 'vendor/private' }] };
    const snapshot = join(root, name); await mkdir(snapshot);
    return { results: await prepareSshDependencies(manager, selection, snapshot, join(root, 'work'), root, new AbortController().signal), snapshot };
  }
  await assert.rejects(fetch('127.0.0.1', host.public, 'loopback'), { code: 'KEY_TOOL_FAILED' });
  assert.equal(authentications, 0);
  const result = await fetch('host.docker.internal', host.public, 'reachable');
  assert.equal(result.results[0]!.commit, expectedCommit); assert.equal(authentications, 1);
  assert.equal(await readFile(join(result.snapshot, 'vendor/private/dependency.txt'), 'utf8'), 'real Docker dependency');
  await assert.rejects(stat(join(result.snapshot, 'vendor/private/.env')), { code: 'ENOENT' });
  await assert.rejects(stat(join(result.snapshot, 'vendor/private/.git')), { code: 'ENOENT' });
  await assert.rejects(fetch('host.docker.internal', utils.generateKeyPairSync('ed25519').public, 'wrong-pin'), { code: 'KEY_TOOL_FAILED' });
  assert.equal(authentications, 1); assert.deepEqual(helperContainers(), before);
});

test('actual helper rejects malformed and oversized stdin without echoing input or leaving a container', { skip: !enabled, timeout: 30_000 }, async () => {
  for (const [input, code] of [['{"privateKey":"fixture-secret-canary",', 'DOCKER_KEY_PROTOCOL'], ['x'.repeat(16 * 1024 * 1024 + 1), 'INVALID_BUILD_CREDENTIAL']]) {
    const name = 'appops-key-input-test-' + randomUUID();
    let stdout = ''; let stderr = ''; let status = 0;
    try {
      stdout = execFileSync('docker', ['run', '--rm', '--name', name, '--interactive', '--log-driver', 'none', '--network', 'none', '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--workdir', '/app', '--entrypoint', 'node', 'appops-linux-runner:local', '--import', 'tsx', 'apps/runner/key-helper.ts'],
      { input, encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      const result = error as { stdout?: string; stderr?: string; status?: number }; stdout = result.stdout ?? ''; stderr = result.stderr ?? ''; status = result.status ?? -1;
    }
    assert.equal(status, 1); assert.deepEqual(JSON.parse(stdout), { ok: false, code });
    assert.ok(!stdout.includes('fixture-secret-canary') && !stderr.includes('fixture-secret-canary'));
    let absence = '';
    try { execFileSync('docker', ['container', 'inspect', name], { stdio: ['ignore', 'pipe', 'pipe'] }); assert.fail('fixture container still exists'); }
    catch (error) { absence = String((error as { stderr?: Buffer }).stderr ?? ''); }
    assert.ok(absence.includes('No such container') || absence.includes('No such object'));
  }
});


test('actual Docker key validation works with the restricted macOS GUI PATH and still rejects wrong secrets', { skip: !enabled, timeout: 30_000 }, async () => {
  const saved = process.env.PATH; process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    assert.equal(await dockerKeyRuntimeAvailable(), true);
    const identity = utils.generateKeyPairSync('ed25519', { passphrase: 'gui-fixture-pass', cipher: 'aes256-cbc', rounds: 2 });
    const host = utils.generateKeyPairSync('ed25519');
    const credentials = { privateKey: identity.private, passphrase: 'gui-fixture-pass', host: 'example.test', knownHosts: 'example.test ' + host.public };
    const result = await validateBuildCredential('ssh', credentials, 'gui-fixture');
    assert.equal(result.publicKey, identity.public.split(' ').slice(0, 2).join(' '));
    await assert.rejects(validateBuildCredential('ssh', { ...credentials, passphrase: 'wrong' }, 'gui-fixture'), { code: 'KEY_TOOL_FAILED' });
  } finally { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; }
});
