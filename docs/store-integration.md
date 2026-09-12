# Google Play · App Store · Steam 스토어 연동

Last Updated: 2026-09-11 (공식 문서 조사 기준일 동일)
담당 모듈: `packages/connectors/google-play.ts`, `packages/connectors/app-store.ts`, `packages/connectors/steam.ts`, `packages/connectors/store-play-edits.ts`, `packages/connectors/store-apple-ops.ts`, `packages/connectors/store-steam-ops.ts`, `packages/connectors/store-jsonapi.ts`, `packages/connectors/store-tools.ts`
계약 원본: [구현 계약](implementation-contract.md) — `Connector { capability, execute }`, 전송·멱등성·정책 검사는 controller/transport가 소유한다.

## 공통 원칙

- 모든 HTTP는 `context.request`를 거치며 transport의 공식 origin 허용 목록을 따른다. Apple 바이너리 업로드의 PUT 대상은 Apple JSON 응답 `uploadOperations[].url`에 나온 정확한 URL만 transport가 작업 단위로 허용한다(코디네이터 합의, 2026-09-11).
- 외부 쓰기는 `write: true`로 표시되어 transport가 dispatch를 기록하고, CLI 외부 효과는 spawn 전에 `context.markDispatched()`를 직접 호출한다. 단계별 외부 ID는 `context.checkpoint`로 남긴다.
- 지원하지 않는 작업·형식은 명시적인 `UNSUPPORTED_OPERATION`/`MISSING_REQUIREMENT` 오류로 반환하며 가짜 성공을 만들지 않는다. `capability.operations`에는 실제 구현된 작업만 나열한다.
- 오류·progress·summary에는 비밀(키·토큰·세션)을 넣지 않는다. Steam CLI 로그는 `redact`로 정리 후 노출한다.

## Google Play (`googlePlayConnector`)

인증: 연결의 서비스 계정 JSON 또는 OAuth 갱신 토큰으로 `context.accessToken(['https://www.googleapis.com/auth/androidpublisher'])`. 패키지 이름은 프로젝트 `appIdentifier` 또는 연결 `packageName`.

| operation | 실제 엔드포인트 | 비고 |
|---|---|---|
| check | `GET .../applications/{pkg}/oneTimeProducts?pageSize=1` | 패키지·권한 확인 |
| list-releases | `GET .../applications/{pkg}/tracks/{track}/releases` | Publishing API `ReleaseSummary` |
| upload-build | edits.insert → bundles/apks media upload → tracks PUT `completed` → validate → commit | 검증된 `.aab`/`.apk` artifact |
| list-listings | edits.insert → `GET .../edits/{id}/listings` → images.list(icon/featureGraphic/phoneScreenshots) → edits.delete | 라이브 반영 없음. 진행 중 편집이 있으면 ACTION_REQUIRED |
| update-listing | edits.insert → `PUT .../edits/{id}/listings/{language}` → validate → commit | Listing: language/title/fullDescription/shortDescription/video |
| upload-listing-image | edits.insert → `POST /upload/.../listings/{language}/{imageType}?uploadType=media` → validate → commit | 공식 imageType enum. 화면의 파일 선택→검증된 프로젝트 미디어 연결 |
| promote-release | edits.insert → tracks.get → `PUT .../edits/{id}/tracks/{track}` → validate → commit | status `draft\|inProgress\|halted\|completed`, userFraction은 (0,1)이며 inProgress/halted만 |
| create-app | `GET .../oneTimeProducts`만 조회 | 공개 API에 앱 생성 메서드 없음. 없으면 `unresolved` + Play Console |

공식 근거 (2026-09-11, androidpublisher v3 discovery revision 20260910 + [Edits](https://developers.google.com/android-publisher/edits) + [Tracks](https://developers.google.com/android-publisher/tracks)):
- Listing `{ language, title, fullDescription, shortDescription, video }`. Image `{ id, url, sha1, sha256 }`. imageType `phoneScreenshots|sevenInchScreenshots|tenInchScreenshots|tvScreenshots|wearScreenshots|icon|featureGraphic|tvBanner`.
- TrackRelease.status `draft|inProgress|halted|completed`, userFraction `0 < fraction < 1` only when inProgress/halted. 단계적 출시 예: `{ versionCodes:["99"], userFraction:0.05, status:"inProgress" }`.
- 신규 앱 생성 메서드는 discovery의 `applications` 리소스에 없다(`dataSafety`만). Play Console 선행 작업.

## App Store Connect (`appStoreConnector`)

인증: 연결의 API 키(keyId/issuerId/privateKey)로 `context.accessToken()`이 ES256 JWT를 발급한다(`packages/credentials`). 서명 인증서(배포 서명)는 별개이며 이 커넥터는 다루지 않는다.

| operation | 실제 엔드포인트 | 비고 |
|---|---|---|
| check | `GET /v1/apps?limit=1` | 키 유효성 확인. vendorNumber 미설정 시 안내 |
| list-apps | `GET /v1/apps` | id/name/bundleId/sku |
| list-releases | `GET /v1/apps/{id}/appStoreVersions`, `GET /v1/builds?filter[app]=` | 스토어 버전은 resources(release), 최근 빌드는 summary |
| list-products | `GET /v1/apps/{id}/inAppPurchasesV2` | resources(product) |
| upload-build | `POST /v1/buildUploads` → `POST /v1/buildUploadFiles` → 부분 PUT → `PATCH /v1/buildUploadFiles/{id}` (`uploaded:true`, `sourceFileChecksums.file{hash,algorithm:SHA_256}`=검증된 artifact sha256) → `GET /v1/buildUploads/{id}` | Build Upload API. Mac/Transporter 불필요 |
| reconcile | `GET /v1/buildUploads/{externalId}` 또는 `GET /v1/reviewSubmissions/{id}?include=app` (`reviewSubmissionId` 입력) | 빌드는 confirmed/FAILED. 심사는 COMPLETE만 confirmed, UNRESOLVED_ISSUES는 failed, 대기 상태는 waitingExternal. `reviewSubmissionId`가 있으면 `externalId`로 덮어쓰지 않음 |
| create-app | `GET /v1/apps?filter[bundleId]=`만 | OpenAPI 4.4.1에 POST /v1/apps 없음. 없으면 `unresolved` + App Store Connect |
| create-version | `POST /v1/appStoreVersions` | 필수 attributes `platform`,`versionString`, relationships.app. 선택 build |
| list-listings | `GET /v1/apps/{id}/appStoreVersions`, 지정 시 `GET /v1/appStoreVersions/{id}?include=app`, `GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations` | 정확한 `appStoreVersionId`는 이 앱 소유여야 함 |
| update-listing | 소유권 확인 후 `POST /v1/appStoreVersionLocalizations` 또는 `PATCH /v1/appStoreVersionLocalizations/{id}` | locale/description/keywords/whatsNew/URLs. 버전 ID 필수. 기존 현지화는 `?include=appStoreVersion`으로 버전·로케일 확인 |
| upload-listing-image | 버전·현지화 소유권 확인 → `GET .../appScreenshotSets` (같은 `screenshotDisplayType`이면 재사용) → `POST /v1/appScreenshots` `{fileName,fileSize}` → `uploadOperations` PUT(오프셋·길이·requestHeaders) → `PATCH uploaded:true, sourceFileChecksum`(파일 전체 **MD5**) → `GET` `assetDeliveryState` | 컨트롤러가 검증한 프로젝트 미디어만. PNG/JPEG, 알파 없음, 공식 픽셀 크기. 세트당 최대 10장. COMPLETE만 confirmed. App Preview 동영상은 미지원 |
| update-app-info | `GET /v1/apps/{id}/appInfos` → POST/PATCH `appInfoLocalizations` | name/subtitle/privacyPolicyUrl. 기존 현지화는 `?include=appInfo`로 이 appInfo·요청 로케일 확인 |
| list-beta-groups | `GET /v1/apps/{id}/betaGroups` | 조회 |
| create-beta-group | `POST /v1/betaGroups` | 같은 이름 그룹이 있으면 재사용(쓰기 없음) |
| distribute-build | `GET /v1/betaGroups/{id}/relationships/app`, `GET /v1/builds/{id}/relationships/app` 후 `POST /v1/betaGroups/{id}/relationships/builds` | 정확한 betaGroupId+buildId가 이 앱 소유. 이미 연결이면 성공 |
| link-build | 버전 `?include=app`·빌드 `/relationships/app` 확인 후 `PATCH /v1/appStoreVersions/{id}/relationships/build` | 스토어 버전에 처리된 빌드 연결 |
| submit-review | 버전 `?include=app` 확인 후 `POST /v1/reviewSubmissions` → `POST /v1/reviewSubmissionItems` → `PATCH submitted:true` | 정확한 appStoreVersionId. 기존 READY_FOR_REVIEW 제출 재사용. 상태 매핑은 reconcile과 동일 |
| list-review-submissions | `GET /v1/reviewSubmissions?filter[app]=` | 조회 |
| release-version | 버전 `?include=app` 확인 후 `POST /v1/appStoreVersionReleaseRequests` 또는 phasedReleases | 수동 출시는 PENDING_DEVELOPER_RELEASE만. pause/complete는 `GET /v1/appStoreVersions/{id}/relationships/appStoreVersionPhasedRelease`로 선택한 버전과 일치하는지 확인 |
| create-product | `GET /v1/territories`(통화 검증) → `POST /v2/inAppPurchases` → `GET .../pricePoints?filter[territory]` → `POST /v1/inAppPurchasePriceSchedules` | 요청 금액과 **정확히 일치하는** 가격 포인트만 적용 |
| update-product | `GET /v2/inAppPurchases/{id}/iapPriceSchedule` → `GET /v1/inAppPurchasePriceSchedules/{id}/baseTerritory` → 가격 일정 재적용 | status 변경은 심사 제출 절차라 미지원(명시 오류) |
| sync | `GET /v1/salesReports?filter[frequency]=DAILY&filter[reportType]=SALES&filter[reportSubType]=SUMMARY&…` | gzip TSV의 Developer Proceeds×Units를 통화별 합산, basis=proceeds |

- 앱 매칭: 프로젝트의 bundle ID(`filter[bundleId]`, 정확히 1건) 또는 연결의 `appleAppId`. `.ipa`의 `Info.plist`(binary/XML plist 자체 파서)에서 CFBundleIdentifier를 읽어 대상 앱과 대조하고, 불일치 시 쓰기 전에 중단한다. 결과물 경로는 controller가 검증한 `context.artifact`만 사용하며 호출자 임의 경로 입력은 받지 않는다.
- 원시 Apple ID는 해석된 프로젝트 앱에 속해야만 사용한다. 공식 OpenAPI 4.4.1 조회만 사용하며 관계를 추측하지 않는다. 버전의 앱은 `GET /v1/appStoreVersions/{id}?include=app`, 버전 현지화는 `GET /v1/appStoreVersionLocalizations/{id}?include=appStoreVersion`(선택한 버전·요청 로케일), 앱 정보 현지화는 `GET /v1/appInfoLocalizations/{id}?include=appInfo`(이 appInfo·요청 로케일), 심사는 `GET /v1/reviewSubmissions/{id}?include=app`. 빌드·TestFlight 그룹은 `GET /v1/builds/{id}/relationships/app`와 `GET /v1/betaGroups/{id}/relationships/app`. 단계적 출시는 `GET /v1/appStoreVersions/{id}/relationships/appStoreVersionPhasedRelease`. 관계가 없거나 형식이 아니면 닫힌 실패(`INVALID_PROVIDER_RESPONSE`)이고, 다른 앱/버전/로케일이면 쓰기 전에 `INVALID_INPUT`이다.
- 심사 상태(submit-review·reconcile 공통, 공식 ReviewSubmission.state): `COMPLETE`만 `summary.confirmed`. `WAITING_FOR_REVIEW`/`IN_REVIEW`/`COMPLETING`/`CANCELING`은 `waitingExternal`. `UNRESOLVED_ISSUES`는 `failed`. `READY_FOR_REVIEW`·누락·알 수 없는 값은 `unresolved`이며 confirmed가 되지 않는다. reconcile은 명시적 `reviewSubmissionId`를 `externalId`보다 우선한다.
- 심사·출시·TestFlight는 정확한 리소스 ID(`appStoreVersionId`, `buildId`, `betaGroupId`)를 요구한다.
- 스크린샷: `upload-listing-image`. Play와 같은 작업 이름이라 컨트롤러는 기존 `mediaAssetId` → 검증 artifact 연결을 재사용한다. 커넥터는 임의 경로·URL을 읽지 않는다. 공식 흐름은 [Uploading Assets to App Store Connect](https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect)와 OpenAPI 4.4.1 `appScreenshotSets`/`appScreenshots`. `sourceFileChecksum`은 원본 파일 **MD5**(빌드 업로드의 SHA_256과 다름). 처리 중이면 `waitingExternal`이며 reconcile은 `appScreenshotId`를 쓴다. `appPreviewSets`/`appPreviews`는 구현하지 않으며 요청 시 `UNSUPPORTED_OPERATION`이다.
- upload-build 입력: `{buildRunId(필수), track(기본 internal)}`. 현재 internal(업로드 후 TestFlight 처리 대기)만 지원. 업로드 상태는 공식 enum `AWAITING_UPLOAD|PROCESSING|FAILED|COMPLETE`(attributes.state.state)이며, COMPLETE 전에는 `waitingExternal: true` + `externalIds{buildUploadId, buildUploadFileId}`를 반환한다. controller는 checkpoint의 buildUploadId로 `reconcile`을 호출해 `confirmed`일 때만 성공 처리하고, FAILED는 절대 성공이 되지 않는다.
- 가격 정책: Apple 가격은 고정 가격 포인트 격자다. 요청 금액과 정확히 일치하는 포인트가 없으면 **임의로 다른 가격을 적용하지 않고** `PRICE_POINT_REQUIRED` 오류로 가장 가까운 위/아래 금액을 안내한다(비밀 없는 details: nearestBelow/nearestAbove/requestedMicros). 가격 포인트는 IAP 생성 후에만 조회되므로, create-product에서 가격 불일치가 나면 상품은 생성된 상태로 남고 checkpoint와 오류 details(createdInAppPurchaseId)로 이어서 처리할 수 있다.
- 통화 검증: 정적 기본값 없이 공식 `GET /v1/territories` 메타데이터(지역별 currency)로 요청 통화를 검증해 기준 지역을 정한다(동률이면 선호 지역 표 사용). 메타데이터에 없는 통화는 외부 변경 전에 명시 오류.
- 매출: vendorNumber(지급 화면) 필요. 최근 1~5일을 시도하고 아직 생성되지 않은 날짜는 missingDates로 보고한다. `filter[version]`은 서버 기본값을 사용한다.

공식 근거 (2026-09-11 확인, **공식 OpenAPI 명세 4.4.1 원문으로 스키마 검증 완료**):
- Apple이 배포하는 [App Store Connect OpenAPI 명세](https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip)(info.version 4.4.1)에서 다음을 원문 확인했다: `BuildUploadCreateRequest`(attributes cfBundleShortVersionString/cfBundleVersion/platform 모두 필수, relationships.app, Platform enum IOS/MAC_OS/TV_OS/VISION_OS), `BuildUploadFileCreateRequest`(fileName/fileSize/uti/assetType 필수, uti enum에 com.apple.ipa·com.apple.pkg), `BuildUploadFileUpdateRequest`(attributes uploaded:boolean, **sourceFileChecksums**: `Checksums{file{hash,algorithm:MD5|SHA_256}}`), `BuildUpload.attributes.state`(객체: state=`AWAITING_UPLOAD|PROCESSING|FAILED|COMPLETE`+errors/warnings의 StateDetail{code,description}), `DeliveryFileUploadOperation`(method/url/offset/length/requestHeaders), `/v2/inAppPurchases/{id}/pricePoints?filter[territory]`, `InAppPurchasePriceScheduleCreateRequest`(inAppPurchase/baseTerritory/manualPrices 필수 + included InAppPurchasePriceInlineCreate), `/v2/inAppPurchases/{id}/iapPriceSchedule`·`/v1/inAppPurchasePriceSchedules/{id}/baseTerritory`, `Territory.attributes.currency`, `/v1/apps?filter[bundleId]`, salesReports 필수 필터. 문서 페이지: [Build uploads](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads), [POST /v2/inAppPurchases](https://developer.apple.com/documentation/appstoreconnectapi/post-v2-inapppurchases), [GET /v1/salesReports](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports).
- 업로드 바이너리 PUT 호스트: 명세는 `uploadOperations[].url`을 동적 값으로만 정의하며 고정 호스트를 문서화하지 않는다. transport의 "신뢰한 JSON 응답의 정확한 URL만 등록(.apple.com/.icloud.com 한정)" 모델이 명세와 일치한다. 실계정에서 실제 호스트가 이 범위를 벗어나면 transport가 거부하므로 그때 코디네이터에 보고한다.

## Steamworks (`steamConnector`)

인증 이원화: 파트너 Web API 키(`apiKey`, 게시자)와 재무 전용 `financialApiKey`(Financial API Group, 없으면 apiKey 사용). 빌드 전송은 전용 빌드 계정의 SteamCMD 세션을 쓴다.

| operation | 실제 수단 | 비고 |
|---|---|---|
| check | `GET /ISteamApps/GetPartnerAppListForWebAPIKey/v2/` | 키 검증 + buildDelivery 상태(steamcmd 존재/세션 캐시) 보고 |
| list-apps | 위와 동일 | 파트너 키에 연결된 앱 목록 |
| list-releases | `GET /ISteamApps/GetAppBuilds/v1/`, `GET /ISteamApps/GetAppBetas/v1/` | 빌드와 라이브 브랜치 병합(live:branch) |
| upload-build | SteamCMD `+login <buildUsername> +run_app_build <생성 VDF> +quit` | 비밀번호/토큰 argv 금지, `+@NoPromptForPassword 1`로 세션 부재 시 즉시 실패 |
| set-live | `POST /ISteamApps/SetAppBuildLive/v2/` (form: key, appid, buildid, betakey, steamid?, description?) | 이후 `GetAppBetas`로 반영 확인. public+출시 앱은 steamid·모바일 승인 |
| create-announcement | 호출 없음 | ISteamNews는 GetNewsForApp/GetNewsForAppAuthed만 문서화. `unresolved` + [이벤트 도구](https://partner.steamgames.com/doc/marketing/event_tools) |
| sync | `GET /IPartnerFinancialsService/GetDetailedSales/v001/` (date + highwatermark 페이징) | `net_sales_usd`(세금·환불 차감 후) 합산을 metric으로, `gross_sales_usd`/`gross_returns_usd` 합계를 summary로 보고. appid로만 매칭(앱 이름 매칭 금지). Steam 수익 배분 차감 전이라 basis=estimated |

- upload-build 입력: `{buildRunId(필수), track(기본 internal)}`. internal은 업로드만(브랜치 미변경), 베타 브랜치 이름(`[A-Za-z0-9_-]`)은 VDF `SetLive`로 반영. `public`/`default` 전환은 업로드 경로에서 거부하고 `set-live`로만 수행한다.
- set-live: 공식 [SetAppBuildLive v2](https://partner.steamgames.com/doc/webapi/ISteamApps). 베타 브랜치는 즉시 GetAppBetas로 확인. public은 `confirmSteamId`(입력 또는 연결)가 필요하고, 문서의 HTTP 201 모바일 승인은 transport가 상태 코드를 노출하지 않아 GetAppBetas 미반영을 `waitingExternal`로 처리한다.
- App ID는 프로젝트의 숫자 앱 식별자에서, Depot ID는 연결의 `depotId`(기본값 AppID+1, Steamworks 기본 생성 규칙)에서 온다. 결과물은 디렉터리형 검증 artifact(콘텐츠 루트)만 허용한다.
- VDF는 `store-tools.renderVdf`가 생성하며 키 형식·제어 문자를 검증하고 `\\`·`"`를 이스케이프한다. 임의 VDF 주입 입력은 없다.
- SteamCMD 실행 파일은 연결 설정의 `steamcmdPath`(절대 경로, steamcmd/steamcmd.sh/steamcmd.exe)만 신뢰하며 action 입력의 경로는 무시한다. 일반 사용자 Steam 설치·프로필을 탐색하지 않는다. 같은 설치 경로의 실행은 직렬화하고, 취소·시간 초과 시 SteamCMD 프로세스 그룹 전체(하위 프로세스 포함)를 종료한다. 세션 파일은 0o600, 디렉터리는 0o700 권한을 유지한다.

### 빌드 계정 세션 수명주기

1. **1회 설정**: 사용자가 전용 빌드 계정으로 지정한 SteamCMD 설치에서 한 번만 대화형 로그인(비밀번호+Steam Guard)한다. 이 앱은 비밀번호를 저장하거나 전송하지 않는다.
2. **재사용**: 이후 실행은 `+login <계정명>`만으로 SteamCMD가 자체 보관한 세션(`<설치 경로>/config/config.vdf`)을 사용한다(공식 근거: [SteamPipe 업로드 문서](https://partner.steamgames.com/doc/sdk/uploading)의 config.vdf 보존 안내). **이 세션 파일은 OS 보관함(vault)과 별도로 SteamCMD 설치 디렉터리에 저장된다.**
3. **회전 백업**: 실행 후 config.vdf가 갱신되면 `context.saveCredentials`로 vault에 `steamSessionConfig`(base64) 백업을 저장하고, 설치가 초기화된 장비에서는 실행 전에 백업을 복원한다(0o600/0o700 권한). 갱신을 무시하지 않는다.
4. **세션 만료/부재**: `AUTH_REQUIRED`와 함께 “이 장비에서 1회 대화형 로그인” 안내를 반환한다. 반복 비밀번호 로그인 구조를 만들지 않는다.

공식 근거 (2026-09-11 확인): [ISteamApps 파트너 API](https://partner.steamgames.com/doc/webapi/ISteamApps) (GetPartnerAppListForWebAPIKey v2, GetAppBuilds v1, GetAppBetas v1, SetAppBuildLive v2), [IPartnerFinancialsService](https://partner.steamgames.com/doc/webapi/IPartnerFinancialsService) (GetDetailedSales v001: date·highwatermark_id·max_id, `net_sales_usd` USD 4자리 소수), [SteamPipe 업로드·로그인 캐시](https://partner.steamgames.com/doc/sdk/uploading).

## 검증 상태 (2026-09-11)

- 완료(공식 명세 검증): Apple 요청/응답 필드명·리소스 타입·경로·필수 속성·상태 enum·checksum 형식을 공식 OpenAPI 명세 4.4.1 원문과 대조해 확정했다(위 "공식 근거" 참조). 추측 필드는 남아 있지 않다.
- 완료(모의 경계 검증): `tests/store-connectors.test.ts` 23개 — Apple buildUploads 흐름(요청 순서·부분 PUT 바이트·SHA_256 sourceFileChecksums 커밋·상태 객체 해석·waitingExternal·checkpoint), reconcile confirmed/failed 매핑(FAILED는 절대 confirmed가 되지 않음), bundle ID 불일치 시 쓰기 차단, .ipa/.pkg/track 검증, 통화의 공식 territory 메타데이터 검증(외부 변경 전), 정확 가격 포인트 강제·PRICE_POINT_REQUIRED 상세(부분 생성 ID 포함), 매출 TSV 집계·결측일 처리, Steam 파트너 API 파싱·gross/returns 합계, SteamCMD argv 무비밀·VDF 이스케이프·세션 회전 저장/복원·Guard 실패 안내·취소 시 프로세스 트리 종료, 미지원 작업 거부. 실행: `node --import tsx --test tests/store-connectors.test.ts`.
- 미완료(실계정·실환경 없음): Apple/Steam 실계정 호출, 실제 .ipa 업로드·업로드 PUT 실호스트 확인, 실제 SteamCMD 바이너리·Steam Guard 흐름. T-2.1 실계정 확보 후 V-05 게이트에서 검증한다.
- 알려진 한계: Apple `.pkg`(macOS) 업로드 미지원, Apple App Preview 동영상(`appPreviews`) 미지원, Apple IAP 상태 전환 미지원, Steam 상품/가격 관리 미지원(파트너 사이트 전용), Steam 공지 쓰기는 공개 API 없음, Steam 매출은 수익 배분 차감 전 금액. Apple 스크린샷은 `tests/app-store-media.test.ts`에서 HTTP 픽스처로 검증했다. 실계정 업로드는 없다.
- 추가 모의 검사: `tests/store-extensions.test.ts` — Play 편집 수명주기(커밋/폐기), 단계적 출시 userFraction, 신규 앱 Console 게이트, 이미지 media 업로드, Apple 현지화/버전/TestFlight/심사 제출 JSON:API, 같은 앱·다른 앱 Apple ID 소유권(공식 include/relationships 증거), 심사 상태 COMPLETE/대기/UNRESOLVED_ISSUES/READY_FOR_REVIEW·누락·unknown, reconcile `reviewSubmissionId` 우선, Steam SetAppBuildLive form과 공지 미지원 게이트. 실행: `node --import tsx --test tests/store-extensions.test.ts`.
- 제어 서비스 통합: `list-beta-groups`, `list-review-submissions`는 조회로 분류한다. `list-listings`는 Play가 edits.insert를 쓰므로 쓰기로 유지한다. `upload-listing-image`는 프로젝트 미디어의 형식·크기·해시·귀속을 확인한 뒤 연결한다. `submit-review` 재확인은 `reviewSubmissionId`, `set-live` 재확인은 `steamBuildId`+branch를 사용한다. Play 변경 전 실패는 임시 편집을 정리하며, 정리 여부가 불명확하면 조회로 확인한다. commit 전송 후 결과 유실은 같은 쓰기를 재전송하지 않는다.
