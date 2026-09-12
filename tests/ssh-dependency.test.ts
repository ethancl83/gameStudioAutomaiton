import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ssh2, { type Connection as SshConnection } from 'ssh2';
const { Server, utils } = ssh2;
import { Store } from '../packages/storage/index.js';
import { CredentialVault } from '../packages/credentials/index.js';
import { BuildKeyManager } from '../packages/build-credentials/index.js';
import { prepareSshDependencies } from '../packages/build-credentials/build.js';
import { DEFAULT_POLICY, type Project } from '../packages/domain/index.js';

test('isolated Git fetch authenticates to a real loopback SSH server, verifies host, and copies only snapshot inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appops-ssh-fetch-')); const repository = join(root, 'repo'); await mkdir(repository);
  const git = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['init', '-b', 'main']); await writeFile(join(repository, 'dependency.txt'), 'actual private dependency'); await writeFile(join(repository, '.env'), 'DO_NOT_COPY=secret');
  git(['add', 'dependency.txt', '.env']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  const expectedCommit = git(['rev-parse', 'HEAD']);
  const identity = utils.generateKeyPairSync('ed25519', { passphrase: 'test-only-ssh-pass', cipher: 'aes256-cbc', rounds: 2 });
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
      const session = accept(); session.on('exec', (acceptExec, reject, info) => {
        if (info.command !== "git-upload-pack '/repo.git'") return reject();
        const channel = acceptExec(); const process = spawn('/usr/bin/git-upload-pack', [repository], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['pipe', 'pipe', 'pipe'] });
        channel.pipe(process.stdin); process.stdout.pipe(channel, { end: false }); process.stderr.pipe(channel.stderr);
        process.on('close', code => { channel.exit(code ?? 1); channel.end(); }); channel.on('close', () => process.kill());
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const store = new Store(join(root, 'data'), { heartbeat: false }); let master: Buffer | undefined;
  const vault = new CredentialVault(join(root, 'vault'), { keyProvider: { name: 'test', getKey: async () => master, setKey: async key => { master = key; } } });
  const manager = new BuildKeyManager(store, vault);
  t.after(async () => { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(root, { recursive: true, force: true }); });
  const key = await manager.save({ kind: 'ssh', label: 'Local fixture', credentials: { privateKey: identity.private, passphrase: 'test-only-ssh-pass', host: '127.0.0.1', port: String(address.port), knownHosts: `[127.0.0.1]:${address.port} ${host.public}` } });
  const buildSecurity = manager.policy({ sshDependencies: [{ credentialId: key.id, repositoryUrl: `ssh://git@127.0.0.1:${address.port}/repo.git`, revision: 'main', relativePath: 'vendor/private' }] });
  const selection = manager.capture({ buildSecurity, policy: DEFAULT_POLICY } as Project);
  const snapshot = join(root, 'snapshot'); await mkdir(snapshot); const work = join(root, 'work');
  const result = await prepareSshDependencies(manager, selection, snapshot, work, store.directory, new AbortController().signal);
  assert.equal(authentications, 1); assert.equal(result[0]!.commit, expectedCommit);
  assert.equal(await readFile(join(snapshot, 'vendor/private/dependency.txt'), 'utf8'), 'actual private dependency');
  await assert.rejects(stat(join(snapshot, 'vendor/private/.env')), { code: 'ENOENT' });
  await assert.rejects(stat(join(snapshot, 'vendor/private/.git')), { code: 'ENOENT' });
  await assert.rejects(stat(join(work, 'checkout-0')), { code: 'ENOENT' });
  // A rotated, incorrect server pin must fail before public-key authentication or file ingestion.
  const wrong = utils.generateKeyPairSync('ed25519');
  await manager.save({ credentials: { knownHosts: `[127.0.0.1]:${address.port} ${wrong.public}` } }, key.id);
  const badSelection = manager.capture({ buildSecurity, policy: DEFAULT_POLICY } as Project);
  const emptySnapshot = join(root, 'snapshot-wrong-pin'); await mkdir(emptySnapshot);
  await assert.rejects(prepareSshDependencies(manager, badSelection, emptySnapshot, work, store.directory, new AbortController().signal), { code: 'KEY_TOOL_FAILED' });
  assert.equal(authentications, 1);
});
