# 구현 검증 기록

Last Updated: 2026-10-01 (아키텍처 안전성·책임 경계 개선; 아래 날짜별 기록은 해당 체크포인트)

[계획 v9](../dev/active/app-operations-platform/app-operations-platform-plan-v9.md) · [작업 목록](../dev/active/app-operations-platform/app-operations-platform-tasks.md) · [맥락](../dev/active/app-operations-platform/app-operations-platform-context.md) · [실제 지원 범위](integration-capabilities.md)

## 2026-10-01 아키텍처 안전성·책임 경계 개선

전체 코드 분석의 개선 범위를 [불변 계획](../dev/archive/architecture-refactoring/architecture-refactoring-plan.md)에 고정하고 ai-team으로 구현했다. 기존 모듈형 모놀리스·SQLite·vault·작업 소유권과 미커밋 변경을 유지했다. 새 서비스·의존성은 추가하지 않았다. [완료 계약과 결정](../dev/archive/architecture-refactoring/architecture-refactoring-context.md) · [실행·복구 계약](workflow-contract.md).

- **프로세스 종료:** 실제 ChildProcess의 생존 상태·부모·PID·시작 시각으로 루트 권한을 확인하고 관찰한 자손만 종료한다. 없는 루트·호스트 프로세스·재사용한 PID·종료 경합을 거절하며 관찰한 setsid 자손 정리는 보존한다.
- **외부 변경과 원자성:** 성장 run·prepared effect·업무 출처·답글/가격 문서를 함께 예약한다. 결과·관측·reconcile·effect·완료를 함께 확정하고 저장 실패에는 rollback·큐 중단·오류 보고를 수행한다. 웹 CLI는 durable dispatch를 commit한 뒤 열며 미확정 결과를 자동 재전송하지 않는다.
- **안전 조회와 호환성:** 표시 상한과 별개로 전체 run/effect 이력을 SQL로 검사한다. 삭제·계정 변경은 외부 await 뒤 재검사하며 기존 웹 배포도 차단 근거로 유지한다. typed 문서 저장과 DB 버전 0/1 호환을 연결하고 미지원 상위 버전은 변경 없이 거절한다.
- **책임 경계:** reusable runner를 packages/runner로 이동하고 Docker context와 기존 entrypoint를 연결했다. 공급자 순환 참조 3개를 하위 client 추출로 제거했다. 8개 기능 Controller의 전체 AppService 의존을 좁은 hooks로 바꾸고 결과·정책·성장 AI CLI 책임을 분리했다. packages→apps 역참조·정적 runtime 순환 검사를 typecheck에 포함했다.
- **조회·화면 계약:** 프로젝트 SQL 범위 조회와 결정 커서 페이지, 공유 개발 DTO를 실제 API/IPC/UI에 연결했다. DevelopmentView를 책임별 구성요소로 분리했다. 성장 화면은 완료 뒤 다음 poll을 예약하고 프로젝트 전환·늦은 응답을 처리하며 서버와 화면이 같은 열린 응답 7개 상태를 사용한다. 전역 digest와 프로젝트의 전체 귀속 cohort 계산 의미는 보존했다.

### 검사와 독립 리뷰

최종 세 게이트는 수정한 테스트를 포함한 같은 소스에서 각각 한 번 실행했고 모두 exit 0이었다.

| 최종 게이트 | 결과 |
|---|---|
| `npm run typecheck` | 두 TypeScript 검사 및 아키텍처 경계·정적 runtime 순환 검사 통과(273개 소스) |
| `npm run build` | 통과; renderer JS chunk 1,042.20 kB의 기존 크기 경고 유지 |
| `npm test` | **729개 중 716 통과·실패 0·취소 0·환경 skip 13**, 21.56초 |

소스 fingerprint는 실행 전후 및 root 회수 후 모두 `df50f8d5bf6099243aaf9f7ec185623f1e0f3b6a4062ed1b7b5149c0d9e4405a`로 같았다. tracked와 비무시 untracked의 apps/packages/scripts/tests 및 package·TypeScript·빌드 설정 381개 파일별 SHA-256을 정렬·집계했고 docs/tmp/dist는 제외했다. [타입 로그](../tmp/architecture-refactoring/typecheck-final.log) · [빌드 로그](../tmp/architecture-refactoring/build-final.log) · [전체 테스트 로그](../tmp/architecture-refactoring/test-final.log).

macOS ARM64 실제 Electron 개발 화면 **20/20**, 성장 화면 **11/11**(기존 8개와 프로젝트 전환/늦은 응답·동일 시각 결정 351건의 커서 경계·A→B→A 복귀 3개)을 통과했다. 모든 성장 응답을 6초 지연한 집중 검사도 첫 로드와 다음 poll **2/2 응답**을 반영했다. runner/mac 회귀 **41/41**도 통과했다. 이 수치는 전체 테스트와 중복될 수 있어 합산하지 않는다. 네이티브 검증은 격리된 DB·fixture 공급자와 실제 Electron bridge/controller를 사용했으며 외부 쓰기는 **0건**이다.

실패 비용이 큰 계약은 구현 전에 별도 Sol 세션에서 검토했다. 구현 후 backend·query·개발 UI는 구현자와 분리한 Sol 세션, connector는 별도 Opus 세션에서 최초 리뷰했다. backend/query의 필수 4건은 각각 기존 구현자가 수정했다.

| 필수 지적 | 해소 및 회귀 근거 |
|---|---|
| 최초 snapshot 전 루트 PID 재사용으로 외부 그룹을 인정 | ChildProcess 생존·직접 부모 검증 및 snapshot/신호 직전 재검사. 신호 spy **10/10**, 실제 macOS setsid 자손 **1/1** |
| 웹 조회 중 수동 종결을 오래된 결과로 덮어씀 | await 뒤 현재 문서 재조회, resolved 상태 보존, 읽기 실패/종결 rollback 검증. 웹 안전성 **12/12** |
| 5초마다 시작한 poll이 매번 6초 걸리면 영구 로딩 | 완료 후 다음 poll 예약과 적용 완료 토큰 비교. 동일 신규 회귀의 수정 전 실패를 확인하고 query **8/8**, 관련 성장 **23/23** 및 네이티브 지연 응답 확인 |
| 최근 500건 밖 blocked 응답이 열린 그룹에서 누락 | 서버·화면의 열린 상태 상수 공유 및 상한 밖 보존. 같은 query 회귀에서 blocked 포함·기존 unresolved 분류 보존 확인 |

수정 전 backend 2건과 query 2건은 결정적 회귀에서 실패를 재현했다. query 수정 전 네이티브 실패는 dist가 이미 수정된 상태여서 확보하지 못했고, 해당 근거를 단위 재현과 최신 native 성공으로 구분한다. 필수 지적은 실제 diff와 집중 회귀 근거로 통합 책임자가 종료했다. 개선 제안인 SQL EXISTS/추가 결정 인덱스는 실제 성능 근거가 필요할 때 검토하며 완료 차단 결함으로 취급하지 않는다.

첫 전체 검사는 **729개 중 714 통과·2 실패·13 skip**이었다. 테스트 2건을 실제 계약에 맞게 수정했다. Play 계정 동기화는 같은 주기에 예약한 앱별 조회가 pending이면 대기하고 다음 주기에 한 번 실행됨을 확인한다. 캠페인 cache 검사는 제거된 private 메서드 대신 분리한 persistResult 모듈을 transaction 안에서 호출한다. 해당 **5/5** 집중 회귀를 통과한 뒤 최종 전체 게이트를 다시 실행했다. 앱 구현은 이 수정에서 변경하지 않았다.

### 범위와 한계

이번 최종 실행 호스트는 macOS ARM64/Node 24.18.0이다. 환경 skip 13건은 Linux tmpfs 키 작업 4개·실제 loopback SSH 1개, opt-in Docker key helper 통합 4개, opt-in Android 실다운로드 1개, Linux x64 Godot/JDK/Android SDK 설치 3개다. 이 검증에서는 Linux/Windows 전체 suite·Docker 이미지 재빌드·실계정 API 변경·설치 패키지·장기 운영을 수행하지 않았다. Docker context의 현재 runner allowlist/파일 포함은 fixture 회귀로 확인했다. 기존 제품 계획의 실계정·다른 OS·장기 수용 항목과 완료율은 유지한다.

ps 시작 시각의 해상도와 snapshot 직후 kill 사이 OS 경합은 남으며 관찰하지 못한 고아를 호스트 전체 검색으로 추측하지 않는다. 경계 검사에서는 정적 import/re-export를 확인하며 동적 import는 정적 순환 판정 밖이다. Vite의 기존 500 kB chunk 경고는 남는다. 검증·리뷰 상세 로그는 [최종 실행 기록](../tmp/architecture-refactoring/final-verification.md), [backend 리뷰](../tmp/architecture-refactoring/backend-review.md), [query 리뷰](../tmp/architecture-refactoring/query-review.md)에 보관했다. 구현·검증 단계에서는 커밋·push·merge·배포·실계정 게시를 수행하지 않았다. 이후 사용자의 커밋 요청에 따라 검증한 코드와 필요한 성장 운영 기반을 `cd3a6a6`에 기록했다. 커밋 준비에서 Pricing.tsx의 EOF 빈 줄 하나를 제거했으며 그 외 소스는 전체 검증 당시와 동일하다. 계획·검증 기록은 별도 문서 커밋으로 기록한다. 기존의 별도 문서 수정과 tmp 산출물은 제외하며 push는 수행하지 않는다.

## 2026-09-22 macOS Docker·Linux 실행과 SDK 이식성

사용자가 추가 실행 환경을 승인하여 macOS에는 전용 Docker Linux 경로를 추가하고 Linux의 기존 bwrap/tmpfs 실행을 유지했다. 워커는 사용자 변경 지시에 따라 `gpt-6-astra ultra fast`로 전환했으며 실제 실행 화면에서 확인했다. 이전 Grok 작업의 SDK 구현과 기존 미커밋 변경을 보존했다.

- **실제 Mac→Linux 빌드:** macOS ARM64 컨트롤러에서 인증 HTTP로 Docker Linux ARM64 러너에 Godot 4.3 빌드를 요청했다. bwrap 격리 export 후 실행 파일 **59,761,504 bytes**, PCK **1,840 bytes**를 Mac으로 회수했다. 회수한 동일 바이트의 복사본을 Linux bwrap에서 실행해 `AppOps controller build OK`, exit 0을 확인했다. [빌드·해시](../tmp/cross-platform-linux-20260922/mac-to-docker-godot.log) · [게임 실행](../tmp/cross-platform-linux-20260922/mac-docker-game-execution.log).
- **Docker 경계:** 호스트 공개 주소는 `127.0.0.1:4320`, 미인증 health 401/인증 200, `ready:true`, bwrap 0.8.0, 연결코드 파일 0600을 확인했다. 상주 컨테이너는 read-only root·이름 있는 전용 volume·로그 저장 없음이며 홈/DB/vault/Docker socket을 연결하지 않는다. cap drop ALL 후 필요한 4개만 추가하고 기본 seccomp에서 bwrap의 `pivot_root`만 허용했다. [실측 권한](../tmp/cross-platform-linux-20260922/minimum-capabilities.json) · [사용법](runner-protocol.md).
- **실제 Mac 키 작업:** 별도 일회성 Linux helper로 SSH/Android 키 등록, 잘못된 암호 거절, AAB/JAR 서명, 지문·링크·APK 도구 부재의 원본 보존, timeout 정리, SSH loopback 거절/도달 가능한 서버 성공/잘못된 서버 키 거절을 확인했다. 전송 실패·취소·동시 작업·입출력 한도까지 포함한 통합/protocol **14/14**, 제한된 GUI PATH에서 실제 SSH 양성/암호 음성 **1/1** 통과. [실측 로그](../tmp/cross-platform-docker-key-20260922/final-focused.log) · [GUI PATH](../tmp/cross-platform-docker-key-20260922/gui-path.log) · [키 작업 계약](build-credentials.md#macos의-docker-키-작업). 초기 `integration.log`는 확장 검사 관찰 타이밍 수정 전 실패 기록이며 최종 결과로 사용하지 않는다.
- **공식 SDK:** `node --import tsx scripts/prepare-verification-tools.ts`로 고정 해시의 Unity IAP 5.4.2·MAX 8.6.5·Play Billing 9.1.0과 호스트용 Godot 4.3을 `tmp/cross-platform-sdk-20260922/`에 준비한다. 전역 설치·라이선스 동의는 하지 않으며 javac/C++ 컴파일러는 별도로 필요하다. Mac 실제 SDK 집중 5/5, Linux SDK·압축 검사 26 통과/0 실패/Android ARM64 미지원 1 skip. AppleDouble 예외에도 경로·타입·크기 한도를 유지했다. [Mac](../tmp/cross-platform-sdk-20260922/mac-results.txt) · [Linux](../tmp/cross-platform-linux-20260922/sdk-tests.log).
- **SDK 독립 리뷰:** 명시한 `APPOPS_SDK_REVIEW_ROOT`에 Billing JAR가 없어도 skip되던 결함을 재현 후 수정했다. 명시 경로 누락 실패와 유효 공식 JAR의 실제 javac, 기타 SDK 회귀 **14/14**. 빈 환경값도 실패한다. [회귀 로그](../tmp/cross-platform-sdk-20260922/review-regression.log).
- **전체 회귀:** 최종 소스 Mac **500개 중 485 통과·0 실패·15 skip**, Linux **500개 중 491 통과·0 실패·9 skip**. 양 OS 타입 검사·빌드 통과. Mac 기본 검사의 Docker 키 4개는 opt-in이라 별도 실측으로 확인했다. Linux 전용/native 반대 조건과 선택적 실다운로드의 skip을 실제 성공으로 계산하지 않는다. [Mac 전체](../tmp/cross-platform-sdk-20260922/npm-test-reviewed-mac.log) · [Linux 전체](../tmp/cross-platform-linux-20260922/npm-test-reviewed-linux.log). Vite의 기존 500 kB 청크 경고는 남는다.
- **Docker 독립 리뷰와 수정:** A/B 최초 독립 리뷰에서 발견한 daemon 전환 정리 오인은 endpoint·실행 파일·환경·daemon ID 고정과 회귀 **3/3**으로 수정했다. 큐/API가 취소 뒤 cleanup 오류·이미 완료한 서명을 잃는 문제는 빌드 정리까지 소유권 유지, 서명별 checkpoint, 공개 복구 ID의 API/이력 기록으로 수정했다. 실제 Store/JobQueue/HTTP와 재시작을 포함한 관련 **31/31**, 데모·종료 영향 검사 **52/52** 통과. 외부 쓰기 취소 fencing은 유지했다. [daemon 회귀](../tmp/cross-platform-docker-key-20260922/daemon-boundary.log) · [소비자 회귀](../tmp/cross-platform-docker-key-20260922/consumer-regression.log) · [취소 영향](../tmp/cross-platform-docker-key-20260922/cancellation-regression.log). daemon 중단·응답 유실은 통신 경계의 제한된 결함 주입이며 실제 Docker 설정을 변경한 시험이 아니다.
- **최종 이미지:** 리뷰 수정 후 allowlist context를 새로 만들고 53파일의 현재 소스 일치를 확인하여 `appops-linux-runner:local`을 다시 빌드했다. 이 이미지로 실제 키·protocol·daemon·큐/API 통합 **26/26**, skip 0을 확인했다. [최종 실측](../tmp/cross-platform-docker-key-20260922/reviewed-image-integration.log) · [이미지 빌드](../tmp/cross-platform-linux-20260922/runner-image-reviewed-build.log). 생성한 검증용 컨테이너·네트워크·volume·임시 연결 코드는 제거하고 제품 이미지와 공개 검증 도구·로그는 보존했다. 워커 터미널도 모두 종료/release했다.

실제 키 검사는 이미지 준비 후 다음처럼 실행한다. 일반 전체 검사가 Docker 설치·다운로드를 자동으로 수행하지는 않는다.

```sh
APPOPS_DOCKER_KEY_TESTS=1 node --import tsx --test tests/docker-key-integration.test.ts
```

현재 실측은 macOS ARM64와 Docker Linux ARM64다. Xcode/iOS·Unity/Unreal 라이선스 빌드·설치 가능한 Android 앱/APK build-tools·Windows·실서비스 게시·장기 운영 완료를 뜻하지 않는다. 기본 키 이미지는 JDK만 포함하므로 APK 도구 부재를 명시적으로 거절한다. 네이티브 macOS 무격리 실행이나 평문 키 디스크 fallback은 추가하지 않았다. 새 설치 패키지와 실제 Electron 창에서의 Docker 작업은 이번 실측 대상이 아니다.

## 2026-09-22 macOS 검사 안정화·CLI/MCP 진단

Grok 4.7/high 구현 워커 2개가 검사 안정화와 CLI 진단을 분담했다. 기존 사용자 UI·앱 종료 변경은 보존했다. 제품의 심볼릭 링크 보호를 완화하지 않고 macOS 테스트 fixture를 실제 경로로 맞췄으며, Linux 메모리 키 저장소가 없으면 명시적 오류로 거절한다.

- 수정 전 `npm test`: **455개 중 413 통과·36 실패·6 skip**. 최신 통합 검사: **468개 중 452 통과·실패 0·16 skip**. 36개 실패 중 26개는 경로/테스트 실행 전제를 수정했고, 10개는 이 환경에서 수행할 수 없는 실제 도구 검사로 명시했다. [기준선](../tmp/core-stability-20260922/npm-test-baseline.log) · [통합 결과](../tmp/core-stability-20260922/npm-test-integrated.log).
- 추가 skip 10개: Linux tmpfs 키 작업 4개·SSH 1개, 실제 bwrap 호스트 파일 은닉 1개, 공식 Unity IAP/MAX 소스·Billing JAR·Godot 4.3 검사 4개. 기존 skip 6개도 남아 있다. 격리 없는 실행 거절과 생성 코드 검사는 별도로 통과했으며 실제 서명·격리·SDK 실행 성공으로 계산하지 않는다.
- 외부 도구는 `APPOPS_SDK_REVIEW_ROOT`, `APPOPS_BILLING_JAR`, `APPOPS_GODOT`으로 지정할 수 있다. 각각 존재하지 않는 경로를 명시한 음성 검사에서 Unity 2개·Billing 1개·Godot 1개가 **skip 없이 예상대로 실패**했다. 설정 오류를 성공으로 숨기지 않는다.
- `npm run typecheck`와 `npm run build` 통과. [최종 타입 검사](../tmp/core-stability-20260922/typecheck-integrated.log). Vite의 기존 500 kB 청크 경고는 남는다. 새 네이티브 패키지·설치/종료 시험은 이번에 실행하지 않았다.
- `node --import tsx scripts/verify-agent-cli.ts`: 제품 탐색이 선택한 **Codex 0.155.1·OpenCode 1.4.3**의 버전과 신규/resume 도움말을 확인했다. 실제 stdio MCP 프로세스의 초기화·도구 목록·fixture 읽기·쓰기 거부 전달도 통과했다. 회귀 검사 **7/7**에는 시간/출력 제한, 임시 디렉터리 정리, 포트 바인딩 실패를 포함한다. [진단 결과](../tmp/agent-cli-20260922/report.json) · [실행 방법과 한계](ai-operations.md#설치된-cli와-mcp-연결-진단).
- 도움말 수락은 실제 로그인·모델 응답·세션 재개의 증거가 아니다. CLI에 설정된 브라우저/이미지 도구, 스토어 실계정 반영, Windows/Linux 네이티브 및 장기 운영은 미검증이다. 커밋·푸시·외부 게시를 수행하지 않았다.
- 독립 경로 설계 검토에서는 실제 호출자의 canonical 경로 처리를 확인해 제품 별칭 예외를 추가하지 않기로 했다. 별도 Grok 최종 리뷰도 완료했으며 필수 결함은 없었다. acknowledge 단언 보강·빈 환경변수 처리·tmpfs 오류 원인 구분은 선택적 개선으로 남겼다. [리뷰 근거](../tmp/core-final-review-20260922.md).

## 2026-09-13 앱 종료 시 프로세스 정리

수정 전 빌드에서 마지막 창을 닫아도 앱이 남아 네이티브 검사의 35초 제한으로 실패했다. 이제 macOS 창 닫기도 앱 종료로 연결하며, 기동·재시작이 끝난 뒤 기존 중지 경로로 제어 서비스와 실행 중인 AI/작업을 정리한다. HTTP가 먼저 내려가더라도 실제 PID 종료를 기다린다. AI 정리를 기다리는 동안 큐가 새 작업을 실행하지 않도록 모든 서비스의 중지를 함께 시작한다.

- `node --import tsx --test tests/lifecycle.test.ts tests/lifecycle-hardening.test.ts tests/project-agent.test.ts`: **52/52**. HTTP 종료 후 PID가 남는 경우의 대기·강제 종료, PID 신원 확인과 중지 표식, Codex/OpenCode 취소를 확인했다.
- `node --import tsx --test tests/desktop-mode.test.ts tests/desktop-security.test.ts`: **23/23**. `npm run typecheck`·`npm run build` 통과. 기존 Vite 청크 경고는 남아 있다. 전체 검사는 이번 범위에서 재실행하지 않았다.
- `npm run build` 후 [네이티브 종료 검사](../scripts/verify-desktop-exit.mjs) `node scripts/verify-desktop-exit.mjs`: **3/3**. 데모 창 닫기, 실제 모드 앱 종료, 기동 직후 창 닫기에서 앱/제어 서비스 PID·HTTP 포트 종료와 메타데이터 제거를 확인했다. 준비된 서비스의 중지 표식도 확인한다. 실제 모드 검사는 별도 제어 서비스의 기존 CLI 탐색 주입 경계에 로컬 실행기 대역을 넣으며 제품 CLI 실행·취소 코드를 그대로 쓴다. SIGTERM을 무시하는 CLI와 그 자식도 종료된다.
- 기동 직후 닫기 검사에서 화면 로드 취소가 처리되지 않는 오류도 발견해 수정했다. 최종 검사는 미처리 Promise 거절을 실패로 취급하며 통과했다.
- [모드 전환 검사](../scripts/verify-desktop-mode.mjs) 통과: 실제↔데모 **33/40/31/39ms**, 취소와 비신뢰 탐색 차단 유지.
- 검증 환경은 macOS Electron이며 Windows/Linux 네이티브·강제 종료(SIGKILL)/전원 차단·외부 서비스 작업 종료를 검증한 결과가 아니다. 실 LLM 응답과 스토어 반영의 검증으로 해석하지 않는다. 기존 사용자 `ui.tsx`/`styles.css` 변경은 보존했다.

## 2026-09-13 AI 요청 자동 전송 제거

버튼이 화면별 고정 문장을 사용자 요청으로 전송하고 즉시 CLI를 시작했다. 실제 HTTP 검사에서 내용이 없는 요청이 200으로 수락되는 것을 먼저 재현했다. 이제 버튼은 기존 채팅만 열고 서버는 메시지를 필수로 요구한다. 요청 UX는 사용자가 직접 재설계하며 새 작업 후보나 승인 단계는 추가하지 않았다.

- `node --import tsx --test tests/project-agent.test.ts`: **19/19**. 모든 화면에서 메시지 누락/빈 문자열/공백을 400으로 거부하며 실행·세션 생성 0건, 실제 전송 문장·선택 범위·같은 세션 전달, resume/clear·CLI 실패·도구 경계를 확인했다.
- 데스크톱 모드/보안 검사 **23/23**, 타입 검사·빌드 통과. 전체 검사는 재실행하지 않았다. 기존 Mac 실패 기준선은 아래 AI 최초 구현 검증 기록에 있다.
- 별도 데이터·실제 HTTP·CLI 대역의 macOS Electron: 12개 화면에서 버튼 열기/닫기 실행 0건, 빈 입력창과 새 후보 UI 없음, 계정 카드의 선택 범위, 사용자 문장 전송 때 1건 실행, resume와 clear 후 새 세션을 확인했다. 1360×868 및 1100×728에서 입력/전송을 확인했다. [최종 화면](../tmp/ai-request-review-20260913/confirm-small.png).
- 실제 LLM의 판단이나 외부 계정·스토어 변경은 수행하지 않았다. 기존 `ui.tsx`/`styles.css` 사용자 변경은 보존한다.

## 2026-09-13 Electron 모드 전환 멈춤

운영 빌드에서 `will-navigate`가 모드 전환의 `location.reload()`까지 차단해 “모드 전환 중” 화면에 머물렀다. 실제 앱에서 8초 이후에도 이전 화면이 남고 탐색 이벤트의 `defaultPrevented`가 true인 것을 확인했다. 같은 시점의 실제/데모 상태 조회는 3~9ms였다. 탐색에도 기존 IPC의 신뢰 URL 판정을 적용해 정확한 앱 진입 화면의 재로딩을 허용했다.

- [네이티브 회귀 검사](../scripts/verify-desktop-mode.mjs): `npm run build` 후 `node scripts/verify-desktop-mode.mjs`. 별도 임시 데이터·실제 제어 서비스·Electron 창을 사용한다. 수정 전 실제 모드 전환이 5초 제한으로 실패했고 수정 후 실제→데모 반복 전환 4회가 **60/393/120/40ms**로 통과했다. 확인창 결과만 대역으로 주입하며 CLI와 외부 공급자는 호출하지 않는다.
- 취소 시 페이지/모드 보존, 승인 시 새 페이지 생성, 화면·HTTP 데이터의 모드 일치, 반대 모드 요청 거부, 외부/다른 로컬 페이지 탐색 차단을 확인했다.
- `node --import tsx --test tests/desktop-mode.test.ts tests/desktop-security.test.ts`: **23/23**. 타입 검사·빌드 통과. 전체 검사는 이번 변경에서 재실행하지 않았으며 기존 Mac 실패 기준선은 아래 AI 검증 기록에 있다.
- 수정한 일반 앱을 재실행했다. 기존 모달 포털 관련 사용자 변경은 수정하지 않았다.
- 네이티브 종료 검사에서 확인한 창 종료 후 `webContents` 접근도 제거했다. 창 ID를 생성 시 보관해 종료 시점에는 파괴된 객체를 읽지 않는다.

## 2026-09-13 AI 요청·대화 세션

각 화면의 버튼과 채팅에서만 AI를 실행하고 Codex/OpenCode의 실제 세션 ID를 이어 쓰며 클리어 뒤 새 세션을 만들도록 연결했다. 관련 **25/25**, 타입·빌드·macOS Electron 검사를 통과했다. 전체 **451개 중 409 통과·36 실패·6 skip**이며 깨끗한 HEAD에서도 같은 36개가 실패했다. 실제 LLM·스토어 검증과 구별한다. [상세 증거와 제한](verification-assets/ai-requests-20260913.md) · [사용법](ai-operations.md).

## 2026-09-12 실사용 결함 수정

요청 거절 복구·수동 확인, 앱별 동기화, 삭제 캠페인 예산, 실제 공개 공지, 외부 결과물 가져오기/업로드와 Apple 이미지 검사를 수정했다. **전체 434/434**, 마지막 관련 검사 **27/27**, 타입 검사·운영 앱 컴파일 통과. 데모/실제 모드의 외부 결과물 업로드와 수동 확인 화면을 Chromium으로 검증했다. 실계정 요청은 수행하지 않았다. [수정 내용·검사 로그·화면 증거](verification-assets/operational-fixes-20260912.md) · [사용법](external-artifacts.md).

## 2026-09-12 실사용 검토 (수정 전)

계정 연결 완료·앱 내부 빌드 제외 조건에서 운영 결함 4개를 재현하고 외부 결과물 배포 경로 부재를 확인했다. 선택한 기존 검사 262개 중 258 통과·Apple 이미지 4 실패, 전체 typecheck는 테스트 코드의 TS2339 오류 3개로 실패했다. node tsconfig 검사는 통과했다. 제품 코드는 수정하지 않았다. [상세 결과·범위·재현](verification-assets/operational-review-20260912.md) · [결과 JSON](verification-assets/operational-review-20260912.json).

## v3 통합 검증

- `npm test`: **246/246 통과**, 실패·건너뜀 0. `/tmp/appops-full-v3.log`.
- `npm run typecheck`: 화면·Node 타입 검사 통과. `/tmp/appops-typecheck-v3.log`.
- `npm run pack`: TypeScript·Vite와 Linux 패키지 생성 통과. `/tmp/appops-pack-v3.log`.
- `npx electron-builder --linux AppImage --prepackaged release/linux-unpacked --config electron-builder.json`: [Linux AppImage](<../release/App Operations-0.1.0.AppImage>) 생성, 134,080,539 bytes. SHA-256 `0c859b6294b144fab8e9b3a7c3a3e83e459a3c40c545bff77d806750ff1a5d72`. `/tmp/appops-appimage-v3.log`.
- 패키지 Electron Node 프로세스에서 인증 없는 상태 조회 401, 실제 연결/프로젝트 0, 데모 연결 9/프로젝트 5, 데모 검수→빌드→업로드 성공, 설정 백업, 실제 이력 불변을 확인했다. [패키지 증거](verification-assets/v3-packaged-controller.json). 재현: `ELECTRON_RUN_AS_NODE=1 release/linux-unpacked/app-operations scripts/verify-packaged.mjs`.
- 실제 Linux 원격 러너의 Godot export와 회수한 게임 headless 실행 성공. [결과](verification-assets/v3-remote-godot.json). 실행 파일 66,074,584 bytes와 PCK 1,840 bytes를 동일 폴더에 회수했다. 재현 `npx tsx scripts/verify-remote-godot.ts` (아래 Godot 도구 환경 변수 사용).
- Opus와 코디네이터가 실제 브라우저에서 게시·예약·키·소재·파이프라인·러너·진단·백업 복원·모드 전환을 확인했다. 새 데모 제어 화면에서 네트워크 오류→자동 재시도(2번째 성공), 초기화→기본 9개 연결·5개 프로젝트 복귀와 실제 공간 보존도 확인했다. [Opus 화면 기록](verification-assets/v3-browser-report.md), [코디네이터 화면 기록](verification-assets/v3-root-ui-report.md), [초기화 후 대시보드](verification-assets/v3-demo-reset-dashboard.png).
- 독립 Sol 리뷰의 화면·광고·백엔드 지적을 수정하고 재검토를 마쳤다. Apple 리소스 소유권·심사 상태는 Grok이 수정했고 별도 Sol이 검증했다. 알림 만료 시간과 검수 단계 설명도 정정했다. [최종 리뷰 목록](verification-assets/v3-final-review-summary.md), [백엔드 수정 확인](verification-assets/v3-backend-fix-verification.md). 남아 있는 지적 없이 요청한 v3 개발 검증 범위를 마쳤으며 완료 워커는 모두 해제했다.

v3 추가 검사에는 영속 데모·모드 전환 경계, 5개 엔진 합성 출시·멱등성, 인증/네트워크/심사 실패, 백업 병합·해시·작업 중 차단, 미디어 귀속·변조, 원격 묶음·HTTP 인증, Play 임시 편집 정리와 불명확한 커밋 구분, Apple 앱 소속과 모든 심사 상태, 광고 iTunes ID·SDK 비밀 제거를 포함한다.

환경: Linux x64, 호스트 Node 22.22.1(패키지 Electron 내장 Node 24.20.0), npm 9.2.0, Electron 44.3.0, TypeScript 7.0.2, React 19.3.0, Vite 8.3.0, electron-builder 26.15.3. 이전 v2 체크포인트는 188개 검사·패키지 기동·fflate 0.8.3 반영 후 npm audit 0건을 기록했다(2026-09-11). 현재 링크의 AppImage는 v3 산출물로 갱신했다.

## 실제 경계 검사

| 경계 | 확인 내용 |
|---|---|
| 인증 | AES-GCM/AAD 변조, 키 유실·잠김, OAuth PKCE/state 재사용·만료, 동시 갱신·회전 저장·재시작 |
| API·미리보기 | 실제 HTTP Bearer·Host·Origin·Electron IPC, 0600 인증 파일, Vite의 비공개 세션과 Origin 위조 차단 |
| 내구성 | SQLite 재시작·lease fencing·직렬화·취소 후 늦은 응답·멱등 충돌·외부 응답 유실 후 비재전송 |
| 자격 증명 저장 | DB 메타데이터/이력 저장 실패, 암호문 보상 삭제 실패, 미등록 키 버전 정리, OAuth 승인 1회로 DB 재시작 복구 |
| SSH | 생성한 암호화 개인 키, 실제 OpenSSH+Git+loopback SSH 서버 인증·clone·커밋·서버 키 변경 차단 |
| Android 키 | 실제 keytool/jarsigner·장기 P12·JAR 서명, 미래 시작·짧은 만료·잘못된 KeyUsage 거부, 지문·별칭·버전 확인 |
| 러너·스냅샷 | 실제 bwrap 파일/네트워크/프로세스 격리, 호스트 접근 차단·취소, 비밀·Git 제외, 실행 비트·해시·필수 산출물 확인 |
| 스토어 | 공식 명세 기반 모의 HTTP, Apple 업로드/상품/가격 복구, Steam 암호화 세션·VDF·전체 산출물 staging |
| 수익·예산 | BigInt 금액·환불·통화, Play UTF-16 ZIP/CSV·월 정정, AdMob Android 앱 귀속·MAX 중복 제외, 계정 간 예산 예약 |
| SNS | X/Threads 공식 OAuth·게시/답글 페이로드·토큰 갱신, 소유권·프로젝트 범위, 예약 재시작/부분 채널/취소, 공개 출시 공지·답글 규칙 |
| SNS 실패 | Threads 준비 확인 후 발행·취소·상한, 응답 유실 비재게시, 확정 실패 이력·한도 해제, 한도 축소 시 오래된 예약 우선 |
| Steam 뉴스 | 같은 계정을 공유하는 여러 프로젝트의 정확한 AppID 귀속, 다른 AppID의 잘못된 귀속 차단 |

외부 API 응답은 주입한 모의 fetch로 검사했다. SSH·Git·JDK·bwrap·SQLite·로컬 HTTP는 실제 도구를 실행했다. 사용자 키·실제 계정·외부 게시·광고 집행·스토어 배포는 검증에 사용하지 않았다.

## 실제 Godot 빌드

공식 Godot 4.3 Linux 편집기와 export templates로 격리 내보내기와 생성 게임의 headless 실행을 통과했다. 이어 실제 제어 서비스에서 프로젝트 등록 → 소스 스냅샷 → 격리 빌드 → 산출물 해시 → 이력 저장을 통과했다. 실행 `365f75c7-71c0-4a29-9550-0de33c8cd1bc`, 실행 파일 66,074,584 bytes + PCK 1,840 bytes. [결과 JSON](verification-assets/godot-controller-20260911.json), [도구·세부 기록](build-support.md).

재현 명령(준비한 공식 편집기/템플릿 경로):

```bash
APPOPS_GODOT_PATH=/tmp/appops-godot-verification-20260911/downloads/Godot_v4.3-stable_linux.x86_64 APPOPS_GODOT_DATA_DIR=/tmp/appops-godot-verification-20260911/godot-data npm run verify:godot
```

## 실제 화면 검사

Opus 워커가 격리된 실제 제어 서비스·메모리 KeyProvider·모의 공식 API와 실제 키 도구로 브라우저 흐름을 검사했다. SSH/Android 키 등록·교체·프로젝트 바인딩·사용 중 삭제 409·해제·삭제, X OAuth callback·정책 저장·화면에서 작성한 게시·답글·예약 취소·오류 표시를 확인했다. 라벨만 수정할 때 credentials가 누락되는 화면 결함도 수정했다. [검사 기록](verification-assets/desktop-smoke-20260911.md), [커뮤니티 화면](verification-assets/community-smoke-20260911.png), [빌드 키 화면](verification-assets/build-keys-smoke-20260911.png).

광고/수익화의 모든 쓰기 폼에 필수 프로젝트를 연결하고 자원 행의 프로젝트를 미리 선택하도록 수정했다. 중복 externalId 입력을 없애고 여러 국가·통화·금액 입력을 검증했다. [화면 수정 기록](verification-assets/marketing-ui-fix-20260911.md). 최종 개발 서버를 최신 코드로 재시작하고 비공개 브라우저 세션의 프로젝트·커뮤니티 화면을 다시 확인했다.

이 호스트는 Electron chrome-sandbox 권한 및 AppArmor 제한으로 네이티브 창 기동이 막힌다. --no-sandbox나 시스템 보안 설정 변경으로 우회하지 않았다. **패키지 생성·패키지의 제어 서비스 기동·브라우저 UI 성공과 네이티브 창 실행을 구분한다.**

## 독립 리뷰

Sol의 초기 구현 리뷰 9건 및 후속 기반 6건을 수정·검증했다. 광고 리뷰 8건은 백엔드·문서 7건의 Opus 확인과 화면 필수 프로젝트 수정으로 반영했다. [광고 수정 확인](verification-assets/marketing-fix-review-20260911.md)은 당시 남았던 화면 항목을 명시하며, 위 화면 수정 기록이 후속 증거다.

새 키·SNS에 대한 Sol 리뷰는 인증서 검사, 저장 장애 복구, Steam 귀속, 한도 축소 시 실행 순서 4건을 제시했다. 코디네이터가 수정한 뒤 별도 Sol 세션에서 네 항목과 Threads 종결 실패 흐름을 다시 확인했다. 범위 내 남은 수정 사항 없음, 집중 검사 48/48 통과. [최초 지적](verification-assets/key-social-review-20260911.md) → [수정 검증](verification-assets/final-fix-review-20260911.md).

실제 Opus·Grok Orca 워커를 사용했다. Fable 요청 세션은 런처 기록과 워커의 런타임 Opus 4.8 자기 식별이 불일치했으므로 Fable 수행 실적으로 확정하지 않는다. 고난도 키·인증·동시성 통합은 코디네이터가 직접 구현했다. 완료 워커는 해제·종료했다.

## 남은 범위

실서비스 계정·권한·업로드·심사·광고 집행·SNS 게시, macOS/Windows 실행·격리·서명, Unity/Unreal 라이선스·프로젝트, 설치 가능한 Android 앱·기기·APK build-tools 실행, OS 재부팅·장비 이전·30일 관찰은 미검증이다. Android 서명 검사의 입력은 JAR 형식 테스트 산출물이며 실제 설치 가능한 앱을 증명하지 않는다.

Steam 공지 쓰기·신규 앱의 필수 Console 단계, macOS/Windows 내장 격리, Apple 스크린샷/프리뷰·pkg, 게임 내부 광고/결제 SDK 설치, 고급 미디에이션·기여 분석, 자동 시작·업데이트와 전체 장비/비밀 백업은 [연동 기능표](integration-capabilities.md)와 [작업 목록](../dev/active/app-operations-platform/app-operations-platform-tasks.md)에 남겨 두었다. 전체 계획의 수용 검사를 완료한 출시 버전으로 표시하지 않는다.

## 2026-09-23 운영준비·프로젝트 탐색·OAuth UX

- 전체 macOS 검사: 508개 중 493 통과, 실패 0, 환경 skip 15. 실제 공식 4.7.2 바이너리를 `APPOPS_GODOT`로 지정했다. 후속 계정 동일성/경로 탐색 및 ZIP 회귀 검사와 타입·빌드도 통과했다.
- Godot 4.7.2·Temurin 21.0.12.1+1을 macOS ARM64 장비의 격리된 검증 경로에 공식 해시로 실설치했다. Android command-line tools 15859902(156,083,281바이트)의 공식 체크섬과 압축 해제를 실검증했다. 최초 실패한 ZIP 중첩 JAR 오인을 중앙 디렉터리 기반 범위 추출로 수정하고 descriptor/stored/빈 항목·CRC·크기·로컬 파일명·잘린 스트림·취소를 회귀 검증했다.
- ZIP 처리 설계만 구현과 분리된 세션에서 독립 검토했다. descriptor의 local size=0, 바이트 범위·겹침, inflate 소비량, 빈 파일·디렉터리, 실패 자원 정리 조건을 반영했다. 전체 작업의 검토는 자체 검토다.
- Electron 실제/데모에서 탭·공급자/AI 버튼, 자동 감지 상태, 파일 선택→경로 저장→검사, 잘못된 경로 오류, OAuth JSON 가져오기, 기존 앱 설정 자동 재사용 및 수동 전환, 1360×868/1000×728 화면을 확인했다. 클릭·키보드 입력·파일 입력으로 조작했고 초기 화면과 작은 창에서 주요 버튼 잘림·가로 넘침을 확인했다. UI 인증 검증에는 별도 데이터 디렉터리의 합성 앱 자격 증명만 사용했다.
- 실제 등록 경로 읽기 검증: `kingdoms/samAstra/godot` 탐색 성공, SEED3 Godot Android 템플릿 경고 없음. `inkbound`에는 지원 대상 엔진 파일이 없어 unknown이 유지된다. 사용자 프로젝트 원본과 실제 계정은 변경하지 않았다.
- 제한: 실제 공급자 브라우저 인증 완료, Android 라이선스 동의 후 플랫폼/빌드 도구 전체 설치, 새 Linux 러너 이미지 빌드 및 다른 OS 실설치는 수행하지 않았다. 공용 OAuth 클라이언트는 제공되지 않았으므로 최초 앱 등록은 여전히 필요하다. 이전 4.3 검증 캐시를 사용하려면 갱신 준비 스크립트를 실행하거나 `APPOPS_GODOT`에 4.7.2 경로를 지정해야 한다.
- 로그·화면: `tmp/operational-fixes-20260923/`의 `all-tests-final.log`, `regression-final.log`, `build.log`, `live-install*.log`, `setup-final.png`, `setup-compact.png`, `oauth-reuse.png`, `oauth-compact.png`.

## 2026-09-23 Google 공통 앱 등록·실계정 접근 검사

- 계정 연결 상단에 독립적인 Google OAuth 앱 등록을 추가했다. 등록 콘솔 열기→데스크톱 JSON 가져오기→공통 보관함 저장으로 Google Play/Google Ads/AdMob에 재사용한다. 기존 계정 토큰과 앱 설정은 교체 시에도 보존한다. 서버는 웹/서비스 계정 JSON과 데모 저장을 거부하고 공개 API에는 비밀을 반환하지 않는다.
- 검증: controller/desktop-security/transport 41/41, 타입·빌드 통과. Electron에서 데모 비활성화, 웹/잘못된 JSON 거부, 공통 등록 저장, 계정 폼 입력 보존, 세 Google 공급자의 클라이언트 필드 제거/설정 재사용, 재시작 유지, 1000×728 배치를 확인했다. 테스트 데이터는 정리했다.
- 실제 사용자가 받은 JSON을 OS 보관함으로 보호된 공통 등록에 저장했다. 기존 Google Play와 Google Ads 연결의 갱신 토큰으로 실제 액세스 토큰 발급에 성공했다. 새 브라우저 로그인 전체 흐름을 완료했다는 의미는 아니다.
- 초기 실측은 Play/Ads 모두 `SERVICE_DISABLED`였다. 이후 사용자 승인 범위에서 Cloud API를 사용 설정하고 Ads 탐색자 액세스를 신청했다. 외부 콘솔 성공과 앱 검증을 구분하며, 최종 결과는 아래 Electron 실제 화면 테스트를 근거로 한다.
- 2026-09-24 Electron 실제 모드: 계정 연결 화면에서 Play 검사 성공, Ads 레거시 계정 이름을 `고객 ID 수정`으로 숫자 ID로 저장한 뒤 검사 성공. 기존 OAuth 토큰은 보존했다. 정상 계정의 임의 재지정, 중복 계정, 실행 중 작업/재인증 중 ID 변경은 거부한다.
- Seed2 원인은 Godot macOS/iOS 프리셋이 Android보다 먼저 나오는 경우 다른 플랫폼의 ID가 대표 식별자로 선택되는 것이었다. Android가 있으면 Android 패키지를 우선하며 원본 프로젝트는 수정하지 않았다. Electron `다시 검수`로 `com.dermolabs.seed2`를 확인했다.
- Electron `스토어 배포 → 출시 조회 → 프로젝트 선택 → 실행`을 Seed2/SEED3 각각 실행했다. 최종 이력 성공 및 표에서 Seed2 `v1.0.5 / internal / 105`, SEED3 `v0.9.1 / internal / 38`을 확인했다. 두 앱 모두 `RELEASE_LIFECYCLE_STATE_PUBLISHED`다.
- Electron 마케팅 동기화에서 관리자 계정 자체에 metrics를 요청하는 HTTP 400을 재현·수정했다. 관리자 연결은 `customer_client`의 활성 하위 광고 계정을 찾아 해당 ID와 관리자 로그인 헤더로 조회한다. 고객별 리소스 ID·통화·metric sourceId를 분리하며 하위 조회 실패는 전체 실패로 반환한다. 관리자 연결의 외부 변경은 차단하고 UI에 개별 광고 계정 연결 안내를 표시한다. [공식 customer_client 계약](https://developers.google.com/google-ads/api/fields/v25/customer_client).
- 수정 후 Electron `운영 준비 → 앱·서비스 → 다시 시작` 성공, 마케팅 `동기화` 최종 성공: 하위 계정 1개, 캠페인 12개, 최근 7일 광고비 행 0개. 목록 화면과 이력 상세를 확인했다. 앱 출시·광고 집행·예산 변경은 수행하지 않았다.
- 도구: Codex Computer Use로 계정 검사·고객 ID 수정·Seed2 재검수를 수행했다. Electron 기본 선택 메뉴 입력이 불안정해 이후 Playwright의 동일 Electron 창 UI 조작으로 출시 조회·Ads 동기화·최종 결과를 검증했다. 별도 API probe는 진단용이며 앱 수용 근거로 대체하지 않았다. 최종 앱 창은 사용자가 확인할 수 있도록 열어 두었다.
- 추가 회귀: controller/engines/transport 44/44, marketing-connectors/marketing-social-extensions/operational-fixes 31/31. 타입·빌드·diff 검사 통과. macOS 실제 UI에서 1360×868 화면의 가로 넘침 없음과 조회 결과를 확인했다. 새 브라우저 OAuth 동의·콜백 전체 재실행, 외부 쓰기, 다른 OS와 Android SDK 전체 구성 요소 설치는 이번 실계정 검사 범위 밖이다.
- 근거: `tmp/google-live-20260923/regression.log`, `api-disabled.png`, `electron-play-releases.png`, `electron-ads-sync.png`, `electron-ads-campaigns.png`, `app-fixes-tests.log`, `ads-manager-tests.log`; UI QA는 `tmp/operational-fixes-20260923/google-app-*.png`와 `google-app-qa.txt`. 등록 원본 `client_secret_*.json`은 Git 제외 패턴을 추가했으며 비밀값은 출력하지 않았다.

## 2026-09-24 CLI AI 설정·GitHub 개발 작업·웹 배포

사용자가 CLI 로그인 중심을 확정한 뒤 `$ai-team`으로 구현했다. UI는 Claude Code Opus 5.5/high, 개발 백엔드는 Codex Sol 6/high, 통합·격리·배포는 root가 맡았다. 구현 세션과 분리한 Opus 백엔드 리뷰, Sol 런타임/UI 리뷰의 결함을 재현·회귀 검사로 수정했다.

- 새 화면: 개발 작업(Git·이슈/PR·문서·tmux 터미널·승인·자동화), 웹 배포, 설정의 앱 내부 AI.
- 실제 계정 쓰기 없이 로컬 Git·worktree·PTY·sandbox와 서비스 fixture를 사용했다. GitHub push/PR·Netlify/Vercel 배포·신규 OAuth 동의는 실계정으로 실행하지 않았다.
- Codex와 OpenCode 실제 모델 → 앱 전용 MCP → native 세션 재개 확인. OpenCode는 전용 XDG 폴더로 해당 세션만 export/import한 뒤 같은 ID 재개도 확인했다. OpenCode 기존 기본값 `openrouter/stealth/ox-alpha`는 현재 목록에 없어 오류를 확인했고, 시험에는 목록에 있는 `openrouter/openai/gpt-6-luna`를 명시했다. 사용자 CLI 설정은 바꾸지 않았다.
- 실제 Codex 개발 작업: 별도 로컬 fixture worktree에서 원본 이슈 문서→plan/context/tasks 생성→add 함수 오류 수정→새 리뷰 세션+controller diff→npm test→사용자 승인에 해당하는 로컬 commit까지 완료. `live-development-evidence.json`에 단계별 결과를 보관했다. 외부 쓰기는 0건이다.
- 전체 테스트: 548개 중 533 통과·실패 0·환경 skip 15. 기존 Godot 경로가 4.3을 가리켜 `APPOPS_GODOT="$PWD/tmp/operational-fixes-20260923/live.tools/godot/4.7.2/Godot.app/Contents/MacOS/Godot" npm test`로 설치된 4.7.2를 명시했다.
- `npm run typecheck`·`npm run build` 통과. 실제 Electron `verify-desktop-development.mjs`에서 프로젝트 전환 경합·조회 전 승인 차단·HEAD 변경·패널 닫힌 로그인/연결 종료·복원 문서·자동 Preview·데모 외부 실행 차단을 포함한 20개 시나리오 통과. 기존 `verify-desktop-mode.mjs` 모드 전환·비신뢰 탐색 차단 6개도 통과.
- macOS `npm run pack` 통과. 패키지 안의 실제 Electron 실행 파일에서 컴파일된 PTY·sandbox 모듈을 로드해 명령 실행·종료를 확인했다. 서명/공증은 수행하지 않았다.
- 리뷰 회귀: 종료 직후 취소가 자동 반영을 재개하지 않음, fork PR 반영 제한, CRLF/대형 에셋의 기존 blob 보존, 변경 필터 실행 차단, 정확한 승인 SHA 배포, 보호 URL과 성공 구분, 복원 잠금 재설정, 루트 소스 공개 거부, 실시간 인증값 마스킹, OpenCode 전역 상태 접근 거부, scoped MCP proxy·Keychain/직접 TCP/Unix socket 차단.

증거 로그·실기 스크립트·화면 캡처는 `tmp/development-workflow/`에 보관했다. 공개용 인증 자료와 테스트용 비밀값 이외의 토큰은 로그에 기록하지 않았다. Linux 이번 변경 실기, 실계정 외부 반영, 서명·공증은 별도 수용 항목으로 유지한다. 사용법은 [AI·개발·배포 안내](ai-operations.md)를 따른다.
