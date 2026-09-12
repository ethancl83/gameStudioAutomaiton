import { CATALOG } from '../catalog.js';
import { rewardedUnit } from '../ids.js';
import type { IntegrationFinding, PlannedFileChange, SdkCatalogEntry, TemplateContext, TemplatePlan } from '../types.js';

export function planUnity(ctx: TemplateContext, existing: Map<string, string | null>): TemplatePlan {
  const findings: IntegrationFinding[] = [];
  const changes: PlannedFileChange[] = [];
  const catalog: SdkCatalogEntry[] = [];
  const ads = ctx.provider === 'admob' || ctx.provider === 'applovin-max';
  const iap = ctx.products.length > 0 || ctx.provider === 'play-billing' || ctx.provider === 'app-store';

  if (existing.get('ProjectSettings/ProjectVersion.txt') == null && existing.get('ProjectSettings/ProjectSettings.asset') == null) {
    findings.push({
      code: 'detect.not_unity',
      severity: 'error',
      message: 'Unity 프로젝트 마커가 없습니다.',
      fixHint: 'ProjectSettings/ProjectVersion.txt 가 있는 원본 Unity 루트를 선택하세요.',
    });
    return { supported: false, catalog, changes, findings };
  }

  const manifestPath = 'Packages/manifest.json';
  let manifestRaw = existing.get(manifestPath) ?? '{\n  "dependencies": {}\n}\n';
  let manifest: { dependencies?: Record<string, string>; scopedRegistries?: { name: string; url: string; scopes: string[] }[] };
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('not object');
  } catch {
    findings.push({
      code: 'format.unity_manifest',
      severity: 'error',
      message: 'Packages/manifest.json 형식을 파싱할 수 없어 덮어쓰지 않습니다.',
      path: manifestPath,
    });
    return { supported: false, catalog, changes, findings };
  }
  manifest.dependencies = manifest.dependencies ?? {};
  manifest.scopedRegistries = manifest.scopedRegistries ?? [];

  const ensureRegistry = (name: string, url: string, scope: string) => {
    const found = manifest.scopedRegistries!.find((item) => item.url === url || item.scopes?.includes(scope));
    if (found) {
      if (!found.scopes.includes(scope)) found.scopes.push(scope);
      return;
    }
    manifest.scopedRegistries!.push({ name, url, scopes: [scope] });
  };

  if (ctx.provider === 'admob') {
    catalog.push(CATALOG.unityAdmob);
    ensureRegistry('package.openupm.com', 'https://package.openupm.com', 'com.google');
    const existingVersion = manifest.dependencies['com.google.ads.mobile'];
    if (existingVersion && existingVersion !== CATALOG.unityAdmob.version) {
      findings.push({
        code: 'conflict.unity_admob_version',
        severity: 'error',
        message: `이미 com.google.ads.mobile@${existingVersion} 이 있습니다.`,
        path: manifestPath,
        fixHint: `${CATALOG.unityAdmob.version}으로 맞추거나 기존 플러그인을 유지하세요.`,
      });
      return { supported: false, catalog, changes, findings };
    }
    manifest.dependencies['com.google.ads.mobile'] = CATALOG.unityAdmob.version;
  }
  if (ctx.provider === 'applovin-max') {
    catalog.push(CATALOG.unityMax);
    ensureRegistry('AppLovin', 'https://package.openupm.com', 'com.applovin');
    manifest.dependencies['com.applovin.mediation.ads'] = CATALOG.unityMax.version;
  }
  if (iap) {
    catalog.push(CATALOG.unityIap);
    manifest.dependencies['com.unity.purchasing'] = CATALOG.unityIap.version;
  }

  changes.push({
    path: manifestPath,
    action: existing.get(manifestPath) ? 'patch' : 'create',
    reason: '공식 UPM 패키지 버전을 manifest.json에 고정합니다. 바이너리는 다운로드하지 않습니다.',
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  });

  if (ctx.provider === 'admob' && ctx.appId) {
    const androidId = ctx.platform === 'android' ? ctx.appId : '';
    const iosId = ctx.platform === 'ios' ? ctx.appId : '';
    const settingsPath = 'Assets/GoogleMobileAds/Resources/GoogleMobileAdsSettings.asset';
    const existingSettings = existing.get(settingsPath);
    const officialSettingsScript = /m_Script:\s*\{[^\n]*guid:\s*a187246822bbb47529482707f3e0eff8\b/.test(existingSettings ?? '');
    if (existingSettings && officialSettingsScript) {
      let next = existingSettings;
      next = next.includes('adMobAndroidAppId:')
        ? next.replace(/adMobAndroidAppId:.*$/m, `adMobAndroidAppId: ${androidId}`)
        : `${next.trimEnd()}\n  adMobAndroidAppId: ${androidId}\n`;
      next = next.includes('adMobIOSAppId:')
        ? next.replace(/adMobIOSAppId:.*$/m, `adMobIOSAppId: ${iosId}`)
        : `${next.trimEnd()}\n  adMobIOSAppId: ${iosId}\n`;
      changes.push({
        path: settingsPath,
        action: 'patch',
        reason: '기존 GoogleMobileAdsSettings.asset 의 공식 직렬화 필드 adMobAndroidAppId/adMobIOSAppId 만 갱신합니다.',
        content: next.endsWith('\n') ? next : `${next}\n`,
      });
    } else {
      findings.push({
        code: 'unity.admob_settings_unbound',
        severity: 'warning',
        message: 'GoogleMobileAdsSettings.asset 이 없거나 m_Script가 없어 합성 YAML을 만들지 않습니다. Unity 메뉴 Assets > Google Mobile Ads > Settings에서 자산을 만든 뒤 다시 적용하세요.',
        path: settingsPath,
        fixHint: 'Google Mobile Ads 11.5.0의 공개 설정 UI로 자산을 생성하세요. Assets 외부 스크립트에서는 internal GoogleMobileAdsSettings/LoadInstance를 호출할 수 없습니다.',
      });
    }
  }

  if (ads) {
    if (!rewardedUnit(ctx.adUnits)) {
      findings.push({
        code: 'id.reward_unit_required',
        severity: 'error',
        message: 'Unity 보상형 브리지에는 adFormat=REWARD 단위가 필요합니다.',
      });
    } else {
      changes.push(unityAds(ctx));
    }
  }
  if (iap) changes.push(unityIap(ctx));
  if (ctx.provider === 'applovin-max') {
    const maxSettings = [...existing.keys()].find((path) => path.endsWith('AppLovinSettings.asset'));
    const maxSettingsContent = maxSettings ? existing.get(maxSettings) : null;
    const serializedSdkKey = maxSettingsContent?.match(/^\s*sdkKey:\s*(.*?)\s*$/m)?.[1] ?? '';
    const officialMaxSettingsScript = /m_Script:\s*\{[^\n]*guid:\s*ebc0ba1b5ef6b4a6b9dd53d7eadfea16\b/.test(maxSettingsContent ?? '');
    const maxSdkKeyConfigured = !['', '""', "''", 'null', '~', '«SDK-key»'].includes(serializedSdkKey);
    if (!maxSettings || !officialMaxSettingsScript || !maxSdkKeyConfigured) {
      findings.push({
        code: 'unity.max_settings_unbound',
        severity: 'warning',
        message: '공식 AppLovinSettings.asset 의 SdkKey가 비어 있습니다. maxSdkKeyBound 요청 플래그만으로 구성 완료를 판정하지 않습니다.',
        fixHint: 'Unity Editor 프로세스에 APPOPS_MAX_SDK_KEY를 일회성으로 제공해 공개 AppLovinSettings.Instance.SdkKey/SaveAsync 바인더를 실행하세요. 키 원문은 미리보기·저널에 넣지 마세요.',
      });
    }
    changes.push({
      path: 'Assets/MaxSdk/Editor/AppOpsBindMaxSettings.cs',
      action: 'create',
      reason: 'MAX 8.6.5 공개 AppLovinSettings.Instance.SdkKey/SaveAsync에 일회성 환경 스테이징 키를 바인딩',
      content: `using System;
using UnityEditor;
using UnityEngine;

[InitializeOnLoad]
static class AppOpsBindMaxSettings
{
    static AppOpsBindMaxSettings()
    {
        var settings = AppLovinSettings.Instance;
        var stagedSdkKey = Environment.GetEnvironmentVariable("APPOPS_MAX_SDK_KEY");
        if (!string.IsNullOrWhiteSpace(stagedSdkKey))
        {
            settings.SdkKey = stagedSdkKey.Trim();
            settings.SaveAsync();
        }
        if (string.IsNullOrWhiteSpace(settings.SdkKey))
            Debug.LogWarning("AppLovinSettings.SdkKey is empty; MAX remains unconfigured.");
    }
}
`,
    });
  }
  return { supported: findings.every((item) => item.severity !== 'error'), catalog, changes, findings };
}

function unityAds(ctx: TemplateContext): PlannedFileChange {
  const unit = rewardedUnit(ctx.adUnits)!.adUnitId;
  if (ctx.provider === 'applovin-max') {
    return {
      path: 'Assets/AppOps/AppOpsAds.cs',
      action: 'create',
      reason: 'MAX Unity MaxSdk.InitializeSdk / LoadRewardedAd / ShowRewardedAd',
      content: `using UnityEngine;

// APPOPS-INTEGRATION-BEGIN unity-max-bridge
// Official plugin 8.6.5: https://support.applovin.com/en/max/unity/overview/integration
public class AppOpsAds : MonoBehaviour
{
    public const string RewardedAdUnitId = ${JSON.stringify(unit)};

    void Start()
    {
        MaxSdkCallbacks.OnSdkInitializedEvent += _ => { MaxSdk.LoadRewardedAd(RewardedAdUnitId); };
        MaxSdkCallbacks.Rewarded.OnAdReceivedRewardEvent += (adUnitId, reward, adInfo) => { OnReward(reward.Label, reward.Amount); };
        MaxSdk.InitializeSdk();
    }

    public void ShowRewarded()
    {
        if (MaxSdk.IsRewardedAdReady(RewardedAdUnitId)) MaxSdk.ShowRewardedAd(RewardedAdUnitId);
    }

    protected virtual void OnReward(string label, int amount) {}
}
// APPOPS-INTEGRATION-END unity-max-bridge
`,
    };
  }
  return {
    path: 'Assets/AppOps/AppOpsAds.cs',
    action: 'create',
    reason: 'Unity Google Mobile Ads MobileAds.Initialize / RewardedAd.Load / Show',
    content: `using GoogleMobileAds.Api;
using UnityEngine;

// APPOPS-INTEGRATION-BEGIN unity-admob-bridge
// Official: https://developers.google.com/admob/unity/quick-start
// Plugin com.google.ads.mobile ${ctx.platform}
public class AppOpsAds : MonoBehaviour
{
    public const string RewardedAdUnitId = ${JSON.stringify(unit)};
    private RewardedAd rewarded;

    void Start()
    {
        MobileAds.Initialize(status =>
        {
            if (status == null) { Debug.LogError("Google Mobile Ads initialization failed."); return; }
            LoadRewarded();
        });
    }

    public void LoadRewarded()
    {
        var request = new AdRequest();
        RewardedAd.Load(RewardedAdUnitId, request, (RewardedAd ad, LoadAdError error) =>
        {
            if (error != null || ad == null) return;
            rewarded = ad;
        });
    }

    public void ShowRewarded()
    {
        if (rewarded == null || !rewarded.CanShowAd()) return;
        rewarded.Show(reward => { OnReward(reward.Type, (int)reward.Amount); });
    }

    protected virtual void OnReward(string type, int amount) {}
}
// APPOPS-INTEGRATION-END unity-admob-bridge
`,
  };
}

function unityIap(ctx: TemplateContext): PlannedFileChange {
  const defs = ctx.products.map((item) => {
    const type = item.productType === 'subs' ? 'ProductType.Subscription'
      : item.productType === 'nonConsumable' ? 'ProductType.NonConsumable'
      : 'ProductType.Consumable';
    return `            new ProductDefinition(${JSON.stringify(item.productId)}, ${type}),`;
  }).join('\n');
  return {
    path: 'Assets/AppOps/AppOpsPurchasing.cs',
    action: 'create',
    reason: 'Unity IAP 5.4.2 StoreController Connect / FetchProducts(List<ProductDefinition>) / ConfirmPurchase(PendingOrder)',
    content: `using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Purchasing;

// APPOPS-INTEGRATION-BEGIN unity-iap-bridge
// Official package com.unity.purchasing 5.4.2
// Sample: IntegratingSelfProvidedBackendReceiptValidation — do not ConfirmPurchase until verified.
public class AppOpsPurchasing : MonoBehaviour
{
    static readonly List<ProductDefinition> Catalog = new List<ProductDefinition>
    {
${defs}
    };
    StoreController store;
    readonly Dictionary<string, PendingOrder> pending = new Dictionary<string, PendingOrder>();
    public event Action<string, string, string> VerificationRequired;

    async void Start()
    {
        store = UnityIAPServices.StoreController();
        store.OnPurchasePending += OnPurchasePending;
        store.OnPurchasesFetched += OnPurchasesFetched;
        store.OnPurchasesFetchFailed += failure => Debug.LogError("FetchPurchases failed: " + failure.Message);
        store.OnStoreConnected += () => store.FetchProducts(Catalog);
        await store.Connect();
    }

    void OnPurchasePending(PendingOrder order)
    {
        var product = FirstProduct(order);
        if (product == null) return;
        var transactionId = order.Info.TransactionID;
        if (string.IsNullOrWhiteSpace(transactionId))
        {
            Debug.LogError("Pending purchase has no TransactionID; refusing verification/completion mapping.");
            return;
        }
        pending[transactionId] = order;
        VerificationRequired?.Invoke(product.definition.id, transactionId, order.Info.Receipt ?? "");
    }

    public void Purchase(string productId) => store?.PurchaseProduct(productId);

    public void Restore()
    {
        if (store == null) return;
        store.RestoreTransactions((ok, error) =>
        {
            if (!ok)
            {
                Debug.LogError("Restore failed: " + error);
                return;
            }
            store.FetchPurchases();
        });
    }

    void OnPurchasesFetched(Orders orders)
    {
        foreach (var order in orders.PendingOrders) OnPurchasePending(order);
        foreach (var order in orders.ConfirmedOrders) EmitRestoredEntitlement(order);
    }

    void EmitRestoredEntitlement(ConfirmedOrder order)
    {
        var product = FirstProduct(order);
        if (product == null || product.definition.type == ProductType.Consumable) return;
        var transactionId = order.Info.TransactionID;
        var receipt = order.Info.Receipt;
        if (string.IsNullOrWhiteSpace(transactionId) || string.IsNullOrWhiteSpace(receipt))
        {
            Debug.LogError("Restored entitlement is missing TransactionID or Receipt; refusing unverifiable restore.");
            return;
        }
        VerificationRequired?.Invoke(product.definition.id, transactionId, receipt);
    }

    public void CompleteVerifiedPurchase(string purchaseToken)
    {
        if (store == null) return;
        if (!pending.TryGetValue(purchaseToken, out var order)) return;
        store.ConfirmPurchase(order);
        pending.Remove(purchaseToken);
    }

    static Product FirstProduct(Order order)
    {
        foreach (var item in order.CartOrdered.Items()) return item.Product;
        return null;
    }
}
// APPOPS-INTEGRATION-END unity-iap-bridge
`,
  };
}
