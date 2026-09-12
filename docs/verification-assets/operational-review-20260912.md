# 실제 운영 흐름 점검 — 2026-09-12

이 문서는 **수정 전 이력**이다. 후속 요청으로 아래 항목을 수정했으며 [현재 수정·검증 결과](operational-fixes-20260912.md)를 따른다.

계정 연결은 완료됐다고 가정하고, 앱 내부 빌드·엔진 설치·서명 도구는 평가에서 제외했다. 현재 코드에는 운영 중 막히는 문제가 있다. 아래 1~4는 실제 서비스·SQLite·큐 또는 스케줄러를 모의 공급자 응답과 연결해 재현했다. 5는 화면/API 호출 흐름에서 확인한 사용 방식의 불일치다. 제품 코드는 수정하지 않았다.

[작업 목록](../../dev/active/app-operations-platform/app-operations-platform-tasks.md) · [맥락](../../dev/active/app-operations-platform/app-operations-platform-context.md) · [검증 색인](../verification.md) · [재현 스크립트](operational-review-20260912.before-fix.mts) · [결과 JSON](operational-review-20260912.json)

## 1. P1 — 명확히 거절된 게시 요청을 정리할 수 없어 이후 게시가 막힘

- 조건: 연결된 X 계정, 프로젝트 게시 한도 1. 게시 POST에 HTTP 400을 반환한다.
- 결과: `PROVIDER_REJECTED`가 `action_required`로 남고, 취소·재시도·재확인 모두 `RECONCILIATION_REQUIRED`가 된다. 다른 문구로 새 글을 보내도 `SOCIAL_DAILY_LIMIT`로 차단된다. 미확정 작업은 날짜가 지나도 한도 계산에 포함된다.
- 원인: `packages/connectors/transport.ts:45`가 요청 전 전송 표시를 하고, `apps/controller/queue.ts:45`가 이후의 모든 오류를 미확정 외부 효과로 취급한다. `apps/controller/service.ts:732`에는 이 X 요청을 종결할 재확인 경로가 없고, `packages/storage/index.ts:176`은 해당 작업을 계속 예약량으로 센다.
- 수정 방향: 단일 요청의 확정 거절과 응답 유실을 구분해 전자는 실패로 종결한다. 여러 단계 변경에서는 앞 단계의 실제 효과까지 확인해야 하므로 모든 HTTP 4xx를 일괄 재시도 가능으로 바꾸면 안 된다. 결과가 정말 불명확한 작업도 사용자가 확인 근거를 남겨 정리하는 경로가 필요하다.
- 관련 작업: T-2.4, T-11.2, T-11.4.

## 2. P1 — 한 Google Play 계정에 연결한 두 번째 앱이 자동 동기화에서 빠짐

- 조건: 계정의 기본 패키지는 `com.review.a`; 프로젝트 A/B를 각각 `com.review.a`, `com.review.b`로 같은 계정에 매핑한다.
- 결과: 정기 동기화는 A에만 요청한다. 같은 API에 B의 `projectId`를 명시하면 B 조회에 성공한다. 화면의 상품·출시 목록 조회에는 프로젝트 선택기가 없어서 기본 앱을 계속 조회한다.
- 원인: `apps/controller/automation.ts:72`가 계정별 `sync`를 `projectId` 없이 생성한다. `apps/desktop/src/operations.ts:47` 및 `components/ResourcePanel.tsx:111`도 상품·출시 목록 요청에서 프로젝트를 받지 않는다. `packages/connectors/google-play.ts:24`는 프로젝트가 없으면 계정의 기본 패키지를 사용한다.
- 수정 방향: 스토어의 앱별 작업을 매핑된 프로젝트별로 예약하고, 목록 화면에서도 대상 앱을 선택하도록 연결한다. 계정 전체 보고서 수집은 중복 예약하지 않도록 구분해야 한다.
- 관련 작업: T-4.2, T-9.1, T-13.7.

## 3. P1 — Google Ads에서 삭제한 캠페인이 남아 새 캠페인의 예산을 막음

- 조건: 한도 USD 100, 기존 PAUSED 캠페인 예산 USD 100을 조회한 다음 외부 삭제를 반영해 다음 목록 응답을 0개로 바꾼다.
- 결과: 동기화 결과는 `campaignCount: 0`인데 앱에는 PAUSED 캠페인 1개가 계속 남는다. 예산 USD 50으로 새 캠페인을 만들면 `BUDGET_LIMIT`가 발생한다.
- 원인: `packages/connectors/google-ads.ts:93`은 REMOVED 캠페인을 제외하고, `apps/controller/service.ts:665`의 제거 대상은 일부 지표뿐이다. 이전 리소스의 삭제·종결 상태를 반영하지 않아 `apps/controller/campaign-budget.ts:28`에서 오래된 예산을 계속 합산한다.
- 수정 방향: 성공한 전체 목록 조회에서 확인한 공급자·리소스 종류·앱 범위를 기준으로 누락 자원을 제거 또는 종결 처리한다. 부분 조회나 조회 실패에서 자원을 삭제하지 않아야 한다.
- 관련 작업: T-7.1, T-9.1, T-13.7.

## 4. P2 — 실제 공개 작업을 완료해도 자동 출시 공지가 생성되지 않음

- 조건: 공지 정책을 켜고 `promote-release`, `release-version`, `set-live` 성공 이력을 넣어 공지 스케줄러를 실행한다.
- 결과: 공지 0개. 비교용 `upload-build` 성공 이력에 `track: production`을 넣으면 공지 1개가 생성된다.
- 원인: `apps/controller/social-automation.ts:139`가 `upload-build`만 확인한다. 내부 테스트 업로드 후 승격하는 정상 출시 과정, 스토어의 수동 공개, 외부 업로드 후 공개 결과를 수집하는 과정은 이 조건을 충족하지 않는다. 업로드 완료와 실제 공개 시점도 별도로 판단해야 한다.
- 수정 방향: 확인된 실제 공개 상태의 전이를 공지 기준으로 삼고, 앱·버전·스토어로 중복을 막는다. 공개 작업이 API에 접수된 것만으로 공지하면 안 된다.
- 관련 작업: T-11.2, T-11.4.

## 5. 사용 방식 불일치 — 외부에서 빌드한 파일을 가져와 배포하는 경로가 없음

사용자는 이 앱에서 빌드하지 않는다고 명시했다. 현재 출시 버튼은 `apps/controller/pipelines.ts:38`의 검수 후 빌드 생성으로 이어진다. 직접 업로드도 `apps/controller/service.ts:419`에서 임의 파일 경로를 거부하고, 같은 파일 424~426행 및 `apps/desktop/src/components/ActionForm.tsx:121`에서 이 앱의 성공한 `build` 이력을 요구한다. 외부 AAB/APK/IPA/Steam 결과물을 검증·등록하는 API와 화면은 찾지 못했다.

따라서 기존 스토어 자료 관리와 별개로, 이 앱에서 바이너리 업로드까지 하려면 **외부 결과물 가져오기 → 앱·버전·서명·무결성 확인 → 업로드** 경로가 필요하다. 내부 빌드 엔진의 완성도를 이번 검토의 결함으로 세지 않는다. 후속 구현 시 사용자 방식에 맞게 출시 계약을 먼저 조정해야 한다.

## 실행한 검증과 한계

- 운영 관련 기존 검사: 160개 중 156 통과, Apple 이미지 관련 4 실패. 로그 `/tmp/appops-operational-review-tests.log`.
- 데스크톱 경계·모드·수명주기·백업 복원·준비 상태·미리보기 검사: 102/102 통과. 로그 `/tmp/appops-operational-review-desktop-tests.log`.
- 합계: 선택한 기존 검사 **262개 중 258 통과, 4 실패**. 전체 `npm test` 결과로 표현하지 않는다.
- `npm run typecheck`: `tests/app-store-media.test.ts:194`부터 Promise의 width/height/mime를 동기 접근하는 TS2339 오류 3개로 실패. `tsc -p tsconfig.node.json --noEmit`은 통과.
- Apple 실패 추가 조사: 기존 PNG fixture에 IDAT 픽셀 데이터가 없다. 정상 RGB PNG로 `inspectScreenshotBytes`를 직접 호출하면 1290×2796으로 통과한다. 저장소 테스트를 바꾸지 않고 `/tmp` 복사본에서 PNG 픽셀과 async/await만 교정하면 5/6 통과한다. 남은 1개는 테스트의 기존 스크린샷 예약 재사용 기대와 구현의 신규 예약 생성이 다르다. 이미지 업로드 전체를 정상 또는 고장으로 단정하지 않는다. 로그 `/tmp/appops-review-apple-media-fixture-only.log`.
- Google Play의 `/applications/{packageName}/tracks/{track}/releases`는 [공식 출시 조회 API](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list)에 존재한다. 구형 Edits API 기억만으로 잘못된 엔드포인트라고 판정하지 않았다. one-time 상품 경로의 대소문자 차이도 [공식 목록](https://developers.google.com/android-publisher/api-ref/rest)과 대조했다.
- 실제 공급자 쓰기, 실제 계정 로그인, 앱/게임 빌드, 새 패키지 제작, OS 자동 시작 설정, 네이티브 창 조작은 수행하지 않았다. 사용자 데이터나 비밀을 읽지 않고 임시 DB와 메모리 키 보관함으로 검증했다.

재현 명령:

```bash
node --import tsx docs/verification-assets/operational-review-20260912.before-fix.mts
```

수정 전 재현을 확인하는 스크립트이므로 결함을 고치면 현재 결과를 기대하는 assertion도 변경해야 한다. 현재 코드를 수정한 회귀 테스트로 간주하지 않는다.
