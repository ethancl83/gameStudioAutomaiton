# 앱 운영 자동화 작업 맥락

Last Updated: 2026-09-12

## Current Execution Contract

- 프로젝트명·GitHub 저장소명: `gameStudioAutomaiton` (사용자가 지정한 철자 그대로). 소유자는 현재 인증된 `sphacker83`, 공개 범위는 private. 사용자 2026-09-12 지시로 이름 반영 후 커밋·최초 푸시를 진행한다. 앱 표시명·패키지 메타데이터를 통일하며 기존 데이터/키 보관함 식별자는 호환성을 위해 유지한다. 이름 변경 검증: 타입 검사·운영 앱 컴파일·패키징 메타데이터 읽기 통과.
- 유효 plan: [v5](app-operations-platform-plan-v5.md). v1~v4는 이력으로 보존한다. 재개 순서: v5 → [tasks](app-operations-platform-tasks.md) → 이 context.
- 이번 요청: 계정 연결 완료를 가정한 실사용 검토에서 보고한 항목을 수정한다. 게임 빌드는 외부에서 수행한다. Phase 14의 운영 오류·외부 결과물 경로·Apple 검사 후속 수정과 검증을 완료했다.
- 기존 전체 작업: Phase 13 및 Phase 2–11의 실계정·OS·장기 수용 조건 42개는 남아 있다. 총 14/56(25%)은 체크리스트 완수율이며 제품 구현률이 아니다. 이번 후속 수정 완료와 전체 장기 개발 완료를 구별한다.
- 금지 사항: 모의/데모 결과를 실서비스 검증으로 표시하지 않는다. 사용자 비밀 탐색·검증용 외부 배포/게시/광고 집행·고정 계획 덮어쓰기 금지. 개발 검증 당시에는 Git 저장소가 없었다. 이후 사용자 커밋·푸시 요청으로 main 저장소를 초기화했다. 최신 커밋·원격 상태는 git status/log/remote로 확인한다. 미리보기 인증 정보는 출력하지 않는다. 이번 후속 수정은 root가 단독 수행했다.

## SESSION PROGRESS

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

### 2026-09-11 22:00 KST — v4 준비 API·화면·SDK 이력 보호 통합 중

- 연결 완료: `packages/setup/` 준비 판정·공식 도구 카탈로그·스트리밍 설치와 `apps/controller/preparation.ts`의 영속 도구/프로젝트 설정. 도구 경로는 서비스별 인자로 전달하고 새 빌드 입력에 고정한다. `/setup` 계열 API·Electron 허용 경로·새 운영 준비 화면을 연결했다.
- 앱 매핑: `Project.storeApps`로 Play 패키지·Apple 앱 ID·Steam AppID와 계정을 별도 저장하고 실제 조회로 검증한다. 원본 모바일 식별자를 Steam 숫자로 덮어쓰지 않는다. 전역의 도구 1개/키 1개로 전체를 준비됨으로 표시하던 운영 요약을 프로젝트·대상별 판정으로 교체했다.
- SDK: Grok 최초 결과의 실제 API 불일치와 원본 프로젝트 내 이력 신뢰 문제가 독립 검토에서 발견됐다. root가 `withIntegrationStorage`로 운영 데이터 밖 원본과 분리된 이력 저장소를 강제하고 변경/백업 해시 검증, 원자적 잠금, 실패 복구, 편집 충돌, 중복 적용 방지를 다시 구현했다. `/projects/:id/integration`의 조회·미리보기·적용·되돌리기와 같은 데모/실제 UI를 연결했다. 템플릿·구매 완료 흐름은 수정 중이며 실행 검증 완료를 주장하지 않는다.
- 검증: 기존 SDK 검사 9/9, 추가 SDK 보호/복구 5/5, 준비 API·서비스 격리·부정 판정·Steam 매핑·SDK 적용/재시작/되돌리기 4/4 통과. 타입 검사 2026-09-11 21:56 KST 통과. 이후 템플릿 수정이 진행되므로 최종 재검사가 필요하다. 로그 `/tmp/appops-sdk-root-tests.log`, `/tmp/appops-sdk-security-tests.log`, `/tmp/appops-preparation-tests.log`, `/tmp/appops-typecheck-v4-green.log`.
- 워커 결과: Opus 수명주기/자동 시작 27개 집중 검사와 새 준비 화면 API 연결·데모 브라우저 확인을 회수했다. Grok 설치기와 실제 Linux Godot 공식 다운로드/압축 해제를 회수했고 타입 오류를 수정했다. 최종 독립 수용은 아직 진행 중이다.
- 네이티브 시험: 기존 시스템 `/opt/google/chrome/chrome-sandbox`가 root:root 4755임을 확인했다. 개발용 `node_modules/electron/dist/chrome-sandbox`만 해당 파일의 심볼릭 링크로 교체해 Electron 44.3.0/Chromium 152.0.7977.78의 **시험 창**을 `sandbox:true`로 실행하고 정상 종료했다. 원본은 `/tmp/appops-bundled-sandbox-<sha>`에 보존했다. 시스템 권한·설정 변경은 없다. 실제 제품 창·패키지 전체 검증과 안전한 런처 통합은 아직 남아 있다. 환경 변수 CHROME_DEVEL_SANDBOX는 이 Electron에서 무시됐다.
- OS 조사: Apple XNU 공식 소스에서 NOTE_TRACK/NOTE_CHILD가 macOS 10.5 이후 미지원임을 확인했다. 이를 이용한 자식 추적을 구현하거나 지원으로 표시하지 않는다. macOS 격리·서명과 Windows 격리·전체 암호화 백업·Gradle 의존성 준비·구매 서버 검증은 다음 핵심 작업이다.
- 다음: 템플릿 수정과 독립 리뷰 지적을 회수·통합하고 실제 앱 창을 검증한다. 프로젝트 수정 중 빌드/복구 차단을 보완하고 도구 설치·전체 백업·네이티브 실행의 남은 구현을 계속한다.


## 이전 세션 요약

- 2026-09-11 20:40 KST — v3 구현·화면·패키지 검증 완료 — 세부 결과는 검증 색인과 해당 버전 계획에 보존.
- 2026-09-11 — v2 키·SNS와 기반 구현 — 세부 결과는 검증 색인과 해당 버전 계획에 보존.
