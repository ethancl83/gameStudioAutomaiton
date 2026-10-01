import { basename } from 'node:path';

const SECRET_NAMES = new Set([
  '.env',
  '.git',
  '.npmrc',
  '.netrc',
  '_netrc',
  '.pypirc',
  'gradle.properties',
  'keystore.properties',
  'key.properties',
  'controller.json',
  'dev-session.json',
  'operations.sqlite',
  'operations.sqlite-wal',
  'operations.sqlite-shm',
  'credentials.json',
  'service-account.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'secrets.json',
]);

const SECRET_EXTENSIONS = new Set([
  '.pem',
  '.p12',
  '.pfx',
  '.key',
  '.keystore',
  '.jks',
  '.mobileprovision',
  '.p8',
  '.snk',
]);

export function isSecretFile(relativePosix: string): boolean {
  const name = basename(relativePosix);
  const lower = name.toLowerCase();
  if (SECRET_NAMES.has(lower) || SECRET_NAMES.has(name)) return true;
  if (lower.startsWith('.env.')) return true;
  if (/^authkey_.+\.p8$/i.test(name)) return true;
  if (/service-account/i.test(name) && lower.endsWith('.json')) return true;
  const dot = lower.lastIndexOf('.');
  if (dot >= 0 && SECRET_EXTENSIONS.has(lower.slice(dot))) return true;
  return false;
}
