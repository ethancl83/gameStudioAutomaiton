import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Snapshot } from '../../packages/domain/index.js';
import { isExcludedDirectory, isGitPath, toPosix } from './excludes.js';
import { isSecretFile } from './secrets.js';

interface ManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
  executable: boolean;
}

export interface SnapshotOptions {
  /** Extra real paths never traversed (e.g. controller data dir under source). */
  excludedRoots?: string[];
}

function isInside(parentReal: string, childReal: string): boolean {
  if (parentReal === childReal) return true;
  const prefix = parentReal.endsWith(sep) ? parentReal : parentReal + sep;
  return childReal.startsWith(prefix);
}

async function listEntries(dir: string): Promise<string[]> {
  return readdir(dir);
}

export async function createSnapshot(
  sourcePath: string,
  destination: string,
  options?: SnapshotOptions,
): Promise<Snapshot> {
  let sourceReal: string;
  try {
    sourceReal = await realpath(resolve(sourcePath));
  } catch {
    throw new Error(`스냅샷 원본 경로를 열 수 없습니다: ${sourcePath}`);
  }
  const destResolved = resolve(destination);
  if (destResolved === sourceReal) {
    throw new Error('스냅샷 대상 경로가 원본과 같습니다.');
  }
  await mkdir(destResolved, { recursive: true });
  const destReal = await realpath(destResolved);
  if (destReal === sourceReal) {
    throw new Error('스냅샷 대상 경로가 원본과 같습니다.');
  }
  // Second boundary: real paths the caller forbids (controller data dir that
  // may live under the source, e.g. a symlinked data directory). Resolved to
  // real paths so an alias under the source cannot slip through.
  const excludedReal: string[] = [];
  for (const extra of options?.excludedRoots ?? []) {
    try {
      excludedReal.push(await realpath(resolve(extra)));
    } catch {
      excludedReal.push(resolve(extra));
    }
  }
  const isExcludedReal = (real: string): boolean =>
    isInside(destReal, real) || excludedReal.some((root) => isInside(root, real));

  const createdAt = new Date().toISOString();
  const entries: ManifestEntry[] = [];

  async function walk(current: string): Promise<void> {
    let currentReal: string;
    try {
      currentReal = await realpath(current);
    } catch {
      return;
    }
    if (isExcludedReal(currentReal)) return;
    if (!isInside(sourceReal, currentReal) && currentReal !== sourceReal) return;

    let names: string[];
    try {
      names = await listEntries(current);
    } catch (error) {
      // An unreadable directory is a real gap: fail rather than silently
      // producing an incomplete-but-"successful" snapshot.
      throw new Error(`스냅샷 대상 디렉터리를 읽을 수 없습니다: ${current} (${(error as Error).message})`);
    }
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const abs = join(current, name);
      let st;
      try {
        st = await lstat(abs);
      } catch (error) {
        throw new Error(`스냅샷 항목 정보를 읽을 수 없습니다: ${abs} (${(error as Error).message})`);
      }
      const rel = toPosix(relative(sourceReal, abs));
      if (!rel || rel.startsWith('..') || rel.includes('\0')) continue;

      if (st.isSymbolicLink()) {
        continue;
      }
      // Exclude Git metadata whether directory or gitlink file, at any depth.
      if (isGitPath(rel)) continue;
      if (st.isDirectory()) {
        if (isExcludedDirectory(rel)) continue;
        let innerReal: string;
        try {
          innerReal = await realpath(abs);
        } catch {
          continue;
        }
        if (isExcludedReal(innerReal)) continue;
        // The directory must still be the same non-symlink object we lstat'd:
        // a symlinked directory is already skipped above, and realpath staying
        // inside source guards against a swapped parent.
        if (!isInside(sourceReal, innerReal)) continue;
        await walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (isSecretFile(rel)) continue;

      await copyAndHash(abs, rel);
    }
  }

  async function copyAndHash(abs: string, rel: string): Promise<void> {
    const destFile = join(destReal, rel);
    await mkdir(dirname(destFile), { recursive: true });
    // Open with O_NOFOLLOW so a symlink swapped in between lstat and copy is
    // refused rather than followed out of the source tree (TOCTOU guard).
    let handle;
    try {
      // O_NOFOLLOW: if the leaf was swapped to a symlink after lstat, open
      // fails (ELOOP) instead of following it outside the source tree.
      handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') return; // became a symlink mid-walk: skip, do not follow
      throw new Error(`스냅샷 파일을 열 수 없습니다: ${abs} (${(error as Error).message})`);
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) return;
      const hash = createHash('sha256');
      let bytes = 0;
      const stream = handle.createReadStream({ autoClose: false });
      const executable = (st.mode & 0o111) !== 0;
      const out = await open(destFile, 'wx', executable ? 0o700 : 0o600);
      try {
        for await (const chunk of stream) {
          hash.update(chunk);
          bytes += chunk.length;
          await out.write(chunk);
        }
      } finally {
        await out.close();
      }
      entries.push({ path: rel, sha256: hash.digest('hex'), bytes, executable });
    } catch (error) {
      throw new Error(`스냅샷 파일을 복사할 수 없습니다: ${abs} (${(error as Error).message})`);
    } finally {
      await handle.close();
    }
  }

  await walk(sourceReal);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifestBody = entries.map((e) => `${e.path}\t${e.sha256}\t${e.bytes}\t${e.executable ? 'x' : '-'}`).join('\n');
  const hash = createHash('sha256').update(manifestBody, 'utf8').digest('hex');
  const fileCount = entries.length;
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  await writeFile(join(destReal, '.appops-manifest.json'), `${JSON.stringify({ hash, fileCount, totalBytes, files: entries }, null, 2)}\n`, 'utf8');

  return { path: destReal, hash, fileCount, totalBytes, createdAt };
}
