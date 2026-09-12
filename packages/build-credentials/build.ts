import { createHash, X509Certificate } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createSnapshot } from '../../apps/runner/index.js';
import { AppError, canonical } from '../domain/errors.js';
import type { BuildKeyManager, BuildKeyReference, BuildSecuritySelection } from './index.js';
import { assertAndroidCertificate } from './index.js';
import { javaTool, privateFile, runTrustedTool, secretWorkspace, sshEnvironment } from './tools.js';

export async function prepareSshDependencies(manager: BuildKeyManager, selection: BuildSecuritySelection, snapshot: string,
  workDirectory: string, namespace: string, signal: AbortSignal): Promise<{ path: string; commit: string; hash: string; key: BuildKeyReference }[]> {
  const records: { path: string; commit: string; hash: string; key: BuildKeyReference }[] = [];
  for (const [index, dependency] of selection.sshDependencies.entries()) {
    signal.throwIfAborted();
    const destination = resolve(snapshot, dependency.relativePath);
    if (!destination.startsWith(resolve(snapshot) + sep)) throw new AppError('DEPENDENCY_PATH_ESCAPE', 'SSH 의존성 경로가 프로젝트 밖을 가리킵니다.');
    // Dependencies are inserted into new directories. Existing project files are never overwritten.
    try { await lstat(destination); throw new AppError('DEPENDENCY_PATH_EXISTS', `의존성 경로 ${dependency.relativePath}가 이미 존재합니다. 새 경로를 지정해 주세요.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const checkout = join(workDirectory, 'checkout-' + index);
    await rm(checkout, { recursive: true, force: true }); await mkdir(checkout, { recursive: true, mode: 0o700 });
    const credentials = await manager.credentials(dependency.key);
    let commit = '';
    try {
      await secretWorkspace(namespace, async directory => {
        const identity = await privateFile(directory, 'identity', credentials.privateKey!);
        const hosts = await privateFile(directory, 'known_hosts', credentials.knownHosts!);
        const environment = { ...(await sshEnvironment(directory, credentials)), APPOPS_IDENTITY_FILE: identity, APPOPS_KNOWN_HOSTS_FILE: hosts,
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
          GIT_SSH: '/tmp/appops-ssh', GIT_SSH_VARIANT: 'ssh' };
        const scripts = { '/tmp/appops-ssh': '#!/bin/sh\nexec /usr/bin/ssh -F /dev/null -i "$APPOPS_IDENTITY_FILE" -o "UserKnownHostsFile=$APPOPS_KNOWN_HOSTS_FILE" -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o ForwardAgent=no -o ProxyCommand=none -o ProxyJump=none -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=20 "$@"\n' };
        await runTrustedTool('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', '-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always',
          'clone', '--depth=1', '--single-branch', '--no-tags', '--no-recurse-submodules', '--branch', dependency.revision, '--', dependency.repositoryUrl, checkout],
        { cwd: checkout, writeRoots: [checkout], readRoots: [directory], network: true, environment, scripts, signal });
        const revision = await runTrustedTool('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', 'HEAD'], { cwd: checkout, writeRoots: [checkout], signal,
          environment: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
        commit = revision.stdout.trim();
        if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new AppError('DEPENDENCY_REVISION_INVALID', '가져온 저장소의 커밋을 확인할 수 없습니다.');
      });
      const dependencySnapshot = await createSnapshot(checkout, destination);
      records.push({ path: dependency.relativePath, commit, hash: dependencySnapshot.hash, key: dependency.key });
    } finally { await rm(checkout, { recursive: true, force: true }); }
  }
  return records;
}
export function buildInputHash(sourceHash: string, dependencies: unknown[]): string {
  return dependencies.length ? createHash('sha256').update(canonical({ sourceHash, dependencies })).digest('hex') : sourceHash;
}
async function androidBuildTools(): Promise<string> {
  const roots = [process.env.APPOPS_ANDROID_SDK_ROOT, process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME].filter(Boolean) as string[];
  for (const root of roots) {
    const base = join(root, 'build-tools');
    try {
      const versions = (await readdir(base)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        const directory = await realpath(join(base, version));
        try { await lstat(join(directory, 'apksigner')); await lstat(join(directory, 'zipalign')); return directory; } catch {}
      }
    } catch {}
  }
  throw new AppError('SIGNING_TOOL_REQUIRED', 'APK 서명에는 Android SDK build-tools의 zipalign과 apksigner가 필요합니다. Android SDK 경로를 설정해 주세요.');
}
export async function signAndroidArtifact(manager: BuildKeyManager, reference: BuildKeyReference, artifact: string,
  namespace: string, signal: AbortSignal): Promise<{ fingerprint: string; keyId: string; version: number; format: string }> {
  const format = extname(artifact).toLowerCase();
  if (!['.aab', '.apk'].includes(format)) throw new AppError('SIGNING_FORMAT_UNSUPPORTED', 'Android 키로 서명할 AAB/APK 결과물이 필요합니다.');
  const info = await lstat(artifact);
  if (!info.isFile() || info.isSymbolicLink()) throw new AppError('ARTIFACT_ESCAPE', '서명할 결과물은 일반 파일이어야 합니다.');
  const credentials = await manager.credentials(reference);
  const signed = artifact + '.signed'; const aligned = artifact + '.aligned';
  await rm(signed, { force: true }); await rm(aligned, { force: true });
  try {
    await secretWorkspace(namespace, async directory => {
      const file = await privateFile(directory, 'keystore', Buffer.from(credentials.keystoreBase64!, 'base64'));
      const storePass = await privateFile(directory, 'store-pass', credentials.storePassword!);
      const keyPass = await privateFile(directory, 'key-pass', credentials.keyPassword!);
      const jdk = await javaTool('jarsigner');
      const environment = { JAVA_HOME: jdk.javaHome };
      const options = { cwd: dirname(artifact), readRoots: [directory], writeRoots: [dirname(artifact)], environment, signal };
      const keytool = await javaTool('keytool');
      const exported = await runTrustedTool(keytool.executable, ['-exportcert', '-rfc', '-keystore', file, '-storepass:file', storePass, '-alias', credentials.keyAlias!], { ...options, environment: { JAVA_HOME: keytool.javaHome } });
      const certificate = new X509Certificate(exported.stdout); assertAndroidCertificate(certificate);
      if (certificate.fingerprint256 !== reference.fingerprint) throw new AppError('SIGNATURE_MISMATCH', '캡처한 서명 키 지문이 일치하지 않습니다.');
      if (format === '.aab') {
        await runTrustedTool(jdk.executable, ['-keystore', file, '-storepass:file', storePass, '-keypass:file', keyPass, '-signedjar', signed, artifact, credentials.keyAlias!], options);
        const verified = await runTrustedTool(jdk.executable, ['-J-Duser.language=en', '-J-Duser.country=US', '-verify', '-strict', '-keystore', file, '-storepass:file', storePass, signed, credentials.keyAlias!], options);
        if (!/jar verified\./i.test(verified.stdout)) throw new AppError('SIGNATURE_INVALID', 'AAB 서명을 확인할 수 없습니다.');
        const result = await runTrustedTool(keytool.executable, ['-printcert', '-rfc', '-jarfile', signed], { ...options, environment: { JAVA_HOME: keytool.javaHome } });
        const certificates = result.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
        if (!certificates.length || certificates.some(cert => new X509Certificate(cert).fingerprint256 !== reference.fingerprint)) throw new AppError('SIGNATURE_MISMATCH', '선택한 키와 다른 서명이 결과물에 포함되어 있습니다. 서명하지 않은 빌드 결과물로 다시 실행해 주세요.');
      } else {
        const tools = await androidBuildTools();
        await runTrustedTool(join(tools, 'zipalign'), ['-f', '-p', '4', artifact, aligned], { ...options, readRoots: [directory, tools] });
        await runTrustedTool(join(tools, 'apksigner'), ['sign', '--ks', file, '--ks-key-alias', credentials.keyAlias!, '--ks-pass', 'file:' + storePass, '--key-pass', 'file:' + keyPass, '--out', signed, aligned], { ...options, readRoots: [directory, tools] });
        const verified = await runTrustedTool(join(tools, 'apksigner'), ['verify', '--print-certs', signed], { ...options, readRoots: [directory, tools] });
        const digests = [...verified.stdout.matchAll(/certificate SHA-256 digest:\s*([a-f0-9]+)/gi)].map(match => match[1]!.toUpperCase());
        if (!digests.length || digests.some(digest => digest !== reference.fingerprint.replace(/:/g, '').toUpperCase())) throw new AppError('SIGNATURE_MISMATCH', 'APK 서명 인증서가 선택한 키와 일치하지 않습니다.');
      }
    });
    signal.throwIfAborted();
    await rename(signed, artifact);
    return { fingerprint: reference.fingerprint, keyId: reference.id, version: reference.version, format: format.slice(1) };
  } finally { await rm(signed, { force: true }); await rm(aligned, { force: true }); }
}
