import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planAndroid } from '../packages/project-integration/templates/android.js';
import { MINIMAL_IOS_PBXPROJ, planIos, registerSwiftInPbx } from '../packages/project-integration/templates/ios.js';
import { rewardedUnit, sanitizeAdUnits, sanitizeProducts, validateShape } from '../packages/project-integration/ids.js';
import { planUnity } from '../packages/project-integration/templates/unity.js';
import { planGodot } from '../packages/project-integration/templates/godot.js';
import { planUnreal } from '../packages/project-integration/templates/unreal.js';
import { stripCodeComments } from '../packages/project-integration/wiring.js';
import type { IntegrationFinding, TemplateContext } from '../packages/project-integration/types.js';

const ctx = (over: Partial<TemplateContext> = {}): TemplateContext => ({
  root: '/tmp/unused',
  engine: 'android',
  platform: 'android',
  provider: 'admob',
  appId: 'ca-app-pub-3940256099942544~3347511713',
  adUnits: [{ adUnitId: 'ca-app-pub-3940256099942544/5224354917', adFormat: 'REWARD' }],
  products: [{ productId: 'coins_100', productType: 'inapp' }],
  maxSdkKeyBound: true,
  detection: { root: '/tmp/unused', engine: 'android', engineEvidence: [], sdks: [], findings: [] },
  ...over,
});

const PBX = MINIMAL_IOS_PBXPROJ;

test('comments do not count as wiring APIs', () => {
  const commented = '// MobileAds.initialize(activity)\n/* RewardedAd.load() */\n';
  assert.equal(stripCodeComments(commented).includes('MobileAds.initialize'), false);
});

test('ids reject MAX AdMob-shaped units, unknown enums, and rewarded fallback', () => {
  const findings: IntegrationFinding[] = [];
  const max = sanitizeAdUnits([{ adUnitId: 'ca-app-pub-3940256099942544/5224354917', adFormat: 'REWARD' }], 'applovin-max', findings, 'android');
  assert.equal(max.length, 0);
  assert.ok(findings.some((item) => item.code === 'id.max_ad_unit_invalid'));
  const format: IntegrationFinding[] = [];
  sanitizeAdUnits([{ adUnitId: 'abc123xyz9', adFormat: 'video' }], 'applovin-max', format, 'android');
  assert.ok(format.some((item) => item.code === 'id.ad_format_invalid'));
  const products: IntegrationFinding[] = [];
  sanitizeProducts([{ productId: 'x', productType: 'lootbox' }], products);
  assert.ok(products.some((item) => item.code === 'id.product_type_invalid'));
  assert.equal(rewardedUnit([{ adUnitId: 'banner', adFormat: 'BANNER' }]), undefined);
  const shape = validateShape({ projectRoot: '/tmp', engine: 'android', platform: 'ios', provider: 'admob' });
  assert.ok(shape.some((item) => item.code === 'scope.engine_platform_mismatch'));
});

test('planAndroid expands self-closing application and fail-closed billing', () => {
  const plan = planAndroid(ctx(), new Map([
    ['app/build.gradle', 'plugins { id "com.android.application" }\ndependencies {\n}\n'],
    ['app/src/main/AndroidManifest.xml', '<manifest><application android:label="X"/></manifest>\n'],
  ]));
  const manifest = plan.changes.find((item) => item.path.endsWith('AndroidManifest.xml'))?.content ?? '';
  assert.match(manifest, /<\/application>/);
  const billing = plan.changes.find((item) => item.path.endsWith('AppOpsBilling.kt'))?.content ?? '';
  assert.match(billing, /completeVerifiedPurchase/);
  assert.match(billing, /ProductType.SUBS/);
  assert.match(billing, /consumeAsync/);
  const afterHandle = billing.split('handlePurchases')[1] ?? '';
  assert.doesNotMatch(afterHandle, /acknowledgePurchase/);
  assert.match(billing, /Launches Play purchase UI/);
});

test('planIos registers Swift into a standard pbxproj and rejects junk', () => {
  const findings: IntegrationFinding[] = [];
  const patched = registerSwiftInPbx(PBX, ['AppOpsMonetization/AppOpsAds.swift'], findings, 'App.xcodeproj/project.pbxproj');
  assert.equal(findings.length, 0);
  assert.match(patched ?? '', /AppOpsAds\.swift in Sources/);
  assert.match(patched ?? '', /isa = PBXFileReference/);
  assert.match(patched ?? '', /path = AppOpsMonetization\/AppOpsAds\.swift; sourceTree = SOURCE_ROOT;/);
  const again = registerSwiftInPbx(patched!, ['AppOpsMonetization/AppOpsAds.swift'], [], 'App.xcodeproj/project.pbxproj');
  assert.equal((again?.match(/AppOpsAds\.swift in Sources/g) ?? []).length, (patched?.match(/AppOpsAds\.swift in Sources/g) ?? []).length);

  const junkFindings: IntegrationFinding[] = [];
  assert.equal(registerSwiftInPbx('// fake\n', ['AppOpsAds.swift'], junkFindings, 'project.pbxproj'), null);
  assert.ok(junkFindings.some((item) => item.code === 'format.pbxproj'));

  const plan = planIos(ctx({ engine: 'ios', platform: 'ios' }), new Map([
    ['Podfile', "platform :ios, '13.0'\ntarget 'App' do\n  use_frameworks!\nend\n"],
    ['Info.plist', '<?xml version="1.0"?><plist><dict></dict></plist>'],
    ['App.xcodeproj/project.pbxproj', PBX],
  ]));
  assert.equal(plan.supported, true);
  const pbx = plan.changes.find((item) => item.path.endsWith('project.pbxproj'))?.content ?? '';
  assert.match(pbx, /AppOpsStore\.swift in Sources/);
  const store = plan.changes.find((item) => item.path.endsWith('AppOpsStore.swift'))?.content ?? '';
  assert.match(store, /completeVerifiedPurchase/);
  assert.match(store, /jwsRepresentation/);
  assert.match(store, /for await result in Transaction\.updates/);
  assert.match(store, /guard case \.verified\(let transaction\) = result else \{ continue \}/);
  assert.match(store, /userCancelled/);
  assert.doesNotMatch(store, /verificationRequired\?\(transaction.productID, String\(transaction.id\), ""\)/);
});

test('minimal iOS fixture matches the generated constant and has resolvable build configurations', async () => {
  const fixture = await readFile('fixtures/minimal-ios.pbxproj', 'utf8');
  assert.equal(fixture, MINIMAL_IOS_PBXPROJ);
  const defined = new Set([...fixture.matchAll(/^\s*([A-F0-9]{24}) \/\*.*?\*\/ = \{/gm)].map((item) => item[1]));
  for (const id of [
    'A10000000000000000000070',
    'A10000000000000000000071',
    'A10000000000000000000072',
    'A10000000000000000000080',
    'A10000000000000000000081',
    'A10000000000000000000082',
  ]) assert.ok(defined.has(id), `missing PBX object ${id}`);
  assert.match(fixture, /Begin XCBuildConfiguration section/);
  assert.match(fixture, /Begin XCConfigurationList section/);
  assert.match(fixture, /buildConfigurationList = A10000000000000000000070/);
  assert.match(fixture, /buildConfigurationList = A10000000000000000000080/);
  assert.match(fixture, /PRODUCT_BUNDLE_IDENTIFIER = com\.example\.AppOpsFixture/);
});

test('Unity IAP 5.4.2 uses ProductDefinition list, two-arg restore, ConfirmPurchase', () => {
  const plan = planUnity(ctx({ engine: 'unity' }), new Map([
    ['ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.21f1\n'],
    ['Packages/manifest.json', '{ "dependencies": {} }'],
  ]));
  const iap = plan.changes.find((item) => item.path.endsWith('AppOpsPurchasing.cs'))?.content ?? '';
  assert.match(iap, /new List<ProductDefinition>/);
  assert.match(iap, /FetchProducts\(Catalog\)/);
  assert.match(iap, /OnPurchasesFetched \+= OnPurchasesFetched/);
  assert.match(iap, /OnPurchasesFetchFailed/);
  assert.match(iap, /store\.FetchPurchases\(\)/);
  assert.match(iap, /order\.Info\.TransactionID/);
  assert.doesNotMatch(iap, /pending\[.*Receipt/);
  assert.match(iap, /RestoreTransactions\(\(ok, error\)/);
  assert.match(iap, /ConfirmPurchase\(order\)/);
  assert.doesNotMatch(iap, /\.Acknowledge\s*\(/);
});

test('Unity settings use only public or validated serialized SDK surfaces', () => {
  const base = new Map<string, string | null>([
    ['ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.21f1\n'],
    ['Packages/manifest.json', '{ "dependencies": {} }'],
  ]);
  const missingAdMob = planUnity(ctx({ engine: 'unity' }), base);
  assert.ok(missingAdMob.findings.some((item) => item.code === 'unity.admob_settings_unbound'));
  assert.equal(missingAdMob.changes.some((item) => item.path.endsWith('AppOpsBindAdMobSettings.cs')), false);

  const validAdMob = planUnity(ctx({ engine: 'unity' }), new Map([
    ...base,
    ['Assets/GoogleMobileAds/Resources/GoogleMobileAdsSettings.asset', `--- !u!114 &11400000
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: a187246822bbb47529482707f3e0eff8, type: 3}
  adMobAndroidAppId:
  adMobIOSAppId:
`],
  ]));
  const patched = validAdMob.changes.find((item) => item.path.endsWith('GoogleMobileAdsSettings.asset'))?.content ?? '';
  assert.match(patched, /adMobAndroidAppId: ca-app-pub-3940256099942544~3347511713/);
  assert.doesNotMatch(patched, /GoogleMobileAdsSettings\.LoadInstance/);

  const maxPlan = planUnity(ctx({
    engine: 'unity',
    provider: 'applovin-max',
    appId: undefined,
    adUnits: [{ adUnitId: 'max_rewarded_123', adFormat: 'REWARD' }],
    maxSdkKeyBound: true,
  }), base);
  assert.ok(maxPlan.findings.some((item) => item.code === 'unity.max_settings_unbound'));
  const binder = maxPlan.changes.find((item) => item.path.endsWith('AppOpsBindMaxSettings.cs'))?.content ?? '';
  assert.match(binder, /AppLovinSettings\.Instance/);
  assert.match(binder, /settings\.SdkKey = stagedSdkKey\.Trim\(\)/);
  assert.match(binder, /settings\.SaveAsync\(\)/);
  assert.match(binder, /Environment\.GetEnvironmentVariable\("APPOPS_MAX_SDK_KEY"\)/);
  const runtime = maxPlan.changes.find((item) => item.path.endsWith('AppOpsAds.cs'))?.content ?? '';
  assert.doesNotMatch(runtime, /SdkKeyBound/);
  assert.doesNotMatch(runtime, /Resources\.Load<ScriptableObject>/);
});

test('Godot uses v5 reward callbacks and billing consume vs acknowledge', () => {
  const plan = planGodot(ctx({
    engine: 'godot',
    products: [
      { productId: 'coins_100', productType: 'consumable' },
      { productId: 'premium', productType: 'nonConsumable' },
      { productId: 'season_pass', productType: 'subs' },
    ],
  }), new Map([['project.godot', '[application]\nconfig/name="Harbor"\n']]));
  const ads = plan.changes.find((item) => item.path.endsWith('app_ops_ads.gd'))?.content ?? '';
  assert.match(ads, /OnInitializationCompleteListener/);
  assert.match(ads, /RewardedAdLoadCallback/);
  assert.match(ads, /OnUserEarnedRewardListener/);
  assert.match(ads, /destroy\(\)/);
  const billing = plan.changes.find((item) => item.path.endsWith('app_ops_billing.gd'))?.content ?? '';
  assert.match(billing, /on_purchase_updated/);
  assert.match(billing, /ProductType.SUBS/);
  assert.match(billing, /consume_purchase/);
  assert.match(billing, /purchase_subscription/);
  assert.match(billing, /subscription_offer_details/);
  assert.match(billing, /base_plan_id/);
  assert.match(billing, /purchase\.get\("product_ids", \[\]\)/);
  assert.match(billing, /Unknown AppOps catalog product/);
  assert.match(billing, /Unknown purchase token; refusing consume\/acknowledge/);
  assert.doesNotMatch(billing, /purchase\.get\("product_id"/);
  const project = plan.changes.find((item) => item.path === 'project.godot')?.content ?? '';
  assert.match(project, /\[admob\]/);
  assert.match(project, /general\/android\/enabled=true/);
  assert.match(project, /general\/android\/app_id="ca-app-pub-/);
  assert.equal(plan.changes.some((item) => item.path.endsWith('app_ids.cfg')), false);
});

test('Godot iOS StoreKit is explicitly unsupported without a built plugin', () => {
  const plan = planGodot(ctx({ engine: 'godot', platform: 'ios', provider: 'app-store' }), new Map([
    ['project.godot', '[application]\nconfig/name="Harbor"\n'],
  ]));
  assert.equal(plan.supported, false);
  assert.ok(plan.findings.some((item) => item.code === 'scope.godot_ios_storekit_source_only' && item.severity === 'error'));
  assert.equal(plan.changes.some((item) => item.path.endsWith('.gdip') || item.path.endsWith('AppOpsStoreKit.swift')), false);
});

test('Unreal uses official advertising provider and fail-closed purchase receipt data', () => {
  const plan = planUnreal(ctx({
    engine: 'unreal',
    products: [
      { productId: 'coins_100', productType: 'consumable' },
      { productId: 'premium', productType: 'nonConsumable' },
      { productId: 'season_pass', productType: 'subs' },
    ],
  }), new Map([
    ['Harbor.uproject', '{"FileVersion":3}\n'],
    ['Source/Harbor.Target.cs', 'using UnrealBuildTool;\npublic class HarborTarget : TargetRules {\n    public HarborTarget(TargetInfo Target) : base(Target) {\n        ExtraModuleNames.Add("Harbor");\n    }\n}\n'],
    ['Config/DefaultEngine.ini', '[/Script/Engine.Engine]\n'],
  ]));
  const cpp = plan.changes.find((item) => item.path.endsWith('AppOpsAds.cpp'))?.content ?? '';
  assert.match(cpp, /IAdvertisingProvider\*/);
  assert.match(cpp, /GetDefaultProvider/);
  assert.doesNotMatch(cpp, /TSharedPtr<IAdvertisingProvider>/);
  assert.doesNotMatch(cpp, /ShowRewardedAd/);
  const target = plan.changes.find((item) => item.path.endsWith('.Target.cs'))?.content ?? '';
  const ctorClose = target.indexOf('ExtraModuleNames.Add("Harbor")');
  const classLast = target.lastIndexOf('}');
  const extraAt = target.indexOf('OnlineSubsystem');
  assert.ok(extraAt > ctorClose && extraAt < classLast);
  assert.ok(plan.findings.some((item) => item.code === 'scope.unreal_rewarded_unsupported'));
  const store = plan.changes.find((item) => item.path.endsWith('AppOpsStore.cpp'))?.content ?? '';
  const storeHeader = plan.changes.find((item) => item.path.endsWith('AppOpsStore.h'))?.content ?? '';
  assert.match(store, /Checkout/);
  assert.match(store, /FinalizePurchase/);
  assert.match(store, /AddPurchaseOffer\(TEXT\(""\), ProductId, 1, Product->bIsConsumable\)/);
  assert.match(store, /LineItem\.ValidationInfo/);
  assert.match(store, /Offer\.Quantity <= 0 \|\| Offer\.Quantity > AppOpsMaxReceiptQuantity/);
  assert.match(store, /AppOpsMaxReceiptQuantity = 1000/);
  assert.match(store, /\{ TEXT\("coins_100"\), true \}/);
  assert.match(store, /\{ TEXT\("premium"\), false \}/);
  assert.doesNotMatch(store, /Receipt\.TransactionId, Receipt\.TransactionId/);
  assert.match(storeHeader, /DECLARE_DELEGATE_FourParams\(FAppOpsVerificationRequired, const FString&, int32, const FString&, const FString&\)/);
  assert.match(storeHeader, /class HARBOR_API UAppOpsStore/);
  assert.match(storeHeader, /static void Purchase\(const FString& ProductId\)/);
  assert.match(storeHeader, /static void Restore\(\)/);
});
