# 앱 운영 자동화 작업 맥락

Last Updated: 2026-09-22

## Current Execution Contract

- 최신 체크포인트 완료(2026-09-22): Mac→Docker Linux Godot 빌드·Mac 결과물 회수·Linux 격리 게임 실행과 Mac SSH/Android 키 등록·AAB/JAR 서명·SSH fetch를 실측했다. 최종 소스 500개 검사에서 Mac 485 통과/15 skip, Linux 491 통과/9 skip, 양쪽 실패 0·타입·빌드 통과. 최종 이미지의 실제 키·daemon·큐/API 통합 26/26 통과. 이미지 context 53파일이 현재 소스와 일치한다. [근거와 사용법](../../../docs/verification.md#2026-09-22-macos-dockerlinux-실행과-sdk-이식성).
- 독립 리뷰 해소: SDK `ctx_dbcce36ce12a`의 명시 SDK 루트 누락 skip 결함은 회귀 14/14. Docker A/B `ctx_099fae02d0a1`의 daemon 전환 정리 오인과 큐/API 정리·commit 기록 소실 2건은 daemon pin 회귀 3/3, 소비자 31/31·취소 영향 52/52 및 최종 통합 26/26으로 해소했다. 기존 외부 쓰기 취소 fencing은 유지하고 실행 중 build만 정리를 기다린다. 제한된 GUI PATH의 실제 SSH 양성·암호 음성도 통과. 생성한 Grok/Astra 워커 터미널은 모두 정확히 종료하고 release/ack했다. 커밋·푸시·실서비스 변경은 하지 않았다.
- 2026-09-22 워커 지정 변경 이력: 사용자가 `gpt astra ultra fast`를 명시했다. 진행 중 Grok 터미널 3개는 fence 후 정확한 터미널 종료(`ptyKilled`)와 release를 확인했고 Docker 설계와 완료 SDK 코드를 인계했다. 새 Codex CLI의 실제 실행 화면에서 `gpt-6-astra ultra fast`를 확인했다. 같은 Run의 독립 설계 검토 `task_d6c7baa905ac / ctx_1d41950a44ea`, Docker 구성 `task_22350a24a5ed`, 키 helper `task_1057e284f74c`를 새 지정으로 완료했다. 아래 Grok 기록은 이전 단계 이력이다.
- 2026-09-22 후속 범위: 사용자가 macOS와 Linux 모두 실제 동작하도록 구현을 요청했다. 이전 skip 분류만으로 완료하지 않는다. 기존 v9 종료/v8 AI UX는 유지하며 Linux 전용 빌드/키 격리의 macOS Docker 지원과 공식 SDK 검증 도구의 호스트 이식성을 구현한다. Run `run_56e46ef2061d`, 현재 워커 지정은 `gpt-6-astra ultra fast`; 초기 Grok 보안 검토 `ctx_6515fdc67baa`·SDK 구현 `ctx_528fd598e42f`는 이력이다. root는 Linux 실행 환경·통합·문서를 담당한다. 새 계획 파일은 만들지 않고 이 실행 계약을 현재 요청의 기준으로 삼는다.
- 현재 완료 조건: 두 OS의 실제 파일·프로세스로 격리/키/SSH/SDK 경로를 확인하고 회귀·타입·빌드·독립 리뷰를 마친다. 보안 미지원 경로의 무격리 실행, 일반 디스크 평문 키 fallback, 관리자 권한/호스트 보안 설정 변경, 실계정 게시·배포·커밋·푸시는 하지 않는다. 기존 dirty 변경은 모두 보존한다.
- Linux 검증 준비 이력: Docker Linux aarch64의 전용 컨테이너에서 bwrap/JDK17/SSH를 실행했다. 중첩 격리에는 `SYS_ADMIN`, 기본 seccomp에 `pivot_root`만 추가한 프로필과 전용 컨테이너의 systempaths 해제가 필요했다. 기존 컨테이너/호스트 설정은 변경하지 않았다. 초기 키·러너·SSH 20 통과/0 실패/반대 조건 skip 1. 전체 기준선의 fixtures 누락·init 없는 zombie 회수 문제 4건은 `--init` 컨테이너에서 관련 35개 통과로 해결했다. 최종 Linux 491/500 통과와 타입·빌드를 완료했으며 이번에 생성한 준비/검증 컨테이너 3개와 검증용 Compose 컨테이너·네트워크·volume·연결 코드만 정리했다. 제품 이미지 `appops-linux-runner:local`, 공개 SDK 도구와 증거 로그는 남긴다.
- macOS 사전 검토 결과: native sandbox의 홈·네트워크 차단과 사용자 권한 RAM 디스크 생성/마운트/600 파일/정리를 실측했으나, setsid 자식은 그룹 취소를 벗어났고 좁은 파일 읽기 프로필은 실행 전 SIGABRT였다. 광범위한 파일 읽기 허용은 수용하지 않았다. 사용자가 Docker 등 추가 실행 환경을 명시 승인해 native RAM 제품 구현은 중단하고 기존 Linux bwrap/tmpfs 실행의 재사용으로 전환한다. Mac 기본 격리 guard는 유지한다. Docker 원격 러너 구성은 `ctx_bf2729fae3b9`, stdin 기반 키 helper는 `ctx_9622bc73df96`, 컨테이너 경계 사전 독립 검토는 `ctx_c02b32ab9ac1`이 담당한다. iOS/Xcode와 라이선스 엔진 전체 지원을 Linux Docker 지원과 혼동하지 않는다.
- 공식 SDK 후속 완료: 고정 해시 Unity IAP/MAX/Billing/Godot 준비 스크립트, Linux ARM64 Godot variant, AppleDouble 경로·크기 한도, portable tar fixture, 빈 환경값 거부와 acknowledgePurchase 단언을 추가했다. Mac SDK 집중 5/5, Linux SDK·다운로드 26 통과/0 실패/Android ARM64 미지원 skip 1. 독립 리뷰의 명시 경로 누락 결함 수정과 최종 양 OS 회귀도 완료했다.
- 2026-09-22 현재 체크포인트 완료: 핵심 잔여 요청의 macOS 검사 안정화(T-13.8)·CLI/MCP 기본 진단 구현·통합 검증·별도 Grok 최종 리뷰를 마쳤다. 필수 결함 없음. 기존 v8 요청 UX·v9 종료 계약과 미커밋 종료/UI 변경을 보존했다. 사용자 지정 Grok CLI `grok-4.7 / high` 구현 워커 2개, 별도 리뷰 세션 1개와 root 통합으로 진행했다. Orca Run `run_37ab7b1b2873`; 구현 Dispatch `ctx_e0063e7f640c` / `ctx_d5b08fbf2609`, 최종 리뷰 `ctx_e1a5d8e93903`. 실서비스 쓰기·커밋·푸시와 2차 성장 운영 구현은 범위 밖이다.
- 검증: 기준선 455개(413 통과·36 실패·6 skip) → 최신 통합 468개(452 통과·실패 0·16 skip), 타입·빌드 통과. 26개 실패는 경로/테스트 전제 수정, 10개는 실행 불가능한 실제 도구 검사로 구분했다. CLI 도움말·실제 MCP 프로세스 경계는 통과했으나 로그인/모델 응답은 검증하지 않았다. [근거](../../../docs/verification.md#2026-09-22-macos-검사-안정화climcp-진단). 로그는 `tmp/core-stability-20260922/`, `tmp/agent-cli-20260922/`다.
- 유효 계획: [v9](app-operations-platform-plan-v9.md) → [tasks](app-operations-platform-tasks.md) → 이 context. v1–v8은 이력으로 보존한다. v8의 AI 요청 계약은 유지한다.
- 2026-09-13 종료 수정 완료: macOS 포함 마지막 창 닫기·앱 종료·SIGINT/SIGTERM에서 제어 서비스와 AI/작업 정리를 기다린다. 기동·재시작 Promise를 추적해 늦은 고아 프로세스를 막고 HTTP 종료 후에도 PID 소멸을 확인한다. 서비스는 AI·설치·백업·큐·스케줄러 정리를 함께 시작한다. 화면 로딩 중 닫기에 따른 예상된 로드 취소도 처리했다. 관련 검사 52/52·데스크톱 23/23·타입·빌드 및 실제 Electron 종료 3개 시나리오, 모드 전환 회귀 통과. [근거](../../../docs/verification.md#2026-09-13-앱-종료-시-프로세스-정리). 이번 요청은 커밋하지 않았다.
- 사용자 확정: 요청 흐름은 사용자가 직접 재설계한다. 이번에는 AI 요청 버튼의 임의 실행만 제거한다. 버튼은 현재 화면·선택 대상을 전달해 기존 채팅만 연다. 고정 요청·작업 후보·새 승인 단계는 추가하지 않는다. 채팅 전송만 실행이며 클리어 전 native CLI ID로 resume, 클리어 뒤 다음 요청만 새 세션이다.
- 2026-09-13 요청 수정 완료: `SCREEN_REQUESTS`는 화면 이름만 보관한다. `/agent/requests`는 실제 메시지를 필수로 검증하고 빈 요청에 세션을 생성하지 않는다. 전송 시 현재 화면/대상을 전달하며 기존 대화를 이어 쓴다. CLI 지시에서도 화면 정보나 분석 질문을 설정/등록 실행으로 확대하지 않도록 정정했다. AI 19/19·데스크톱 23/23·타입·빌드 통과, 12개 화면 버튼 열기/닫기 실행 0건과 명시적 전송을 Electron에서 확인했다. [검증](../../../docs/verification.md#2026-09-13-ai-요청-자동-전송-제거).
- 완료: Phase 15 요청 기반 CLI/MCP 도구·채팅·화면 버튼·자료 결과와 검증. 프로젝트별 대화와 전체 운영 대화는 각각 native ID/제공자/대화/요청 범위를 SQLite에 저장한다. 제공자 고정, ID 누락 시 새 세션 fallback 차단, clear 중 재요청 차단과 늦은 콜백 격리, 새 작업 디렉터리를 적용했다.
- 2026-09-13 후속: Electron 탐색 차단이 자체 reload까지 막던 모드 전환 멈춤을 수정했다. `main.ts`에서 기존 신뢰 URL 판정을 재사용한다. `scripts/verify-desktop-mode.mjs`가 실제 IPC/페이지 재로딩/모드 분리를 검증한다(수정 전 5초 실패, 수정 후 40~393ms). 관련 23/23·타입·빌드 통과, 일반 앱 재실행 완료. [검증과 재현](../../../docs/verification.md#2026-09-13-electron-모드-전환-멈춤). 이 수정의 남은 항목은 없으며 기존 장기 수용 범위는 그대로다.
- 등록 요청 범위: 실제 프로젝트 근거·문구·PNG 생성, 기존 계정/앱 매핑·큐 재사용. 문구 반영과 이미지 업로드 근거가 있어야 등록 완료다. 브라우저/이미지 도구는 CLI 설정을 활용하며 도구 부재·로그인·계약·알 수 없는 필수값만 요청한다. 원본 수정·빌드·심사·공개·광고·SNS 전송은 제외한다.
- 수정 파일 이유: packages/agent는 실행·이벤트·MCP·자료/이미지 검증, controller/agent는 영속 세션·도구/실행 경계, service/server/storage는 수명주기·API·저장, AgentPanel/AgentActions/App와 각 view는 채팅·요청과 선택 전달, Electron security는 새 API 경로다. main의 기존 isTrustedSender 무한 재귀는 실제 native IPC 실패를 재현한 뒤 isTrustedFrame으로 고쳤다.
- 2026-09-13 과거 검증: 관련 25/25, 타입·빌드 통과. 당시 전체 451개: 409 pass / 36 fail / 6 skip, 깨끗한 HEAD에서도 같은 36개 실패였다. 최신 전체 검사 결과는 위 2026-09-22 기록을 따른다. macOS Electron 창에서 버튼·선택·채팅·클리어·재기동 보존·PNG 결과·배치를 확인했다. [당시 근거](../../../docs/verification-assets/ai-requests-20260913.md).
- 2차 기획: [성장 운영 v2](../ai-growth-operations/ai-growth-operations-plan-v2.md). Orca Sol/high 워커 2회 dispatch로 문서만 작성·보완했고 해제/ack 완료. 광고 실험·수익률·커뮤니티 주기 실행은 구현하지 않았다.
- 남은 제한: 실제 CLI 모델 호출·인증, CLI의 browser/image 도구, 스토어 실계정, Windows·Linux 데스크톱 GUI, Xcode/iOS·Unity/Unreal·설치 가능한 Android 앱·APK SDK 도구·장기 운영은 미검증이다. Linux tmpfs/bwrap와 Mac Docker·공식 SDK는 위 실측으로 구분한다. 새 설치 패키지에서 Docker UI를 실행한 증거는 없으며 seccomp 리소스 포함 계약과 제한된 GUI PATH만 확인했다. Vite 500 kB 청크 경고가 있다.
- 기존 다른 작업자의 ui.tsx/styles.css 변경은 커밋에서 제외해 보존한다. 사용자 요청에 따라 모드 수정과 AI 요청 수정을 별도 커밋하며 push/외부 게시하지 않는다. 기존 검증 자료는 tmp/ai-requests-20260913, 이번 화면 증거는 tmp/ai-request-review-20260913에 둔다.
- 다음: 이번 양 OS Docker/키/SDK 체크포인트의 필수 잔여는 없다. 후속은 새 설치 패키지의 실제 UI 수용, Xcode/라이선스 엔진/Android SDK가 필요한 경로, 실제 CLI 로그인·모델 응답과 실계정·장기 수용이다. 실서비스 반영은 별도 명시 승인 범위에서만 수행한다. 제품 이미지가 준비된 이 작업 폴더에서는 `docker compose -f docker/runner/compose.yaml up -d --no-build --wait --wait-timeout 1800`으로 Linux 러너를 다시 띄울 수 있다. 최초 템플릿 다운로드와 연결 코드 등록은 [러너 사용법](../../../docs/runner-protocol.md)을 따른다.

### 2026-09-12 — 이전 실행 계약 (이력)


- 프로젝트명·GitHub 저장소명: `gameStudioAutomaiton` (사용자가 지정한 철자 그대로). 소유자는 현재 인증된 `sphacker83`, 공개 범위는 private. 사용자 2026-09-12 지시로 이름 반영 후 커밋·최초 푸시를 진행한다. 앱 표시명·패키지 메타데이터를 통일하며 기존 데이터/키 보관함 식별자는 호환성을 위해 유지한다. 이름 변경 검증: 타입 검사·운영 앱 컴파일·패키징 메타데이터 읽기 통과.
- 유효 plan: [v5](app-operations-platform-plan-v5.md). v1~v4는 이력으로 보존한다. 재개 순서: v5 → [tasks](app-operations-platform-tasks.md) → 이 context.
- 이번 요청: 계정 연결 완료를 가정한 실사용 검토에서 보고한 항목을 수정한다. 게임 빌드는 외부에서 수행한다. Phase 14의 운영 오류·외부 결과물 경로·Apple 검사 후속 수정과 검증을 완료했다.
- 기존 전체 작업: Phase 13 및 Phase 2–11의 실계정·OS·장기 수용 조건 42개는 남아 있다. 총 14/56(25%)은 체크리스트 완수율이며 제품 구현률이 아니다. 이번 후속 수정 완료와 전체 장기 개발 완료를 구별한다.
- 금지 사항: 모의/데모 결과를 실서비스 검증으로 표시하지 않는다. 사용자 비밀 탐색·검증용 외부 배포/게시/광고 집행·고정 계획 덮어쓰기 금지. 개발 검증 당시에는 Git 저장소가 없었다. 이후 사용자 커밋·푸시 요청으로 main 저장소를 초기화했다. 최신 커밋·원격 상태는 git status/log/remote로 확인한다. 미리보기 인증 정보는 출력하지 않는다. 이번 후속 수정은 root가 단독 수행했다.

## SESSION PROGRESS

### 2026-09-22 — macOS 검사 안정화·CLI/MCP 기본 진단

- 결정: 실제 제품은 Store/서비스 기동에서 canonical 경로를 사용하므로 `/var` 별칭 예외를 추가하지 않는다. 독립 경로 리뷰를 받아 fixture만 realpath로 정리했다. Linux 전용 키/격리 거절 계약은 유지한다.
- 변경: build-credentials의 메모리 저장소 가용성 판정과 테스트 경로·환경 전제를 정리했다. SDK 생성 코드 검사를 외부 도구 실행 검사와 분리했으며 명시적으로 잘못 지정한 SDK/Godot 경로는 실패한다.
- 진단: 새 `scripts/verify-agent-cli.ts`는 설치 CLI의 신규/resume 도움말과 실제 MCP 읽기/거절 전달을 확인한다. 모델 호출·로그인·실세션 성공을 주장하지 않는다. 관련 7/7, 전체 452 통과·실패 0·16 skip, 타입·빌드 통과.
- 상태: 구현·독립 리뷰 완료, 모든 Dispatch release/ack 및 생성한 Grok 터미널 정리. 최종 리뷰 `ctx_e1a5d8e93903`의 필수 결함 없음. acknowledge 검사 보강·빈 SDK 환경값 처리·tmpfs 오류 원인 구분은 선택적 후속으로 남긴다. [검증 기록](../../../docs/verification.md#2026-09-22-macos-검사-안정화climcp-진단). 기존 장기 체크리스트 19/61은 유지한다.

### 2026-09-12 — 실사용 검토 후속 수정 완료

- 완료: 첫 변경 요청의 확정 거절과 결과 불명을 분리, 수동 서비스 확인 근거 기록, 프로젝트별 스토어 sync-app, 전체 캠페인 목록의 삭제 반영, 실제 공개 전환 기록/공지, 외부 결과물 가져오기/업로드 화면·API·재시작 경로. Apple 이미지 async/fixture와 신규 데모 자동 동기화의 시나리오/백업 경합을 수정했다.
- 핵심 결정: 외부 결과물은 별도 imported-artifact 문서와 artifacts/import-UUID 경로에 보관한다. 내부 build 이력을 위조하지 않으며 원본/엔진을 요구하지 않는다. 모바일 앱 ID·버전·서명 정보 포함 여부를 읽고 업로드 직전에 해시를 재검사한다. 서명 신뢰 검증은 스토어에 맡긴다. Steam 내부 링크는 실제 파일로 복사하고 외부/순환 링크는 차단한다. 첫 공개 목록은 기준선, 이후 공개 전환은 provider/app/version으로 중복 방지한다.
- 수정 파일 이유: service/queue/storage/transport는 효과 기록·복구·원자적 목록 저장, release-observations/social-automation/automation은 관측과 스케줄, imported-artifacts/android-artifact는 읽기/복사/귀속, pipelines/PublishFlow/ActionForm/ArtifactPicker/api/Electron은 외부 결과물 사용자 흐름, tests는 회귀 근거다.
- 검증: 전체 `npm test` 434/434, 마지막 관련 검사 27/27, `npm run typecheck`·`npm run build` 통과. Chromium에서 데모와 실제 모드 모두 가져오기→무빌드 업로드 완료, 실제 모드 수동 확인 결과 저장을 검증했다. 실제 파일 복사 API+임시 DB+메모리 보관함+모의 커넥터이며 실서비스 전송 0건. [전체 증거](../../../docs/verification-assets/operational-fixes-20260912.md).
- 검사 정리: SDK 실설치 테스트에서 취소 후 installer.close 이전에 임시 폴더를 지우는 hook 순서 경합을 수정했다. SDK 제품 동작 변경 없이 전체 검사 통과. 기존 수정 전 재현 스크립트는 before-fix.mts로 보존하고 현재 회귀 검사는 tests/operational-fixes.test.ts와 tests/imported-artifacts.test.ts로 분리했다.
- 문서: [외부 결과물 사용법](../../../docs/external-artifacts.md), [실행/복구 계약](../../../docs/workflow-contract.md), [운영 정책](../../../docs/automation-policies.md), 검증 색인·tasks·catalog를 갱신했다. 기존 AppImage는 새 패키지가 아니며 dist는 운영 앱 컴파일 결과로 갱신했다.
- 다음: 이번 수정 범위의 남은 항목은 없다. 이후 실계정 검증 또는 기존 Phase 2–13의 미완료 수용 항목을 요청받으면 해당 범위부터 재개한다. 기존 워커 서술은 아래 과거 세션 이력이며 이번에 위임하지 않았다.

### 2026-09-12 — 계정 연결 완료·앱 내부 빌드 제외 조건의 실사용 검토

- 완료: [운영 검토](../../../docs/verification-assets/operational-review-20260912.md), [재현 코드](../../../docs/verification-assets/operational-review-20260912.before-fix.mts), [결과](../../../docs/verification-assets/operational-review-20260912.json)를 기록했다. 확정 거절된 X 게시의 정리/한도 차단, Play 다중 앱 동기화 누락, 삭제된 Google Ads 캠페인의 예산 점유, 실제 공개 작업의 자동 공지 누락을 재현했다.
- 검증: 선택한 기존 검사 262개 중 258 통과·Apple 이미지 4 실패, 전체 typecheck는 테스트의 Promise 접근 오류 3개로 실패. node tsconfig는 통과. 정상 PNG 검사 통과, `/tmp`에서 픽셀·await만 교정한 Apple 검사는 5/6으로 예약 재사용 기대 불일치 1개가 남는다. 자세한 명령·로그는 보고서에 있다.
- 결정: 사용자는 이 앱에서 빌드하지 않는다. 이번 검토에서 엔진/격리/서명 도구 미완성은 결함으로 세지 않았다. 다만 현재 배포가 내부 빌드 이력을 필수로 요구하므로 외부 결과물을 가져와 배포할 사용 경로가 필요하다. 기존 고정 계획은 수정하지 않았다.
- 변경: 검토 자료 및 검증 색인·tasks/context·카탈로그만 갱신했다. 제품 코드·기존 테스트·실제 데이터는 수정하지 않았고, 외부 게시/광고 집행은 하지 않았다. 현재 세션에서는 워커를 사용하지 않았다.
- 다음: 수정 요청 시 보고서 1~3의 복구/동기화 문제부터 재현 조건을 유지해 보완하고, 실제 공개 공지와 외부 결과물 등록 흐름을 연결한다. T-2.4/T-4.2/T-7.1/T-9.1/T-11.2/T-11.4/T-13.7~8의 잔여 항목이며 체크리스트 8/50은 유지한다.

### 2026-09-11 23:39 KST — 전체 백업 API·복원 전환·실패 롤백 연결

- root: 전체 백업 생성/목록/스트리밍 내보내기·가져오기/복원 준비/전환 API와 AppService 유지보수 잠금·취소를 연결했다. `packages/backup/activation.ts`는 인증된 전환 저널·단계별 원자적 rename·준비된 파일 해시·기존 데이터/키 보존·기동 실패 롤백을 사용한다. Store를 열기 전에 복원하고, 시작 검사가 실패하면 이전 데이터로 되돌려 서비스를 다시 기동한다. 데모는 별도 Store만 교체한다.
- 검증: 원본 키/새 키 보존, 살아 있는 제어 서비스 차단, 준비 후 변조 거부, 두 rename 경계에서 프로세스 강제 종료 후 복구, HTTP 백업/재시작 복원 후 외부 호출 0건, 데모 binary 내보내기/가져오기/복원, 기동 실패 후 이전 서비스 재시작을 확인했다. 전체 백업 제어 검사 7개와 엔진 검사 13개 **20/20 통과** (`/tmp/appops-v4-backup-engine-tests.log`). 타입 검사·빌드 통과(`/tmp/appops-backup-typecheck3.log`, `/tmp/appops-v4-backup-build.log`). 최종 전체/실제 파일 대화상자 검사는 남았다.
- UI: Opus4.8 전체 백업 패널/네이티브 스트리밍 bridge를 회수했다. root가 imported 파일의 검증 대기 표시, 재시작 실패를 성공으로 표시하던 문제, 실제 committed 상태 확인·데모 새로고침, 프로젝트 원본 폴더 재연결 API/UI를 보완했다. SDK 조회는 복원 전 원래 장비의 경로를 읽지 않는다. 실제 네이티브 창은 새 빌드 검증 중이다.
- 도구: Grok이 Android 공식 다운로드의 gzip Content-Length 혼동을 고쳤다. 실제 direct downloadVerified 파일 181,833,628 bytes, SHA256 `4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583` 확인(`/tmp/appops-download-verified-cmdline.json`). 실제 sdkmanager로 API36/build-tools36.0.0/platform-tools37.0.1 및 라이선스 영수증을 확인했다(`/tmp/appops-setup-real-result.json`). 다운로드·네이티브 파일 bridge·Apple media는 독립 검토 중이다.
- 독립 검토: Opus5 [백업 암호화 리뷰](../../../docs/verification-assets/v4-backup-crypto-review.md)에서 동시 Vault 인스턴스의 키 덮어쓰기, 쓰기/읽기 구조 불일치, 낮은 KDF 비용 등 발견. Opus4.8 `task_5eb7fe800c8a / ctx_337944f83812 / term_5854f08c-1abe-4836-a5d6-69d726597b39`가 archive/vault 수정 중(root가 이 파일을 수정하지 않는다). 원시 암호화 검토와 전체 복원 수용은 구분한다.
- SDK: Sol high `task_ff018d0192ab / ctx_7974001a7816 / term_4fef614e-93a7-4e06-8b9d-15e9a94cafe0`가 Unreal/Godot/Unity/iOS API 교정과 완전한 PBX fixture를 구현·검증 중. Unreal quantity 인수 추가 승인. MAX 실행 시 키 전달·구매 검증 서버·실기기 검증·SDK 준비 근거 연결은 root 후속이다.
- Apple: Grok 스크린샷 set/reserve/upload/commit/poll 코드와 6 HTTP 검사 회수. root는 service 재조정에 appScreenshotId를 연결했다. capability 필드가 공통 ActionForm으로 나타나므로 실제 화면에서 확인한다. 미리보기 동영상은 미구현. 해당 Grok dispatch와 외부 터미널은 release 후 close했다.
- 리뷰 워커: Sol high `task_79b7927c57b1 / ctx_466041932928 / term_f25630c6-f25d-49cc-9726-cf5697a3671a`가 다운로드/Apple 스크린샷/네이티브 backup bridge를 read-only로 검토, 보고서 `docs/verification-assets/v4-transfer-review.md` 예정. root의 activation/snapshot/server는 별도 독립 리뷰가 필요하다.
- 다음: 현재 워커 결과 수용·즉시 재사용/해제, 전체 복원 독립 리뷰, 실제 백업 창/파일 bridge 확인, Gradle 의존성 준비·OS 격리/서명·SDK 검증 연결·남은 스토어 기능, 새 패키지/전체 검증. v3 산출물을 v4 완료품으로 제공하지 않는다.

### 2026-09-11 22:50 KST — 실제 네이티브 앱·공식 JDK 확인, 전체 백업 구현 중

- 실제 앱: 샌드박스 preload의 ESM import 때문에 window.appOps가 없던 P0를 재현했다. `scripts/build-preload.mjs`의 esbuild CommonJS 번들과 `preload.cjs` 경로로 수정한 뒤 실제 Electron 창에서 데모 9계정/5프로젝트와 운영 준비 화면을 확인했다. Node API는 renderer에 노출되지 않는다. [실제 창](../../../docs/verification-assets/v4-native-setup.png). 창 종료 후 controller4321 유지·재실행 인수·데모 중지 거부·실제 모드 명시적 중지/IPC 재시작 성공을 확인했다. 최초 실제 모드 확인 모달을 누르기 전 관찰은 모드 키 오류가 아니었다.
- 설치: GNU/oldgnu/PAX/ustar, Unicode PAX 바이트 길이/패딩, 내부 JDK 라이선스 링크를 일반 파일로 복사하는 제한 경로, ZIP CRC·Windows 예약 경로 방어를 추가했다. 공식 Temurin21 전체 파일(해시 검증)을 실제 추출하고 java/javac 21.0.12.1 실행에 성공했다. 압축·준비·SDK 보호 17개, 보관함/준비/SDK 보호 35개 집중 검사 통과. `/tmp/appops-real-temurin-result.json`, `/tmp/appops-tar-fixes-tests.log`, `/tmp/appops-v4-core-regression.log`, `/tmp/appops-v4-vault-regression.log`.
- 보호: SDK 복구 충돌을 영속 차단 상태로 보존하고 빌드/검수/등록 해제를 막는다. 보관함·관리형 도구도 프로젝트/스냅샷 보호 대상이다. 도구는 java/javac·adb/aapt2 실행과 실제 필수 파일로 검사하고, 준비 화면의 도구 매핑/설치 작업 최신 순서를 고쳤다.
- 수명주기: Opus 수정에 명시적 중지 파일, 자동 시작 인코딩, 실제/데모 IPC 검사, 엄격한 인증·시간 제한이 포함된다. Linux deb 대상과 개발 런처를 추가했다. 현재 release AppImage는 v3 산출물이며 v4로 재빌드/검증해야 한다. OS 자동 시작 등록은 실행하지 않았다.
- 전체 백업: `packages/backup/archive.ts`의 scrypt/AES-GCM 스트리밍 envelope, `snapshot.ts`의 SQLite online backup·데이터/산출물/메모리 내 보관함 기록·복원 전 작업 차단, 보관함별 OS 키 슬롯을 구현했다. 원본/대상 키 보존·암호 오류/변조/잘림·WAL 이력/산출물/키 복원 3개 집중 검사 통과. **아직 API·UI·오프라인 교체/실패 롤백이 미연결**이며 root가 이어 구현한다. Node 최소 버전은 22.16으로 올렸다. 이 변경은 독립 검토 중이다.
- SDK 잔여: Sol 후속 리뷰에서 Unreal 결제 4번째 인수/ValidationInfo/공개 헤더, Godot product_ids/구독 base plan, Unity internal Editor 설정 접근, iOS PBX 경로 등 P0가 남았다. [후속 리뷰](../../../docs/verification-assets/v4-sdk-followup-review.md). Grok 템플릿을 반복 성공으로 간주하지 않고 root가 실제 API/소스로 직접 수정한다. 장비 런타임 증거는 없다.
- 다음: 전체 백업 API·원자적 활성화/롤백·원본 프로젝트 재연결, SDK P0/런타임 구매 검증, OS 빌드 격리·서명, Gradle 준비, 새 deb/AppImage와 전체 회귀/독립 수용을 계속한다. 제공된 채팅 비밀번호는 용도 답변이 없어 사용하거나 저장하지 않았다.

## 이전 세션 요약

- 2026-09-11 22:00 KST — v4 준비 API·앱별 매핑·원본과 분리된 SDK 이력 보호 연결, SDK 9/9·보호 5/5·준비 4/4 및 타입 검사 통과. 당시 네이티브 시험 창만 확인했고 이후 수용 결과는 위 후속 세션과 검증 색인을 따른다. 미지원 NOTE_TRACK 기반 자식 추적은 사용하지 않는다.
- 2026-09-11 20:40 KST — v3 구현·화면·패키지 검증 완료 — 세부 결과는 검증 색인과 해당 버전 계획에 보존.
- 2026-09-11 — v2 키·SNS와 기반 구현 — 세부 결과는 검증 색인과 해당 버전 계획에 보존.
