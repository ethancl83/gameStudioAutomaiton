import { AppError, text } from '../domain/errors.js';
import { findExactPricePoint, microsInput, resolveTerritoryForCurrency } from './apple-pricing.js';
import {
  APP_STORE_API as API, appleAuthHeaders, collectPages, one, relationshipId, resolveAppleApp, resourceId, textAttribute,
  type JsonApiDocument, type JsonApiResource,
} from './store-jsonapi.js';
import type { ConnectorContext, ConnectorResult, ResourceInput } from './types.js';

// Shapes follow the official App Store Connect OpenAPI 4.5 spec (checked 2026-09-24):
// SubscriptionGroupCreateRequest, SubscriptionCreateRequest, SubscriptionPriceCreateRequest,
// SubscriptionSubmissionCreateRequest, InAppPurchaseSubmissionCreateRequest.

/** Auto-renewable subscriptions share Apple's numeric ID space with IAPs, so their resource IDs carry a prefix. */
export const SUBSCRIPTION_PREFIX = 'subscription:';

const PERIODS: Record<string, string> = {
  P1W: 'ONE_WEEK', P1M: 'ONE_MONTH', P2M: 'TWO_MONTHS', P3M: 'THREE_MONTHS', P6M: 'SIX_MONTHS', P1Y: 'ONE_YEAR',
};
// Review has been requested or granted; a second submission would be rejected by Apple.
const SUBMITTED_STATES = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'APPROVED', 'PENDING_BINARY_APPROVAL']);

export function isAppleSubscriptionId(externalId: unknown): boolean {
  return typeof externalId === 'string' && externalId.startsWith(SUBSCRIPTION_PREFIX);
}

function subscriptionId(externalId: unknown): string {
  const raw = text(externalId, '상품 식별자', 220);
  return resourceId(raw.startsWith(SUBSCRIPTION_PREFIX) ? raw.slice(SUBSCRIPTION_PREFIX.length) : raw, '구독 ID');
}

function period(value: unknown): string {
  const raw = text(value, '구독 결제 주기', 20).toUpperCase();
  const mapped = PERIODS[raw] ?? (Object.values(PERIODS).includes(raw) ? raw : undefined);
  if (!mapped) throw new AppError('INVALID_INPUT', `구독 결제 주기는 ${Object.keys(PERIODS).join(', ')} 중 하나여야 합니다.`);
  return mapped;
}

function subscriptionResource(item: JsonApiResource, bundleId: string, group?: JsonApiResource): ResourceInput {
  return {
    kind: 'product',
    externalId: SUBSCRIPTION_PREFIX + item.id,
    name: textAttribute(item, 'name') || textAttribute(item, 'productId'),
    status: textAttribute(item, 'state') || 'UNKNOWN',
    data: {
      bundleId, productId: textAttribute(item, 'productId'), productType: 'subscription', type: 'auto-renewable-subscription',
      subscriptionId: item.id, subscriptionPeriod: textAttribute(item, 'subscriptionPeriod') || null,
      subscriptionGroupId: group?.id ?? (relationshipId(item, 'group') || null),
      subscriptionGroupName: group ? textAttribute(group, 'referenceName') : null,
    },
  };
}

async function appGroups(context: ConnectorContext, appId: string, headers: Record<string, string>): Promise<JsonApiResource[]> {
  return collectPages(context, `${API}/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?limit=200`, headers, '구독 그룹');
}

export async function listAppleSubscriptions(context: ConnectorContext, app: { id: string; bundleId: string }): Promise<ResourceInput[]> {
  const headers = await appleAuthHeaders(context);
  const resources: ResourceInput[] = [];
  for (const group of await appGroups(context, app.id, headers)) {
    const items = await collectPages(context, `${API}/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions?limit=200`, headers, '구독 목록');
    for (const item of items) resources.push(subscriptionResource(item, app.bundleId, group));
  }
  return resources;
}

/** Reads a subscription and proves it belongs to the configured app through its group. */
async function requireOwnedSubscription(context: ConnectorContext, id: string, headers: Record<string, string>) {
  const app = await resolveAppleApp(context);
  const subscription = one(
    await context.request<JsonApiDocument>(`${API}/v1/subscriptions/${encodeURIComponent(id)}?include=group`, { headers }),
    '구독 조회',
  );
  const groupId = relationshipId(subscription, 'group');
  const group = (await appGroups(context, app.id, headers)).find(item => item.id === groupId);
  if (!groupId || !group) throw new AppError('RESOURCE_MISMATCH', '선택한 구독이 연결된 앱의 구독 그룹에 속하지 않습니다.');
  return { app, subscription, group };
}

async function applySubscriptionPrice(
  context: ConnectorContext, id: string, territory: string, priceMicros: bigint, preserveCurrentPrice: boolean,
): Promise<{ customerPrice: string; subscriptionPriceId: string }> {
  const point = await findExactPricePoint(
    context,
    `${API}/v1/subscriptions/${encodeURIComponent(id)}/pricePoints?filter[territory]=${encodeURIComponent(territory)}&limit=200`,
    territory,
    priceMicros,
  );
  const created = one(await context.request<JsonApiDocument>(`${API}/v1/subscriptionPrices`, {
    method: 'POST', headers: await appleAuthHeaders(context), write: true,
    json: {
      data: {
        type: 'subscriptionPrices',
        attributes: { preserveCurrentPrice },
        relationships: {
          subscription: { data: { type: 'subscriptions', id } },
          territory: { data: { type: 'territories', id: territory } },
          subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: point.id } },
        },
      },
    },
  }), '구독 가격 설정');
  return { customerPrice: point.customerPrice, subscriptionPriceId: created.id };
}

export async function createAppleSubscription(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const productId = text(input.productId, 'productId', 200);
  const name = text(input.name, 'name', 64);
  const groupName = text(input.subscriptionGroup, '구독 그룹 참조 이름', 64);
  const subscriptionPeriod = period(input.billingPeriod);
  const currency = text(input.currency, 'currency', 3).toUpperCase();
  const priceMicros = microsInput(input.priceMicros);
  // Every read-side prerequisite is validated before the first external mutation.
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  const territory = await resolveTerritoryForCurrency(context, currency);
  const groups = (await appGroups(context, app.id, headers)).filter(group => textAttribute(group, 'referenceName') === groupName);
  if (groups.length > 1) throw new AppError('INVALID_INPUT', `참조 이름이 "${groupName}"인 구독 그룹이 여러 개입니다. App Store Connect에서 이름을 정리해 주세요.`);
  let group = groups[0];
  if (group) {
    const existing = await collectPages(context,
      `${API}/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptions?filter[productId]=${encodeURIComponent(productId)}&limit=200`, headers, '구독 목록');
    if (existing.some(item => textAttribute(item, 'productId') === productId)) {
      throw new AppError('PRODUCT_EXISTS', '같은 상품 ID의 구독이 이미 있습니다. 상품 변경 작업을 사용해 주세요.');
    }
  } else {
    group = one(await context.request<JsonApiDocument>(`${API}/v1/subscriptionGroups`, {
      method: 'POST', headers, write: true,
      json: { data: { type: 'subscriptionGroups', attributes: { referenceName: groupName }, relationships: { app: { data: { type: 'apps', id: app.id } } } } },
    }), '구독 그룹 생성');
  }
  context.checkpoint({ appleSubscriptionGroupId: group.id, bundleId: app.bundleId, territory, currency, phase: 'group-ready' });
  const created = one(await context.request<JsonApiDocument>(`${API}/v1/subscriptions`, {
    method: 'POST', headers, write: true,
    json: {
      data: {
        type: 'subscriptions',
        attributes: { name, productId, subscriptionPeriod },
        relationships: { group: { data: { type: 'subscriptionGroups', id: group.id } } },
      },
    },
  }), '구독 생성');
  const resource = subscriptionResource(created, app.bundleId, group);
  context.checkpoint({ appleSubscriptionId: created.id, externalId: resource.externalId, phase: 'subscription-created' });
  let applied: { customerPrice: string; subscriptionPriceId: string };
  try {
    applied = await applySubscriptionPrice(context, created.id, territory, priceMicros, false);
  } catch (error) {
    // Price points exist only after the subscription exists; keep the created ID addressable.
    if (error instanceof AppError && error.code === 'PRICE_POINT_REQUIRED') {
      throw new AppError('PRICE_POINT_REQUIRED', `${error.message} 구독(${productId})은 생성되었으며, 사용 가능한 금액으로 update-product를 실행하면 가격이 설정됩니다.`, 422,
        { ...(typeof error.details === 'object' ? error.details : {}), createdSubscriptionId: created.id, externalId: resource.externalId });
    }
    throw error;
  }
  resource.data = { ...resource.data, currency, territory, appliedCustomerPrice: applied.customerPrice };
  return {
    resources: [resource],
    summary: {
      externalId: resource.externalId, externalIds: { subscriptionId: created.id, subscriptionGroupId: group.id, subscriptionPriceId: applied.subscriptionPriceId },
      productId, subscriptionGroupReused: groups.length === 1, subscriptionPeriod, territory, currency,
      requestedPriceMicros: priceMicros.toString(), appliedCustomerPrice: applied.customerPrice, state: resource.status,
    },
  };
}

export async function updateAppleSubscriptionPrice(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const id = subscriptionId(input.externalId);
  if (input.priceMicros === undefined) throw new AppError('INVALID_INPUT', '변경할 항목이 없습니다. priceMicros를 지정해 주세요.');
  const priceMicros = microsInput(input.priceMicros);
  const currency = text(input.currency, '가격 통화', 3).toUpperCase();
  // Existing subscribers keep their price unless the caller explicitly opts out.
  const preserveCurrentPrice = input.preserveCurrentPrice !== false && input.preserveCurrentPrice !== 'false';
  const headers = await appleAuthHeaders(context);
  const { subscription } = await requireOwnedSubscription(context, id, headers);
  const territory = await resolveTerritoryForCurrency(context, currency);
  const applied = await applySubscriptionPrice(context, id, territory, priceMicros, preserveCurrentPrice);
  context.checkpoint({ appleSubscriptionId: id, externalId: SUBSCRIPTION_PREFIX + id, appleSubscriptionPriceId: applied.subscriptionPriceId });
  return {
    summary: {
      externalId: SUBSCRIPTION_PREFIX + id, externalIds: { subscriptionId: id, subscriptionPriceId: applied.subscriptionPriceId },
      productId: textAttribute(subscription, 'productId'), requestedPriceMicros: priceMicros.toString(),
      appliedCustomerPrice: applied.customerPrice, territory, currency, preserveCurrentPrice,
    },
  };
}

/** Submits an IAP (inAppPurchaseSubmissions) or auto-renewable subscription (subscriptionSubmissions) for review. */
export async function submitAppleProduct(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const headers = await appleAuthHeaders(context);
  const subscription = isAppleSubscriptionId(input.externalId);
  let id: string; let item: JsonApiResource; let bundleId: string;
  if (subscription) {
    id = subscriptionId(input.externalId);
    const owned = await requireOwnedSubscription(context, id, headers);
    item = owned.subscription; bundleId = owned.app.bundleId;
  } else {
    id = resourceId(input.externalId, '인앱 상품 ID');
    const app = await resolveAppleApp(context);
    item = one(await context.request<JsonApiDocument>(`${API}/v2/inAppPurchases/${encodeURIComponent(id)}`, { headers }), '인앱 상품 조회');
    // InAppPurchaseV2 exposes no app relationship; ownership is proven through the app's own IAP collection.
    const owned = await collectPages(context,
      `${API}/v1/apps/${encodeURIComponent(app.id)}/inAppPurchasesV2?filter[productId]=${encodeURIComponent(textAttribute(item, 'productId'))}&limit=200`, headers, '인앱 상품 목록');
    if (!owned.some(product => product.id === id)) throw new AppError('RESOURCE_MISMATCH', '선택한 인앱 상품이 연결된 앱에 속하지 않습니다.');
    bundleId = app.bundleId;
  }
  const externalId = subscription ? SUBSCRIPTION_PREFIX + id : id;
  const before = textAttribute(item, 'state') || 'UNKNOWN';
  const resource = (state: string): ResourceInput => ({
    kind: 'product', externalId, name: textAttribute(item, 'name') || textAttribute(item, 'productId'), status: state,
    data: { bundleId, productId: textAttribute(item, 'productId'), productType: subscription ? 'subscription' : 'in-app' },
  });
  if (SUBMITTED_STATES.has(before)) {
    return { resources: [resource(before)], summary: { externalId, state: before, alreadySubmitted: true, submitted: false } };
  }
  if (before !== 'READY_TO_SUBMIT' && before !== 'DEVELOPER_ACTION_NEEDED' && before !== 'REJECTED') {
    throw new AppError('INVALID_INPUT', `심사 제출은 READY_TO_SUBMIT 상태에서만 가능합니다. 현재 상태: ${before}. 현지화·가격·심사 스크린샷을 먼저 완성해 주세요.`);
  }
  const created = one(await context.request<JsonApiDocument>(`${API}/v1/${subscription ? 'subscriptionSubmissions' : 'inAppPurchaseSubmissions'}`, {
    method: 'POST', headers, write: true,
    json: subscription
      ? { data: { type: 'subscriptionSubmissions', relationships: { subscription: { data: { type: 'subscriptions', id } } } } }
      : { data: { type: 'inAppPurchaseSubmissions', relationships: { inAppPurchaseV2: { data: { type: 'inAppPurchases', id } } } } },
  }), '상품 심사 제출');
  context.checkpoint({ externalId, appleProductSubmissionId: created.id, phase: 'submitted' });
  const after = one(await context.request<JsonApiDocument>(
    subscription ? `${API}/v1/subscriptions/${encodeURIComponent(id)}` : `${API}/v2/inAppPurchases/${encodeURIComponent(id)}`, { headers }), '제출 후 상태 조회');
  const state = textAttribute(after, 'state') || 'UNKNOWN';
  return {
    resources: [resource(state)],
    // The created submission is the confirmed effect; review progress is observed later through list-products.
    summary: { externalId, submissionId: created.id, previousState: before, state, submitted: true, stateUpdated: SUBMITTED_STATES.has(state) },
  };
}
