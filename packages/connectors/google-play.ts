import { openAsBlob } from 'node:fs';
import { extname } from 'node:path';
import { AppError, text } from '../domain/errors.js';
import { parseMicros } from '../metrics/index.js';
import type { Connector, ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { collectPlayEarnings } from './play-earnings.js';
import { listPlayListings, preparePlayApp, promotePlayRelease, reconcilePlayListingEdit, updatePlayListing, uploadPlayListingImage } from './store-play-edits.js';

const HOST = 'https://androidpublisher.googleapis.com';
const ROOT = HOST + '/androidpublisher/v3/applications/';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
interface ProductRecord {
  packageName: string; productId: string;
  listings?: { title?: string; languageCode?: string; description?: string }[];
  purchaseOptions?: Record<string, unknown>[]; basePlans?: Record<string, unknown>[];
}
interface ReleaseRecord {
  track: string; releaseName?: string; releaseLifecycleState: string;
  activeArtifacts?: { versionCode: number }[];
}

function packageName(ctx: ConnectorContext): string {
  const value = ctx.project?.appIdentifier || ctx.credentials.packageName;
  if (!value || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value)) {
    throw new AppError('APP_IDENTIFIER_REQUIRED', '프로젝트의 Android 패키지 이름 또는 연결의 기본 패키지 이름을 설정해 주세요.');
  }
  return value;
}
function segment(value: unknown, label: string): string {
  const result = text(value, label, 150);
  if (!/^[a-zA-Z0-9_.-]+$/.test(result)) throw new AppError('INVALID_INPUT', `${label} 형식이 올바르지 않습니다.`);
  return result;
}
async function authorization(ctx: ConnectorContext): Promise<Record<string, string>> {
  return { Authorization: 'Bearer ' + await ctx.accessToken([SCOPE]) };
}
function productResource(product: ProductRecord, kind: 'one-time' | 'subscription'): ResourceInput {
  const variants = product.purchaseOptions ?? product.basePlans ?? [];
  return {
    kind: 'product', externalId: `${product.packageName}:${kind}:${product.productId}`,
    name: product.listings?.[0]?.title || product.productId,
    status: String(variants[0]?.state ?? 'DRAFT'),
    data: { packageName: product.packageName, productId: product.productId, productType: kind, listings: product.listings ?? [], variants },
  };
}
async function listProducts(ctx: ConnectorContext): Promise<ConnectorResult> {
  const pkg = packageName(ctx); const headers = await authorization(ctx);
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
      for (const product of (records ?? []) as ProductRecord[]) resources.push(productResource({ ...product, packageName: pkg }, kind));
      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    } while (pageToken);
  }
  return { resources, summary: { packageName: pkg, productCount: resources.length } };
}
async function listReleases(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const pkg = packageName(ctx); const headers = await authorization(ctx);
  const tracks = input.track ? [segment(input.track, '출시 트랙')] : ['internal', 'alpha', 'beta', 'production'];
  const resources: ResourceInput[] = [];
  for (const track of tracks) {
    try {
      const data = await ctx.request<{ releases?: ReleaseRecord[] }>(ROOT + pkg + '/tracks/' + track + '/releases', { headers });
      for (const release of data.releases ?? []) {
        const versions = (release.activeArtifacts ?? []).map(item => String(item.versionCode));
        resources.push({ kind: 'release', externalId: `${pkg}:${track}:${versions.join(',') || release.releaseName || 'draft'}`,
          name: release.releaseName || `${track} · ${versions.join(', ')}`, status: release.releaseLifecycleState,
          data: { packageName: pkg, track, versionCodes: versions } });
      }
    } catch (error) {
      if ((error as AppError).code === 'RESOURCE_NOT_FOUND' && !input.track) continue;
      throw error;
    }
  }
  return { resources, summary: { packageName: pkg, releaseCount: resources.length } };
}
function money(micros: unknown, currency: unknown) {
  const value = parseMicros(micros);
  if (value <= 0n) throw new AppError('INVALID_AMOUNT', '상품 가격은 0보다 커야 합니다.');
  const code = text(currency, '통화', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new AppError('INVALID_AMOUNT', '통화 코드를 확인해 주세요.');
  return { currencyCode: code, units: (value / 1_000_000n).toString(), nanos: Number(value % 1_000_000n) * 1000 };
}
async function upsertProduct(operation: string, input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const pkg = packageName(ctx); const headers = await authorization(ctx);
  const create = operation === 'create-product';
  let kind: 'one-time' | 'subscription' = input.type === 'subscription' ? 'subscription' : 'one-time';
  let id: string;
  if (create) id = segment(input.productId, '상품 ID');
  else {
    const parts = text(input.externalId, '상품 식별자').split(':');
    if (parts.length !== 3 || parts[0] !== pkg || !['one-time', 'subscription'].includes(parts[1])) {
      throw new AppError('RESOURCE_MISMATCH', '선택한 프로젝트의 동기화된 상품을 선택해 주세요.');
    }
    kind = parts[1] as typeof kind; id = segment(parts[2], '상품 ID');
  }
  if (!/^[a-z0-9][a-z0-9_.]{0,39}$/.test(id)) throw new AppError('INVALID_INPUT', '상품 ID는 소문자·숫자·밑줄·마침표를 사용하는 40자 이하 값이어야 합니다.');
  if (input.status !== undefined) throw new AppError('UNSUPPORTED_CHANGE', '이 버전은 상품 가격과 설명을 관리합니다. 판매 상태 전환은 서비스의 상품 심사·활성화 절차가 필요합니다.');
  const price = money(input.priceMicros, input.currency);
  const region = text(input.country ?? ctx.credentials.defaultRegion ?? 'US', '판매 국가', 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) throw new AppError('INVALID_INPUT', '판매 국가 코드를 확인해 주세요.');
  const converted = await ctx.request<{ regionVersion: { version: string }; convertedRegionPrices: Record<string, { price: typeof price }> }>(
    ROOT + pkg + '/pricing:convertRegionPrices', { method: 'POST', headers, json: { price }, write: false });
  const localPrice = converted.convertedRegionPrices?.[region]?.price;
  if (!converted.regionVersion?.version || !localPrice) throw new AppError('REGION_UNAVAILABLE', '선택한 국가의 상품 가격을 계산할 수 없습니다.');
  // Users select a currency and country explicitly. A conversion cannot silently change that contract.
  if (localPrice.currencyCode !== price.currencyCode) throw new AppError('CURRENCY_MISMATCH', '상품 통화와 판매 국가의 통화가 일치해야 합니다.');
  const productPath = kind === 'subscription' ? 'subscriptions' : 'oneTimeProducts';
  let product: ProductRecord;
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
    product = await ctx.request<ProductRecord>(ROOT + pkg + '/' + productPath + '/' + id, { headers });
    const key = kind === 'subscription' ? 'basePlans' : 'purchaseOptions';
    const variants = product[key];
    if (!variants || variants.length !== 1) throw new AppError('MULTIPLE_PRICE_OPTIONS', '구매 옵션이 여러 개인 상품은 옵션별 편집이 필요합니다. 가격을 일괄 변경하지 않았습니다.');
    // Preserve every other region and setting, and omit output-only state from the patch.
    const variant = { ...variants[0] }; delete variant.state;
    const pricesKey = kind === 'subscription' ? 'regionalConfigs' : 'regionalPricingAndAvailabilityConfigs';
    const prices = (variant[pricesKey] ?? []) as Record<string, unknown>[];
    if (!prices.some(item => item.regionCode === region)) throw new AppError('REGION_UNAVAILABLE', '이 상품에서 이미 설정된 국가의 가격만 변경할 수 있습니다.');
    variant[pricesKey] = prices.map(item => item.regionCode === region ? { ...item, price } : item);
    product = { packageName: pkg, productId: id, [key]: [variant] };
  }
  const query = new URLSearchParams({ 'regionsVersion.version': converted.regionVersion.version });
  let path: string; let method: 'POST' | 'PATCH';
  if (create && kind === 'subscription') { query.set('productId', id); path = 'subscriptions'; method = 'POST'; }
  else {
    query.set('updateMask', create ? 'listings,purchaseOptions' : kind === 'subscription' ? 'basePlans' : 'purchaseOptions');
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
  const resource = productResource({ ...saved, packageName: pkg, productId: id }, kind);
  ctx.checkpoint({ externalId: resource.externalId });
  return { resources: [resource], summary: { externalId: resource.externalId, state: resource.status, currency: price.currencyCode, region } };
}
async function uploadBuild(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const pkg = packageName(ctx); const artifact = ctx.artifact;
  if (!artifact || artifact.kind === 'directory' || !['.aab', '.apk'].includes(extname(artifact.name).toLowerCase())) {
    throw new AppError('ARTIFACT_REQUIRED', '검증된 Android App Bundle(.aab) 또는 APK 빌드가 필요합니다.');
  }
  const track = segment(input.track ?? 'internal', '출시 트랙');
  const headers = await authorization(ctx);
  const blob = await openAsBlob(artifact.path, { type: 'application/octet-stream' });
  const edit = await ctx.request<{ id: string }>(ROOT + pkg + '/edits', { method: 'POST', headers, json: {}, write: true });
  const editId = segment(edit.id, '편집 ID');
  ctx.checkpoint({ packageName: pkg, editId, track, artifactSha256: artifact.sha256 });
  ctx.progress('Google Play 편집을 만들었습니다. 빌드 파일을 업로드합니다.');
  const type = extname(artifact.name).toLowerCase() === '.aab' ? 'bundles' : 'apks';
  const uploaded = await ctx.request<{ versionCode: number }>(HOST + '/upload/androidpublisher/v3/applications/' + pkg + '/edits/' + editId + '/' + type + '?uploadType=media',
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: blob, write: true });
  if (!Number.isSafeInteger(uploaded.versionCode) || uploaded.versionCode <= 0) throw new AppError('INVALID_PROVIDER_RESPONSE', '업로드된 빌드의 버전 코드를 확인할 수 없습니다.');
  const versionCode = String(uploaded.versionCode);
  ctx.checkpoint({ versionCode });
  await ctx.request(ROOT + pkg + '/edits/' + editId + '/tracks/' + track, {
    method: 'PUT', headers, write: true,
    json: { track, releases: [{ versionCodes: [versionCode], status: 'completed', name: `Build ${versionCode}` }] },
  });
  await ctx.request(ROOT + pkg + '/edits/' + editId + ':validate', { method: 'POST', headers, json: {}, write: true });
  await ctx.request(ROOT + pkg + '/edits/' + editId + ':commit', { method: 'POST', headers, json: {}, write: true });
  ctx.checkpoint({ committed: true });
  const latest = await listReleases({ track }, ctx);
  const release = latest.resources?.find(resource => (resource.data.versionCodes as string[]).includes(versionCode));
  const published = release?.status === 'RELEASE_LIFECYCLE_STATE_PUBLISHED';
  return { resources: latest.resources, waitingExternal: !published,
    summary: { packageName: pkg, editId, versionCode, track, committed: true, state: release?.status ?? 'PROCESSING', artifactSha256: artifact.sha256 } };
}

export const googlePlayConnector: Connector = {
  capability: {
    provider: 'google-play', name: 'Google Play', category: 'store',
    description: 'Android 업로드·스토어 자료·단계적 출시와 일회성 상품·구독을 관리합니다.', authKind: 'Google OAuth 또는 서비스 계정',
    fields: [
      { key: 'packageName', label: '기본 Android 패키지 이름', required: true, placeholder: 'com.company.app' },
      { key: 'serviceAccountJson', label: '서비스 계정 JSON (OAuth 연결 시 생략)', secret: true, multiline: true },
      { key: 'clientId', label: 'Google OAuth 클라이언트 ID' },
      { key: 'clientSecret', label: 'OAuth 클라이언트 시크릿 (해당되는 경우)', secret: true },
      { key: 'refreshToken', label: '기존 OAuth 갱신 토큰 (브라우저 연결 시 생략)', secret: true },
      { key: 'defaultRegion', label: '상품 기본 판매 국가', placeholder: 'US' },
      { key: 'defaultLanguage', label: '상품 기본 언어', placeholder: 'en-US' },
      { key: 'reportBucket', label: '수익 보고서 버킷 (선택)', placeholder: 'pubsite_prod_rev_0123456789' },
    ],
    operations: ['check', 'sync', 'sync-app', 'list-products', 'create-product', 'update-product', 'list-releases', 'upload-build',
      'list-listings', 'update-listing', 'upload-listing-image', 'promote-release', 'create-app'],
    operationFields: {
      'update-product': [{ key: 'priceMicros', required: true }, { key: 'status', remove: true }, { key: 'description', remove: true },
        { key: 'country', label: '판매 국가', type: 'text', placeholder: 'US', hint: '기존에 설정된 국가의 가격만 변경합니다. 비우면 연결의 기본 국가를 사용합니다.' }],
      'sync': [{ key: 'reportMonth', label: '수익 보고서 월 (선택)', type: 'text', placeholder: '202608', hint: '비우면 최근 완료된 3개월을 수집합니다.' }],
      'list-listings': [{ key: 'language', label: '언어 (선택)', placeholder: 'en-US', hint: '비우면 모든 현지화 목록과 아이콘·그래픽·휴대전화 스크린샷 메타데이터를 읽습니다. Play 편집 세션을 만들고 커밋 없이 삭제합니다.' }],
      'update-listing': [
        { key: 'language', label: '언어', required: true, placeholder: 'en-US', hint: 'BCP-47 언어 태그입니다.' },
        { key: 'title', label: '스토어 제목', required: true, hint: '최대 50자.' },
        { key: 'shortDescription', label: '짧은 설명', type: 'textarea', hint: '최대 80자.' },
        { key: 'fullDescription', label: '자세한 설명', type: 'textarea', hint: '최대 4000자.' },
        { key: 'video', label: 'YouTube 홍보 URL', placeholder: 'https://www.youtube.com/watch?v=…' },
      ],
      'upload-listing-image': [
        { key: 'language', label: '언어', required: true, placeholder: 'en-US' },
        { key: 'imageType', label: '이미지 유형', type: 'select', required: true, options: [
          { value: 'icon', label: '아이콘' }, { value: 'featureGraphic', label: '그래픽 이미지' },
          { value: 'phoneScreenshots', label: '휴대전화 스크린샷' }, { value: 'sevenInchScreenshots', label: '7인치 태블릿' },
          { value: 'tenInchScreenshots', label: '10인치 태블릿' }, { value: 'tvScreenshots', label: 'TV 스크린샷' },
          { value: 'wearScreenshots', label: 'Wear 스크린샷' }, { value: 'tvBanner', label: 'TV 배너' },
        ], hint: '검증된 이미지 파일 결과물(PNG/JPEG/WebP, 15MB 이하)이 필요합니다.' },
      ],
      'promote-release': [
        { key: 'track', label: '대상 트랙', type: 'select', required: true, options: [
          { value: 'internal', label: '내부 테스트' }, { value: 'alpha', label: '비공개 테스트' },
          { value: 'beta', label: '공개 테스트' }, { value: 'production', label: '프로덕션' },
        ] },
        { key: 'versionCodes', label: '버전 코드', required: true, placeholder: '123,124', hint: '쉼표로 구분합니다. 이전 completed 출시 코드는 유지됩니다.' },
        { key: 'status', label: '출시 상태', type: 'select', required: true, options: [
          { value: 'draft', label: '초안' }, { value: 'inProgress', label: '단계적 출시' },
          { value: 'halted', label: '일시 중지' }, { value: 'completed', label: '전체 출시' },
        ] },
        { key: 'userFraction', label: '단계적 출시 비율', placeholder: '0.1', hint: 'inProgress/halted일 때 0과 1 사이. 0.1 = 10%.' },
        { key: 'fromTrack', label: '원본 트랙 (승격)', hint: '다른 트랙의 버전을 가져올 때 사용합니다.' },
        { key: 'releaseName', label: '출시 이름' },
        { key: 'releaseNotes', label: '출시 노트', type: 'textarea' },
        { key: 'language', label: '출시 노트 언어', placeholder: 'en-US' },
      ],
      'create-app': [{ key: 'productId', remove: true }, { key: 'name', remove: true }, { key: 'priceMicros', remove: true }],
    },
    setupUrl: 'https://developers.google.com/android-publisher/getting_started',
    limitations: ['최초 앱 생성·개발자 계약·첫 바이너리 등록은 Play Console에서 필요합니다. 공개 API는 앱을 만들지 않습니다.',
      '업로드용 서명 키와 API 계정은 별개입니다. 출시 결과는 심사 상태에 따라 추적합니다.',
      '상품 생성은 초안 상태이며 판매 활성화와 여러 구매 옵션의 편집은 후속 지원 대상입니다.',
      '스토어 자료·이미지·단계적 출시는 Edits API 수명주기(insert→변경→validate→commit)를 사용합니다. 커밋 후 같은 쓰기를 자동 재전송하지 않습니다.',
      '수익 보고서는 버킷과 재무 조회 권한이 필요합니다. 최근 완료된 3개월의 수수료·환불 반영 수익을 수집하며 실제 입금액과 구분합니다.'],
  },
  async execute(operation, input, ctx) {
    if (operation === 'reconcile' && input.listingsEditId) return reconcilePlayListingEdit(input, ctx, packageName(ctx), await authorization(ctx));
    if (operation === 'check') {
      const pkg = packageName(ctx);
      await ctx.request(ROOT + pkg + '/oneTimeProducts?pageSize=1', { headers: await authorization(ctx) });
      return { summary: { packageName: pkg, connected: true } };
    }
    if (operation === 'list-products') return listProducts(ctx);
    if (operation === 'list-releases') return listReleases(input, ctx);
    if (operation === 'sync-app') {
      const products = await listProducts(ctx); const releases = await listReleases(input, ctx);
      return { resources: [...(products.resources ?? []), ...(releases.resources ?? [])], summary: { ...products.summary, ...releases.summary } };
    }
    if (operation === 'sync') {
      const products = await listProducts(ctx); const releases = await listReleases(input, ctx);
      const earnings = await collectPlayEarnings(input, ctx);
      return { ...earnings, resources: [...(products.resources ?? []), ...(releases.resources ?? [])], summary: { ...products.summary, ...releases.summary, ...earnings.summary } };
    }
    if (operation === 'create-product' || operation === 'update-product') return upsertProduct(operation, input, ctx);
    if (operation === 'upload-build') return uploadBuild(input, ctx);
    if (operation === 'list-listings' || operation === 'update-listing' || operation === 'upload-listing-image' || operation === 'promote-release' || operation === 'create-app') {
      const pkg = packageName(ctx); const headers = await authorization(ctx);
      if (operation === 'list-listings') return listPlayListings(input, ctx, pkg, headers);
      if (operation === 'update-listing') return updatePlayListing(input, ctx, pkg, headers);
      if (operation === 'upload-listing-image') return uploadPlayListingImage(input, ctx, pkg, headers);
      if (operation === 'promote-release') return promotePlayRelease(input, ctx, pkg, headers);
      return preparePlayApp(ctx, pkg, headers);
    }
    throw new AppError('UNSUPPORTED_OPERATION', 'Google Play에서 지원하지 않는 작업입니다.');
  },
};
