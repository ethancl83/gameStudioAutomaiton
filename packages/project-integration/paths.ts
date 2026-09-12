import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { integrationStorage } from './storage.js';

export class PathGuardError extends Error {
  constructor(message: string, public code = 'path.rejected') {
    super(message);
    this.name = 'PathGuardError';
  }
}

export function toPosix(value: string): string {
  return value.split(sep).join('/');
}

export function isInside(parentReal: string, childReal: string): boolean {
  if (parentReal === childReal) return true;
  const prefix = parentReal.endsWith(sep) ? parentReal : parentReal + sep;
  return childReal.startsWith(prefix);
}

export async function resolveProjectRoot(projectRoot: string): Promise<string> {
  const requested = resolve(projectRoot);
  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    throw new PathGuardError(`프로젝트 경로를 열 수 없습니다: ${requested}`, 'path.unreadable');
  }
  const st = await stat(real);
  if (!st.isDirectory()) throw new PathGuardError('프로젝트 경로는 디렉터리여야 합니다.', 'path.not_directory');
  return real;
}

function assertRelative(rel: string): string {
  const normalized = toPosix(rel);
  if (!normalized || normalized.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(normalized) || isAbsolute(normalized) || normalized.split('/').some((part) => part === '..' || part === '.' || part === '' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new PathGuardError(`허용되지 않은 상대 경로입니다: ${rel}`, 'path.escape');
  }
  return normalized;
}

export async function resolveSafeRelative(rootReal: string, rel: string): Promise<string> {
  const normalized = assertRelative(rel);
  const parts = normalized.split('/');
  let current = rootReal;
  for (let i = 0; i < parts.length; i += 1) {
    const next = join(current, parts[i]);
    let st;
    try {
      st = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const remainder = resolve(join(current, ...parts.slice(i)));
      if (!isInside(rootReal, remainder) && remainder !== rootReal) {
        throw new PathGuardError(`프로젝트 밖 경로입니다: ${rel}`, 'path.escape');
      }
      return remainder;
    }
    if (st.isSymbolicLink()) {
      throw new PathGuardError(`심볼릭 링크는 쓰지 않습니다: ${toPosix(join(...parts.slice(0, i + 1)))}`, 'path.symlink');
    }
    if (i < parts.length - 1) {
      if (!st.isDirectory()) throw new PathGuardError(`디렉터리가 아닙니다: ${rel}`, 'path.not_directory');
      const real = await realpath(next);
      if (!isInside(rootReal, real)) throw new PathGuardError(`프로젝트 밖 경로입니다: ${rel}`, 'path.escape');
      current = real;
    } else {
      current = next;
    }
  }
  return current;
}

export async function assertSafeRelative(rootReal: string, rel: string): Promise<string> {
  return resolveSafeRelative(rootReal, rel);
}

export async function ensureParent(abs: string, rootReal: string): Promise<void> {
  const parent = dirname(abs);
  if (!isInside(rootReal, parent) && parent !== rootReal) {
    throw new PathGuardError(`프로젝트 밖 경로입니다: ${parent}`, 'path.escape');
  }
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  if (!isInside(rootReal, parentReal) && parentReal !== rootReal) {
    throw new PathGuardError(`프로젝트 밖 경로입니다: ${relPath(rootReal, abs)}`, 'path.escape');
  }
}

function relPath(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}

export async function openFileNoFollow(abs: string, flags: number): Promise<Awaited<ReturnType<typeof open>>> {
  return open(abs, flags | constants.O_NOFOLLOW);
}

export async function readTextNoFollow(abs: string): Promise<string> {
  const handle = await openFileNoFollow(abs, constants.O_RDONLY);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function writeTextAtomic(abs: string, content: string, rootReal?: string): Promise<void> {
  const dir = dirname(abs);
  if (rootReal) await assertSafeRelative(rootReal, relative(rootReal,abs));
  await mkdir(dir, { recursive: true });
  if (rootReal) {
    const dirReal = await realpath(dir);
    if (!isInside(rootReal, dirReal) && dirReal !== rootReal) {
      throw new PathGuardError(`프로젝트 밖 경로입니다: ${abs}`, 'path.escape');
    }
  }
  const tmp = join(dir, `.appops-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const { rename } = await import('node:fs/promises');
  try {
    if (rootReal) await assertSafeRelative(rootReal, relative(rootReal,abs));
    await rename(tmp, abs);
  } finally { await import('node:fs/promises').then(fs=>fs.rm(tmp,{force:true})); }
}

export function integrationHome(rootReal: string): string {
  return integrationStorage(rootReal);
}

export function relativeFrom(rootReal: string, abs: string): string {
  return toPosix(relative(rootReal, abs));
}
