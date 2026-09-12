import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CredentialError } from './errors.js';
import { KeyringKeyProvider } from './key-provider.js';
import type { KeyProvider } from './types.js';

const SLOT_FILE = 'key-slot.json';
const SLOT = /^vault-[a-f0-9-]{36}$/;

// Make a freshly published directory entry durable. Directory fsync is unsupported on some
// platforms; treat those as best-effort rather than failing the write.
async function fsyncDir(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, constants.O_RDONLY); } catch { return; }
  try { await handle.sync(); } catch { /* platform rejects directory fsync */ } finally { await handle.close(); }
}

/** Each new vault owns a separate OS-keyring slot. A restored vault can be staged
 * without replacing the live key; legacy vaults retain their original slot. The slot is
 * created only on the first write, so a read-only status probe never materializes one. */
export class DirectoryKeyProvider implements KeyProvider {
  readonly name = 'os-keyring';
  private selected?: Promise<KeyProvider>;
  constructor(private readonly directory: string,
    private readonly factory: (account?: string) => KeyProvider = account => new KeyringKeyProvider({account})) {}

  private async readSlot(): Promise<string | undefined> {
    let file;
    try { file = await open(join(this.directory, SLOT_FILE), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      if (!(await file.stat()).isFile() || (await file.stat()).size > 1024) throw new Error('invalid slot');
      const value = JSON.parse(await file.readFile('utf8')) as {schema?:number;account?:string};
      if (value.schema !== 1 || typeof value.account !== 'string' || !SLOT.test(value.account)) throw new Error('invalid slot');
      return value.account;
    } finally { await file.close(); }
  }

  /** Read-only resolution: the provider for an existing slot or a legacy directory, or undefined
   * for an empty directory. Never creates a directory or a slot file. */
  private async resolveExisting(): Promise<KeyProvider | undefined> {
    const existing = await this.readSlot();
    if (existing) return this.factory(existing);
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    // Legacy upgrade: ciphertext present but no slot yet → the shared default keyring account.
    if (names.some(name => name.endsWith('.cred.json'))) return this.factory();
    return undefined;
  }

  /** Create-or-select, used on the first write. Publishes a complete slot record durably (file sync
   * plus parent-directory sync) without overwriting a concurrently created slot. */
  private resolveForWrite(): Promise<KeyProvider> {
    if (!this.selected) this.selected = (async () => {
      try {
        const existing = await this.resolveExisting();
        if (existing) return existing;
        await mkdir(this.directory, {recursive:true, mode:0o700});
        const afterMkdir = await this.resolveExisting();
        if (afterMkdir) return afterMkdir;
        const account = 'vault-' + randomUUID();
        const temporary = join(this.directory, '.' + randomUUID() + '.slot');
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify({schema:1,account})); await file.sync(); }
        finally { await file.close(); }
        try {
          // Publish a complete record without overwriting a concurrently created slot, then fsync the
          // parent so the directory entry survives a crash.
          try { await link(temporary, join(this.directory, SLOT_FILE)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          await fsyncDir(this.directory);
        } finally { await rm(temporary, {force:true}); }
        const selected = await this.readSlot();
        if (!selected) throw new Error('missing slot');
        return this.factory(selected);
      } catch (cause) {
        this.selected = undefined;
        throw new CredentialError('storage_corrupted', '보관함의 암호화 키 위치를 확인할 수 없습니다.', {cause});
      }
    })();
    return this.selected;
  }

  async getKey(): Promise<Buffer | undefined> {
    if (this.selected) return (await this.selected).getKey();
    let existing: KeyProvider | undefined;
    try { existing = await this.resolveExisting(); }
    catch (cause) { throw new CredentialError('storage_corrupted', '보관함의 암호화 키 위치를 확인할 수 없습니다.', {cause}); }
    if (existing) { this.selected = Promise.resolve(existing); return existing.getKey(); }
    return undefined; // empty directory: a slot is allocated on the first setKey, not on a read
  }
  async setKey(key:Buffer):Promise<void> { await (await this.resolveForWrite()).setKey(key); }
}
