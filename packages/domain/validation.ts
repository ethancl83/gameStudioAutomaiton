import { AppError } from './errors.js';
import type { BuildTarget } from './index.js';

export function targetValue(value: unknown): BuildTarget {
  if (!['android', 'ios', 'windows', 'macos', 'linux'].includes(String(value))) throw new AppError('INVALID_TARGET', '빌드 대상을 선택해 주세요.');
  return value as BuildTarget;
}
