import { AppError } from '../domain/errors.js';

/**
 * Explicit JSON parsing for ActionForm textarea values.
 * The generic form sends textarea content as a raw string; only named
 * connector fields call this. Arrays/objects already parsed by a caller
 * are accepted as-is.
 */
export function parseJsonArray(value: unknown, label: string, options: { min?: number; max?: number } = {}): string[] {
  if (value === undefined || value === null || value === '') return [];
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw new AppError('INVALID_INPUT', `${label}은(는) JSON 배열이어야 합니다. 예: ["값1","값2"]`); }
  }
  if (!Array.isArray(parsed)) throw new AppError('INVALID_INPUT', `${label}은(는) JSON 배열이어야 합니다.`);
  if (options.max != null && parsed.length > options.max) throw new AppError('INVALID_INPUT', `${label}은(는) ${options.max}개 이하여야 합니다.`);
  const items: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || !item.trim() || item.includes('\0')) {
      throw new AppError('INVALID_INPUT', `${label}의 각 항목은 비어 있지 않은 문자열이어야 합니다.`);
    }
    items.push(item.trim());
  }
  if (options.min != null && items.length < options.min) {
    throw new AppError('INVALID_INPUT', `${label}은(는) ${options.min}개 이상이어야 합니다.`);
  }
  return items;
}

export function codePointLength(value: string): number {
  return [...value].length;
}
