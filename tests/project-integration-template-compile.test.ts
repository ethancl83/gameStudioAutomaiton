import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AppError } from '../packages/domain/errors.js';
import { planAndroid } from '../packages/project-integration/templates/android.js';
import { planGodot } from '../packages/project-integration/templates/godot.js';
import { planUnreal } from '../packages/project-integration/templates/unreal.js';
import { planUnity } from '../packages/project-integration/templates/unity.js';
import type { TemplateContext } from '../packages/project-integration/types.js';
import { explicitEnv, godotBinaryFor, sdkReviewRootFor } from '../scripts/prepare-verification-tools.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function sdkReviewRoot(): string {
  return explicitEnv('APPOPS_SDK_REVIEW_ROOT') ?? sdkReviewRootFor(repoRoot);
}

async function officialTexts(t: TestContext, envName: string, paths: string[]): Promise<string[] | undefined> {
  const configured = explicitEnv(envName);
  const explicit = configured !== undefined;
  const texts: string[] = [];
  for (const path of paths) {
    try {
      const text = await readFile(path, 'utf8');
      if (!text.trim()) assert.fail(`공식 SDK 소스가 비어 있습니다: ${path}`);
      texts.push(text);
    } catch (error) {
      if (explicit || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      t.skip(`공식 SDK 소스가 없습니다: ${path}. node --import tsx scripts/prepare-verification-tools.ts 로 준비하거나 ${envName}로 검토 트리 루트를 지정할 수 있습니다.`);
      return undefined;
    }
  }
  return texts;
}

function probeGodot(path: string): { ok: true; version: string } | { ok: false; launched: boolean; detail: string } {
  const probed = spawnSync(path, ['--version'], { encoding: 'utf8' });
  if (probed.error) return { ok: false, launched: false, detail: probed.error.message };
  const version = `${probed.stdout ?? ''}${probed.stderr ?? ''}`.trim();
  if (probed.status !== 0 || !probed.stdout?.includes('4.3')) return { ok: false, launched: true, detail: version || `exit ${probed.status}` };
  return { ok: true, version: probed.stdout.trim() };
}

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

test('Unity generated IAP calls the pinned StoreController methods', () => {
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

test('official Unity IAP 5.4.2 StoreController source matches the pinned signatures', async (t) => {
  const root = sdkReviewRoot();
  const texts = await officialTexts(t, 'APPOPS_SDK_REVIEW_ROOT', [
    join(root, 'unity-iap/package/Runtime/Purchasing/Core/StoreController.cs'),
    join(root, 'unity-iap/package/Runtime/Purchasing/Core/Purchasing/Models/Interfaces/IOrderInfo.cs'),
  ]);
  if (!texts) return;
  const [source, orderInfo] = texts;
  assert.match(source!, /void FetchProducts\(List<ProductDefinition>/);
  assert.match(source!, /event Action<Orders>\? OnPurchasesFetched/);
  assert.match(source!, /event Action<PurchasesFetchFailureDescription>\? OnPurchasesFetchFailed/);
  assert.match(source!, /void FetchPurchases\(\)/);
  assert.match(source!, /void RestoreTransactions\(Action<bool, string\?>/);
  assert.match(source!, /void ConfirmPurchase\(PendingOrder order\)/);
  assert.doesNotMatch(source!, /void Acknowledge\(/);
  assert.match(orderInfo!, /string TransactionID \{ get; \}/);
});

test('Unity generated MAX binder uses the pinned settings API', () => {
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

test('official Unity MAX 8.6.5 settings source matches the pinned public API', async (t) => {
  const texts = await officialTexts(t, 'APPOPS_SDK_REVIEW_ROOT', [
    join(sdkReviewRoot(), 'max-unity/ebc0ba1b5ef6b4a6b9dd53d7eadfea16/asset'),
  ]);
  if (!texts) return;
  const source = texts[0]!;
  assert.match(source, /public class AppLovinSettings : ScriptableObject/);
  assert.match(source, /public static AppLovinSettings Instance/);
  assert.match(source, /public string SdkKey/);
  assert.match(source, /public void SaveAsync\(\)/);
});

function generatedBilling(): string {
  return planAndroid(ctx('android'), new Map([
    ['app/build.gradle', 'dependencies {\n}\n'],
    ['app/src/main/AndroidManifest.xml', '<manifest><application></application></manifest>\n'],
  ])).changes.find((item) => item.path.endsWith('AppOpsBilling.kt'))?.content ?? '';
}

test('generated Android billing source calls Play Billing query and acknowledge APIs', () => {
  const kt = generatedBilling();
  assert.match(kt, /queryProductDetailsAsync/);
  assert.match(kt, /queryResult\.productDetailsList/);
  assert.match(kt, /acknowledgePurchase\(AcknowledgePurchaseParams\.newBuilder\(\)\.setPurchaseToken\(purchaseToken\)\.build\(\)\)/);
});

test('Android billing calls compile against official Play Billing 9.1.0 classes.jar', async (t) => {
  const configured = explicitEnv('APPOPS_BILLING_JAR');
  const jar = configured ?? join(sdkReviewRoot(), 'billing/classes.jar');
  const explicit = configured !== undefined || explicitEnv('APPOPS_SDK_REVIEW_ROOT') !== undefined;
  try { await access(jar); } catch (error) {
    if (explicit || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip(`Play Billing classes.jar 가 없습니다: ${jar}. node --import tsx scripts/prepare-verification-tools.ts 로 준비하거나 APPOPS_BILLING_JAR로 지정할 수 있습니다.`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'appops-javac-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'android/app'), { recursive: true });
  await mkdir(join(dir, 'android/content'), { recursive: true });
  await writeFile(join(dir, 'android/content/Context.java'), 'package android.content; public class Context {}\n');
  await writeFile(join(dir, 'android/app/Activity.java'), 'package android.app; public class Activity extends android.content.Context {}\n');
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
    '-classpath', `${jar}${process.platform === 'win32' ? ';' : ':'}${dir}`,
    '-d', dir,
    join(dir, 'android/content/Context.java'),
    join(dir, 'android/app/Activity.java'),
    join(dir, 'ApiCheck.java'),
  ], { encoding: 'utf8' });
  assert.equal(javac.status, 0, javac.stderr || javac.stdout);
});

function generatedGodotBilling(): string {
  return planGodot({
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
  ])).changes.find((item) => item.path.endsWith('app_ops_billing.gd'))?.content ?? '';
}

test('generated Godot billing bridge calls the Billing 3.3 public script contract', () => {
  const generated = generatedGodotBilling();
  assert.match(generated, /query_product_details\(PackedStringArray\(INAPP_IDS\)/);
  assert.match(generated, /query_product_details\(PackedStringArray\(SUBS_IDS\)/);
  assert.match(generated, /purchase_subscription\(/);
  assert.match(generated, /consume_purchase\(/);
  assert.match(generated, /acknowledge_purchase\(/);
  assert.match(generated, /query_purchases\(BillingClient\.ProductType\.INAPP\)/);
});

test('Godot 4.3 parses the generated Billing 3.3.0 bridge against its public script contract', { timeout: 180_000 }, async (t) => {
  const configured = explicitEnv('APPOPS_GODOT');
  let candidate = configured;
  if (!candidate) {
    try { candidate = godotBinaryFor(repoRoot); }
    catch (error) {
      if (error instanceof AppError && error.code === 'INSTALL_PLATFORM') {
        t.skip(error.message);
        return;
      }
      throw error;
    }
  }
  const probed = probeGodot(candidate);
  if (!probed.ok) {
    if (configured !== undefined || probed.launched) assert.fail(`Godot 4.3으로 실행하지 못했습니다 (${candidate}: ${probed.detail}).`);
    t.skip(`Godot 4.3 검증 바이너리가 없습니다: ${candidate} (${probed.detail}). node --import tsx scripts/prepare-verification-tools.ts 로 이 호스트용 4.3을 준비하거나 APPOPS_GODOT로 지정할 수 있습니다.`);
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
  await writeFile(join(dir, 'AppOpsBilling.gd'), generatedGodotBilling());
  const check = spawnSync(candidate, ['--headless', '--editor', '--path', dir, '--quit'], { encoding: 'utf8' });
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
