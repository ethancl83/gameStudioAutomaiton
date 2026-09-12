import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { CredentialError, describeError } from './errors.js';
import { DirectoryKeyProvider } from './directory-key-provider.js';
import type { Credentials, KeyProvider, VaultStatus } from './types.js';

// Cross-instance / cross-process exclusive lock for the vault's canonical directory. It guards every
// destructive write (set, remove, and — critically — master-key creation) so two vaults on one empty
// directory cannot both mint a key and have the second overwrite the first (silent credential loss).
// The lock is a plain O_EXCL file next to the slot; a losing racer re-reads the freshly minted key
// instead of minting its own. Stale locks from a dead or hung owner are reclaimed safely.
const LOCK_FILE = '.vault.lock';
const LOCK_STALE_MS = 30_000; // a single set/remove/key-create is sub-second; a lock older than this is dead or hung
const LOCK_MAX_WAIT_MS = 45_000;
const LOCK_RETRY_MS = 25;

interface LockHandle { path: string; nonce: string; }

function delay(ms: number): Promise<void> { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }

// True unless we can prove the owner is gone. Cross-host PIDs are unknowable, so those age out instead.
function ownerAlive(pid: unknown, host: unknown): boolean {
  if (host !== hostname()) return true;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function lockIsStale(path: string): Promise<boolean> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; } // vanished → retry create; unreadable → treat as stale
  let info: { pid?: unknown; host?: unknown; at?: unknown };
  try { info = JSON.parse(raw); } catch { return true; }
  if (typeof info.at !== 'number') return true;
  if (!ownerAlive(info.pid, info.host)) return true;
  return Date.now() - info.at > LOCK_STALE_MS;
}

async function acquireDirLock(directory: string): Promise<LockHandle> {
  const path = join(directory, LOCK_FILE);
  const nonce = randomUUID();
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), nonce, at: Date.now() })); await handle.sync(); }
      finally { await handle.close(); }
      return { path, nonce };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new CredentialError('vault_unavailable', `failed to acquire the vault write lock: ${describeError(error)}`, { cause: error });
      }
      if (await lockIsStale(path)) {
        // Move the stale lock aside atomically: only one racer wins the rename. The real mutual
        // exclusion remains the O_EXCL create above, so reclaiming can never let two owners coexist.
        try { const aside = `${path}.${nonce}.stale`; await rename(path, aside); await rm(aside, { force: true }); }
        catch (moveError) {
          if ((moveError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new CredentialError('vault_unavailable', `failed to reclaim a stale vault lock: ${describeError(moveError)}`, { cause: moveError });
          }
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new CredentialError('vault_locked', 'another process is writing to this vault; try again shortly', { retryable: true });
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function releaseDirLock(lock: LockHandle): Promise<void> {
  try {
    const info = JSON.parse(await readFile(lock.path, 'utf8')) as { nonce?: string };
    if (info.nonce !== lock.nonce) return; // ours was reclaimed as stale; leave the current owner's lock in place
  } catch { return; }
  await rm(lock.path, { force: true });
}

const SCHEMA_VERSION = 1;
const KEY_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FILE_SUFFIX = '.cred.json';
// Explicit total heap cap for snapshotRecords: at most this many bytes of decrypted plaintext are
// held at once, independent of the 10k count cap.
const SNAPSHOT_MAX_BYTES = 64 * 1024 ** 2;
// No path separators, no leading dot, no '..' anywhere: the id doubles as the
// on-disk file name, so it must not be able to escape the vault directory.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface StoredRecord {
  schema: number;
  keyVersion: number;
  algorithm: string;
  nonce: string;
  ciphertext: string;
  tag: string;
  updatedAt: string;
}

function aadFor(id: string, schema: number, keyVersion: number): Buffer {
  return Buffer.from(`app-ops-credential|schema:${schema}|id:${id}|key:${keyVersion}`, 'utf8');
}

function assertValidId(id: string): void {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || id.includes('..')) {
    throw new CredentialError(
      'invalid_id',
      'credential id must be 1-128 characters of [A-Za-z0-9._-], start with an alphanumeric character, and must not contain path separators or ".."',
    );
  }
}

function assertValidCredentials(value: Credentials): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CredentialError('invalid_credentials', 'credentials must be a plain object of string values');
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue !== 'string') {
      throw new CredentialError('invalid_credentials', `credential field "${field}" must be a string`);
    }
  }
}

export class CredentialVault {
  readonly #directory: string;
  readonly #keyProvider: KeyProvider;
  #writeLock: Promise<unknown> = Promise.resolve();

  /** Used by source/build boundaries; credential contents remain accessible only through the vault. */
  get directory(): string { return this.#directory; }

  constructor(directory: string, options?: { keyProvider?: KeyProvider }) {
    if (typeof directory !== 'string' || directory.trim() === '') {
      throw new TypeError('CredentialVault requires a non-empty directory path');
    }
    this.#directory = resolve(directory);
    this.#keyProvider = options?.keyProvider ?? new DirectoryKeyProvider(this.#directory);
  }

  async status(): Promise<VaultStatus> {
    const backend = this.#keyProvider.name;
    let key: Buffer | undefined;
    try {
      key = await this.#keyProvider.getKey();
    } catch (error) {
      return {
        available: false,
        backend,
        reason: error instanceof CredentialError ? error.message : `key provider failed: ${describeError(error)}`,
      };
    }
    if (key !== undefined) {
      if (key.length !== KEY_BYTES) {
        return { available: false, backend, reason: 'stored master key has an unexpected length; refusing to use it' };
      }
      return { available: true, backend };
    }
    if ((await this.#listCredentialFiles()).length > 0) {
      return {
        available: false,
        backend,
        reason:
          'encrypted credentials exist but the master key is absent from the key store; restore the key instead of creating a new one',
      };
    }
    // Empty vault and no key yet: usable, a key is created on the first write.
    return { available: true, backend };
  }

  async get(id: string): Promise<Credentials> {
    assertValidId(id);
    const file = this.#filePath(id);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CredentialError('credential_not_found', `no credentials are stored for id "${id}"`);
      }
      throw new CredentialError('vault_unavailable', `failed to read credential file for id "${id}": ${describeError(error)}`, {
        cause: error,
      });
    }
    const record = this.#parseRecord(id, raw);
    const key = await this.#requireExistingKey();
    const nonce = Buffer.from(record.nonce, 'base64');
    const tag = Buffer.from(record.tag, 'base64');
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      throw new CredentialError('storage_corrupted', `credential file for id "${id}" has malformed nonce or auth tag`);
    }
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aadFor(id, record.schema, record.keyVersion));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
    } catch {
      throw new CredentialError(
        'decrypt_failed',
        `credentials for id "${id}" failed integrity verification; the file may be tampered with, copied from another id, or encrypted under a different master key`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new CredentialError('storage_corrupted', `decrypted payload for id "${id}" is not valid JSON`);
    }
    assertValidCredentials(value as Credentials);
    return value as Credentials;
  }

  async set(id: string, value: Credentials): Promise<void> {
    assertValidId(id);
    assertValidCredentials(value);
    const file = this.#filePath(id);
    const payload = JSON.stringify(value);
    // Cross-process lock so key creation (inside #obtainWriteKey) and the ciphertext write are one
    // atomic step: a second vault racing on the same directory re-reads the freshly minted key.
    await this.#withWriteLock(() => this.#withDirLock(async () => {
      const key = await this.#obtainWriteKey();
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aadFor(id, SCHEMA_VERSION, KEY_VERSION));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(payload, 'utf8')), cipher.final()]);
      const record: StoredRecord = {
        schema: SCHEMA_VERSION,
        keyVersion: KEY_VERSION,
        algorithm: 'aes-256-gcm',
        nonce: nonce.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        updatedAt: new Date().toISOString(),
      };
      await this.#writeAtomically(file, JSON.stringify(record, null, 2));
    }));
  }

  async remove(id: string): Promise<void> {
    assertValidId(id);
    // Under the same write lock as set/snapshot so a delete cannot interleave with a snapshot (which
    // would list the id, then fail to read it) or race a concurrent set on the same id.
    await this.#withWriteLock(() => this.#withDirLock(() => rm(this.#filePath(id), { force: true })));
  }

  async has(id: string): Promise<boolean> {
    assertValidId(id);
    try {
      await access(this.#filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Controller maintenance only. Lists IDs in this app's own vault, never secret values. */
  async listIds(): Promise<string[]> {
    return (await this.#listCredentialFiles()).map(file => file.slice(0, -FILE_SUFFIX.length))
      .filter(id => ID_PATTERN.test(id) && !id.includes('..'));
  }

  /** Portable backup encrypts these records directly into its output stream.
   * The caller must never persist this object or include it in API/log output. */
  async snapshotRecords(): Promise<Record<string, Credentials>> {
    // Held under the in-memory write lock (which set and remove also take) so the snapshot observes a
    // consistent set within this instance. Bounded by both a count cap and an explicit total-bytes cap
    // so a hostile or corrupt vault cannot force unbounded heap growth in this "bounded memory" path.
    return this.#withWriteLock(async () => {
      const records:Record<string,Credentials> = Object.create(null);
      const ids = await this.listIds();
      if (ids.length > 10_000) throw new CredentialError('storage_corrupted', '보관함 항목 수가 백업 한도를 넘습니다.');
      let total = 0;
      for (const id of ids) {
        const value = await this.get(id);
        total += Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (total > SNAPSHOT_MAX_BYTES) throw new CredentialError('storage_corrupted', '보관함 스냅숏 크기가 백업 한도를 넘습니다.');
        records[id] = value;
      }
      return records;
    });
  }

  #filePath(id: string): string {
    const file = join(this.#directory, `${id}${FILE_SUFFIX}`);
    if (!file.startsWith(this.#directory + sep)) {
      throw new CredentialError('invalid_id', 'credential id resolves outside the vault directory');
    }
    return file;
  }

  #parseRecord(id: string, raw: string): StoredRecord {
    let record: Partial<StoredRecord>;
    try {
      record = JSON.parse(raw) as Partial<StoredRecord>;
    } catch {
      throw new CredentialError('storage_corrupted', `credential file for id "${id}" is not valid JSON`);
    }
    if (
      typeof record !== 'object' || record === null ||
      typeof record.nonce !== 'string' || typeof record.ciphertext !== 'string' || typeof record.tag !== 'string'
    ) {
      throw new CredentialError('storage_corrupted', `credential file for id "${id}" is missing required fields`);
    }
    if (record.schema !== SCHEMA_VERSION || record.keyVersion !== KEY_VERSION || record.algorithm !== 'aes-256-gcm') {
      throw new CredentialError('storage_corrupted', `credential file for id "${id}" uses an unsupported schema, key version, or algorithm`);
    }
    return record as StoredRecord;
  }

  async #listCredentialFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.#directory);
      return entries.filter(entry => entry.endsWith(FILE_SUFFIX));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new CredentialError('vault_unavailable', `failed to list the vault directory: ${describeError(error)}`, { cause: error });
    }
  }

  async #requireExistingKey(): Promise<Buffer> {
    const key = await this.#keyProvider.getKey();
    if (key === undefined) {
      throw new CredentialError(
        'master_key_missing',
        'the master key is absent from the key store while encrypted credentials exist; restore the key instead of re-encrypting',
      );
    }
    if (key.length !== KEY_BYTES) {
      throw new CredentialError('storage_corrupted', 'stored master key has an unexpected length; refusing to use it');
    }
    return key;
  }

  async #obtainWriteKey(): Promise<Buffer> {
    const key = await this.#keyProvider.getKey();
    if (key !== undefined) {
      if (key.length !== KEY_BYTES) {
        throw new CredentialError('storage_corrupted', 'stored master key has an unexpected length; refusing to use it');
      }
      return key;
    }
    // Fail closed: a fresh key may only be created for an empty vault.
    // Generating a new key while ciphertext exists would silently orphan it.
    if ((await this.#listCredentialFiles()).length > 0) {
      throw new CredentialError(
        'master_key_missing',
        'refusing to create a new master key: encrypted credentials already exist for the previous key',
      );
    }
    const fresh = randomBytes(KEY_BYTES);
    await this.#keyProvider.setKey(fresh);
    return fresh;
  }

  async #writeAtomically(file: string, data: string): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#writeLock.then(task, task);
    this.#writeLock = run.catch(() => undefined);
    return run;
  }

  // Cross-process exclusive lock on the vault directory, always taken inside #withWriteLock so the
  // in-memory serialization avoids hammering the on-disk lock for same-instance writes.
  async #withDirLock<T>(task: () => Promise<T>): Promise<T> {
    const lock = await acquireDirLock(this.#directory);
    try { return await task(); }
    finally { await releaseDirLock(lock); }
  }
}
