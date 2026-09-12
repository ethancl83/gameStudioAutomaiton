import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { AppError, redact } from '../domain/errors.js';

const excluded = /^(?:\.|node_modules$|vendor$|Library$|Temp$|build$|dist$|coverage$)|(?:secret|credential|keystore|service.?account|auth[_-]?key|\.pem$|\.p12$|\.p8$|\.jks$|\.key$)/i;
const textExtensions = new Set(['.md', '.txt', '.json', '.godot', '.cfg', '.gd', '.cs', '.cpp', '.h', '.ts', '.tsx', '.js', '.jsx', '.swift', '.xml', '.gradle', '.kts', '.plist', '.pbxproj', '.uproject', '.unity', '.tscn']);

export async function containedFile(root: string, path: string): Promise<string> {
  const canonical = await realpath(root);
  const target = resolve(canonical, path);
  const rel = relative(canonical, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || resolve(target) !== target) throw new AppError('AGENT_PATH_DENIED', '허용된 작업 폴더 안의 파일만 사용할 수 있습니다.');
  let current = canonical;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new AppError('AGENT_PATH_DENIED', 'AI 분석에서 심볼릭 링크는 사용하지 않습니다.');
  }
  if (await realpath(target) !== target) throw new AppError('AGENT_PATH_DENIED', '파일 경로가 변경되었습니다.');
  return target;
}
function allowed(path: string): void {
  if (path.split(/[\\/]/).some(part => part === '..' || excluded.test(part))) throw new AppError('AGENT_PATH_DENIED', '비밀·숨김·의존성 파일은 AI 분석 대상에서 제외합니다.');
}
export async function listProjectFiles(root: string, path = '') {
  if (path) allowed(path);
  const directory = path ? await containedFile(root, path) : await realpath(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter(entry => !excluded.test(entry.name) && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()));
  return { files: files.slice(0, 200).map(entry => ({ path: [path, entry.name].filter(Boolean).join('/'), directory: entry.isDirectory() })), truncated: files.length > 200 };
}
export async function readProjectFile(root: string, path: string) {
  allowed(path);
  if (!textExtensions.has(extname(path).toLowerCase())) throw new AppError('AGENT_FILE_TYPE', '지원하는 프로젝트 문서·소스 파일만 읽을 수 있습니다.');
  const target = await containedFile(root, path);
  const info = await lstat(target);
  if (!info.isFile() || info.size > 256 * 1024) throw new AppError('AGENT_FILE_SIZE', '분석할 파일은 256 KiB 이하의 일반 파일이어야 합니다.');
  const content = await readFile(target, 'utf8');
  // Do not pass an entire file containing recognizable credential material to a model.
  if (/-----BEGIN .*PRIVATE KEY-----|["']?(?:api[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|password|private[_-]?key)["']?\s*[:=]\s*["'][^"']+["']/i.test(content)) {
    throw new AppError('AGENT_SECRET_FILE', '인증 정보가 포함될 수 있는 파일은 AI에 전달하지 않습니다.');
  }
  return { path, content: redact(content), truncated: content.length > 16_000 };
}
