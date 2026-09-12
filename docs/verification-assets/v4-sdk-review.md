# App Operations v4 — independent SDK implementation review

Date: 2026-09-11  
Scope: read-only review of `packages/project-integration/**`, `tests/project-integration.test.ts`, and `docs/project-integration.md` against official SDK APIs and exact pinned artifacts. Native OS, Unity, Godot, and Unreal editors were unavailable, so this is source/package verification—not a device, editor-import, store-sandbox, or native-build attestation.

## Release assessment

Not ready for the stated “all engines ads/IAP” requirement. The transaction hardening reported by the coordinator (isolated journal state and 14 passing transaction tests) is positive, but those tests do not establish that generated projects compile or that initialize/show/reward/purchase/restore work in an engine or store sandbox.

## Findings

### P0 — Unreal output is not buildable and does not implement the required flows

- `packages/project-integration/templates/unreal.ts:75-104` inserts the platform `if` immediately before the final class brace of a normal `.Target.cs`; that places executable code outside the constructor. Insert into the constructor body using a syntax-aware or strictly validated anchor, and reject unknown layouts.
- `packages/project-integration/templates/unreal.ts:173-203` assigns `FAdvertising::Get().GetAdvertisingProvider()` to `TSharedPtr<IAdvertisingProvider>`. Epic’s interface returns an `IAdvertisingProvider*`; the emitted type/check shape is incompatible. The first-party advertising interface documents banner/interstitial operations, not rewarded rewards, so it cannot satisfy the requested reward flow.
- `packages/project-integration/templates/unreal.ts:207+` only starts product/receipt queries. It does not provide a complete callable checkout, completion callback, server receipt verification handoff, entitlement decision, or finalization path.
- `packages/project-integration/templates/unreal.ts:23-30` says there is no official MAX module, but AppLovin now publishes an official Unreal integration. Either integrate and compile-check that supported plugin or explicitly report Unreal/MAX as unsupported; do not report installed or runtime verified.

Required acceptance: compile a generated Unreal target, exercise documented provider initialization and supported ad formats, and perform checkout/receipt verification/finalization plus restore through the platform online subsystem. Sources: [Epic mobile ads guide](https://dev.epicgames.com/documentation/unreal-engine/using-in-game-ads-in-unreal-engine-projects-on-mobile-platforms), [Epic `FAdvertising`](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Advertising/FAdvertising), [Epic purchase interface](https://dev.epicgames.com/documentation/unreal-engine/online-subsystem-purchase-interface-in-unreal-engine), [AppLovin MAX Unreal integration](https://support.applovin.com/en/max/unreal/overview/integration).

### P0 — Godot purchase/reward paths cannot deliver verified outcomes

- `packages/project-integration/templates/godot.ts:114-134` does not wait for mobile-ads initialization, uses an underspecified rewarded-load callback, and calls `show()` without the v5 reward listener/callback needed to grant a reward. Implement the exact v5 initialization completion and `RewardedAdLoadCallback`/`OnUserEarnedRewardListener` contracts, including disposal and reload lifecycle.
- `packages/project-integration/templates/godot.ts:155-190` queries product details only as `INAPP`, does not subscribe to the purchase-update signal, and always acknowledges in `complete_verified_purchase`. Subscriptions require `SUBS` and offer selection; consumables require consumption after server entitlement rather than acknowledgement.
- `packages/project-integration/templates/godot.ts:196-228` accepts a verified StoreKit result but never emits the transaction/JWS to the backend; restore only syncs and emits no verified current entitlements. The generated Swift also lacks demonstrated Godot export-plugin registration/callable binding.

Required acceptance: install the exact official plugins, import and compile in Godot, wait for SDK readiness, deliver a rewarded callback, route purchase tokens/JWS to a backend, consume/acknowledge/finish only after entitlement, and restore verified ownership after restart. Sources: [Godot AdMob v5 migration](https://poingstudios.github.io/godot-admob-plugin/5.0/migration/), [Godot rewarded ads](https://poingstudios.github.io/godot-admob-plugin/latest/ad_formats/rewarded/), [official Godot Billing client source](https://github.com/godot-sdk-integrations/godot-google-play-billing/blob/master/godot-google-play-billing/export_scripts/BillingClient.gd), [Godot Android IAP guide](https://docs.godotengine.org/en/4.6/tutorials/platform/android/android_in_app_purchases.html), [Apple `Transaction.currentEntitlements`](https://developer.apple.com/documentation/storekit/transaction/currententitlements).

### P1 — Unity app/SDK-key settings are not bound through supported plugin assets

- `packages/project-integration/templates/unity.ts:82-97` creates a `GoogleMobileAdsSettings.asset` without the required `m_Script` reference and writes `googleMobileAdsAndroidAppId` / `googleMobileAdsIOSAppId`; the 11.5.0 plugin source serializes `adMobAndroidAppId` / `adMobIOSAppId`. This synthetic asset is not a valid assurance that either app ID is loaded.
- `packages/project-integration/templates/unity.ts:102-114` writes an AppOps JSON and text resource, while the official MAX Unity plugin reads its own `AppLovinSettings` asset. The generated bridge’s `MaxSdk.SetSdkKey` call (`:135-142`) exists in 8.6.5 but is deprecated; the JSON itself is never consumed.

Update existing valid plugin settings through Unity editor serialization, preserving script references, or generate them through an editor import step. Validate that the public client SDK key—not a management/report credential—is present in the plugin’s supported configuration before initialization; otherwise remain `installed_unwired`. Sources: [Google Mobile Ads Unity setup](https://developers.google.com/admob/unity/quick-start), [official settings source](https://github.com/googleads/googleads-mobile-unity/blob/main/source/plugin/Assets/GoogleMobileAds/Editor/GoogleMobileAdsSettings.cs), [MAX Unity integration](https://support.applovin.com/en/max/unity/overview/integration).

### P1 — Android Billing drops product semantics

- `packages/project-integration/templates/android.ts:184-190` reduces the verified catalog to IDs. Consequently `:371-404` queries everything as `INAPP` and uses one-time offers, so subscriptions cannot be purchased.
- `packages/project-integration/templates/android.ts:418-423` always acknowledges a verified token. Consumables must instead be consumed after backend entitlement so they can be bought again.
- `purchase(...): Boolean` at `:388-405` reports only whether the billing UI launched, not purchase success; callers and documentation must not treat it as entitlement.

Preserve `productType`, query `INAPP` and `SUBS` separately, select valid subscription offers, and branch completion to consume versus acknowledge only after backend verification. The new `verificationRequired` handoff and deferral of acknowledgement (`:338-434`) are directionally correct. Sources: [Play Billing integration](https://developer.android.com/google/play/billing/integrate), [secure backend processing](https://developer.android.com/google/play/billing/backend), [billing security](https://developer.android.com/google/play/billing/security).

### P1 — iOS integration and restore still need fail-closed target/receipt handling

- `packages/project-integration/templates/ios.ts:14-17` fabricates a CocoaPods target named `App` when none exists. This is not evidence that dependencies are linked to the actual application target.
- The new PBX registration at `:274-312` chooses the first sources phase/group by text pattern and does not associate it with the intended native target. On multi-target projects it can attach generated Swift to the wrong target. Require an unambiguous application target or stop with `installed_unwired`.
- Native StoreKit purchase now forwards a locally verified JWS and finishes only through `completeVerifiedPurchase` (`:218-267`), which is a sound direction. Restore, however, emits an empty signed payload at `:252-258`; the backend cannot verify that handoff as generated. Forward each verified result’s signed representation and keep cancellation, pending, and unverified states distinct.

Sources: [Apple `Product.PurchaseResult`](https://developer.apple.com/documentation/storekit/product/purchaseresult), [Apple `Transaction`](https://developer.apple.com/documentation/storekit/transaction), [Apple `AppStore.sync()`](https://developer.apple.com/documentation/storekit/appstore/sync%28%29), [Google iOS ads setup](https://developers.google.com/admob/ios/quick-start), [MAX iOS integration](https://support.applovin.com/en/max/ios/overview/integration).

### P1 — public-ID validation is syntactically safe but semantically incomplete

- `packages/project-integration/ids.ts:45-76` accepts an AdMob-shaped unit for provider `applovin-max`, preserves unknown ad formats, and does not enforce `unit.platform` against the requested platform.
- `packages/project-integration/ids.ts:81-96` casts `productType` without validating its runtime enum value.
- `packages/project-integration/ids.ts:115-116` falls back to the first ad unit when no rewarded unit exists, allowing a banner/interstitial ID to be emitted into rewarded code.
- `packages/project-integration/ids.ts:127-169` validates provider/platform in isolation but not valid engine/platform pairs or verified app/provider ownership.

Require exact enums, exact provider ID grammar, matching platform and application ownership from the root-supplied verified records, a real `REWARD` unit for rewarded templates, and a supported engine/platform pair. Current allowlists plus `JSON.stringify` prevent direct string-literal injection for the reviewed public-ID shapes; no raw public-ID code injection was found, but that does not replace semantic association checks.

## Verified positive scope and limits

- Exact package/source inspection confirmed the reviewed pins exist: Google Mobile Ads Android 25.4.0, iOS 13.9.0, Unity 11.5.0; Play Billing 9.1.0; AppLovin Android/iOS 13.6.4 and Unity 8.6.5; Unity IAP 5.4.2; Godot AdMob 5.0.0; Godot Google Play Billing 3.3.0. The Android AdMob/MAX initialization and rewarded API symbols match their pinned artifacts.
- Unity IAP now uses the 5.4 connection, product fetch, pending-order, restore, and `ConfirmPurchase` shapes, and defers confirmation behind a backend handoff. It still requires Unity compilation and sandbox transaction verification.
- `packages/project-integration/wiring.ts:116-140` now distinguishes a generated bridge from a game call site and reports it as `installed_unwired`. Keep this fail-closed behavior.
- Coordinator-reported journal isolation/content-hash/back-up fixes and 14 passing transaction tests cover transaction mechanics. This review intentionally did not reproduce journal attacks, and it does not elevate template-token tests to SDK runtime proof.
- A plugin declaration, generated README, source drop, or package pin is not an installed/runtime-verified integration. Release evidence must include dependency resolution, engine/native compilation, SDK initialization completion, ad load/show/reward, purchase pending/success/cancel paths, backend verification, correct consume/acknowledge/finish behavior, and restore across restart on supported native targets.
