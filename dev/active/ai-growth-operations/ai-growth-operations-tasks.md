# AI 성장 운영 자동화 Tasks

Last Updated: 2026-09-13

후속 구현은 아직 승인되지 않았다. 모든 항목은 예정 작업이며, AI는 채팅 제출 또는 화면의 `AI 요청` 버튼으로만 시작한다. 2차 주기 작업은 사용자가 요청한 구체적 범위·기간의 활성 `OperationMandate` 안에서만 실행하고, 외부 광고비·가격·메시지·게시를 사용하는 실계정 검증은 각 task의 별도 gate 전에는 실행하지 않는다.

## Phase 1 — 읽기 전용 성장 기준선 [상태: 대기]

- [ ] T-1.1 AI 요청·native session·성장 운영 위임 envelope와 데이터 계약 확정

### T-1.1 참조 블록

- 작업 전 필독: [v2의 명시적 요청·세션·mandate 계약](ai-growth-operations-plan-v2.md), [기존 자동화 정책](../../../docs/automation-policies.md), [지표 정의](../../../docs/metric-definitions.md)
- 원본 코드 참조: `packages/domain/index.ts:1`, `apps/controller/validation.ts:30`, `packages/storage/index.ts:9`, 안정화된 1차 Codex/OpenCode adapter 계약
- 구현 대상: `AIRequest`·`AgentSessionBinding`·`OperationMandate`·`GrowthPolicy` 타입/저장, controller 요청·resume/clear·정책 API, 최소 chat 진입 UI, 관련 단위 테스트
- 검증 참조: 채팅/`AI 요청`만 시작점, 버튼의 screen/selection snapshot 기록, 공급자가 반환한 native session ID 저장, clear 전 exact resume/실패 시 action_required/clear 후 새 session, 목표·기간·절대 한도 필수값과 기존 값 재사용, 등록·화면·재시작 자동 시작 0건
- 문서 반영: 구현 승인 시 `docs/metric-definitions.md`, `docs/automation-policies.md`, 이 tasks/context

- [ ] T-1.2 귀속 fact·FX·revision·신선도 read model 구현 (의존: T-1.1)

### T-1.2 참조 블록

- 작업 전 필독: [plan의 지표·귀속 계약](ai-growth-operations-plan-v2.md), [마케팅 연동](../../../docs/marketing-integration.md)
- 원본 코드 참조: `packages/domain/index.ts:87`, `packages/metrics/index.ts:4`, `apps/controller/service.ts:668`
- 구현 대상: `packages/metrics/`, connector metric normalization, 필요한 최소 SQLite document kind/index와 migration 검사
- 검증 참조: campaign/arm/cohort/window/basis grain, 환불·수수료 정정 lineage, 중복 source, 0 spend, 다중 통화·FX snapshot, stale watermark 검사
- 문서 반영: 구현 승인 시 `docs/metric-definitions.md`, data migration/복구 문서, 이 tasks/context

- [ ] T-1.3 ROAS·순이익 ROI 품질 진단과 읽기 전용 화면 구현 (의존: T-1.2)

### T-1.3 참조 블록

- 작업 전 필독: [plan의 두 지표 수식](ai-growth-operations-plan-v2.md), [현재 수익 화면](../../../apps/desktop/src/views/MonetizationView.tsx)
- 원본 코드 참조: `packages/metrics/index.ts:15`, `apps/desktop/src/views/MarketingView.tsx:17`, `apps/desktop/src/components/DailyMetrics.tsx:1`
- 구현 대상: metrics calculator/quality diagnostics, controller state/API, Marketing/Monetization read-only cards
- 검증 참조: ROAS와 순이익 ROI numerator/denominator 라벨, 미계산 사유, 통화/cohort/window 불일치, 현재 contribution 오표시 방지, browser QA
- 문서 반영: 구현 승인 시 `docs/metric-definitions.md`, `docs/desktop-usage.md`, 이 tasks/context

## Phase 2 — 한 공급자의 실험 관측 수직 단계 [상태: 대기]

- [ ] T-2.1 공급자 실험 capability probe와 지원표 구현 (의존: T-1.1)

### T-2.1 참조 블록

- 작업 전 필독: [plan의 공급자 지원 경계](ai-growth-operations-plan-v2.md), [연동 기능표](../../../docs/integration-capabilities.md), Google Ads Experiments 공식 링크
- 원본 코드 참조: `packages/connectors/google-ads.ts:7`, `packages/connectors/types.ts:1`, `apps/controller/service.ts:428`
- 구현 대상: Google Ads experiment read/probe adapter와 capability 상태, 실계정 검증 fixture
- 검증 참조: App campaign workflow, Campaign Mix allowlist, 권한/버전 불일치, 지원 없음의 명시적 `unsupported/action_required`, 외부 write 0건
- 문서 반영: 구현 승인 시 `docs/integration-capabilities.md`, 마케팅 운영 문서, 이 tasks/context

- [ ] T-2.2 가설·대조군·arm·사전 등록 상태 모델 구현 (의존: T-1.1, T-2.1)

### T-2.2 참조 블록

- 작업 전 필독: [plan의 실험·폐루프 계약](ai-growth-operations-plan-v2.md)
- 원본 코드 참조: `packages/domain/index.ts:58`, `packages/storage/index.ts:112`, `packages/storage/index.ts:128`
- 구현 대상: `Experiment`, `ExperimentArm`, `DecisionSnapshot` 타입/저장/API와 가설 UI
- 검증 참조: origin `OperationMandate`/기간, primary metric/최소 효과/guardrail/window와 fixed-horizon|sequential stopping rule 불변, optimistic version, 단일 active experiment 충돌, 변경 시 새 experiment 생성 검사
- 문서 반영: 구현 승인 시 experiment data contract 문서, 이 tasks/context

- [ ] T-2.3 control/treatment 지표 읽기와 observational 라벨 구현 (의존: T-1.2, T-2.2)

### T-2.3 참조 블록

- 작업 전 필독: [plan의 control·관찰 계약](ai-growth-operations-plan-v2.md), Google Ads experiment reporting 공식 링크
- 원본 코드 참조: `packages/connectors/google-ads.ts:30`, `apps/controller/service.ts:697`
- 구현 대상: arm metric ingestion, assignment evidence validator, experiment comparison UI
- 검증 참조: native split/arm 누락, campaign-only aggregate, 인과 추론 불가 비교의 `observational_comparison`, stale/sample 부족 표시
- 문서 반영: 구현 승인 시 `docs/metric-definitions.md`, `docs/integration-capabilities.md`, 이 tasks/context

## Phase 3 — 광고 실험 실행과 제한된 승자 확대 [상태: 대기]

- [ ] T-3.1 native experiment 생성·schedule·end adapter 구현 (의존: T-2.1~3)

### T-3.1 참조 블록

- 작업 전 필독: [plan Phase 3](ai-growth-operations-plan-v2.md), Google Ads experiment lifecycle 공식 링크, [이력·복구 계약](../../../docs/workflow-contract.md)
- 원본 코드 참조: `packages/connectors/google-ads.ts:30`, `packages/connectors/transport.ts:1`, `packages/storage/index.ts:137`
- 구현 대상: Google Ads experiment write adapter, capability operation fields, fixture tests
- 검증 참조: provider temp/resource IDs, `write:true`, pre-dispatch checkpoint, deterministic idempotency, rejected/timeout/long-running reconcile, test-account gate
- 문서 반영: 구현 승인 시 `docs/marketing-integration.md`, `docs/integration-capabilities.md`, 이 tasks/context

- [ ] T-3.2 탐색→관찰→평가 decision engine 구현 (의존: T-1.3, T-2.3)

### T-3.2 참조 블록

- 작업 전 필독: [plan의 실험 단계·다중검정](ai-growth-operations-plan-v2.md)
- 원본 코드 참조: `packages/metrics/index.ts:15`, `apps/controller/automation.ts:35`
- 구현 대상: fixed-horizon 또는 유효한 sequential experiment evaluator, configured significance/minimum effect/multiplicity/stopping strategy, immutable decision snapshot
- 검증 참조: fixed-horizon 중간 look의 효능 결정 0건, 사전 등록된 sequential look/boundary와 alpha 소비, 표본 부족/최대 기간/inconclusive, attribution window 미완료, Holm/FDR 선택 고정, primary metric 변경 금지, 재현 가능한 동일 결과
- 문서 반영: 구현 승인 시 `docs/metric-definitions.md`, experiment methodology 문서, 이 tasks/context

- [ ] T-3.3 정책 한도 내 promote·단계 증액·실패 중지 구현 (의존: T-3.1, T-3.2)

### T-3.3 참조 블록

- 작업 전 필독: [plan의 winner scaling/failure stop](ai-growth-operations-plan-v2.md), [자동화 정책](../../../docs/automation-policies.md)
- 원본 코드 참조: `apps/controller/campaign-budget.ts:5`, `apps/controller/validation.ts:46`, `apps/controller/service.ts:593`
- 구현 대상: `OperationMandate`-gated growth scheduler, budget/promotion policy gate, expiry/emergency pause, reconcile UI
- 검증 참조: 명시 요청 없는 due 생성 0건, scope/기간 만료 후 새 effect 0건과 dispatched reconcile, 재시작 시 활성 mandate만 resume, 일일/누적/step/cooldown 한도, stale/guardrail 차단, policy race, manual console drift, pause 허용, 중복 promote/증액 방지
- 문서 반영: 구현 승인 시 `docs/automation-policies.md`, `docs/workflow-contract.md`, 이 tasks/context

## Phase 4 — 수익 폐루프와 수익화 실험 [상태: 대기]

- [ ] T-4.1 광고비↔net proceeds cohort reconciliation 구현 (의존: T-1.2, T-3.2)

### T-4.1 참조 블록

- 작업 전 필독: [plan의 지표·폐루프 계약](ai-growth-operations-plan-v2.md), [스토어 수익 정의](../../../docs/metric-definitions.md)
- 원본 코드 참조: `packages/connectors/play-earnings.ts:1`, `packages/connectors/app-store.ts:526`, `packages/connectors/steam.ts:360`, `packages/metrics/index.ts:15`
- 구현 대상: cohort reconciliation service, revision invalidation, decision lineage UI
- 검증 참조: provider별 proceeds basis, refund/fee/tax 중복 차감 방지, MMP/arm 부재 차단, late correction winner invalidation
- 문서 반영: 구현 승인 시 `docs/metric-definitions.md`, 수익화 운영 문서, 이 tasks/context

- [ ] T-4.2 MAX ad-unit experiment 읽기→생성→promote/deprecate 구현 (의존: T-1.3)

### T-4.2 참조 블록

- 작업 전 필독: [plan의 MAX 경계](ai-growth-operations-plan-v2.md), AppLovin MAX Ad Unit Management API 공식 링크
- 원본 코드 참조: `packages/connectors/applovin-max.ts:29`, `packages/connectors/applovin-max.ts:128`, `apps/controller/service.ts:478`
- 구현 대상: MAX experiment adapter/capability, active experiment conflict gate, UI
- 검증 참조: `has_active_experiment`, create/get/promote/deprecate payload, segment scope, account/app ownership, timeout/reconcile, 실계정 write gate
- 문서 반영: 구현 승인 시 `docs/marketing-integration.md`, `docs/integration-capabilities.md`, 이 tasks/context

- [ ] T-4.3 가격·상품 제안, 고객경험 guardrail, rollback 구현 (의존: T-1.1, T-4.1)

### T-4.3 참조 블록

- 작업 전 필독: [plan의 제품·수익화 guardrail](ai-growth-operations-plan-v2.md), [스토어 연동](../../../docs/store-integration.md)
- 원본 코드 참조: `apps/controller/validation.ts:64`, `apps/controller/service.ts:478`, Play/Apple product connector operations
- 구현 대상: pricing policy/envelope, snapshot/proposal/effect/reconcile/rollback, Monetization UI
- 검증 참조: 지역/tier/신규·기존 cohort, entitlement·refund·payment·retention/crash guardrail, irreversible action gate, 원복 응답 유실
- 문서 반영: 구현 승인 시 수익화 운영 문서, `docs/automation-policies.md`, 이 tasks/context

## Phase 5 — 지식 기반 고객응대 read-only 단계 [상태: 대기]

- [ ] T-5.1 승인된 지식 revision 수집·검색·근거 계약 구현

### T-5.1 참조 블록

- 작업 전 필독: [plan의 지식 근거 계약](ai-growth-operations-plan-v2.md), [1차 v6](../app-operations-platform/app-operations-platform-plan-v6.md)
- 원본 코드 참조: `packages/agent/tools.ts:5`, `packages/domain/index.ts:33`, `apps/controller/service.ts:215`
- 구현 대상: `KnowledgeRevision` 저장/승인/API, 프로젝트·스토어·FAQ/changelog importer, read-only retrieval
- 검증 참조: source/version/hash/citation, 폐기 revision, 비밀/숨김/프로젝트 밖 파일 배제, 근거 없는 답변 차단
- 문서 반영: 구현 승인 시 community knowledge contract 문서, 이 tasks/context

- [ ] T-5.2 비신뢰 입력 격리와 구조화된 AI 분류·초안 구현 (의존: T-5.1, 1차 Agent 계약 안정화)

### T-5.2 참조 블록

- 작업 전 필독: [plan의 prompt injection·escalation 계약](ai-growth-operations-plan-v2.md), [소셜 운영](../../../docs/social-operations.md)
- 원본 코드 참조: `packages/social/types.ts:1`, `packages/agent/cli.ts:53`, `packages/agent/mcp.ts:17`
- 구현 대상: community AI adapter, schema validator, risk/intent/citation result, model timeout/fallback
- 검증 참조: prompt injection/secret/tool 요청, malformed output, hallucinated citation, multilingual text, provider text as data, 외부 effect 0건
- 문서 반영: 구현 승인 시 community AI safety 문서, 이 tasks/context

- [ ] T-5.3 민감도·opt-out·스팸 분류와 draft/escalation·요약 UI 구현 (의존: T-5.2)

### T-5.3 참조 블록

- 작업 전 필독: [plan의 SNS 고객응대 계약](ai-growth-operations-plan-v2.md), X Automation Rules 공식 링크
- 원본 코드 참조: `apps/controller/social-automation.ts:143`, `apps/desktop/src/views/CommunityView.tsx:550`
- 구현 대상: `ResponseIntent`/escalation/digest 상태, Community review UI, redaction
- 검증 참조: 환불/법적/분쟁/보안/개인정보/위기 입력 차단, opt-out, 근거 부족, 중복 interaction, 요약 PII 최소화
- 문서 반영: 구현 승인 시 `docs/social-operations.md`, `docs/automation-policies.md`, 이 tasks/context

## Phase 6 — 제한된 SNS 자동응대와 회수 [상태: 대기]

- [ ] T-6.1 플랫폼 정책 승인 evidence와 발송 전 gate 구현 (의존: T-5.3)

### T-6.1 참조 블록

- 작업 전 필독: [plan의 공급자/X·Threads 경계](ai-growth-operations-plan-v2.md), X Automation Rules, 최신 Threads 1차 정책
- 원본 코드 참조: `apps/controller/social-automation.ts:40`, `apps/controller/validation.ts:46`
- 구현 대상: platform approval record, opt-in/out registry, pre-send policy validator
- 검증 참조: 활성 `OperationMandate`의 계정/채널/기간/응답 범위, X 서면 승인 부재, Threads 정책 미검증, 원문 삭제, 민감 media/text, interaction당 1회, 정책 변경 race 차단
- 문서 반영: 구현 승인 시 `docs/social-operations.md`, `docs/integration-capabilities.md`, 이 tasks/context

- [ ] T-6.2 일반 문의의 idempotent 자동 답글·복구 구현 (의존: T-6.1)

### T-6.2 참조 블록

- 작업 전 필독: [이력·복구 계약](../../../docs/workflow-contract.md), [plan의 중복/스팸 계약](ai-growth-operations-plan-v2.md)
- 원본 코드 참조: `apps/controller/social-automation.ts:125`, `packages/storage/index.ts:137`, `apps/controller/queue.ts:23`
- 구현 대상: approved `ResponseIntent`→기존 `reply` Run/effect durable queue bridge, policyVersion과 분리된 외부 reply identity key, read reconcile
- 검증 참조: 자동 승인도 `authorized→queued→prepared→dispatched` 통과, AI/UI direct writer 0건, policy/knowledge version 변경 후 같은 interaction 재발송 0건, queued/dispatched/confirmed/unresolved 재시작, 유사 문구/빈도 한도, account/project ownership, 결과 불명 비재발송
- 문서 반영: 구현 승인 시 `docs/workflow-contract.md`, `docs/social-operations.md`, 이 tasks/context

- [ ] T-6.3 pause·회수·incident·운영 요약 구현 (의존: T-6.2)

### T-6.3 참조 블록

- 작업 전 필독: [plan의 회수·요약 계약](ai-growth-operations-plan-v2.md), 공급자 delete/정정 정책
- 원본 코드 참조: `apps/controller/service.ts:471`, `apps/controller/service.ts:672`, `packages/social/x.ts`, `packages/social/threads.ts`
- 구현 대상: policy pause, recall run, incident linkage, digest/alert UI
- 검증 참조: 본인 글 소유권, 자동 hide 금지, delete 실패/timeout, pause 이후 pending fence, 원문·정정·후속 연결
- 문서 반영: 구현 승인 시 incident/recall runbook, `docs/social-operations.md`, 이 tasks/context

## Phase 7 — 피드백에서 제품 개선 실험까지 [상태: 대기]

- [ ] T-7.1 FeedbackItem 정규화·중복 수집 방지 구현 (의존: T-5.2)

### T-7.1 참조 블록

- 작업 전 필독: [plan의 이슈 연결 계약](ai-growth-operations-plan-v2.md)
- 원본 코드 참조: `apps/controller/service.ts:679`, `packages/social/helpers.ts`, `apps/controller/social-automation.ts:146`
- 구현 대상: feedback normalizer/store/API, source retention/redaction, ingestion tests
- 검증 참조: provider/account/interaction 중복, 다국어·편집/삭제, PII 최소화, project/version/platform 매핑 불명 처리
- 문서 반영: 구현 승인 시 feedback data contract, 이 tasks/context

- [ ] T-7.2 설명 가능한 IssueCluster 후보·병합·우선순위 구현 (의존: T-7.1)

### T-7.2 참조 블록

- 작업 전 필독: [plan의 cluster·우선순위 계약](ai-growth-operations-plan-v2.md)
- 원본 코드 참조: `packages/storage/index.ts:112`, 1차 AI adapter의 안정화된 structured-result pattern
- 구현 대상: cluster candidate/merge/split audit, priority dimensions, review UI
- 검증 참조: 동일 오류 키/유사 표현/반대 의미/서로 다른 버전, 애매한 자동 병합 금지, source trace, 불투명 단일 점수 금지
- 문서 반영: 구현 승인 시 issue triage contract, 이 tasks/context

- [ ] T-7.3 제품 가설·release·성과 실험 링크 구현 (의존: T-7.2, T-4.1)

### T-7.3 참조 블록

- 작업 전 필독: [plan Phase 7](ai-growth-operations-plan-v2.md), [출시 관측 계약](../../../docs/automation-policies.md)
- 원본 코드 참조: `packages/domain/index.ts:92`, `apps/controller/release-observations.ts`, `apps/controller/pipelines.ts`
- 구현 대상: `ProductExperimentLink`, 승인 gate, release/version cohort observation UI
- 검증 참조: 개발 미승인 시 코드 작업 미생성, release 전후 cohort 혼합 방지, 수정 없는 계절 변화, rollback/재출시 lineage
- 문서 반영: 구현 승인 시 product experiment runbook, 이 tasks/context

## Phase 8 — 운영 통합과 실계정 단계적 수용 [상태: 대기]

- [ ] T-8.1 scheduler·상태·복구·backup fencing 통합 (의존: T-3.3, T-4.3, T-6.3, T-7.3)

### T-8.1 참조 블록

- 작업 전 필독: [plan의 주기·상태·복구 계약](ai-growth-operations-plan-v2.md), [포터블 백업](../../../docs/portable-backup.md)
- 원본 코드 참조: `apps/controller/automation.ts:35`, `apps/controller/service.ts:78`, `packages/backup/snapshot.ts:66`
- 구현 대상: `OperationMandate`-gated unified growth cycle, due stamps/watermarks, expiry/cancel fence, maintenance fence, restore pause/relink behavior
- 검증 참조: 등록/페이지/재시작의 새 mandate·AI session 생성 0건, 활성 mandate만 resume, 만료 후 신규 평가·외부 effect 0건과 dispatched reconcile, concurrent tick, crash/lease, stale intent, restore 이후 외부 write 0, 연결/정책/지식 revision 변경 재평가
- 문서 반영: 구현 승인 시 `docs/workflow-contract.md`, `docs/portable-backup.md`, 이 tasks/context

- [ ] T-8.2 목표·실험·응답·이슈 운영 화면과 알림 완성 (의존: T-8.1)

### T-8.2 참조 블록

- 작업 전 필독: [plan의 목표 상태와 완료 조건](ai-growth-operations-plan-v2.md), [desktop 사용법](../../../docs/desktop-usage.md)
- 원본 코드 참조: `apps/desktop/src/App.tsx:63`, chat surface와 Marketing/Monetization/Community/History views, `apps/desktop/src/components/OperationNotifications.tsx`, 안정화된 1차 session adapter
- 구현 대상: 채팅 및 각 화면의 `AI 요청` 버튼, screen/selection request entry, native session ID resume/clear 표시, mandate scope/period와 due/status/watermark/blocker/decision/pause/stop/escalation UI 및 API client
- 검증 참조: 버튼이 같은 채팅에 현재 화면/선택 요청을 기록, clear 전 동일 native ID resume/clear 후 새 ID, provider 전환·resume 실패 시 조용한 새 session 금지, 등록/화면 진입 자동 호출 0건, 데모/실제 모드 구분, 키보드/오류/빈 상태, 미검증 capability 비활성, decision evidence drill-down, browser/Electron QA
- 문서 반영: 구현 승인 시 `docs/desktop-usage.md`, 운영 runbook, 이 tasks/context

- [ ] T-8.3 공급자별 실계정 gate·장기 관찰·독립 리뷰 (의존: T-8.2)

### T-8.3 참조 블록

- 작업 전 필독: [plan의 공급자 경계와 Phase 8](ai-growth-operations-plan-v2.md), [검증 기록](../../../docs/verification.md), 사용자 제공 AGENTS 리뷰 기준
- 원본 코드 참조: 전체 관련 diff, 공급자 connector/queue/policy/metrics/social/UI 통합 경로
- 구현 대상: test/sandbox fixture, 실계정 검증 체크리스트와 증거, 발견 결함 수정은 별도 승인 범위
- 검증 참조: 명시적 채팅/버튼 요청과 scope/period mandate 증거→읽기→test/sandbox write→사용자 지정 최소 한도 write→장기 관찰; fixed/sequential 통계 rule, reply external identity/durable queue, session resume/clear; 전체 test/typecheck/build/Electron; 구현자와 분리된 최초 독립 리뷰
- 문서 반영: 구현 승인 시 `docs/verification.md`, `docs/integration-capabilities.md`, 이 tasks/context 및 root가 관리하는 catalog
