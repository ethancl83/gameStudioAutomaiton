import type { SdkDetection, TemplatePlan, VerifiedAdUnit, VerifiedProduct, WiringCheck } from './types.js';

const GENERATED = /(?:^|\/)(?:AppOps|appops|AppOpsMonetization|addons\/appops_monetization)\b/;

const EVENT_APIS: Record<WiringCheck['event'], RegExp[]> = {
  'ad.initialize': [
    /\bMobileAds\s*\.\s*initialize\s*\(/,
    /\bMobileAds\s*\.\s*Initialize\s*\(/,
    /\bMobileAds\s*\.\s*shared\s*\.\s*start\s*\(/,
    /\bMaxSdk\s*\.\s*InitializeSdk\s*\(/,
    /\bAppLovinSdkInitializationConfiguration\s*\.\s*builder\s*\(/,
    /\bALSdkInitializationConfiguration\s*\(/,
    /\bFAdvertising\s*::\s*Get\s*\(/,
    /\bShowAdBanner\s*\(/,
  ],
  'ad.show': [
    /\bRewardedAd\s*\.\s*load\s*\(/,
    /\bRewardedAd\s*\.\s*Load\s*\(/,
    /\bshowRewarded\s*\(/,
    /\bShowRewarded\s*\(/,
    /\bMaxRewardedAd\s*\.\s*getInstance\s*\(/,
    /\bMaxSdk\s*\.\s*ShowRewardedAd\s*\(/,
    /\brewardedAd\s*\.\s*show\s*\(/,
    /\bShowInterstitialAd\s*\(/,
    /\bshow_rewarded\s*\(/,
  ],
  'ad.reward': [
    /\bOnUserEarnedRewardListener\b/,
    /\bonUserRewarded\s*\(/,
    /\bOnAdReceivedRewardEvent\b/,
    /\bdidRewardUser\s*\(/,
    /\bOnReward\s*\(/,
    /\badReward\b/,
  ],
  purchase: [
    /\blaunchBillingFlow\s*\(/,
    /\bPurchaseProduct\s*\(/,
    /\bproduct\s*\.\s*purchase\s*\(/,
    /\bbilling_client\s*\.\s*purchase\s*\(/,
    /\bCheckout\s*\(/,
    /\bCompleteVerifiedPurchase\s*\(/,
    /\bcompleteVerifiedPurchase\s*\(/,
    /\bcomplete_verified_purchase\s*\(/,
  ],
  restore: [
    /\bqueryPurchasesAsync\s*\(/,
    /\bRestoreTransactions\s*\(/,
    /\bAppStore\s*\.\s*sync\s*\(/,
    /\bquery_purchases\s*\(/,
    /\bQueryReceipts\s*\(/,
    /\bFetchPurchases\s*\(/,
  ],
};

const GAME_HOOKS: Record<WiringCheck['event'], RegExp[]> = {
  'ad.initialize': [/\bAppOpsAds\s*\.\s*(?:initialize|Initialize)\s*\(/, /\bAppOpsAds\.shared\.initialize\s*\(/],
  'ad.show': [/\bAppOpsAds\s*\.\s*(?:showRewarded|ShowRewarded|show_rewarded|ShowBanner|showBanner)\s*\(/],
  'ad.reward': [/\bOnReward\s*\(/, /\bon_user_rewarded\s*\(/, /\bVerificationRequired\b/],
  purchase: [/\bAppOps(?:Billing|Purchasing|Store)\s*\.\s*(?:purchase|Purchase)\s*\(/, /\bcompleteVerifiedPurchase\s*\(/, /\bCompleteVerifiedPurchase\s*\(/],
  restore: [/\bAppOps(?:Billing|Purchasing|Store)\s*\.\s*(?:restore|Restore)\s*\(/],
};

export function stripCodeComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*#(?!include|pragma|if|endif|define).*$/gm, '')
    .replace(/^\s*;.*$/gm, '');
}

export function isGeneratedPath(path: string): boolean {
  return GENERATED.test(path.replaceAll('\\', '/'));
}

function fileHasApi(content: string, patterns: RegExp[]): boolean {
  const code = stripCodeComments(content);
  return patterns.some((pattern) => pattern.test(code));
}

export function wiringChecks(
  plan: TemplatePlan,
  detection: SdkDetection,
  adUnits: VerifiedAdUnit[],
  products: VerifiedProduct[],
  wantAds: boolean,
  wantIap: boolean,
): WiringCheck[] {
  const checks: WiringCheck[] = [];
  const events: WiringCheck['event'][] = [];
  if (wantAds) events.push('ad.initialize', 'ad.show', 'ad.reward');
  if (wantIap) events.push('purchase', 'restore');

  const pluginBlock = plan.findings.find((item) => item.code.startsWith('plugin.') && item.severity !== 'info');
  const generated = plan.changes.filter((change) => isGeneratedPath(change.path));
  const gameFiles = [
    ...plan.changes.filter((change) => !isGeneratedPath(change.path)),
    ...detection.sdks.filter((sdk) => sdk.id.startsWith('game-hook-')).map((sdk) => ({ path: sdk.evidence, content: sdk.evidence })),
  ];

  for (const event of events) {
    const apis = EVENT_APIS[event];
    const hooks = GAME_HOOKS[event];
    const generatedHit = generated.find((change) => fileHasApi(change.content ?? '', apis));
    const gameHit = gameFiles.find((change) => fileHasApi(change.content ?? '', hooks) || fileHasApi(change.content ?? '', apis));
    const detectedHook = detection.sdks.find((sdk) => sdk.id === `game-hook-${event}`);

    if (event.startsWith('ad.') && adUnits.length === 0) {
      checks.push({ event, status: 'missing', detail: '검증된 광고 단위 ID가 없어 이벤트 배선을 완료로 표시하지 않습니다.' });
      continue;
    }
    if ((event === 'purchase' || event === 'restore') && products.length === 0) {
      checks.push({ event, status: 'missing', detail: '검증된 상품 ID가 없어 구매 배선을 완료로 표시하지 않습니다.' });
      continue;
    }
    if (pluginBlock) {
      checks.push({
        event,
        status: 'installed_unwired',
        detail: `브리지 코드는 추가되지만 ${pluginBlock.message}`,
        path: generatedHit?.path ?? pluginBlock.path,
      });
      continue;
    }
    if (detectedHook || gameHit) {
      checks.push({
        event,
        status: 'wired',
        detail: `게임 코드가 ${event} 훅을 호출합니다.`,
        path: detectedHook?.evidence ?? gameHit?.path,
      });
      continue;
    }
    if (generatedHit) {
      checks.push({
        event,
        status: 'installed_unwired',
        detail: `공식 API 브리지는 ${generatedHit.path} 에 설치되었습니다. 게임이 해당 훅을 호출해야 배선 완료입니다.`,
        path: generatedHit.path,
      });
      continue;
    }
    if (!plan.supported) {
      checks.push({ event, status: 'conflict', detail: '템플릿을 적용할 수 없어 배선을 성공으로 표시하지 않습니다.' });
    } else {
      checks.push({ event, status: 'missing', detail: '해당 공식 API 호출이 계획에 없습니다.' });
    }
  }
  if (!wantAds && !wantIap) {
    checks.push({ event: 'ad.initialize', status: 'unsupported', detail: '광고·결제 입력이 없습니다.' });
  }
  return checks;
}
