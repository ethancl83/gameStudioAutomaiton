import { posix } from 'node:path';

const ROOT_CACHE_DIRS = new Set([
  '.git',
  '.appops',
  '.godot',
  '.import',
  '.gradle',
  '.idea',
  'library',
  'temp',
  'obj',
  'logs',
  'usersettings',
  'intermediate',
  'saved',
  'binaries',
  'deriveddatacache',
  'node_modules',
  'xcuserdata',
]);

const ANY_CACHE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'xcuserdata',
  '.gradle',
  '__pycache__',
]);

export function isExcludedDirectory(relativePosix: string): boolean {
  const parts = relativePosix.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  const first = parts[0].toLowerCase();
  if (ROOT_CACHE_DIRS.has(first)) return true;
  return parts.some((part) => ANY_CACHE_DIRS.has(part.toLowerCase()));
}

// Git metadata must be excluded whether it appears as a directory or a file
// (e.g. a submodule's `.git` gitlink file), at any depth.
export function isGitPath(relativePosix: string): boolean {
  return relativePosix.split('/').filter(Boolean).some((part) => part.toLowerCase() === '.git');
}

export function toPosix(relative: string): string {
  return relative.split('\\').join('/');
}

export { posix };
