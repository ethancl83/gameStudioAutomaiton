import { CATALOG, marker, MAX_SDK_PLACEHOLDER } from '../catalog.js';
import { rewardedUnit } from '../ids.js';
import { insertIntoBlock, ensureXmlMeta } from '../patch.js';
import type { IntegrationFinding, PlannedFileChange, SdkCatalogEntry, TemplateContext, TemplatePlan, VerifiedProduct } from '../types.js';

function gradleFiles(): string[] {
  return ['app/build.gradle', 'app/build.gradle.kts', 'build.gradle', 'build.gradle.kts'];
}

export function planAndroid(ctx: TemplateContext, existing: Map<string, string | null>): TemplatePlan {
  const findings: IntegrationFinding[] = [];
  const changes: PlannedFileChange[] = [];
  const catalog: SdkCatalogEntry[] = [];
  const ads = ctx.provider === 'admob' || ctx.provider === 'applovin-max';
  const iap = ctx.products.length > 0 || ctx.provider === 'play-billing';

  const gradlePath = ['app/build.gradle', 'app/build.gradle.kts'].find((path) => existing.get(path) != null)
    ?? gradleFiles().find((path) => existing.get(path) != null)
    ?? (existing.has('app/build.gradle.kts') ? 'app/build.gradle.kts' : 'app/build.gradle');
  const groovy = gradlePath.endsWith('.gradle') && !gradlePath.endsWith('.kts');
  let gradle = existing.get(gradlePath) ?? '';
  if (!gradle) {
    gradle = groovy
      ? `plugins { id 'com.android.application' }\nandroid { namespace 'com.example.app' }\ndependencies {\n}\n`
      : `plugins { id("com.android.application") }\nandroid { namespace = "com.example.app" }\ndependencies {\n}\n`;
    changes.push({ path: gradlePath, action: 'create', reason: '앱 모듈 Gradle이 없어 최소 파일을 만듭니다.', content: gradle });
  }

  const deps: string[] = [];
  if (ctx.provider === 'admob') {
    catalog.push(CATALOG.admobAndroid);
    deps.push(groovy
      ? `implementation 'com.google.android.gms:play-services-ads:${CATALOG.admobAndroid.version}'`
      : `implementation("com.google.android.gms:play-services-ads:${CATALOG.admobAndroid.version}")`);
  }
  if (ctx.provider === 'applovin-max') {
    catalog.push(CATALOG.maxAndroid);
    deps.push(groovy
      ? `implementation 'com.applovin:applovin-sdk:${CATALOG.maxAndroid.version}'`
      : `implementation("com.applovin:applovin-sdk:${CATALOG.maxAndroid.version}")`);
  }
  if (iap) {
    catalog.push(CATALOG.playBilling);
    deps.push(groovy
      ? `implementation 'com.android.billingclient:billing:${CATALOG.playBilling.version}'`
      : `implementation("com.android.billingclient:billing:${CATALOG.playBilling.version}")`);
  }

  const depMark = marker('android-deps', 'slash');
  const patchedGradle = insertIntoBlock(
    existing.get(gradlePath) ?? gradle,
    /dependencies\s*\{/,
    depMark.begin,
    depMark.end,
    deps.join('\n'),
    findings,
    gradlePath,
  );
  if (patchedGradle == null) {
    return { supported: false, catalog, changes, findings };
  }
  if (patchedGradle !== (existing.get(gradlePath) ?? '')) {
    const existingDep = existing.get(gradlePath) ?? '';
    if (/play-services-ads:[^'\"]+/.test(existingDep) && ctx.provider === 'admob' && !existingDep.includes(CATALOG.admobAndroid.version) && !existingDep.includes(depMark.begin)) {
      findings.push({
        code: 'conflict.existing_admob_version',
        severity: 'error',
        message: '이미 다른 play-services-ads 버전이 있습니다. 덮어쓰지 않습니다.',
        path: gradlePath,
        fixHint: `기존 버전을 ${CATALOG.admobAndroid.version}으로 맞추거나 관리 구간을 비우세요.`,
      });
      return { supported: false, catalog, changes, findings };
    }
    changes.push({
      path: gradlePath,
      action: existing.get(gradlePath) ? 'patch' : 'create',
      reason: '공식 Maven 아티팩트를 앱 모듈 dependencies에 추가합니다.',
      content: patchedGradle,
    });
  }

  const manifestPath = existing.get('app/src/main/AndroidManifest.xml') != null
    ? 'app/src/main/AndroidManifest.xml'
    : (existing.get('src/main/AndroidManifest.xml') != null ? 'src/main/AndroidManifest.xml' : 'app/src/main/AndroidManifest.xml');
  let manifest = existing.get(manifestPath);
  if (!manifest) {
    manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n    <application>\n    </application>\n</manifest>\n`;
  }
  manifest = expandSelfClosingApplication(manifest);
  if (ctx.provider === 'admob' && ctx.appId) {
    const m = marker('admob-app-id', 'xml');
    const next = ensureXmlMeta(manifest, 'com.google.android.gms.ads.APPLICATION_ID', ctx.appId, m.begin, m.end, findings, manifestPath);
    if (next == null) return { supported: false, catalog, changes, findings };
    manifest = next;
  }
  if (ctx.provider === 'applovin-max') {
    const m = marker('max-sdk-key', 'xml');
    const next = ensureXmlMeta(manifest, 'applovin.sdk.key', MAX_SDK_PLACEHOLDER, m.begin, m.end, findings, manifestPath);
    if (next == null) return { supported: false, catalog, changes, findings };
    manifest = next;
    findings.push({
      code: 'max.runtime_key',
      severity: 'info',
      message: 'MAX SDK Key는 매니페스트에 플레이스홀더만 둡니다. 런타임 설정으로 따로 바인딩하세요.',
      path: manifestPath,
      fixHint: 'options.maxSdkKeyBound=true 와 AppOps 런타임 설정을 사용하세요. vault 값을 쓰지 않습니다.',
    });
  }
  if (iap) {
    if (!manifest.includes('com.android.vending.BILLING')) {
      const permMark = marker('play-billing-permission', 'xml');
      if (!manifest.includes(permMark.begin)) {
        manifest = manifest.replace(
          '<manifest',
          `<manifest`,
        );
        const insertAt = manifest.indexOf('>');
        manifest = `${manifest.slice(0, insertAt + 1)}\n    ${permMark.begin}\n    <uses-permission android:name="com.android.vending.BILLING" />\n    ${permMark.end}${manifest.slice(insertAt + 1)}`;
      }
    }
  }
  if (manifest !== (existing.get(manifestPath) ?? '')) {
    changes.push({
      path: manifestPath,
      action: existing.get(manifestPath) ? 'patch' : 'create',
      reason: '공식 매니페스트 메타데이터·결제 권한을 추가합니다.',
      content: manifest,
    });
  }

  if (ads) {
    if (!rewardedUnit(ctx.adUnits)) {
      findings.push({
        code: 'id.reward_unit_required',
        severity: 'error',
        message: '보상형 광고 브리지에는 adFormat=REWARD 단위가 필요합니다. 배너/전면 ID로 대체하지 않습니다.',
      });
    } else {
      changes.push(androidAdsBridge(ctx));
    }
  }
  if (iap) changes.push(androidBillingBridge(ctx));
  if (ctx.provider === 'applovin-max') {
    changes.push({
      path: 'appops/max-runtime.properties',
      action: existing.get('appops/max-runtime.properties') ? 'patch' : 'create',
      reason: 'MAX 공개 SDK 키(클라이언트)는 스테이징 훅으로만 주입합니다. 관리 API 비밀이 아닙니다.',
      content: [
        `# ${marker('max-runtime', 'hash').begin}`,
        'sdk_key_placeholder=' + MAX_SDK_PLACEHOLDER,
        `sdk_key_bound=${ctx.maxSdkKeyBound ? 'true' : 'false'}`,
        'public_sdk_key_hook=assets/appops/max_sdk_key',
        'note=AppLovin Account > Keys SDK Key is the public client key. Never write Report Key or Management API secrets into the game.',
        `# ${marker('max-runtime', 'hash').end}`,
        '',
      ].join('\n'),
    });
    if (existing.get('app/src/main/assets/appops/max_sdk_key') == null) {
      changes.push({
        path: 'app/src/main/assets/appops/max_sdk_key',
        action: 'create',
        reason: '컨트롤러가 스테이징에서 공개 MAX SDK 키를 주입하는 훅. 미리보기에는 값을 쓰지 않습니다.',
        content: '\n',
      });
    }
  }
  return { supported: findings.every((item) => item.severity !== 'error'), catalog, changes, findings };
}

function expandSelfClosingApplication(manifest: string): string {
  return manifest.replace(/<application(\s[^>]*)?\s*\/>/g, (_match, attrs: string | undefined) => `<application${attrs ?? ''}>\n    </application>`);
}

function androidAdsBridge(ctx: TemplateContext): PlannedFileChange {
  const unit = rewardedUnit(ctx.adUnits)!.adUnitId;
  const appId = ctx.appId ?? '';
  if (ctx.provider === 'applovin-max') {
    return {
      path: 'app/src/main/java/appops/monetization/AppOpsAds.kt',
      action: 'create',
      reason: 'MAX initialize/show/reward 공식 API 브리지',
      content: maxKotlin(unit, ctx.maxSdkKeyBound),
    };
  }
  return {
    path: 'app/src/main/java/appops/monetization/AppOpsAds.kt',
    action: 'create',
    reason: 'AdMob MobileAds.initialize / RewardedAd.load / show 공식 API 브리지',
    content: admobKotlin(appId, unit),
  };
}

function androidBillingBridge(ctx: TemplateContext): PlannedFileChange {
  return {
    path: 'app/src/main/java/appops/monetization/AppOpsBilling.kt',
    action: 'create',
    reason: 'Play Billing Library 9.1.0 INAPP/SUBS query, launch-only purchase, consume vs acknowledge after verify',
    content: billingKotlin(ctx.products),
  };
}

function admobKotlin(appId: string, unit: string): string {
  return `package appops.monetization

import android.app.Activity
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.OnUserEarnedRewardListener
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback

// APPOPS-INTEGRATION-BEGIN android-admob-bridge
// Official: https://developers.google.com/admob/android/quick-start
// Official rewarded: https://developers.google.com/admob/android/rewarded
object AppOpsAds {
    const val APP_ID: String = ${JSON.stringify(appId)}
    const val REWARDED_AD_UNIT_ID: String = ${JSON.stringify(unit)}
    @Volatile private var rewarded: RewardedAd? = null
    @Volatile var lastRewardType: String? = null
    @Volatile var lastRewardAmount: Int = 0

    @JvmStatic
    fun initialize(activity: Activity) {
        Thread {
            MobileAds.initialize(activity) { }
        }.start()
    }

    @JvmStatic
    fun loadRewarded(activity: Activity) {
        RewardedAd.load(
            activity,
            REWARDED_AD_UNIT_ID,
            AdRequest.Builder().build(),
            object : RewardedAdLoadCallback() {
                override fun onAdLoaded(ad: RewardedAd) { rewarded = ad }
                override fun onAdFailedToLoad(error: LoadAdError) { rewarded = null }
            },
        )
    }

    @JvmStatic
    fun showRewarded(activity: Activity): Boolean {
        val ad = rewarded ?: return false
        ad.show(activity, OnUserEarnedRewardListener { reward ->
            lastRewardType = reward.type
            lastRewardAmount = reward.amount
        })
        return true
    }
}
// APPOPS-INTEGRATION-END android-admob-bridge
`;
}

function maxKotlin(unit: string, bound: boolean): string {
  return `package appops.monetization

import android.app.Activity
import com.applovin.mediation.MaxAd
import com.applovin.mediation.MaxError
import com.applovin.mediation.MaxReward
import com.applovin.mediation.MaxRewardedAdListener
import com.applovin.mediation.ads.MaxRewardedAd
import com.applovin.sdk.AppLovinMediationProvider
import com.applovin.sdk.AppLovinSdk
import com.applovin.sdk.AppLovinSdkInitializationConfiguration

// APPOPS-INTEGRATION-BEGIN android-max-bridge
// Official: https://support.applovin.com/en/max/android/overview/integration
// Public client SDK key is loaded from assets/appops/max_sdk_key (staged). Management/report keys must never be in the game.
object AppOpsAds {
    const val REWARDED_AD_UNIT_ID: String = ${JSON.stringify(unit)}
    const val SDK_KEY_BOUND: Boolean = ${bound ? 'true' : 'false'}
    const val SDK_KEY_PLACEHOLDER: String = "«SDK-key»"
    private var rewarded: MaxRewardedAd? = null
    @Volatile var lastRewardLabel: String? = null
    @Volatile var lastRewardAmount: Int = 0

    @JvmStatic
    fun loadPublicSdkKey(activity: Activity): String? {
        return try {
            activity.assets.open("appops/max_sdk_key").bufferedReader().use { it.readText().trim() }.ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    @JvmStatic
    fun initialize(activity: Activity, runtimeSdkKey: String? = null) {
        val key = runtimeSdkKey?.takeIf { it.isNotEmpty() } ?: loadPublicSdkKey(activity) ?: return
        val config = AppLovinSdkInitializationConfiguration.builder(key, activity)
            .setMediationProvider(AppLovinMediationProvider.MAX)
            .build()
        AppLovinSdk.getInstance(activity).initialize(config) { }
    }

    @JvmStatic
    fun loadRewarded(activity: Activity) {
        val ad = MaxRewardedAd.getInstance(REWARDED_AD_UNIT_ID, activity)
        ad.setListener(object : MaxRewardedAdListener {
            override fun onAdLoaded(maxAd: MaxAd) {}
            override fun onAdLoadFailed(adUnitId: String, error: MaxError) {}
            override fun onAdDisplayed(maxAd: MaxAd) {}
            override fun onAdHidden(maxAd: MaxAd) { ad.loadAd() }
            override fun onAdClicked(maxAd: MaxAd) {}
            override fun onAdDisplayFailed(maxAd: MaxAd, error: MaxError) { ad.loadAd() }
            override fun onUserRewarded(maxAd: MaxAd, reward: MaxReward) {
                lastRewardLabel = reward.label
                lastRewardAmount = reward.amount
            }
        })
        ad.loadAd()
        rewarded = ad
    }

    @JvmStatic
    fun showRewarded(activity: Activity): Boolean {
        val ad = rewarded ?: return false
        if (!ad.isReady) return false
        ad.showAd(activity)
        return true
    }
}
// APPOPS-INTEGRATION-END android-max-bridge
`;
}

function billingKotlin(products: VerifiedProduct[]): string {
  const catalog = products.map((item) => {
    const playType = item.productType === 'subs' ? 'SUBS' : 'INAPP';
    const finish = item.productType === 'subs' || item.productType === 'nonConsumable' ? 'ACK' : 'CONSUME';
    return `        ${JSON.stringify(item.productId)} to CatalogProduct(${JSON.stringify(playType)}, ${JSON.stringify(finish)}),`;
  }).join('\n');
  return `package appops.monetization

import android.app.Activity
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams

data class CatalogProduct(val playType: String, val finish: String)
fun interface VerificationRequired {
    fun onVerificationRequired(productId: String, purchaseToken: String, signedPayload: String)
}

// APPOPS-INTEGRATION-BEGIN android-billing-bridge
// Official: https://developer.android.com/google/play/billing/integrate (Billing Library 9.1.0)
// purchase() is launch-only, not entitlement. Consume INAPP/consumable; acknowledge SUBS/nonConsumable after server verification.
object AppOpsBilling {
    private val CATALOG: Map<String, CatalogProduct> = mapOf(
${catalog}
    )
    @Volatile private var client: BillingClient? = null
    @Volatile private var details: List<ProductDetails> = emptyList()
    private val tokenProducts = HashMap<String, String>()
    @Volatile var verificationRequired: VerificationRequired? = null

    @JvmStatic
    fun initialize(activity: Activity) {
        val billing = BillingClient.newBuilder(activity)
            .setListener { result, purchases -> handlePurchases(result, purchases) }
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build()
        client = billing
        billing.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    queryProducts()
                    restore()
                }
            }
            override fun onBillingServiceDisconnected() {}
        })
    }

    @JvmStatic
    fun queryProducts() {
        val billing = client ?: return
        queryByType(billing, BillingClient.ProductType.INAPP)
        queryByType(billing, BillingClient.ProductType.SUBS)
    }

    private fun queryByType(billing: BillingClient, type: String) {
        val products = CATALOG.filter { it.value.playType == type }.map { (id, _) ->
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(id)
                .setProductType(type)
                .build()
        }
        if (products.isEmpty()) return
        billing.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder().setProductList(products).build(),
        ) { billingResult, queryResult ->
            if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                details = details.filter { it.productType != type } + queryResult.productDetailsList
            }
        }
    }

    /** Launches Play purchase UI. Does not mean the user is entitled. */
    @JvmStatic
    fun purchase(activity: Activity, productId: String): Boolean {
        val billing = client ?: return false
        val product = details.find { it.productId == productId } ?: return false
        val offer = if (product.productType == BillingClient.ProductType.SUBS) {
            product.subscriptionOfferDetails?.firstOrNull()?.offerToken
        } else {
            product.oneTimePurchaseOfferDetailsList?.firstOrNull()?.offerToken
                ?: product.oneTimePurchaseOfferDetails?.offerToken
        } ?: return false
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(
                listOf(
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(product)
                        .setOfferToken(offer)
                        .build(),
                ),
            )
            .build()
        return billing.launchBillingFlow(activity, params).responseCode == BillingClient.BillingResponseCode.OK
    }

    @JvmStatic
    fun restore() {
        val billing = client ?: return
        billing.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build(),
        ) { result, purchases -> handlePurchases(result, purchases) }
        billing.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(),
        ) { result, purchases -> handlePurchases(result, purchases) }
    }

    @JvmStatic
    fun completeVerifiedPurchase(purchaseToken: String) {
        val billing = client ?: return
        val productId = tokenProducts[purchaseToken]
        val finish = productId?.let { CATALOG[it]?.finish } ?: "ACK"
        if (finish == "CONSUME") {
            billing.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(purchaseToken).build()) { _, _ -> }
        } else {
            billing.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchaseToken).build()) { }
        }
    }

    private fun handlePurchases(result: BillingResult, purchases: List<Purchase>?) {
        if (result.responseCode != BillingClient.BillingResponseCode.OK || purchases == null) return
        for (purchase in purchases) {
            if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) continue
            if (purchase.isAcknowledged) continue
            val productId = purchase.products.firstOrNull() ?: continue
            tokenProducts[purchase.purchaseToken] = productId
            verificationRequired?.onVerificationRequired(productId, purchase.purchaseToken, purchase.originalJson)
        }
    }
}
// APPOPS-INTEGRATION-END android-billing-bridge
`;
}
