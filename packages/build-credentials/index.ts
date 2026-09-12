import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import type { CredentialVault } from '../credentials/index.js';
import type { BuildCredential, Project, ProjectBuildSecurity, Run } from '../domain/index.js';
import { AppError, object, text } from '../domain/errors.js';
import type { Store } from '../storage/index.js';
import { javaTool, privateFile, runTrustedTool, secretWorkspace, sshEnvironment } from './tools.js';

export interface BuildKeyReference { id: string; version: number; fingerprint: string }
export interface BuildSecuritySelection {
  android?: BuildKeyReference;
  sshDependencies: { key: BuildKeyReference; repositoryUrl: string; revision: string; relativePath: string }[];
}
const vaultId = (id: string, version: number) => `build-key-${id}-v${version}`;
const at = () => new Date().toISOString();
const fail = (message: string): never => { throw new AppError('INVALID_BUILD_CREDENTIAL', message); };
function password(value: unknown, name: string, optional = false): string {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.length || value.length > 1024 || /[\r\n\0]/.test(value)) return fail(`${name}을 한 줄로 입력해 주세요.`);
  return value;
}
function credentialsInput(value: unknown): Record<string, string> {
  const input = object(value); const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.length > 1_500_000) return fail('키 입력은 허용된 크기의 문자열이어야 합니다.');
    result[key] = value;
  }
  return result;
}
export function validateSshLocation(credentials: Record<string, string>): { host: string; port: string; username: string } {
  const host = text(credentials.host, 'SSH 서버', 253).toLowerCase();
  if (!isIP(host) && (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..'))) return fail('SSH 서버 호스트 이름이 올바르지 않습니다.');
  const port = credentials.port || '22';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return fail('SSH 포트는 1~65535 사이여야 합니다.');
  const username = credentials.username || 'git';
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username)) return fail('SSH 사용자 이름이 올바르지 않습니다.');
  return { host, port: String(Number(port)), username };
}
export function validateDependency(input: unknown, credential: BuildCredential): ProjectBuildSecurity['sshDependencies'][number] {
  const data = object(input);
  const repositoryUrl = text(data.repositoryUrl, 'SSH 저장소 주소', 2048);
  let url: URL; try { url = new URL(repositoryUrl); } catch { return fail('저장소 주소는 ssh://git@서버/경로 형식이어야 합니다.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'ssh:' || url.password || url.search || url.hash || host !== credential.details.host ||
      (url.port || '22') !== credential.details.port || decodeURIComponent(url.username || 'git') !== credential.details.username ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(url.pathname) || url.pathname.includes('..') || url.pathname.includes('//')) {
    return fail('등록한 SSH 서버·사용자·포트와 같은 저장소 주소를 입력해 주세요.');
  }
  const revision = text(data.revision, '브랜치·태그', 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(revision) || revision.includes('..') || revision.endsWith('.lock') || revision.endsWith('/') || revision.includes('//')) return fail('브랜치·태그 이름이 올바르지 않습니다.');
  const relativePath = text(data.relativePath, '프로젝트 내 경로', 240);
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(relativePath) || relativePath.split('/').some(part => part === '..' || part === '.git' || part === '.')) return fail('의존성 경로는 프로젝트 안의 상대 폴더여야 합니다.');
  return { credentialId: credential.id, repositoryUrl, revision, relativePath };
}
interface ValidatedBuildCredential { credentials: Record<string, string>; fingerprint: string; publicKey?: string; details: Record<string, string> }
export function assertAndroidCertificate(certificate: X509Certificate): void {
  const start = Date.parse(certificate.validFrom); const end = Date.parse(certificate.validTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > Date.now()) return fail('서명 인증서의 유효 기간이 아직 시작되지 않았습니다.');
  if (end <= Date.now()) return fail('서명 인증서가 만료되었습니다.');
  if (end <= Date.parse('2033-10-22T23:59:59.999Z')) return fail('Google Play 배포용 서명 인증서는 2033년 10월 22일 이후까지 유효해야 합니다.');
}
export async function validateBuildCredential(kind: BuildCredential['kind'], raw: Record<string, string>, namespace: string): Promise<ValidatedBuildCredential> {
  return secretWorkspace(namespace, async (directory): Promise<ValidatedBuildCredential> => {
    if (kind === 'ssh') {
      const location = validateSshLocation(raw);
      const privateKey = text(raw.privateKey, 'SSH 개인 키', 1_048_576) + '\n';
      const passphrase = password(raw.passphrase, '키 암호', true);
      const knownHosts = text(raw.knownHosts, '고정한 SSH 서버 키', 1_048_576) + '\n';
      const keyFile = await privateFile(directory, 'identity', privateKey);
      const hostsFile = await privateFile(directory, 'known_hosts', knownHosts);
      const environment = await sshEnvironment(directory, { passphrase });
      const result = await runTrustedTool('/usr/bin/ssh-keygen', ['-y', '-f', keyFile], { cwd: directory, environment });
      const publicKey = result.stdout.trim().split(/\s+/).slice(0, 2).join(' ');
      const [algorithm, encoded] = publicKey.split(' ');
      if (!['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'].includes(algorithm!) || !encoded) return fail('지원하는 SSH 공개 키 형식이 아닙니다.');
      const pubFile = await privateFile(directory, 'public', publicKey + '\n');
      const bits = await runTrustedTool('/usr/bin/ssh-keygen', ['-l', '-f', pubFile], { cwd: directory });
      if (algorithm === 'ssh-rsa' && Number(bits.stdout.split(' ')[0]) < 2048) return fail('RSA SSH 키는 2048비트 이상이어야 합니다.');
      const pinned = await runTrustedTool('/usr/bin/ssh-keygen', ['-F', location.port === '22' ? location.host : `[${location.host}]:${location.port}`, '-f', hostsFile], { cwd: directory });
      const matched = await privateFile(directory, 'matched-hosts', pinned.stdout);
      await runTrustedTool('/usr/bin/ssh-keygen', ['-l', '-f', matched], { cwd: directory });
      const fingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/, '');
      return { credentials: { ...location, privateKey, passphrase, knownHosts }, fingerprint, publicKey, details: { ...location, algorithm } };
    }
    const encoded = text(raw.keystoreBase64, 'Android 키스토어', 1_500_000);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) return fail('키스토어 파일 인코딩이 올바르지 않습니다.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > 1_048_576 || bytes.toString('base64') !== encoded) return fail('키스토어 파일은 1 MiB 이하여야 합니다.');
    const storePassword = password(raw.storePassword, '키스토어 암호');
    const keyPassword = password(raw.keyPassword || storePassword, '개인 키 암호');
    const keyAlias = text(raw.keyAlias, '키 별칭', 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(keyAlias)) return fail('키 별칭은 영문·숫자·점·밑줄·하이픈을 사용해 주세요.');
    const file = await privateFile(directory, 'keystore', bytes);
    const storePass = await privateFile(directory, 'store-pass', storePassword);
    const keyPass = await privateFile(directory, 'key-pass', keyPassword);
    const keytool = await javaTool('keytool'); const signer = await javaTool('jarsigner');
    const exported = await runTrustedTool(keytool.executable, ['-exportcert', '-rfc', '-keystore', file, '-storepass:file', storePass, '-alias', keyAlias], { cwd: directory, environment: { JAVA_HOME: keytool.javaHome } });
    let certificate: X509Certificate; try { certificate = new X509Certificate(exported.stdout); } catch { return fail('서명 인증서를 확인할 수 없습니다.'); }
    assertAndroidCertificate(certificate);
    const testJar = await privateFile(directory, 'verify.jar', zipSync({ 'appops-verification.txt': Buffer.from('AppOps key possession check') }));
    await runTrustedTool(signer.executable, ['-keystore', file, '-storepass:file', storePass, '-keypass:file', keyPass, testJar, keyAlias], { cwd: directory, environment: { JAVA_HOME: signer.javaHome } });
    await runTrustedTool(signer.executable, ['-verify', '-strict', '-keystore', file, '-storepass:file', storePass, testJar, keyAlias], { cwd: directory, environment: { JAVA_HOME: signer.javaHome } });
    return { credentials: { keystoreBase64: encoded, storePassword, keyPassword, keyAlias }, fingerprint: certificate.fingerprint256,
      details: { keyAlias, expiresAt: new Date(certificate.validTo).toISOString(), algorithm: certificate.publicKey.asymmetricKeyType ?? 'unknown' } };
  });
}

export class BuildKeyManager {
  constructor(private readonly store: Store, private readonly vault: CredentialVault) {}
  list(): BuildCredential[] { return this.store.list<BuildCredential>('build-credential'); }
  get(id: string): BuildCredential {
    const key = this.store.get<BuildCredential>('build-credential', id);
    if (!key || key.details.deleting === 'true') throw new AppError('KEY_NOT_FOUND', '등록된 빌드 키를 찾을 수 없습니다.', 404);
    return key;
  }
  async save(input: unknown, id?: string): Promise<BuildCredential> {
    const data = object(input); const previous = id ? this.get(id) : undefined;
    const kind = previous?.kind ?? data.kind;
    if (kind !== 'ssh' && kind !== 'android-keystore') return fail('SSH 키 또는 Android 키스토어를 선택해 주세요.');
    const label = data.label === undefined && previous ? previous.label : text(data.label, '키 이름', 100);
    const credentials = { ...(previous ? await this.vault.get(vaultId(previous.id, previous.version)) : {}), ...credentialsInput(data.credentials) };
    const validated = await validateBuildCredential(kind, credentials, this.store.directory);
    const key: BuildCredential = { id: previous?.id ?? randomUUID(), kind, label, version: (previous?.version ?? 0) + 1,
      fingerprint: validated.fingerprint, publicKey: validated.publicKey, details: validated.details, createdAt: previous?.createdAt ?? at(), updatedAt: at() };
    // Persist the new encrypted version before publishing metadata. Old versions remain for captured jobs.
    try {
      await this.vault.set(vaultId(key.id, key.version), validated.credentials);
      this.store.writeBatch([{ kind: 'build-credential', id: key.id, value: key }], [], [{ kind: previous ? 'build-key.rotated' : 'build-key.registered', message: `${label} 빌드 키를 ${previous ? '교체' : '등록'}했습니다.`, data: { id: key.id, version: key.version, fingerprint: key.fingerprint } }]);
    } catch (error) {
      // A synchronous failure rolls back the unpublished version. Startup/deletion also
      // enumerate version IDs, covering process death or a failed compensation.
      await this.vault.remove(vaultId(key.id, key.version)).catch(() => {});
      throw error;
    }
    return key;
  }
  async remove(id: string): Promise<{ deleted: true }> {
    const key = this.store.get<BuildCredential>('build-credential', id);
    if (!key) throw new AppError('KEY_NOT_FOUND', '등록된 빌드 키를 찾을 수 없습니다.', 404);
    const bound = this.store.list<Project>('project').some(project => project.buildSecurity?.androidKeystoreId === id || project.buildSecurity?.sshDependencies.some(dependency => dependency.credentialId === id));
    const active = this.store.runs(100_000).some(run => run.kind === 'build' && ['queued', 'running', 'retry_wait', 'waiting_external', 'action_required'].includes(run.status) && this.runReferences(run).some(reference => reference.id === id));
    if (bound || active) throw new AppError('BUILD_KEY_IN_USE', '프로젝트 또는 진행 중인 빌드가 사용하는 키입니다. 프로젝트 연결을 해제하고 작업 종료 후 삭제해 주세요.', 409);
    this.store.put('build-credential', id, { ...key, details: { ...key.details, deleting: 'true' } });
    const ids = new Set((await this.vault.listIds()).filter(value => value.startsWith(`build-key-${id}-v`)));
    for (let version = 1; version <= key.version; version++) ids.add(vaultId(id, version));
    for (const value of ids) await this.vault.remove(value);
    this.store.writeBatch([], [{ kind: 'build-credential', id }], [{ kind: 'build-key.removed', message: key.label + ' 빌드 키와 보관된 이전 버전을 삭제했습니다.' }]);
    return { deleted: true };
  }
  policy(input: unknown): ProjectBuildSecurity {
    const data = object(input); const result: ProjectBuildSecurity = { sshDependencies: [] };
    if (data.androidKeystoreId) {
      const key = this.get(text(data.androidKeystoreId, 'Android 키 ID', 100));
      if (key.kind !== 'android-keystore') return fail('Android 서명에는 Android 키스토어를 선택해 주세요.');
      result.androidKeystoreId = key.id;
    }
    if (!Array.isArray(data.sshDependencies) || data.sshDependencies.length > 20) return fail('SSH 의존성은 20개 이하로 지정해 주세요.');
    for (const value of data.sshDependencies) {
      const key = this.get(text(object(value).credentialId, 'SSH 키 ID', 100));
      if (key.kind !== 'ssh') return fail('저장소 접근에는 SSH 키를 선택해 주세요.');
      const dependency = validateDependency(value, key);
      if (result.sshDependencies.some(item => item.relativePath === dependency.relativePath || item.relativePath.startsWith(dependency.relativePath + '/') || dependency.relativePath.startsWith(item.relativePath + '/'))) return fail('SSH 의존성 경로가 서로 겹칩니다.');
      result.sshDependencies.push(dependency);
    }
    return result;
  }
  capture(project: Project): BuildSecuritySelection {
    const reference = (id: string): BuildKeyReference => { const key = this.get(id); return { id, version: key.version, fingerprint: key.fingerprint }; };
    const policy = project.buildSecurity;
    return { ...(policy?.androidKeystoreId ? { android: reference(policy.androidKeystoreId) } : {}),
      sshDependencies: (policy?.sshDependencies ?? []).map(dependency => ({ key: reference(dependency.credentialId), repositoryUrl: dependency.repositoryUrl, revision: dependency.revision, relativePath: dependency.relativePath })) };
  }
  async credentials(reference: BuildKeyReference): Promise<Record<string, string>> {
    if (!/^[a-f0-9-]{36}$/.test(reference.id) || !Number.isSafeInteger(reference.version) || reference.version < 1) return fail('빌드 키 버전 참조가 올바르지 않습니다.');
    return this.vault.get(vaultId(reference.id, reference.version));
  }
  private runReferences(run: Run): BuildKeyReference[] {
    const selection = run.input.buildSecurity as BuildSecuritySelection | undefined;
    return [...(selection?.android ? [selection.android] : []), ...(selection?.sshDependencies ?? []).map(item => item.key)];
  }
  async cleanup(): Promise<void> {
    for (const id of await this.vault.listIds()) {
      const match = /^build-key-([a-f0-9-]{36})-v([1-9][0-9]*)$/.exec(id);
      if (!match) continue;
      const metadata = this.store.get<BuildCredential>('build-credential', match[1]!);
      if (!metadata || Number(match[2]) > metadata.version) await this.vault.remove(id);
    }
    for (const key of this.list()) if (key.details.deleting === 'true') await this.remove(key.id);
    if (process.platform !== 'linux') return;
    // A controller is single-owner. Remove only its exact namespace's abandoned tmpfs files on start.
    const prefix = 'appops-key-' + createHash('sha256').update(this.store.directory).digest('hex').slice(0, 12) + '-';
    for (const name of await readdir('/dev/shm')) {
      if (!name.startsWith(prefix)) continue;
      const path = join('/dev/shm', name); const info = await lstat(path);
      if (info.isDirectory() && info.uid === process.getuid?.()) await rm(path, { recursive: true, force: true });
    }
  }
}
