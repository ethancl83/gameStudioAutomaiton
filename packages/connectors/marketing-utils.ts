import { AppError, text } from '../domain/errors.js';
import { decimalToMicros, parseMicros } from '../metrics/index.js';


export function currencyCode(value: unknown, label = '통화'): string {
  const code = text(value, label, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new AppError('INVALID_AMOUNT', '통화 코드는 ISO-4217 세 글자여야 합니다.');
  return code;
}

export function countryCode(value: unknown, label = '국가'): string {
  const code = text(value, label, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new AppError('INVALID_INPUT', '국가 코드는 ISO-3166 alpha-2 여야 합니다.');
  return code;
}

export function microsString(value: unknown, label = '금액'): string {
  const amount = parseMicros(value);
  if (amount < 0n) throw new AppError('INVALID_AMOUNT', `${label}은(는) 0 이상이어야 합니다.`);
  return amount.toString();
}

export function microsToDecimal(micros: string): string {
  const value = parseMicros(micros);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

export function moneyToMicros(value: unknown, label = '금액'): string {
  if (typeof value === 'number' && Number.isFinite(value)) return decimalToMicros(value.toFixed(6));
  if (typeof value === 'string' && value.trim()) return decimalToMicros(value.trim());
  throw new AppError('INVALID_AMOUNT', `${label} 형식을 확인해 주세요.`);
}

export function ymd(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

export function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return ymd(date);
}

export function digits(value: string, label: string): string {
  const compact = value.replace(/-/g, '');
  if (!/^\d{6,16}$/.test(compact)) throw new AppError('INVALID_INPUT', `${label} 형식을 확인해 주세요.`);
  return compact;
}

export function headerAuth(kind: 'bearer' | 'raw' | 'api-key', secret: string): Record<string, string> {
  if (kind === 'bearer') return { Authorization: `Bearer ${secret}` };
  if (kind === 'api-key') return { 'Api-Key': secret };
  return { Authorization: secret };
}

export function isoDate(value: unknown, label: string): string {
  const raw = text(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(raw)) throw new AppError('INVALID_INPUT', `${label}는 ISO-8601 날짜여야 합니다.`);
  return raw.includes('T') ? raw : `${raw}T00:00:00`;
}
