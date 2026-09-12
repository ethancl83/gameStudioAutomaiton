import type { IntegrationEngine, IntegrationPlatform, IntegrationProvider, SdkCatalogEntry } from './types.js';

/** Official versions verified 2026-09-11 from primary docs / GitHub releases. Do not invent. */
export const CATALOG = {
  admobAndroid: {
    id: 'admob-android',
    artifact: 'com.google.android.gms:play-services-ads',
    version: '25.4.0',
    documentation: 'https://developers.google.com/admob/android/quick-start',
    source: 'https://developers.google.com/admob/android/quick-start',
    kind: 'ads',
  },
  admobIos: {
    id: 'admob-ios',
    artifact: 'Google-Mobile-Ads-SDK',
    version: '13.9.0',
    documentation: 'https://developers.google.com/admob/ios/quick-start',
    source: 'https://cocoapods.org/pods/Google-Mobile-Ads-SDK',
    kind: 'ads',
  },
  admobIosSpm: {
    id: 'admob-ios-spm',
    artifact: 'https://github.com/googleads/swift-package-manager-google-mobile-ads.git',
    version: '13.9.0',
    documentation: 'https://developers.google.com/admob/ios/quick-start',
    source: 'https://github.com/googleads/swift-package-manager-google-mobile-ads',
    kind: 'ads',
  },
  maxAndroid: {
    id: 'max-android',
    artifact: 'com.applovin:applovin-sdk',
    version: '13.6.4',
    documentation: 'https://support.applovin.com/en/max/android/overview/integration',
    source: 'https://github.com/AppLovin/AppLovin-MAX-SDK-Android/releases',
    kind: 'ads',
  },
  maxIos: {
    id: 'max-ios',
    artifact: 'AppLovinSDK',
    version: '13.6.4',
    documentation: 'https://support.applovin.com/en/max/ios/overview/integration',
    source: 'https://github.com/AppLovin/AppLovin-MAX-SDK-iOS/releases',
    kind: 'ads',
  },
  playBilling: {
    id: 'play-billing',
    artifact: 'com.android.billingclient:billing',
    version: '9.1.0',
    documentation: 'https://developer.android.com/google/play/billing/integrate',
    source: 'https://developer.android.com/google/play/billing/getting-ready',
    kind: 'iap',
  },
  storeKit2: {
    id: 'storekit2',
    artifact: 'StoreKit',
    version: '2',
    documentation: 'https://developer.apple.com/documentation/storekit/product/purchase()',
    source: 'https://developer.apple.com/documentation/storekit',
    kind: 'iap',
  },
  unityAdmob: {
    id: 'unity-admob',
    artifact: 'com.google.ads.mobile',
    version: '11.5.0',
    documentation: 'https://developers.google.com/admob/unity/quick-start',
    source: 'https://github.com/googleads/googleads-mobile-unity/releases',
    kind: 'plugin',
  },
  unityMax: {
    id: 'unity-max',
    artifact: 'com.applovin.mediation.ads',
    version: '8.6.5',
    documentation: 'https://support.applovin.com/en/max/unity/overview/integration',
    source: 'https://github.com/AppLovin/AppLovin-MAX-Unity-Plugin/releases',
    kind: 'plugin',
  },
  unityIap: {
    id: 'unity-iap',
    artifact: 'com.unity.purchasing',
    version: '5.4.2',
    documentation: 'https://docs.unity3d.com/Packages/com.unity.purchasing@5.4/manual/index.html',
    source: 'https://docs.unity3d.com/Packages/com.unity.purchasing@5.4/manual/index.html',
    kind: 'iap',
  },
  godotAdmob: {
    id: 'godot-admob',
    artifact: 'poingstudios/godot-admob-plugin',
    version: '5.0.0',
    documentation: 'https://poingstudios.github.io/godot-admob-plugin/',
    source: 'https://developers.google.com/admob/other-platforms',
    kind: 'plugin',
  },
  godotPlayBilling: {
    id: 'godot-play-billing',
    artifact: 'GodotGooglePlayBilling',
    version: '3.3.0',
    documentation: 'https://docs.godotengine.org/en/stable/tutorials/platform/android_in_app_purchases.html',
    source: 'https://github.com/godot-sdk-integrations/godot-google-play-billing/releases',
    kind: 'iap',
  },
  unrealAndroidAdvertising: {
    id: 'unreal-android-advertising',
    artifact: 'AndroidAdvertising + OnlineSubsystemGooglePlay',
    version: 'UE5 first-party',
    documentation: 'https://dev.epicgames.com/documentation/en-us/unreal-engine/using-ad-mob-in-game-ads-on-android',
    source: 'https://dev.epicgames.com/documentation/en-us/unreal-engine/using-ad-mob-in-game-ads-on-android',
    kind: 'ads',
  },
} as const satisfies Record<string, SdkCatalogEntry>;

export const MARKER_BEGIN = 'APPOPS-INTEGRATION-BEGIN';
export const MARKER_END = 'APPOPS-INTEGRATION-END';
export const MAX_SDK_PLACEHOLDER = '«SDK-key»';
export const ADMOB_TEST_ANDROID_APP = 'ca-app-pub-3940256099942544~3347511713';
export const ADMOB_TEST_IOS_APP = 'ca-app-pub-3940256099942544~1458002511';
export const ADMOB_TEST_REWARD = 'ca-app-pub-3940256099942544/5224354917';

export function catalogFor(
  engine: IntegrationEngine,
  platform: IntegrationPlatform,
  provider: IntegrationProvider,
  includePurchases: boolean,
): SdkCatalogEntry[] {
  const items: SdkCatalogEntry[] = [];
  const ads = provider === 'admob' || provider === 'applovin-max';
  const iap = includePurchases || provider === 'play-billing' || provider === 'app-store';

  if (engine === 'android' || (engine !== 'ios' && platform === 'android')) {
    if (provider === 'admob') items.push(CATALOG.admobAndroid);
    if (provider === 'applovin-max') items.push(CATALOG.maxAndroid);
    if (iap && platform === 'android') items.push(CATALOG.playBilling);
  }
  if (engine === 'ios' || (engine !== 'android' && platform === 'ios')) {
    if (provider === 'admob') items.push(CATALOG.admobIos, CATALOG.admobIosSpm);
    if (provider === 'applovin-max') items.push(CATALOG.maxIos);
    if (iap && platform === 'ios') items.push(CATALOG.storeKit2);
  }
  if (engine === 'unity') {
    if (provider === 'admob') items.push(CATALOG.unityAdmob);
    if (provider === 'applovin-max') items.push(CATALOG.unityMax);
    if (iap) items.push(CATALOG.unityIap);
  }
  if (engine === 'godot') {
    if (provider === 'admob') items.push(CATALOG.godotAdmob);
    if (iap && platform === 'android') items.push(CATALOG.godotPlayBilling);
    if (iap && platform === 'ios') items.push(CATALOG.storeKit2);
  }
  if (engine === 'unreal') {
    if (ads) items.push(CATALOG.unrealAndroidAdvertising);
    if (iap && platform === 'android') items.push(CATALOG.playBilling);
    if (iap && platform === 'ios') items.push(CATALOG.storeKit2);
  }
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

export function marker(id: string, comment: 'slash' | 'hash' | 'xml' | 'semi'): { begin: string; end: string } {
  const tag = `${MARKER_BEGIN} ${id}`;
  const close = `${MARKER_END} ${id}`;
  if (comment === 'slash') return { begin: `// ${tag}`, end: `// ${close}` };
  if (comment === 'hash') return { begin: `# ${tag}`, end: `# ${close}` };
  if (comment === 'semi') return { begin: `; ${tag}`, end: `; ${close}` };
  return { begin: `<!-- ${tag} -->`, end: `<!-- ${close} -->` };
}
