# App Operations v4 — SDK template follow-up review

Date: 2026-09-11  
Scope: independent, read-only review of the current `packages/project-integration/{templates,ids,wiring,detect,catalog}.ts` and `tests/project-integration-template*.test.ts`. Root storage, journal, apply/preview, and security behavior were excluded. This is a defensive source/API/flow review; no exploit payloads or store transactions were attempted.

## Release assessment

The earlier report is partly stale: Android Billing now preserves product type and separates `INAPP`/`SUBS`; Godot AdMob now uses the v5 initialization/reward callback contracts; Unreal module insertion and `IAdvertisingProvider*` are corrected; iOS rejects a missing Podfile, selects a unique application target, and forwards StoreKit JWS for purchase and restore; and the ID validators now fail closed on provider/format/platform mismatches. Those corrections are real, but the current templates are not yet build/runtime ready. There are still direct compile blockers in Unreal IAP and Unity AdMob, broken Godot subscription/purchase decoding, an invalid Xcode file reference, and restore/completion gaps across multiple engines.

## Current findings

### P0 — Unreal IAP emits a non-compiling checkout call and the wrong verification payload

- `packages/project-integration/templates/unreal.ts:254-299` emits `Request.AddPurchaseOffer(TEXT(""), ProductId, 1)`. The current Epic `FPurchaseCheckoutRequest::AddPurchaseOffer` contract takes namespace, offer ID, quantity, and `bIsConsumable`; the generated call omits the fourth argument. `planUnreal` also discards product types at `:173-179`, so it cannot supply the required consumable value. This blocks compilation against the real OnlineSubsystem interface.
- `packages/project-integration/templates/unreal.ts:294-299` and `:309-317` send `FPurchaseReceipt::TransactionId` as both token and `SignedPayload`. Epic defines each line item's `ValidationInfo` as the opaque data needed to verify ownership; a transaction identifier is not that validation payload. The callback must select the relevant receipt offer/line item, forward `ValidationInfo`, preserve the product/quantity mapping, and only finalize after backend acceptance.
- The store generator creates only `AppOpsStore.cpp` (`:173-179`) with free functions (`:273-339`), while `wiring.ts:55-61` and `detect.ts:126-132` look for callable `AppOpsStore.purchase/Purchase` and `.restore/Restore` hooks. There is no header, Blueprint library, or declared game-facing class, so the generated flow cannot satisfy its own game-hook contract without manual declarations.

Primary references: [Epic `FPurchaseCheckoutRequest`](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/OnlineSubsystem/FPurchaseCheckoutRequest), [Epic `FPurchaseReceipt::FLineItemInfo`](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/OnlineSubsystem/FPurchaseReceipt/FLineItemInfo), [Epic purchase interface](https://dev.epicgames.com/documentation/unreal-engine/online-subsystem-purchase-interface-in-unreal-engine).

Required correction: retain `VerifiedProduct.productType`, emit the four-argument offer call, provide a real header/Blueprint or module-facing API, and pass line-item `ValidationInfo` to verification. Compile `AppOpsStore.cpp` inside a pinned UE target; the current test compiles only ads against local stubs.

### P0 — Godot Google Play Billing 3.3.0 cannot launch subscriptions and misdecodes every purchase product

- `packages/project-integration/templates/godot.ts:216-224` ignores the queried subscription offers and calls `purchase_subscription(product_id, "")`. The exact 3.3.0 `BillingClient.gd` signature requires `base_plan_id`; its Kotlin bridge matches offers by `basePlanId`, and an empty/nonexistent plan returns `DEVELOPER_ERROR`. A product ID alone is insufficient for a subscription checkout.
- `packages/project-integration/templates/godot.ts:239-253` reads `product_id` and then `products`. Exact 3.3.0 `Utils.kt:20-34` exposes purchases as `product_ids`. Therefore the emitted `product_id` is empty, `_token_products` records the empty string, and `complete_verified_purchase` (`:230-237`) falls through to `consume`. That can choose consumption for subscriptions/non-consumables instead of acknowledgement after verification.
- The plugin signal shapes themselves are now correct: `connected` has no argument, and product/purchase/update signals each pass one `Dictionary` (`godot.ts:199-208`). The regression is payload-field and offer-selection logic, not signal arity.

Primary references: [tagged 3.3.0 `BillingClient.gd`](https://github.com/godot-sdk-integrations/godot-google-play-billing/blob/3.3.0/godot-google-play-billing/export_scripts/BillingClient.gd), [tagged 3.3.0 `Utils.kt`](https://github.com/godot-sdk-integrations/godot-google-play-billing/blob/3.3.0/godot-google-play-billing/src/main/java/org/godotengine/plugin/googleplaybilling/Utils.kt), [tagged 3.3.0 native bridge](https://github.com/godot-sdk-integrations/godot-google-play-billing/blob/3.3.0/godot-google-play-billing/src/main/java/org/godotengine/plugin/googleplaybilling/GodotGooglePlayBilling.kt).

Required correction: retain/select a `base_plan_id` and optional `offer_id` from `subscription_offer_details`, read `product_ids[0]`, reject missing/unknown catalog mappings, and exercise all three product types in a Godot export using plugin 3.3.0.

### P0 — Unity Google Mobile Ads 11.5.0 editor binder cannot compile in the UPM layout

`packages/project-integration/templates/unity.ts:109-129` creates an external Assets script that imports `GoogleMobileAds.Editor.GoogleMobileAdsSettings` and calls `LoadInstance()`. In the exact official 11.5.0 source, both the class and `LoadInstance()` are `internal`; in the UPM installation selected by `unity.ts:60-64`, the generated Assets script is outside the plugin editor assembly and cannot access either symbol. The direct YAML patch at `:85-100` uses the correct serialized field names when a valid settings asset already exists, but the advertised fallback binder is a compile blocker rather than a supported fallback.

Primary references: [official v11.5.0 settings source](https://github.com/googleads/googleads-mobile-unity/blob/v11.5.0/source/plugin/Assets/GoogleMobileAds/Editor/GoogleMobileAdsSettings.cs), [official Unity setup](https://developers.google.com/admob/unity/quick-start).

Required correction: patch only a valid existing serialized settings asset, or use a supported public/editor integration path inside the package's assembly model. Add a Unity compilation/import test for the exact 11.5.0 UPM package.

### P0 — iOS registers the StoreKit Swift source in the right target with the wrong filesystem path

`packages/project-integration/templates/ios.ts:234-239` creates `AppOpsMonetization/AppOpsStore.swift`, but `registerSwiftInPbx` emits `path = AppOpsStore.swift` at `:343-350` and inserts that reference into the first text-matched PBX group at `:358-361`. Unless that arbitrary group resolves to `AppOpsMonetization`, Xcode looks for a root/group-relative `AppOpsStore.swift` that does not exist. The unique application Sources phase selection at `:302-312` fixes the earlier wrong-target problem, but it does not fix the file reference/group path.

Primary reference: [Apple Xcode project build/file concepts](https://developer.apple.com/library/archive/featuredarticles/XcodeConcepts/Concept-Projects.html).

Required correction: either create a matching `AppOpsMonetization` PBX group and use the basename, or retain `path = AppOpsMonetization/AppOpsStore.swift` under the project root group. Extend `tests/project-integration-template.test.ts:64-90` to assert the full path and group relationship, then run an actual `xcodebuild`; the current assertion checks only `AppOpsStore.swift in Sources`.

### P1 — Android Billing 9.1 APIs match, but restore and completion are not fail closed

- The generated Billing 9.1 surface is now materially correct: `PendingPurchasesParams`, auto reconnection, separate `INAPP`/`SUBS` queries, one-time/subscription offer tokens, and consume-versus-ack catalog mapping appear at `packages/project-integration/templates/android.ts:330-456`. `javap`/`javac` checks against the exact 9.1.0 `classes.jar` confirmed those API symbols.
- `handlePurchases` skips every acknowledged purchase at `android.ts:458-466`. Because `restore()` routes owned purchases through that same method (`:435-444`), already acknowledged non-consumables and active subscriptions are never emitted to the verification/entitlement callback after reinstall or local-state loss. Acknowledged means the Play transaction was completed; it does not mean this process already restored the entitlement.
- `completeVerifiedPurchase` defaults an unknown token to `ACK` at `android.ts:446-455`. The token-to-product map is process-local (`:363-366`), so a restart between verification and completion can acknowledge a consumable rather than consume it. Unknown mappings must stop, not select a completion operation. The asynchronous consume/ack results are also discarded, leaving no retry/error route.

Primary references: [Play Billing integration and restore processing](https://developer.android.com/google/play/billing/integrate), [Billing security/verification](https://developer.android.com/google/play/billing/security), [BillingClient reference](https://developer.android.com/reference/com/android/billingclient/api/BillingClient).

Required correction: surface owned acknowledged non-consumables/subscriptions as entitlement-restoration events without trying to acknowledge them again; persist or re-derive a verified token/product/type association; reject unknown associations; and inspect/retry non-OK completion results.

### P1 — Godot iOS StoreKit output is a Swift source drop, not a loadable Godot plugin

`packages/project-integration/templates/godot.ts:259-315` contains valid StoreKit 2 purchase/current-entitlement JWS handling, but `:319-338` declares a nonexistent `libappops_storekit.a`, leaves initialization/deinitialization empty, and merely lists the Swift file. It neither builds a Godot-linked static library/xcframework nor registers a singleton callable from GDScript. As generated, purchase, restore, JWS delivery, and completion have no Godot runtime entry point.

Primary references: [Godot iOS plugin requirements](https://docs.godotengine.org/en/stable/tutorials/platform/ios/ios_plugin.html), [Apple `Transaction`](https://developer.apple.com/documentation/storekit/transaction), [Apple verification results](https://developer.apple.com/documentation/storekit/verificationresult).

Required correction: generate/build a real Godot iOS plugin with initialization registration and exposed methods/signals, or explicitly classify the template as source-only/unwired and require the official StoreKit 2 Godot plugin.

### P1 — Unity IAP 5.4.2 restore does not deliver restored ownership, and receipt is a poor dictionary key

`packages/project-integration/templates/unity.ts:292-329` uses the correct 5.4.2 `StoreController` API names, but `Restore()` only logs the `RestoreTransactions` status (`:311-314`). The exact package exposes restored/existing orders through `OnPurchasesFetched`/`FetchPurchases`; the bridge subscribes only `OnPurchasePending` (`:294-297`) and therefore has no explicit restored-entitlement output for confirmed non-consumables/subscriptions. At `:300-307`, it keys pending orders by `order.Info.Receipt`; exact `IOrderInfo` states that Apple supplies the full receipt of every purchase, so that value is not a stable per-order identifier and can collide/overwrite. `TransactionID` should identify the pending order while `Receipt` remains the verification payload.

Primary reference: [Unity IAP 5.4 manual](https://docs.unity3d.com/Packages/com.unity.purchasing@5.4/manual/index.html). Exact artifact evidence: `Runtime/Purchasing/Core/Purchasing/Models/Interfaces/IOrderInfo.cs:31-50` and `Runtime/Purchasing/Core/StoreController.cs:159-174,275-305` in the supplied 5.4.2 package.

Required correction: subscribe before connection to purchase-fetch success/failure, emit each restorable entitlement with its receipt and transaction ID, and key pending completion by `TransactionID` (with an explicit empty-ID failure path).

### P1 — SDK settings presence is mistaken for configuration in Unity MAX and Godot AdMob

- Unity MAX: `packages/project-integration/templates/unity.ts:145-170` loads an untyped `ScriptableObject` and checks only existence; runtime at `:188-203` trusts the separate `maxSdkKeyBound` boolean and again checks only asset existence. Exact MAX 8.6.5 exposes public `AppLovinSettings.Instance.SdkKey` and `SaveAsync()`. An empty-key asset can currently pass both checks and call `MaxSdk.InitializeSdk()`.
- Godot AdMob: `packages/project-integration/templates/godot.ts:98-104` writes `addons/appops_monetization/app_ids.cfg`, but official v5.0.0 configures per-platform Enabled/App ID under Godot Project Settings and does not consume this AppOps file. The initialization/reward signatures at `:111-169` now match v5, but the native export remains unconfigured unless a user separately performs the plugin setup.

Primary references: [MAX Unity integration](https://support.applovin.com/en/max/unity/overview/integration), [official MAX 8.6.5 settings source](https://github.com/AppLovin/AppLovin-MAX-Unity-Plugin/blob/release_8_6_5/Assets/MaxSdk/Scripts/IntegrationManager/Editor/AppLovinSettings.cs), [tagged Godot AdMob v5 setup](https://github.com/poingstudios/godot-admob-plugin/blob/v5.0.0/docs/index.md).

Required correction: inspect/bind the typed MAX `SdkKey` and remain `installed_unwired` when empty; for Godot, write the official Project Settings keys through a supported plugin path or explicitly require and detect that editor configuration.

### P1 — native StoreKit needs a transaction-update listener

The iOS StoreKit bridge correctly forwards `VerificationResult.jwsRepresentation` for purchases and `Transaction.currentEntitlements` restore at `packages/project-integration/templates/ios.ts:255-289`. It does not start a long-lived `Transaction.updates` listener, so Ask-to-Buy/deferred purchases and transactions completed on another device are not surfaced while the app is running unless a caller explicitly invokes restore. Keep the listener alive for the app lifecycle, verify each result, emit its JWS, and finish only after backend acceptance.

Primary references: [Apple in-app purchase integration](https://developer.apple.com/documentation/storekit/in-app_purchase), [Apple `Transaction.updates`](https://developer.apple.com/documentation/storekit/transaction/updates), [Apple `Transaction.currentEntitlements`](https://developer.apple.com/documentation/storekit/transaction/currententitlements).

## Confirmed corrections from the earlier report

- ID validation and rewarded selection are fail closed: `ids.ts:4-11,47-112,115-167` validates enums/provider grammar/platform and requires an exact `REWARD` unit.
- Android now preserves product type, queries `INAPP` and `SUBS`, selects offers, and separates consume from acknowledge: `android.ts:330-456`.
- Godot AdMob v5 signatures now match the tagged source (`OnInitializationCompleteListener`, `RewardedAdLoadCallback`, `OnUserEarnedRewardListener`, `destroy`): `godot.ts:111-169`.
- Unreal constructor insertion is brace-bounded (`unreal.ts:75-110,184-215`), and ads use the real `IAdvertisingProvider*` shape (`:217-250`). First-party rewarded is explicitly rejected instead of invented.
- Native iOS no longer invents a Podfile target (`ios.ts:14-23`), requires one unique application target for Sources (`:302-335`), and forwards JWS in purchase and restore (`:255-289`).
- `catalog.ts:45-99` pins the reviewed Billing, StoreKit, Unity IAP, and Godot packages consistently with the inspected versions.

## Verification performed and its limits

Command: `node --import tsx --test tests/project-integration-template.test.ts tests/project-integration-template-compile.test.ts`  
Result: 10/10 tests passed.

That result is not native-runtime evidence:

- Android test `tests/project-integration-template-compile.test.ts:42-81` compiles a handwritten Java API probe against Billing 9.1.0; emitted Kotlin is checked only for two text tokens. No Kotlin compiler was available.
- Unreal test `:83-123` compiles emitted advertising C++ against locally authored stubs; it does not compile the store bridge or use Unreal headers/tooling.
- Unity IAP test `:26-40` greps exact package source signatures and then regex-checks generated C#; it does not compile in Unity. The Google Mobile Ads and MAX editor/runtime templates have no Unity compilation test.
- Godot tests `tests/project-integration-template.test.ts:105-117` are token assertions only. No Godot editor/import/export or plugin runtime was available.
- iOS tests `:64-90` are string/PBX token assertions only. No Swift compiler, Xcode, simulator, signing, or StoreKit sandbox was available.
- No ad load/show/reward, purchase UI, backend verification, consume/acknowledge/finalize, restore-after-restart, or native SDK initialization was exercised.

Inspected local artifact hashes:

| Artifact | SHA-256 |
|---|---|
| `billing-9.1.0.aar` | `d28286d4e4c18725510980de01211d9b72501e7146d96817fa0c9999af9b0d22` |
| extracted Billing `classes.jar` | `3be24f22afdafe9abb2b0eb864b02b64c16e51619d756d3727a14c557c75c10d` |
| `unity-iap-5.4.2.tgz` | `f7c516d0b6ee44aead758ac000cbec5fa451086da779c94b92005e52e26bb220` |
| `max-unity-8.6.5.unitypackage` | `8070203b3e34cd38bb25e3f7eaf8009f4b612029a555cfc628a6f70b3c17220c` |

Release evidence still needed after corrections: real emitted-source compilation/import in each engine, then platform sandbox/device coverage for SDK readiness, ad reward, purchase pending/success/cancel, server verification payload, correct consume/acknowledge/finish behavior, and entitlement restoration across restart/reinstall.
