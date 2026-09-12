# 앱 출시·마케팅·수익화 통합 자동화 작업 목록

Last Updated: 2026-09-12

프로젝트명: `gameStudioAutomaiton`. 2026-09-12 사용자 지시로 앱 표시명·패키지 이름을 통일하고 `sphacker83/gameStudioAutomaiton` 비공개 저장소로 관리한다. 이름 변경 타입 검사·컴파일·패키징 메타데이터 검증 통과. 기존 개발계획 파일명은 참조 이력으로 보존한다.

유효 기준선: [개발계획 v5](app-operations-platform-plan-v5.md), [v4](app-operations-platform-plan-v4.md), [v3](app-operations-platform-plan-v3.md), [v2](app-operations-platform-plan-v2.md), [승계한 v1](app-operations-platform-plan.md). 진행 맥락: [작업 맥락](app-operations-platform-context.md). 14개 Phase, 56개 작업이며 완료 조건을 충족한 작업은 문서 3개와 v3 통합 5개, 실사용 후속 수정 6개, 총 14개다. 나머지 42개는 실서비스·OS·장기 수용 조건까지 포함하며 코드 구현률을 뜻하지 않는다.

Phase 1의 문서 고정 뒤 사용자 지시로 구현을 진행 중이다. 체크 표시는 해당 작업의 전체 산출물·검증 계약이 완료됐다는 뜻이며 코드 생성만으로 체크하지 않는다. 구현 중 경로는 [구현 계약](../../../docs/implementation-contract.md)과 context의 체크포인트를 따른다. 각 작업의 완료 조건은 해당 Phase의 Acceptance Criteria와 V-* 검증 계약을 함께 적용한다. 최근 검증은 [검증 기록](../../../docs/verification.md), [이력·복구 계약](../../../docs/workflow-contract.md), [운영 정책](../../../docs/automation-policies.md), [지표 정의](../../../docs/metric-definitions.md)에 기록한다.

개발 체크포인트(2026-09-11): 전체 자동 검사 246개·타입 검사·최종 Linux AppImage·패키지 제어 서비스의 데모 출시·백업·실제 원격 Godot 실행·독립 리뷰를 통과했다. 실제 브라우저에서 소재·게시·예약·키·파이프라인·운영·복구·오류 재시도·데모 초기화를 확인했다. 실계정·전체 OS·아직 미구현인 수용 조건은 체크하지 않았다. 자세한 근거는 [검증 기록](../../../docs/verification.md)을 따른다.

실사용 검토와 후속 수정(2026-09-12): [수정 전 검토](../../../docs/verification-assets/operational-review-20260912.md)의 운영 결함 4개, 외부 결과물 배포 경로 부재, Apple 이미지 검사 오류를 사용자 요청으로 수정했다. 전체 434/434·마지막 관련 검사 27/27·타입·운영 앱 컴파일 통과, 데모/실제 모드 브라우저에서 외부 파일 업로드와 수동 확인 결과 저장을 검증했다. [수정 결과](../../../docs/verification-assets/operational-fixes-20260912.md) · [외부 결과물 사용법](../../../docs/external-artifacts.md). 이번 범위는 Phase 14로 종결하며 기존 실계정·장비·장기 수용 조건 42개를 완료로 바꾸지 않는다.

## Phase 1 — 개발 기준선 문서 고정 [상태: 완료]

- [x] T-1.1 사용자 요구·사용 흐름·최초 1회 연결 계약 정리
- [x] T-1.2 공식 연동 근거·구조·단계·완료 기준 작성
- [x] T-1.3 요구사항·문서 연결·태스크 정합성 검토와 상태 고정

## Phase 2 — 연동 실현성·계정·실행 기반 [상태: 진행 중]

- [ ] T-2.1 필수 서비스의 인증 유지·권한·쓰기·신규 앱 절차를 실계정으로 검증
- [ ] T-2.2 데스크톱·제어 서비스·공통 계약과 실제 검증 명령 구성
- [ ] T-2.3 OS 보관함·연결 마법사·인증 갱신·연결 재사용 구현
- [ ] T-2.4 DB·내구성 있는 작업 큐·변경 의도·공통 이력 구현

### T-2.1 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 3–5절과 서비스별 공식 근거, [작업 맥락](app-operations-platform-context.md)의 미확인 조건.
- 원본 코드 참조: 없음. 검증 계정·대표 프로젝트·장비 보유 상태를 먼저 확인한다.
- 구현 대상: `docs/integration-capabilities.md`, `docs/build-support.md`, 필요한 최소 검증 스크립트. 계정/기능별 인증·읽기·쓰기·재확인·브라우저 지원과 확인 날짜를 기록한다.
- 검증 참조: V-02·V-05·V-07·V-08의 공급자 계약. API 존재 확인과 실제 계정 테스트를 구분하고 토큰 갱신, AppLovin 접근 제한, Google Ads Cloud 접근 수준, Play 신규 앱, Steam 공개 확인을 검증한다.
- 문서 반영: 두 신규 문서의 실제 링크를 이 작업과 context에 추가. 계정/장비별 blocker, 지원 범위, 일정 재산정 근거를 기록한다.

### T-2.2 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 6절, T-2.1의 실현성 결과.
- 원본 코드 참조: 현재 없음. 패키지·런타임 엔트리포인트는 이 작업에서 생성한다.
- 구현 대상: `apps/desktop/`, `apps/controller/`, `packages/domain/`, 루트 패키지·잠금 파일, `docs/verification.md`.
- 검증 참조: V-09의 화면/서비스 분리와 지원 OS 기동. 실제 설치·타입 검사·정적 검사·테스트·빌드 명령을 패키지 스크립트로 확정한다.
- 문서 반영: 실제 코드 구조·환경 버전·검증 명령을 context와 `docs/verification.md`에 기록하고 후속 작업의 예정 참조를 갱신한다.

### T-2.3 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 3·4·7절, T-2.1 기능표.
- 원본 코드 참조: T-2.2에서 생성할 화면/제어 서비스 경계와 공통 연결 계약.
- 구현 대상: `packages/credentials/`, `packages/connectors/`의 인증 부분, 계정·환경 설정 화면.
- 검증 참조: V-02. 동시 갱신·재시작·권한 철회·OS 보관함 잠김·Linux 안전한 보관함 부재·여러 프로젝트 재사용·비밀 로그 제거를 검사한다.
- 문서 반영: [인증 수명주기](../../../docs/credential-lifecycle.md)에 공급자별 인증 상태와 복구·해제 절차를 기록했다. 메모리 보관함·모의 HTTP 26개 검증을 통과했으며 실계정·Mac/Windows 검증은 남아 있다.

### T-2.4 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 8·11절, T-2.2 공통 계약.
- 원본 코드 참조: T-2.2의 제어 서비스와 T-2.3의 연결 상태 구현.
- 구현 대상: `packages/storage/`, `apps/controller/`의 큐·예약·정책·이력 저장, `tests/integration/`.
- 검증 참조: V-06. 실제 DB 재시작·중복 전달·lease 만료·늦은 러너 응답·외부 효과 결과 미확정·부분 성공 시나리오를 검증한다.
- 문서 반영: `docs/workflow-contract.md`에 상태 전이·소유권·재조정 규칙을 기록하고 이 작업 및 context에 연결한다.

## Phase 3 — 프로젝트 검수·빌드 공통 구조 [상태: 진행 중]

- [ ] T-3.1 프로젝트 탐지·기존 앱 매칭·검수 규칙 구현
- [ ] T-3.2 소스 스냅샷·로컬/원격 러너·명령 실행 계약 구현
- [ ] T-3.3 결과물·서명 단계 계약·시험 실행·이력 화면 구현

### T-3.1 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 1·2·5·9절, T-2.1 지원표.
- 원본 코드 참조: T-2.2 공통 프로젝트 계약, T-2.3 연결·앱 식별 정보, T-2.4 저장소.
- 구현 대상: `packages/inspection/`, `packages/engines/` 탐지 부분, 프로젝트 등록·검수 화면, `tests/fixtures/`.
- 검증 참조: V-03. 다섯 프로젝트 유형, 혼합 폴더, 미설치 도구, 잘못된 식별자, 두 계정의 비슷한 앱 이름을 검사하고 잘못된 자동 매칭을 막는다.
- 문서 반영: `docs/inspection-rules.md`에 규칙·근거·심각도와 자동 보완 조건을 기록하고 context에 연결한다.

### T-3.2 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 5–8절, T-2.4 실행 계약.
- 원본 코드 참조: T-3.1 프로젝트 구조, T-2.4 큐·소유권·이력.
- 구현 대상: `apps/runner/`, 소스 스냅샷·도구 탐지·장비 등록·전송·프로세스 제어 모듈.
- 검증 참조: V-04·V-06. Git 없는 폴더·미커밋 변경·장비 연결 유실·명령 취소·잘못된 경로·늦은 결과 전달을 검증하고 원본 변경과 비밀 전송이 없는지 확인한다.
- 문서 반영: `docs/runner-protocol.md`에 장비 신원·스냅샷·작업 범위·취소·복구 규칙을 기록하고 context에 연결한다.

### T-3.3 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 8·9절, T-3.2 러너 계약.
- 원본 코드 참조: T-2.4 이력 저장소와 T-3.2 결과 이벤트.
- 구현 대상: 결과물 저장·해시·보존 모듈, 서명 작업 경계, 실행·이력·로그 화면, 시험 실행 어댑터.
- 검증 참조: V-04·V-06·V-09. 소스→검수→결과물 추적, 파일 훼손·용량 부족·로그 스트리밍·보존 정책과 시험 실행 실패를 검증한다.
- 문서 반영: `docs/artifact-lifecycle.md`에 저장·서명·검증·보존 계약을 기록하고 context에 연결한다.

## Phase 4 — Android·Godot와 Google Play 배포 [상태: 진행 중]

- [ ] T-4.1 네이티브 Android·Godot Android의 검수·빌드·서명 구현
- [ ] T-4.2 Google Play 업데이트·등록 자료·트랙·상태 관리 구현
- [ ] T-4.3 Google Play 신규 앱 준비·필수 Console 절차·공개 흐름 구현

### T-4.1 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 5·7·9절, 실제 엔진·SDK 버전의 공식 CLI 문서.
- 원본 코드 참조: T-3.1 검사, T-3.2 러너, T-3.3 서명·결과물 계약.
- 구현 대상: `packages/engines/android/`, `packages/engines/godot/`, 대표 프로젝트·실제 빌드 검증.
- 검증 참조: V-03·V-04. 선택한 variant·내보내기 설정으로 AAB/APK 생성, 서명·버전 확인, 시험 기기 실행과 SDK 누락 오류를 검증한다.
- 문서 반영: `docs/build-support.md`에 실제 버전·호스트·샘플·도구·검증 결과를 추가하고 context에 연결한다.

### T-4.2 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 4·8·9절, T-2.1의 Play API 검증.
- 원본 코드 참조: T-2.3 인증, T-2.4 변경 의도, T-4.1 결과물·버전 정보.
- 구현 대상: `packages/connectors/google-play/`, 스토어 자료·트랙·배포 상태 화면.
- 검증 참조: V-02·V-05·V-06. 내부 시험 트랙 업로드, 두 프로젝트의 반복 배포, 버전 충돌, edit 무효화, 업로드 후 응답 유실을 검증한다.
- 문서 반영: `docs/integration-capabilities.md`와 `docs/release-operations.md`에 검증된 작업·복구 절차를 기록하고 context에 연결한다.

### T-4.3 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 3·4·9절, T-2.1에서 확인한 신규 앱별 필수 절차.
- 원본 코드 참조: T-4.2 Play 배포, T-2.4 사용자 조치 대기·재개 계약.
- 구현 대상: 신규 앱 등록 준비·기존 앱 매칭, 최초 업로드·설문·동의 상태, 검증된 경우의 브라우저 어댑터, 공개 절차.
- 검증 참조: V-05·V-06. 신규/기존 앱 구분, 등록 정보 재사용, 필수 조치 완료 후 이어서 실행, 화면 변경 시 잘못된 쓰기 차단을 확인한다.
- 문서 반영: `docs/integration-capabilities.md`에 자동/필수 조치 경계를, `docs/release-operations.md`에 최초 출시 절차를 기록한다.

## Phase 5 — Apple·Steam 배포 확장 [상태: 진행 중]

- [ ] T-5.1 Mac 러너와 네이티브 iOS·Godot iOS 빌드·서명 구현
- [ ] T-5.2 Apple 업로드·처리 상태·TestFlight·심사·출시 관리 구현
- [ ] T-5.3 Steam용 빌드·SteamPipe·브랜치·공개 확인·자료 관리 구현

### T-5.1 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 4–7절, T-2.1의 Mac 장비·키 역할·서명 조건.
- 원본 코드 참조: T-3.2 원격 러너, T-3.3 서명 경계, T-4.1 Godot 어댑터.
- 구현 대상: `packages/engines/ios/`, Godot iOS 내보내기, Mac 장비 준비·서명 프로파일 처리.
- 검증 참조: V-02·V-04·V-06. 연결된 Mac에서 archive/export·서명·시험 실행, 인증서 만료·프로파일 불일치·장비 유실·정상 갱신을 검사한다.
- 문서 반영: `docs/build-support.md`, `docs/credential-lifecycle.md`, `docs/runner-protocol.md`의 Mac 검증 근거와 context를 갱신한다.

### T-5.2 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 4·8·9절, T-2.1 Apple API 기능표.
- 원본 코드 참조: T-2.3 JWT 인증, T-2.4 작업 상태, T-5.1 iOS 결과물.
- 구현 대상: `packages/connectors/app-store/`, 업로드·자료·TestFlight·버전/심사/출시 상태 화면.
- 검증 참조: V-02·V-05·V-06. 시험 빌드 업로드·처리 완료·TestFlight 조회, 심사 대기/반려·필수 정보·API 권한 오류, 중복 빌드 처리를 검증한다.
- 문서 반영: `docs/integration-capabilities.md`와 `docs/release-operations.md`에 키 역할·업로드 수단·첫 등록·공개 제약을 기록한다.

### T-5.3 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 3–5·8절, T-2.1 Steam 로그인·최초 앱/Depot·출시 절차.
- 원본 코드 참조: T-4.1 Godot 어댑터, T-3.2 OS 러너, T-2.3 지속 자격 증명, T-2.4 변경 의도.
- 구현 대상: `packages/connectors/steam/`, Godot 데스크톱 빌드, Depot·브랜치·상점 자료·공개 상태 관리.
- 검증 참조: V-02·V-04~06. OS별 결과물 실행, SteamCMD 재시작 후 로그인 재사용, 시험 브랜치 업로드, 공개 확인과 재개, 설정 파일 갱신 보존을 검증한다.
- 문서 반영: 빌드 지원표·연동 기능표·출시 운영 문서에 실제 지원 작업과 필수 사용자 조치를 기록한다.

## Phase 6 — Unity·Unreal 빌드 확장 [상태: 진행 중]

- [ ] T-6.1 Unity 어댑터와 타깃별 실제 빌드·배포 연결 구현
- [ ] T-6.2 Unreal 어댑터와 타깃별 실제 빌드·배포 연결 구현

### T-6.1 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 5절과 Phase 6, 실제 Unity 버전·라이선스 조건.
- 원본 코드 참조: T-3의 공통 검사·러너·결과물, T-4·5의 스토어 연결.
- 구현 대상: `packages/engines/unity/`, 버전별 빌드 진입점·검수·시험 프로젝트.
- 검증 참조: V-03~06. Android/iOS/데스크톱 타깃별 빌드·서명·실행·기존 스토어 업로드, 라이선스·모듈·플러그인 누락과 Editor 충돌을 검증한다.
- 문서 반영: `docs/build-support.md`와 context에 지원 버전·호스트·플러그인 조건과 재현 자료를 기록한다.

### T-6.2 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 5절과 Phase 6, 실제 Unreal 버전의 UAT·타깃 도구 문서.
- 원본 코드 참조: T-3의 공통 실행 계약, T-4·5의 스토어 연결과 Mac 서명 경계.
- 구현 대상: `packages/engines/unreal/`, BuildCookRun·검수·시험 프로젝트.
- 검증 참조: V-03~06. Android/iOS/데스크톱 타깃별 cook·package·서명·실행·업로드, 플러그인·도구·공간 부족 오류를 검증한다.
- 문서 반영: `docs/build-support.md`와 context에 지원 버전·호스트·플러그인 조건과 재현 자료를 기록한다.

## Phase 7 — 수익화 설정과 수익 통합 [상태: 진행 중]

- [ ] T-7.1 스토어·광고 매출/정산 수집과 중복 없는 수익 집계 구현
- [ ] T-7.2 AdMob·MAX 광고 단위·미디에이션 운영 구현
- [ ] T-7.3 상품·구독·가격·판매 상태 운영 구현
- [ ] T-7.4 엔진별 광고·결제 SDK 탐지·지원 템플릿·실제 동작 검증

### T-7.1 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 4·8·10절, T-2.1의 재무 권한·원천 보고서 확인.
- 원본 코드 참조: T-2.3 공급자 연결, T-2.4 수집 작업, T-3.1 앱 매핑, T-4·5 스토어 커넥터.
- 구현 대상: Play·Apple·Steam·MAX·AdMob 보고 모듈, `packages/metrics/`, 수익 화면.
- 검증 참조: V-07. 원천 대조, 수정 보고서 재수집, 중복 미디에이션, 환불·수수료·다중 통화·시간대·미수집 값을 검증한다.
- 문서 반영: `docs/metric-definitions.md`에 필드·집계식·원천 우선순위·정산 주기를 기록하고 context에 연결한다.

### T-7.2 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 4·10·11절, T-2.1의 AdMob/MAX 읽기·쓰기 지원표.
- 원본 코드 참조: T-2.3 목적별 키 보관, T-2.4 변경 의도·정책, T-7.1 앱/광고 단위 매핑.
- 구현 대상: `packages/connectors/admob/`, `packages/connectors/applovin-max/`, 광고 단위·미디에이션 설정 화면.
- 검증 참조: V-06·V-07. 지원되는 생성·수정·조회 동작, 중복 생성 방지, 원격 변경 충돌, 잘못된 앱/네트워크 연결을 검사한다.
- 문서 반영: `docs/integration-capabilities.md`와 `docs/monetization-operations.md`에 작업별 지원·복구 근거를 기록한다.

### T-7.3 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 4·10·11절, T-2.1의 상품·구독·가격·판매 기능표.
- 원본 코드 참조: T-4·5 스토어 커넥터, T-2.4 정책·변경 의도·외부 상태 확인.
- 구현 대상: Play·Apple 상품/구독 관리, Steam 지원 판매/가격 작업, 수익화 상품·가격 화면.
- 검증 참조: V-06·V-07. 상품 등록·설정 변경 후 외부 상태 확인, 국가/통화·식별자 충돌·중복 재시도·즉시 적용 작업 경계를 검증한다.
- 문서 반영: 연동 기능표와 수익화 운영 문서에 플랫폼별 지원 작업·정책·예외를 기록한다.

### T-7.4 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 7·9·10절, T-4~6 엔진 지원표, T-7.2·7.3의 실제 리소스 매핑.
- 원본 코드 참조: T-3.1 SDK 검사, T-3.2 작업 복사본, 각 엔진 빌드 진입점. 기존 게임 SDK·구매 검증 서버가 있으면 이를 먼저 재사용한다.
- 구현 대상: SDK 탐지·통합 템플릿·패치 diff·연결 설정, 지원 엔진별 시험 광고/구매 프로젝트.
- 검증 참조: V-04·V-07. 광고·보상·구매·취소·복원·서버 검증 연결과 원본 보존을 실제 샘플에서 확인한다. 프로젝트별 미연결 게임 이벤트는 완료로 표시하지 않는다.
- 문서 반영: `docs/monetization-operations.md`와 빌드 지원표에 템플릿별 지원·시험 결과·필수 게임 내 연결을 기록한다.

## Phase 8 — 마케팅 집행과 자동 운영 규칙 [상태: 진행 중]

- [ ] T-8.1 Google Ads 캠페인·소재·예산·중지·성과 연동 구현
- [ ] T-8.2 AppLovin 광고 캠페인·소재·예산·중지·성과 연동 구현
- [ ] T-8.3 전환·귀속 연결과 수익성·광고 효율 지표 구현
- [ ] T-8.4 프로젝트별 자동 실행 정책·운영 규칙·변경 이력 구현

### T-8.1 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 4·8·11절, T-2.1의 Cloud 프로젝트 접근 수준·캠페인 유형 확인.
- 원본 코드 참조: T-2.3 OAuth, T-2.4 외부 효과·정책, T-3.1 프로젝트 식별과 출시 대상.
- 구현 대상: `packages/connectors/google-ads/`, 캠페인·소재·예산·성과 화면.
- 검증 참조: V-06·V-08. 시험/제한 계정의 생성·수정·중지·보고 대조, API 접근 수준 오류, 응답 유실·중복 쓰기·한도 밖 설정 차단을 검증한다.
- 문서 반영: `docs/integration-capabilities.md`, `docs/marketing-operations.md`에 계정·캠페인 유형별 지원과 테스트 범위를 기록한다.

### T-8.2 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 4·8·11절, T-2.1의 AppLovin Campaign Management 접근 및 Report Key 검증.
- 원본 코드 참조: T-8.1 공통 광고 화면/계약, T-2.3 인증, T-2.4 변경 의도. MAX 수익화 키와 구분한다.
- 구현 대상: `packages/connectors/applovin-ads/`, AppLovin 캠페인·소재·예산·광고 보고 연결.
- 검증 참조: V-06·V-08. 실제 허용된 계정으로 생성·수정·중지·보고, 서로 다른 목적의 키 혼용 방지, 중복 요청·한도 정책을 검증한다.
- 문서 반영: 연동 기능표·마케팅 운영 문서에 접근 제한·지원 작업·실서비스 검증 결과를 기록한다.

### T-8.3 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 10·11절, T-7.1 지표 정의.
- 원본 코드 참조: T-7.1 수익 수집, T-8.1·8.2 광고비·성과, 프로젝트에 기존 전환/측정 연동이 있으면 재사용한다.
- 구현 대상: `packages/metrics/` 귀속·집계, 측정 연결 설정, 캠페인·프로젝트 효율 화면.
- 검증 참조: V-07·V-08. 같은 유입 집단·귀속 기간만 ROAS 산출, 미귀속·미수집·통화 차이·지연 보정과 원천 보고 대조를 검증한다.
- 문서 반영: `docs/metric-definitions.md`에 전환 원천·집단·귀속 기간·정정 방식을 기록한다.

### T-8.4 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 3·8·11절, T-8.3 지표 품질 조건.
- 원본 코드 참조: T-2.4 정책·큐·이력, T-8.1·8.2 쓰기 동작, T-7.2·7.3 수익화 설정, 스토어 공개 상태.
- 구현 대상: 자동 실행 트리거·범위·예산 규칙, 이상 성과 중지·한도 내 재배분, 묶음 알림·예외 재개 화면.
- 검증 참조: V-02·V-06·V-08. 한 번 저장한 정책으로 반복 실행, 범위 밖 요청·신선하지 않은 데이터 증액·중복 증액 차단, 앱 미출시 광고 대기를 검사한다.
- 문서 반영: `docs/automation-policies.md`에 기본값·실행 조건·예산/소재/상품 변경 근거와 예외를 기록하고 context에 연결한다.

## Phase 9 — 무인 운영과 통합 출시 검증 [상태: 진행 중]

- [ ] T-9.1 상시 제어 장비·예약·장비 이전/복귀·통신 장애 처리 완성
- [ ] T-9.2 설치·업데이트·보존·백업/복구·진단 제공
- [ ] T-9.3 인증·권한·중복 실행·외부 충돌·비밀 보호의 통합 검증
- [ ] T-9.4 전체 요구 수용 검사와 30일 운영 관찰 후 출시 범위 확정

### T-9.1 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 6·8·11절, T-3.2 러너 프로토콜, T-8.4 정책.
- 원본 코드 참조: 제어 서비스·장비 연결·작업 소유권·OS 보관함·예약 처리의 실제 구현.
- 구현 대상: OS별 백그라운드 실행, 제어 장비 이전·재연결·소유권 이관·대기 작업 복구.
- 검증 참조: V-06·V-09. 화면 종료·컴퓨터 재부팅·절전·네트워크 단절·OS 보관함 잠김·제어 장비 변경 시 상태·예약·외부 캠페인 지속 상황을 검증한다.
- 문서 반영: `docs/operations.md`와 러너/보관함 문서에 상시 운영 조건·중단 영향·장비 이전 순서를 기록한다.

### T-9.2 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 6–8절, T-3.3 결과물 수명주기와 T-2.3 보관함 계약.
- 원본 코드 참조: 데스크톱 패키징·DB 마이그레이션·결과물 저장·자격 증명 구현.
- 구현 대상: 세 OS 설치 패키지·서명·업데이트, DB/결과물 백업과 검증 복원, 비밀이 제거된 진단 묶음.
- 검증 참조: V-02·V-09. 이전 버전에서 업데이트 후 로그인 재사용, 실패한 마이그레이션·가득 찬 디스크·백업 복원·새 장비 자격 증명 처리 검증.
- 문서 반영: `docs/operations.md`에 설치·업데이트·보존·복구 절차와 실제 검증 범위를 기록한다.

### T-9.3 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md)의 7·8·12절과 리스크, `docs/verification.md`의 실제 검사 명령.
- 원본 코드 참조: 인증·IPC·프로젝트 경로·러너 권한·모든 외부 쓰기·보고 수집 구현과 기존 핵심 테스트.
- 구현 대상: 필요한 장애 주입·권한·외부 충돌·비밀 유출 회귀 검사와 발견한 결함 수정.
- 검증 참조: V-02·V-04·V-06~09. 쓰기 전후 강제 종료, 두 러너·두 프로젝트의 경쟁, 권한 취소, 로그/스냅샷 비밀 노출, 외부 수동 변경을 실제 경계에서 검사한다.
- 문서 반영: `docs/verification.md`와 context에 수행/미수행 검사·실패 원인·잔여 위험을 기록한다.

### T-9.4 참조 블록

- 작업 전 필독: [개발계획](app-operations-platform-plan.md) 전체, 모든 Phase 결과, 최신 연동 기능표·빌드 지원표·운영 절차.
- 원본 코드 참조: 전체 사용자 흐름의 실제 구현과 T-9.3 검증 결과.
- 구현 대상: 전체 수용 시나리오·30일 관찰 기록·최종 사용자 안내·지원 범위 문서.
- 검증 참조: V-01~10. R-01~10과 각 스토어·엔진·광고·수익화 쓰기/조회/동작의 실제 근거를 대조한다. 필수 예외와 결함을 구분하고 장기 관찰을 모의 테스트로 대체하지 않는다.
- 문서 반영: 완료 조건이 모두 충족된 경우에만 tasks/context와 카탈로그를 종결하고 Dev Docs를 archive로 이동한다. 미충족이면 해당 항목과 다음 행동을 유지한다.

## Phase 10 — 빌드 자격 증명 [상태: 진행 중]

- [ ] T-10.1 SSH·Android 키 등록·검증·버전·회전·프로젝트 연결
- [ ] T-10.2 격리된 SSH 의존성 준비·Android 서명·산출물 증명
- [ ] T-10.3 키 관리 화면·사용 중 삭제 보호·실패/취소 복구 검증

### T-10.1~3 참조 블록

- 작업 전 필독: [v2 R-11·V-11](app-operations-platform-plan-v2.md), [인증 수명주기](../../../docs/credential-lifecycle.md), [빌드 지원표](../../../docs/build-support.md).
- 원본 코드 참조: `packages/credentials/`, `packages/domain/`, `apps/controller/service.ts`, `apps/runner/`.
- 구현 대상: `packages/build-credentials/`, 제어 서비스 키 API·프로젝트 연결, 데스크톱 설정·빌드 화면, 관련 실제 도구 검증.
- 검증 참조: V-11. 생성한 테스트 키로 올바른/틀린 암호, 지문, 암호문 저장, 키 회전·버전 고정, 원본·로그·산출물의 비밀 배제, 취소 정리, 실제 서명 검증을 수행한다.
- 문서 반영: 빌드 지원표·인증 수명주기·검증 기록과 context에 지원 도구·OS·잔여 제약을 동기화한다. [빌드 키 관리](../../../docs/build-credentials.md)에 실제 구현·도구 검증을 기록했다.

## Phase 11 — SNS·커뮤니티 [상태: 진행 중]

- [ ] T-11.1 X·Threads·Steam 인증·갱신·공식 채널 어댑터
- [ ] T-11.2 내구성 있는 예약·출시 공지·발행 조정·중복 방지
- [ ] T-11.3 댓글·반응·답변 정책·프로젝트 연결·운영 화면
- [ ] T-11.4 소셜 통합 장애 검사·실계정 검증·지원 문서

### T-11.1~4 참조 블록

- 작업 전 필독: [v2 R-12·V-12](app-operations-platform-plan-v2.md), [이력·복구 계약](../../../docs/workflow-contract.md), [운영 정책](../../../docs/automation-policies.md).
- 원본 코드 참조: `packages/connectors/types.ts`, `packages/credentials/`, `packages/storage/`, `apps/controller/automation.ts`.
- 구현 대상: `packages/social/`, 소셜 큐·예약·계정 연결, 커뮤니티 UI, `tests/social-connectors.test.ts`, `docs/social-operations.md`.
- 검증 참조: V-12. 공식 OAuth·게시·조회 페이로드, 토큰 갱신·회전, 계정/프로젝트 범위, 예약 재시작, 응답 유실·부분 성공, 댓글을 정책으로 실행하지 않는 경계, 빈도 한도. 실제 외부 게시 검증은 계정이 제공된 별도 시나리오로 구분한다.
- 문서 반영: 공급자별 실제 지원 기능·공식 근거·Steam 쓰기 제약·검증 결과를 [소셜 운영 문서](../../../docs/social-operations.md)와 context에 연결한다. [연동 기능표](../../../docs/integration-capabilities.md)에 채널별 현재 범위를 기록했다.


## Phase 12 — 데모·실제 운영 통합 [상태: 완료]

- [x] T-12.1 공통 실행 계약·격리된 영속 데모·오류 상황 구현
- [x] T-12.2 전체 관리 화면·대시보드·출시 파이프라인 구현
- [x] T-12.3 스토어 자료·심사 및 광고·SNS 공식 작업 확장
- [x] T-12.4 운영 준비·러너·설정·백업/복구·진단 구현
- [x] T-12.5 통합 검사·실제 브라우저·패키지·독립 리뷰

완료 근거: [데모 실행 계약](../../../docs/demo-execution-contract.md), [지원 범위](../../../docs/integration-capabilities.md), [최종 검증](../../../docs/verification.md). 전체 계획의 실계정·실기기 수용 검사는 이 완료에 포함하지 않는다.

## Phase 13 — 설치 후 운영 준비 완성 [상태: 진행 중]

- [ ] T-13.1 프로젝트별 준비 진단·실행 전 점검·최초 설정 화면
- [ ] T-13.2 엔진·SDK 설치·영속 설정·실패 복구·라이선스 단계
- [ ] T-13.3 macOS/Windows 빌드 격리·취소·플랫폼 서명
- [ ] T-13.4 광고·결제 SDK 적용·게임 이벤트 연결·검증·되돌리기
- [ ] T-13.5 네이티브 기동·백그라운드 제어 서비스·자동 시작·업데이트
- [ ] T-13.6 전체 데이터·암호화 자격 증명 백업/이전·무결성·복구
- [ ] T-13.7 스토어 미디어·앱 매핑·광고/수익 운영 준비 보완
- [ ] T-13.8 실제 도구·화면·패키지·독립 리뷰·준비 수용 검사

### T-13.1~8 참조 블록

- 작업 전 필독: [v4](app-operations-platform-plan-v4.md), [맥락](app-operations-platform-context.md), [현재 지원 범위](../../../docs/integration-capabilities.md).
- 원본 코드 참조: `packages/setup/`, `packages/engines/`, `packages/project-integration/`, `packages/lifecycle/`, `apps/controller/`, `apps/desktop/`.
- 구현 대상: 프로젝트별 준비 근거·설치/연결·SDK 변경 저널·OS 격리·상시 실행·전체 백업과 같은 API를 사용하는 데모/실제 화면.
- 검증 참조: 설치 무결성/경로·취소·재시작, 프로젝트별 누락 진단, SDK 충돌/롤백, 비밀/호스트 접근 차단, 백업 무결성/외부 작업 재실행 방지, 실제 브라우저·Linux 도구·패키지. Mac/Windows·실계정 미실행은 구별한다.
- 문서 반영: 새 기능별 문서와 `docs/verification.md`, 이 작업 목록·맥락·카탈로그에 실제 증거를 반영한다. 기존 계획과 v3 검증 이력은 보존한다.

22:50 체크포인트: 실제 네이티브 창/명시적 중지·재시작, 공식 JDK 실행, 설치·SDK·보관함 보호 집중 검사를 확인했다. 전체 백업 암호화·SQLite/키 이전 집중 검사 3개는 통과했으나 활성화/API/UI와 SDK 후속 P0가 남아 T-13 체크는 유지한다. [맥락](app-operations-platform-context.md).

23:39 체크포인트: 전체 백업 API/스트리밍/기동 전 전환/실패 롤백/프로젝트 재연결을 연결했다. 엔진·복원 20/20, 타입/빌드 통과. 보관함 동시성 수정·SDK 후속 수정·파일 전송/전체 복원 독립 리뷰 및 새 네이티브/패키지 검증이 남아 T-13 체크는 유지한다. [맥락](app-operations-platform-context.md).


## Phase 14 — 실사용 검토 후속 수정 [상태: 완료]

- [x] T-14.1 확정 거절의 안전한 복구와 실제 결과 불명의 수동 종결
- [x] T-14.2 공유 스토어 계정의 프로젝트별 동기화·수동 조회 선택
- [x] T-14.3 성공한 전체 캠페인 목록에서 삭제와 예산 예약량 반영
- [x] T-14.4 실제 공개 전환 관측·초기 과거 버전 제외·공지 중복 방지
- [x] T-14.5 외부 AAB/APK/IPA/Steam 결과물 가져오기·보관·무빌드 업로드·UI
- [x] T-14.6 Apple 이미지/검증 정합성·회귀 검사·화면 확인·문서 반영

Acceptance: [v5](app-operations-platform-plan-v5.md)의 이번 완료 조건을 충족했다. 외부 공급자 쓰기 없는 모의/임시 데이터 검증을 실계정 검증과 구별한다. 문서 반영: [사용법](../../../docs/external-artifacts.md), [복구 계약](../../../docs/workflow-contract.md), [정책](../../../docs/automation-policies.md). 검증 참조: [434/434 및 27/27·타입·컴파일·실제/데모 화면 증거](../../../docs/verification-assets/operational-fixes-20260912.md).
