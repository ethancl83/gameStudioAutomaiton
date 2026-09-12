# App Operations v4 — SDK template final review (independent, read-only)

Date: 2026-09-12
Reviewer: independent Opus 5 pass, read-only. No files under review were edited, no provider APIs were called, no secrets were read, no subagents were used.
Scope (frozen): `packages/project-integration/templates/{unreal,godot,unity,ios}.ts`, `fixtures/minimal-ios.pbxproj`, `tests/project-integration-template.test.ts`, `tests/project-integration-template-compile.test.ts`, `docs/project-integration.md`. `wiring.ts`, `ids.ts`, `catalog.ts`, `detect.ts` were read only where a frozen file's output is consumed by them; findings that cross that line are marked.
Accepted by root and not re-litigated: the generated Unreal `VerificationRequired(ProductId, Quantity, PurchaseToken, ValidationInfo)` signature, and the 1..1000 quantity bound. The rest of the SDK behaviour is still expected to be fail-closed until server verification.

## Release assessment

Do not ship. The previous round's findings were largely addressed at the level they were written: Unreal now emits the four-argument offer call and a real public header, Godot Billing reads `product_ids` and passes a `base_plan_id`, the Unity AdMob `internal` binder is gone, the Unity IAP bridge keys pending orders by `TransactionID` and subscribes to purchase-fetch events, iOS registers the Swift file with its full path, and iOS StoreKit runs a `Transaction.updates` listener and finishes only after verification. Those specific corrections are real and I confirmed each of them.

However, this round found a larger class of defect than the previous report did, because this pass exercised the real Godot 4.3 engine, the real pinned SDK binaries, and the real generated plans instead of reading strings. Three of the four engines cannot work as generated: both Godot bridges abort at their first guard on a real engine, all three iOS Swift bridges fail to compile against the pinned SDK headers, the Unity MAX path pins a package that does not exist in any registry, and the Unreal sources are written to a directory that is frequently not a compiled module. Two defects are destructive to existing project state, and one makes the tool report "wired" for every event with no game code present.

Counts: 8 P0, 10 P1, 6 P2. Every finding below was confirmed by running code, by the real engine, or by the exact pinned SDK artifact. Items I could not verify are listed separately as unverified and are not counted as defects.

## P0 — blocking

### P0-1 Wiring reports every event as `wired` for Unreal with no game code at all

`packages/project-integration/templates/unreal.ts:144,150,175,181` write the bridges to `Source/<Module>/AppOpsAds.{cpp,h}` and `Source/<Module>/AppOpsStore.{cpp,h}`. `packages/project-integration/wiring.ts:3` classifies generated files with `/(?:^|\/)(?:AppOps|appops|AppOpsMonetization|addons\/appops_monetization)\b/`. In `AppOpsStore.cpp` the `\b` after `AppOps` fails because the next character is a word character, so the path is not recognised as generated. `wiring.ts:96-99` then treats the file as game code, and `wiring.ts:105,125-131` returns `wired`.

Executed against the real planner with an empty project and no game sources, all five events came back `wired`:

```
ad.initialize  wired  Source/Harbor/AppOpsAds.cpp
ad.show        wired  Source/Harbor/AppOpsAds.cpp
ad.reward      wired  Source/Harbor/AppOpsStore.h
purchase       wired  Source/Harbor/AppOpsStore.h
restore        wired  Source/Harbor/AppOpsStore.cpp
```

`isGeneratedPath` returned `false` for `Source/Harbor/AppOpsAds.cpp`, `Source/Harbor/AppOpsStore.cpp` and `app/src/main/java/com/x/AppOpsBilling.kt`, and `true` for the iOS, Unity and Godot paths. This is the tool's central honesty guarantee inverted: the product tells the operator the game calls the hooks when nothing does. Android is affected by the same regex gap. This is a code bug, not a missing device test.

`ad.reward` additionally matches on the purchase delegate name: `wiring.ts:58` lists `/\bVerificationRequired\b/` under the ad-reward game hooks, so an IAP symbol satisfies an advertising event.

### P0-2 Both Godot bridges abort at their first guard on a real engine

`godot.ts:161` guards on `ClassDB.class_exists("MobileAds")`, `:176` on `ClassDB.class_exists("RewardedAdLoader")`, `:231` on `ClassDB.class_exists("BillingClient")`. All three are GDScript global classes, not engine classes, so `ClassDB` never knows them.

Exact pinned sources: `godot-google-play-billing` 3.3.0 `export_scripts/BillingClient.gd:1` is `class_name BillingClient extends Node`; `godot-admob-plugin` v5.0.0 `platforms/godot_editor/addons/admob/gdscript/src/api/MobileAds.gd:23` is `class_name MobileAds extends MobileSingletonPlugin` and `RewardedAdLoader.gd:23` likewise.

Verified on the supplied Godot 4.3 binary (`Godot_v4.3-stable_linux.x86_64`) with the real `BillingClient.gd` and the plugin's API classes present and registered (15 global classes):

```
classdb MobileAds=false RewardedAdLoader=false BillingClient=false
>>> calling AppOpsAds.initialize()
ERROR: AdMob plugin missing: install poing.studios AdMob from AssetLib...
>>> calling AppOpsBilling.initialize()
ERROR: GodotGooglePlayBilling plugin missing. Install 3.3.0 from official releases...
billing_client after initialize=<null>
```

Ads never initialise, `billing_client` stays null, and every downstream call is dead. A correct presence test is the plugin singleton (`Engine.has_singleton("GodotGooglePlayBilling")`, `Engine.has_singleton("PoingGodotAdMob")`) or the global class list, not `ClassDB`. Note also that the generated ads script declares `var _rewarded: RewardedAd` and constructs `OnUserEarnedRewardListener.new()` at member scope, so with the plugin genuinely absent the script fails to parse before any guard runs; the guard protects nothing in either direction.

### P0-3 Patching `project.godot` silently disables every editor plugin the project already enabled

`godot.ts:62-74`: the condition is true whenever the marker is absent, even if an `[editor_plugins]` section already exists, and the else branch appends a second section. Generated output for a project that already enabled one plugin:

```
[editor_plugins]
enabled=PackedStringArray("res://addons/other/plugin.cfg")

; APPOPS-INTEGRATION-BEGIN godot-plugins
[editor_plugins]
enabled=PackedStringArray("res://addons/admob/plugin.cfg", "res://addons/GodotGooglePlayBilling/plugin.cfg")
; APPOPS-INTEGRATION-END godot-plugins
```

Read back by the real Godot 4.3 binary:

```
enabled=["res://addons/admob/plugin.cfg", "res://addons/GodotGooglePlayBilling/plugin.cfg"]
```

`res://addons/other/plugin.cfg` is gone. The later duplicate section wins, so applying an integration disables the user's existing editor plugins. This is destructive to project state and is recorded as an ordinary patch.

### P0-4 Unity MAX pins a UPM package that exists in no registry

`unity.ts:67-68` adds a scoped registry for `com.applovin` at `https://package.openupm.com` and the dependency `com.applovin.mediation.ads` at the `catalog.ts:69-76` version 8.6.5. Live registry checks:

| Query | Result |
|---|---|
| `package.openupm.com/com.applovin.mediation.ads` | `error: no such package available` |
| `registry.npmjs.org/com.applovin.mediation.ads` | HTTP 404 |
| OpenUPM search `applovin` | only third-party mediation adapters, no AppLovin MAX plugin |
| `AppLovin-MAX-Unity-Plugin` repo `package.json` (release_8_6_5 and master) | HTTP 404, not a UPM package |

The generated `Packages/manifest.json` therefore cannot resolve and Unity's Package Manager blocks the project. The artifact actually downloaded for review is `max-unity-8.6.5.unitypackage`, an Assets-layout install, which is AppLovin's real distribution channel. The manifest entry and the catalog artifact id are both wrong. By contrast `com.google.ads.mobile` 11.5.0 does exist on OpenUPM and its own dependency `com.google.external-dependency-manager` is inside the `com.google` scope the template adds, so the AdMob manifest path is correct.

### P0-5 Podfile pods are inserted inside a `post_install` hook

`ios.ts:43` locates the insertion point with `podfile.lastIndexOf('end')`. Any Podfile with a `post_install` block, which is the common case, ends with that block's `end`. Generated output for a normal Podfile:

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |t|
    ...
  end
  # APPOPS-INTEGRATION-BEGIN ios-pods
  pod 'Google-Mobile-Ads-SDK', '13.9.0'
  # APPOPS-INTEGRATION-END ios-pods
end
```

`pod` is not defined in the post-install scope, so `pod install` fails, and the dependency is attached to no target. The same scan also matches `end` inside words and comments. The target's `end` has to be located by parsing the `target ... do` block, not by a substring scan.

### P0-6 The iOS MAX Swift bridge does not compile against AppLovinSDK 13.6.4

Checked against the pinned xcframework (`AppLovinSDK-13.6.4.xcframework.zip`, sha256 `c00f052c4b15766a6a2734e2b3685234e6bd28dbc47fbe7cbc3edbf56f701d5c`, the exact binary the official Swift package references).

- `ios.ts:158` writes `builder.mediationProvider = ALMediationProvider.max`. `ALMediationProvider.h:22` declares `extern NSString *const ALMediationProviderMAX;` with no `NS_TYPED_ENUM` and no `NS_SWIFT_NAME` anywhere in the header. Swift imports a plain `let ALMediationProviderMAX: String`; the type `ALMediationProvider` does not exist. The builder property is `@property (nonatomic, copy, nullable) NSString *mediationProvider`.
- `ios.ts:172,186,188` call `ad.load()` / `rewarded?.load()`. `MARewardedAd.h:70` declares `- (void)loadAd;`. There is no `load`.
- `ios.ts:179` calls `ad.show()`. `MARewardedAd.h:81` declares `- (void)showAd;` plus `showAdForPlacement:` variants. There is no `show`.

Four call sites, three distinct errors. The rest of that file is correct against the same headers: `ALSdkInitializationConfiguration(sdkKey:)` is a valid Swift import of `+configurationWithSdkKey:builderBlock:`, `ALSdk.shared()` matches `+ (ALSdk *)shared`, `initialize(with:)` matches `-initializeWithConfiguration:completionHandler:`, `MARewardedAd.shared(withAdUnitIdentifier:)` and `isReady` match, and every `MAAdDelegate`/`MARewardedAdDelegate` requirement in `MAAdDelegate.h:24-78` and `MARewardedAdDelegate.h:29` is implemented with the correct imported Swift name.

### P0-7 The iOS AdMob Swift bridge does not compile against Google Mobile Ads 13.9.0

`ios.ts:211` calls `MobileAds.shared.start()`. In the pinned binary (`googlemobileadsios-spm-13.9.0.zip`, sha256 `cd356c1fe78f0b19abe9b0722affc128dfcaf9f863fd69c379cc47d46275d7bb`, the checksum the official Swift package pins), `GADMobileAds.h:82` declares the only start method as `- (void)startWithCompletionHandler:(nullable GADInitializationCompletionHandler)completionHandler;`. Objective-C methods are never imported with default arguments, so the Swift spelling is `start(completionHandler:)` and the argument is required. Google's own quick start writes `MobileAds.shared.start(completionHandler: nil)`.

Everything else in that bridge checks out against the same headers: `sharedInstance NS_SWIFT_NAME(shared)` at `GADMobileAds.h:35`, `NS_SWIFT_NAME(MobileAds)` at `:31`, `load(with:request:completionHandler:)` at `GADRewardedAd.h:61-64`, `present(from:userDidEarnRewardHandler:)` at `:92-94`, `adReward` at `:39`, and `NS_SWIFT_NAME(Request)` at `GADRequest.h:15`.

`wiring.ts` matches `MobileAds.shared.start(` as an official initialise API, so the non-compiling call is reported as an installed bridge.

### P0-8 Unreal writes its sources into a directory that need not be a module, and patches a different module's Build.cs

`unreal.ts:75` derives `moduleName` from the `.uproject` basename and `:144,150,175,181` write all four sources to `Source/<uproject basename>/`. `unreal.ts:112-113` independently finds the first `*.Build.cs` under `Source/`. Real projects routinely name the primary module differently from the project file. Executed against such a project:

```
patch  Source/HarborEditorTarget.Target.cs
patch  Source/HarborRuntime/HarborRuntime.Build.cs
create Source/Harbor/AppOpsAds.cpp
create Source/Harbor/AppOpsAds.h
create Source/Harbor/AppOpsStore.h
create Source/Harbor/AppOpsStore.cpp
```

The module dependencies land in `HarborRuntime`, the sources land in `Source/Harbor`, which is not a module directory, so UnrealBuildTool never compiles them. The generated header compounds it: `unreal.ts:261` derives the export macro from the same `.uproject` basename and emits `class HARBOR_API UAppOpsStore`, while the module that would compile it defines `HARBORRUNTIME_API`. The plan reports success. Both the placement and the macro must come from the module that owns the Build.cs that was patched.

## P1 — must fix before release

### P1-1 Unity AdMob settings patch erases the other platform's app ID

`unity.ts:83-84` sets the non-target platform's id to the empty string and `:93-95` writes it unconditionally. Executed with an asset that already held both ids, integrating for Android:

```
  adMobAndroidAppId: ca-app-pub-1111111111111111~2222222222
  adMobIOSAppId: 
```

`ca-app-pub-8888888888888888~3333333333` is destroyed. The patch must leave the platform it is not targeting untouched. The rest of that block is verified correct against the pinned 11.5.0 UPM package: the script GUID `a187246822bbb47529482707f3e0eff8` matches `GoogleMobileAds/Editor/GoogleMobileAdsSettings.cs.meta`, the serialized names `adMobAndroidAppId` and `adMobIOSAppId` match the shipped sample asset, and the asset path matches `MobileAdsSettingsResDir = "Assets/GoogleMobileAds/Resources"` in the shipped source.

### P1-2 Unity IAP raises the verification callback twice for every fetched pending order

`unity.ts:318-322` re-invokes `OnPurchasePending` for each entry of `orders.PendingOrders`. In the pinned 5.4.2 package, `Runtime/Purchasing/Core/Purchasing/PurchaseService.cs:481-489` already routes each fetched pending order through `ProcessPendingOrder`, and `:530-536` shows that method invoking `OnPurchasePending`. The routing is on by default (`:29`, `m_ProcessFetchedPendingOrders = true`) for every builtin store, which includes Google Play and the App Store. Each fetch therefore produces two `VerificationRequired` events and two server verification attempts per pending purchase. Either call `ProcessPendingOrdersOnPurchasesFetched(false)` before connecting, or drop the manual loop.

### P1-3 The Unity IAP "unverifiable receipt" guard can never fire

`unity.ts:299` forwards `order.Info.Receipt` and `:330` refuses when that value is blank. In the pinned package, `Runtime/Purchasing/Core/Purchasing/Models/OrderInfo.cs` always returns a JSON envelope: the getter calls `CreateUnifiedReceipt(...)`, and `Runtime/Purchasing/Utilities/UnifiedReceiptFormatter.cs` serialises a `UnifiedReceipt { Store, TransactionID, Payload }` with `JsonUtility.ToJson`. An absent platform receipt yields `{"Store":"","TransactionID":"","Payload":""}`, which is non-blank. The fail-closed check passes and an envelope with an empty payload is forwarded to the server as if it were a verification payload. The check belongs on the inner payload, or on `Info.Apple.jwsRepresentation` / `Info.Google`.

Related, and worth a decision rather than a fix: on Apple the envelope wraps `AppReceipt`, the legacy app receipt, while the StoreKit 2 per-transaction JWS is exposed separately as `IAppleOrderInfo.jwsRepresentation` (`Runtime/Purchasing/Core/Purchasing/Models/AppleOrderInfo.cs:14`). The iOS native template already standardises on JWS; the Unity path does not.

### P1-4 Godot product-details handler throws on the payload the plugin actually sends

`godot.ts:257` declares `var offers: Array = details.get("subscription_offer_details", [])`. The pinned plugin writes an explicit null for that key when there are no subscription offers (`Utils.kt:82-91`, `dict["subscription_offer_details"] = null`), so the default is never used. On the real Godot 4.3 binary:

```
SCRIPT ERROR: Trying to assign value of type 'Nil' to a variable of type 'Array'.
          at: AppOpsBilling._on_products (res://app_ops_billing.gd:44)
```

The handler aborts, so the remaining products in the same response are skipped too, instead of reaching the intended `push_error` path.

### P1-5 Godot restore never re-emits an already acknowledged entitlement

`godot.ts:314` skips every purchase with `is_acknowledged` true. After a reinstall or local state loss, every owned non-consumable and every active subscription is acknowledged, so `restore()` at `:291-293` produces no `verification_required` at all and the entitlement cannot be re-granted. Acknowledged means Play considers the transaction complete; it does not mean this install has the entitlement. This is the same defect the previous report raised for Android, unfixed in the Godot template.

### P1-6 Godot never observes the completion results it depends on

`godot.ts:295-305` calls `consume_purchase` / `acknowledge_purchase` and returns. The pinned plugin emits `consume_purchase_response` and `acknowledge_purchase_response` (`BillingClient.gd:8-9`, `GodotGooglePlayBilling.kt:259,272`), and neither is connected at `:235-238`. A failed acknowledgement inside Play's three-day window is silently lost and the purchase is refunded. There is no retry or error route.

### P1-7 Godot `restore()` throws when the client is not initialised

`godot.ts:291-293` dereferences `billing_client` with no null check, unlike `purchase()` and `complete_verified_purchase()`. On the real engine:

```
SCRIPT ERROR: Invalid call. Nonexistent function 'query_purchases' in base 'Nil'.
          at: AppOpsBilling.restore (res://app_ops_billing.gd:79)
```

Given P0-2 this is the normal state of the object on every device today.

### P1-8 Unreal enables no OnlineSubsystem plugin and writes no OnlineSubsystem configuration

The generated plan touches `Config/DefaultEngine.ini`, `*.Target.cs`, `*.Build.cs` and the four sources. It never edits the `.uproject` to enable `OnlineSubsystemGooglePlay` or `OnlineSubsystemIOS`, and the ini block it writes contains only the `[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]` section. Without the plugin enabled and a default platform service configured, `IOnlineSubsystem::Get()` resolves to the null subsystem, `GetPurchaseInterface()` is invalid, and `Purchase`, `Restore` and `CompleteVerifiedPurchase` all return silently at `unreal.ts:363,379,398`. Separately, `unreal.ts:85-87` adds `OnlineSubsystem`, `OnlineSubsystemGooglePlay` and `AndroidAdvertising` to `ExtraModuleNames`, which is the target's extra *game* module list, not the place engine and plugin modules are enabled. The omission is a code gap; the exact runtime consequence needs a real engine to demonstrate and is listed under remaining evidence.

### P1-9 The iOS MAX SDK key can never be read

`ios.ts:126-130` creates `AppOpsMonetization/MaxSdkKey.txt` whose content is a single newline, and `ios.ts:163-167` reads that file from the app bundle. `ios.ts:99` registers only `.swift` files in the Xcode project, so the text file and `MaxRuntime.plist` are never added to any Copy Bundle Resources phase; the minimal fixture has no `PBXResourcesBuildPhase` at all. Executed: `MaxSdkKey.txt referenced in pbx? false`, `resources phase present? false`. `initialize()` therefore returns at its guard and MAX never starts. The plan nonetheless returned `supported: true` with `findings: []` and `maxSdkKeyBound: true`, with no counterpart to Unity's `unity.max_settings_unbound` warning. Both the wiring and the truthfulness are wrong here.

### P1-10 A nested `.xcodeproj` produces file references that point at nothing

`ios.ts:100` accepts any path ending in `project.pbxproj`, and `:362` emits `sourceTree = SOURCE_ROOT`, but the Swift files are always written relative to the integration root. Executed with `ios/App.xcodeproj/project.pbxproj`:

```
path = AppOpsMonetization/AppOpsAds.swift; sourceTree = SOURCE_ROOT;
```

`SOURCE_ROOT` is the directory holding the `.xcodeproj`, so Xcode looks under `<root>/ios/AppOpsMonetization/`, while the files were created at `<root>/AppOpsMonetization/`. The build fails on missing sources and the plan reports `supported: true` with no findings. The reference must be made relative to the project directory, or the project must be required at the integration root.

## P2 — should fix

1. **`inapp` is treated as consumable everywhere.** `unreal.ts:291`, `godot.ts:208` and `unity.ts:251-253` all map the `inapp` product type to consumable. On Google Play `inapp` is the one-time product type and covers non-consumables. `ids.ts:142-145` additionally defaults a product with no declared type to `inapp` with a warning that says it will be treated as consumable. Consuming a non-consumable makes it repurchasable and destroys the entitlement. Verified: a product `{productId: "remove_ads", productType: "inapp"}` generates `{ TEXT("remove_ads"), true }`.
2. **Dead code in the Unreal ini block.** `unreal.ts:55` is `AdMobAdUnitIDs=${index > 0 ? id : id}`; both branches are identical. The shape suggests an unfinished intent to prefix additional array entries. Array-valued UE config keys are conventionally written with a `+` prefix; see unverified items below.
3. **Unreal emits verification for receipts in any transaction state.** `unreal.ts:328-343` iterates every receipt returned by `GetReceipts` without checking the receipt's transaction state, so non-purchased receipts reach the verification callback.
4. **Unreal `Restore` dereferences an unchecked interface.** `unreal.ts:386` calls `IOnlineSubsystem::Get()->GetPurchaseInterface()` inside the query callback with no null check, unlike every other call site in the same file. `unreal.ts:345-355` also discards the offer query result by passing a default-constructed delegate, so `QueryProducts` has no observable effect.
5. **`SaveAsync` does not save.** `unity.ts:157` relies on `AppLovinSettings.SaveAsync()`; in the pinned 8.6.5 source that method's entire body is `EditorUtility.SetDirty(instance)`. A one-shot `-batchmode -quit` binder run can exit without the staged key reaching disk. `AssetDatabase.SaveAssets()` is needed. The key value itself does not leak: the generated file contains only the variable name `APPOPS_MAX_SDK_KEY`, and no plan content, preview field or journal field carries the value.
6. **Leaked Godot node and ignored quantity.** `godot.ts:234` creates a `BillingClient`, which the pinned plugin defines as a `Node`, and never adds it to the tree or frees it. `unity.ts:346-350` takes only the first cart item and ignores `CartItem.Quantity`, which the pinned package exposes.

## Confirmed corrections from the previous round

Each of these was re-verified against the exact pinned artifact, not against the test assertions.

- Unreal `AddPurchaseOffer(TEXT(""), ProductId, 1, Product->bIsConsumable)` now passes the consumable flag (`unreal.ts:367`), and `AppOpsEmitReceipt` forwards `LineItem.ValidationInfo` with the offer's product id and quantity rather than reusing the transaction id (`:328-343`).
- A real public header now exists: `unreal.ts:260-287` declares `UAppOpsStore` as a `UBlueprintFunctionLibrary` with `BlueprintCallable` `QueryProducts/Purchase/Restore/CompleteVerifiedPurchase` and the four-parameter delegate, and the `.generated.h` include is last as UnrealHeaderTool requires.
- Godot Billing reads `product_ids[0]` (`godot.ts:316-320`), which matches `Utils.kt:33` exactly, and calls `purchase_subscription(product_id, base_plan_id, offer_id)`, which matches `BillingClient.gd:127` exactly. The signal names, the enum names `BillingResponseCode.OK/ERROR/DEVELOPER_ERROR`, `ProductType.INAPP/SUBS`, `PurchaseState.PURCHASED`, and the response keys `product_details`, `purchases`, `response_code`, `debug_message`, `purchase_token`, `is_acknowledged`, `original_json` all match the pinned 3.3.0 source. `complete_verified_purchase` refuses an unknown token instead of guessing.
- Godot AdMob signatures match v5.0.0 exactly: `MobileAds.initialize(listener)`, `OnInitializationCompleteListener.on_initialization_complete`, `RewardedAdLoadCallback.on_ad_loaded/on_ad_failed_to_load`, `RewardedAd.full_screen_content_callback`, `RewardedAd.show(listener)`, `destroy()`, `RewardedItem.amount/type`. My earlier concern that the temporary `RewardedAdLoader` would be freed before the load completes is wrong: `RewardedAdLoader.gd` calls `reference()` before dispatching and `unreference.call_deferred()` in both callbacks.
- The Godot AdMob project settings are right. `godot.ts:98-99` writes `general/<platform>/enabled` and `general/<platform>/app_id` under `[admob]`, which resolves to `admob/general/android/app_id`, exactly the paths built by `project_settings_service.gd` (`get_android_setting_path`, `get_ios_setting_path`). Read back from the real engine: `admob_enabled=true`, `admob_app_id=ca-app-pub-...`. The old `app_ids.cfg` file is gone.
- Godot iOS StoreKit is now truthfully refused: `godot.ts:88-95` raises an error-severity `scope.godot_ios_storekit_source_only` finding, emits no `.gdip` and no Swift file, and the plan is unsupported.
- Unity no longer touches the `internal` AdMob editor API. `GoogleMobileAdsSettings` and `LoadInstance()` are still `internal` in 11.5.0; the template now patches only an existing asset whose `m_Script` GUID matches, and otherwise emits a warning.
- The Unity MAX binder uses only public members: `AppLovinSettings` is public in the global namespace, `Instance`, `SdkKey` and `SaveAsync` are all public in the pinned 8.6.5 source, and the settings GUID `ebc0ba1b5ef6b4a6b9dd53d7eadfea16` matches.
- Unity IAP now keys pending orders by `TransactionID` with an explicit empty-id refusal, subscribes `OnPurchasesFetched` and `OnPurchasesFetchFailed` before connecting, and calls `FetchPurchases()` after a successful restore. Every API name used exists in the pinned 5.4.2 package: `UnityIAPServices.StoreController()`, `Connect()`, `FetchProducts(List<ProductDefinition>)`, `PurchaseProduct(string)`, `RestoreTransactions(Action<bool,string?>)`, `FetchPurchases()`, `ConfirmPurchase(PendingOrder)`, `Orders.PendingOrders/ConfirmedOrders`, `Order.CartOrdered.Items()`, `CartItem.Product`, `Product.definition`, `ProductDefinition.id/type`, `PurchasesFetchFailureDescription.Message`.
- The Unity AdMob and MAX runtime bridges match their pinned packages. `MobileAds.Initialize(Action<InitializationStatus>)`, `RewardedAd.Load(id, request, (ad, error) => ...)`, `CanShowAd()`, `Show(reward => ...)`, `Reward.Amount/Type` all match the official 11.5.0 sample controller. `MaxSdk.InitializeSdk()`, `LoadRewardedAd`, `IsRewardedAdReady`, `ShowRewardedAd`, `MaxSdkCallbacks.OnSdkInitializedEvent` and `MaxSdkCallbacks.Rewarded.OnAdReceivedRewardEvent` with `Action<string, Reward, AdInfo>`, and `Reward.Label`/`Reward.Amount` types, all match 8.6.5.
- iOS now registers the Swift file with its full path and `sourceTree = SOURCE_ROOT` into the unique application target's Sources phase, and re-registration is idempotent. The earlier bare-basename defect is gone for a root-level project.
- The iOS StoreKit bridge is correct StoreKit 2 as far as static review can establish: a lifetime `Transaction.updates` listener started once, `VerificationResult.jwsRepresentation` forwarded for purchase, updates and `Transaction.currentEntitlements`, unverified results skipped, and `finish()` reached only through `completeVerifiedPurchase` matching an unfinished transaction by id.
- `fixtures/minimal-ios.pbxproj` is byte-identical to `MINIMAL_IOS_PBXPROJ` and now carries both `XCConfigurationList` objects with resolvable `XCBuildConfiguration` children, a bundle identifier, `SDKROOT`, deployment target and Swift version. It remains a fixture: no Info.plist, no Frameworks phase and no Resources phase, which is what P1-9 runs into.

## Verification performed and its limits

Commands and results:

| Check | Result |
|---|---|
| `node --import tsx --test tests/project-integration-template.test.ts tests/project-integration-template-compile.test.ts` | 16/16 pass |
| Generated-plan execution probes (Unreal, Godot, Unity, iOS) | ran, outputs quoted above |
| Godot 4.3 headless script runs on generated GDScript | ran, errors quoted above |
| Registry lookups (OpenUPM, npmjs, GitHub) | ran, results quoted above |
| Pinned SDK header inspection (GMA iOS 13.9.0, AppLovin iOS 13.6.4, Unity IAP 5.4.2, MAX Unity 8.6.5, GMA Unity 11.5.0, Godot Billing 3.3.0, Godot AdMob 5.0.0) | ran |

The passing suite is not evidence of buildability, and in several places it is evidence of the wrong thing:

- `tests/project-integration-template-compile.test.ts:202-313` compiles the Unreal store against stubs written in the same test, including a hand-written `#define HARBOR_API`. It cannot detect P0-8, P1-8 or P2-3, and it cannot detect a type error in the delegate because the stub macro discards the parameter types.
- `:114-158` writes its own `BillingClient.gd` stub and asserts only that the editor parses the generated script. The real 3.3.0 file has the same shape, so the stub is fair, but a parse check cannot reach P0-2, P1-4, P1-6 or P1-7. All four need the script to be executed, which this review did.
- `:27-49` and `:51-71` grep the real package sources and then regex the generated C#. No Unity compilation, Package Manager resolution or Editor import happens, so P0-4, P1-1, P1-2 and P1-3 pass through.
- `tests/project-integration-template.test.ts:65-94` asserts PBX tokens only. No `xcodebuild`, no `swiftc`, no `pod install`, so P0-5, P0-6, P0-7, P1-9 and P1-10 pass through.
- No test calls `wiringChecks`, which is how P0-1 survived.

Not available in this environment, and therefore not attempted: Unreal Engine and UnrealBuildTool, the Unity Editor, Xcode, `swiftc`, `xcodebuild`, CocoaPods, a Kotlin compiler, any device or simulator, and any store sandbox. Nothing in this report claims device or store behaviour. Every P0 and P1 above is a code defect reproducible without a device, except P1-8 whose omission is confirmed in the generated plan while its runtime consequence still needs a real engine.

Inspected artifact hashes:

| Artifact | SHA-256 |
|---|---|
| `googlemobileadsios-spm-13.9.0.zip` | `cd356c1fe78f0b19abe9b0722affc128dfcaf9f863fd69c379cc47d46275d7bb` |
| `AppLovinSDK-13.6.4.xcframework.zip` | `c00f052c4b15766a6a2734e2b3685234e6bd28dbc47fbe7cbc3edbf56f701d5c` |

Both match the checksums pinned by the vendors' own Swift packages. The Billing, Unity IAP and MAX Unity artifact hashes recorded in the previous report were reused unchanged; those files were not re-downloaded.

## Unverified, not counted as defects

- The Unreal ini keys. `unreal.ts:53-56` writes `bEnableGooglePlaySupport`, `AdMobAdUnitIDs` and `GooglePlayAppID` under `[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]`. Unreal Engine source is access-gated and the AdMob documentation page renders client-side, so I could not confirm the exact property names, nor whether an array-valued config key requires the `+` prefix that the dead ternary at `:55` hints at. Confirm against `AndroidRuntimeSettings.h` in the pinned engine version before release.
- `FPurchaseReceipt::TransactionState` and its enum spelling, for the same reason. The defect in P2-3 is that no state is checked at all, which is visible in the generated source.
- Whether AppLovin's Unity plugin, once installed from its real `.unitypackage`, keeps `MaxSdk.Scripts.IntegrationManager.Editor` auto-referenced. The shipped asmdef does not set `autoReferenced: false`, so `Assets/MaxSdk/Editor/AppOpsBindMaxSettings.cs` should compile in the Assets layout; this was not compiled.
- Whether writing into `Assets/MaxSdk/`, which the plugin owns, survives an Integration Manager plugin update.

## Evidence still required for release

1. Fix the eight P0 items, then re-run the wiring checks and confirm that a project with no game code reports `installed_unwired`, never `wired`, on every engine.
2. Compile each generated bridge with the real toolchain: UnrealBuildTool against a pinned engine including UnrealHeaderTool on the generated header, the Unity Editor importing both UPM and Assets layouts, `swiftc`/`xcodebuild` against the pinned iOS SDKs, `pod install` against a Podfile that has a `post_install` hook, and a Godot export with both plugins actually installed.
3. Execute, do not parse, the Godot bridges with the real plugins present, and prove that initialise, load, reward, purchase, restore and completion each reach the plugin.
4. Prove the non-destructive property on projects that already have state: an existing `[editor_plugins]` list, an existing `GoogleMobileAdsSettings.asset` with both platform ids, an existing Podfile with hooks, an existing multi-module Unreal project.
5. Then, and only then, device and sandbox acceptance: ad load, show and reward; purchase pending, success and cancel; the exact verification payload received server-side; correct consume, acknowledge and finish; and entitlement restoration across restart and reinstall on each engine.
