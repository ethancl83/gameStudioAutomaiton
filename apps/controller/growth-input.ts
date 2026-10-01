import { AppError, text } from '../../packages/domain/errors.js';
import { parseMicros } from '../../packages/metrics/index.js';

// 성장 운영 API 입력 검증. 사용자 정책값은 범위를 벗어나면 조용히 보정하지 않고 거절한다.
export const iso = (value: unknown, label: string) => {
  const raw = text(value, label, 40); const time = Date.parse(raw);
  if (!Number.isFinite(time)) throw new AppError('INVALID_INPUT', `${label} 형식을 확인해 주세요.`);
  return new Date(time).toISOString();
};
export const ratio = (value: unknown, label: string, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new AppError('INVALID_INPUT', `${label} 값은 ${min}~${max} 사이여야 합니다.`);
  return value;
};
export const integer = (value: unknown, label: string, min: number, max: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new AppError('INVALID_INPUT', `${label} 값은 ${min}~${max} 사이의 정수여야 합니다.`);
  return Number(value);
};
export const micros = (value: unknown, label: string) => {
  const amount = parseMicros(value);
  if (amount < 0n) throw new AppError('INVALID_INPUT', `${label}은 0 이상이어야 합니다.`);
  return amount.toString();
};
