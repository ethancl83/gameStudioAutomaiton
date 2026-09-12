# AI 성장 운영 자동화 Plan

Created: 2026-09-13
Last Updated: 2026-09-13
Description: AI Growth Operations Automation

## 요약

프로젝트 등록→AI 분석→스토어 자료·이미지 생성→계정 연결·등록으로 이어지는 1차 흐름 다음에, 광고 실험과 수익성 개선, SNS 고객응대, 피드백 기반 제품 개선을 하나의 안전한 폐루프로 잇는다. 이 작업은 후속 구현을 여러 수직 단계로 나누기 위한 bootstrap 기획이며, 현재 Electron/React 화면, controller의 30초 scheduler와 내구성 큐, SQLite `Store`, `CredentialVault`, Google Ads·AppLovin Ads/MAX·AdMob 커넥터, metrics, X·Threads·Steam 어댑터를 재사용한다. 이 문서 세 파일의 작성만 승인됐고 제품 코드 구현, 실계정 광고 집행, 가격 변경, 메시지 발송, 게시, 커밋·push는 모두 미승인·예정 상태다.

## 범위와 운영 원칙

- 범위: 광고 A/B 실험, ROAS/순이익 ROI 측정·목표 운영, 광고비↔수익 폐루프, 수익화 실험, X·Threads 고객응대, 피드백 이슈 집계와 제품 개선 실험 연결.
- 비범위: 게임 코드 자동 수정·빌드, 자체 MMP 제작, 회계 결산 대체, 법률 판단, 광고 네트워크가 지원하지 않는 실험을 A/B로 가장하기, Steam 공지 자동 게시, DM 자동화, 승인되지 않은 실계정 쓰기.
- 사용자 입력 최소화: 최초에 목표 지표·귀속 창·예산/가격/고객경험 한도·허용 계정/채널·escalation 담당만 위임받고, 프로젝트·스토어·기존 캠페인·과거 지표·FAQ/정책에서 추론 가능한 값은 재사용한다. 로그인/MFA, 정책상 명시 승인, 충돌하는 목표, 유일하게 추론할 수 없는 법적·가격·브랜드 판단만 예외 질문으로 올리고 나머지 독립 작업은 계속한다.
- 외부 변경 분리: 관측→제안→정책 검증→내구성 있는 실행 intent→공급자 확인의 각 단계를 분리한다. AI 출력은 제안 데이터일 뿐 권한이 아니며, 모든 쓰기는 기존 `Run`/`effects` 저널과 저장된 정책을 통과해야 한다.
- 확정값과 제안 기본값 분리: 기존 코드의 30초 scheduler tick, 정상 연결 1시간 sync, 1분 회복 sync, 정책의 일일 예산/게시 한도는 현재 구현값이다. 새 실험의 판단 주기, 유의수준, 최소 효과, 관찰 기간, 증액 폭, 가격 변경 폭, 응답 빈도는 구현 전 사용자가 위임한 정책값으로 저장한다. 문서에 든 통계 관례와 주기는 모두 **제안 기본값**이며 사용자 정책으로 확정하지 않는다.

## 현재 상태 분석

### 구현돼 있고 재사용할 기반

| 근거 | 현재 역할 | 이 계획에서 재사용할 부분 |
|---|---|---|
| `apps/desktop/src/App.tsx`, `views/MarketingView.tsx`, `MonetizationView.tsx`, `CommunityView.tsx` | React 화면이 마케팅·수익화·커뮤니티를 capability 기반으로 분리한다. 현재 캠페인 CRUD, 통화별 기여액, 게시/예약/고정 규칙 답글을 노출한다. | 목표·실험·결정 근거·응답 검토·이슈 cluster를 기존 화면에 단계적으로 추가한다. |
| `apps/desktop/electron/main.ts`, `preload.ts` | Electron main이 bearer와 파일/외부 링크 권한을 소유하고 renderer는 최소 IPC만 쓴다. controller-only와 OS 자동 시작 기반이 있다. | 성장 운영 API도 renderer가 비밀이나 공급자 토큰을 받지 않는 같은 경계를 쓴다. |
| `apps/controller/automation.ts` | 30초 tick, 중복 stamp, 정상 1시간/회복 1분 sync, 읽기 복구를 제공한다. | 별도 무한 루프를 만들지 않고 “다음 실행 시각”이 된 성장 cycle을 enqueue한다. |
| `apps/controller/queue.ts`, `packages/storage/index.ts` | SQLite WAL/FULL, controller·run lease, connection 단위 직렬화, `prepared→dispatched→confirmed/action_required`, idempotency, 재시작 복구를 구현했다. | 실험 생성·예산/가격 변경·SNS 답글·회수는 모두 기존 외부 효과 계약을 사용한다. 도메인 상태와 실행 `Run`을 분리한다. |
| `apps/controller/validation.ts`, `campaign-budget.ts` | 프로젝트별 허용 연결, 광고/수익화 쓰기 토글, 같은 통화 일일 설정 예산, 기존·대기 캠페인 합산, 증액 전 재검사를 수행한다. | 총 예산·실험별/일별/증액별 envelope와 비상 중지를 추가하되 기존 한도를 하한 안전장치로 유지한다. |
| `packages/credentials/vault.ts` | 자격 증명을 AES-GCM 암호문으로 저장하고 OS/디렉터리 키 제공자와 원자 쓰기를 사용한다. | MMP/API/소셜 비밀은 vault에만 두고 AI prompt·이력·지표 fact에는 넣지 않는다. |
| `packages/connectors/google-ads.ts`, `applovin-ads.ts` | 앱 캠페인 PAUSED 생성/소재/예산/활성·중지와 Axon LIVE 생성/변경/중지, 최근 지출 sync를 제공한다. | 캠페인/지출 read model과 쓰기 adapter를 재사용한다. 실험 기능은 별도 capability probe 뒤에만 연다. |
| `packages/connectors/applovin-max.ts`, `admob.ts` | MAX 광고 단위와 추정 수익, AdMob 읽기와 수익을 제공한다. MAX는 `hasActiveExperiment`만 읽고 실험 작업은 미구현이다. | 수익화 실험은 MAX 공식 experiment endpoint부터 작게 연결하고, AdMob은 읽기 전용으로 둔다. |
| `packages/metrics/index.ts`, `MetricFact` | 정수 micros/BigInt, 통화 분리, 수익−광고비 contribution, MAX/AdMob 중복 제외가 있다. | 원천 fact를 유지하면서 campaign/arm/cohort/귀속 창/신선도/정정/FX 차원을 추가한다. |
| `packages/social/**`, `apps/controller/social-automation.ts` | X·Threads 게시/답글·조회, Steam 읽기, 프로젝트/소유권, 일일 한도, idempotency, 결과 불명 비재게시, 고정 문자열 규칙 답글을 구현했다. | 수집·소유권·쓰기/복구 경계를 재사용하고 AI는 지식 기반 분류/초안만 담당한다. |

### 아직 구현되지 않은 목표 기능

- 광고 실험 도메인(가설, primary metric, control/treatment assignment, 관찰 창, 통계 결정, 승자 확대·실패 중지)과 공급자별 experiment adapter가 없다.
- 현재 `MetricFact`는 일자·통화·앱·원천 수준의 revenue/spend만 있어 campaign/arm/설치 cohort 귀속, FX snapshot, 데이터 watermark, 환불·수수료 정정 계보가 없다. 현재 contribution은 ROAS나 회사 순이익 ROI가 아니다.
- 가격/상품·MAX 설정을 고객경험 지표와 함께 실험하고 자동 rollback하는 정책이 없다.
- 커뮤니티 자동화는 고정 문자열 포함 규칙뿐이며 versioned knowledge, AI 근거, prompt injection 차단, 민감도/escalation, opt-out, 중복 표현 방지, 회수·요약, 이슈 cluster가 없다.
- 피드백→중복 이슈→우선순위→제품 개선 실험의 추적 링크가 없다.
- `packages/agent/**`는 현재 checkout에서 1차 root가 진행 중인 untracked 구현이다. Codex/OpenCode CLI와 MCP 도구 초안은 보이지만 controller/UI 통합·검증 완료로 간주하지 않으며, 이 계획은 공개된 안정 계약이 생긴 뒤 adapter로 소비한다.

## 목표 상태

사용자는 프로젝트별 “성장 운영 목표”에서 목표 지표와 절대 한도를 한 번 정한다. 시스템은 데이터를 수집·품질 검사하고, 하나의 검증 가능한 가설과 대조군을 가진 실험을 탐색→평가→승자 확대 순으로 운영한다. 데이터가 낡거나 표본이 부족하면 증액하지 않고, 실패/고객경험/정책 guardrail을 넘으면 중지한다. 각 결정은 사용한 fact, 정책 버전, 알고리즘 버전, 공급자 기능, 시각과 근거를 재현할 수 있다.

커뮤니티는 새 상호작용을 읽고 외부 텍스트를 명령이 아닌 데이터로 격리한 뒤, 승인된 지식 문서에 근거한 답변만 만든다. 일반 문의만 위임 범위 안에서 한 번 답하고, 민감·환불·법적·분쟁·보안·개인정보·정책 불확실 항목은 사람에게 올린다. 피드백은 개인 식별 정보를 최소화해 중복 이슈로 묶고, 빈도·영향·신뢰도·전략 적합도로 우선순위를 설명하며 제품 개선 실험과 성장 지표에 연결한다.

## 지표·귀속 계약

### 서로 다른 두 지표

- `ROAS(w, basis) = attributedRevenue(w, basis) / adSpend(w)`. `w`는 설치/유입 cohort에 고정한 귀속 창이고 `basis`는 `gross_conversion_value`, `net_proceeds`, `estimated_ad_revenue`처럼 명시한다. 분모가 0, 캠페인/arm 귀속이 없거나 서로 다른 창·통화·cohort이면 산출하지 않고 `not_computable`로 둔다.
- `순이익 ROI(w) = (attributedNetProceeds(w) - adSpend(w) - attributableVariableCosts(w)) / (adSpend(w) + attributableVariableCosts(w))`. `attributedNetProceeds`는 확보 가능한 범위에서 환불·store/payment/platform fee·세금 조정을 반영한 개발자 몫이고, 이미 차감된 비용을 `attributableVariableCosts`에 다시 넣지 않는다. 고정 인건비·회사 공통비는 사용자가 versioned 원가 배부 정책을 주지 않으면 제외하며, 따라서 회계상 회사 전체 ROI로 표시하지 않는다.
- ROAS 목표와 순이익 ROI 목표는 동시에 저장할 수 있지만 같은 것으로 대체하지 않는다. Google/AppLovin이 보고하는 provider ROAS와 내부 net-proceeds ROI를 별도 칼럼으로 표시하고 numerator basis를 항상 보인다.

### 귀속·코호트·정정

- 최소 grain: `projectId/provider/account/campaign/experiment/arm/acquisitionDate/cohortKey/attributionWindow/currency/revenueBasis/sourceId`와 `eventDate`, `observedAt`, `collectedAt`, `sourceWatermark`, `finality(estimated|proceeds|settled)`를 보존한다.
- acquisition cohort와 event date를 구분한다. 같은 arm에 노출/설치된 사용자 집단의 창 안 수익만 분자에, 같은 집단을 얻은 광고비만 분모에 둔다. 플랫폼/MMP가 campaign·arm 귀속을 제공하지 않으면 앱 전체 contribution만 보여 주고 실험 ROAS는 만들지 않는다.
- 환불·chargeback·수수료·세금·보고서 삭제/정정은 이전 fact를 조용히 덮어쓰지 않고 source revision과 대체 관계를 남겨 해당 cohort의 snapshot을 재계산한다. 확정 후 반전된 winner는 자동 재증액하지 않고 `decision_invalidated`로 올린다.
- 원통화 fact는 항상 보존한다. 같은 통화는 정수 micros로 합산하고, 다른 통화는 사용자가 허용한 보고 통화와 versioned FX source/date/rate가 있을 때만 변환한다. FX 부재·오래됨·환전 시점 불일치는 통화별로 분리하고 목표 판정을 막는다.
- freshness gate는 원천별 기대 지연, 마지막 성공 watermark, 귀속 창 종료, 환불 정정 대기, 수집 실패를 본다. 신선도 한계를 넘은 데이터로 증액·승자 확정·가격 확대를 하지 않는다. 신선도 한계 자체는 제안값으로 시작해 원천별 실제 실계정 관측 후 확정한다.

## 실험·폐루프 계약

1. `hypothesis`: 대상 cohort, 한 가지 주 변경, primary metric, guardrail, 최소 실질 효과, 귀속 창, 최대 관찰 기간을 고정한다. 탐색 중 primary metric을 바꾸면 새 실험이다.
2. `control`: 무변경 대조군과 treatment assignment를 공급자가 보장하고 재현 가능한 경우에만 A/B라고 부른다. 무작위/상호 배타 분할을 증명할 수 없는 병렬·순차 캠페인은 `observational_comparison`으로 표시하고 winner 자동 확대에 쓰지 않는다.
3. `exploring`: 한 번에 하나의 주요 변수만 바꾸는 것이 제안 기본값이다. 여러 소재/가격/타깃을 동시에 시험하면 사전 등록한 factorial/다중 arm 설계와 더 큰 표본 요건을 적용한다.
4. `observing`: 최소 관찰 기간, 전체 귀속 창, 요일/학습 효과, 표본·conversion 수를 기다린다. Google의 “최소 4주” 권고는 Google 실험용 제안 기본값일 뿐 전역 정책이 아니며, 실제 정책은 앱 주기·귀속 창·예산과 함께 저장한다.
5. `evaluating`: 사전 등록 primary metric 하나로 판단한다. 표본 부족이면 최대 관찰 기간 안에서 유지하고, 넘으면 `inconclusive`로 종료한다. 다중 arm/다중 지표는 저장한 Holm family-wise 보정 또는 FDR 방식을 적용한다. 보정 방식·유의수준·최소 효과는 versioned 정책이며 임의의 사후 선택을 금지한다.
6. `winner_scaling`: 신선한 데이터, 신뢰구간/최소 효과, 모든 guardrail, 공급자 상태 확인을 통과할 때만 사용자가 정한 한 단계 증액 폭과 누적/일일/실험 예산 한도 안에서 확대한다. 매 단계 뒤 재관찰하며 한 번에 전액 이동하지 않는다.
7. `failure_stop`: 손실 예산, ROAS/ROI 하방, crash/retention/refund/부정 피드백/정책 위반/결제 오류 guardrail 중 하나가 정책 한계를 넘거나 데이터·권한이 불명확하면 신규 지출을 중지한다. 기존 캠페인 pause는 예산 초과 상태에서도 허용한다.
8. 수익 폐루프는 `spend → attributed installs/cohort → gross/estimated revenue → refunds/fees → net proceeds → ROAS/ROI decision → bounded write → provider confirmation → next observation`이다. 어느 연결도 끊기면 화면에 사유를 보이고 자동 확대하지 않는다.

## 공급자 지원 경계와 공식 근거

확인일은 모두 2026-09-13이다. 문서 존재와 API 계약 확인은 실계정 권한·allowlist·실제 집행 성공을 보장하지 않는다.

| 공급자 | 공식 근거 | 계획상 경계 |
|---|---|---|
| Google Ads | [Experiments overview](https://developers.google.com/google-ads/api/docs/experiments/overview), [Reporting](https://developers.google.com/google-ads/api/docs/experiments/reporting), [Campaign Mix](https://developers.google.com/google-ads/api/docs/experiments/campaign-mix) | API는 control/treatment와 schedule/end/promote, experiment reporting을 제공한다. 현재 앱이 만드는 `APP_CAMPAIGN`은 일반 system-managed 유형 목록에 직접 포함되지 않는다. App 캠페인을 포함할 수 있는 Campaign Mix는 공식 문서상 allowlisted 기능이므로 계정 capability와 정확한 arm split/report를 실계정에서 확인하기 전에는 자동 A/B·promote를 열지 않는다. |
| AppLovin Ads (Axon) | [Axon Campaign Management API](https://support.applovin.com/en/growth/promoting-your-apps/api/axon-campaign-management-api) | 현재 create/update/pause와 ROAS goal 필드를 쓰지만, 조회한 공식 계약에서 acquisition campaign의 무작위 A/B lifecycle은 확인하지 못했다. 별도 캠페인을 만들어도 `observational_comparison`이며 자동 winner 확대는 금지한다. URL은 현재 브라우저 조회가 실패했으므로 기존 코드·문서 근거에 의존한 **재검증 필요** 항목이다. |
| AppLovin MAX | [Ad Unit Management API](https://support.applovin.com/en/max/advanced-features/ad-unit-management-api) | 공식 `/ad_unit_experiment/{ad-unit-ID}`는 생성·조회·promote/deprecate를 지원한다. 이는 사용자 획득 광고 캠페인 A/B가 아니라 미디에이션/waterfall·frequency cap 등 수익화 실험이다. 현재 connector는 실험 존재만 읽으므로 쓰기는 후속 구현·실계정 gate다. |
| AdMob | [AdMob API reference](https://developers.google.com/admob/api/reference/rest) | 현재 계정/앱/광고 단위/수익 읽기만 재사용한다. 공개 API에서 현재 connector가 지원하지 않는 광고 단위/실험 쓰기를 추정하지 않는다. |
| X | [Automation rules](https://help.x.com/en/rules-and-policies/x-automation) | 자동 답글은 사용자 상호작용별 한 번, opt-in/opt-out, 민감 콘텐츠 필터, 중복/스팸 금지가 필요하다. 공식 규칙상 AI reply bot은 X의 사전 명시 승인이 필요하므로 승인 증거가 저장되지 않으면 AI 자동 답글은 draft/escalation까지만 하고 외부 발송하지 않는다. |
| Threads | [Threads API](https://developers.facebook.com/docs/threads) | 게시/답글 API는 현재 구현됐지만 AI 고객응대·스팸/자동화 허용 범위의 최신 1차 정책을 이번 조사에서 확인하지 못했다. 공급자 정책 증거와 필요한 앱 심사를 실계정 gate에서 확인하기 전에는 AI 답글을 자동 발송하지 않는다. |

## 제품·수익화 고객경험 guardrail

- 가격/상품 변경은 기존 `allowMonetizationWrites`만으로 충분하지 않다. 별도 `allowPricingExperiments`, 상품/국가/가격 floor·ceiling, 최대 단계 변화, cooldown, 동시 실험 수, 원복 가격과 세금/스토어 승인 조건을 최초 위임에 저장한다.
- 구독 entitlement, 기존 구매자 약속, 지역 가격 tier, 무료 체험, 광고 빈도·보상 가치는 가격 실험 전 계약 검사 대상이다. 신규/기존 cohort를 분리할 수 없거나 공급자가 원자적 대조군을 지원하지 않으면 자동 변경하지 않는다.
- primary 수익 지표가 좋아도 retention, crash-free, 결제 실패/복원 실패, 환불·chargeback, 광고 노출 빈도, 리뷰/부정 피드백, 고객지원 escalation이 악화되면 확대를 막고 필요 시 원복한다.
- 원복도 외부 쓰기다. 원래 값과 공급자 revision을 snapshot하고 idempotent run으로 실행·재확인한다. 되돌릴 수 없는 상품 상태·기존 구매자 영향·법적 고지는 사람 승인 gate로 둔다.

## SNS 고객응대·피드백 계약

- 지식 근거: 프로젝트 분석 결과, 승인된 스토어 설명, 공개 FAQ, 지원 정책, changelog, 알려진 문제를 `KnowledgeRevision`으로 보관한다. 답변은 사용한 revision ID와 문장별 근거를 기록하며 근거가 없으면 추측하지 않고 질문/escalation한다.
- prompt injection: 게시물·닉네임·링크·첨부 텍스트는 모두 비신뢰 데이터다. “정책 변경/도구 실행/비밀 공개” 지시를 무시하고, LLM에는 읽기 전용 지식 검색과 구조화된 `classification/draft/citations/risk` 출력만 준다. 외부 쓰기 도구, shell, vault, 원문 파일 경로는 응답 생성 모델에 노출하지 않는다.
- 중복/스팸: `provider+account+interactionId+policyVersion`으로 한 번만 응답하고, 이미 `dispatched/confirmed/unresolved`이면 재발송하지 않는다. 사용자별 opt-out, 계정별/프로젝트별 한도, 유사 문구 반복률, 원문 존재·소유권·상호작용 의도를 발송 직전에 다시 확인한다.
- escalation: 개인정보/계정·결제 정보, 환불/chargeback, 법적 요청·규제·저작권, 위협·괴롭힘·자해/아동 안전, 보안 취약점, 언론·분쟁, 보상 약속, 정책 근거 부족은 공개 자동 응답하지 않는다. 안전한 접수 문구조차 승인 정책에 있을 때만 보내고 원문 링크·risk·추천 담당/기한을 남긴다.
- 회수: 잘못된 답변 발견 시 정책을 즉시 pause하고 이후 큐를 막는다. 소유권이 확인된 본인 게시물의 삭제가 공급자와 정책에서 허용될 때만 별도 회수 run을 만들며, 결과 불명은 재삭제/재게시하지 않는다. 원문 삭제, 정정 공지, 사람 후속 응대를 하나의 incident로 묶는다.
- 요약: 공개 본문 전체를 장기 복제하지 않고 필요한 발췌/해시/원격 ID를 보존한다. 일/주간 요약은 개인 식별 정보를 최소화하고, 문의 유형·미해결·감정 신호·근거 부족·issue cluster 변화만 제시한다.
- 이슈 연결: `FeedbackItem`을 정규화한 뒤 동일 앱 버전/플랫폼/증상/오류코드와 AI 유사도 제안을 이용해 `IssueCluster`에 묶는다. 자동 병합은 설명 가능한 동일 키가 있을 때만 하고 애매하면 후보로 둔다. 우선순위는 빈도, 영향 사용자/매출, 심각도, 재현 신뢰도, 추세, 전략 적합도를 각각 보이며 하나의 불투명 점수로 숨기지 않는다. 승인된 cluster는 제품 변경 가설·release/version·후속 실험 ID와 연결해 “수정→출시→피드백/retention/ROI 변화”를 관찰한다.

## 주기·상태·권한·데이터 계약

- 주기: 기존 scheduler tick에서 due item만 claim한다. 수집은 원천별 기존 sync를 재사용하고, 실험 평가는 새 데이터 watermark가 전진했을 때만 수행한다. 제안 기본값은 “수집은 원천 허용 주기, 평가는 하루 한 번, 승자 확대는 완전한 귀속 창/주간 cycle 이후”이며 실계정 지연 관측 전에는 고정값이 아니다.
- 실험 상태: `draft → validating → scheduled → exploring → observing → evaluating → winner_scaling → completed`; terminal/예외는 `inconclusive | stopped | action_required | failed`. 상태 전이는 optimistic version과 decision snapshot으로 원자 저장하며 scheduler는 동일 상태/버전에서 하나의 run만 만든다.
- 고객응대 상태: `ingested → classified → draft_ready | blocked | escalated → queued → dispatched → confirmed | unresolved → closed | retracted`. 자동 발송이 허용된 일반 문의만 `draft_ready→queued`를 건너뛸 수 있고, 위험/근거 부족/opt-out은 발송 경로가 없다.
- 복구: 외부 effect가 `prepared`면 안전하게 재개하고 `dispatched/action_required`면 공급자 읽기 reconcile 또는 사람 확인 전 재전송하지 않는다. 정책/연결/지식 revision 변경은 아직 전송되지 않은 intent를 무효화해 재평가한다.
- 권한: 프로젝트별 allowlisted connection, campaign/monetization/social 세부 capability, 절대 예산/가격/빈도 한도, X/Threads 정책 승인 증거, escalation role을 분리한다. 보관함 secret은 모델 context·DB JSON·이력에 넣지 않는다.
- 최소 데이터 계약: `GrowthPolicy`, `Experiment`, `ExperimentArm`, `DecisionSnapshot`, `AttributionFact`, `FxSnapshot`, `KnowledgeRevision`, `ResponseIntent`, `FeedbackItem`, `IssueCluster`, `ProductExperimentLink`. 각 record는 `projectId`, `version`, `source`, `createdAt/updatedAt`, `policyVersion`과 필요한 source IDs를 갖는다. 초기에는 기존 `documents` 저장과 `writeBatch` 원자성을 재사용하고, cohort fact 규모·질의가 실제로 요구할 때만 index table migration을 추가한다.

## Phase 실행 지도

### Phase 1 — 읽기 전용 성장 기준선

- 목표: 외부 쓰기 없이 목표, 데이터 계약, 신선도, ROAS/순이익 ROI 계산 가능 여부를 한 화면에서 확인한다.
- 작업: `GrowthPolicy`의 초기 위임 입력, attribution/FX/revision schema, 현재 metrics adapter와 품질 진단, read-only 목표 대시보드를 구현한다.
- Acceptance Criteria:
  - 같은 통화·cohort·귀속 창·basis가 맞는 fact만 ROAS/ROI를 계산하고 환불·수수료·FX·미수집/낡은 데이터를 구분한다.
  - 현재 contribution을 ROAS/회사 순이익으로 오표시하지 않으며 모든 미계산 사유를 설명한다.
  - 사용자에게 이미 저장된 프로젝트/앱/계정을 다시 묻지 않고, 자동 쓰기는 여전히 0건이다.
- 검증 게이트: 임시 SQLite와 모의 fact로 다중 통화, 0 spend, 정정·환불, 중복 source, stale watermark, 미귀속 cohort 회귀 검사; typecheck/build; 화면 검증.

### Phase 2 — 한 공급자의 실험 관측 수직 단계

- 목표: provider capability가 증명된 하나의 Google Ads 실험을 생성하지 않고 목록·arm·지표만 읽어 A/B 계약을 검증한다.
- 작업: experiment capability probe/read adapter, control/treatment mapping, hypothesis 사전 등록, observational fallback 라벨을 연결한다.
- Acceptance Criteria:
  - App campaign에 지원되지 않는 workflow를 선택하지 않고 Campaign Mix allowlist 부재를 `unsupported/action_required`로 표시한다.
  - assignment 증명이 없는 캠페인 비교를 A/B 또는 winner로 표시하지 않는다.
  - 표본 부족·귀속 미완료·다중검정·신선도 상태가 decision snapshot에 남는다.
- 검증 게이트: 공식 payload fixture와 모의 HTTP에서 support/unsupported/allowlist/arm 누락/지표 정정 검사; 실계정 **읽기 전용** capability 검증은 별도 승인 gate.

### Phase 3 — 광고 실험 실행과 제한된 승자 확대

- 목표: 검증된 native experiment에서만 탐색→관찰→평가→중지/확대를 내구성 있게 실행한다.
- 작업: experiment mutate/schedule/end/promote adapter, policy checker, scheduler, deterministic idempotency, decision audit와 emergency stop을 연결한다.
- Acceptance Criteria:
  - 예산·일일/누적 손실·step/cooldown 한도와 stale/sample/guardrail을 쓰기 직전 다시 검사한다.
  - 재시작·응답 유실·수동 콘솔 변경에서 중복 schedule/promote/budget write가 없다.
  - 표본 부족은 inconclusive 또는 관찰 연장이고 자동 승자 선정이 아니다.
- 검증 게이트: 모의 외부 효과 crash/reconcile, 정책 변경 race, multiple-comparison 결정 검사; Google Ads test account 구조 검증 후 실제 비용 없는 gate; 실비 집행은 별도 명시 승인.

### Phase 4 — 수익 폐루프와 수익화 실험

- 목표: 광고비와 net proceeds를 같은 cohort로 닫고, MAX 수익화 실험 및 가격 제안을 고객경험 guardrail 아래 운영한다.
- 작업: attribution reconciliation, MAX experiment read→create→promote/deprecate, 가격/상품 제안과 rollback snapshot을 단계적으로 연결한다.
- Acceptance Criteria:
  - 광고비→cohort 수익→환불/수수료→ROAS/ROI→결정 lineage가 끊기면 확대하지 않는다.
  - MAX 실험과 acquisition 광고 실험을 구분하고 활성 실험 충돌을 막는다.
  - 가격 변경은 별도 위임 envelope와 retention/crash/refund/결제/피드백 guardrail 없이는 실행되지 않는다.
- 검증 게이트: 모의 MAX/스토어 API, revision/rollback/idempotency 검사; sandbox/test 상품 검증; 실광고·실가격 변경은 공급자/사용자 승인 gate.

### Phase 5 — 지식 기반 고객응대 read-only 단계

- 목표: 외부 발송 없이 새 상호작용을 분류하고 근거가 있는 답변 초안·escalation·요약을 만든다.
- 작업: knowledge revision 수집/승인, untrusted input 격리, structured AI output validator, risk/opt-out/spam classifier, feedback ingestion을 구현한다.
- Acceptance Criteria:
  - 모든 답변 문장에 승인된 knowledge revision 근거가 있거나 `근거 부족`으로 차단된다.
  - prompt injection, secret 요청, 민감·환불·법적·분쟁 입력이 tool/정책을 바꾸거나 외부 쓰기를 만들지 못한다.
  - 같은 interaction 재수집은 하나의 ResponseIntent/FeedbackItem만 만든다.
- 검증 게이트: 악성 prompt corpus, 개인정보 최소화, 중복 interaction, 지식 폐기/갱신, model 오류/timeout 검사; 실제 계정 읽기만 별도 gate.

### Phase 6 — 제한된 SNS 자동응대와 회수

- 목표: 플랫폼 승인과 저장된 정책이 모두 있는 일반 문의만 한 번 발송하고 사고를 멈추고 회수할 수 있게 한다.
- 작업: reply authorization evidence, pre-send recheck, X/Threads writer adapter, pause/recall/incident/digest UI를 연결한다.
- Acceptance Criteria:
  - X AI bot 서면 승인 또는 Threads 정책 증거가 없으면 draft만 만들고 발송하지 않는다.
  - opt-in/opt-out, interaction당 1회, 원문 존재, 소유 프로젝트, 중복/유사 스팸, 일일 한도를 전송 직전 검사한다.
  - 발송 결과 불명은 재발송하지 않고, 회수도 별도 idempotent effect와 evidence로 남는다.
- 검증 게이트: 모의 게시/타임아웃/재시작/정책 변경/원문 삭제/opt-out 회귀 검사; 플랫폼 개발/테스트 계정과 사전 승인 증거 확인 후 소량 실계정 검증 gate.

### Phase 7 — 피드백에서 제품 개선 실험까지

- 목표: 피드백 중복 이슈와 우선순위를 설명 가능하게 만들고 제품 수정·출시·성과 관찰을 연결한다.
- 작업: IssueCluster 후보/병합, 우선순위 차원, 수동 승인, release/product experiment link, 사후 지표 비교를 구현한다.
- Acceptance Criteria:
  - 자동 병합 근거와 원문 source IDs를 추적하고 애매한 cluster는 합치지 않는다.
  - 심각도와 빈도, 매출 영향, 재현도, 추세를 각각 보여 주며 민감정보를 요약에 노출하지 않는다.
  - 제품 변경은 별도 개발 승인 없이 코드 작업으로 변환되지 않고, 승인된 변경만 release와 실험에 연결된다.
- 검증 게이트: 다국어/유사·반대 피드백 fixture, cluster split/merge audit, release 전후 cohort 혼합 방지 검사; 사용자 승인된 제품 실험만 실서비스 gate.

### Phase 8 — 운영 통합과 실계정 단계적 수용

- 목표: 전체 cycle의 권한·복구·관찰 가능성·실계정 지원 범위를 검증하고 부분 기능을 허위 완료로 표시하지 않는다.
- 작업: API/UI, 알림/escalation, backup fencing, 권한 철회, provider drift, 실계정 gate checklist와 운영 문서를 완성한다.
- Acceptance Criteria:
  - cycle/experiment/response/issue 상태, 마지막/다음 실행, watermark, blocker, 결정 근거, pause/stop가 UI에 보인다.
  - 백업 복원 후 자동화는 중지되고 재연결·정책 재확인 전 외부 effect가 없다.
  - 공급자별 read/test/write/spend/price/post 검증 수준과 날짜가 구분되고 미검증 기능은 비활성이다.
- 검증 게이트: 전체 자동 검사·typecheck·build·Electron 화면·재시작/백업 복구·독립 리뷰; 실제 계정은 읽기→test/sandbox write→최소 한도 write→장기 관찰 순서의 명시 gate.

## 리스크와 완화 전략

| 리스크 | 영향 | 완화 |
|---|---|---|
| 귀속·보고 지연과 환불 정정으로 거짓 winner 선택 | 광고비 손실, 잘못된 가격 결정 | cohort/window/finality/watermark gate, revision 재계산, invalidated decision, 단계적 확대 |
| 플랫폼 native A/B 부재 또는 allowlist | 인과 추론 불가 | capability probe, unsupported/observational 라벨, 자동 확대 금지 |
| 실험 중 자동입찰 학습·계절성·교차 오염 | 편향된 효과 | 사전 등록, 대조군, 관찰 기간, 동시 실험 충돌 검사, 단계별 snapshot |
| 여러 arm/지표의 사후 선택 | false positive | primary metric 고정, Holm/FDR 정책, 최소 효과·신뢰구간, inconclusive 허용 |
| 예산/가격/광고 빈도 자동화의 고객 피해 | 환불·이탈·정책 위반 | 절대 envelope, CX guardrail, emergency stop, 원복 snapshot, irreversible gate |
| AI 응답 hallucination·prompt injection | 잘못된 약속·비밀 유출·브랜드 피해 | versioned knowledge citations, structured output, 도구 격리, 민감도 차단, platform approval |
| 중복 답글·스팸·결과 불명 | 계정 제재·고객 불만 | interaction idempotency, opt-out, pre-send recheck, unresolved 비재발송, 빈도/유사도 gate |
| feedback 자동 병합 오류 | 잘못된 우선순위 | 설명 가능한 키, candidate review, split/merge audit, source link 보존 |
| 1차 AI 작업 계약 변동 | 통합 중 충돌 | 안정화된 MCP/AgentTask 공개 계약만 adapter로 소비하고 `packages/agent/**` 직접 결합을 후속으로 미룬다. |
