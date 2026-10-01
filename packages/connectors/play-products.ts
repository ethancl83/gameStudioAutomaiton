import { AppError, text } from '../domain/errors.js';
import { parseMicros } from '../metrics/index.js';
import type { ConnectorContext, ConnectorResult, ResourceInput } from './types.js';

// Android Publisher v3 monetization API (discovery revision 20260923, checked 2026-09-24):
// oneTimeProducts / subscriptions list·get·patch, purchaseOptions:batchUpdateStates,
// basePlans/{id}:activate|deactivate. `state` is output-only on purchase options and base plans.
const HOST = 'https://androidpublisher.googleapis.com';
const ROOT = HOST + '/androidpublisher/v3/applications/';

type Kind = 'one-time' | 'subscription';
type Variant = Record<string, unknown>;
interface ProductRecord {
  packageName: string; productId: string;
  listings?: { title?: string; languageCode?: string; description?: string }[];
  purchaseOptions?: Variant[]; basePlans?: Variant[];
}
interface Money { currencyCode?: string; units?: string; nanos?: number }

const VARIANT_KEY = { 'one-time': 'purchaseOptions', subscription: 'basePlans' } as const;
const VARIANT_ID = { 'one-time': 'purchaseOptionId', subscription: 'basePlanId' } as const;
const PRICES_KEY = { 'one-time': 'regionalPricingAndAvailabilityConfigs', subscription: 'regionalConfigs' } as const;
const INACTIVE_STATES = new Set(['INACTIVE', 'INACTIVE_PUBLISHED']);

function segment(value: unknown, label: string): string {
  const result = text(value, label, 150);
  if (!/^[a-zA-Z0-9_.-]+$/.test(result)) throw new AppError('INVALID_INPUT', `${label} 형식이 올바르지 않습니다.`);
  return result;
}
function moneyMicros(price: Money | undefined): string | null {
  if (!price || price.units === undefined && price.nanos === undefined) return null;
  return (BigInt(price.units ?? '0') * 1_000_000n + BigInt(Math.trunc((price.nanos ?? 0) / 1000))).toString();
}
function variants(product: ProductRecord, kind: Kind): Variant[] {
  return product[VARIANT_KEY[kind]] ?? [];
}

/** Per-option state and regional prices, so a multi-option product is never summarized by its first option alone. */
function optionSummary(variant: Variant, kind: Kind) {
  const prices = (variant[PRICES_KEY[kind]] ?? []) as Array<{ regionCode?: string; price?: Money; availability?: string; newSubscriberAvailability?: boolean }>;
  return {
    optionId: String(variant[VARIANT_ID[kind]] ?? ''),
    state: String(variant.state ?? 'DRAFT'),
    prices: prices.map(item => ({
      regionCode: item.regionCode ?? null, currency: item.price?.currencyCode ?? null, priceMicros: moneyMicros(item.price),
      available: kind === 'subscription' ? item.newSubscriberAvailability === true : item.availability === 'AVAILABLE',
    })),
  };
}
export function playProductResource(product: ProductRecord, kind: Kind): ResourceInput {
  const list = variants(product, kind);
  const options = list.map(item => optionSummary(item, kind));
  const states = options.map(item => item.state);
  return {
    kind: 'product', externalId: `${product.packageName}:${kind}:${product.productId}`,
    name: product.listings?.[0]?.title || product.productId,
    status: states.includes('ACTIVE') ? 'ACTIVE' : states[0] ?? 'DRAFT',
    data: { packageName: product.packageName, productId: product.productId, productType: kind, listings: product.listings ?? [], variants: list, options },
  };
}

export async function listPlayProducts(ctx: ConnectorContext, pkg: string, headers: Record<string, string>): Promise<ConnectorResult> {
  const resources: ResourceInput[] = [];
  for (const [path, field, kind] of [['oneTimeProducts', 'oneTimeProducts', 'one-time'], ['subscriptions', 'subscriptions', 'subscription']] as const) {
    let pageToken = ''; const seen = new Set<string>();
    do {
      if (seen.has(pageToken) || seen.size >= 100) throw new AppError('PAGINATION_LIMIT', '상품 목록이 너무 큽니다. 앱별로 조회해 주세요.');
      seen.add(pageToken);
      const query = new URLSearchParams({ pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
      const data = await ctx.request<Record<string, unknown>>(ROOT + pkg + '/' + path + '?' + query, { headers });
      const records = data[field];
      if (records !== undefined && !Array.isArray(records)) throw new AppError('INVALID_PROVIDER_RESPONSE', '상품 목록 응답 형식을 확인할 수 없습니다.');
      for (const product of (records ?? []) as ProductRecord[]) resources.push(playProductResource({ ...product, packageName: pkg }, kind));
      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    } while (pageToken);
  }
  return { resources, summary: { packageName: pkg, productCount: resources.length } };
}

function money(micros: unknown, currency: unknown) {
  const value = parseMicros(micros);
  if (value <= 0n) throw new AppError('INVALID_AMOUNT', '상품 가격은 0보다 커야 합니다.');
  const code = text(currency, '통화', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new AppError('INVALID_AMOUNT', '통화 코드를 확인해 주세요.');
  return { currencyCode: code, units: (value / 1_000_000n).toString(), nanos: Number(value % 1_000_000n) * 1000 };
}

function productTarget(input: Record<string, unknown>, pkg: string): { kind: Kind; id: string } {
  const parts = text(input.externalId, '상품 식별자').split(':');
  if (parts.length !== 3 || parts[0] !== pkg || !['one-time', 'subscription'].includes(parts[1])) {
    throw new AppError('RESOURCE_MISMATCH', '선택한 프로젝트의 동기화된 상품을 선택해 주세요.');
  }
  return { kind: parts[1] as Kind, id: segment(parts[2], '상품 ID') };
}

function optionInput(input: Record<string, unknown>): string | undefined {
  const raw = input.optionId ?? input.purchaseOptionId ?? input.basePlanId;
  return raw === undefined || raw === '' ? undefined : segment(raw, '구매 옵션 ID');
}

/** Picks the option to act on; a multi-option product requires an explicit option ID. */
function selectVariant(list: Variant[], kind: Kind, optionId: string | undefined): Variant {
  const ids = list.map(item => String(item[VARIANT_ID[kind]]));
  if (optionId) {
    const match = list.find(item => item[VARIANT_ID[kind]] === optionId);
    if (!match) throw new AppError('RESOURCE_NOT_FOUND', `구매 옵션 ${optionId}이(가) 없습니다. 사용 가능: ${ids.join(', ') || '없음'}`, 404);
    return match;
  }
  if (list.length !== 1) {
    throw new AppError('MULTIPLE_PRICE_OPTIONS', `구매 옵션이 여러 개인 상품입니다. optionId로 대상을 지정해 주세요 (사용 가능: ${ids.join(', ') || '없음'}). 가격을 일괄 변경하지 않았습니다.`,
      422, { optionIds: ids });
  }
  return list[0];
}

async function readProduct(ctx: ConnectorContext, pkg: string, kind: Kind, id: string, headers: Record<string, string>): Promise<ProductRecord> {
  return ctx.request<ProductRecord>(ROOT + pkg + '/' + (kind === 'subscription' ? 'subscriptions' : 'oneTimeProducts') + '/' + id, { headers });
}

export async function upsertPlayProduct(operation: string, input: Record<string, unknown>, ctx: ConnectorContext, pkg: string, headers: Record<string, string>): Promise<ConnectorResult> {
  const create = operation === 'create-product';
  let kind: Kind = input.type === 'subscription' ? 'subscription' : 'one-time';
  let id: string;
  if (create) id = segment(input.productId, '상품 ID');
  else ({ kind, id } = productTarget(input, pkg));
  if (!/^[a-z0-9][a-z0-9_.]{0,39}$/.test(id)) throw new AppError('INVALID_INPUT', '상품 ID는 소문자·숫자·밑줄·마침표를 사용하는 40자 이하 값이어야 합니다.');
  if (input.status !== undefined) throw new AppError('UNSUPPORTED_CHANGE', '판매 상태는 activate-product 또는 deactivate-product 작업으로 전환해 주세요. 가격 변경과 함께 처리하지 않았습니다.');
  const price = money(input.priceMicros, input.currency);
  const region = text(input.country ?? ctx.credentials.defaultRegion ?? 'US', '판매 국가', 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) throw new AppError('INVALID_INPUT', '판매 국가 코드를 확인해 주세요.');
  const converted = await ctx.request<{ regionVersion: { version: string }; convertedRegionPrices: Record<string, { price: typeof price }> }>(
    ROOT + pkg + '/pricing:convertRegionPrices', { method: 'POST', headers, json: { price }, write: false });
  const localPrice = converted.convertedRegionPrices?.[region]?.price;
  if (!converted.regionVersion?.version || !localPrice) throw new AppError('REGION_UNAVAILABLE', '선택한 국가의 상품 가격을 계산할 수 없습니다.');
  // Users select a currency and country explicitly. A conversion cannot silently change that contract.
  if (localPrice.currencyCode !== price.currencyCode) throw new AppError('CURRENCY_MISMATCH', '상품 통화와 판매 국가의 통화가 일치해야 합니다.');
  let product: ProductRecord; let optionId: string | undefined;
  if (create) {
    const name = text(input.name, '상품 이름', 55);
    const languageCode = text(input.language ?? ctx.credentials.defaultLanguage ?? 'en-US', '상품 언어', 20);
    product = { packageName: pkg, productId: id, listings: [{ languageCode, title: name,
      description: text(input.description ?? name, '상품 설명', 200) }] };
    if (kind === 'subscription') {
      const period = text(input.billingPeriod, '구독 결제 주기', 5);
      if (!['P1W', 'P1M', 'P3M', 'P6M', 'P1Y'].includes(period)) throw new AppError('INVALID_INPUT', '구독 결제 주기를 선택해 주세요.');
      product.basePlans = [{ basePlanId: 'standard', autoRenewingBasePlanType: { billingPeriodDuration: period },
        regionalConfigs: [{ regionCode: region, newSubscriberAvailability: true, price }] }];
    } else product.purchaseOptions = [{ purchaseOptionId: 'standard', buyOption: {},
      regionalPricingAndAvailabilityConfigs: [{ regionCode: region, availability: 'AVAILABLE', price }] }];
  } else {
    const current = await readProduct(ctx, pkg, kind, id, headers);
    const list = variants(current, kind);
    const target = selectVariant(list, kind, optionInput(input));
    optionId = String(target[VARIANT_ID[kind]]);
    const pricesKey = PRICES_KEY[kind];
    const prices = (target[pricesKey] ?? []) as Variant[];
    if (!prices.some(item => item.regionCode === region)) throw new AppError('REGION_UNAVAILABLE', '이 구매 옵션에서 이미 설정된 국가의 가격만 변경할 수 있습니다.');
    // The patch replaces the whole option list: every other option and region is sent back unchanged,
    // and the output-only state is omitted from each entry.
    const patched = list.map(item => {
      const { state: _state, ...rest } = item;
      if (item !== target) return rest;
      return { ...rest, [pricesKey]: prices.map(entry => entry.regionCode === region ? { ...entry, price } : entry) };
    });
    product = { packageName: pkg, productId: id, [VARIANT_KEY[kind]]: patched };
  }
  const query = new URLSearchParams({ 'regionsVersion.version': converted.regionVersion.version });
  let path: string; let method: 'POST' | 'PATCH';
  if (create && kind === 'subscription') { query.set('productId', id); path = 'subscriptions'; method = 'POST'; }
  else {
    query.set('updateMask', create ? 'listings,purchaseOptions' : VARIANT_KEY[kind]);
    if (create) query.set('allowMissing', 'true');
    path = (kind === 'subscription' ? 'subscriptions' : 'onetimeproducts') + '/' + id; method = 'PATCH';
    if (create) {
      try {
        await ctx.request(ROOT + pkg + '/oneTimeProducts/' + id, { headers });
        throw new AppError('PRODUCT_EXISTS', '같은 ID의 상품이 이미 있습니다. 상품 변경 작업을 사용해 주세요.');
      } catch (error) { if ((error as AppError).code !== 'RESOURCE_NOT_FOUND') throw error; }
    }
  }
  const saved = await ctx.request<ProductRecord>(ROOT + pkg + '/' + path + '?' + query, { method, headers, json: product, write: true });
  const resource = playProductResource({ ...saved, packageName: pkg, productId: id }, kind);
  ctx.checkpoint({ externalId: resource.externalId, ...(optionId ? { optionId } : {}) });
  return { resources: [resource], summary: { externalId: resource.externalId, state: resource.status, currency: price.currencyCode, region, ...(optionId ? { optionId } : {}) } };
}

/** activate-product / deactivate-product for one purchase option or base plan. */
export async function setPlayProductState(operation: string, input: Record<string, unknown>, ctx: ConnectorContext, pkg: string, headers: Record<string, string>): Promise<ConnectorResult> {
  const activate = operation === 'activate-product';
  const { kind, id } = productTarget(input, pkg);
  const current = await readProduct(ctx, pkg, kind, id, headers);
  const target = selectVariant(variants(current, kind), kind, optionInput(input));
  const optionId = String(target[VARIANT_ID[kind]]);
  const before = String(target.state ?? 'DRAFT');
  const reached = (state: string) => activate ? state === 'ACTIVE' : INACTIVE_STATES.has(state);
  const externalId = `${pkg}:${kind}:${id}`;
  if (reached(before)) {
    const resource = playProductResource({ ...current, packageName: pkg, productId: id }, kind);
    return { resources: [resource], summary: { externalId, optionId, previousState: before, state: before, changed: false, confirmed: true } };
  }
  if (!activate && before !== 'ACTIVE') throw new AppError('INVALID_INPUT', `판매 중(ACTIVE)인 옵션만 중지할 수 있습니다. 현재 상태: ${before}.`);
  let saved: ProductRecord;
  if (kind === 'one-time') {
    const body = { packageName: pkg, productId: id, purchaseOptionId: optionId };
    const result = await ctx.request<{ oneTimeProducts?: ProductRecord[] }>(ROOT + pkg + '/oneTimeProducts/' + id + '/purchaseOptions:batchUpdateStates', {
      method: 'POST', headers, write: true,
      json: { requests: [activate ? { activatePurchaseOptionRequest: body } : { deactivatePurchaseOptionRequest: body }] },
    });
    const updated = result.oneTimeProducts?.[0];
    if (!updated) throw new AppError('INVALID_PROVIDER_RESPONSE', '판매 상태 변경 응답에 상품이 없습니다. 상품 목록을 다시 동기화해 확인해 주세요.', 502);
    saved = updated;
  } else {
    saved = await ctx.request<ProductRecord>(ROOT + pkg + '/subscriptions/' + id + '/basePlans/' + optionId + (activate ? ':activate' : ':deactivate'), {
      method: 'POST', headers, write: true, json: { packageName: pkg, productId: id, basePlanId: optionId },
    });
  }
  ctx.checkpoint({ externalId, optionId });
  const resource = playProductResource({ ...saved, packageName: pkg, productId: id }, kind);
  const after = String(variants(saved, kind).find(item => item[VARIANT_ID[kind]] === optionId)?.state ?? 'UNKNOWN');
  const confirmed = reached(after);
  return {
    resources: [resource],
    // The provider accepted the request but reported a different state: never report it as done.
    unresolved: !confirmed,
    summary: { externalId, optionId, previousState: before, state: after, changed: true, confirmed },
  };
}
