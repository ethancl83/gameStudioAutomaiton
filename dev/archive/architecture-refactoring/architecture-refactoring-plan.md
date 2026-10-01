# 아키텍처 안전성 및 책임 경계 개선 Plan

Created: 2026-09-30
Last Updated: 2026-09-30
Description: Architecture safety, atomic execution and module boundary refactoring

## 요약

Electron·Controller·SQLite로 구성된 로컬 모듈형 모놀리스를 유지하면서, 전체 코드 분석에서 재현한 프로세스 종료·외부 변경 추적·저장 원자성 결함을 먼저 수정한다. 이후 패키지 의존성 방향, 공급자 순환 참조, 서비스와 UI의 책임, 저장·조회 계약을 정리한다. 사용자는 전체 계획의 문서 고정과 ai-team 구현을 승인했다. 이 계획은 불변 기준이며 실제 진행·검증·후속 결정은 context와 tasks에 기록한다.

## 현재 상태 분석

- `apps/runner/process-tree.ts`: macOS에서 부모의 시작 시각을 비교할 때 미등록 PID와 프로세스 테이블에 없는 PID가 모두 undefined이면 일치로 판단한다. 신호를 보내지 않은 재현에서 존재하지 않는 루트로 호스트 571개 프로세스와 제어 프로세스 자신까지 수집했다.
- `apps/controller/growth.ts`, `growth-community.ts`, `growth-pricing.ts`: 외부 변경 run 생성 뒤 위임·응답·가격 변경 출처를 별도 저장한다. 저장 실패 시 출처 없는 queued run이 남으며 assertDispatch는 출처가 없으면 통과한다.
- `apps/controller/service.ts`, `automation.ts`, `operations.ts`, `project-integrations.ts`: 최근 10,000~100,000개 run 목록으로 안전성·활성 작업을 판단하여 오래된 미확정 외부 변경을 놓친다.
- `apps/controller/web-deployments.ts`: 외부 CLI를 실행한 뒤 dispatched를 저장하며 공통 effects 원장 및 프로젝트 삭제 가드와 분리되어 있다.
- `apps/controller/queue.ts`, `service.ts`, `packages/storage/index.ts`: 결과 문서 저장과 run 완료가 별도 트랜잭션이며 완료 저장 실패를 catch에서 숨긴다. 재현에서 결과만 저장되고 run은 running, queue active는 0, 오류 이벤트는 0이었다.
- `packages/build-credentials`, `packages/remote-runner`가 `apps/runner`를, runner가 Controller의 validation을 참조한다. Google Ads·AppLovin Ads·MAX 커넥터는 구현/실험·소재 모듈 사이 3개 정적 순환 참조를 가진다.
- `AppService`는 조립·정책·실행·결과 저장을 함께 담당하고 기능 Controller 8개가 전체 서비스에 접근한다. growth의 순수 업무 규칙과 CLI AI 실행도 같은 패키지에 있다.
- `Store.get<T>/list<T>`는 호출자가 문서 타입을 지정하며 state polling이 전체 resource/metric/growth 데이터를 반복 로딩한다. DevelopmentView는 Git·GitHub·작업·문서·터미널 책임을 함께 가진다.
- 분석 시 typecheck/build와 안전한 범위 159개 테스트는 통과했다. 전체 테스트는 프로세스가 중간 종료되어 완료 근거가 없으며 P0 수정 전 재실행하지 않는다.

## 목표 상태

- 종료 대상은 검증한 빌드 프로세스 그룹 및 실제 자손으로 제한된다. PID 재사용·루트 소멸·호스트 프로세스·수집 경합을 안전하게 처리한다.
- 모든 외부 변경은 실행 전에 durable prepared/dispatched 추적을 가진다. 성장 출처·관련 업무 문서와 예약은 하나의 트랜잭션으로 저장하며 미확정 결과는 자동 재전송하지 않는다.
- 결과·effects·run 완료는 원자적으로 확정한다. 저장 실패는 명시적으로 보고하고 큐를 멈추며 소유권 상실만 정상 fencing으로 처리한다.
- 안전 가드는 표시용 최근 목록과 분리한 정확한 SQL 질의를 사용한다. 기존 웹 배포 기록도 미확정 상태를 보존하고 삭제를 차단한다.
- 앱 엔트리포인트는 패키지를 조립한다. packages는 apps를 import하지 않으며 공급자 공유 HTTP 기능은 하위 클라이언트에 둔다.
- 성장 규칙은 CLI 실행을 주입받고, 기능 Controller는 필요한 좁은 계약만 받는다. AppService의 결과 저장 및 정책 실행 책임을 응집된 단위로 분리한다.
- 저장 문서의 타입과 실제 조회 범위를 연결하고 프로젝트·기간·페이지에 필요한 SQL만 실행한다. UI에서 책임별 구성요소와 공통 타입 계약을 사용하며 기존 상호작용과 IPC 명시적 허용 규칙을 유지한다.

## 실행 계약

- 기존 수정·새 파일을 보존한다. 이번 변경의 시작 상태는 OS 임시 경로에 별도 보관하여 리뷰에서 이전 변경과 구분한다.
- 새 의존성·서비스 분산·ORM·일괄 타입 단언·가짜 성공 결과를 추가하지 않는다. SQLite WAL/FULL, 단일 Controller 임대, run fencing, durable idempotency, vault/모드/IPC 경계를 유지한다.
- 실제 계정 외부 변경, push·merge·배포·공개 게시·커밋은 이번 실행 범위에 없다. 이전 제품 계획의 실계정·다른 OS·장기 관찰 게이트를 완료로 바꾸지 않는다.
- 동일 계약은 한 담당자가 순차 구현한다. 독립 편집 범위만 병렬화한다. 위험이 큰 프로세스·원장·원자성 계약은 구현 전 독립 검토하고 팀 산출물은 최초 독립 리뷰를 받는다.
- 배정: 상태·원자성·프로세스·의존성 통합은 Codex Astra high, 분리된 공급자 백엔드는 Codex Sol high, 화면/조회 공통 계약은 Claude Code Opus 5.5 high. 실행 검증은 Codex Luna max, Astra/Opus 결과 리뷰는 Sol high, Sol 결과 리뷰는 Opus high. 현재 코디네이터는 문서·통합과 승인된 직접 작업을 맡는다.
- 기능 범위 변경이 필요하면 기존 plan을 수정하지 않고 새 버전을 기록한다. 구현 방법의 세부 결정과 진행은 context로 관리한다.

## Phase 실행 지도

### Phase 1 — 계획 고정과 위험 계약 검토

- 목표: 전체 개선 범위와 회귀 조건을 고정한다.
- 작업: 계획·진행 문서와 색인 생성, 시작 상태 보존, 위험 계약 독립 검토.
- Acceptance Criteria: 모든 분석 항목에 구현 단계·완료 조건이 있고 위험 계약 검토의 필수 지적을 해소한다.
- 검증 게이트: 문서 링크/체크리스트/역할 확인, 별도 Sol 세션의 근거 기반 설계 검토.

### Phase 2 — macOS 프로세스 종료 범위 수정

- 목표: unrelated host process를 수집·종료하지 않는다.
- 작업: 루트/자손 시작 시각과 그룹 검증, 수집 경합·PID 재사용 처리, 안전한 테이블/신호 주입 회귀 테스트.
- Acceptance Criteria: PID 0·없는 루트·자기/조상·이전 PID·외부 그룹이 신호 대상에 들어가지 않고 관찰된 setsid 자손 종료를 보존한다.
- 검증 게이트: 신호 spy 기반 결정적 회귀 후 제한된 detached child 테스트 및 mac-isolation 기존 검사. 전체 runner 검사는 이 단계 이후 실행한다.

### Phase 3 — 예약·결과 원자성과 오류 전파

- 목표: 외부 변경의 출처와 완료 상태가 저장 실패에 의해 분리되지 않는다.
- 작업: 원자적 run 예약+업무 문서 생성, growth/reply/pricing 호출 연결, 출처 누락 fail closed, 결과와 완료·reconcile 동시 commit, fencing 외 오류 보고/큐 중단.
- Acceptance Criteria: 트랜잭션 실패에 고아 run/부분 결과가 없고 idempotent 기존 run의 출처 충돌을 숨기지 않는다. 저장 실패 후 자동 외부 재전송이 없다.
- 검증 게이트: 저장 실패 주입·복구·위임 정지·reply/pricing 예약·완료 회귀, storage/growth/controller 테스트.

### Phase 4 — 정확한 안전 질의와 웹 배포 원장

- 목표: 전체 이력의 미확정 외부 변경을 빠짐없이 추적한다.
- 작업: 활성/미확정 run의 SQL 질의·인덱스, 모든 capped 안전 호출 교체, 배포 실행 전 effect 기록과 기존 기록 호환 삭제/복구 차단.
- Acceptance Criteria: 최근 100,000개 뒤의 미확정 effect도 삭제/충돌을 차단하고 CLI 실행 전에 durable dispatch가 존재한다. 임의 provider 연결을 만들지 않으며 기존 배포 기록을 삭제하지 않는다.
- 검증 게이트: 100,001개 이력 fixture, 프로젝트/연결 삭제·배포 저장 실패/재시작/불확실성 회귀.

### Phase 5 — 패키지 방향과 공급자 순환 참조 정리

- 목표: 재사용 구현은 packages에 있고 앱은 조립만 한다.
- 작업: runner/runtime/snapshot/secret/exclude 정책의 패키지 이동, runner→Controller validation 제거, Docker context 소비자 연결, 공급자 HTTP helper 하위 추출.
- Acceptance Criteria: packages→apps 역참조가 없고 확인한 커넥터 정적 순환 3개가 제거되며 엔트리포인트·격리·서명·snapshot 동작을 보존한다.
- 검증 게이트: 정적 경계·순환 검사, runner/remote/build-credentials/connector 회귀, Docker context 검사와 typecheck/build.

### Phase 6 — 서비스·성장 규칙 책임 분리

- 목표: 업무 기능이 AppService 전체 구현 및 CLI 런타임을 알지 않는다.
- 작업: 실제 사용하는 좁은 기능별 hooks 계약, 결과 저장·정책 실행 책임 분리, growth AI CLI 구현을 agent adapter로 이동하고 pure classify injection 유지.
- Acceptance Criteria: 기능 Controller의 전체 AppService 타입 의존을 제거하고 성장 업무 패키지가 child_process 실행을 소유하지 않는다. 기존 모든 요청 소비자를 연결한다.
- 검증 게이트: 타입 검사·agent/growth/controller/operations/development 회귀, runtime import 경계 확인.

### Phase 7 — 타입 있는 저장·범위 조회·화면 책임 정리

- 목표: 표시와 실행 계약이 타입 및 조회 범위로 명확해진다.
- 작업: 핵심 DocumentKind와 payload 대응 타입/검증, DB 버전 보호, project/time/cursor SQL 질의, state polling의 중복 전체 로딩 제거, 공유 API/operation DTO와 DevelopmentView 책임별 컴포넌트 연결.
- Acceptance Criteria: 기존 DB·백업 호환을 유지하고 미지원 DB 버전을 덮어쓰지 않는다. 조회 범위/페이지 경계가 정확하며 기존 화면·모드·IPC allowlist 동작을 보존한다.
- 검증 게이트: 저장/백업/페이지 및 API contract 회귀, UI typecheck/build와 기존 desktop 개발·growth 검증 중 환경에서 가능한 실행.

### Phase 8 — 통합 검증·독립 리뷰·기록 종결

- 목표: 같은 최종 코드 상태에서 전체 연결을 확인한다.
- 작업: 타입·빌드·전체 테스트, 팀 구현 독립 리뷰, 지적 수정의 집중 회귀, 문서/색인 갱신.
- Acceptance Criteria: 이번 범위의 필수 결함·회귀가 해소되고 검증 불가 항목은 근거를 기록한다. 이전 실계정 수용을 이 작업 완료로 가장하지 않는다.
- 검증 게이트: npm run typecheck, npm run build, npm test; 최종 diff/새 파일 독립 리뷰; 환경 의존 skip/미실행은 명시.

## 리스크와 완화 전략

| 리스크 | 영향 | 완화 |
|---|---|---|
| 프로세스 종료 오수집 | 호스트/검증/앱 종료 | 신호 없는 결정적 회귀를 먼저 실행하고 알려진 자손만 허용 |
| 외부 요청 후 저장 실패 | 중복 변경·출처 유실 | 실행 전 durable dispatch, 원자적 settlement, 불확실성 fail closed |
| 기존 미커밋 작업 | 변경 유실·리뷰 오판 | 시작 상태 별도 보존, 단일 파일 소유권, 기준 snapshot diff |
| 큰 책임 분리 | 호출자·Docker·IPC 회귀 | 실제 소비자 연결과 phase별 좁은 검증, 기존 contracts 재사용 |
| 장기 데이터/기존 DB | 안전 가드 누락·페이지/버전 오류 | capped 표시와 안전 SQL 분리, 기존 레코드/백업 호환 테스트 |
| 네이티브·다른 OS·실계정 제한 | 확인되지 않은 수용 | 이번 로컬 검증과 기존 제품 acceptance를 구분하고 미충족을 명시 |

## 관련 기준

- [워크플로 계약](../../../docs/workflow-contract.md)
- [구현 계약](../../../docs/implementation-contract.md)
- [기존 앱 운영 계획](../app-operations-platform/app-operations-platform-plan-v11.md)
- [성장 운영 계획](../ai-growth-operations/ai-growth-operations-plan-v2.md)
