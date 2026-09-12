import { unzipSync } from 'fflate';
import { AppError, text } from '../domain/errors.js';
import { decimalToMicros } from '../metrics/index.js';
import type { ConnectorContext, ConnectorResult, MetricInput } from './types.js';

const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';
const LIMIT = 100 * 1024 * 1024;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function csvRows(source: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || !field) quoted = !quoted;
      else throw new AppError('INVALID_REPORT', '수익 보고서의 CSV 형식이 올바르지 않습니다.');
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(field); field = '';
      if (char !== ',') {
        if (row.some(value => value.trim())) rows.push(row);
        row = []; if (char === '\r' && source[i + 1] === '\n') i++;
      }
    } else field += char;
    if (field.length > 1_000_000 || row.length > 1000 || rows.length > 1_000_000) throw new AppError('REPORT_TOO_LARGE', '수익 보고서의 처리 한도를 넘었습니다.');
  }
  if (quoted) throw new AppError('INVALID_REPORT', '수익 보고서에 닫히지 않은 CSV 값이 있습니다.');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function reportDate(value: string): string {
  let date = value.trim();
  const english = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(date);
  if (english) {
    const month = MONTHS.indexOf(english[1].slice(0, 3).toLowerCase());
    if (month >= 0) date = `${english[3]}-${String(month + 1).padStart(2, '0')}-${english[2].padStart(2, '0')}`;
  }
  const parsed = new Date(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new AppError('INVALID_REPORT', '수익 보고서의 거래 날짜를 해석할 수 없습니다.');
  }
  return date;
}

/** Only package/day/currency totals leave this parser; orders and buyer data are never persisted. */
export function parsePlayEarnings(archive: Uint8Array, month: string): MetricInput[] {
  let files: Record<string, Uint8Array>; let declared = 0; let count = 0;
  try {
    files = unzipSync(archive, { filter(file) {
      if (!/\.csv$/i.test(file.name)) return false;
      declared += file.originalSize; count++;
      if (count > 32 || declared > LIMIT || file.originalSize > LIMIT || !Number.isSafeInteger(file.originalSize)) {
        throw new AppError('REPORT_TOO_LARGE', '압축 해제된 수익 보고서가 처리 한도를 넘습니다.');
      }
      return true;
    } });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_REPORT', 'Google Play 수익 보고서 ZIP을 읽을 수 없습니다.');
  }
  if (!count) throw new AppError('INVALID_REPORT', '수익 보고서에 CSV 파일이 없습니다.');
  const totals = new Map<string, MetricInput>();
  for (const bytes of Object.values(files)) {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const rows = csvRows(new TextDecoder(encoding, { fatal: true }).decode(bytes));
    const header = rows.shift()?.map(value => value.trim());
    const names = ['Transaction Date', 'Package ID', 'Merchant Currency', 'Amount (Merchant Currency)', 'Transaction Type'];
    const positions = names.map(name => header?.indexOf(name) ?? -1);
    if (positions.some(index => index < 0)) throw new AppError('INVALID_REPORT', '수익 보고서의 필수 열이 없습니다. Google Play earnings 보고서인지 확인해 주세요.');
    for (const row of rows) {
      const [dateRaw, appIdentifier, currencyRaw, rawAmount] = positions.map(index => row[index]?.trim());
      const currency = currencyRaw?.toUpperCase();
      if (!appIdentifier || !currency || !/^[A-Z]{3}$/.test(currency) || !rawAmount || !dateRaw) throw new AppError('INVALID_REPORT', '수익 보고서에 필수 값이 누락되어 있습니다.');
      const date = reportDate(dateRaw);
      const amount = /^-?\d{1,3}(?:,\d{3})+(?:\.\d{1,6})?$/.test(rawAmount) ? rawAmount.replaceAll(',', '') : rawAmount;
      const micros = BigInt(decimalToMicros(amount));
      const sourceId = `play-earnings:${month}:${appIdentifier}`;
      const key = `${sourceId}:${date}:${currency}`;
      const previous = totals.get(key);
      totals.set(key, { date, appIdentifier, currency, kind: 'revenue', basis: 'proceeds', sourceId,
        amountMicros: (BigInt(previous?.amountMicros ?? '0') + micros).toString() });
    }
  }
  return [...totals.values()];
}

export async function collectPlayEarnings(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const bucket = ctx.credentials.reportBucket;
  if (!bucket) return { summary: { revenueStatus: 'report_bucket_required' } };
  if (!/^pubsite_prod_rev_[a-zA-Z0-9_-]+$/.test(bucket)) throw new AppError('INVALID_INPUT', 'Play Console의 비공개 수익 보고서 버킷 이름을 입력해 주세요.');
  const months: string[] = [];
  if (input.reportMonth !== undefined) {
    const month = text(input.reportMonth, '보고서 월', 6);
    if (!/^20\d{2}(?:0[1-9]|1[0-2])$/.test(month)) throw new AppError('INVALID_INPUT', '보고서 월은 YYYYMM 형식이어야 합니다.');
    months.push(month);
  } else {
    const today = new Date();
    for (let offset = 1; offset <= 3; offset++) {
      const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1));
      months.push(month.toISOString().slice(0, 7).replace('-', ''));
    }
  }
  const headers = { Authorization: 'Bearer ' + await ctx.accessToken([SCOPE]) };
  const metrics: MetricInput[] = []; const metricSourcePrefixes: string[] = []; const missingMonths: string[] = [];
  for (const month of months) {
    const object = encodeURIComponent(`earnings/earnings_${month}.zip`);
    try {
      const data = await ctx.request<Uint8Array>(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`, { headers, format: 'bytes' });
      metrics.push(...parsePlayEarnings(data, month));
      metricSourcePrefixes.push(`play-earnings:${month}:`);
    } catch (error) {
      if ((error as AppError).code === 'RESOURCE_NOT_FOUND') { missingMonths.push(month); continue; }
      throw error;
    }
  }
  return { metrics, metricSourcePrefixes, summary: { revenueStatus: metricSourcePrefixes.length ? 'collected' : 'not_available',
    reportMonths: months.filter(month => !missingMonths.includes(month)), missingMonths, revenueBasis: 'proceeds' } };
}
