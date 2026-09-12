// Behavioral regression tests for the per-vault key slot + write locking (packages/credentials).
// Covers v4-backup-crypto-review F1 (concurrent master-key creation must not lose credentials),
// F5 (remove is atomic with snapshot), F7 (status is read-only), F8 (legacy stays slotless), and the
// stale-lock recovery path. Uses injected fake key providers only — never the live OS keyring, and
// never asserts a secret value beyond confirming a round-trip decrypts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault, DirectoryKeyProvider, type KeyProvider } from '../packages/credentials/index.js';

// Shared in-memory key store standing in for the OS keyring, keyed by slot account.
function providers() {
  const keys = new Map<string, Buffer>();
  const factory = (account = 'legacy'): KeyProvider => ({
    name: 'test-slots',
    getKey: async () => keys.get(account),
    setKey: async key => { keys.set(account, Buffer.from(key)); },
  });
  return { keys, factory, vault: (path: string) => new CredentialVault(path, { keyProvider: new DirectoryKeyProvider(path, factory) }) };
}

async function temporary(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'appops-vault-primitive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// F1: two vaults racing on one empty directory must not lose the first credential
// ---------------------------------------------------------------------------

test('concurrent first writes on one directory converge on a single key (no silent loss)', async t => {
  const root = await temporary(t);
  for (let round = 0; round < 3; round += 1) {
    const p = providers(), dir = join(root, `race-${round}`);
    const v1 = p.vault(dir), v2 = p.vault(dir);
    // Both vaults see an empty directory and try to mint a master key at the same time.
    await Promise.all([v1.set('one', { token: 'one' }), v2.set('two', { token: 'two' })]);
    // Without the cross-process lock the second mint overwrote the first key and 'one' would be
    // undecryptable. Both must decrypt, under exactly one shared key/account.
    assert.deepEqual(await p.vault(dir).get('one'), { token: 'one' }, `round ${round}: first record`);
    assert.deepEqual(await p.vault(dir).get('two'), { token: 'two' }, `round ${round}: second record`);
    assert.equal(p.keys.size, 1, `round ${round}: one key account`);
  }
});

// ---------------------------------------------------------------------------
// F5: remove() runs under the write lock, so snapshotRecords stays consistent
// ---------------------------------------------------------------------------

test('remove during snapshotRecords never yields credential_not_found', async t => {
  const root = await temporary(t), p = providers(), dir = join(root, 'snap');
  const v = p.vault(dir);
  for (let i = 0; i < 30; i += 1) await v.set(`id${i}`, { token: `t${i}` });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // Racing a delete against a snapshot must not make the snapshot observe an id it cannot read.
    await assert.doesNotReject(Promise.all([v.snapshotRecords(), v.remove('id10')]));
    await v.set('id10', { token: 't10' }); // re-add for the next attempt
  }
  const snap = await v.snapshotRecords();
  assert.deepEqual(snap['id10'], { token: 't10' });
});

// ---------------------------------------------------------------------------
// F7: status() must not materialize a slot on a read-only probe
// ---------------------------------------------------------------------------

test('status() on an absent directory reports usable without creating a slot', async t => {
  const root = await temporary(t), p = providers(), dir = join(root, 'probe');
  const v = p.vault(dir);
  const status = await v.status();
  assert.equal(status.available, true); // empty vault: a key is minted on first write
  assert.equal(existsSync(join(dir, 'key-slot.json')), false, 'a read probe must not publish a slot');
  assert.equal(p.keys.size, 0, 'a read probe must not mint a key');
});

// ---------------------------------------------------------------------------
// F8: a legacy directory keeps its shared account and gains no slot on a write
// ---------------------------------------------------------------------------

test('writing through DirectoryKeyProvider on a legacy directory adds no slot', async t => {
  const root = await temporary(t), p = providers(), dir = join(root, 'legacy');
  const legacy = new CredentialVault(dir, { keyProvider: p.factory() }); // raw shared-default account
  await legacy.set('old', { token: 'legacy' });
  const wrapped = p.vault(dir);
  await wrapped.set('added', { token: 'added' });
  assert.equal(existsSync(join(dir, 'key-slot.json')), false, 'legacy directory must not gain a slot');
  assert.deepEqual([...p.keys.keys()], ['legacy'], 'exactly the shared default account');
  assert.deepEqual(await wrapped.get('old'), { token: 'legacy' });
  assert.deepEqual(await wrapped.get('added'), { token: 'added' });
});

// ---------------------------------------------------------------------------
// Stale-lock recovery: a lock left by a dead/hung owner must not deadlock the vault
// ---------------------------------------------------------------------------

test('a stale write lock is safely reclaimed on the next write', async t => {
  const root = await temporary(t), p = providers(), dir = join(root, 'stale');
  const v = p.vault(dir);
  await v.set('first', { token: 'first' });
  await mkdir(dir, { recursive: true });
  // Age-based staleness: our own pid is alive, but the lock is far older than the stale threshold, so
  // it must be reclaimed rather than waited on indefinitely.
  await writeFile(join(dir, '.vault.lock'), JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'stale', at: Date.now() - 5 * 60_000 }));
  await v.set('second', { token: 'second' });
  assert.deepEqual(await v.get('second'), { token: 'second' });
  assert.deepEqual(await v.get('first'), { token: 'first' });
  assert.equal(existsSync(join(dir, '.vault.lock')), false, 'the reclaimed lock is released after the write');
});

test('a lock owned by a dead pid is reclaimed', async t => {
  const root = await temporary(t), p = providers(), dir = join(root, 'deadpid');
  const v = p.vault(dir);
  await v.set('first', { token: 'first' });
  await mkdir(dir, { recursive: true });
  // Fresh timestamp but an out-of-range / absent pid: the owner-liveness check must classify it stale.
  await writeFile(join(dir, '.vault.lock'), JSON.stringify({ pid: 2 ** 31 - 1, host: hostname(), nonce: 'dead', at: Date.now() }));
  await v.set('second', { token: 'second' });
  assert.deepEqual(await v.get('second'), { token: 'second' });
});
