import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, renameSync, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { AppError } from '../domain/errors.js';
import type { BuildCredential } from '../domain/index.js';
import { normalizeBuildCredential, validateDependency, type BuildKeyManager, type BuildKeyReference, type BuildSecuritySelection } from './index.js';
import { runDockerKeyHelper } from './docker-runtime.js';
import type { CredentialMetadata, DependencyMetadata, SignatureMetadata } from './docker-protocol.js';

const signing = new Set<string>();
function abort(signal: AbortSignal): void { if (signal.aborted) throw new AppError('CANCELLED', '키 사용 작업을 취소했습니다.'); }
function artifactError(): never { throw new AppError('ARTIFACT_ESCAPE', '서명할 결과물 또는 임시 파일의 경로·소유권이 변경되었습니다.'); }
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function regular(info: Stats): void { if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) artifactError(); }
async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  return hash.digest('hex');
}
export async function validateDockerBuildCredential(kind: BuildCredential['kind'], raw: Record<string, string>): Promise<CredentialMetadata & { credentials: Record<string, string> }> {
  const credentials = normalizeBuildCredential(kind, raw);
  const metadata = await runDockerKeyHelper({ operation: 'validate', kind, credentials }) as CredentialMetadata;
  return { credentials, fingerprint: metadata.fingerprint, publicKey: metadata.publicKey, details: metadata.details };
}

export async function signDockerAndroidArtifact(manager: Pick<BuildKeyManager, 'credentials'>, reference: BuildKeyReference,
  artifact: string, signal: AbortSignal): Promise<SignatureMetadata> {
  abort(signal);
  const format = extname(artifact).toLowerCase();
  if (format !== '.aab' && format !== '.apk') throw new AppError('SIGNING_FORMAT_UNSUPPORTED', 'Android 키로 서명할 AAB/APK 결과물이 필요합니다.');
  const parent = await realpath(dirname(artifact)); const original = join(parent, basename(artifact));
  if (signing.has(original)) throw new AppError('ARTIFACT_IN_USE', '이 결과물은 이미 서명 중입니다.');
  signing.add(original);
  let staging: string | undefined; let source: FileHandle | undefined; let committed = false;
  try {
    const parentInfo = await lstat(parent);
    regular(await lstat(original));
    try { source = await open(original, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') artifactError(); throw error; }
    const sourceInfo = await source.stat(); regular(sourceInfo);
    if (!sameFile(sourceInfo, await lstat(original))) artifactError();
    staging = await mkdtemp(join(parent, '.appops-sign-')); await chmod(staging, 0o700);
    const stageInfo = await lstat(staging);
    if (stageInfo.dev !== sourceInfo.dev || stageInfo.uid !== process.getuid?.()) artifactError();
    const staged = join(staging, 'artifact' + format);
    const output = await open(staged, 'wx', 0o600); const hash = createHash('sha256');
    try {
      for await (const chunk of source.createReadStream({ autoClose: false, start: 0 })) { hash.update(chunk); await output.write(chunk); }
      regular(await output.stat()); await output.sync();
    } finally { await output.close(); }
    const originalHash = hash.digest('hex');
    const credentials = normalizeBuildCredential('android-keystore', await manager.credentials(reference));
    const result = await runDockerKeyHelper({ operation: 'sign', reference, format: format.slice(1) as 'aab' | 'apk', credentials },
      { mounts: [{ source: staging, target: '/work/sign' }], signal }) as SignatureMetadata;
    // The helper verified the signature and was removed before this host-side commit check.
    const final = await open(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { regular(await final.stat()); await final.sync(); } finally { await final.close(); }
    if (await hashFile(source) !== originalHash) artifactError();
    await source.close(); source = undefined;
    const currentParent = lstatSync(parent); const currentOriginal = lstatSync(original); const currentStage = lstatSync(staged);
    regular(currentOriginal); regular(currentStage);
    if (!sameFile(sourceInfo, currentOriginal) || currentParent.dev !== parentInfo.dev || currentParent.ino !== parentInfo.ino ||
      realpathSync(dirname(artifact)) !== parent || realpathSync(staged) !== staged || currentStage.dev !== sourceInfo.dev || currentStage.uid !== process.getuid?.()) artifactError();
    // No await in the commit interval. A later abort cannot undo or relabel this successful rename.
    abort(signal); renameSync(staged, original); committed = true;
    return result;
  } finally {
    signing.delete(original);
    try { await source?.close(); } finally {
      if (staging) {
        try { await rm(staging, { recursive: true, force: true }); }
        catch { throw new AppError(committed ? 'SIGNING_COMMITTED_CLEANUP_FAILED' : 'KEY_STAGING_CLEANUP_FAILED',
          committed ? '서명은 완료했지만 임시 폴더를 정리하지 못했습니다.' : '서명 임시 폴더를 정리하지 못했습니다.'); }
      }
    }
  }
}

async function dependencyHash(root: string): Promise<string> {
  const entries: { path: string; hash: string; size: number; executable: boolean }[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name); const relative = prefix ? prefix + '/' + name : name;
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new AppError('DEPENDENCY_PATH_ESCAPE', '의존성 결과물에 링크나 특수 파일이 있습니다.');
      if (info.isDirectory()) await walk(path, relative);
      else if (relative !== '.appops-manifest.json') {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { entries.push({ path: relative, hash: await hashFile(file), size: info.size, executable: (info.mode & 0o111) !== 0 }); } finally { await file.close(); }
      }
    }
  }
  await walk(root, ''); entries.sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256').update(entries.map(entry => `${entry.path}\t${entry.hash}\t${entry.size}\t${entry.executable ? 'x' : '-'}`).join('\n')).digest('hex');
}
async function dependencyDestination(snapshot: string, relative: string): Promise<string> {
  const destination = resolve(snapshot, relative);
  if (!destination.startsWith(snapshot + sep)) throw new AppError('DEPENDENCY_PATH_ESCAPE', 'SSH 의존성 경로가 프로젝트 밖을 가리킵니다.');
  let parent = snapshot;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = join(parent, part);
    try { await mkdir(parent, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) throw new AppError('DEPENDENCY_PATH_ESCAPE', 'SSH 의존성 부모 경로가 변경되었습니다.');
  }
  try { await lstat(destination); throw new AppError('DEPENDENCY_PATH_EXISTS', 'SSH 의존성 경로가 이미 존재합니다.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return destination;
}
export async function prepareDockerSshDependencies(manager: Pick<BuildKeyManager, 'credentials'>, selection: BuildSecuritySelection,
  snapshot: string, signal: AbortSignal): Promise<DependencyMetadata[]> {
  const results: DependencyMetadata[] = [];
  const snapshotRoot = await realpath(snapshot); const snapshotInfo = await lstat(snapshotRoot);
  for (const dependency of selection.sshDependencies) {
    abort(signal);
    const credentials = normalizeBuildCredential('ssh', await manager.credentials(dependency.key));
    validateDependency(dependency, { id: dependency.key.id, details: credentials } as BuildCredential);
    await dependencyDestination(snapshotRoot, dependency.relativePath);
    const staging = await mkdtemp(join(dirname(snapshotRoot), '.appops-fetch-')); await chmod(staging, 0o700);
    try {
      const output = join(staging, 'snapshot'); const checkout = join(staging, 'checkout');
      await mkdir(output, { mode: 0o700 }); await mkdir(checkout, { mode: 0o700 });
      const result = await runDockerKeyHelper({ operation: 'fetch', dependency, credentials }, { signal,
        mounts: [{ source: output, target: '/work/snapshot' }, { source: checkout, target: '/work/checkout' }] }) as DependencyMetadata;
      const fetched = join(output, dependency.relativePath);
      if (await realpath(fetched) !== fetched || !(await lstat(fetched)).isDirectory() || await dependencyHash(fetched) !== result.hash) {
        throw new AppError('DEPENDENCY_REVISION_INVALID', '가져온 의존성의 파일 해시를 확인할 수 없습니다.');
      }
      const destination = await dependencyDestination(snapshotRoot, dependency.relativePath);
      const current = lstatSync(snapshotRoot);
      if (current.dev !== snapshotInfo.dev || current.ino !== snapshotInfo.ino || realpathSync(dirname(destination)) !== dirname(destination)) {
        throw new AppError('DEPENDENCY_PATH_ESCAPE', 'SSH 의존성 스냅샷 경로가 변경되었습니다.');
      }
      abort(signal); renameSync(fetched, destination);
      results.push(result);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  return results;
}
