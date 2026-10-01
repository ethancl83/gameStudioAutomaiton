import { AppError } from '../domain/errors.js';
import { decimalToMicros } from './store-tools.js';
import { APP_STORE_API, appleAuthHeaders, many, textAttribute, type JsonApiDocument } from './store-jsonapi.js';
import type { ConnectorContext } from './types.js';

// Preferred base territory per currency, used only to break ties among the
// territories the official /v1/territories metadata reports for a currency.
// The API metadata is authoritative; nothing silently falls back to USD.
const PREFERRED_TERRITORIES: Record<string, string> = {
  USD: 'USA', EUR: 'DEU', GBP: 'GBR', JPY: 'JPN', KRW: 'KOR', CAD: 'CAN', AUD: 'AUS', CNY: 'CHN', BRL: 'BRA', INR: 'IND',
};

export function microsInput(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,30}$/.test(value)) return BigInt(value);
  throw new AppError('INVALID_INPUT', 'priceMicros는 0 이상의 정수여야 합니다.');
}

/**
 * Resolves the base territory for a currency from the official
 * /v1/territories metadata (each territory carries its currency). There is
 * no static default: an unknown currency fails with the actual options.
 */
export async function resolveTerritoryForCurrency(context: ConnectorContext, currency: string): Promise<string> {
  const document = await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/territories?limit=200`, { headers: await appleAuthHeaders(context) });
  const matching = many(document)
    .filter(territory => textAttribute(territory, 'currency') === currency)
    .map(territory => territory.id)
    .sort();
  if (matching.length === 0) {
    throw new AppError('INVALID_INPUT', `App Store 지역 메타데이터에서 통화 ${currency}를 쓰는 지역을 찾지 못했습니다. 지원 통화로 다시 요청해 주세요.`);
  }
  const preferred = PREFERRED_TERRITORIES[currency];
  return preferred && matching.includes(preferred) ? preferred : matching[0];
}

/**
 * Requires an exact Apple price point for the requested amount. Apple prices
 * are a fixed grid, and silently charging a different price than the user
 * asked for is never acceptable — a miss returns PRICE_POINT_REQUIRED with
 * the nearest available amounts so the user can pick one deliberately.
 * `pricePointsUrl` is the product's pricePoints collection already filtered by territory.
 */
export async function findExactPricePoint(
  context: ConnectorContext,
  pricePointsUrl: string,
  territory: string,
  priceMicros: bigint,
): Promise<{ id: string; customerPrice: string }> {
  const headers = await appleAuthHeaders(context);
  let url = pricePointsUrl;
  let nearestBelow: { customerPrice: string; micros: bigint } | undefined;
  let nearestAbove: { customerPrice: string; micros: bigint } | undefined;
  let sawAny = false;
  for (let page = 0; page < 8 && url; page += 1) {
    const document = await context.request<JsonApiDocument>(url, { headers });
    for (const point of many(document)) {
      const customerPrice = textAttribute(point, 'customerPrice');
      if (!customerPrice) continue;
      sawAny = true;
      const micros = decimalToMicros(customerPrice);
      if (micros === priceMicros) return { id: point.id, customerPrice };
      if (micros < priceMicros && (!nearestBelow || micros > nearestBelow.micros)) nearestBelow = { customerPrice, micros };
      if (micros > priceMicros && (!nearestAbove || micros < nearestAbove.micros)) nearestAbove = { customerPrice, micros };
    }
    url = document.links?.next ?? '';
  }
  if (!sawAny) {
    throw new AppError('RESOURCE_NOT_FOUND', `${territory} 지역의 가격 포인트를 조회하지 못했습니다.`, 404);
  }
  const candidates = [nearestBelow?.customerPrice, nearestAbove?.customerPrice].filter(Boolean).join(', ');
  throw new AppError(
    'PRICE_POINT_REQUIRED',
    `요청한 금액(${priceMicros.toString()} micros)에 해당하는 Apple 가격 포인트가 ${territory} 지역에 없습니다. 가장 가까운 사용 가능 금액: ${candidates}. 이 중 하나로 다시 요청해 주세요.`,
    422,
    {
      territory,
      requestedMicros: priceMicros.toString(),
      nearestBelow: nearestBelow?.customerPrice ?? null,
      nearestAbove: nearestAbove?.customerPrice ?? null,
    },
  );
}
