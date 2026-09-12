export type Credentials = Record<string, string>;

export interface KeyProvider {
  name: string;
  getKey(): Promise<Buffer | undefined>;
  setKey(key: Buffer): Promise<void>;
}

export interface VaultStatus {
  available: boolean;
  backend: string;
  reason?: string;
}
