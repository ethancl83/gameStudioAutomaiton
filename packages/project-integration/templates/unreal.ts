import { CATALOG, marker } from '../catalog.js';
import { rewardedUnit } from '../ids.js';
import type { IntegrationFinding, PlannedFileChange, SdkCatalogEntry, TemplateContext, TemplatePlan } from '../types.js';

export function planUnreal(ctx: TemplateContext, existing: Map<string, string | null>): TemplatePlan {
  const findings: IntegrationFinding[] = [];
  const changes: PlannedFileChange[] = [];
  const catalog: SdkCatalogEntry[] = [];
  const ads = ctx.provider === 'admob' || ctx.provider === 'applovin-max';
  const iap = ctx.products.length > 0 || ctx.provider === 'play-billing' || ctx.provider === 'app-store';
  const uproject = [...existing.keys()].find((path) => path.endsWith('.uproject'));

  if (!uproject) {
    findings.push({
      code: 'detect.not_unreal',
      severity: 'error',
      message: '.uproject 파일이 없습니다.',
      fixHint: 'Unreal 프로젝트 루트를 선택하세요.',
    });
    return { supported: false, catalog, changes, findings };
  }

  if (ctx.provider === 'applovin-max') {
    findings.push({
      code: 'scope.unreal_max_unsupported',
      severity: 'error',
      message: 'AppLovin MAX Unreal 플러그인은 공식 문서가 있으나 이 도구는 플러그인 바이너리를 받지 않아 설치·런타임 검증하지 않습니다.',
      fixHint: 'Epic AndroidAdvertising AdMob 경로를 사용하거나 AppLovin 공식 Unreal 플러그인을 에디터에서 직접 설치하세요.',
    });
    return { supported: false, catalog, changes, findings };
  }

  if (ads) catalog.push(CATALOG.unrealAndroidAdvertising);
  if (iap && ctx.platform === 'android') catalog.push(CATALOG.playBilling);
  if (iap && ctx.platform === 'ios') catalog.push(CATALOG.storeKit2);
  if (ads && ctx.adUnits.some((unit) => String(unit.adFormat ?? '').toUpperCase().includes('REWARD'))) {
    findings.push({
      code: 'scope.unreal_rewarded_unsupported',
      severity: 'warning',
      message: 'Unreal 퍼스트파티 AndroidAdvertising은 배너·전면만 문서화되어 있습니다. ShowRewardedAd는 호출하지 않습니다.',
      fixHint: 'IAdvertisingProvider::ShowAdBanner / LoadInterstitialAd / ShowInterstitialAd 를 사용합니다.',
    });
  }

  const iniPath = 'Config/DefaultEngine.ini';
  let ini = existing.get(iniPath) ?? '';
  const mark = marker('unreal-admob', 'semi');
  const units = ctx.adUnits.map((item) => item.adUnitId);
  const reward = rewardedUnit(ctx.adUnits)?.adUnitId;
  if (ads) {
    const block = [
      mark.begin,
      '[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]',
      'bEnableGooglePlaySupport=True',
      ...units.map((id, index) => `AdMobAdUnitIDs=${index > 0 ? id : id}`),
      ...(ctx.appId ? [`GooglePlayAppID=${ctx.appId}`] : []),
      mark.end,
      '',
    ].join('\n');
    if (ini.includes(mark.begin)) {
      const begin = ini.indexOf(mark.begin);
      const end = ini.indexOf(mark.end);
      if (end > begin) ini = `${ini.slice(0, begin)}${block}${ini.slice(end + mark.end.length)}`;
    } else {
      ini = `${ini.trimEnd()}\n\n${block}`;
    }
    changes.push({
      path: iniPath,
      action: existing.get(iniPath) ? 'patch' : 'create',
      reason: 'Epic 공식 AndroidRuntimeSettings AdMob Ad Unit IDs',
      content: ini.endsWith('\n') ? ini : `${ini}\n`,
    });
  }

  const moduleName = uproject.replace(/\.uproject$/, '');
  const targetPath = [...existing.keys()].find((path) => path.endsWith('.Target.cs')) ?? `Source/${moduleName}.Target.cs`;
  let target = existing.get(targetPath);
  if (!target) {
    target = `using UnrealBuildTool;\npublic class ${moduleName}Target : TargetRules\n{\n    public ${moduleName}Target(TargetInfo Target) : base(Target)\n    {\n        Type = TargetType.Game;\n        ExtraModuleNames.Add("${moduleName}");\n    }\n}\n`;
  }
  const extra = [
    `        if (Target.Platform == UnrealTargetPlatform.${ctx.platform === 'android' ? 'Android' : 'IOS'})`,
    '        {',
    `            ${marker('unreal-modules', 'slash').begin}`,
    '            ExtraModuleNames.Add("OnlineSubsystem");',
    ctx.platform === 'android' ? '            ExtraModuleNames.Add("OnlineSubsystemGooglePlay");' : '            ExtraModuleNames.Add("OnlineSubsystemIOS");',
    ctx.platform === 'android' ? '            ExtraModuleNames.Add("AndroidAdvertising");' : '            ExtraModuleNames.Add("IOSAdvertising");',
    `            ${marker('unreal-modules', 'slash').end}`,
    '        }',
  ].join('\n');
  const tMark = marker('unreal-modules', 'slash');
  if (!target.includes(tMark.begin)) {
    const inserted = insertIntoCsharpConstructor(target, `${extra}\n`);
    if (!inserted) {
      findings.push({
        code: 'format.unreal_target',
        severity: 'error',
        message: 'Target.cs 생성자 본문을 찾지 못해 ExtraModuleNames를 삽입하지 않습니다. 클래스 마지막 중괄호 밖에는 넣지 않습니다.',
        path: targetPath,
      });
      return { supported: false, catalog, changes, findings };
    }
    target = inserted;
    changes.push({
      path: targetPath,
      action: existing.get(targetPath) ? 'patch' : 'create',
      reason: 'Epic AdMob C++ 문서: Target.cs 생성자 안의 ExtraModuleNames',
      content: target,
    });
  }

  const buildPath = [...existing.keys()].find((path) => path.endsWith('.Build.cs') && path.startsWith('Source/'))
    ?? `Source/${moduleName}/${moduleName}.Build.cs`;
  let build = existing.get(buildPath);
  if (!build) {
    build = `using UnrealBuildTool;\npublic class ${moduleName} : ModuleRules\n{\n    public ${moduleName}(ReadOnlyTargetRules Target) : base(Target)\n    {\n        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;\n        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });\n    }\n}\n`;
  }
  const bMark = marker('unreal-build-deps', 'slash');
  if (!build.includes(bMark.begin)) {
    const deps = ctx.platform === 'android'
      ? '"Advertising", "OnlineSubsystem", "OnlineSubsystemUtils", "OnlineSubsystemGooglePlay"'
      : '"Advertising", "OnlineSubsystem", "OnlineSubsystemUtils", "OnlineSubsystemIOS"';
    const insert = `        ${bMark.begin}\n        PublicDependencyModuleNames.AddRange(new string[] { ${deps} });\n        ${bMark.end}\n`;
    const insertedBuild = insertIntoCsharpConstructor(build, insert);
    if (!insertedBuild) {
      findings.push({
        code: 'format.unreal_build_cs',
        severity: 'error',
        message: 'Build.cs 생성자 본문을 찾지 못해 모듈 의존성을 삽입하지 않습니다.',
        path: buildPath,
      });
    } else {
      changes.push({
        path: buildPath,
        action: existing.get(buildPath) ? 'patch' : 'create',
        reason: '게임 모듈 Build.cs 생성자의 PublicDependencyModuleNames',
        content: insertedBuild,
      });
    }
  }

  if (ads) {
    changes.push({
      path: `Source/${moduleName}/AppOpsAds.cpp`,
      action: 'create',
      reason: 'IAdvertisingProvider ShowAdBanner / LoadInterstitialAd / ShowInterstitialAd',
      content: unrealAdsCpp(moduleName, units[0] ?? ''),
    });
    changes.push({
      path: `Source/${moduleName}/AppOpsAds.h`,
      action: 'create',
      reason: '광고 브리지 헤더',
      content: `#pragma once
#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "AppOpsAds.generated.h"

UCLASS()
class UAppOpsAds : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()
public:
    UFUNCTION(BlueprintCallable, Category="AppOps")
    static void InitializeAds();
    UFUNCTION(BlueprintCallable, Category="AppOps")
    static void ShowBanner();
    UFUNCTION(BlueprintCallable, Category="AppOps")
    static void ShowInterstitial();
};
`,
    });
  }
  if (iap) {
    changes.push({
      path: `Source/${moduleName}/AppOpsStore.h`,
      action: 'create',
      reason: '게임/Blueprint에서 호출 가능한 OnlineStore 구매/복원 공개 API와 검증 콜백 선언',
      content: unrealStoreHeader(moduleName),
    });
    changes.push({
      path: `Source/${moduleName}/AppOpsStore.cpp`,
      action: 'create',
      reason: 'OnlineStoreInterface 구매/복원 브리지',
      content: unrealStoreCpp(ctx.products),
    });
  }
  return { supported: findings.every((item) => item.severity !== 'error'), catalog, changes, findings };
}

function insertIntoCsharpConstructor(source: string, extra: string): string | null {
  const match = source.match(/\)\s*:\s*base\s*\(\s*\w+\s*\)\s*\{/);
  if (!match || match.index === undefined) return null;
  const open = source.indexOf('{', match.index);
  if (open < 0) return null;
  const close = matchingBrace(source, open);
  if (close < 0) return null;
  return `${source.slice(0, close)}${extra}${source.slice(close)}`;
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function unrealAdsCpp(module: string, unit: string): string {
  return `// APPOPS-INTEGRATION-BEGIN unreal-admob-bridge
// Official: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Advertising/FAdvertising
// GetDefaultProvider() returns IAdvertisingProvider*
#include "AppOpsAds.h"
#include "Advertising.h"
#include "Interfaces/IAdvertisingProvider.h"

void UAppOpsAds::InitializeAds()
{
    if (!FAdvertising::IsAvailable()) return;
    IAdvertisingProvider* Ads = FAdvertising::Get().GetDefaultProvider();
    if (Ads)
    {
        Ads->HideAdBanner();
        Ads->LoadInterstitialAd(0);
    }
}

void UAppOpsAds::ShowBanner()
{
    if (!FAdvertising::IsAvailable()) return;
    IAdvertisingProvider* Ads = FAdvertising::Get().GetDefaultProvider();
    if (Ads) { Ads->ShowAdBanner(true, 0); }
}

void UAppOpsAds::ShowInterstitial()
{
    if (!FAdvertising::IsAvailable()) return;
    IAdvertisingProvider* Ads = FAdvertising::Get().GetDefaultProvider();
    if (Ads && Ads->IsInterstitialAdAvailable()) { Ads->ShowInterstitialAd(); }
    else { UE_LOG(LogTemp, Warning, TEXT("Interstitial unit %s not ready"), TEXT("${unit}")); }
}
// APPOPS-INTEGRATION-END unreal-admob-bridge
`;
}

function unrealStoreHeader(module: string): string {
  const api = `${module.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_API`;
  return `#pragma once
#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "AppOpsStore.generated.h"

// ProductId, positive Quantity, purchase identifier, opaque platform ValidationInfo.
DECLARE_DELEGATE_FourParams(FAppOpsVerificationRequired, const FString&, int32, const FString&, const FString&);

UCLASS()
class ${api} UAppOpsStore : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()
public:
    static FAppOpsVerificationRequired VerificationRequired;

    UFUNCTION(BlueprintCallable, Category="AppOps")
    static void QueryProducts();
    UFUNCTION(BlueprintCallable, Category="AppOps")
    static void Purchase(const FString& ProductId);
    UFUNCTION(BlueprintCallable, Category="AppOps")
    static void Restore();
    UFUNCTION(BlueprintCallable, Category="AppOps")
    static void CompleteVerifiedPurchase(const FString& PurchaseToken);
};
`;
}

function unrealStoreCpp(products: TemplateContext['products']): string {
  const entries = products.map((item) => {
    const consumable = item.productType === 'inapp' || item.productType === 'consumable';
    return `{ TEXT("${item.productId}"), ${consumable ? 'true' : 'false'} }`;
  }).join(', ');
  return `// APPOPS-INTEGRATION-BEGIN unreal-store-bridge
#include "AppOpsStore.h"
#include "OnlineSubsystem.h"
#include "Interfaces/OnlineIdentityInterface.h"
#include "Interfaces/OnlinePurchaseInterface.h"
#include "Interfaces/OnlineStoreInterfaceV2.h"

struct FAppOpsProduct
{
    const TCHAR* ProductId;
    bool bIsConsumable;
};

static const TArray<FAppOpsProduct> AppOpsProducts = { ${entries} };
static constexpr int32 AppOpsMaxReceiptQuantity = 1000;

FAppOpsVerificationRequired UAppOpsStore::VerificationRequired;

static TSharedPtr<const FUniqueNetId> AppOpsUser()
{
    IOnlineSubsystem* OSS = IOnlineSubsystem::Get();
    if (!OSS || !OSS->GetIdentityInterface().IsValid()) return nullptr;
    return OSS->GetIdentityInterface()->GetUniquePlayerId(0);
}

static const FAppOpsProduct* AppOpsFindProduct(const FString& ProductId)
{
    for (const FAppOpsProduct& Product : AppOpsProducts)
    {
        if (ProductId == Product.ProductId) return &Product;
    }
    return nullptr;
}

static void AppOpsEmitReceipt(const FPurchaseReceipt& Receipt)
{
    for (const FPurchaseReceipt::FReceiptOfferEntry& Offer : Receipt.ReceiptOffers)
    {
        if (!AppOpsFindProduct(Offer.OfferId) || Offer.Quantity <= 0 || Offer.Quantity > AppOpsMaxReceiptQuantity) continue;
        for (const FPurchaseReceipt::FLineItemInfo& LineItem : Offer.LineItems)
        {
            if (LineItem.ValidationInfo.IsEmpty()) continue;
            UAppOpsStore::VerificationRequired.ExecuteIfBound(
                Offer.OfferId,
                Offer.Quantity,
                Receipt.TransactionId,
                LineItem.ValidationInfo);
        }
    }
}

void UAppOpsStore::QueryProducts()
{
    IOnlineSubsystem* OSS = IOnlineSubsystem::Get();
    TSharedPtr<const FUniqueNetId> User = AppOpsUser();
    if (!OSS || !User.IsValid()) return;
    IOnlineStoreV2Ptr Store = OSS->GetStoreV2Interface();
    if (!Store.IsValid()) return;
    TArray<FUniqueOfferId> Offers;
    for (const FAppOpsProduct& Product : AppOpsProducts) { Offers.Add(Product.ProductId); }
    Store->QueryOffersById(*User, Offers, FOnQueryOnlineStoreOffersComplete());
}

void UAppOpsStore::Purchase(const FString& ProductId)
{
    const FAppOpsProduct* Product = AppOpsFindProduct(ProductId);
    if (!Product) return;
    IOnlineSubsystem* OSS = IOnlineSubsystem::Get();
    TSharedPtr<const FUniqueNetId> User = AppOpsUser();
    if (!OSS || !User.IsValid()) return;
    IOnlinePurchasePtr Purchase = OSS->GetPurchaseInterface();
    if (!Purchase.IsValid()) return;
    FPurchaseCheckoutRequest Request;
    Request.AddPurchaseOffer(TEXT(""), ProductId, 1, Product->bIsConsumable);
    Purchase->Checkout(*User, Request, FOnPurchaseCheckoutComplete::CreateLambda([](const FOnlineError& Result, const TSharedRef<FPurchaseReceipt>& Receipt)
    {
        if (!Result.WasSuccessful()) return;
        AppOpsEmitReceipt(*Receipt);
    }));
}

void UAppOpsStore::Restore()
{
    IOnlineSubsystem* OSS = IOnlineSubsystem::Get();
    TSharedPtr<const FUniqueNetId> User = AppOpsUser();
    if (!OSS || !User.IsValid()) return;
    IOnlinePurchasePtr Purchase = OSS->GetPurchaseInterface();
    if (!Purchase.IsValid()) return;
    Purchase->QueryReceipts(*User, true, FOnQueryReceiptsComplete::CreateLambda([User](const FOnlineError& Result)
    {
        if (!Result.WasSuccessful()) return;
        TArray<FPurchaseReceipt> Receipts;
        IOnlineSubsystem::Get()->GetPurchaseInterface()->GetReceipts(*User, Receipts);
        for (const FPurchaseReceipt& Receipt : Receipts)
        {
            AppOpsEmitReceipt(Receipt);
        }
    }));
}

static void AppOpsCompleteVerifiedPurchase(const FString& PurchaseToken)
{
    IOnlineSubsystem* OSS = IOnlineSubsystem::Get();
    TSharedPtr<const FUniqueNetId> User = AppOpsUser();
    if (!OSS || !User.IsValid()) return;
    IOnlinePurchasePtr Purchase = OSS->GetPurchaseInterface();
    if (!Purchase.IsValid()) return;
    Purchase->FinalizePurchase(*User, PurchaseToken);
}

void UAppOpsStore::CompleteVerifiedPurchase(const FString& PurchaseToken)
{
    AppOpsCompleteVerifiedPurchase(PurchaseToken);
}
// APPOPS-INTEGRATION-END unreal-store-bridge
`;
}
