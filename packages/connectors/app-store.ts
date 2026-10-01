import { AppError, text } from '../domain/errors.js';
import type { Capability } from '../domain/index.js';
import { decimalToMicros, parseGzipTsv, readFileSlice, readIpaMetadata } from './store-tools.js';
import { findExactPricePoint, microsInput, resolveTerritoryForCurrency } from './apple-pricing.js';
import type { Connector, ConnectorContext, ConnectorResult, MetricInput, ResourceInput } from './types.js';
import {
  APP_STORE_API as API, appleAuthHeaders as authHeaders, attribute, many, one,
  resolveAppleApp as resolveApp, textAttribute, type JsonApiDocument, type JsonApiResource,
} from './store-jsonapi.js';
import {
  createAppleBetaGroup, createAppleVersion, distributeAppleBuild, linkAppleBuild, listAppleBetaGroups,
  listAppleListings, listAppleReviewSubmissions, prepareAppleApp, reconcileAppleReview, releaseAppleVersion,
  submitAppleReview, updateAppleAppInfo, updateAppleListing,
} from './store-apple-ops.js';
import { APPLE_SCREENSHOT_DISPLAY_TYPES, reconcileAppleScreenshot, uploadAppleScreenshot } from './apple-media.js';
import { APPLE_PREVIEW_TYPES, reconcileApplePreview, uploadApplePreview } from './apple-previews.js';
import {
  createAppleSubscription, isAppleSubscriptionId, listAppleSubscriptions, submitAppleProduct, updateAppleSubscriptionPrice,
} from './apple-subscriptions.js';
import { collectAppleFinance } from './apple-finance.js';

// Official host. Binary build parts are PUT to the exact URLs Apple returns in
// uploadOperations[]; the transport pins those per operation (coordinator contract).

const PRODUCT_TYPES: Record<string, string> = {
  consumable: 'CONSUMABLE',
  'non-consumable': 'NON_CONSUMABLE',
  non_consumable: 'NON_CONSUMABLE',
  'non-renewing-subscription': 'NON_RENEWING_SUBSCRIPTION',
};

// BuildUpload.attributes.state is an object per the official OpenAPI spec
// (verified 2026-09-11, spec 4.4.1): { state: BuildUploadState, errors[],
// warnings[], infos[] } with BuildUploadState in
// AWAITING_UPLOAD | PROCESSING | FAILED | COMPLETE.
interface UploadStateInfo { state: string; confirmed: boolean; failed: boolean; details: Array<{ code: string; description: string }> }

function parseUploadState(resource: JsonApiResource): UploadStateInfo {
  const raw = attribute(resource, 'state');
  const stateObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const state = typeof stateObject.state === 'string' && stateObject.state !== '' ? stateObject.state : 'UNKNOWN';
  const details: Array<{ code: string; description: string }> = [];
  for (const level of ['errors', 'warnings'] as const) {
    if (!Array.isArray(stateObject[level])) continue;
    for (const item of stateObject[level] as Array<Record<string, unknown>>) {
      details.push({
        code: typeof item.code === 'string' ? item.code : level,
        description: typeof item.description === 'string' ? item.description : '',
      });
    }
  }
  return { state, confirmed: state === 'COMPLETE', failed: state === 'FAILED', details };
}

async function readBuildUploadState(context: ConnectorContext, buildUploadId: string): Promise<UploadStateInfo> {
  const document = await context.request<JsonApiDocument>(
    `${API}/v1/buildUploads/${encodeURIComponent(buildUploadId)}`,
    { headers: await authHeaders(context) },
  );
  return parseUploadState(one(document, '빌드 업로드 상태'));
}

interface UploadOperation { method: string; url: string; offset: number; length: number; requestHeaders: Record<string, string> }

function parseUploadOperations(resource: JsonApiResource): UploadOperation[] {
  const raw = attribute(resource, 'uploadOperations');
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError('INVALID_PROVIDER_RESPONSE', '업로드 준비 응답에 uploadOperations가 없습니다.', 502);
  }
  return raw.map(item => {
    const operation = item as Record<string, unknown>;
    const url = typeof operation.url === 'string' ? operation.url : '';
    const offset = typeof operation.offset === 'number' ? operation.offset : Number.NaN;
    const length = typeof operation.length === 'number' ? operation.length : Number.NaN;
    if (!url.startsWith('https://') || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
      throw new AppError('INVALID_PROVIDER_RESPONSE', '업로드 지시 형식을 해석할 수 없습니다.', 502);
    }
    const requestHeaders: Record<string, string> = {};
    if (Array.isArray(operation.requestHeaders)) {
      for (const header of operation.requestHeaders as Array<Record<string, unknown>>) {
        if (typeof header.name === 'string' && typeof header.value === 'string') requestHeaders[header.name] = header.value;
      }
    }
    return { method: typeof operation.method === 'string' ? operation.method : 'PUT', url, offset, length, requestHeaders };
  });
}

async function uploadBuild(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const buildRunId = text(input.importedArtifactId ?? input.buildRunId, '결과물 ID', 100);
  const track = input.track === undefined ? 'internal' : text(input.track, 'track', 50);
  if (track !== 'internal') {
    throw new AppError('UNSUPPORTED_OPERATION', 'App Store 빌드 업로드는 현재 internal 트랙(업로드 후 TestFlight 처리 대기)만 지원합니다. 외부 테스터 배포와 심사 제출은 별도 지원 예정입니다.');
  }
  const artifact = context.artifact;
  if (!artifact || artifact.kind === 'directory') {
    throw new AppError('MISSING_REQUIREMENT', '업로드할 검증된 빌드 결과물이 없습니다. buildRunId가 서명된 iOS 빌드를 가리키는지 확인해 주세요.');
  }
  if (artifact.name.endsWith('.pkg')) {
    throw new AppError('UNSUPPORTED_OPERATION', 'macOS .pkg 업로드는 아직 지원하지 않습니다. 현재는 iOS .ipa만 업로드할 수 있습니다.');
  }
  if (!artifact.name.endsWith('.ipa')) {
    throw new AppError('INVALID_INPUT', `App Store 업로드 대상은 .ipa 파일이어야 합니다 (현재: ${artifact.name}).`);
  }

  const metadata = await readIpaMetadata(artifact.path);
  const app = await resolveApp(context);
  if (metadata.bundleId !== app.bundleId) {
    throw new AppError('INVALID_INPUT', `.ipa의 bundle ID(${metadata.bundleId})가 대상 앱(${app.bundleId})과 다릅니다. 다른 앱의 빌드를 업로드하지 않도록 중단했습니다.`);
  }
  context.progress(`업로드 준비: ${app.name} ${metadata.shortVersion} (${metadata.buildVersion})`);

  const headers = await authHeaders(context);
  const buildUpload = one(
    await context.request<JsonApiDocument>(`${API}/v1/buildUploads`, {
      method: 'POST',
      headers,
      write: true,
      json: {
        data: {
          type: 'buildUploads',
          attributes: {
            cfBundleShortVersionString: metadata.shortVersion,
            cfBundleVersion: metadata.buildVersion,
            platform: 'IOS',
          },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      },
    }),
    '빌드 업로드 생성',
  );
  context.checkpoint({ appleBuildUploadId: buildUpload.id });

  const uploadFile = one(
    await context.request<JsonApiDocument>(`${API}/v1/buildUploadFiles`, {
      method: 'POST',
      headers,
      write: true,
      json: {
        data: {
          type: 'buildUploadFiles',
          attributes: { assetType: 'ASSET', fileName: artifact.name, fileSize: artifact.size, uti: 'com.apple.ipa' },
          relationships: { buildUpload: { data: { type: 'buildUploads', id: buildUpload.id } } },
        },
      },
    }),
    '업로드 파일 등록',
  );
  context.checkpoint({ appleBuildUploadId: buildUpload.id, appleBuildUploadFileId: uploadFile.id });

  const operations = parseUploadOperations(uploadFile);
  let sent = 0;
  for (const operation of operations) {
    context.signal.throwIfAborted();
    const part = await readFileSlice(artifact.path, operation.offset, operation.length);
    await context.request<string>(operation.url, {
      method: operation.method as 'PUT',
      headers: operation.requestHeaders,
      body: new Uint8Array(part),
      write: true,
      format: 'text',
    });
    sent += operation.length;
    context.progress(`바이너리 업로드 ${Math.min(100, Math.round((sent / artifact.size) * 100))}%`);
  }

  // Checksums shape per official spec: { file: { hash, algorithm: MD5|SHA_256 } }.
  // The verified artifact's SHA-256 is reused so the uploaded bytes are pinned
  // to exactly what the controller verified.
  await context.request<JsonApiDocument>(`${API}/v1/buildUploadFiles/${encodeURIComponent(uploadFile.id)}`, {
    method: 'PATCH',
    headers,
    write: true,
    json: {
      data: {
        type: 'buildUploadFiles',
        id: uploadFile.id,
        attributes: { uploaded: true, sourceFileChecksums: { file: { hash: artifact.sha256, algorithm: 'SHA_256' } } },
      },
    },
  });

  const uploadState = await readBuildUploadState(context, buildUpload.id);
  if (uploadState.failed) {
    throw new AppError('PROVIDER_REJECTED', 'App Store Connect가 빌드 업로드를 실패로 보고했습니다. 서명과 빌드 구성을 확인해 주세요.', 422, uploadState.details);
  }
  const resource: ResourceInput = {
    kind: 'release',
    externalId: buildUpload.id,
    name: `${app.bundleId} ${metadata.shortVersion} (${metadata.buildVersion})`,
    status: uploadState.state,
    data: { buildRunId, platform: 'IOS', bundleId: app.bundleId, track },
  };
  return {
    summary: {
      externalIds: { buildUploadId: buildUpload.id, buildUploadFileId: uploadFile.id },
      state: uploadState.state,
      confirmed: uploadState.confirmed,
      failed: false,
      uploadedBytes: artifact.size,
      cfBundleShortVersionString: metadata.shortVersion,
      cfBundleVersion: metadata.buildVersion,
      note: 'Apple 처리(멀웨어 검사·자산 검증)가 끝날 때까지 TestFlight에 나타나지 않습니다.',
    },
    resources: [resource],
    waitingExternal: !uploadState.confirmed,
  };
}

// Root passes checkpoint.appleBuildUploadId as input.externalId and treats a
// run as succeeded only when summary.confirmed is true; FAILED must never be
// reported as confirmed.
async function reconcileBuildUpload(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const buildUploadId = text(input.externalId, 'externalId', 200);
  const uploadState = await readBuildUploadState(context, buildUploadId);
  return {
    summary: {
      externalIds: { buildUploadId },
      state: uploadState.state,
      confirmed: uploadState.confirmed,
      failed: uploadState.failed,
      stateDetails: uploadState.details,
    },
    waitingExternal: !uploadState.confirmed && !uploadState.failed,
  };
}

async function applyPriceSchedule(
  context: ConnectorContext,
  inAppPurchaseId: string,
  territory: string,
  priceMicros: bigint,
): Promise<{ customerPrice: string }> {
  const point = await findExactPricePoint(
    context,
    `${API}/v2/inAppPurchases/${encodeURIComponent(inAppPurchaseId)}/pricePoints?filter[territory]=${encodeURIComponent(territory)}&limit=200`,
    territory,
    priceMicros,
  );
  await context.request<JsonApiDocument>(`${API}/v1/inAppPurchasePriceSchedules`, {
    method: 'POST',
    headers: await authHeaders(context),
    write: true,
    json: {
      data: {
        type: 'inAppPurchasePriceSchedules',
        relationships: {
          inAppPurchase: { data: { type: 'inAppPurchases', id: inAppPurchaseId } },
          baseTerritory: { data: { type: 'territories', id: territory } },
          manualPrices: { data: [{ type: 'inAppPurchasePrices', id: '${price-1}' }] },
        },
      },
      included: [
        {
          type: 'inAppPurchasePrices',
          id: '${price-1}',
          attributes: { startDate: null, endDate: null },
          relationships: {
            inAppPurchaseV2: { data: { type: 'inAppPurchases', id: inAppPurchaseId } },
            inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: point.id } },
          },
        },
      ],
    },
  });
  return { customerPrice: point.customerPrice };
}

async function createProduct(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const productId = text(input.productId, 'productId', 200);
  const name = text(input.name, 'name', 64);
  const typeKey = text(input.type, 'type', 50);
  const mappedType = PRODUCT_TYPES[typeKey];
  if (!mappedType) {
    throw new AppError('INVALID_INPUT', `지원하지 않는 상품 유형입니다: ${typeKey}. 사용 가능: ${Object.keys(PRODUCT_TYPES).join(', ')}`);
  }
  const currency = text(input.currency, 'currency', 3).toUpperCase();
  const priceMicros = microsInput(input.priceMicros);
  // All read-side prerequisites (app match, currency→territory via official
  // metadata) are validated before the first external mutation.
  const app = await resolveApp(context);
  const territory = await resolveTerritoryForCurrency(context, currency);

  const created = one(
    await context.request<JsonApiDocument>(`${API}/v2/inAppPurchases`, {
      method: 'POST',
      headers: await authHeaders(context),
      write: true,
      json: {
        data: {
          type: 'inAppPurchases',
          attributes: { name, productId, inAppPurchaseType: mappedType },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      },
    }),
    '인앱 상품 생성',
  );
  context.checkpoint({ appleInAppPurchaseId: created.id, bundleId: app.bundleId, territory, currency });
  let applied: { customerPrice: string };
  try {
    applied = await applyPriceSchedule(context, created.id, territory, priceMicros);
  } catch (error) {
    // Apple exposes an IAP's price points only after the IAP exists, so an
    // exact-price miss leaves a created product without a schedule. The
    // checkpoint above and these details keep that partial state addressable.
    if (error instanceof AppError && error.code === 'PRICE_POINT_REQUIRED') {
      throw new AppError(
        'PRICE_POINT_REQUIRED',
        `${error.message} 상품(${productId})은 생성되었으며, 사용 가능한 금액으로 update-product를 실행하면 가격이 설정됩니다.`,
        422,
        { ...(typeof error.details === 'object' ? error.details : {}), createdInAppPurchaseId: created.id },
      );
    }
    throw error;
  }
  return {
    summary: {
      externalIds: { inAppPurchaseId: created.id },
      productId,
      requestedPriceMicros: priceMicros.toString(),
      appliedCustomerPrice: applied.customerPrice,
      territory,
    },
    resources: [{
      kind: 'product',
      externalId: created.id,
      name,
      status: textAttribute(created, 'state') || 'CREATED',
      data: { productId, type: typeKey, currency, bundleId: app.bundleId, appliedCustomerPrice: applied.customerPrice },
    }],
  };
}

async function updateProduct(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const inAppPurchaseId = text(input.externalId, 'externalId', 200);
  if (input.status !== undefined) {
    throw new AppError('UNSUPPORTED_OPERATION', 'Apple 인앱 상품의 상태 전환은 심사 제출 절차를 통해서만 진행됩니다. submit-product 작업으로 심사에 제출해 주세요.');
  }
  if (input.priceMicros === undefined) {
    throw new AppError('INVALID_INPUT', '변경할 항목이 없습니다. priceMicros를 지정해 주세요.');
  }
  const priceMicros = microsInput(input.priceMicros);
  const headers = await authHeaders(context);
  // Spec-valid two-hop lookup (the single /iapPriceSchedule/baseTerritory
  // path does not exist in the official OpenAPI spec): schedule id first,
  // then its baseTerritory, whose metadata carries the currency.
  let territory = '';
  let currency = '';
  try {
    const schedule = one(
      await context.request<JsonApiDocument>(
        `${API}/v2/inAppPurchases/${encodeURIComponent(inAppPurchaseId)}/iapPriceSchedule`,
        { headers },
      ),
      '가격 일정 조회',
    );
    const base = one(
      await context.request<JsonApiDocument>(
        `${API}/v1/inAppPurchasePriceSchedules/${encodeURIComponent(schedule.id)}/baseTerritory`,
        { headers },
      ),
      '기준 지역 조회',
    );
    territory = base.id;
    currency = textAttribute(base, 'currency');
  } catch (error) {
    if (error instanceof AppError && error.code === 'RESOURCE_NOT_FOUND') {
      currency = text(input.currency, '최초 가격 통화', 3).toUpperCase();
      territory = await resolveTerritoryForCurrency(context, currency);
    } else {
      throw error;
    }
  }
  if (input.currency !== undefined && String(input.currency).toUpperCase() !== currency) {
    throw new AppError('CURRENCY_MISMATCH', `이 상품의 기준 통화는 ${currency}입니다. 동일 통화의 가격으로 변경해 주세요.`);
  }
  const applied = await applyPriceSchedule(context, inAppPurchaseId, territory, priceMicros);
  return {
    summary: {
      externalIds: { inAppPurchaseId },
      requestedPriceMicros: priceMicros.toString(),
      appliedCustomerPrice: applied.customerPrice,
      territory,
      currency,
    },
  };
}

async function listProducts(context: ConnectorContext): Promise<ConnectorResult> {
  const app = await resolveApp(context);
  const records: JsonApiResource[] = []; let next = `${API}/v1/apps/${encodeURIComponent(app.id)}/inAppPurchasesV2?limit=200`;
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next) || visited.size >= 100) throw new AppError('PAGINATION_LIMIT', '앱 상품 목록의 조회 한도를 넘었습니다.');
    visited.add(next);
    const document = await context.request<JsonApiDocument>(next, { headers: await authHeaders(context) });
    records.push(...many(document)); next = typeof document.links?.next === 'string' ? document.links.next : '';
  }
  const resources: ResourceInput[] = records.map(item => ({
    kind: 'product',
    externalId: item.id,
    name: textAttribute(item, 'name') || textAttribute(item, 'productId'),
    status: textAttribute(item, 'state') || 'UNKNOWN',
    data: { bundleId: app.bundleId, productId: textAttribute(item, 'productId'), productType: 'in-app', type: textAttribute(item, 'inAppPurchaseType') },
  }));
  const subscriptions = await listAppleSubscriptions(context, app);
  resources.push(...subscriptions);
  return { summary: { app: app.bundleId, products: resources.length, subscriptions: subscriptions.length }, resources };
}

async function listReleases(context: ConnectorContext): Promise<ConnectorResult> {
  const app = await resolveApp(context);
  const headers = await authHeaders(context);
  const versions = many(await context.request<JsonApiDocument>(
    `${API}/v1/apps/${encodeURIComponent(app.id)}/appStoreVersions?limit=50`,
    { headers },
  ));
  const builds = many(await context.request<JsonApiDocument>(
    `${API}/v1/builds?filter[app]=${encodeURIComponent(app.id)}&sort=-uploadedDate&limit=20`,
    { headers },
  ));
  const resources: ResourceInput[] = versions.map(version => ({
    kind: 'release',
    externalId: version.id,
    name: `${app.bundleId} ${textAttribute(version, 'versionString')}`,
    status: textAttribute(version, 'appStoreState') || textAttribute(version, 'appVersionState') || 'UNKNOWN',
    data: { bundleId: app.bundleId, appStoreVersionId:version.id, versionString:textAttribute(version,'versionString'), platform: textAttribute(version, 'platform'), createdDate: textAttribute(version, 'createdDate') },
  }));
  return {
    summary: {
      app: app.bundleId,
      versions: resources.length,
      recentBuilds: builds.map(build => ({
        id: build.id,
        version: textAttribute(build, 'version'),
        processingState: textAttribute(build, 'processingState'),
      })),
    },
    resources,
  };
}

async function listApps(context: ConnectorContext): Promise<ConnectorResult> {
  const document = await context.request<JsonApiDocument>(`${API}/v1/apps?limit=200`, { headers: await authHeaders(context) });
  const apps = many(document).map(app => ({
    id: app.id,
    name: textAttribute(app, 'name'),
    bundleId: textAttribute(app, 'bundleId'),
    sku: textAttribute(app, 'sku'),
  }));
  return { summary: { apps, count: apps.length } };
}

async function syncSales(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const vendorNumber = context.credentials.vendorNumber;
  if (!vendorNumber) {
    throw new AppError('MISSING_REQUIREMENT', '매출 수집에는 App Store Connect 지급 화면의 vendor number가 필요합니다. 연결 설정에 vendorNumber를 추가해 주세요.');
  }
  const headers = await authHeaders(context, { Accept: 'application/a-gzip' });
  const metrics: MetricInput[] = [];
  const collectedDates: string[] = [];
  const missingDates: string[] = [];
  for (let daysAgo = 1; daysAgo <= 5; daysAgo += 1) {
    context.signal.throwIfAborted();
    const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let bytes: Buffer;
    try {
      bytes = await context.request<Buffer>(
        `${API}/v1/salesReports?filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&filter[reportDate]=${date}&filter[vendorNumber]=${encodeURIComponent(vendorNumber)}`,
        { headers, format: 'bytes' },
      );
    } catch (error) {
      // Reports for very recent dates are commonly not generated yet.
      if (error instanceof AppError && (error.code === 'RESOURCE_NOT_FOUND' || error.code === 'PROVIDER_REJECTED')) {
        missingDates.push(date);
        continue;
      }
      throw error;
    }
    const rows = parseGzipTsv(bytes);
    const totals = new Map<string, bigint>();
    for (const row of rows) {
      const units = Number(row.Units ?? '0');
      const proceeds = row['Developer Proceeds'];
      const currency = row['Currency of Proceeds'];
      if (!currency || !proceeds || !Number.isFinite(units)) continue;
      const amount = decimalToMicros(proceeds) * BigInt(Math.trunc(units));
      totals.set(currency, (totals.get(currency) ?? 0n) + amount);
    }
    for (const [currency, amount] of totals) {
      metrics.push({
        date,
        currency,
        kind: 'revenue',
        amountMicros: amount.toString(),
        basis: 'proceeds',
        sourceId: `apple:sales:${vendorNumber}:${date}:${currency}`,
      });
    }
    collectedDates.push(date);
  }
  const finance = await collectAppleFinance(input, context, vendorNumber);
  return {
    summary: {
      collectedDates,
      missingDates,
      note: '일별 SALES SUMMARY 보고서의 Developer Proceeds 합계(proceeds)와 월별 FINANCIAL 정산 보고서(settled)를 별도 sourceId로 수집합니다. 같은 기간을 합산하지 말고 정산값을 우선해야 합니다.',
      ...finance.summary,
    },
    metrics: [...metrics, ...(finance.metrics ?? [])],
    metricSourcePrefixes: finance.metricSourcePrefixes,
  };
}

async function check(context: ConnectorContext): Promise<ConnectorResult> {
  const document = await context.request<JsonApiDocument>(`${API}/v1/apps?limit=1`, { headers: await authHeaders(context) });
  many(document);
  return {
    summary: {
      ok: true,
      salesConfigured: Boolean(context.credentials.vendorNumber),
      note: context.credentials.vendorNumber ? undefined : '매출 수집(sync)을 쓰려면 vendorNumber를 추가해 주세요.',
    },
  };
}

const capability: Capability = {
  provider: 'app-store',
  name: 'App Store Connect',
  category: 'store',
  description: 'App Store Connect API 키로 앱 조회, iOS 빌드 업로드(TestFlight 처리), 스토어 자료·스크린샷·미리보기 동영상·심사·출시, 인앱 상품·자동 갱신 구독 관리, 일별 매출과 월별 정산 수집을 수행합니다.',
  authKind: 'api-key-jwt',
  operationFields: {
    'create-product': [
      { key: 'type', options: [{ value: 'consumable', label: '소비성' }, { value: 'non-consumable', label: '비소비성' }, { value: 'non-renewing-subscription', label: '자동 갱신 없는 구독' }] },
      { key: 'billingPeriod', remove: true }, { key: 'description', remove: true }, { key: 'language', remove: true }, { key: 'country', remove: true },
      { key: 'priceMicros', hint: '통화에 맞는 기준 지역에서 정확히 일치하는 Apple 가격 포인트를 사용합니다.' },
    ],
    'update-product': [{ key: 'priceMicros', required: true, hint: '인앱 상품은 기존 기준 통화와 같은 통화, 자동 갱신 구독은 가격을 바꿀 지역의 통화를 선택합니다.' }, { key: 'status', remove: true }, { key: 'description', remove: true }],
    'create-subscription': [
      { key: 'subscriptionGroup', label: '구독 그룹 참조 이름', required: true, hint: '같은 참조 이름의 그룹이 있으면 재사용하고 없으면 만듭니다.' },
      { key: 'productId', label: '상품 ID', required: true, placeholder: 'com.company.app.premium.monthly' },
      { key: 'name', label: '참조 이름', required: true, hint: '최대 64자. App Store Connect 내부 표시용입니다.' },
      { key: 'billingPeriod', label: '구독 기간', type: 'select', required: true, options: [
        { value: 'P1W', label: '1주' }, { value: 'P1M', label: '1개월' }, { value: 'P2M', label: '2개월' },
        { value: 'P3M', label: '3개월' }, { value: 'P6M', label: '6개월' }, { value: 'P1Y', label: '1년' },
      ] },
      { key: 'priceMicros', label: '가격', type: 'money', required: true, hint: '통화의 기준 지역에서 정확히 일치하는 Apple 가격 포인트만 사용합니다.' },
    ],
    'submit-product': [{ key: 'priceMicros', remove: true }, { key: 'status', remove: true }, { key: 'description', remove: true }],
    'upload-app-preview': [
      { key: 'appStoreVersionId', label: '앱 스토어 버전 ID', required: true, hint: 'list-releases에서 확인한 정확한 버전 ID입니다.' },
      { key: 'locale', label: '로케일', required: true, placeholder: 'ko', hint: '해당 현지화가 있어야 합니다.' },
      { key: 'previewType', label: '미리보기 유형', type: 'select', required: true, options: APPLE_PREVIEW_TYPES.map(value => ({ value, label: value })), hint: '.mov/.m4v/.mp4, 500MB 이하, 15–30초, 기기 유형별 최대 3개. 컨트롤러가 검증한 프로젝트 동영상만 사용합니다.' },
      { key: 'previewFrameTimeCode', label: '포스터 프레임 (선택)', placeholder: '00:00:05:00', hint: '비우면 Apple 기본값(5초)을 사용합니다.' },
      { key: 'localizationId', label: '현지화 ID (선택)', hint: '있으면 소유권을 확인합니다. 없으면 버전+로케일로 찾습니다.' },
    ],
    'sync': [{ key: 'financeMonth', label: '정산 보고서 월 (선택)', placeholder: '2026-08', hint: 'Apple 회계 월(YYYY-MM)입니다. 비우면 최근 3개월을 다시 수집해 같은 월의 정산값을 교체합니다.' }],
    'list-listings': [{ key: 'appStoreVersionId', label: '앱 스토어 버전 ID', hint: '비우면 최근 버전의 현지화를 모두 조회합니다. 정확한 버전 ID를 권장합니다.' }],
    'upload-listing-image': [
      { key: 'appStoreVersionId', label: '앱 스토어 버전 ID', required: true, hint: 'list-releases에서 확인한 정확한 버전 ID입니다.' },
      { key: 'locale', label: '로케일', required: true, placeholder: 'ko', hint: '예: ko, ja, en-US. 해당 현지화가 있어야 합니다.' },
      { key: 'screenshotDisplayType', label: '표시 유형', type: 'select', required: true, options: APPLE_SCREENSHOT_DISPLAY_TYPES.map(value => ({ value, label: value })), hint: '공식 Screenshot Display Type. PNG/JPEG, 알파 없음, 해당 유형의 공식 픽셀 크기. 컨트롤러가 검증한 프로젝트 미디어만 사용합니다.' },
      { key: 'localizationId', label: '현지화 ID (선택)', hint: '있으면 소유권을 확인합니다. 없으면 버전+로케일로 찾습니다.' },
    ],
    'list-beta-groups': [{ key: 'appStoreVersionId', remove: true }],
    'update-listing': [
      { key: 'appStoreVersionId', label: '앱 스토어 버전 ID', required: true, hint: 'list-releases 또는 list-listings에서 확인한 정확한 ID를 입력합니다.' },
      { key: 'locale', label: '로케일', required: true, placeholder: 'ko', hint: '예: ko, ja, en-US.' },
      { key: 'localizationId', label: '현지화 ID (수정 시)', hint: '있으면 PATCH, 없으면 해당 로케일을 생성합니다.' },
      { key: 'description', label: '설명', type: 'textarea' },
      { key: 'whatsNew', label: '새로운 기능', type: 'textarea' },
      { key: 'keywords', label: '키워드', hint: '쉼표로 구분, 최대 100자.' },
      { key: 'promotionalText', label: '프로모션 문구' },
      { key: 'marketingUrl', label: '마케팅 URL' },
      { key: 'supportUrl', label: '지원 URL' },
    ],
    'update-app-info': [
      { key: 'locale', label: '로케일', required: true, placeholder: 'ko' },
      { key: 'localizationId', label: '앱 정보 현지화 ID (수정 시)' },
      { key: 'name', label: '앱 이름', hint: '최대 30자. 신규 현지화에는 필수입니다.' },
      { key: 'subtitle', label: '부제' },
      { key: 'privacyPolicyUrl', label: '개인정보 처리방침 URL' },
    ],
    'create-version': [
      { key: 'versionString', label: '버전', required: true, placeholder: '1.2.0' },
      { key: 'platform', label: '플랫폼', type: 'select', required: true, options: [
        { value: 'IOS', label: 'iOS' }, { value: 'MAC_OS', label: 'macOS' }, { value: 'TV_OS', label: 'tvOS' }, { value: 'VISION_OS', label: 'visionOS' },
      ] },
      { key: 'copyright', label: '저작권' },
      { key: 'releaseType', label: '출시 방식', type: 'select', options: [
        { value: 'MANUAL', label: '심사 후 수동 출시' }, { value: 'AFTER_APPROVAL', label: '승인 후 자동 출시' }, { value: 'SCHEDULED', label: '예약 출시' },
      ] },
      { key: 'buildId', label: '연결할 빌드 ID' },
    ],
    'create-beta-group': [
      { key: 'name', label: '그룹 이름', required: true },
      { key: 'isInternalGroup', label: '내부 그룹', type: 'select', options: [{ value: 'true', label: '내부' }, { value: 'false', label: '외부' }] },
    ],
    'distribute-build': [
      { key: 'betaGroupId', label: 'TestFlight 그룹 ID', required: true },
      { key: 'buildId', label: '빌드 ID', required: true, hint: '처리가 끝난 TestFlight 빌드 ID입니다. 업로드 ID가 아닙니다.' },
    ],
    'link-build': [
      { key: 'appStoreVersionId', label: '앱 스토어 버전 ID', required: true },
      { key: 'buildId', label: '빌드 ID', required: true },
    ],
    'submit-review': [
      { key: 'appStoreVersionId', label: '앱 스토어 버전 ID', required: true, hint: '심사에 넣을 정확한 버전 ID가 필요합니다.' },
      { key: 'platform', label: '플랫폼', type: 'select', options: [
        { value: 'IOS', label: 'iOS' }, { value: 'MAC_OS', label: 'macOS' }, { value: 'TV_OS', label: 'tvOS' }, { value: 'VISION_OS', label: 'visionOS' },
      ] },
    ],
    'list-review-submissions': [{ key: 'platform', label: '플랫폼', type: 'select', options: [
      { value: 'IOS', label: 'iOS' }, { value: 'MAC_OS', label: 'macOS' }, { value: 'TV_OS', label: 'tvOS' }, { value: 'VISION_OS', label: 'visionOS' },
    ] }],
    'release-version': [
      { key: 'appStoreVersionId', label: '앱 스토어 버전 ID', required: true },
      { key: 'action', label: '동작', type: 'select', required: true, options: [
        { value: 'release', label: '수동 출시 (Pending Developer Release)' },
        { value: 'phased-start', label: '단계적 출시 시작' },
        { value: 'phased-pause', label: '단계적 출시 일시 중지' },
        { value: 'phased-complete', label: '단계적 출시 완료' },
      ] },
      { key: 'phasedReleaseId', label: '단계적 출시 ID', hint: '일시 중지/완료 시 필요합니다.' },
    ],
    'create-app': [{ key: 'productId', remove: true }, { key: 'name', remove: true }, { key: 'priceMicros', remove: true }],
  },
  fields: [
    { key: 'keyId', label: 'API Key ID', required: true },
    { key: 'issuerId', label: 'Issuer ID', required: true },
    { key: 'privateKey', label: 'API 개인 키 (.p8 내용)', secret: true, multiline: true, required: true },
    { key: 'vendorNumber', label: 'Vendor Number (매출 보고서용, 선택)', required: false },
    { key: 'appleAppId', label: 'Apple 앱 ID (선택, bundle ID 중복 시)', required: false },
  ],
  operations: [
    'check', 'sync', 'sync-app', 'list-apps', 'list-releases', 'list-products', 'upload-build', 'create-product', 'update-product',
    'create-app', 'create-version', 'list-listings', 'update-listing', 'upload-listing-image', 'update-app-info',
    'list-beta-groups', 'create-beta-group', 'distribute-build', 'link-build',
    'submit-review', 'list-review-submissions', 'release-version',
    'create-subscription', 'submit-product', 'upload-app-preview',
  ],
  setupUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
  limitations: [
    'iOS .ipa 업로드만 지원합니다. macOS .pkg 업로드는 아직 지원하지 않습니다.',
    '업로드 후 Apple 처리(waitingExternal)가 끝나야 TestFlight에 나타납니다.',
    '앱 레코드 생성(POST /v1/apps)은 OpenAPI 4.5에도 없어 App Store Connect에서 직접 만들어야 합니다.',
    '심사 제출·출시·TestFlight 배포는 정확한 appStoreVersionId·buildId·betaGroupId가 필요합니다.',
    '스크린샷은 upload-listing-image(PNG/JPEG), App Preview 동영상은 upload-app-preview(.mov/.m4v/.mp4, 500MB 이하)로 올립니다. 처리 중이면 appScreenshotId 또는 appPreviewId로 reconcile 합니다. 동영상 길이(15–30초)·해상도·코덱은 업로드 전에 검사하지 않고 Apple 처리 결과(videoDeliveryState)로 판정합니다.',
    '인앱 상품·구독 가격은 요청 금액과 정확히 일치하는 Apple 가격 포인트가 있어야 설정됩니다. 불일치 시 사용 가능한 금액을 안내합니다. 판매 상태는 submit-product(심사 제출)로만 전환합니다.',
    '자동 갱신 구독은 기준 지역 1곳의 가격만 설정합니다. 다른 지역 가격·구독/그룹 현지화·심사 스크린샷은 App Store Connect에서 채워야 READY_TO_SUBMIT이 됩니다. 가격 변경은 기본적으로 기존 구독자 가격을 유지(preserveCurrentPrice)합니다.',
    '첫 인앱 상품·구독은 Apple 정책상 새 앱 버전과 함께 심사에 제출해야 할 수 있습니다. submit-product는 READY_TO_SUBMIT 상태의 상품만 제출합니다.',
    '월별 정산(financeReports FINANCIAL·ZZ)은 Finance 역할 키가 필요합니다. 정산값(settled)은 일별 매출(proceeds)과 다른 sourceId(apple-finance:)로 저장되며, 합계에서는 같은 기간의 정산값을 우선해야 합니다. 권한이 없으면 financeStatus=permission_required로 표시하고 일별 매출만 수집합니다.',
    '실계정 검증 전입니다. 요청·응답 형식은 공식 OpenAPI 명세(4.5, 2026-09-24 확인)로 검증했습니다. 포스터 프레임 타임코드 형식은 공식 문서에서 확인하지 못해 HH:MM:SS(:FF)만 허용합니다.',
  ],
};

export const appStoreConnector: Connector = {
  capability,
  async execute(operation, input, context): Promise<ConnectorResult> {
    switch (operation) {
      case 'check': return check(context);
      case 'list-apps': return listApps(context);
      case 'list-releases': return listReleases(context);
      case 'list-products': return listProducts(context);
      case 'sync-app': {
        const releases = await listReleases(context); const products = await listProducts(context);
        return {resources:[...(releases.resources ?? []),...(products.resources ?? [])],summary:{...releases.summary,...products.summary}};
      }
      case 'upload-build': return uploadBuild(input, context);
      case 'reconcile':
        if (input.appScreenshotId) return reconcileAppleScreenshot(input, context);
        if (input.appPreviewId) return reconcileApplePreview(input, context);
        return input.reviewSubmissionId ? reconcileAppleReview(input, context) : reconcileBuildUpload(input, context);
      case 'create-product': return createProduct(input, context);
      case 'update-product':
        if (input.status === undefined && isAppleSubscriptionId(input.externalId)) return updateAppleSubscriptionPrice(input, context);
        return updateProduct(input, context);
      case 'create-subscription': return createAppleSubscription(input, context);
      case 'submit-product': return submitAppleProduct(input, context);
      case 'upload-app-preview': return uploadApplePreview(input, context);
      case 'create-app': return prepareAppleApp(context);
      case 'create-version': return createAppleVersion(input, context);
      case 'list-listings': return listAppleListings(input, context);
      case 'update-listing': return updateAppleListing(input, context);
      case 'upload-listing-image': return uploadAppleScreenshot(input, context);
      case 'update-app-info': return updateAppleAppInfo(input, context);
      case 'list-beta-groups': return listAppleBetaGroups(context);
      case 'create-beta-group': return createAppleBetaGroup(input, context);
      case 'distribute-build': return distributeAppleBuild(input, context);
      case 'link-build': return linkAppleBuild(input, context);
      case 'submit-review': return submitAppleReview(input, context);
      case 'list-review-submissions': return listAppleReviewSubmissions(input, context);
      case 'release-version': return releaseAppleVersion(input, context);
      case 'sync': return syncSales(input, context);
      default:
        throw new AppError('UNSUPPORTED_OPERATION', `App Store 연결이 지원하지 않는 작업입니다: ${operation}`);
    }
  },
};
