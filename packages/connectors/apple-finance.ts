import { gunzipSync } from 'node:zlib';
import { AppError, text } from '../domain/errors.js';
import { decimalToMicros } from './store-tools.js';
import { APP_STORE_API, appleAuthHeaders } from './store-jsonapi.js';
import type { ConnectorContext, ConnectorResult, MetricInput } from './types.js';

// GET /v1/financeReports (OpenAPI 4.5, checked 2026-09-24): vendorNumber, reportType
// FINANCIAL, regionCode ZZ (consolidated, all regions, multiple currencies), reportDate
// YYYY-MM (Apple fiscal month), application/a-gzip TSV. Columns per App Store Connect Help
// "Financial report fields": Extended Partner Share is signed (returns are negative) and
// denominated in Partner Share Currency.
const LIMIT = 100 * 1024 * 1024;
const REQUIRED = ['Start Date', 'End Date', 'Extended Partner Share', 'Partner Share Currency'] as const;

/** Settled facts use their own sourceId family so they never collide with daily `apple:sales:` proceeds. */
export function appleFinancePrefix(vendorNumber: string, month: string): string {
  return `apple-finance:${vendorNumber}:${month}:`;
}

function isoDate(value: string): string | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return undefined;
  const date = `${match[3]}-${match[1]}-${match[2]}`;
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
}

/**
 * Sums signed partner share per fiscal period and currency. Only rows starting with a
 * transaction date are data; header repeats, `Total_*` lines and summary tables are skipped.
 */
export function parseAppleFinanceReport(bytes: Uint8Array, vendorNumber: string, month: string): { metrics: MetricInput[]; rows: number } {
  let source: string;
  try { source = gunzipSync(bytes, { maxOutputLength: LIMIT }).toString('utf8'); } catch {
    throw new AppError('INVALID_REPORT', 'Apple 재무 보고서 압축을 해제할 수 없거나 처리 한도를 넘습니다.');
  }
  let columns: number[] | undefined; let rows = 0;
  const totals = new Map<string, MetricInput>();
  for (const line of source.split(/\r?\n/)) {
    const cells = line.split('\t').map(cell => cell.trim());
    if (cells[0] === 'Start Date') {
      columns = REQUIRED.map(name => cells.indexOf(name));
      if (columns.some(index => index < 0)) throw new AppError('INVALID_REPORT', 'Apple 재무 보고서의 필수 열이 없습니다. FINANCIAL 보고서인지 확인해 주세요.');
      continue;
    }
    if (!isoDate(cells[0] ?? '')) continue;
    if (!columns) throw new AppError('INVALID_REPORT', 'Apple 재무 보고서의 머리글을 찾지 못했습니다.');
    const [start, end, amount, currencyRaw] = columns.map(index => cells[index] ?? '');
    const startDate = isoDate(start); const endDate = isoDate(end); const currency = currencyRaw.toUpperCase();
    if (!startDate || !endDate || !/^[A-Z]{3}$/.test(currency) || !/^-?\d+(?:\.\d+)?$/.test(amount)) {
      throw new AppError('INVALID_REPORT', 'Apple 재무 보고서 행의 기간·통화·금액을 해석할 수 없습니다.');
    }
    const sourceId = `${appleFinancePrefix(vendorNumber, month)}${startDate}_${endDate}`;
    const key = `${sourceId}:${currency}`;
    const previous = totals.get(key);
    totals.set(key, { date: endDate, currency, kind: 'revenue', basis: 'settled', sourceId,
      amountMicros: (BigInt(previous?.amountMicros ?? '0') + decimalToMicros(amount)).toString() });
    rows += 1;
  }
  return { metrics: [...totals.values()], rows };
}

function months(input: Record<string, unknown>): string[] {
  if (input.financeMonth !== undefined && input.financeMonth !== '') {
    const month = text(input.financeMonth, '정산 보고서 월', 7);
    if (!/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) throw new AppError('INVALID_INPUT', '정산 보고서 월은 YYYY-MM 형식이어야 합니다.');
    return [month];
  }
  const today = new Date();
  return [1, 2, 3].map(offset => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - offset, 1)).toISOString().slice(0, 7));
}

export async function collectAppleFinance(input: Record<string, unknown>, context: ConnectorContext, vendorNumber: string): Promise<ConnectorResult> {
  const headers = await appleAuthHeaders(context, { Accept: 'application/a-gzip' });
  const metrics: MetricInput[] = []; const metricSourcePrefixes: string[] = [];
  const settledMonths: string[] = []; const missingMonths: string[] = [];
  for (const month of months(input)) {
    context.signal.throwIfAborted();
    const query = new URLSearchParams({
      'filter[vendorNumber]': vendorNumber, 'filter[reportType]': 'FINANCIAL', 'filter[regionCode]': 'ZZ', 'filter[reportDate]': month,
    });
    let bytes: Uint8Array;
    try {
      bytes = await context.request<Uint8Array>(`${APP_STORE_API}/v1/financeReports?${query}`, { headers, format: 'bytes' });
    } catch (error) {
      if (error instanceof AppError && error.code === 'RESOURCE_NOT_FOUND') { missingMonths.push(month); continue; }
      // Finance reports need the Finance role; daily sales proceeds stay usable without it.
      if (error instanceof AppError && error.code === 'PERMISSION_REQUIRED') {
        return { metrics, metricSourcePrefixes, summary: { financeStatus: 'permission_required', financeMessage: error.message, settledMonths, missingMonths } };
      }
      throw error;
    }
    metrics.push(...parseAppleFinanceReport(bytes, vendorNumber, month).metrics);
    // Replace every previously collected fact of this fiscal month, including periods that disappeared.
    metricSourcePrefixes.push(appleFinancePrefix(vendorNumber, month));
    settledMonths.push(month);
  }
  return { metrics, metricSourcePrefixes,
    summary: { financeStatus: settledMonths.length ? 'collected' : 'not_available', settledMonths, missingMonths, settledBasis: 'settled' } };
}
