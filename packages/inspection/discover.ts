import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../domain/errors.js';
import { detectEngine } from './detect.js';

const SKIP = new Set(['node_modules', 'vendor', 'build', 'dist', 'Library', 'Temp', 'obj', 'bin', 'Pods', 'tmp', 'temp', 'coverage']);

/** Stop at engine roots so exported Gradle/Xcode projects never become extra candidates. */
export async function resolveProjectRoot(directory: string): Promise<string> {
  const root = await realpath(directory).catch(() => directory);
  if ((await detectEngine(root)).engine !== 'unknown') return root;
  const candidates: string[] = [];
  const queue = [{ path: root, depth: 0 }];
  let inspected = 0;
  let incomplete = false;
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); }
    catch { incomplete = true; continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      if (current.depth >= 6 || ++inspected > 2000) { incomplete = true; continue; }
      const path = join(current.path, entry.name);
      const detection = await detectEngine(path);
      if (detection.engine !== 'unknown') {
        if (detection.markers.some(marker => marker.primary)) candidates.push(path);
      } else queue.push({ path, depth: current.depth + 1 });
    }
    if (inspected > 2000) break;
  }
  if (candidates.length > 1) throw new AppError('PROJECT_SELECTION_REQUIRED', `하위 폴더에 프로젝트가 여러 개 있습니다. 등록할 폴더를 선택해 주세요: ${candidates.join(', ')}`);
  if (incomplete) throw new AppError('PROJECT_SEARCH_INCOMPLETE', '하위 폴더 검색을 완료하지 못했습니다(권한 또는 검색 범위: 6단계·2,000폴더). 프로젝트에 가까운 폴더를 선택해 주세요.');
  return candidates[0] ?? root;
}
