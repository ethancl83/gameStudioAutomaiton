import { AppError } from '../domain/errors.js';
import type { AdFormat, IntegrationFinding, IntegrationPlatform, IntegrationRequest, ProductType, VerifiedAdUnit, VerifiedProduct } from './types.js';

const SECRET_KEYS = /^(?:password|storePassword|keyPassword|passphrase|keystoreBase64|privateKey|private_key|refreshToken|refresh_token|accessToken|access_token|clientSecret|client_secret|serviceAccountJson|apiKey|api_key|reportKey|managementKey|sdkKey|sdk_key|oauthToken)$/i;
const ADMOB_APP = /^ca-app-pub-\d{16}~\d{10}$/;
const ADMOB_UNIT = /^ca-app-pub-\d{16}\/\d{10}$/;
const PRODUCT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_UNIT = /^[A-Za-z0-9]{8,64}$/;
const PACKAGE = /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/;
const PRODUCT_TYPES = new Set<ProductType>(['inapp', 'subs', 'consumable', 'nonConsumable']);
const AD_FORMATS = new Set<AdFormat>(['BANNER', 'INTER', 'REWARD', 'MREC', 'APPOPEN', 'NATIVE']);

const FORMAT_MAP: Record<string, AdFormat> = {
  banner: 'BANNER',
  interstitial: 'INTER',
  inter: 'INTER',
  rewarded: 'REWARD',
  reward: 'REWARD',
  mrec: 'MREC',
  native: 'NATIVE',
  appopen: 'APPOPEN',
  app_open: 'APPOPEN',
  APPOPEN: 'APPOPEN',
  BANNER: 'BANNER',
  INTER: 'INTER',
  REWARD: 'REWARD',
  MREC: 'MREC',
  NATIVE: 'NATIVE',
};

export function assertNoSecrets(value: unknown, depth = 0): void {
  if (depth > 20) throw new AppError('INVALID_INPUT', '입력이 너무 깊게 중첩되어 있습니다.');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.test(key)) {
      throw new AppError('SECRET_IN_JOB', 'OAuth·관리 API·Report Key는 전달하지 않습니다. MAX 공개 클라이언트 SDK 키는 스테이징 훅으로만 주입하고 요청에 넣지 않습니다.');
    }
    assertNoSecrets(item, depth + 1);
  }
}

export function normalizeAdFormat(value: string | undefined): AdFormat | undefined {
  if (!value) return undefined;
  return FORMAT_MAP[value] ?? FORMAT_MAP[value.toLowerCase()];
}

export function sanitizeAdUnits(
  units: VerifiedAdUnit[] | undefined,
  provider: string,
  findings: IntegrationFinding[],
  platform?: IntegrationPlatform,
): VerifiedAdUnit[] {
  const result: VerifiedAdUnit[] = [];
  for (const unit of units ?? []) {
    const id = String(unit.adUnitId ?? '').trim();
    if (!id) {
      findings.push({ code: 'id.ad_unit_empty', severity: 'error', message: '광고 단위 ID가 비어 있습니다.', fixHint: '검증된 공개 광고 단위 ID를 전달하세요.' });
      continue;
    }
    if (provider === 'admob' && !ADMOB_UNIT.test(id)) {
      findings.push({
        code: 'id.ad_unit_invalid',
        severity: 'error',
        message: `AdMob 광고 단위 ID 형식이 아닙니다: ${id}`,
        fixHint: 'ca-app-pub-################/########## 형식의 검증된 광고 단위를 사용하세요.',
      });
      continue;
    }
    if (provider === 'applovin-max') {
      if (ADMOB_UNIT.test(id) || !MAX_UNIT.test(id)) {
        findings.push({
          code: 'id.max_ad_unit_invalid',
          severity: 'error',
          message: `MAX 광고 단위 ID 형식이 아닙니다: ${id}`,
          fixHint: 'MAX 대시보드의 공개 광고 단위 ID만 전달하세요. AdMob ca-app-pub 형식은 MAX에 쓰지 않습니다.',
        });
        continue;
      }
    }
    const format = normalizeAdFormat(unit.adFormat);
    if (!format || !AD_FORMATS.has(format)) {
      findings.push({
        code: 'id.ad_format_invalid',
        severity: unit.adFormat ? 'error' : 'warning',
        message: unit.adFormat
          ? `광고 형식 '${String(unit.adFormat)}' 은 BANNER|INTER|REWARD|MREC|APPOPEN|NATIVE 가 아닙니다.`
          : '광고 단위에 adFormat이 없어 보상형 코드에 사용하지 않습니다.',
        fixHint: '검증된 adFormat enum을 전달하세요.',
      });
      if (unit.adFormat) continue;
      continue;
    }
    if (unit.platform && unit.platform !== 'android' && unit.platform !== 'ios') {
      findings.push({
        code: 'id.ad_platform_invalid',
        severity: 'error',
        message: `광고 단위 플랫폼 '${unit.platform}' 은 android 또는 ios 여야 합니다.`,
      });
      continue;
    }
    if (platform && unit.platform && unit.platform !== platform) {
      findings.push({
        code: 'id.ad_platform_mismatch',
        severity: 'error',
        message: `광고 단위 플랫폼(${unit.platform})이 요청 플랫폼(${platform})과 다릅니다.`,
        fixHint: '루트가 검증한 동일 플랫폼 광고 단위만 전달하세요.',
      });
      continue;
    }
    result.push({ adUnitId: id, name: unit.name, adFormat: format, platform: unit.platform ?? platform });
  }
  return result;
}

export function sanitizeProducts(products: VerifiedProduct[] | undefined, findings: IntegrationFinding[]): VerifiedProduct[] {
  const result: VerifiedProduct[] = [];
  for (const product of products ?? []) {
    const id = String(product.productId ?? '').trim();
    if (!PRODUCT_ID.test(id)) {
      findings.push({
        code: 'id.product_invalid',
        severity: 'error',
        message: `상품 ID가 유효하지 않습니다: ${id || '(empty)'}`,
        fixHint: 'Play/App Store의 공개 상품 ID만 전달하세요.',
      });
      continue;
    }
    const type = product.productType as string | undefined;
    if (type && !PRODUCT_TYPES.has(type as ProductType)) {
      findings.push({
        code: 'id.product_type_invalid',
        severity: 'error',
        message: `상품 유형 '${type}' 은 inapp|subs|consumable|nonConsumable 가 아닙니다.`,
        fixHint: '검증된 productType enum을 전달하세요.',
      });
      continue;
    }
    if (!type) {
      findings.push({
        code: 'id.product_type_defaulted',
        severity: 'warning',
        message: `상품 '${id}' 에 productType이 없어 inapp(consumable)로 처리합니다.`,
      });
    }
    result.push({ productId: id, name: product.name, productType: (type as ProductType | undefined) ?? 'inapp' });
  }
  return result;
}

export function sanitizeAppId(appId: string | undefined, provider: string, findings: IntegrationFinding[]): string | undefined {
  if (!appId) return undefined;
  const value = appId.trim();
  if (provider === 'admob' && !ADMOB_APP.test(value) && !PACKAGE.test(value)) {
    findings.push({
      code: 'id.app_invalid',
      severity: 'error',
      message: `AdMob 앱 ID 형식이 아닙니다: ${value}`,
      fixHint: 'ca-app-pub-################~########## 또는 패키지 이름을 검증된 리소스에서 가져오세요.',
    });
    return undefined;
  }
  return value;
}

/** Rewarded templates require an exact REWARD unit. Never fall back to banner/interstitial IDs. */
export function rewardedUnit(units: VerifiedAdUnit[]): VerifiedAdUnit | undefined {
  return units.find((unit) => normalizeAdFormat(unit.adFormat) === 'REWARD');
}

export function engines(): readonly string[] {
  return ['android', 'ios', 'unity', 'godot', 'unreal'];
}

export function providers(): readonly string[] {
  return ['admob', 'applovin-max', 'play-billing', 'app-store'];
}

export function validateShape(input: IntegrationRequest): IntegrationFinding[] {
  const findings: IntegrationFinding[] = [];
  if (!engines().includes(input.engine)) {
    findings.push({
      code: 'scope.engine_unsupported',
      severity: 'error',
      message: `엔진 '${String(input.engine)}' 임의 플러그인 배선은 지원하지 않습니다.`,
      fixHint: 'android, ios, unity, godot, unreal 중 하나의 구체 템플릿을 사용하세요.',
    });
  }
  if (input.platform !== 'android' && input.platform !== 'ios') {
    findings.push({
      code: 'scope.platform_unsupported',
      severity: 'error',
      message: `플랫폼 '${String(input.platform)}'은 지원하지 않습니다.`,
      fixHint: 'android 또는 ios를 지정하세요.',
    });
  }
  if (!providers().includes(input.provider)) {
    findings.push({
      code: 'scope.provider_unsupported',
      severity: 'error',
      message: `공급자 '${String(input.provider)}'는 지원하지 않습니다.`,
      fixHint: 'admob, applovin-max, play-billing, app-store 중 하나를 사용하세요.',
    });
  }
  if (input.engine === 'android' && input.platform !== 'android') {
    findings.push({
      code: 'scope.engine_platform_mismatch',
      severity: 'error',
      message: '네이티브 Android 템플릿은 platform=android 만 지원합니다.',
    });
  }
  if (input.engine === 'ios' && input.platform !== 'ios') {
    findings.push({
      code: 'scope.engine_platform_mismatch',
      severity: 'error',
      message: '네이티브 iOS 템플릿은 platform=ios 만 지원합니다.',
    });
  }
  if (input.provider === 'play-billing' && input.platform !== 'android') {
    findings.push({
      code: 'scope.play_billing_android_only',
      severity: 'error',
      message: 'Google Play Billing은 Android 전용입니다.',
      fixHint: 'iOS는 provider=app-store(StoreKit 2)를 사용하세요.',
    });
  }
  if (input.provider === 'app-store' && input.platform !== 'ios') {
    findings.push({
      code: 'scope.app_store_ios_only',
      severity: 'error',
      message: 'App Store / StoreKit 2는 iOS 전용입니다.',
      fixHint: 'Android는 provider=play-billing을 사용하세요.',
    });
  }
  return findings;
}
