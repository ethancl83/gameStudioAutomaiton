import { CredentialError, describeError } from './errors.js';
import type { KeyProvider } from './types.js';

// Namespace owned by this application. The vault only ever touches this one
// service/account pair and never enumerates or reads other keyring entries.
const DEFAULT_SERVICE = 'app-operations-platform';
const DEFAULT_ACCOUNT = 'credential-vault-master-key';

export interface AsyncEntryLike {
  // The published .d.ts declares `Uint8Array | undefined`, but the native
  // binding resolves `null` for an absent entry; both must count as absent.
  getSecret(): Promise<Uint8Array | undefined | null>;
  setSecret(secret: Uint8Array): Promise<void>;
}

export class KeyringKeyProvider implements KeyProvider {
  readonly name = 'os-keyring';
  readonly #service: string;
  readonly #account: string;
  #entry: AsyncEntryLike | undefined;

  constructor(options?: { service?: string; account?: string; entry?: AsyncEntryLike }) {
    this.#service = options?.service ?? DEFAULT_SERVICE;
    this.#account = options?.account ?? DEFAULT_ACCOUNT;
    this.#entry = options?.entry;
  }

  // The native module is loaded lazily so that vaults constructed with an
  // injected KeyProvider (tests, headless environments) never touch it.
  async #resolveEntry(): Promise<AsyncEntryLike> {
    if (!this.#entry) {
      try {
        const { AsyncEntry } = await import('@napi-rs/keyring');
        this.#entry = new AsyncEntry(this.#service, this.#account);
      } catch (error) {
        throw new CredentialError(
          'vault_unavailable',
          `OS keyring backend could not be loaded: ${describeError(error)}`,
          { cause: error },
        );
      }
    }
    return this.#entry;
  }

  async getKey(): Promise<Buffer | undefined> {
    const entry = await this.#resolveEntry();
    try {
      // AsyncEntry.getSecret resolves empty (null/undefined) when no secret
      // exists and rejects when the store is locked or unreachable, which
      // lets us keep "absent" and "locked" as distinct states.
      const secret = await entry.getSecret();
      return secret == null ? undefined : Buffer.from(secret);
    } catch (error) {
      throw new CredentialError(
        'vault_locked',
        `OS keyring is locked or unreachable: ${describeError(error)}`,
        { retryable: true, cause: error },
      );
    }
  }

  async setKey(key: Buffer): Promise<void> {
    const entry = await this.#resolveEntry();
    try {
      await entry.setSecret(new Uint8Array(key));
    } catch (error) {
      throw new CredentialError(
        'vault_locked',
        `OS keyring rejected the master key write; the store may be locked or unreachable: ${describeError(error)}`,
        { retryable: true, cause: error },
      );
    }
  }
}
