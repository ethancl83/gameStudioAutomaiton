import type { ResourceInput } from './types.js';

/**
 * Read-only SDK integration config. This never installs SDK code, never
 * patches a game project, and never executes user scripts.
 *
 * Official identifiers (verified 2026-09-11):
 * - AdMob Android App ID → AndroidManifest `com.google.android.gms.ads.APPLICATION_ID`
 *   (https://developers.google.com/admob/android/quick-start)
 * - AdMob iOS App ID → Info.plist `GADApplicationIdentifier`
 *   (https://developers.google.com/admob/ios/quick-start)
 * - MAX SDK Key is passed to the official initializer, not returned here:
 *   Android `AppLovinSdkInitializationConfiguration.builder("«SDK-key»")`
 *   (https://support.applovin.com/en/max/android/overview/integration)
 *   iOS `ALSdkInitializationConfiguration` `configurationWithSdkKey:`
 *   (https://support.applovin.com/en/max/ios/overview/integration)
 *   Manual Android-only: AndroidManifest `applovin.sdk.key` with placeholder
 *   (https://support.applovin.com/en/max/android/overview/manual-integration)
 * - IAP product IDs belong to Play / App Store connectors (`list-products`).
 */

const IAP_NOTE = '인앱 결제 상품 ID는 Google Play·App Store 연결의 list-products로 조회합니다. AdMob/MAX는 IAP를 생성하지 않으며 SDK 코드를 설치하지 않습니다.';
const ADMOB_ANDROID_DOCS = 'https://developers.google.com/admob/android/quick-start';
const ADMOB_IOS_DOCS = 'https://developers.google.com/admob/ios/quick-start';
const MAX_ANDROID_DOCS = 'https://support.applovin.com/en/max/android/overview/integration';
const MAX_IOS_DOCS = 'https://support.applovin.com/en/max/ios/overview/integration';
const MAX_ANDROID_MANUAL_DOCS = 'https://support.applovin.com/en/max/android/overview/manual-integration';
const MAX_SDK_PLACEHOLDER = '«SDK-key»';
const MAX_MANIFEST_PLACEHOLDER = '«your-SDK-key»';

function platformKey(value: unknown): string {
  return String(value ?? '').toUpperCase();
}

export function admobSdkConfig(apps: ResourceInput[], units: ResourceInput[]): Record<string, unknown> {
  const appRows = apps.filter(item => item.kind === 'product').map(app => {
    const admobAppId = app.data.admobAppId ?? app.externalId;
    const id = typeof admobAppId === 'string' ? admobAppId : undefined;
    const platform = platformKey(app.data.platform);
    return {
      admobAppId,
      name: app.name,
      platform: app.data.platform,
      packageName: app.data.packageName,
      ...(platform === 'ANDROID' && id ? {
        androidManifest: {
          metaDataName: 'com.google.android.gms.ads.APPLICATION_ID',
          value: id,
        },
        documentation: ADMOB_ANDROID_DOCS,
      } : {}),
      ...(platform === 'IOS' && id ? {
        infoPlist: {
          key: 'GADApplicationIdentifier',
          value: id,
        },
        documentation: ADMOB_IOS_DOCS,
      } : {}),
    };
  });
  return {
    provider: 'admob',
    installsSdk: false,
    documentation: ADMOB_ANDROID_DOCS,
    iosDocumentation: ADMOB_IOS_DOCS,
    apps: appRows,
    adUnits: units.filter(item => item.kind === 'ad-unit').map(unit => ({
      adUnitId: unit.externalId,
      name: unit.name,
      adFormat: unit.data.adFormat,
      admobAppId: unit.data.admobAppId,
      appIdentifier: unit.data.appIdentifier,
    })),
    iap: { supportedHere: false, note: IAP_NOTE, storeOperations: ['list-products'] },
    note: '이 작업은 식별자와 플랫폼별 설정 키만 반환합니다. Android는 AndroidManifest APPLICATION_ID, iOS는 Info.plist GADApplicationIdentifier입니다. Gradle/Xcode SDK 설치는 수행하지 않습니다.',
  };
}

export function maxSdkConfig(units: ResourceInput[], sdkKey?: string): Record<string, unknown> {
  // `sdkKey` is read only to set sdkKeyConfigured. Stored bytes stay in the
  // vault and must not appear in the summary, manifest, or job ledger.
  return {
    provider: 'applovin-max',
    installsSdk: false,
    documentation: MAX_ANDROID_DOCS,
    iosDocumentation: MAX_IOS_DOCS,
    sdkKeyConfigured: Boolean(sdkKey),
    sdkKeySource: 'AppLovin 대시보드 Account > General > Keys. Ad Unit Management API는 SDK Key를 반환하지 않습니다.',
    sdkKeyPlaceholder: MAX_SDK_PLACEHOLDER,
    android: {
      documentation: MAX_ANDROID_DOCS,
      initializer: 'AppLovinSdkInitializationConfiguration.builder("«SDK-key»").setMediationProvider(AppLovinMediationProvider.MAX).build()',
      androidManifest: {
        metaDataName: 'applovin.sdk.key',
        value: MAX_MANIFEST_PLACEHOLDER,
        documentation: MAX_ANDROID_MANUAL_DOCS,
        note: '수동 Android 연동 전용. iOS에는 AndroidManifest를 쓰지 않습니다.',
      },
    },
    ios: {
      documentation: MAX_IOS_DOCS,
      initializer: '[ALSdkInitializationConfiguration configurationWithSdkKey: @"«SDK-key»"]',
    },
    adUnits: units.filter(item => item.kind === 'ad-unit').map(unit => ({
      adUnitId: unit.externalId,
      name: unit.name,
      platform: unit.data.platform,
      packageName: unit.data.packageName ?? unit.data.appIdentifier,
      adFormat: unit.data.adFormat,
    })),
    iap: { supportedHere: false, note: IAP_NOTE, storeOperations: ['list-products'] },
    note: '이 작업은 광고 단위 ID·패키지와 SDK Key 설정 여부만 반환합니다. SDK Key 값은 vault에 남기고 요약·매니페스트·작업 이력에 넣지 않습니다. SDK 코드를 설치하지 않습니다.',
  };
}
