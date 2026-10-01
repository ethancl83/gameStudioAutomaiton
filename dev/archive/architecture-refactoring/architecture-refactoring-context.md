# 아키텍처 안전성 및 책임 경계 개선 Context

Last Updated: 2026-10-01
Completed: 2026-10-01
Status: 완료

## Current Execution Contract

- 유효 plan: [architecture-refactoring-plan.md](architecture-refactoring-plan.md). 원본 내용과 bootstrap SHA-256을 유지했다.
- Phase: Phase 1~8 완료
- Task: 16/16 완료. 필수 구현·최초 독립 리뷰·지적 수정·최종 타입/빌드/전체 검사·문서 종결을 충족했다.
- 범위: 로컬 모듈형 모놀리스·SQLite·vault·단일 Controller 소유권을 유지하며 안전성·책임·조회 경계를 개선했다. 기존 사용자 변경은 보존했다.
- 권한: 구현·검증 단계에서는 커밋·push·merge·배포·실계정 외부 변경을 수행하지 않았다. 이후 사용자가 로컬 커밋을 요청해 검증한 코드와 기록을 커밋했다. push·merge·배포·실계정 외부 변경은 요청 범위에 없다. 기존 제품 계획의 실계정·다른 OS·장기 수용 항목은 이 작업으로 완료 처리하지 않는다.

## 빠른 재개 안내

- 이 리팩터링의 필수 후속 작업과 blocker는 없다. 최종 계약·검증은 [실행·복구 계약](../../../docs/workflow-contract.md)과 [검증 기록](../../../docs/verification.md#2026-10-01-아키텍처-안전성책임-경계-개선)에 있다.
- 계획과 [tasks](architecture-refactoring-tasks.md)는 완료 이력이다. 재검증이 필요한 새 변경이 생기면 `npm run typecheck`, `npm run build`, `npm test`를 실행한다.
- 기존 장기 제품 수용은 [앱 운영 계획](../../active/app-operations-platform/app-operations-platform-plan-v11.md)과 [성장 운영 계획](../../active/ai-growth-operations/ai-growth-operations-plan-v2.md)을 따른다. 불변 plan의 두 관련 계획 링크는 bootstrap 당시 active 폴더 기준 상대 경로이므로 현재 유효 경로는 이 문단을 사용한다.
- 임시 우회책은 없다. SQL EXISTS/결정 복합 인덱스는 실제 성능 병목 근거가 생길 때의 선택적 개선이며 필수 미해결 항목이 아니다.

## SESSION PROGRESS

### 2026-10-01 — 사용자 후속 커밋 요청

- 검증한 앱/패키지/검사와 필요한 미커밋 성장 운영 기반을 `cd3a6a6` (`fix(architecture): 성장 운영 기반과 실행 안전성 및 책임 경계 정리`)에 기록했다. 계획·검증/계약·archive 색인은 별도 docs 커밋으로 기록한다.
- 검사 뒤 코드 변경은 Pricing.tsx EOF 빈 줄 하나 제거뿐이며 staged bytes와 현재 소스를 비교했다. 이전 타입·빌드·전체 716pass/13skip 근거를 재사용하고 staged diff 공백 검사를 통과했다.
- 별도 기존 문서 변경과 tmp/런타임 산출물을 제외했다. catalog에서는 이번 작업의 Last Updated 갱신만 스테이징하고 다른 작업의 기존 변경은 남겼다. plan 원본은 수정하지 않는다. push는 수행하지 않는다.

### 2026-10-01 — 구현·리뷰 수정·최종 검증 및 종결

- 안전성: 프로세스 identity·ChildProcess 생존/부모 검증, 성장 예약/출처/업무 문서 원자성, 결과/reconcile/effect/완료 원자성, 저장 실패 rollback/큐 중단을 연결했다. 정확한 전체 이력 SQL과 await 후 재검사, CLI 시작 전 원장 및 기존 웹 배포 호환 복구를 구현했다.
- 책임 경계: reusable runner를 packages/runner로 옮기고 entrypoint·Docker context·credentials 소비자를 연결했다. 공급자 client 추출로 정적 순환 3개를 제거했고 성장 AI CLI를 agent로 옮겼다. 8개 기능은 좁은 hooks를 받고 결과/정책은 별도 모듈이 맡는다. 경계 검사를 typecheck에 연결했다.
- 저장/조회/UI: typed 문서·DB 상위 버전 보호, 프로젝트 scope·결정 keyset page 및 실제 API/IPC/UI를 연결했다. shared 개발 DTO와 DevelopmentView 책임별 구성요소, 성장 poll의 늦은 응답 처리를 구현했다. 표시 cap과 안전 SQL·global digest·cohort 계산을 구분했다.
- 최초 독립 리뷰: 구현 전 위험 계약과 구현 후 backend/query/개발 UI는 별도 Sol 세션, connector는 별도 Opus 세션에서 검토했다. backend 2건(PID 재사용/web check와 수동 종결 경합)과 query 2건(느린 poll 영구 로딩/상한 밖 blocked 누락)은 원래 구현자가 red→green 회귀로 수정했다. root가 실제 코드·diff·회귀 근거로 종료했다. UI 분리와 connector에는 필수 결함이 없었다.
- 집중 검증: 프로세스 signal spy10/10, 실제 macOS setsid 자손1/1, 웹 안전성12/12; query8/8과 성장23/23. 기존 runtime/mac41/41, Electron 개발20/20을 보존했다. 성장 native11/11과 6초 지연 첫 로드/다음 poll2/2 응답도 통과했고 fixture 외부 write는0건이다. 중복되는 검증 수치를 합산하지 않는다.
- 첫 전체 게이트: typecheck/build는 통과했고 npm test는729개 중714통과/2실패/13skip이었다. 정확한 SQL은 같은 주기에 새로 예약한 sync-app도 pending으로 감지한다. 테스트를 앱 완료 후 다음 tick의 account sync1회·중복 없음으로 수정했고, 제거한 private persistResult 호출은 results 모듈의 transaction 호출로 연결했다. 앱 코드 변경 없이 해당5/5 통과 후 새 최종 freeze를 검증했다.
- 최종 게이트: typecheck/build/full suite 모두exit0. 전체729개 중716통과/0실패/0취소/13환경skip,21.56초. 경계 검사273파일. 전후 및 root 회수 후381파일 fingerprint는 `df50f8d5bf6099243aaf9f7ec185623f1e0f3b6a4062ed1b7b5149c0d9e4405a`로 일치한다. 상세 로그는 [최종 실행 기록](../../../tmp/architecture-refactoring/final-verification.md)에 보존했다.
- 한계: query 수정 전 native red는 dist가 이미 수정된 상태라 확보하지 못했다. 결정적 timer/저장 red→green과 최신 native green을 구분한다. 이번 실행에서 Linux/Windows 전체 검사·Docker 이미지 재빌드·실계정/설치 패키지/장기 수용은 수행하지 않았다. ps 해상도 및 snapshot/kill OS 경합, 미관찰 고아 추적 제한과 기존 Vite chunk 경고는 검증 문서에 기록했다.
- 모델 관찰: Astra high(안전성), Sol high(backend/독립 리뷰), Opus 5.5 high(UI/공유 query 및 connector 리뷰), Luna max(실행 검증)의 실제 session 모델/effort를 요청값과 대조했다.
- 실행 경로: Orca custom argv/noninteractive 실행을 사용했으며 권한 우회 flag를 추가하지 않았다. TUI 준비 감지/로컬 RPC 실패와 query 리뷰 capacity 실패는 실제 실패를 확인해 fencing·새 Dispatch 재개 후 정리했다. 같은 검증 세션을 새 Task로 재사용하여 최종 게이트를 수행했다. mailbox Delivery는 처리 후 ack했다.
- 종료: 마지막 QA Task `task_40974d7a3677`/Dispatch `ctx_cb975fcb392d` 결과를 실제 로그와 비교해 회수했다. settled Dispatch를 release하고 custom 실행용으로 만든 정확한 터미널을 닫았다. 불변 plan은 그대로 archive로 이동하고 context/tasks·검증/계약·색인을 종결했다.

### 2026-09-30 — 전체 개선 범위 고정 및 팀 구현 착수

- 전체 코드 분석에서 안전성 결함5개와 의존성/책임/조회 개선을 확인했다. 당시 타입·빌드와 안전한159개 검사는 통과했으며 전체 검사는 P0 수정 전 완료 근거가 없었다.
- 사용자가 전체 계획의 문서 고정과 ai-team 구현을 승인했다. 기존 모듈형 모놀리스·SQLite를 유지하고 새 의존성 없이 확인한 결함부터 구현하기로 결정했다.

## 핵심 파일과 역할

- `packages/runner/process-tree.ts` — 검증한 루트·자손 identity와 종료 대상 추적
- `packages/storage/index.ts`, `documents.ts`, `document-query.ts` — 원자성·정확한 안전 SQL·typed 문서·범위/커서 질의
- `apps/controller/contracts.ts`, `results.ts`, `policy.ts` — 기능 hooks·결과 저장·정책 경계
- `apps/controller/service.ts`, `queue.ts`, `growth*.ts`, `web-deployments.ts` — 실행·업무 출처·외부 변경 원장
- `apps/desktop/src/views/development/`, `views/growth/`, `api.ts`, `packages/development/types.ts` — UI 책임·공유 조회 계약
- `scripts/check-architecture.mjs` — packages→apps/runner→controller 및 정적 runtime 순환 검사

## 중요한 의사결정

- 공급자·런타임을 별도 서비스로 분산하지 않는다. 실제 사용 중인 경계를 분리하고 DB 트랜잭션으로 안전성을 확보하는 것이 현재 결함을 해결하는 가장 단순한 방향이다.
- 표시 상한 밖의 미확정 effect와 열린 응답도 안전/업무 검사에 포함한다. 프로젝트 fact 전체와 studio-global digest의 기존 의미를 임의 시간 제한으로 바꾸지 않는다.
- 시작 상태는 `/tmp/studio-architecture-team-current`가 가리키는 OS scratch baseline에 보관했다. 독립 리뷰는 git HEAD뿐 아니라 해당 baseline delta를 검토해 기존 미커밋 사용자 변경과 구분했다.
- Orca Run: `run_166bfb662f90`. 계획 원본 SHA-256: `966bd1f48ae7538c9df6f001158cf66e94241fbca676c6951a03d86c3afeef1c`.
