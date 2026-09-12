import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { openFileNoFollow } from './paths.js';

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function sha256File(abs: string): Promise<string | null> {
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('SDK 대상 파일이 링크 또는 일반 파일이 아닙니다.');
    if (st.size > 8 * 1024 * 1024) throw new Error('SDK 대상 파일이 8 MiB 한도를 넘습니다.');
    const handle = await openFileNoFollow(abs, constants.O_RDONLY);
    try {
      const buf = await handle.readFile();
      return createHash('sha256').update(buf).digest('hex');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function combineHashes(entries: { path: string; hash: string | null }[]): string {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.hash ?? 'missing');
    hash.update('\n');
  }
  return hash.digest('hex');
}
