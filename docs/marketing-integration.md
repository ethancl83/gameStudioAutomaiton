# 마케팅·수익화 연동 (Google Ads · AppLovin Ads · MAX · AdMob)

Last Updated: 2026-09-11 (T-12.3 마케팅 확장)

이 문서는 `packages/connectors/google-ads.ts`, `applovin-ads.ts`, `applovin-max.ts`, `admob.ts`의 공식 근거와 구현 범위다. 실계정 호출·광고 지출은 수행하지 않았다. 검증은 주입된 `ConnectorContext.request` 모의 응답뿐이다.

네 커넥터는 `packages/connectors/index.ts`에 등록되어 실제 UI/제어 서비스에서 사용된다. 작업별 필드는 `capability.operationFields`를 화면이 소비한다. 모든 외부 쓰기는 프로젝트 정책과 동기화된 대상 소유권을 검사한다.

## 구현한 작업

| 공급자 | operations | 인증 | 쓰기 |
|---|---|---|---|
| google-ads | check, sync, list-campaigns, create-campaign, create-creative, update-campaign, pause-campaign | OAuth/서비스 계정 `https://www.googleapis.com/auth/adwords`. Cloud 프로젝트 접근 수준. **developerToken 필드·헤더 없음** | `googleAds:mutate` `write:true` (예산·캠페인·광고그룹·AppAd) |
| applovin-ads | check, sync, list-campaigns, create-campaign, update-campaign, pause-campaign | `Authorization: <Campaign Management API key>` (Bearer 아님) + `account_id` 쿼리. Report Key는 별도 | create는 `activation=LIVE` 명시 시에만. update는 LIVE/PAUSED |
| applovin-max | check, sync, list-ad-units, create-ad-unit, update-ad-unit, sdk-integration-config | `Api-Key: <Management Key>`. Report Key 별도. SDK Key는 대시보드(선택 저장) | `POST /mediation/v1/ad_unit`. sdk-integration-config는 읽기 |
| admob | check, sync, list-apps, list-ad-units, sdk-integration-config | OAuth `admob.readonly` | **광고 단위 쓰기 없음**. sdk-integration-config는 읽기 |

미지원 작업은 `UNSUPPORTED_OPERATION`으로 실패한다. 가짜 성공 경로 없음.

## 공식 문서 (2026-09-11 확인)

| 주제 | URL |
|---|---|
| Google Ads developer token 종료 (2026-09-09) | https://developers.google.com/google-ads/api/docs/api-policy/developer-token |
| Google Ads API v25 mutate | https://developers.google.com/google-ads/api/rest/common/mutate |
| Google Ads App campaign | https://developers.google.com/google-ads/api/docs/app-campaigns/create-campaign |
| Google Ads App ad group & AppAd | https://developers.google.com/google-ads/api/docs/app-campaigns/create-ad-group |
| Google Ads Add app campaign sample | https://developers.google.com/google-ads/api/docs/samples/add-app-campaign |
| App campaign asset types | https://support.google.com/google-ads/answer/9948381 |
| ACE asset minimums | https://support.google.com/google-ads/answer/9234183 |
| AdMob Android SDK App ID (`APPLICATION_ID`) | https://developers.google.com/admob/android/quick-start |
| AdMob iOS SDK App ID (`GADApplicationIdentifier`) | https://developers.google.com/admob/ios/quick-start |
| MAX Android SDK initializer | https://support.applovin.com/en/max/android/overview/integration |
| MAX iOS SDK initializer | https://support.applovin.com/en/max/ios/overview/integration |
| MAX Android manual `applovin.sdk.key` (Android only) | https://support.applovin.com/en/max/android/overview/manual-integration |
| Google Ads GoogleAdsService.Mutate | https://developers.google.com/google-ads/api/reference/rpc/v25/GoogleAdsService/Mutate |
| Cloud Ads API Overview | https://console.cloud.google.com/google/ads-apis/overview |
| AppLovin Campaign Management | https://support.applovin.com/en/growth/promoting-your-apps/api/axon-campaign-management-api |
| AppLovin Advertiser Reporting | https://support.applovin.com/en/growth/promoting-your-apps/api/reporting-api |
| MAX Ad Unit Management | https://support.applovin.com/en/max/advanced-features/ad-unit-management-api |
| MAX Revenue Reporting | https://support.applovin.com/en/max/reporting-apis/revenue-reporting-api |
| AdMob reports / inventory | https://developers.google.com/admob/api/v1/reporting |
| AdMob REST | https://developers.google.com/admob/api/reference/rest |

## 현재 모델

### Google Ads v25 REST

- 호스트: `https://googleads.googleapis.com/v25`
- 조회: `POST /customers/{id}/googleAds:search`
- 원자 쓰기: `POST /customers/{id}/googleAds:mutate` (`campaignBudgetOperation` + `campaignOperation`, 임시 리소스 `campaignBudgets/-1`, `campaigns/-2`)
- App 캠페인: `advertisingChannelType=MULTI_CHANNEL`, `advertisingChannelSubType=APP_CAMPAIGN`, `explicitlyShared=false`, `status=PAUSED`
- 설치 목표: `OPTIMIZE_INSTALLS_TARGET_INSTALL_COST` + `targetCpa.targetCpaMicros` (없으면 생성 거부)
- 헤더: `Authorization: Bearer`. `developer-token` 미전송. 선택 `login-customer-id`
- 예산 변경: `campaign_budget.explicitly_shared` 가 true이거나 다른 캠페인이 같은 예산을 쓰면 `SHARED_BUDGET`
- 헤드라인 2–5개(30자)·설명 1–5개(90자) JSON 배열이 있으면 같은 mutate에 광고그룹(type 미지정, 공식 샘플)과 AppAd를 포함. 이미지 바이너리 업로드 없음(기존 `customers/{id}/assets/{id}` 또는 YouTube 11자 ID)
- `create-creative`는 기존 캠페인에 AppAd를 추가
- ENABLED는 해당 캠페인에 헤드라인 2개·설명 1개 이상의 AppAd가 확인된 뒤에만 허용 (`CREATIVE_REQUIRED` 아니면 거부)
- `containsEuPoliticalAdvertising=DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING` (공식 Add app campaign 샘플)
- 지출: `metrics.cost_micros`, 계정 `currency_code` / `time_zone`

### AppLovin Ads (Axon)

- `GET/POST https://api.ads.axon.ai/manage/v1/campaign/list|create|update?account_id=`
- 공식 create는 `status`를 무시한다(Campaign object Create 열 = Ignored). PAUSED 초안을 가장하지 않는다. 사용자가 `activation=LIVE`를 명시한 생성만 허용하며 생성 직후 pause를 자동 호출하지 않는다. 실제 상태는 재조회 값이다.
- 필수 생성 필드: name, type=APP, platform, package_name, start_date, targeting, budget, goal, bidding_strategy, tracking(impression_url/click_url/tracking_method). iOS는 itunes_id.
- 기존 캠페인 update는 `LIVE`/`PAUSED`를 공식 계약대로 변경한다.
- 예산은 USD 십진 문자열 (`daily_budget_for_all_countries`). UI micros ÷ 1,000,000
- 변경은 기존 캠페인만 대상으로 하고 재조회해 이름·상태·예산·앱 정보를 보존한다. 생성에 필요한 추적·입찰 정보는 현재 제공하지 않는 생성 작업의 입력으로 노출하지 않는다.
- 보고: `GET https://r.applovin.com/report?report_type=advertiser&columns=day,cost,campaign_id_external` UTC, 45일 창

### MAX

- 목록 `GET https://o.applovin.com/mediation/v1/ad_units`
- 생성 `POST https://o.applovin.com/mediation/v1/ad_unit` `{name,platform,package_name,ad_format}`
- 수정 `POST https://o.applovin.com/mediation/v1/ad_unit/{id}`
- 수익 `GET https://r.applovin.com/maxReport` `estimated_revenue` USD 추정, UTC
- `sdk-integration-config`(읽기): 광고 단위 ID·패키지와 `sdkKeyConfigured`만 반환. 저장된 SDK Key 바이트는 vault에 남기고 요약·매니페스트·작업 이력에 넣지 않음. Android는 `AppLovinSdkInitializationConfiguration.builder("«SDK-key»")`, iOS는 `ALSdkInitializationConfiguration` `configurationWithSdkKey:`. AndroidManifest `applovin.sdk.key`는 Android 수동 연동 안내(placeholder)뿐이며 iOS에 쓰지 않음. Management API는 SDK Key를 반환하지 않음(대시보드 Account > General > Keys). SDK 코드를 설치하지 않음

### AdMob v1

- `GET /v1/accounts/{pub}` → `currencyCode`, `reportingTimeZone`
- `GET .../apps`, `GET .../adUnits`
- `accounts.apps.list`의 공식 `appApprovalState`를 보존. `ACTION_REQUIRED`·`IN_REVIEW`는 `ACTIVE`로 매핑하지 않음. `APPROVED`만 `ACTIVE`
- `POST .../networkReport:generate` `ESTIMATED_EARNINGS.microsValue`, DATE
- create/update ad unit은 v1에 없어 capability.operations에 없음
- `sdk-integration-config`(읽기): AdMob App ID·광고 단위 ID와 플랫폼별 설정 키를 반환. Android는 AndroidManifest `com.google.android.gms.ads.APPLICATION_ID`, iOS는 Info.plist `GADApplicationIdentifier`. SDK 코드를 설치하지 않음
- IAP 상품 ID는 Play/App Store `list-products`. AdMob/MAX는 IAP를 만들지 않음

## 화면 작업 계약

Google Ads 생성에는 이름·일일 예산·통화·목표 CPA가 필요하다. 헤드라인/설명 textarea는 JSON 배열이며 제네릭 폼이 아니라 커넥터가 파싱한다. 국가 입력은 하나 또는 여러 ISO-2 국가이며 각 국가의 위치 조건을 원자 mutate에 포함한다. ENABLED는 AppAd 확인 후에만 허용한다.

MAX 생성은 BANNER/INTER/REWARD/MREC와 앱·플랫폼을 제공한다. NATIVE는 필수 template_size를 지원하기 전까지 제외했다. 광고 단위 변경은 이름을 요구한다. status/disabled는 read-only이므로 활성·중지를 성공으로 반환하지 않는다.

AppLovin Ads 생성은 `activation=LIVE`와 공식 필수 필드(MMP URL, 목표, 입찰, 국가, 시작일)가 필요하다. AdMob 광고 단위 쓰기는 capability에 없다. SDK 준비는 `sdk-integration-config` 읽기만 제공한다.

## 지표 규칙

- 금액은 마이크로 **정수 문자열**. 원천 십진수는 `decimalToMicros`
- Google Ads 지출 `kind=spend`, AppLovin Ads `cost`→spend, MAX `estimated_revenue`→revenue, AdMob `ESTIMATED_EARNINGS`→revenue, 모두 `basis=estimated`
- Google Ads는 같은 앱·날짜의 모든 캠페인 지출을 BigInt로 합산한 뒤 저장한다. 같은 sourceId의 다른 캠페인이 덮어써지지 않는다.
- AdMob의 SDK 앱 ID는 sourceId/리소스 메타데이터에 보존한다. linkedAppInfo에서 확인한 Android 패키지만 appIdentifier에 넣어 프로젝트와 MAX의 같은 앱을 매칭한다. iOS 숫자 store ID/미연결 앱은 bundle ID로 간주하지 않으며 미귀속으로 남긴다.
- **MAX 미디에이션 추정 수익과 AdMob 네트워크 수익을 더하지 말 것.** MAX 보고에 network 열을 넣지 않았고 AdMob은 네트워크 보고만 수집한다.
- Google Ads `googleAds:search`와 AdMob `networkReport:generate`는 읽기 POST이므로 `write:false`다. 변이는 `write:true`.
- 미귀속 매출로 ROAS를 계산하지 않음

## 검증

주입 컨텍스트 테스트 `tests/marketing-connectors.test.ts`, 확장 `tests/marketing-social-extensions.test.ts` (실계정·실지출 없음).

## root에 필요한 조회 작업·추가 검사

`packages/connectors/types.ts` `isWriteOperation`에 아래 **읽기** 이름을 추가해야 한다. 추가하지 않으면 프로젝트 정책·idempotency가 조회에 걸린다.

- `sdk-integration-config` (admob, applovin-max)

추가 보안 검사(이미 커넥터에서 강제, root는 정책만 유지):

- 캠페인 쓰기는 기존 `allowCampaignWrites`·예산 한도. `create-creative` 이름에 `campaign`이 없어 root가 `enforcePolicy`에 이 작업을 캠페인 쓰기로 넣어야 한다.
- JSON textarea는 화면이 파싱하지 않는다. 커넥터가 명시 필드만 `JSON.parse` 한다.
- 사용자 스크립트 실행·로컬 파일 SDK 설치·실계정 자격 증명 사용 없음.

## 남은 실제 검증

실제 계정 OAuth·AppLovin 접근 허용·API 최소 예산·캠페인/광고 단위 변경·게임 SDK 실행은 미수행이다. 테스트에 실계정이나 지출은 사용하지 않았다. [연동 기능표](integration-capabilities.md), [지표 정의](metric-definitions.md), [검증 기록](verification.md)을 함께 따른다.

### 프로젝트와 광고 앱의 귀속 (v3 통합)

캠페인·광고 단위 생성의 packageName/appId는 선택한 프로젝트 식별자와 대조하고 다른 프로젝트의 패키지를 덮어쓸 수 없다. Google Ads 소재 생성은 같은 연결·프로젝트에 동기화된 캠페인만 받는다. iOS 숫자 iTunes ID를 쓰는 Google Ads/AppLovin Ads 작업은 연결된 Apple 계정에서 프로젝트 bundle ID에 해당하는 Apple 앱 ID를 확인하고 대조한다. 확인된 공개 식별자 매핑만 저장하며, 다른 숫자 ID나 Apple 연결 부재는 외부 변경 전에 실패한다. Google Ads 지표·캠페인은 이 검증된 매핑으로 프로젝트에 귀속하고 예산 계산에 반영한다. 전송 직전 프로젝트 식별자가 바뀌어도 변경을 중단한다.
