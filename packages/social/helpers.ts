import { AppError } from '../domain/errors.js';

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Explicit JSON-array parse for textarea fields. The generic form does not parse JSON. */
export function parseJsonArray(value: unknown, label: string, options: { min?: number; max?: number } = {}): string[] {
  if (value === undefined || value === null || value === '') return [];
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw new AppError('INVALID_INPUT', `${label}은(는) JSON 배열이어야 합니다. 예: ["https://example.com/a.jpg"]`); }
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

export function optionalText(input: Record<string, unknown>, key: string, maximum = 200): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new AppError('INVALID_INPUT', `${key} 값을 확인해 주세요.`);
  }
  return value.trim();
}

/** Reads a bounded positive integer input with a clamp; never unbounded. */
export function boundedInt(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = input[key];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new AppError('INVALID_INPUT', `${key}는 정수여야 합니다.`);
  return Math.min(max, Math.max(min, value));
}

/**
 * A dispatched external write whose outcome could not be read (timeout, network
 * loss, or a transient 5xx/429) is AMBIGUOUS: the write may or may not have
 * taken effect. Such an error must never trigger an automatic repost.
 */
export function isAmbiguousWriteError(error: unknown): boolean {
  return error instanceof AppError && !error.externalWriteRejected && (error.code === 'TEMPORARY' || error.code === 'CANCELLED');
}
