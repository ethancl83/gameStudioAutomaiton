# AI 성장 운영 자동화 Context

Last Updated: 2026-09-13

## Current Execution Contract

- 유효 plan: [ai-growth-operations-plan-v2.md](ai-growth-operations-plan-v2.md)
- Active Phase: Phase 1 — 읽기 전용 성장 기준선
- Active Task: T-1.1 AI 요청·native session·성장 운영 위임 envelope와 데이터 계약 확정
- 완료 조건: v2 기획 보완은 완료했다. 전체 작업 완료는 T-1.1~T-8.3의 구현·검증·실계정 gate가 별도 승인 후 모두 충족되고, 암묵적 AI 시작이나 미지원 공급자 기능을 완료로 표시하지 않았을 때다.
- 금지 사항: 현재는 이 디렉터리의 `plan-v2/tasks/context` 외 편집, bootstrap plan 수정, 제품 구현·테스트 변경, catalog/다른 Dev Docs/AGENTS/README 편집, 커밋·push, 외부 광고/가격/메시지/게시·실계정 쓰기를 하지 않는다.

## SESSION PROGRESS

### 2026-09-13 — 명시적 요청·CLI 세션·주기 작업 위임 계약으로 v2 보완

- 완료: bootstrap plan을 수정하지 않고 `plan-v2`를 만들고 24개 예정 task의 최신 plan backlink를 갱신했다. 채팅/`AI 요청`만 AI 시작점으로 두고, 버튼의 화면·선택 request 기록, 실제 Codex/OpenCode native session ID의 clear 전 resume/clear 후 신규 세션, 구체적 범위·기간의 `OperationMandate`만 주기 실행하는 계약을 반영했다.
- 결정: 등록·화면 진입·재시작은 AI나 새 mandate를 시작/연장하지 않는다. 재시작은 유효한 기존 mandate만 resume한다. SNS 외부 reply identity에서 policyVersion을 분리하고, fixed-horizon 또는 사전 등록 sequential rule만 효능 판단에 쓰며, 자동 승인 reply도 durable queue를 반드시 통과한다.
- 수정: `ai-growth-operations-plan-v2.md`는 변경 기준, tasks는 24개 구현 완료 조건과 검증, context는 최신 실행 계약과 재개 순서를 기록한다. 제품 코드와 catalog는 수정하지 않았다.
- 다음: 구현이 승인되면 T-1.1에서 1차 Agent 계약을 확인한 뒤 `AIRequest`·`AgentSessionBinding`·`OperationMandate`의 저장/상태/실패 계약부터 작은 read-only 수직 단계로 구현한다.

### 2026-09-13 — 2차 AI 성장 운영 기획 기준선 작성

- 완료: 현재 Electron/React/controller/SQLite/vault/광고·수익·소셜·metrics 흐름과 최신 v6→tasks→context, 필수 운영 문서 4개를 대조했다. ROAS/순이익 ROI, 귀속·신선도, 실험 lifecycle, 공급자 경계, 수익화/고객경험 guardrail, AI 고객응대, 피드백 issue loop를 plan과 8 Phase·24 task로 기록했다.
- 결정: 외부 쓰기 전에 Phase 1 읽기 전용 지표 기준선과 Phase 2 native assignment 관측을 먼저 만든다. 무작위/상호 배타 assignment를 증명하지 못하면 A/B가 아니라 observational comparison이다. X AI 자동 답글은 서면 승인 증거 없이는 draft-only, Threads는 최신 정책 근거 확인 전 draft-only다. 현재 `packages/agent/**`는 1차 root의 진행 중 untracked 코드라 안정 계약으로 간주하지 않는다.
- 다음: 구현 승인 후 T-1.1에서 사용자의 목표/절대 한도만 한 번 입력받는 `GrowthPolicy` 계약을 확정하고, 기존 프로젝트·계정·정책 값을 자동 재사용하는 read-only 수직 단계를 시작한다.

## 다음 세션 읽기 순서

1. [ai-growth-operations-plan-v2.md](ai-growth-operations-plan-v2.md)
2. [ai-growth-operations-tasks.md](ai-growth-operations-tasks.md)
3. 이 파일
4. 변경 이력이 필요할 때만 [bootstrap plan](ai-growth-operations-plan.md)
5. [1차 최신 v6](../app-operations-platform/app-operations-platform-plan-v6.md) → [기존 tasks](../app-operations-platform/app-operations-platform-tasks.md) → [기존 context](../app-operations-platform/app-operations-platform-context.md)
6. [자동화 정책](../../../docs/automation-policies.md) → [지표 정의](../../../docs/metric-definitions.md) → [소셜 운영](../../../docs/social-operations.md) → [연동 기능표](../../../docs/integration-capabilities.md)
7. `packages/domain/index.ts`, `packages/storage/index.ts`, `apps/controller/{automation,queue,service,campaign-budget,social-automation}.ts`, `packages/{metrics,credentials,connectors,social}/`

## 핵심 파일과 역할

- `dev/active/ai-growth-operations/ai-growth-operations-plan-v2.md` — 현재 유효한 명시적 요청·세션·mandate·성장 운영 계약. bootstrap plan과 충돌하면 v2를 따른다.
- `packages/domain/index.ts` — 현재 Project policy, Run/effect 상태, MetricFact, social/resource 공개 계약. 성장 도메인 확장 후보.
- `packages/storage/index.ts` — SQLite WAL/FULL, controller/run lease, document 저장, idempotency와 외부 effect 복구의 기준선.
- `apps/controller/automation.ts` — 30초 scheduler와 원천별 sync/reconcile stamp. 새 growth cycle의 재사용 지점.
- `apps/controller/queue.ts` — 실행 concurrency, retry/action_required, 취소와 결과 불명 처리.
- `apps/controller/service.ts` — 정책·vault·connector·metrics/resource persistence·외부 쓰기 직전 재검사의 통합 경계.
- `apps/controller/campaign-budget.ts` — 같은 통화의 기존/대기 캠페인 예산을 합산하고 pause는 허용하는 현재 안전장치.
- `packages/metrics/index.ts` — 정수 micros/BigInt와 통화별 contribution; 아직 ROAS/ROI·cohort가 없는 출발점.
- `packages/connectors/google-ads.ts` — APP_CAMPAIGN, 지출, 소재/예산/상태 작업. native experiment는 미구현.
- `packages/connectors/applovin-ads.ts` — Axon 캠페인/지출과 ROAS goal. acquisition A/B lifecycle은 미검증.
- `packages/connectors/applovin-max.ts` — MAX ad unit/추정 수익. 공식 experiment endpoint는 후속 구현 후보.
- `packages/social/**` — X/Threads/Steam API, 소유권, 토큰, 쓰기 결과 불명 계약.
- `apps/controller/social-automation.ts` — 프로젝트별 한도/예약/출시 공지/고정 규칙 답글과 중복 방지.
- `apps/desktop/src/views/{MarketingView,MonetizationView,CommunityView}.tsx` — 목표·실험·결정·응답·issue 운영 UI 확장 지점.
- `packages/agent/**` — 1차 root가 작성 중인 Codex/OpenCode CLI/MCP 초안. 현재 untracked·미통합 상태이므로 안정화 후 adapter로만 의존한다.

## 1차 구현 통합 체크포인트 — 2026-09-13

루트가 이후 [1차 v7](../app-operations-platform/app-operations-platform-plan-v7.md)의 요청 기반 버튼·채팅·native resume/clear와 CLI/MCP 도구를 통합했다. 관련 25/25·타입·빌드·Electron 검증 근거는 [결과](../../../docs/verification-assets/ai-requests-20260913.md)에 있다. 위 초안/미통합 서술과 plan-v2의 작성 당시 상태는 과거 관측이다. 2차 OperationMandate·실험·자동응대는 계속 미구현이며 24개 task는 모두 대기다.

## 중요한 의사결정

- AI 시작점을 사용자 동작으로 한정한다: 채팅 제출과 현재 화면의 `AI 요청` 버튼만 `AIRequest`를 만들며 등록·화면 진입·재시작·sync는 만들지 않는다. 버튼은 숨은 direct action이 아니라 화면/선택 snapshot이 보이는 채팅 요청이다. 기각한 대안: 프로젝트 등록이나 화면 lifecycle에서 자동 AI 호출.
- 실제 CLI session을 논리 채팅에 bind한다: 공급자가 반환한 Codex/OpenCode native ID를 저장하고 clear 전 exact resume, clear 뒤 다음 요청에서 새 session을 만든다. resume 실패는 action_required다. 기각한 대안: 내부 UUID를 native ID로 가장하거나 조용히 새 session으로 fallback.
- 주기 작업 권한은 `OperationMandate`다: 광고/수익/커뮤니티 작업은 구체적 범위·기간·상한을 요청한 mandate 안에서만 진행하고 재시작은 만료 전 기존 mandate만 resume한다. 기각한 대안: 페이지 방문·등록·앱 재시작을 opt-in으로 간주.
- reply 중복 identity와 감사 버전을 분리한다: 외부 interaction identity에는 policyVersion을 넣지 않고 정책/지식 버전은 audit로 저장한다. 모든 자동 승인 reply도 durable queue를 통과한다. 기각한 대안: 정책 변경 때 같은 interaction 재발송 또는 AI/UI direct writer.
- 반복 효능 판단은 fixed-horizon 단일 판정 또는 사전 등록된 유효 sequential rule만 허용한다: 일상 watermark 평가는 품질/안전 감시와 구분한다. 기각한 대안: 매 주기 같은 고정표본 p-value를 반복해 최초 유의 시 승자 선택.
- ROAS와 순이익 ROI를 별도 계약으로 유지한다: ROAS는 선택한 revenue basis/광고비, ROI는 net proceeds에서 광고비와 중복되지 않은 직접 변동비를 뺀 순이익/투입비다. 기각한 대안: 현재 contribution을 ROAS 또는 회사 순이익으로 이름만 변경.
- 공급자 native assignment가 검증된 실험만 A/B로 승자 확대한다: Google App campaign의 Campaign Mix는 allowlist 실계정 probe가 필요하고 Axon acquisition A/B는 미검증이다. 기각한 대안: 독립 캠페인 성과 차이를 무조건 A/B로 간주.
- 모든 숫자 한도는 versioned GrowthPolicy 값이다: 문서상의 관찰 주기·유의수준·step은 제안 기본값일 뿐 사용자 정책이 아니다. 기각한 대안: 코드 상수로 예산·가격·통계 결정을 고정.
- AI는 분류·근거 있는 draft를 만들고 기존 queue/policy가 외부 쓰기를 소유한다: 외부 텍스트는 비신뢰 데이터이며 vault/tool 권한을 받지 않는다. 기각한 대안: 소셜 모델에 게시 도구와 정책 변경 권한 직접 제공.
- 실험/응답/이슈 도메인 상태와 실행 `Run`을 분리한다: 각 외부 effect만 기존 prepared/dispatched/reconcile 계약을 사용한다. 기각한 대안: 장기 실험 lifecycle 전체를 하나의 장시간 queue run으로 유지.
- 초기 저장은 기존 `documents`+`writeBatch`를 재사용한다: 실제 cohort 규모·질의 요구가 입증되기 전 새 데이터베이스/서비스를 추가하지 않는다. 기각한 대안: 기획 단계에서 별도 warehouse를 필수화.

## 외부 근거와 미확인 조건

- 2026-09-13 확인: Google Ads Experiments overview/reporting은 control/treatment lifecycle과 통계 보고를 제공한다. App campaign에 Campaign Mix를 쓰는 계정 allowlist·정확한 operation은 실계정 미검증이다.
- 2026-09-13 확인: AppLovin MAX Ad Unit Management API는 `/ad_unit_experiment` 생성/조회/promote/deprecate를 문서화한다. 현재 앱 adapter와 실계정 권한은 없다.
- 2026-09-13 확인: X Automation Rules는 interaction당 1회, opt-in/out, 스팸/민감 필터와 AI reply bot의 사전 서면 승인을 요구한다. 프로젝트 계정 승인 여부는 미확인이다.
- AppLovin Axon acquisition experiment API는 현재 공식 페이지를 브라우저로 재확인하지 못했고, repository의 2026-09-11 공식 근거와 현재 connector만 확인했다. native A/B 지원으로 주장하지 않는다.
- Threads AI 자동 고객응대의 최신 정책/심사 조건은 이번 공식 검색에서 확인하지 못했다. 확인 전 자동 발송을 비활성으로 유지한다.
- 실계정, 실광고비, 실제 가격·상품, 실제 SNS 게시/답글은 모두 미검증이며 이번 기획 작업에서 실행하지 않았다.

## 빠른 재개 안내

- 재시작 시 바로 실행할 명령: `git status --short -- dev/active/ai-growth-operations && sed -n '1,280p' dev/active/ai-growth-operations/ai-growth-operations-plan-v2.md`
- 현재 blocker: 구현 승인이 없으므로 T-1.1 이후는 예정 상태다. 설계 자체의 blocker는 없다.
- 남아 있는 임시 우회책: 없음
