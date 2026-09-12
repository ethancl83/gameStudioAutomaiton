import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync } from 'fflate';
import { Store } from '../packages/storage/index.js';
import { CredentialVault, type KeyProvider } from '../packages/credentials/index.js';
import { BuildKeyManager, validateBuildCredential } from '../packages/build-credentials/index.js';
import { signAndroidArtifact } from '../packages/build-credentials/build.js';
import { javaTool, privateFile, runTrustedTool, secretWorkspace } from '../packages/build-credentials/tools.js';
import { DEFAULT_POLICY, type Project } from '../packages/domain/index.js';

test('real SSH import decrypts a passphrase key, pins host, versions vault data, and prevents in-use deletion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-key-lifecycle-')); const store = new Store(directory, { heartbeat: false });
  let master: Buffer | undefined; const keyProvider: KeyProvider = { name: 'test-memory', getKey: async () => master, setKey: async key => { master = key; } };
  const vault = new CredentialVault(join(directory, 'vault'), { keyProvider }); const manager = new BuildKeyManager(store, vault);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const passphrase = 'test-only-SSH-passphrase';
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const hostKey = await secretWorkspace(directory, async workspace => {
    const key = join(workspace, 'hostkey');
    await runTrustedTool('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { cwd: workspace });
    return (await readFile(key + '.pub', 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  });
  const credentials = { privateKey, passphrase, host: 'git.example.test', knownHosts: 'git.example.test ' + hostKey };
  await assert.rejects(manager.save({ kind: 'ssh', label: 'Wrong pass', credentials: { ...credentials, passphrase: 'incorrect' } }), { code: 'KEY_TOOL_FAILED' });
  const key = await manager.save({ kind: 'ssh', label: 'Test repo', credentials });
  assert.match(key.fingerprint, /^SHA256:/); assert.ok(key.publicKey?.startsWith('ssh-rsa '));
  assert.equal(JSON.stringify(manager.list()).includes(passphrase), false);
  assert.equal(JSON.stringify(manager.list()).includes('PRIVATE KEY'), false);
  const file = join(directory, 'vault', 'build-key-' + key.id + '-v1.cred.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, 'utf8')).includes(passphrase), false);
  const policy = manager.policy({ sshDependencies: [{ credentialId: key.id, repositoryUrl: 'ssh://git@git.example.test/org/repo.git', revision: 'main', relativePath: 'vendor/repo' }] });
  const project = { id: 'project', policy: DEFAULT_POLICY, buildSecurity: policy } as Project;
  store.put('project', project.id, project);
  const selection = manager.capture(project);
  // A failed metadata/event transaction must not expose or strand a new version.
  store.db.exec("CREATE TRIGGER fail_key_event BEFORE INSERT ON events WHEN NEW.kind='build-key.rotated' BEGIN SELECT RAISE(ABORT, 'synthetic key event failure'); END");
  await assert.rejects(manager.save({ credentials: {}, label: 'Uncommitted rotation' }, key.id), /synthetic key event failure/);
  assert.equal(manager.get(key.id).version, 1);
  assert.equal(await vault.has('build-key-' + key.id + '-v2'), false);
  const remove = vault.remove.bind(vault);
  vault.remove = async () => { throw new Error('synthetic cleanup failure'); };
  await assert.rejects(manager.save({ credentials: {}, label: 'Interrupted cleanup' }, key.id));
  assert.equal(await vault.has('build-key-' + key.id + '-v2'), true);
  vault.remove = remove; store.db.exec('DROP TRIGGER fail_key_event');
  await new BuildKeyManager(store, vault).cleanup();
  assert.equal(await vault.has('build-key-' + key.id + '-v2'), false);
  const rotated = await manager.save({ credentials: { passphrase }, label: 'Rotated label' }, key.id);
  assert.equal(rotated.version, 2); assert.equal(selection.sshDependencies[0]!.key.version, 1);
  assert.equal((await manager.credentials(selection.sshDependencies[0]!.key)).passphrase, passphrase);
  await assert.rejects(manager.remove(key.id), { code: 'BUILD_KEY_IN_USE' });
  assert.throws(() => manager.policy({ sshDependencies: [{ ...policy.sshDependencies[0], repositoryUrl: 'ssh://git@attacker.test/org/repo.git' }] }), { code: 'INVALID_BUILD_CREDENTIAL' });
  store.remove('project', project.id);
  store.createRun({ kind: 'build', label: 'captured key', input: { buildSecurity: selection } });
  await assert.rejects(manager.remove(key.id), { code: 'BUILD_KEY_IN_USE' });
  const active = store.runs()[0]!; store.cancel(active.id);
  await vault.set('build-key-' + key.id + '-v3', { synthetic: 'unpublished version' });
  await manager.remove(key.id); assert.equal(await vault.has('build-key-' + key.id + '-v1'), false);
  assert.equal(await vault.has('build-key-' + key.id + '-v2'), false);
  assert.equal(await vault.has('build-key-' + key.id + '-v3'), false);
});

test('real Android keystore import proves the private key and signs/verifies an AAB-format JAR', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-android-key-')); const store = new Store(directory, { heartbeat: false });
  let master: Buffer | undefined;
  const vault = new CredentialVault(join(directory, 'vault'), { keyProvider: { name: 'test', getKey: async () => master, setKey: async key => { master = key; } } });
  const manager = new BuildKeyManager(store, vault); t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const storePassword = 'test-only-Android-password';
  const keystoreBase64 = await secretWorkspace(directory, async workspace => {
    const keytool = await javaTool('keytool'); const pass = await privateFile(workspace, 'pass', storePassword); const path = join(workspace, 'test.p12');
    await runTrustedTool(keytool.executable, ['-genkeypair', '-keyalg', 'RSA', '-keysize', '2048', '-alias', 'release', '-dname', 'CN=AppOps Test', '-validity', '10000', '-keystore', path, '-storepass:file', pass, '-keypass:file', pass], { cwd: workspace, environment: { JAVA_HOME: keytool.javaHome } });
    return (await readFile(path)).toString('base64');
  });
  await assert.rejects(validateBuildCredential('android-keystore', { keystoreBase64, storePassword: 'wrong-password', keyAlias: 'release' }, directory), { code: 'KEY_TOOL_FAILED' });
  const key = await manager.save({ kind: 'android-keystore', label: 'Android test', credentials: { keystoreBase64, storePassword, keyAlias: 'release' } });
  assert.match(key.fingerprint, /^[A-F0-9:]{95}$/); assert.equal(key.details.keyAlias, 'release');
  const output = join(directory, 'output'); await mkdir(output);
  const path = join(output, 'unsigned.aab'); await writeFile(path, zipSync({ 'base/manifest/AndroidManifest.xml': Buffer.from('test signing payload, not an installable app') }));
  const result = await signAndroidArtifact(manager, { id: key.id, version: key.version, fingerprint: key.fingerprint }, path, directory, new AbortController().signal);
  assert.equal(result.fingerprint, key.fingerprint);
  const bytes = await readFile(path); assert.equal(bytes.includes(Buffer.from(storePassword)), false); assert.equal(bytes.includes(Buffer.from(keystoreBase64)), false);
  assert.deepEqual((await readdir(output)).sort(), ['unsigned.aab']);
});

test('private temporary files are removed on errors and cancellation kills trusted tool work', async () => {
  let path = '';
  await assert.rejects(secretWorkspace('cleanup-test', async workspace => { path = workspace; await privateFile(workspace, 'private', 'fake secret'); throw new Error('test failure'); }));
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await secretWorkspace('cancel-test', async workspace => {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 100);
    try { await assert.rejects(runTrustedTool('/usr/bin/sleep', ['60'], { cwd: workspace, signal: abort.signal }), { code: 'CANCELLED' }); }
    finally { clearTimeout(timer); }
  });
});

test('Android release keys reject future validity, short expiry and prohibited signing usage', async () => {
  await secretWorkspace('android-invalid-certificates', async workspace => {
    const keytool = await javaTool('keytool'); const storePassword = 'generated-test-password';
    const pass = await privateFile(workspace, 'password', storePassword);
    for (const [name, extra, code] of [
      ['future', ['-startdate', '+1d', '-validity', '10000'], 'INVALID_BUILD_CREDENTIAL'],
      ['short', ['-validity', '30'], 'INVALID_BUILD_CREDENTIAL'],
      ['usage', ['-validity', '10000', '-ext', 'KU=keyEncipherment'], 'KEY_TOOL_FAILED'],
    ] as const) {
      const file = join(workspace, name + '.p12');
      await runTrustedTool(keytool.executable, ['-genkeypair', '-keyalg', 'RSA', '-keysize', '2048', '-alias', 'release', '-dname', 'CN=AppOps Negative Test', ...extra, '-keystore', file, '-storepass:file', pass, '-keypass:file', pass], { cwd: workspace, environment: { JAVA_HOME: keytool.javaHome } });
      const credentials = { keystoreBase64: (await readFile(file)).toString('base64'), storePassword, keyPassword: storePassword, keyAlias: 'release' };
      await assert.rejects(validateBuildCredential('android-keystore', credentials, name), { code });
      if (name !== 'usage') {
        // Also reject a previously stored invalid key at build time, before replacing the source artifact.
        const artifact = join(workspace, name + '.aab'); const original = zipSync({ 'base/manifest/AndroidManifest.xml': Buffer.from('test') });
        await writeFile(artifact, original);
        await assert.rejects(signAndroidArtifact({ credentials: async () => credentials } as unknown as BuildKeyManager, { id: '00000000-0000-0000-0000-000000000000', version: 1, fingerprint: 'unused' }, artifact, name, new AbortController().signal), { code });
        assert.deepEqual(await readFile(artifact), Buffer.from(original));
      }
    }
  });
});
