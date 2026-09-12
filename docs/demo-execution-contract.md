# 데모와 실제 운영의 공통 실행 계약

확정: 2026-09-11. 기준: [계획 v3](../dev/active/app-operations-platform/app-operations-platform-plan-v3.md). [사용 안내](desktop-usage.md) · [검증](verification.md).

## 모드와 데이터

기본 화면은 데모다. 9개 서비스 연결과 Godot·Unity·Unreal·Android·iOS의 5개 프로젝트, 캠페인·상품·광고 단위·게시물·14일 지표·합성 빌드 키를 준비한다. 같은 React 화면과 AppService·작업 큐·정책·이력 계약을 사용하며, 수행 결과는 재시작 후에도 유지한다.

실제 API는 `/api/...`, 데모는 `/api/demo/...`다. 실제 저장 경로의 형제 디렉터리 `<data-directory>.demo/data`에 데모 DB·보관함·결과물을 따로 둔다. URL 정규화 전에 원시 경로를 검증하므로 `..`, 인코딩된 구분자, 역슬래시, 중복 구분자로 모드를 넘을 수 없다. Electron IPC도 경로·메서드를 제한한다.

`AppState.runtime.mode`가 모드를 표시한다. 모드 변경은 새 페이지를 열어 고정된 모드의 API 클라이언트를 만들고 이전 응답·폼·타이머를 제거한다. 실제/데모의 계정·프로젝트·작업을 복사하지 않는다. 데모의 외부 HTTP와 엔진 CLI는 실행하지 않으며, 실제 키·토큰 입력과 OAuth 시작을 거부한다. 데모 키는 공개된 합성 키이고 실제 비밀 보관 용도가 아니다. 데모에서 선택한 경로는 합성 프로젝트 생성용 이름으로만 사용한다.

`POST /demo/scenario`는 `{scenario:'normal'|'network-error'|'auth-expired'|'review-rejected'}`를 받는다. 실패→재시도, 인증 확인 후 준비 작업 재개, 심사 거절을 재현한다. `POST /demo/reset`은 데모만 지우며 실행 중·외부 확인 대기·조치 필요 작업이나 다른 요청이 있으면 409를 반환한다. 초기화 전에 해당 작업을 완료하거나 안전하게 취소해야 한다.

## 출시와 소재

`POST /projects/:id/publish` 입력:

```json
{"target":"android","connectionId":"connection-id","track":"internal","version":"1.3.0","releaseNotes":"업데이트 내용","idempotencyKey":"request-id"}
```

선택 입력은 `configuration`, `exportPreset`, `scheme`, `runnerId`다. 프로젝트 검수는 이벤트로 남기고, 빌드와 스토어 업로드는 각각 자식 작업으로 저장한다. `AppState.pipelines`의 부모가 진행·실패·취소를 추적한다. 빌드 결과와 해시 검증 후 업로드를 한 번만 생성하며, 같은 요청 키와 다른 내용은 409다. 대상 OS와 스토어가 맞아야 하고, 등록한 준비 완료 Mac 러너를 선택한 iOS 빌드는 로컬 호스트의 Mac 필요 경고만 제외한다. 소스 자체의 검수 오류는 유지한다.

`POST /pipelines/:id/cancel`은 자식 작업도 취소한다. 이미 보낸 외부 쓰기의 결과가 불명확하면 상태 확인이 먼저다. 공개 출시가 확인되고 프로젝트 소셜 정책이 켜져 있으면 X/Threads 공지를 연결한다. 내부 트랙 업로드만으로 공개 출시 공지를 보내지 않는다.

`POST /media`는 `{projectId,name,base64}`를 받는다. PNG/JPEG/WebP의 시그니처·확장자·15 MiB 한도를 검사하고 프로젝트 소유 파일과 해시를 기록한다. Play 이미지 작업에는 `mediaAssetId`를 넣는다. 실행 직전에 프로젝트 귀속·크기·해시를 다시 확인한다. 파일 경로를 직접 받지 않는다. Threads 미디어는 플랫폼이 접근할 HTTPS URL을 입력한다.

## 운영과 복구

- `GET /operations`: 준비 상태·러너·백업·운영 설정. 준비 안내는 해당 앱 화면으로 이동한다.
- `PUT /operations/settings`: `retentionDays` 7–3650, `backupHour` 0–23, `autoBackup`, `notifications`. 보존 기간은 설정 백업 파일에 적용한다. 알림은 앱 내 완료·실패·조치 필요 알림이다.
- `POST /operations/backup`: 선택 `description`(200자). 프로젝트·정책·운영 설정의 논리 백업을 만든다.
- `POST /operations/restore`: `{backupId}`. 같은 설치·모드의 해시 검증된 백업만 받고, 작업 중이면 거부한다. 백업 프로젝트를 현재 설정에 병합하며 이후 추가한 프로젝트, 현재 계정·키, 작업·외부 효과 이력, 미디어·산출물을 보존한다. 복구한 프로젝트의 자동 빌드·출시·광고·수익화·소셜과 자동 백업을 끈다. 복구 결과의 `automationsPaused`는 boolean이다.
- `POST /operations/diagnostics`: 비밀 값 없이 준비 상태와 버전을 담은 진단 자료·이력을 만든다.
- `POST /operations/runners`: `{label,platform,endpoint,pairingToken}`. 실제 모드는 최초 연결 코드를 암호화 저장하고, 데모는 코드 없이 합성 확인한다. `POST /operations/runners/:id/check`, `DELETE /operations/runners/:id`. 로컬 러너는 내장 행이며 등록·삭제 대상이 아니다. [원격 러너 계약](runner-protocol.md)을 따른다.

백업은 전체 장비 이사나 암호문 복구 수단이 아니다. 이미 전송한 작업 이력을 과거 상태로 되돌리지 않는다.

## 공급자 작업과 결과

`Capability.operations`와 `operationFields`가 공통 실행 폼을 만든다. 쓰기는 프로젝트·연결 허용 범위·예산·소유권을 확인하고, `Run.writeEffect`가 실제 외부 효과 여부를 표시한다. Apple 현지화 조회는 GET만 수행하지만 Play 현지화 조회는 임시 편집을 생성하므로 쓰기 이력을 가진다. 신규 앱 준비·Steam 공지 준비는 수동 단계 안내이고 미지원 게시를 성공 처리하지 않는다.

Google Play는 커밋 전 실패 시 편집 삭제를 시도한다. 삭제 실패는 편집 ID와 함께 조치 필요로 남기고, 커밋 응답이 불명확하면 삭제·재전송을 하지 않는다. 임시 편집 정리는 읽기만 하는 상태 확인으로 검증하며 실패한 조회/변경은 새 작업으로 다시 실행한다.

Apple 전역 리소스 ID는 프로젝트의 앱 관계를 확인한다. 심사는 `COMPLETE`만 성공, `UNRESOLVED_ISSUES`는 실패, 진행·취소 중은 대기, 미정·알 수 없는 상태는 조치 필요다. SDK 설정 안내에 보관함 키 원문을 넣지 않는다. 공식 API 제한과 실제 검증 여부는 [연동 기능표](integration-capabilities.md)에 구분한다.

## 화면의 데모 상황과 초기화

운영·복구의 데모 체험 설정에서 정상 동작·네트워크 오류·권한 만료·심사 거절을 다음 해당 작업에 적용한다. 네트워크 오류는 재시도 대기 후 자동 복구되고 시도 횟수와 최종 결과를 이력에 남긴다. 초기화는 확인 창을 거쳐 데모 프로젝트·작업·키·백업을 기본 시드로 재생성하며 실제 운영 공간은 보존한다. 진행 중·외부 대기·사용자 조치 작업이 있으면 화면과 제어 서비스 모두 초기화를 차단한다.
