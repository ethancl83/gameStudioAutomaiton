import { AppError } from '../domain/errors.js';
import type { ConnectorContext } from './types.js';
import { digits } from './marketing-utils.js';

export const HOST = 'https://googleads.googleapis.com/v25';
const SCOPE = 'https://www.googleapis.com/auth/adwords';
function customerId(ctx: ConnectorContext): string {
  return digits(ctx.connection.accountId || ctx.credentials.customerId || '', 'Google Ads 고객 ID');
}

export async function headers(ctx: ConnectorContext): Promise<Record<string, string>> {
  const token = await ctx.accessToken([SCOPE]);
  const result: Record<string, string> = { Authorization: `Bearer ${token}` };
  const login = ctx.credentials.loginCustomerId?.replace(/-/g, '');
  if (login) {
    if (!/^\d{6,16}$/.test(login)) throw new AppError('INVALID_INPUT', 'loginCustomerId 형식을 확인해 주세요.');
    result['login-customer-id'] = login;
  }
  return result;
}

export async function search<T extends Record<string, unknown>>(ctx: ConnectorContext, query: string, id = customerId(ctx)): Promise<T[]> {
  const rows: T[] = [];
  let pageToken = '';
  const seen = new Set<string>();
  do {
    if (seen.has(pageToken) || seen.size >= 50) throw new AppError('PAGINATION_LIMIT', 'Google Ads 목록이 너무 큽니다.');
    seen.add(pageToken);
    const body: Record<string, unknown> = { query };
    if (pageToken) body.pageToken = pageToken;
    const data = await ctx.request<{ results?: T[]; nextPageToken?: string }>(`${HOST}/customers/${id}/googleAds:search`, {
      method: 'POST', headers: await headers(ctx), json: body, write: false,
    });
    if (data.results !== undefined && !Array.isArray(data.results)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Google Ads 검색 응답 형식을 확인할 수 없습니다.');
    rows.push(...(data.results ?? []));
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
  } while (pageToken);
  return rows;
}

export async function customerInfo(ctx: ConnectorContext): Promise<{ id: string; currency: string; timeZone: string; name: string; manager: boolean }> {
  const id = customerId(ctx);
  const rows = await search<Record<string, unknown>>(ctx, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer');
  const customer = (rows[0]?.customer ?? {}) as Record<string, unknown>;
  const currency = typeof customer.currencyCode === 'string' ? customer.currencyCode : '';
  if (!currency) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Google Ads 계정 통화를 확인할 수 없습니다.');
  return {
    id: String(customer.id ?? id),
    currency,
    timeZone: String(customer.timeZone ?? ''),
    name: String(customer.descriptiveName ?? ''),
    manager: customer.manager === true,
  };
}
