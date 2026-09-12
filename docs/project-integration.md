# 프로젝트 SDK 통합 (광고·인앱 결제)

Last Updated: 2026-09-11 (SDK template correction)

v3의 AdMob/MAX 설정 안내는 식별자만 반환했다. v4는 지원 엔진의 **빌드 의존성**과 **호출 가능한 게임 코드**를 미리보기·적용·되돌리기한다. 원본 보존, 해시 충돌 검사, 재시작 저널을 포함한다. 게임 이벤트 미연결을 성공으로 숨기지 않는다.

패키지: `packages/project-integration/`. 루트 제어 서비스·UI가 HTTP로 연결한다. `packages/connectors/sdk-integration.ts`는 읽기 전용 설정 안내로 남는다.

## 공개 계약

```ts
previewIntegration(request): Promise<IntegrationPreview>
applyIntegration(request | { previewId, projectRoot }): Promise<IntegrationApplyResult>
rollbackIntegration(applyId, projectRoot): Promise<IntegrationRollbackResult>
detectProjectSdks(projectRoot): Promise<SdkDetection>
```

입력 `{ projectRoot, engine, platform, provider, appId, adUnits, products, options }`.

- `engine`: `android` | `ios` | `unity` | `godot` | `unreal`
- `platform`: `android` | `ios`
- `provider`: `admob` | `applovin-max` | `play-billing` | `app-store`
- `appId` / `adUnits` / `products`: **검증된 공개 리소스**에서 온 ID만. OAuth·API·SDK 키 금지.
- `options.maxSdkKeyBound`: **공개 클라이언트 SDK 키**를 스테이징 훅에 주입할 준비가 됐는지. 요청 본문·미리보기 파일에 키 원문을 받지 않는다. AppLovin Report Key·Management API 비밀과는 다른 값이며 게임 파일에 관리 비밀을 두지 않는다.
- `options.includePurchases`: 광고 공급자와 함께 Play Billing / StoreKit 2를 배선.

출력: `previewId` / `applyId`, 공식 카탈로그(아티팩트·버전·문서 URL), 파일 계획, `wiring`(installed vs event), before/after SHA-256, 백업 경로, findings.

루트 권장 HTTP (이 패키지는 라우트를 등록하지 않음):

| 요청 | 입력 | data |
|---|---|---|
| POST `/api/projects/:id/integration/preview` | 위 요청에서 projectRoot는 서버가 프로젝트 경로로 채움 | `IntegrationPreview` |
| POST `/api/projects/:id/integration/apply` | `{ previewId }` 또는 전체 요청 | `IntegrationApplyResult` |
| POST `/api/projects/:id/integration/rollback` | `{ applyId }` | `IntegrationRollbackResult` |

비밀 bearer는 기존 제어 서비스 계약을 따른다. 작업 이력에 SDK Key·OAuth를 넣지 않는다.

## 공식 버전 (2026-09-11 1차 문서)

| 대상 | 아티팩트 | 버전 | 근거 |
|---|---|---|---|
| AdMob Android | `com.google.android.gms:play-services-ads` | 25.4.0 | [Quick start](https://developers.google.com/admob/android/quick-start) |
| AdMob iOS | `Google-Mobile-Ads-SDK` | 13.9.0 | [Quick start](https://developers.google.com/admob/ios/quick-start), CocoaPods |
| MAX Android | `com.applovin:applovin-sdk` | 13.6.4 | [Integration](https://support.applovin.com/en/max/android/overview/integration), GitHub releases |
| MAX iOS | `AppLovinSDK` | 13.6.4 | GitHub `AppLovin-MAX-SDK-iOS` |
| Play Billing | `com.android.billingclient:billing` | 9.1.0 | [Integrate](https://developer.android.com/google/play/billing/integrate) |
| StoreKit 2 | `Product.purchase()` / `AppStore.sync()` | 2 | Apple StoreKit |
| Unity AdMob | `com.google.ads.mobile` | 11.5.0 | [Unity quick start](https://developers.google.com/admob/unity/quick-start) OpenUPM |
| Unity MAX | `com.applovin.mediation.ads` | 8.6.5 | AppLovin Unity plugin releases (Android/iOS SDK 13.6.4) |
| Unity IAP | `com.unity.purchasing` | 5.4.2 | Unity IAP 5.4 매뉴얼 |
| Godot AdMob | poingstudios/godot-admob-plugin | 5.0.0 | [Google other platforms](https://developers.google.com/admob/other-platforms) |
| Godot Play Billing | GodotGooglePlayBilling | 3.3.0 | [Godot Android IAP](https://docs.godotengine.org/en/stable/tutorials/platform/android_in_app_purchases.html) (Billing 9.1.0) |
| Unreal AdMob | AndroidAdvertising + OnlineSubsystemGooglePlay | UE first-party | [Epic AdMob](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-ad-mob-in-game-ads-on-android) |

이 호스트는 플러그인 zip·AAR·SDK 바이너리를 **다운로드하지 않는다**. Gradle/CocoaPods/UPM 좌표와 소스 브리지만 기록한다. 실제 해석은 사용자 빌드 환경에서 이루어진다.

## 런타임 브리지

광고: `initialize` → `show` → `reward`. 결제: `purchase` → `restore`.

- AdMob Android: `MobileAds.initialize`, `RewardedAd.load`, `OnUserEarnedRewardListener`. 보상 코드는 `adFormat=REWARD` 단위가 있을 때만 생성
- MAX Android: `AppLovinSdkInitializationConfiguration.builder`, `MaxRewardedAd.getInstance`, `onUserRewarded`. 공개 클라이언트 SDK 키는 `assets/appops/max_sdk_key` 훅. 관리/리포트 키 금지
- Play Billing 9.1.0: INAPP와 SUBS를 따로 `queryProductDetailsAsync`. `purchase()`는 결제 UI 실행 여부만. 검증 후 consumable/`inapp`은 `consumeAsync`, `subs`/`nonConsumable`은 `acknowledgePurchase`
- iOS AdMob: `MobileAds.shared.start`, `RewardedAd.load` / `present`. Podfile이 없으면 가짜 `App` 타깃을 만들지 않음. Swift 파일 참조는 실제 생성 경로 `AppOpsMonetization/*.swift` + `SOURCE_ROOT`이고 **유일한** `com.apple.product-type.application` Sources 페이즈에만 등록
- StoreKit 2: `Product.PurchaseResult`의 success/verified·unverified·userCancelled·pending을 구분. 앱 시작 시 `startTransactionListener()`로 `Transaction.updates`를 유지하고, purchase/restore/update는 verified 결과의 `jwsRepresentation`만 넘김. finish는 verified `Transaction.unfinished`와 일치하는 `completeVerifiedPurchase`만
- Unity: AdMob 11.5.0의 internal `GoogleMobileAdsSettings.LoadInstance()`를 외부 Assets assembly에서 호출하지 않는다. 공식 스크립트 GUID가 있는 기존 설정 자산의 직렬화 필드만 패치하며, 없으면 **Assets > Google Mobile Ads > Settings**에서 먼저 생성한다. MAX는 Unity Editor의 일회성 `APPOPS_MAX_SDK_KEY`를 공개 `AppLovinSettings.Instance.SdkKey`/`SaveAsync()`에 바인딩하고 빈 키를 설정 완료로 보지 않는다. IAP 5.4.2는 `TransactionID`로 pending을 식별하고 `OnPurchasesFetched`/`OnPurchasesFetchFailed` + `FetchPurchases()`로 복원 결과를 전달한다.
- Godot AdMob v5: `OnInitializationCompleteListener`, `RewardedAdLoadCallback`, `OnUserEarnedRewardListener`, `destroy()`. 앱 ID는 공식 Project Settings `admob/general/{android|ios}/enabled`와 `app_id`에 기록한다. Billing 3.3.0은 조회한 `subscription_offer_details`의 `base_plan_id`/`offer_id`, 구매의 `product_ids[0]`, fail-closed 카탈로그/토큰 매핑을 사용한다.
- Unreal: `FAdvertising::Get().GetDefaultProvider()` → `IAdvertisingProvider*`. Target.cs **생성자 안** ExtraModuleNames. 배너/전면만. `UAppOpsStore` 공개 Blueprint 헤더를 만들고 `AddPurchaseOffer(namespace, id, quantity, bIsConsumable)`를 호출하며, receipt offer/line item의 양수 quantity와 opaque `ValidationInfo`를 검증 콜백에 전달한 뒤에만 `FinalizePurchase`

구매는 공통으로 **fail-closed** 입니다. `VerificationRequired(productId, purchaseToken, signedPayload)` 콜백만 올리고, 호출자가 서버 검증 결과를 받은 뒤 `CompleteVerifiedPurchase`로 acknowledge/confirm/finish 합니다. Unreal은 receipt 매핑 보존을 위해 `VerificationRequired(ProductId, Quantity, PurchaseToken, ValidationInfo)` 네 인자를 쓰며 카탈로그 상품과 `1...1000` 수량만 허용합니다. 로컬 StoreKit 2 JWS는 기기 측 진위만 증명하며 중복·자격은 서버가 처리합니다. 루트가 영수증 HTTP를 구현합니다.

`wiring[].status`:

- `wired` — **게임 소유** 소스(생성 AppOps 브리지가 아님)가 주석이 아닌 코드에서 초기화·표시·보상·구매·복원 훅을 호출함
- `installed_unwired` — 공식 API 브리지/의존성은 설치됐지만 게임 훅이 없거나 플러그인 바이너리가 없음. 생성 파일 substring만으로 wired 하지 않음
- `missing` / `conflict` / `unsupported` — 완료로 표시하지 않음

## 트랜잭션

상태 디렉터리: `{project}/.appops/integration/` (심볼릭 링크 거부).

1. preview: 대상 파일 beforeHash, 계획, preview JSON
2. apply: exclusive `journal.lock` → 원본 백업 → 원자적 쓰기 → afterHash. 미리보기 이후 파일이 바뀌면 `apply.concurrent_edit`
3. 적용 중 실패: 백업에서 복구, `failed`
4. rollback: afterHash가 그대로일 때만 원본 복구. 이후 수동 편집이면 conflict
5. 재시작: journal `backing_up`/`applying` 이면 `recoverIncomplete`가 되돌림

경로 `..`, 절대 경로, 심볼릭 링크, 프로젝트 밖 realpath는 거부한다. 알 수 없는 Gradle/Podfile/plist/pbxproj/manifest 형식은 덮어쓰지 않고 finding을 반환한다. 기존 다른 SDK 버전은 conflict.

## 명시적 미지원

- 임의 엔진·커뮤니티 플러그인 자동 배선
- MAX 미디에이션 어댑터 전체 행렬
- Godot + AppLovin MAX (공식 Godot MAX 플러그인 없음)
- Godot iOS StoreKit 소스 드롭. 빌드된 `.a`/xcframework, 초기화/해제 등록, GDScript 싱글턴을 갖춘 실제 플러그인이 없으면 소스도 `.gdip`도 생성하지 않고 `scope.godot_ios_storekit_source_only` 오류로 남김
- Unreal + AppLovin MAX (공식 Unreal 플러그인 문서는 있으나 바이너리를 받지 않아 설치·런타임 미검증)
- Unreal 퍼스트파티 보상형 광고 (`IAdvertisingProvider`에 rewarded 없음)
- 호스트에서 프로젝트 스크립트·gradlew·pod install·엔진 에디터 실행
- 신뢰하지 않는 zip/AAR 다운로드, 엔진/스토어 샌드박스·실기기 광고·결제
- vault·관리 API·Report Key. MAX 공개 클라이언트 SDK 키만 스테이징 훅
- iOS: Podfile 없음, 애플리케이션 타깃이 하나가 아닌 pbxproj, 가짜 pbx 텍스트
- 보상형 템플릿에 배너/전면 ID 대체 (`id.reward_unit_required`)

데모용 최소 유효 pbxproj: `fixtures/minimal-ios.pbxproj` (`MINIMAL_IOS_PBXPROJ`). 실제 `XCBuildConfiguration`/`XCConfigurationList`와 타깃·프로젝트 설정 참조를 포함합니다. 루트 preview existingMap에 `*.xcodeproj/project.pbxproj` 와 `Source/**/*.Build.cs` 를 넣으면 자동 배선합니다.

이 패키지는 소스 생성·공식 API 부호 검사를 제공합니다. **엔진 런타임·스토어 샌드박스·네이티브 빌드 성공을 주장하지 않습니다.**

Godot AdMob/Play Billing 플러그인 바이너리가 없으면 브리지는 쓰되 `plugin.*_missing` + `installed_unwired`로 남긴다. Godot iOS StoreKit은 가짜 바이너리 선언을 만들지 않고 unsupported/conflict로 남긴다. 게임이 훅을 호출하고 실제 플러그인이 있어야 `wired`가 된다.

MAX 공개 클라이언트 SDK 키는 API 요청·미리보기·저널 파일에 넣지 않는다. Unity Editor를 시작하는 제한된 프로세스 환경에 `APPOPS_MAX_SDK_KEY`를 일회성으로 주입하고 import가 `AppLovinSettings.asset`에 저장된 것을 확인한 뒤 환경 값을 제거한다. `options.maxSdkKeyBound=true`만으로는 설정 완료가 아니며, 관리 API/Report Key는 이 경로에 절대 사용하지 않는다.

Android 매니페스트의 self-closing `<application .../>` 은 메타데이터를 넣기 전에 열어 패치한다. 모듈 `app/build.gradle` 과 `app/build.gradle.kts` 를 모두 지원한다.

## 검증

템플릿 집중 검사는 `node --import tsx --test tests/project-integration-template.test.ts tests/project-integration-template-compile.test.ts`이다. 공식 Unity IAP 5.4.2/MAX 8.6.5 소스 계약, Billing 9.1.0 `javac`, 다운로드된 Godot 4.3의 headless GDScript import, Unreal 공개 헤더/receipt 계약의 로컬 `g++`, PBX 객체/설정 참조를 확인한다. 이 Linux 호스트에는 Unity/Unreal toolchain과 Swift/Xcode가 없으므로 Unity/UE 엔진 빌드나 `xcodebuild` 성공을 주장하지 않으며, Godot 모바일 플러그인 바이너리/export와 실기기 광고·스토어 결제도 별도 수용 조건이다.
