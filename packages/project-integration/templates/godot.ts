import { CATALOG, marker } from '../catalog.js';
import { rewardedUnit } from '../ids.js';
import type { IntegrationFinding, PlannedFileChange, SdkCatalogEntry, TemplateContext, TemplatePlan } from '../types.js';

export function planGodot(ctx: TemplateContext, existing: Map<string, string | null>): TemplatePlan {
  const findings: IntegrationFinding[] = [];
  const changes: PlannedFileChange[] = [];
  const catalog: SdkCatalogEntry[] = [];
  const ads = ctx.provider === 'admob' || ctx.provider === 'applovin-max';
  const iap = ctx.products.length > 0 || ctx.provider === 'play-billing' || ctx.provider === 'app-store';

  if (existing.get('project.godot') == null) {
    findings.push({
      code: 'detect.not_godot',
      severity: 'error',
      message: 'project.godot 가 없습니다.',
      fixHint: 'Godot 프로젝트 루트를 선택하세요.',
    });
    return { supported: false, catalog, changes, findings };
  }

  if (ctx.provider === 'applovin-max') {
    findings.push({
      code: 'scope.godot_max_unsupported',
      severity: 'error',
      message: 'Godot용 공식 MAX 플러그인은 없습니다. 임의 서드파티 배선은 하지 않습니다.',
      fixHint: 'AdMob(poingstudios, Google other-platforms 목록) 또는 네이티브 모듈을 사용하세요.',
    });
    return { supported: false, catalog, changes, findings };
  }

  const originalProject = existing.get('project.godot') ?? '';
  let project = originalProject;
  const pluginMark = marker('godot-plugins', 'semi');

  if (ads) {
    catalog.push(CATALOG.godotAdmob);
    if (existing.get('addons/admob/plugin.cfg') == null) {
      findings.push({
        code: 'plugin.godot_admob_missing',
        severity: 'warning',
        message: 'Poing Studios AdMob 플러그인 바이너리가 없습니다. 이 도구는 플러그인 zip을 다운로드하지 않습니다.',
        path: 'addons/admob/plugin.cfg',
        fixHint: `Godot AssetLib에서 AdMob (poing.studios) ${CATALOG.godotAdmob.version}을 설치하세요. Google 안내: ${CATALOG.godotAdmob.source}`,
      });
    }
  }
  if (iap && ctx.platform === 'android') {
    catalog.push(CATALOG.godotPlayBilling);
    if (existing.get('addons/GodotGooglePlayBilling/plugin.cfg') == null) {
      findings.push({
        code: 'plugin.godot_play_billing_missing',
        severity: 'warning',
        message: '공식 GodotGooglePlayBilling 플러그인이 없습니다. zip을 다운로드하지 않습니다.',
        path: 'addons/GodotGooglePlayBilling/plugin.cfg',
        fixHint: `릴리스 ${CATALOG.godotPlayBilling.version}을 에디터/AssetLib으로 설치하세요. ${CATALOG.godotPlayBilling.documentation}`,
      });
    }
  }
  if (iap && ctx.platform === 'ios') catalog.push(CATALOG.storeKit2);

  if (!project.includes('[editor_plugins]') || !project.includes(pluginMark.begin)) {
    const enabled: string[] = [];
    if (ads) enabled.push('"res://addons/admob/plugin.cfg"');
    if (iap && ctx.platform === 'android') enabled.push('"res://addons/GodotGooglePlayBilling/plugin.cfg"');
    if (enabled.length) {
      const block = `\n${pluginMark.begin}\n[editor_plugins]\nenabled=PackedStringArray(${enabled.join(', ')})\n${pluginMark.end}\n`;
      if (project.includes(pluginMark.begin)) {
        /* keep */
      } else {
        project = `${project.trimEnd()}\n${block}`;
      }
    }
  }

  if (ads) {
    if (!rewardedUnit(ctx.adUnits)) {
      findings.push({
        code: 'id.reward_unit_required',
        severity: 'error',
        message: 'Godot 보상형 브리지에는 adFormat=REWARD 단위가 필요합니다.',
      });
    } else {
      changes.push(godotAds(ctx));
    }
  }
  if (iap && ctx.platform === 'android') changes.push(godotBilling(ctx));
  if (iap && ctx.platform === 'ios') {
    findings.push({
      code: 'scope.godot_ios_storekit_source_only',
      severity: 'error',
      message: 'StoreKit 2 Swift 소스만으로는 Godot iOS 싱글턴이 되지 않습니다. 빌드된 정적 라이브러리/xcframework와 초기화 등록이 없어 설치 또는 배선 완료로 표시하지 않습니다.',
      fixHint: 'Godot iOS 플러그인 요구사항을 충족하는 실제 StoreKit 2 플러그인을 설치하고 내보내기에서 싱글턴을 확인하세요.',
    });
  }

  if (ctx.appId && ads) {
    project = setGodotSetting(project, 'admob', `general/${ctx.platform}/enabled`, 'true');
    project = setGodotSetting(project, 'admob', `general/${ctx.platform}/app_id`, JSON.stringify(ctx.appId));
  }
  if (project !== originalProject) {
    changes.push({
      path: 'project.godot',
      action: 'patch',
      reason: '공식 플러그인 활성화와 AdMob v5 Project Settings enabled/app_id를 적용합니다.',
      content: project.endsWith('\n') ? project : `${project}\n`,
    });
  }

  const pluginMissing = findings.some((item) => item.code.startsWith('plugin.') && item.severity === 'error');
  return { supported: !pluginMissing && findings.every((item) => item.severity !== 'error'), catalog, changes, findings };
}

function setGodotSetting(source: string, section: string, key: string, value: string): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const header = `[${section}]`;
  let sectionStart = lines.findIndex((line) => line.trim() === header);
  if (sectionStart < 0) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push('', header, '', `${key}=${value}`, '');
    return lines.join('\n');
  }
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  const setting = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    if (setting.test(lines[i])) {
      lines[i] = `${key}=${value}`;
      return lines.join('\n');
    }
  }
  lines.splice(sectionEnd, 0, `${key}=${value}`);
  return lines.join('\n');
}

function godotAds(ctx: TemplateContext): PlannedFileChange {
  const unit = rewardedUnit(ctx.adUnits)!.adUnitId;
  return {
    path: 'addons/appops_monetization/app_ops_ads.gd',
    action: 'create',
    reason: 'Poing AdMob v5 MobileAds.initialize completion, RewardedAdLoadCallback, OnUserEarnedRewardListener, destroy',
    content: `extends Node
class_name AppOpsAds

# APPOPS-INTEGRATION-BEGIN godot-admob-bridge
# Official: https://poingstudios.github.io/godot-admob-plugin/latest/ad_formats/rewarded/
const APP_ID := ${JSON.stringify(ctx.appId ?? '')}
const REWARDED_AD_UNIT_ID := ${JSON.stringify(unit)}
signal initialization_complete
signal user_earned_reward(amount: int, type: String)
var _rewarded: RewardedAd
var _initialized := false
var _on_user_earned_reward_listener := OnUserEarnedRewardListener.new()

func initialize() -> void:
    if not ClassDB.class_exists("MobileAds"):
        push_error("AdMob plugin missing: install poing.studios AdMob from AssetLib. Zip was not downloaded by AppOps.")
        return
    var listener := OnInitializationCompleteListener.new()
    listener.on_initialization_complete = func(_status: InitializationStatus) -> void:
        _initialized = true
        initialization_complete.emit()
    MobileAds.initialize(listener)
    _on_user_earned_reward_listener.on_user_earned_reward = func(item: RewardedItem) -> void:
        user_earned_reward.emit(item.amount, item.type)

func load_rewarded() -> void:
    if not _initialized:
        push_error("MobileAds.initialize has not completed")
        return
    if not ClassDB.class_exists("RewardedAdLoader"):
        push_error("RewardedAdLoader missing")
        return
    if _rewarded:
        _rewarded.destroy()
        _rewarded = null
    var callback := RewardedAdLoadCallback.new()
    callback.on_ad_failed_to_load = func(ad_error: LoadAdError) -> void:
        push_error(ad_error.message)
        _rewarded = null
    callback.on_ad_loaded = func(ad: RewardedAd) -> void:
        _rewarded = ad
        var full := FullScreenContentCallback.new()
        full.on_ad_dismissed_full_screen_content = func() -> void:
            load_rewarded()
        _rewarded.full_screen_content_callback = full
    RewardedAdLoader.new().load(REWARDED_AD_UNIT_ID, AdRequest.new(), callback)

func show_rewarded() -> bool:
    if _rewarded == null:
        return false
    _rewarded.show(_on_user_earned_reward_listener)
    return true
# APPOPS-INTEGRATION-END godot-admob-bridge
`,
  };
}

function godotBilling(ctx: TemplateContext): PlannedFileChange {
  const inapp = ctx.products.filter((item) => item.productType !== 'subs').map((item) => `"${item.productId}"`);
  const subs = ctx.products.filter((item) => item.productType === 'subs').map((item) => `"${item.productId}"`);
  const finish = ctx.products.map((item) => {
    const mode = item.productType === 'subs' || item.productType === 'nonConsumable' ? 'ack' : 'consume';
    return `    ${JSON.stringify(item.productId)}: ${JSON.stringify(mode)},`;
  }).join('\n');
  return {
    path: 'addons/appops_monetization/app_ops_billing.gd',
    action: 'create',
    reason: '공식 GodotGooglePlayBilling BillingClient.gd: INAPP/SUBS, on_purchase_updated, consume vs acknowledge after verify',
    content: `extends Node
class_name AppOpsBilling

# APPOPS-INTEGRATION-BEGIN godot-play-billing-bridge
# Official source: https://github.com/godot-sdk-integrations/godot-google-play-billing/blob/3.3.0/godot-google-play-billing/export_scripts/BillingClient.gd
const INAPP_IDS := [${inapp.join(', ')}]
const SUBS_IDS := [${subs.join(', ')}]
const FINISH := {
${finish}
}
signal verification_required(product_id: String, purchase_token: String, signed_payload: String)
var billing_client
var _token_products := {}
var _subscription_offers := {}

func initialize() -> void:
    if not ClassDB.class_exists("BillingClient"):
        push_error("GodotGooglePlayBilling plugin missing. Install 3.3.0 from official releases. AppOps does not download plugin zips.")
        return
    billing_client = BillingClient.new()
    billing_client.connected.connect(_on_connected)
    billing_client.query_product_details_response.connect(_on_products)
    billing_client.query_purchases_response.connect(_on_purchases)
    billing_client.on_purchase_updated.connect(_on_purchases)
    billing_client.start_connection()

func _on_connected() -> void:
    if INAPP_IDS.size() > 0:
        billing_client.query_product_details(PackedStringArray(INAPP_IDS), BillingClient.ProductType.INAPP)
    if SUBS_IDS.size() > 0:
        billing_client.query_product_details(PackedStringArray(SUBS_IDS), BillingClient.ProductType.SUBS)

func _on_products(response: Dictionary) -> void:
    if int(response.get("response_code", BillingClient.BillingResponseCode.ERROR)) != BillingClient.BillingResponseCode.OK:
        push_error("Product details query failed: %s" % str(response.get("debug_message", "unknown error")))
        return
    for details in response.get("product_details", []):
        if typeof(details) != TYPE_DICTIONARY:
            continue
        var product_id := str(details.get("product_id", ""))
        if not SUBS_IDS.has(product_id):
            continue
        var offers: Array = details.get("subscription_offer_details", [])
        var selected: Dictionary = {}
        for offer in offers:
            if typeof(offer) == TYPE_DICTIONARY and offer.get("offer_id") == null:
                selected = offer
                break
        if selected.is_empty() and not offers.is_empty() and typeof(offers[0]) == TYPE_DICTIONARY:
            selected = offers[0]
        var base_plan_id := str(selected.get("base_plan_id", ""))
        if base_plan_id == "":
            push_error("No subscription base plan returned for catalog product: %s" % product_id)
            continue
        var raw_offer_id = selected.get("offer_id")
        _subscription_offers[product_id] = {
            "base_plan_id": base_plan_id,
            "offer_id": "" if raw_offer_id == null else str(raw_offer_id),
        }

func purchase(product_id: String, base_plan_id: String = "", offer_id: String = "") -> Dictionary:
    if billing_client == null:
        return {}
    if not FINISH.has(product_id):
        push_error("Unknown AppOps catalog product: %s" % product_id)
        return { "response_code": BillingClient.BillingResponseCode.DEVELOPER_ERROR, "debug_message": "Unknown AppOps catalog product" }
    if SUBS_IDS.has(product_id):
        var selected: Dictionary = _subscription_offers.get(product_id, {})
        var resolved_base_plan := base_plan_id if base_plan_id != "" else str(selected.get("base_plan_id", ""))
        var resolved_offer := offer_id if offer_id != "" else str(selected.get("offer_id", ""))
        if resolved_base_plan == "":
            push_error("Subscription details are missing; wait for query_product_details_response before purchase")
            return { "response_code": BillingClient.BillingResponseCode.DEVELOPER_ERROR, "debug_message": "Subscription base plan unavailable" }
        return billing_client.purchase_subscription(product_id, resolved_base_plan, resolved_offer)
    return billing_client.purchase(product_id)

func restore() -> void:
    billing_client.query_purchases(BillingClient.ProductType.INAPP)
    billing_client.query_purchases(BillingClient.ProductType.SUBS)

func complete_verified_purchase(purchase_token: String) -> void:
    if billing_client == null:
        return
    var product_id: String = str(_token_products.get(purchase_token, ""))
    if product_id == "" or not FINISH.has(product_id):
        push_error("Unknown purchase token; refusing consume/acknowledge")
        return
    if FINISH[product_id] == "consume":
        billing_client.consume_purchase(purchase_token)
    else:
        billing_client.acknowledge_purchase(purchase_token)

func _on_purchases(response: Dictionary) -> void:
    var purchases = response.get("purchases", [])
    for purchase in purchases:
        if typeof(purchase) != TYPE_DICTIONARY:
            continue
        if int(purchase.get("purchase_state", 1)) != BillingClient.PurchaseState.PURCHASED:
            continue
        if purchase.get("is_acknowledged", false):
            continue
        var product_ids: Array = purchase.get("product_ids", [])
        if product_ids.is_empty():
            push_error("Purchase payload has no product_ids")
            continue
        var product_id := str(product_ids[0])
        if not FINISH.has(product_id):
            push_error("Purchase product is not in the AppOps catalog: %s" % product_id)
            continue
        var token := str(purchase.get("purchase_token", ""))
        if token == "":
            push_error("Purchase payload has no purchase_token")
            continue
        _token_products[token] = product_id
        verification_required.emit(product_id, token, str(purchase.get("original_json", "")))
# APPOPS-INTEGRATION-END godot-play-billing-bridge
`,
  };
}
