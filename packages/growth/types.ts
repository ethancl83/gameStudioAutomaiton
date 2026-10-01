// 성장 운영(광고 실험·수익 폐루프·고객응대·피드백) 공개 계약.
// 금액은 정수 마이크로 단위 문자열이다. 모든 record는 기존 documents 저장과
// writeBatch 원자성을 사용하며 비밀값을 담지 않는다.
import type { Provider } from '../domain/index.js';

/** 사용자가 채팅/화면 요청으로 위임할 수 있는 동작. 범위 밖 동작은 새 요청이 필요하다. */
export type MandateAction =
  | 'observe'            // 지표 수집·품질 진단·결정 기록(외부 쓰기 없음)
  | 'ads-experiment'     // 공급자 native 실험 생성·일정·종료
  | 'ads-scale'          // 승자 단계 증액·promote
  | 'ads-stop'           // 실패 중지(pause)
  | 'ads-rebalance'      // 같은 통화 캠페인 사이 예산 재배분(총액 유지)
  | 'max-experiment'     // MAX 광고 단위 실험 생성·promote·deprecate
  | 'pricing-proposal'   // 가격·상품 변경 제안(외부 쓰기 없음)
  | 'pricing-change'     // 위임 envelope 안의 가격 변경·원복
  | 'community-draft'    // 분류·초안·escalation(외부 쓰기 없음)
  | 'community-reply'    // 승인 증거가 있는 일반 문의 자동 답글
  | 'community-recall'   // 본인 답글 회수
  | 'feedback-triage';   // 피드백 정규화·이슈 후보

export const MANDATE_ACTIONS: MandateAction[] = ['observe', 'ads-experiment', 'ads-scale', 'ads-stop', 'ads-rebalance', 'max-experiment', 'pricing-proposal', 'pricing-change', 'community-draft', 'community-reply', 'community-recall', 'feedback-triage'];
/** 외부 상태를 바꾸는 위임 동작. */
export const WRITE_ACTIONS: MandateAction[] = ['ads-experiment', 'ads-scale', 'ads-stop', 'ads-rebalance', 'max-experiment', 'pricing-change', 'community-reply', 'community-recall'];

export type RevenueBasis = 'gross_conversion_value' | 'net_proceeds' | 'estimated_ad_revenue';

export interface GrowthGoals {
  /** 목표 ROAS(비율, 1.5 = 150%)와 그 분자 기준·귀속 창. */
  roas?: { target: number; basis: RevenueBasis; windowDays: number };
  /** 목표 순이익 ROI(비율, 0.2 = 20%). 고정비는 포함하지 않는다. */
  netRoi?: { target: number; windowDays: number };
}

export interface MandateLimits {
  currency: string;
  /** 위임 전체 기간의 일일 신규 광고 지출 상한. */
  maxDailySpendMicros: string;
  /** 위임 기간 누적 광고 지출 상한. */
  maxTotalSpendMicros: string;
  /** 누적 손실 상한(지출 − 귀속 순수익). 넘으면 신규 지출 중지. */
  maxLossMicros: string;
  /** 한 번의 증액 폭 상한(비율, 0.2 = 20%). */
  maxBudgetStep: number;
  /** 같은 대상의 연속 증액 사이 최소 시간. */
  cooldownHours: number;
  /** 하루 자동 답글 상한(프로젝트 소셜 정책 한도와 별개로 더 작은 값 적용). */
  maxDailyReplies: number;
  /** 캠페인 성과 규칙: 이 ROAS 미만이면 중지(ads-stop). 판단에 필요한 최소 광고비와 함께 설정한다. */
  campaignStopRoasBelow?: number;
  /** 캠페인 성과로 중지·재배분을 판단하기 위한 기간 최소 광고비. */
  minDecisionSpendMicros?: string;
  /** 가격 변경 envelope. 없으면 가격 변경을 실행하지 않는다. */
  pricing?: PricingEnvelope;
}

export interface PricingEnvelope {
  productIds: string[];
  regions: string[];
  /** 상품별 가격 floor/ceiling(마이크로, 통화 포함). */
  bounds: Array<{ productId: string; currency: string; floorMicros: string; ceilingMicros: string }>;
  /** 한 번의 가격 변화 폭 상한(비율). */
  maxStep: number;
  cooldownHours: number;
  maxConcurrentExperiments: number;
}

export type MandateStatus = 'proposed' | 'active' | 'stopped' | 'expired';

/** 사용자가 요청한 구체적 운영 범위와 기간. 스케줄러는 active이고 기간 안인 위임만 실행한다. */
export interface OperationMandate {
  id: string; projectId: string; version: number; status: MandateStatus;
  origin: { source: 'chat' | 'screen-button' | 'form'; agentTaskId?: string; requestText: string; requestedAt: string };
  connectionIds: string[];
  actions: MandateAction[];
  goals: GrowthGoals;
  limits: MandateLimits;
  startsAt: string; endsAt: string;
  /** 성장 주기 간격(분). */
  cadenceMinutes: number;
  /** 빠진 필수값을 기존 승인값으로 채운 근거. */
  reuseEvidence: string[];
  policyVersion: number;
  confirmedAt?: string; stoppedAt?: string; stopReason?: string;
  lastCycleAt?: string; nextDueAt?: string;
  createdAt: string; updatedAt: string;
}

export type StoppingRule =
  | { kind: 'fixed_horizon' }
  /** 사전 등록한 look 시각과 Lan-DeMets alpha-spending 경계. */
  | { kind: 'sequential'; looks: string[]; spending: 'obrien_fleming' | 'pocock' };

/** 프로젝트별 통계·안전 정책. 모든 값은 사용자가 확정한 정책값이며 버전으로 감사한다. */
export interface GrowthPolicy {
  projectId: string; version: number;
  alpha: number;
  multiplicity: 'holm' | 'bh';
  defaultStopping: StoppingRule['kind'];
  /** 원천별 허용 지연(시간). 넘으면 stale로 판단해 확대를 막는다. */
  freshnessHours: Partial<Record<Provider, number>>;
  reportingCurrency?: string;
  /** 허용한 FX 출처. 없으면 다른 통화는 합산하지 않는다. */
  fxSource?: string;
  fxMaxAgeHours: number;
  /** 가변비용(결제 수수료 외 추가 비용) 비율. 원천이 이미 차감한 수수료는 넣지 않는다. */
  variableCostRate: number;
  allowPricingExperiments: boolean;
  updatedAt: string;
}

export type MetricKey = 'roas' | 'net_roi' | 'conversion_rate' | 'cost_per_install' | 'arpdau' | 'retention_d1' | 'crash_free_rate' | 'refund_rate';

export interface Guardrail {
  metric: MetricKey;
  /** 'min'은 이 값 아래로, 'max'는 이 값 위로 가면 위반이다. */
  direction: 'min' | 'max';
  threshold: number;
}

export type ExperimentKind = 'ads' | 'monetization' | 'pricing' | 'product';
export type ExperimentDesign = 'native_ab' | 'observational_comparison';
export type ExperimentStatus = 'draft' | 'validating' | 'scheduled' | 'exploring' | 'observing' | 'evaluating' | 'winner_scaling' | 'completed' | 'inconclusive' | 'stopped' | 'action_required' | 'failed';

export interface ExperimentArm {
  id: string; role: 'control' | 'treatment'; label: string;
  /** 공급자 식별자(Google Ads experiment arm, 캠페인, MAX 실험 그룹 등). */
  externalId?: string; campaignId?: string;
  trafficShare?: number;
}

export interface ExperimentHypothesis {
  change: string; cohort: string;
  primaryMetric: MetricKey;
  revenueBasis?: RevenueBasis;
  guardrails: Guardrail[];
  /** 최소 실질 효과(상대, 0.1 = 10%). */
  minimumEffect: number;
  attributionWindowDays: number;
  minDurationDays: number; maxDurationDays: number;
  minSamplePerArm: number;
}

export interface Experiment {
  id: string; projectId: string; mandateId: string; version: number;
  kind: ExperimentKind; provider: Provider; connectionId: string;
  providerExperimentId?: string;
  design: ExperimentDesign;
  hypothesis: ExperimentHypothesis;
  stopping: StoppingRule;
  alpha: number; multiplicity: 'holm' | 'bh';
  arms: ExperimentArm[];
  status: ExperimentStatus;
  /** 사전 등록 시각. 이후 가설·주 지표·중지 규칙은 바꿀 수 없다(새 실험 필요). */
  registeredAt?: string;
  startedAt?: string; horizonAt?: string;
  looksUsed: number;
  lastDecisionId?: string;
  /** 승자 확대 근거가 된 효능 결정. 이후 품질 점검 스냅샷이 lastDecisionId를 덮어써도 보존한다. */
  winnerDecisionId?: string;
  /** 외부 작업 Run ID 기록(생성·일정·종료·promote·증액·중지). */
  runIds: string[];
  supersedes?: string;
  /** 공급자 실험 설정(MAX 네트워크·빈도·bid floor 등). 비밀값은 넣을 수 없다. */
  providerConfig?: Record<string, unknown>;
  statusReason?: string;
  policyVersion: number;
  createdAt: string; updatedAt: string;
}

export interface ArmMetrics {
  armId: string;
  /** 주 지표 관측값(일별 등)과 요약. */
  samples: number;
  successes?: number; trials?: number;
  values?: number[];
  estimate: number | null;
  spendMicros?: string; revenueMicros?: string; currency?: string;
}

export interface DataQuality {
  fresh: boolean; sampleSufficient: boolean; windowComplete: boolean; assignmentProven: boolean;
  currencyConsistent: boolean;
  reasons: string[];
}

export type DecisionOutcome = 'continue' | 'winner' | 'no_effect' | 'inconclusive' | 'stop_guardrail' | 'stop_loss' | 'blocked' | 'invalidated' | 'observational_only';

export interface DecisionSnapshot {
  id: string; experimentId: string; experimentVersion: number; projectId: string;
  at: string; look: number;
  kind: 'quality_check' | 'efficacy' | 'guardrail' | 'invalidation';
  outcome: DecisionOutcome;
  winnerArmId?: string;
  arms: ArmMetrics[];
  comparisons: Array<{ armId: string; effect: number | null; ciLow: number | null; ciHigh: number | null; pValue: number | null; adjustedP: number | null; boundaryP: number | null; significant: boolean }>;
  quality: DataQuality;
  guardrailViolations: string[];
  factIds: string[];
  policyVersion: number; algorithmVersion: string;
  mandateId: string; agentTaskId?: string;
  reasons: string[];
}

export type AttributionKind = 'spend' | 'revenue' | 'refund' | 'fee' | 'tax' | 'installs' | 'conversions' | 'clicks' | 'impressions' | 'active_users' | 'crashes' | 'sessions' | 'retained_d1';
export type Finality = 'estimated' | 'proceeds' | 'settled';

/** 귀속 fact. 원천 정정은 덮어쓰지 않고 revision과 supersedes로 계보를 남긴다. */
export interface AttributionFact {
  id: string; projectId: string; provider: Provider; connectionId: string;
  campaignId?: string; experimentId?: string; armId?: string;
  acquisitionDate?: string; cohortKey?: string; attributionWindowDays?: number;
  kind: AttributionKind;
  currency?: string; amountMicros?: string; count?: number;
  revenueBasis?: RevenueBasis;
  eventDate: string; observedAt: string; collectedAt: string;
  sourceId: string; sourceWatermark: string; revision: number;
  supersedes?: string;
  finality: Finality;
}

export interface FxSnapshot {
  id: string; source: string; date: string; base: string; quote: string;
  /** base 1단위 = rate quote. 소수 문자열(최대 10자리)로 저장해 부동소수 오차를 피한다. */
  rate: string; recordedAt: string; version: number;
}

export type KnowledgeSource = 'store_listing' | 'faq' | 'support_policy' | 'changelog' | 'known_issue' | 'analysis';
export interface KnowledgeRevision {
  id: string; projectId: string; documentKey: string; version: number;
  sourceKind: KnowledgeSource; title: string; body: string; sha256: string;
  sourceRef?: string;
  status: 'draft' | 'approved' | 'retired';
  approvedAt?: string; retiredAt?: string; createdAt: string;
}

export type RiskFlag = 'personal_data' | 'payment' | 'refund' | 'legal' | 'harassment' | 'self_harm' | 'child_safety' | 'security' | 'press' | 'dispute' | 'compensation' | 'prompt_injection' | 'spam' | 'opt_out' | 'sensitive_media';
export type ResponseStatus = 'ingested' | 'classified' | 'draft_ready' | 'blocked' | 'escalated' | 'authorized' | 'queued' | 'prepared' | 'dispatched' | 'confirmed' | 'unresolved' | 'closed' | 'retracted';
/**
 * 운영자 확인·처리가 남은 열린 응답 상태(사람 확인, 승인 대기, 차단 보류, 발송 경로).
 * 서버는 최근 표시 상한 밖이어도 이 상태의 응답을 목록에 유지하고, 화면은 이 상태 그룹을 펼쳐 보인다.
 */
export const OPEN_RESPONSE_STATUSES: readonly ResponseStatus[] = ['escalated', 'draft_ready', 'blocked', 'authorized', 'queued', 'prepared', 'dispatched'];

export interface Citation { revisionId: string; quote: string }
export interface ResponseDraft { text: string; sentences: Array<{ text: string; citations: Citation[] }>; language: string }
export interface ResponseClassification {
  intent: 'question' | 'bug_report' | 'feature_request' | 'praise' | 'complaint' | 'other';
  risks: RiskFlag[]; language: string; confidence: number;
  source: 'rules' | 'ai' | 'rules+ai';
}

export interface ResponseIntent {
  id: string; projectId: string; connectionId: string; provider: Provider;
  interactionId: string; replyTargetId: string;
  /** provider+account+interaction+target+action의 불변 외부 identity. policyVersion을 넣지 않는다. */
  externalIdentity: string;
  status: ResponseStatus;
  /** 원문 전체 대신 최소 발췌와 해시. */
  excerpt: string; textHash: string; authorHash: string;
  classification?: ResponseClassification;
  draft?: ResponseDraft;
  blockReasons: string[];
  escalation?: { reason: string; owner: string; dueAt: string };
  policyVersion?: number; knowledgeRevisionIds: string[];
  mandateId?: string; runId?: string; recallRunId?: string; incidentId?: string;
  createdAt: string; updatedAt: string;
}

export interface PlatformApproval {
  id: string; provider: 'x' | 'threads'; connectionId: string;
  kind: 'ai_reply_automation';
  evidence: string; approvedAt: string; expiresAt?: string;
  recordedAt: string; revokedAt?: string;
}

export interface OptOutRecord { id: string; provider: Provider; connectionId: string; authorHash: string; source: 'user_request' | 'operator'; at: string }

export interface GrowthIncident {
  id: string; projectId: string; reason: string;
  responseIntentIds: string[]; recallRunIds: string[];
  status: 'open' | 'recalling' | 'resolved';
  pausedMandateIds: string[];
  notes: string[]; createdAt: string; updatedAt: string;
}

export interface FeedbackItem {
  id: string; projectId: string;
  source: { provider: Provider; connectionId: string; interactionId: string };
  excerpt: string; textHash: string; authorHash: string; language: string;
  appVersion?: string; platform?: string; symptomKey?: string; errorCode?: string;
  sentiment: 'negative' | 'neutral' | 'positive';
  intent: ResponseClassification['intent'];
  occurredAt: string; editedAt?: string; deletedAt?: string;
  clusterId?: string;
  createdAt: string; updatedAt: string;
}

export interface IssuePriority {
  frequency: number; affectedUsers: number; revenueImpactMicros: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  reproConfidence: number; trend: 'rising' | 'stable' | 'falling' | 'new';
  strategicFit: 'unknown' | 'low' | 'medium' | 'high';
}

export interface IssueCluster {
  id: string; projectId: string; key: string; title: string;
  status: 'candidate' | 'confirmed' | 'merged' | 'split' | 'closed';
  itemIds: string[];
  /** 자동 병합에 사용한 설명 가능한 키 구성. */
  keyParts: { symptomKey?: string; errorCode?: string; appVersion?: string; platform?: string };
  candidates: Array<{ clusterId: string; similarity: number; reason: string }>;
  priority: IssuePriority;
  mergedInto?: string;
  audit: Array<{ at: string; action: 'created' | 'added' | 'merged' | 'split' | 'confirmed' | 'closed'; reason: string; itemIds?: string[] }>;
  createdAt: string; updatedAt: string;
}

export interface ProductExperimentLink {
  id: string; projectId: string; clusterId: string; hypothesis: string;
  status: 'proposed' | 'approved' | 'released' | 'observing' | 'concluded' | 'rolled_back';
  approvedAt?: string; approvalNote?: string;
  releaseVersion?: string; releaseObservationId?: string; releasedAt?: string;
  experimentId?: string;
  baseline?: { from: string; to: string };
  observation?: { from: string; to: string };
  result?: { negativeFeedbackBefore: number; negativeFeedbackAfter: number; mixedCohort: boolean; note: string };
  previousLinkId?: string;
  createdAt: string; updatedAt: string;
}

/** 위임 envelope 안의 가격 변경. 원래 가격을 먼저 보존하고 guardrail 위반 시 같은 경로로 원복한다. */
export interface PricingChange {
  id: string; projectId: string; mandateId: string; connectionId: string; provider: Provider;
  productExternalId: string; productType: 'one-time' | 'subscription' | 'unknown';
  region: string; currency: string;
  previousPriceMicros: string; proposedPriceMicros: string;
  status: 'proposed' | 'approval_required' | 'queued' | 'applied' | 'observing' | 'kept' | 'rolling_back' | 'rolled_back' | 'blocked' | 'failed' | 'action_required';
  guardrails: Guardrail[];
  baseline: Partial<Record<MetricKey, number>>;
  observeDays: number;
  reasons: string[];
  runId?: string; rollbackRunId?: string;
  approvedAt?: string; appliedAt?: string; decidedAt?: string;
  createdAt: string; updatedAt: string;
}

/** 스케줄러가 기록하는 성장 주기 상태. */
export interface GrowthCycleState {
  mandateId: string; lastRunAt?: string; nextDueAt?: string;
  watermarks: Record<string, string>;
  blockers: string[];
  lastError?: string;
}

/**
 * 성장 운영 조회 결과. projectId가 있으면 프로젝트 문서만 담고, fx·capabilities·approvals·digest는 전역 값이다.
 * digest(최근 24시간 집계와 조치 필요 항목)는 표시 상한과 별도 조회라 목록 상한으로 누락되지 않는다.
 */
export interface GrowthState {
  /** 프로젝트 범위 조회일 때 그 프로젝트 ID. 전역 조회에는 없다. */
  projectId?: string;
  mandates: OperationMandate[];
  policies: GrowthPolicy[];
  experiments: Experiment[];
  /** 최근 결정(at·id 내림차순, 서버 표시 상한까지). */
  decisions: DecisionSnapshot[];
  /** 상한 밖에 더 오래된 결정이 있으면 이어서 조회할 커서. */
  decisionsNext?: GrowthDecisionCursor | null;
  fx: FxSnapshot[];
  knowledge: KnowledgeRevision[];
  responses: ResponseIntent[];
  approvals: PlatformApproval[];
  incidents: GrowthIncident[];
  feedback: FeedbackItem[];
  clusters: IssueCluster[];
  productLinks: ProductExperimentLink[];
  pricing: PricingChange[];
  cycles: GrowthCycleState[];
  /** 프로젝트·통화·basis별 ROAS/ROI 계산 결과와 미계산 사유. */
  performance: PerformanceReport[];
  capabilities: ProviderExperimentCapability[];
  paused: boolean;
  /** 최근 24시간 묶음 요약. 개별 이벤트 알림 대신 조치가 필요한 항목만 모아 보여 준다. */
  digest: GrowthDigest;
  /** 제품 개선 연결에서 고를 공개 출시 기록. */
  releases: Array<{ id: string; projectId: string; provider: Provider; version: string; published: boolean; publishedAt: string | null }>;
}

/** 결정 이력 keyset 커서. 같은 at의 결정은 id 내림차순으로 이어진다. */
export interface GrowthDecisionCursor { at: string; id: string }
/** POST /growth/decisions/query 응답. */
export interface GrowthDecisionPage { decisions: DecisionSnapshot[]; next: GrowthDecisionCursor | null }

export interface GrowthDigest {
  from: string; to: string;
  decisions: Record<string, number>;
  community: { total: number; byStatus: Record<string, number>; byRisk: Record<string, number>; escalations: { open: number; overdue: number }; lowEvidence: number };
  pricing: Record<string, number>;
  actionRequired: Array<{ kind: 'experiment' | 'pricing' | 'incident' | 'escalation' | 'mandate'; id: string; projectId: string; reason: string }>;
  blockers: Array<{ mandateId: string; reasons: string[] }>;
}

export interface PerformanceReport {
  projectId: string; currency: string; windowDays: number;
  basis: RevenueBasis;
  spendMicros: string; attributedRevenueMicros: string; netProceedsMicros: string; variableCostMicros: string;
  roas: number | null; netRoi: number | null;
  roasReason?: string; netRoiReason?: string;
  quality: DataQuality;
  /** 기존 contribution과 혼동하지 않도록 각 값의 정의를 표시한다. */
  definitions: { roas: string; netRoi: string };
  factIds: string[];
}

export type CapabilityLevel = 'unsupported' | 'action_required' | 'read' | 'test_write' | 'write';
export interface ProviderExperimentCapability {
  connectionId: string; provider: Provider;
  kind: 'ads_native_experiment' | 'max_ad_unit_experiment';
  level: CapabilityLevel;
  reasons: string[];
  checkedAt: string;
  /** 공급자 문서·실계정 검증 수준. */
  verification: 'fixture' | 'read_verified' | 'test_verified' | 'live_verified';
}
