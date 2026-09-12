import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planAndroid } from '../packages/project-integration/templates/android.js';
import { planGodot } from '../packages/project-integration/templates/godot.js';
import { planUnreal } from '../packages/project-integration/templates/unreal.js';
import { planUnity } from '../packages/project-integration/templates/unity.js';
import type { TemplateContext } from '../packages/project-integration/types.js';

function ctx(engine: TemplateContext['engine']): TemplateContext {
  return {
    root: '/tmp',
    engine,
    platform: 'android',
    provider: engine === 'unreal' ? 'admob' : 'admob',
    appId: 'ca-app-pub-3940256099942544~3347511713',
    adUnits: [{ adUnitId: 'ca-app-pub-3940256099942544/5224354917', adFormat: 'INTER' }],
    products: [{ productId: 'coins_100', productType: 'inapp' }],
    maxSdkKeyBound: false,
    detection: { root: '/tmp', engine, engineEvidence: [], sdks: [], findings: [] },
  };
}

test('Unity generated IAP matches official 5.4.2 StoreController signatures', async () => {
  const source = await readFile('/tmp/appops-v4-sdk-review.JVhp3D/unity-iap/package/Runtime/Purchasing/Core/StoreController.cs', 'utf8');
  const orderInfo = await readFile('/tmp/appops-v4-sdk-review.JVhp3D/unity-iap/package/Runtime/Purchasing/Core/Purchasing/Models/Interfaces/IOrderInfo.cs', 'utf8');
  assert.match(source, /void FetchProducts\(List<ProductDefinition>/);
  assert.match(source, /event Action<Orders>\? OnPurchasesFetched/);
  assert.match(source, /event Action<PurchasesFetchFailureDescription>\? OnPurchasesFetchFailed/);
  assert.match(source, /void FetchPurchases\(\)/);
  assert.match(source, /void RestoreTransactions\(Action<bool, string\?>/);
  assert.match(source, /void ConfirmPurchase\(PendingOrder order\)/);
  assert.doesNotMatch(source, /void Acknowledge\(/);
  assert.match(orderInfo, /string TransactionID \{ get; \}/);
  const plan = planUnity(ctx('unity'), new Map([
    ['ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3\n'],
    ['Packages/manifest.json', '{ "dependencies": {} }'],
  ]));
  const generated = plan.changes.find((item) => item.path.endsWith('AppOpsPurchasing.cs'))?.content ?? '';
  assert.match(generated, /FetchProducts\(Catalog\)/);
  assert.match(generated, /OnPurchasesFetched \+= OnPurchasesFetched/);
  assert.match(generated, /OnPurchasesFetchFailed/);
  assert.match(generated, /Info\.TransactionID/);
  assert.match(generated, /ConfirmPurchase\(order\)/);
  assert.match(generated, /RestoreTransactions\(\(ok, error\)/);
});

test('Unity MAX binder uses the pinned 8.6.5 public typed settings API', async () => {
  const source = await readFile('/tmp/appops-v4-sdk-review.JVhp3D/max-unity/ebc0ba1b5ef6b4a6b9dd53d7eadfea16/asset', 'utf8');
  assert.match(source, /public class AppLovinSettings : ScriptableObject/);
  assert.match(source, /public static AppLovinSettings Instance/);
  assert.match(source, /public string SdkKey/);
  assert.match(source, /public void SaveAsync\(\)/);
  const plan = planUnity({
    ...ctx('unity'),
    provider: 'applovin-max',
    appId: undefined,
    adUnits: [{ adUnitId: 'max_rewarded_123', adFormat: 'REWARD' }],
    maxSdkKeyBound: true,
  }, new Map([
    ['ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3\n'],
    ['Packages/manifest.json', '{ "dependencies": {} }'],
  ]));
  const binder = plan.changes.find((item) => item.path.endsWith('AppOpsBindMaxSettings.cs'))?.content ?? '';
  assert.match(binder, /AppLovinSettings\.Instance/);
  assert.match(binder, /settings\.SdkKey = stagedSdkKey\.Trim\(\)/);
  assert.match(binder, /settings\.SaveAsync\(\)/);
});

test('Android billing calls compile against official Play Billing 9.1.0 classes.jar', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-javac-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'android/app'), { recursive: true });
  await mkdir(join(dir, 'android/content'), { recursive: true });
  await writeFile(join(dir, 'android/content/Context.java'), 'package android.content; public class Context {}\n');
  await writeFile(join(dir, 'android/app/Activity.java'), 'package android.app; public class Activity extends android.content.Context {}\n');
  const plan = planAndroid(ctx('android'), new Map([
    ['app/build.gradle', 'dependencies {\n}\n'],
    ['app/src/main/AndroidManifest.xml', '<manifest><application></application></manifest>\n'],
  ]));
  const kt = plan.changes.find((item) => item.path.endsWith('AppOpsBilling.kt'))?.content ?? '';
  assert.match(kt, /queryProductDetailsAsync/);
  assert.match(kt, /queryResult\.productDetailsList/);
  const java = `import android.app.Activity;
import com.android.billingclient.api.*;
public class ApiCheck {
  static void check(Activity activity) {
    BillingClient client = BillingClient.newBuilder(activity)
      .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
      .setListener((result, purchases) -> {})
      .build();
    client.queryProductDetailsAsync(
      QueryProductDetailsParams.newBuilder().setProductList(java.util.List.of()).build(),
      (BillingResult result, QueryProductDetailsResult details) -> { details.getProductDetailsList(); });
    client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken("t").build(), r -> {});
    client.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken("t").build(), (r, token) -> {});
  }
}
`;
  await writeFile(join(dir, 'ApiCheck.java'), java);
  const javac = spawnSync('javac', [
    '-classpath', `/tmp/appops-v4-sdk-review.JVhp3D/billing/classes.jar:${dir}`,
    '-d', dir,
    join(dir, 'android/content/Context.java'),
    join(dir, 'android/app/Activity.java'),
    join(dir, 'ApiCheck.java'),
  ], { encoding: 'utf8' });
  assert.equal(javac.status, 0, javac.stderr || javac.stdout);
});

test('Godot 4.3 parses the generated Billing 3.3.0 bridge against its public script contract', async (t) => {
  const godot = '/tmp/appops-godot-verification-20260911/downloads/Godot_v4.3-stable_linux.x86_64';
  if (!spawnSync(godot, ['--version'], { encoding: 'utf8' }).stdout.includes('4.3')) {
    t.skip('downloaded Godot 4.3 verification binary is unavailable');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'appops-godot-billing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'project.godot'), '[application]\nconfig/name="AppOps Billing Compile"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  await writeFile(join(dir, 'BillingClient.gd'), `class_name BillingClient extends Node
signal connected
signal query_product_details_response(response: Dictionary)
signal query_purchases_response(response: Dictionary)
signal on_purchase_updated(response: Dictionary)
enum BillingResponseCode { OK = 0, DEVELOPER_ERROR = 5, ERROR = 6 }
enum ProductType { INAPP, SUBS }
enum PurchaseState { UNSPECIFIED_STATE, PURCHASED, PENDING }
func start_connection() -> void: pass
func query_product_details(_ids: PackedStringArray, _type: ProductType) -> void: pass
func query_purchases(_type: ProductType, _include_suspended_subs: bool = false) -> void: pass
func purchase(_product_id: String, _purchase_option_id: String = "", _offer_id: String = "", _personalized: bool = false) -> Dictionary: return {}
func purchase_subscription(_product_id: String, _base_plan_id: String, _offer_id: String = "", _personalized: bool = false) -> Dictionary: return {}
func consume_purchase(_purchase_token: String) -> void: pass
func acknowledge_purchase(_purchase_token: String) -> void: pass
`);
  const plan = planGodot({
    ...ctx('godot'),
    provider: 'play-billing',
    adUnits: [],
    products: [
      { productId: 'coins_100', productType: 'consumable' },
      { productId: 'premium', productType: 'nonConsumable' },
      { productId: 'season_pass', productType: 'subs' },
    ],
  }, new Map([
    ['project.godot', '[application]\nconfig/name="AppOps Billing Compile"\n'],
    ['addons/GodotGooglePlayBilling/plugin.cfg', '[plugin]\nname="GodotGooglePlayBilling"\n'],
  ]));
  const generated = plan.changes.find((item) => item.path.endsWith('app_ops_billing.gd'))?.content ?? '';
  await writeFile(join(dir, 'AppOpsBilling.gd'), generated);
  const check = spawnSync(godot, ['--headless', '--editor', '--path', dir, '--quit'], { encoding: 'utf8' });
  const output = `${check.stdout}\n${check.stderr}`;
  assert.equal(check.status, 0, output);
  assert.doesNotMatch(output, /SCRIPT ERROR|Parse Error|Failed to load script/);
});

test('Unreal generated ads compile against official IAdvertisingProvider stubs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-gxx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'Interfaces'), { recursive: true });
  await writeFile(join(dir, 'CoreMinimal.h'), '#pragma once\n#define TEXT(x) x\n#define UE_LOG(...)\nstruct FString { FString(const char*) {} };\ntemplate<typename T> struct TSharedPtr { bool IsValid() const { return true; } T* operator->() { return nullptr; } };\n');
  await mkdir(join(dir, 'Kismet'), { recursive: true });
  await writeFile(join(dir, 'Kismet/BlueprintFunctionLibrary.h'), '#pragma once\nclass UBlueprintFunctionLibrary {};\n');
  await writeFile(join(dir, 'AppOpsAds.generated.h'), '#pragma once\n#define UCLASS() \n#define GENERATED_BODY() \n#define UFUNCTION(...) \n');
  await writeFile(join(dir, 'Interfaces/IAdvertisingProvider.h'), `#pragma once
class IAdvertisingProvider {
public:
  virtual void ShowAdBanner(bool bShowOnBottomOfScreen, int adID) = 0;
  virtual void HideAdBanner() = 0;
  virtual void CloseAdBanner() = 0;
  virtual int GetAdIDCount() = 0;
  virtual void LoadInterstitialAd(int adID) = 0;
  virtual bool IsInterstitialAdAvailable() = 0;
  virtual bool IsInterstitialAdRequested() = 0;
  virtual void ShowInterstitialAd() = 0;
};
`);
  await writeFile(join(dir, 'Advertising.h'), `#pragma once
#include "Interfaces/IAdvertisingProvider.h"
struct FAdvertising {
  static FAdvertising& Get() { static FAdvertising i; return i; }
  static bool IsAvailable() { return false; }
  IAdvertisingProvider* GetDefaultProvider() { return nullptr; }
};
`);
  const plan = planUnreal(ctx('unreal'), new Map([
    ['Game.uproject', '{"FileVersion":3}\n'],
    ['Source/Game.Target.cs', 'public class GameTarget : TargetRules { public GameTarget(TargetInfo Target) : base(Target) { ExtraModuleNames.Add("Game"); } }'],
    ['Config/DefaultEngine.ini', ''],
  ]));
  const cpp = plan.changes.find((item) => item.path.endsWith('AppOpsAds.cpp'))?.content ?? '';
  const header = plan.changes.find((item) => item.path.endsWith('AppOpsAds.h'))?.content ?? '';
  await writeFile(join(dir, 'AppOpsAds.h'), header);
  await writeFile(join(dir, 'AppOpsAds.cpp'), cpp);
  const gxx = spawnSync('g++', ['-std=c++17', '-fsyntax-only', '-I', dir, join(dir, 'AppOpsAds.cpp')], { encoding: 'utf8' });
  assert.equal(gxx.status, 0, gxx.stderr || gxx.stdout);
});

test('Unreal generated store compiles against the reviewed OnlineSubsystem receipt contract', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'appops-unreal-store-gxx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'Interfaces'), { recursive: true });
  await mkdir(join(dir, 'Kismet'), { recursive: true });
  await writeFile(join(dir, 'CoreMinimal.h'), `#pragma once
#include <memory>
#include <string>
#include <vector>
using int32 = int;
using TCHAR = char;
#define TEXT(x) x
#define HARBOR_API
#define DECLARE_DELEGATE_FourParams(Name, A, B, C, D) struct Name { template<class... T> void ExecuteIfBound(T&&...) {} };
struct FString {
  std::string value;
  FString() = default;
  FString(const char* input) : value(input) {}
  bool IsEmpty() const { return value.empty(); }
  bool operator==(const char* input) const { return value == input; }
};
template<class T> struct TArray : std::vector<T> {
  using std::vector<T>::vector;
  void Add(const T& value) { this->push_back(value); }
  int32 Num() const { return static_cast<int32>(this->size()); }
};
template<class T> struct TSharedPtr {
  std::shared_ptr<T> value;
  TSharedPtr() = default;
  TSharedPtr(std::nullptr_t) {}
  bool IsValid() const { return static_cast<bool>(value); }
  T* operator->() const { return value.get(); }
  T& operator*() const { return *value; }
};
template<class T> struct TSharedRef {
  std::shared_ptr<T> value;
  T* operator->() const { return value.get(); }
  T& operator*() const { return *value; }
};
`);
  await writeFile(join(dir, 'Kismet/BlueprintFunctionLibrary.h'), '#pragma once\nclass UBlueprintFunctionLibrary {};\n');
  await writeFile(join(dir, 'AppOpsStore.generated.h'), '#pragma once\n#define UCLASS()\n#define GENERATED_BODY()\n#define UFUNCTION(...)\n');
  await writeFile(join(dir, 'Interfaces/OnlineIdentityInterface.h'), `#pragma once
#include "CoreMinimal.h"
struct FUniqueNetId {};
struct IOnlineIdentity { TSharedPtr<const FUniqueNetId> GetUniquePlayerId(int32) { return {}; } };
using IOnlineIdentityPtr = TSharedPtr<IOnlineIdentity>;
`);
  await writeFile(join(dir, 'Interfaces/OnlinePurchaseInterface.h'), `#pragma once
#include "CoreMinimal.h"
using FUniqueOfferId = FString;
using FOfferNamespace = FString;
using FUniqueEntitlementId = FString;
struct FOnlineError { bool WasSuccessful() const { return true; } };
struct FPurchaseReceipt {
  struct FLineItemInfo { FString ItemName; FUniqueEntitlementId UniqueId; FString ValidationInfo; };
  struct FReceiptOfferEntry { FOfferNamespace Namespace; FUniqueOfferId OfferId; int32 Quantity = 1; TArray<FLineItemInfo> LineItems; };
  FString TransactionId;
  TArray<FReceiptOfferEntry> ReceiptOffers;
};
struct FPurchaseCheckoutRequest {
  void AddPurchaseOffer(const FOfferNamespace&, const FUniqueOfferId&, int32, bool) {}
};
struct FOnPurchaseCheckoutComplete {
  template<class F> static FOnPurchaseCheckoutComplete CreateLambda(F&&) { return {}; }
};
struct FOnQueryReceiptsComplete {
  template<class F> static FOnQueryReceiptsComplete CreateLambda(F&&) { return {}; }
};
struct IOnlinePurchase {
  void Checkout(const FUniqueNetId&, const FPurchaseCheckoutRequest&, FOnPurchaseCheckoutComplete) {}
  void QueryReceipts(const FUniqueNetId&, bool, FOnQueryReceiptsComplete) {}
  void GetReceipts(const FUniqueNetId&, TArray<FPurchaseReceipt>&) {}
  void FinalizePurchase(const FUniqueNetId&, const FString&) {}
};
using IOnlinePurchasePtr = TSharedPtr<IOnlinePurchase>;
`);
  await writeFile(join(dir, 'Interfaces/OnlineStoreInterfaceV2.h'), `#pragma once
#include "Interfaces/OnlinePurchaseInterface.h"
struct FOnQueryOnlineStoreOffersComplete {};
struct IOnlineStoreV2 { void QueryOffersById(const FUniqueNetId&, const TArray<FUniqueOfferId>&, FOnQueryOnlineStoreOffersComplete) {} };
using IOnlineStoreV2Ptr = TSharedPtr<IOnlineStoreV2>;
`);
  await writeFile(join(dir, 'OnlineSubsystem.h'), `#pragma once
#include "Interfaces/OnlineIdentityInterface.h"
#include "Interfaces/OnlinePurchaseInterface.h"
#include "Interfaces/OnlineStoreInterfaceV2.h"
struct IOnlineSubsystem {
  static IOnlineSubsystem* Get() { static IOnlineSubsystem subsystem; return &subsystem; }
  IOnlineIdentityPtr GetIdentityInterface() { return {}; }
  IOnlinePurchasePtr GetPurchaseInterface() { return {}; }
  IOnlineStoreV2Ptr GetStoreV2Interface() { return {}; }
};
`);
  const plan = planUnreal({
    ...ctx('unreal'),
    products: [
      { productId: 'coins_100', productType: 'consumable' },
      { productId: 'premium', productType: 'nonConsumable' },
    ],
  }, new Map([
    ['Harbor.uproject', '{"FileVersion":3}\n'],
    ['Source/Harbor.Target.cs', 'public class HarborTarget : TargetRules { public HarborTarget(TargetInfo Target) : base(Target) { ExtraModuleNames.Add("Harbor"); } }'],
    ['Config/DefaultEngine.ini', ''],
  ]));
  const source = plan.changes.find((item) => item.path.endsWith('AppOpsStore.cpp'))?.content ?? '';
  const header = plan.changes.find((item) => item.path.endsWith('AppOpsStore.h'))?.content ?? '';
  await writeFile(join(dir, 'AppOpsStore.h'), header);
  await writeFile(join(dir, 'AppOpsStore.cpp'), source);
  const gxx = spawnSync('g++', ['-std=c++17', '-fsyntax-only', '-I', dir, join(dir, 'AppOpsStore.cpp')], { encoding: 'utf8' });
  assert.equal(gxx.status, 0, gxx.stderr || gxx.stdout);
});
