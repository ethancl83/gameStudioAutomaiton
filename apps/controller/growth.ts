import { createHash, randomUUID } from 'node:crypto';
import type { Connection, ExternalResource, Project, Provider, Run } from '../../packages/domain/index.js';
import { AppError, object, prohibitSecrets, text } from '../../packages/domain/errors.js';
import type { Store, RunMutation } from '../../packages/storage/index.js';
import { parseMicros } from '../../packages/metrics/index.js';
import { MANDATE_ACTIONS, OPEN_RESPONSE_STATUSES, type AttributionFact, type DecisionSnapshot, type Experiment, type ExperimentArm, type ExperimentHypothesis, type FeedbackItem, type FxSnapshot, type GrowthCycleState, type GrowthDecisionCursor, type GrowthDecisionPage, type GrowthDigest, type GrowthIncident, type GrowthPolicy, type GrowthState, type IssueCluster, type KnowledgeRevision, type MandateAction, type MandateLimits, type MetricKey, type OperationMandate, type PerformanceReport, type PlatformApproval, type PricingChange, type ProductExperimentLink, type ProviderExperimentCapability, type ResponseIntent, type RevenueBasis, type StoppingRule } from '../../packages/growth/types.js';
import { evaluateExperiment, invalidateDecision } from '../../packages/growth/decision.js';
import { currentFacts, performanceReports, withoutOverlap } from '../../packages/growth/attribution.js';
import { planBudgetStep, planStop } from '../../packages/growth/scale.js';
import { campaignPerformance, planCampaignRules } from '../../packages/growth/rebalance.js';
import { digest as communityDigest } from '../../packages/growth/community.js';
import { GrowthPricing } from './growth-pricing.js';
import { integer, iso, micros, ratio } from './growth-input.js';
import { GrowthCommunity } from './growth-community.js';
import { approveLink } from '../../packages/growth/feedback.js';

export interface GrowthHooks {
  mode: 'demo' | 'live';
  action(connectionId: string, input: unknown, mutate?: RunMutation): Run;
  cancel(runId: string): void;
  supported(provider: Provider, operation: string): boolean;
  /** 비신뢰 게시물 분류·초안용 1회성 AI 호출. 없으면 규칙 분류만 하고 초안은 근거 부족으로 막는다. */
  classify?(prompt: string, signal: AbortSignal): Promise<string>;
  projectFiles?(project: Project): Promise<Array<{ path: string; content: string }>>;
  agentListing?(projectId: string): { title: string; shortDescription: string; fullDescription: string } | undefined;
}

const pending = new Set(['queued', 'running', 'retry_wait']);
// 화면 표시 상한. 결정은 커서로 이어서 볼 수 있고, 응답은 처리 대기 상태를 상한과 별도로 포함한다.
const DECISION_LIMIT = 300, DECISION_PAGE = 50, RESPONSE_LIMIT = 500, FEEDBACK_LIMIT = 1000;
function decisionCursor(value: unknown): GrowthDecisionCursor {
  const cursor = object(value); const at = text(cursor.at, '결정 이력 위치', 40);
  // 저장한 at은 toISOString 형식이라 같은 형식만 받아야 문자열 비교 경계가 시각 순서와 일치한다.
  if (Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) throw new AppError('INVALID_INPUT', '결정 이력 위치가 올바르지 않습니다.');
  return { at, id: text(cursor.id, '결정 ID', 200) };
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const METRICS: MetricKey[] = ['roas', 'net_roi', 'conversion_rate', 'cost_per_install', 'arpdau', 'retention_d1', 'crash_free_rate', 'refund_rate'];
const BASES: RevenueBasis[] = ['gross_conversion_value', 'net_proceeds', 'estimated_ad_revenue'];
const PROVIDER_WRITES: Record<string, { create: string; end: string; promote?: string; action: MandateAction } | undefined> = {
  // App 캠페인 A/B는 Campaign Mix만 가능하고 공식 종료 방법이 End/Graduate라 promote를 쓰지 않는다. 승자는 예산 단계 증액으로 확대한다.
  'google-ads': { create: 'create-experiment', end: 'end-experiment', action: 'ads-experiment' },
  'applovin-max': { create: 'create-ad-unit-experiment', end: 'deprecate-ad-unit-experiment', promote: 'promote-ad-unit-experiment', action: 'max-experiment' },
};

/**
 * 성장 운영 통합 경계. 명시적으로 확정한 OperationMandate 안에서만 주기 작업을 실행하고,
 * 모든 외부 변경은 기존 내구성 큐(service.action)의 정책·예산·소셜 검사를 그대로 통과한다.
 */
export class GrowthOperations {
  private running: Promise<void> | undefined;
  private abort = new AbortController();
  readonly pricing: GrowthPricing;
  readonly community: GrowthCommunity;
  constructor(private store: Store, private hooks: GrowthHooks, private clock: () => number = Date.now) {
    this.pricing = new GrowthPricing(store, { iso: () => this.iso(), clock: () => this.clock(), mandate: id => this.mandate(id), policy: id => this.policy(id), active: mandate => this.active(mandate),
      queueWrite: (mandate, action, connectionId, operation, input, identity, safety) => this.queueWrite(mandate, action, connectionId, operation, input, identity, safety) });
    this.community = new GrowthCommunity(store, { hooks, iso: () => this.iso(), clock: () => this.clock(), signal: () => this.abort.signal, project: id => this.project(id), policy: id => this.policy(id),
      active: mandate => this.active(mandate), stopMandate: (id, reason) => this.stopMandate(id, reason),
      track: (run, mandateId, responseId, reused, safety) => this.track(run, mandateId, safety ?? false, responseId, reused),
      cancelResponses: responseIds => this.cancelPending(link => Boolean(link.responseId && responseIds.includes(link.responseId))) });
  }
  private iso(): string { return new Date(this.clock()).toISOString(); }

  // ── 조회 ──────────────────────────────────────────────
  /**
   * 화면 폴링용 상태. projectId가 있으면 프로젝트 문서만 SQL에서 읽고, 없으면 기존처럼 전체를 돌려준다.
   * 표시 상한은 DB에서 적용하며 digest는 상한과 무관한 별도 조회라 조치 필요 항목이 빠지지 않는다.
   */
  state(projectId?: string): GrowthState {
    const scope = projectId === undefined ? {} : { projectId };
    const policies = this.store.documents<GrowthPolicy>('growth-policy', scope);
    const fx = this.store.list<FxSnapshot>('fx-snapshot');
    const mandates = this.store.documents<OperationMandate>('growth-mandate', scope);
    const decisions = this.store.documentPage<DecisionSnapshot>('growth-decision', { ...scope, order: 'at', limit: DECISION_LIMIT });
    const responses = this.store.documents<ResponseIntent>('response-intent', { ...scope, limit: RESPONSE_LIMIT });
    // 운영자가 처리해야 하는 응답은 최근 상한 밖이어도 대기열에 남긴다.
    const seen = new Set(responses.map(item => item.id));
    for (const item of this.store.documents<ResponseIntent>('response-intent', { ...scope, in: { status: OPEN_RESPONSE_STATUSES } })) if (!seen.has(item.id)) responses.push(item);
    return {
      ...scope,
      mandates, policies,
      experiments: this.store.documents<Experiment>('growth-experiment', scope),
      decisions: decisions.items, decisionsNext: decisions.next && { at: decisions.next.value, id: decisions.next.id },
      fx, knowledge: this.store.documents<KnowledgeRevision>('knowledge-revision', scope),
      responses,
      approvals: this.store.list<PlatformApproval>('platform-approval'),
      incidents: this.store.documents<GrowthIncident>('growth-incident', scope),
      feedback: this.store.documents<FeedbackItem>('feedback-item', { ...scope, limit: FEEDBACK_LIMIT }),
      clusters: this.store.documents<IssueCluster>('issue-cluster', scope),
      productLinks: this.store.documents<ProductExperimentLink>('product-link', scope),
      pricing: this.store.documents<PricingChange>('pricing-change', scope),
      cycles: projectId === undefined ? this.store.list<GrowthCycleState>('growth-cycle')
        : this.store.documents<GrowthCycleState>('growth-cycle', { in: { mandateId: mandates.map(item => item.id) } }),
      performance: this.performance(policies, mandates, fx, projectId),
      capabilities: this.store.list<ProviderExperimentCapability>('growth-capability'),
      paused: this.paused(),
      digest: this.digest(),
      releases: this.store.documents<import('../../packages/domain/index.js').ReleaseObservation>('release-observation', scope).map(({ id, projectId, provider, version, published, publishedAt }) => ({ id, projectId, provider, version, published, publishedAt })),
    };
  }
  /**
   * 결정 이력의 이전 페이지(POST /growth/decisions/query). 커서는 (at, id) 내림차순 경계다.
   * 실험을 지정하면 그 실험이 요청한 프로젝트 소속일 때만 조회하고, 형식이 어긋난 커서는 거절한다.
   */
  decisionPage(input: unknown): GrowthDecisionPage {
    const data = object(input);
    const projectId = text(data.projectId, '프로젝트 ID', 100);
    if (!this.store.get<Project>('project', projectId)) throw new AppError('NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
    const experimentId = data.experimentId === undefined ? undefined : text(data.experimentId, '실험 ID', 100);
    if (experimentId !== undefined && this.store.get<Experiment>('growth-experiment', experimentId)?.projectId !== projectId) throw new AppError('NOT_FOUND', '이 프로젝트의 실험을 찾을 수 없습니다.', 404);
    const before = data.before === undefined ? undefined : decisionCursor(data.before);
    const limit = data.limit === undefined ? DECISION_PAGE : integer(data.limit, '조회 개수', 1, 100);
    const page = this.store.documentPage<DecisionSnapshot>('growth-decision', { projectId, ...(experimentId ? { in: { experimentId: [experimentId] } } : {}),
      order: 'at', limit, ...(before ? { before: { value: before.at, id: before.id } } : {}) });
    return { decisions: page.items, next: page.next && { at: page.next.value, id: page.next.id } };
  }
  private paused(): boolean {
    return Boolean(this.store.get('settings', 'growth-paused')) || Boolean(this.store.get('settings', 'device-transferred'));
  }
  /**
   * 성과 보고서는 성숙한 모든 획득 cohort를 합산하고(기간 하한 없음) revision·supersedes로 현재 fact를 고르므로,
   * 시간창으로 자르지 않고 프로젝트 범위의 fact 전체를 읽는다. 창을 자르면 대체된 fact가 되살아날 수 있다.
   */
  private performance(policies: GrowthPolicy[], mandates: OperationMandate[], fx: FxSnapshot[], projectId?: string): PerformanceReport[] {
    const facts = new Map<string, AttributionFact[]>();
    for (const fact of this.store.documents<AttributionFact>('attribution-fact', projectId === undefined ? {} : { projectId })) {
      const list = facts.get(fact.projectId); if (list) list.push(fact); else facts.set(fact.projectId, [fact]);
    }
    const projects = projectId === undefined ? this.store.list<Project>('project').map(item => item.id) : this.store.get<Project>('project', projectId) ? [projectId] : [];
    const performance: PerformanceReport[] = [];
    for (const id of projects) {
      const policy = policies.find(item => item.projectId === id);
      if (!policy) continue;
      const goals = mandates.find(item => item.projectId === id && item.status === 'active')?.goals;
      const windows = new Map<string, { windowDays: number; basis: RevenueBasis }>();
      if (goals?.roas) windows.set(goals.roas.basis + goals.roas.windowDays, { windowDays: goals.roas.windowDays, basis: goals.roas.basis });
      if (goals?.netRoi) windows.set('net_proceeds' + goals.netRoi.windowDays, { windowDays: goals.netRoi.windowDays, basis: 'net_proceeds' });
      if (!windows.size) windows.set('default', { windowDays: 7, basis: 'gross_conversion_value' });
      for (const option of windows.values()) performance.push(...performanceReports(id, facts.get(id) ?? [], policy, fx, new Date(this.clock()), option));
    }
    return performance;
  }
  /** 전체 프로젝트의 최근 24시간 집계와 조치 필요 항목. 시간창·상태 조건을 SQL에서 적용한다. */
  private digest(): GrowthDigest {
    const to = this.iso(); const from = new Date(this.clock() - 86_400_000).toISOString();
    const count = (items: string[]) => items.reduce<Record<string, number>>((result, key) => ({ ...result, [key]: (result[key] ?? 0) + 1 }), {});
    const community = communityDigest(this.store.documents<ResponseIntent>('response-intent', { range: { field: 'createdAt', from, to } }), from, to);
    const actionRequired: GrowthDigest['actionRequired'] = [
      ...this.store.documents<Experiment>('growth-experiment', { in: { status: ['action_required'] } }).map(item => ({ kind: 'experiment' as const, id: item.id, projectId: item.projectId, reason: item.statusReason ?? '실험 확인이 필요합니다.' })),
      ...this.store.documents<PricingChange>('pricing-change', { in: { status: ['approval_required', 'action_required'] } }).map(item => ({ kind: 'pricing' as const, id: item.id, projectId: item.projectId, reason: item.reasons.at(-1) ?? '가격 변경 확인이 필요합니다.' })),
      ...this.store.documents<GrowthIncident>('growth-incident', { notIn: { status: ['resolved'] } }).map(item => ({ kind: 'incident' as const, id: item.id, projectId: item.projectId, reason: item.reason })),
      ...this.store.documents<ResponseIntent>('response-intent', { in: { status: ['escalated'] } }).map(item => ({ kind: 'escalation' as const, id: item.id, projectId: item.projectId, reason: item.escalation?.reason ?? '사람 확인이 필요한 문의입니다.' })),
      ...this.store.documents<OperationMandate>('growth-mandate', { in: { status: ['proposed'] } }).map(item => ({ kind: 'mandate' as const, id: item.id, projectId: item.projectId, reason: 'AI가 제안한 위임안의 확정이 필요합니다.' })),
    ];
    return { from, to,
      decisions: count(this.store.documents<DecisionSnapshot>('growth-decision', { range: { field: 'at', from }, notIn: { kind: ['quality_check'] } }).map(item => item.outcome)),
      community: { total: community.total, byStatus: community.byStatus, byRisk: community.byRisk, escalations: community.escalations, lowEvidence: community.lowEvidence },
      pricing: count(this.store.documents<PricingChange>('pricing-change', { range: { field: 'updatedAt', from } }).map(item => item.status)),
      actionRequired,
      blockers: this.store.list<GrowthCycleState>('growth-cycle').filter(item => item.blockers.length || item.lastError).map(item => ({ mandateId: item.mandateId, reasons: [...new Set([...(item.lastError ? [item.lastError] : []), ...item.blockers])].slice(0, 8) })) };
  }
  /** AI 채팅 도구용 요약. 원문 게시물·작성자 해시는 포함하지 않는다. */
  context(projectId: string) {
    const scope = { projectId };
    const mandates = this.store.documents<OperationMandate>('growth-mandate', scope);
    const policies = this.store.documents<GrowthPolicy>('growth-policy', scope);
    return {
      mandates,
      policy: policies[0] ?? null,
      experiments: this.store.documents<Experiment>('growth-experiment', scope),
      decisions: this.store.documentPage<DecisionSnapshot>('growth-decision', { ...scope, order: 'at', limit: 20 }).items,
      performance: this.performance(policies, mandates, this.store.list<FxSnapshot>('fx-snapshot'), projectId),
      capabilities: this.store.list<ProviderExperimentCapability>('growth-capability'),
      responses: this.store.documents<ResponseIntent>('response-intent', { ...scope, limit: 50 }).map(({ excerpt: _e, authorHash: _a, textHash: _t, ...rest }) => rest),
      clusters: this.store.documents<IssueCluster>('issue-cluster', { ...scope, notIn: { status: ['merged'] } }).map(({ itemIds, ...rest }) => ({ ...rest, itemCount: itemIds.length })),
      productLinks: this.store.documents<ProductExperimentLink>('product-link', scope),
      paused: this.paused(),
    };
  }

  // ── 명령 ──────────────────────────────────────────────
  async action(input: unknown): Promise<unknown> {
    const data = object(input); prohibitSecrets(data);
    switch (text(data.action, '성장 운영 작업', 60)) {
      case 'save-policy': return this.savePolicy(data);
      case 'propose-mandate': return this.proposeMandate(data);
      case 'confirm-mandate': return this.confirmMandate(text(data.id, '위임 ID', 100), integer(data.version, '위임 버전', 1, 1_000_000));
      case 'stop-mandate': return this.stopMandate(text(data.id, '위임 ID', 100), text(data.reason ?? '사용자가 중지했습니다.', '중지 사유', 500));
      case 'run-cycle': return this.runMandateNow(text(data.id, '위임 ID', 100));
      case 'create-experiment': return this.createExperiment(data);
      case 'register-experiment': return this.registerExperiment(text(data.id, '실험 ID', 100), integer(data.version, '실험 버전', 1, 1_000_000));
      case 'start-experiment': return this.startExperiment(text(data.id, '실험 ID', 100));
      case 'resume-experiment': return this.resumeExperiment(text(data.id, '실험 ID', 100), text(data.note, '확인 내용', 1000));
      case 'stop-experiment': return this.stopExperiment(text(data.id, '실험 ID', 100), text(data.reason ?? '사용자가 중지했습니다.', '중지 사유', 500));
      case 'record-fx': return this.recordFx(data);
      case 'save-knowledge': return this.community.saveKnowledge(data);
      case 'approve-knowledge': return this.community.reviseKnowledge(text(data.id, '지식 ID', 100), 'approve');
      case 'retire-knowledge': return this.community.reviseKnowledge(text(data.id, '지식 ID', 100), 'retire');
      case 'import-knowledge': return this.community.importKnowledge(text(data.projectId, '프로젝트 ID', 100));
      case 'record-approval': return this.community.recordApproval(data);
      case 'revoke-approval': return this.community.revokeApproval(text(data.id, '승인 기록 ID', 100));
      case 'authorize-response': return this.community.authorizeResponse(text(data.id, '응답 ID', 200));
      case 'dismiss-response': return this.community.dismissResponse(text(data.id, '응답 ID', 200), text(data.reason ?? '운영자가 보류했습니다.', '사유', 500));
      case 'record-opt-out': return this.community.recordOptOut(text(data.id, '응답 ID', 200), 'operator');
      case 'recall-response': return this.community.recallResponse(text(data.id, '응답 ID', 200), text(data.reason, '회수 사유', 500));
      case 'resolve-incident': return this.community.resolveIncident(text(data.id, '사고 ID', 100), text(data.note ?? '처리를 완료했습니다.', '처리 메모', 1000));
      case 'confirm-cluster': return this.community.updateCluster(text(data.id, '이슈 ID', 100), cluster => ({ ...cluster, status: 'confirmed', audit: [...cluster.audit, { at: this.iso(), action: 'confirmed', reason: text(data.reason ?? '운영자가 확인했습니다.', '사유', 500) }] }));
      case 'merge-clusters': return this.community.mergeCluster(text(data.targetId, '대상 이슈', 100), text(data.sourceId, '병합할 이슈', 100), text(data.reason, '병합 사유', 500));
      case 'split-cluster': return this.community.splitIssue(text(data.id, '이슈 ID', 100), data.itemIds, text(data.reason, '분리 사유', 500));
      case 'propose-product-link': return this.community.proposeProductLink(text(data.clusterId, '이슈 ID', 100), text(data.hypothesis, '제품 개선 가설', 1000));
      case 'approve-product-link': return this.community.updateLink(text(data.id, '연결 ID', 100), link => approveLink(link, text(data.note, '승인 메모', 1000), this.iso()));
      case 'attach-release': return this.community.attachProductRelease(text(data.id, '연결 ID', 100), text(data.releaseObservationId, '출시 기록', 200));
      case 'verify-capability': return this.verifyCapability(data);
      case 'propose-price': return this.pricing.propose(data);
      case 'approve-price': return this.pricing.approve(text(data.id, '가격 변경 ID', 100), text(data.note, '승인 메모', 1000));
      case 'rollback-price': return this.pricing.rollback(text(data.id, '가격 변경 ID', 100), text(data.reason ?? '운영자가 원복을 요청했습니다.', '원복 사유', 500));
      case 'resume-growth': return this.resume();
      default: throw new AppError('UNSUPPORTED_OPERATION', '지원하지 않는 성장 운영 작업입니다.');
    }
  }

  private project(id: string): Project {
    const project = this.store.get<Project>('project', id);
    if (!project) throw new AppError('NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
    return project;
  }
  private policy(projectId: string): GrowthPolicy {
    const policy = this.store.get<GrowthPolicy>('growth-policy', projectId);
    if (!policy) throw new AppError('GROWTH_POLICY_REQUIRED', '성장 운영의 통계·신선도 정책을 먼저 저장해 주세요.');
    return policy;
  }
  savePolicy(data: Record<string, unknown>): GrowthPolicy {
    const projectId = text(data.projectId, '프로젝트 ID', 100); this.project(projectId);
    const previous = this.store.get<GrowthPolicy>('growth-policy', projectId);
    const freshness: GrowthPolicy['freshnessHours'] = {};
    for (const [provider, hours] of Object.entries(object(data.freshnessHours ?? {}))) freshness[provider as Provider] = integer(hours, `${provider} 신선도 기준(시간)`, 1, 24 * 60);
    const multiplicity = data.multiplicity === 'bh' ? 'bh' : data.multiplicity === 'holm' ? 'holm' : undefined;
    const stopping = data.defaultStopping === 'sequential' ? 'sequential' : data.defaultStopping === 'fixed_horizon' ? 'fixed_horizon' : undefined;
    if (!multiplicity || !stopping) throw new AppError('INVALID_INPUT', '다중 비교 보정과 중지 규칙을 선택해 주세요.');
    const reportingCurrency = data.reportingCurrency ? text(data.reportingCurrency, '보고 통화', 3).toUpperCase() : undefined;
    if (reportingCurrency && !/^[A-Z]{3}$/.test(reportingCurrency)) throw new AppError('INVALID_INPUT', '보고 통화 코드를 확인해 주세요.');
    if (typeof data.allowPricingExperiments !== 'boolean') throw new AppError('INVALID_INPUT', '가격 실험 허용 여부를 선택해 주세요.');
    const policy: GrowthPolicy = {
      projectId, version: (previous?.version ?? 0) + 1,
      alpha: ratio(data.alpha, '유의수준', 0.001, 0.2), multiplicity, defaultStopping: stopping, freshnessHours: freshness,
      ...(reportingCurrency ? { reportingCurrency } : {}),
      ...(data.fxSource ? { fxSource: text(data.fxSource, '환율 출처', 100) } : {}),
      fxMaxAgeHours: integer(data.fxMaxAgeHours ?? 48, '환율 허용 기간(시간)', 1, 24 * 31),
      variableCostRate: ratio(data.variableCostRate ?? 0, '가변비용 비율', 0, 0.9),
      allowPricingExperiments: data.allowPricingExperiments, updatedAt: this.iso(),
    };
    this.store.writeBatch([{ kind: 'growth-policy', id: projectId, value: policy }], [], [{ projectId, kind: 'growth.policy', message: `성장 운영 정책 v${policy.version}을 저장했습니다. 대기 중인 결정은 새 정책으로 다시 평가합니다.`, data: { version: policy.version } }]);
    return policy;
  }

  /**
   * probe는 쓰기 가능을 스스로 주장하지 않는다. 운영자가 시험/실계정에서 생성·종료를 확인한 근거를 기록해야
   * native 실험 쓰기를 연다. 공급자 문서 확인만으로는 test_write로 올리지 않는다.
   */
  verifyCapability(data: Record<string, unknown>): ProviderExperimentCapability {
    const connectionId = text(data.connectionId, '계정', 100);
    const kind = data.kind === 'max_ad_unit_experiment' ? 'max_ad_unit_experiment' : data.kind === 'ads_native_experiment' ? 'ads_native_experiment' : undefined;
    const level = data.level === 'write' ? 'write' : data.level === 'test_write' ? 'test_write' : undefined;
    if (!kind || !level) throw new AppError('INVALID_INPUT', '확인한 실험 기능과 수준을 선택해 주세요.');
    const stored = this.store.get<ProviderExperimentCapability>('growth-capability', connectionId + ':' + kind);
    if (!stored || !['read', 'test_write', 'write'].includes(stored.level)) throw new AppError('CAPABILITY_REQUIRED', '먼저 계정의 실험 조회 기능을 확인해 주세요. 조회가 안 되는 계정은 쓰기를 열 수 없습니다.', 409);
    const evidence = text(data.evidence, '검증 근거', 2000);
    if (evidence.length < 10) throw new AppError('INVALID_INPUT', '시험 계정에서 생성·종료를 확인한 내용을 구체적으로 기록해 주세요.');
    const value: ProviderExperimentCapability = { ...stored, level, verification: level === 'write' ? 'live_verified' : 'test_verified', reasons: [...stored.reasons, '운영자 검증: ' + evidence], checkedAt: this.iso() };
    this.store.writeBatch([{ kind: 'growth-capability', id: connectionId + ':' + kind, value }], [], [{ kind: 'growth.capability', message: '공급자 실험 쓰기 검증 근거를 기록했습니다.', data: { connectionId, kind, level } }]);
    return value;
  }
  // ── 위임 ──────────────────────────────────────────────
  proposeMandate(data: Record<string, unknown>): OperationMandate {
    const projectId = text(data.projectId, '프로젝트 ID', 100); const project = this.project(projectId);
    if (project.relinkRequired) throw new AppError('PROJECT_RELINK_REQUIRED', '복원한 프로젝트의 원본 폴더를 연결한 뒤 위임해 주세요.', 409);
    const policy = this.policy(projectId);
    const source = ['chat', 'screen-button', 'form'].includes(String(data.source)) ? data.source as OperationMandate['origin']['source'] : undefined;
    if (!source) throw new AppError('INVALID_INPUT', '위임 요청 출처를 확인해 주세요.');
    const evidence: string[] = [];
    if (!Array.isArray(data.actions) || !data.actions.length) throw new AppError('INVALID_INPUT', '위임할 운영 동작을 선택해 주세요.');
    const actions = [...new Set(['observe', ...data.actions.map(item => text(item, '운영 동작', 40))])] as MandateAction[];
    if (actions.some(item => !MANDATE_ACTIONS.includes(item))) throw new AppError('INVALID_INPUT', '지원하지 않는 운영 동작이 포함되어 있습니다.');
    const connections = this.store.list<Connection>('connection').filter(item => item.status !== 'disconnected');
    const allowed = new Set([...project.policy.allowedConnectionIds, ...(project.socialPolicy?.connectionIds ?? [])]);
    let connectionIds = Array.isArray(data.connectionIds) ? [...new Set(data.connectionIds.map(item => text(item, '연결 ID', 100)))] : [];
    if (!connectionIds.length) {
      connectionIds = connections.filter(item => allowed.has(item.id)).map(item => item.id);
      if (connectionIds.length) evidence.push('운영 계정은 프로젝트 정책이 이미 허용한 연결을 재사용했습니다.');
    }
    if (!connectionIds.length || connectionIds.length > 20) throw new AppError('INVALID_INPUT', '위임할 계정·채널을 선택해 주세요.');
    for (const id of connectionIds) if (!connections.some(item => item.id === id) || !allowed.has(id)) throw new AppError('POLICY_DENIED', '프로젝트 정책에서 허용한 연결만 위임할 수 있습니다.', 403);
    const startsAt = data.startsAt ? iso(data.startsAt, '시작 시각') : this.iso();
    const endsAt = iso(data.endsAt, '종료 시각');
    if (Date.parse(endsAt) <= Date.parse(startsAt) || Date.parse(endsAt) <= this.clock()) throw new AppError('INVALID_INPUT', '종료 시각은 시작 시각과 현재 이후여야 합니다.');
    if (Date.parse(endsAt) - Date.parse(startsAt) > 366 * 86_400_000) throw new AppError('INVALID_INPUT', '한 번의 위임 기간은 1년 이내여야 합니다.');
    const limits = this.limits(object(data.limits ?? {}), project, actions, evidence);
    const goals = object(data.goals ?? {});
    const roas = goals.roas ? object(goals.roas) : undefined; const netRoi = goals.netRoi ? object(goals.netRoi) : undefined;
    if (roas && !BASES.includes(roas.basis as RevenueBasis)) throw new AppError('INVALID_INPUT', 'ROAS 수익 기준을 선택해 주세요.');
    const mandate: OperationMandate = {
      id: randomUUID(), projectId, version: 1, status: 'proposed',
      origin: { source, requestText: text(data.requestText, '요청 문구', 4000), requestedAt: this.iso(), ...(data.agentTaskId ? { agentTaskId: text(data.agentTaskId, 'AI 작업 ID', 100) } : {}) },
      connectionIds, actions,
      goals: {
        ...(roas ? { roas: { target: ratio(roas.target, '목표 ROAS', 0.01, 100), basis: roas.basis as RevenueBasis, windowDays: integer(roas.windowDays, 'ROAS 귀속 창(0은 공급자 기본 창)', 0, 365) } } : {}),
        ...(netRoi ? { netRoi: { target: ratio(netRoi.target, '목표 순이익 ROI', -0.99, 100), windowDays: integer(netRoi.windowDays, 'ROI 귀속 창(0은 공급자 기본 창)', 0, 365) } } : {}),
      },
      limits, startsAt, endsAt,
      cadenceMinutes: data.cadenceMinutes === undefined ? 60 : integer(data.cadenceMinutes, '주기(분)', 15, 7 * 24 * 60),
      reuseEvidence: evidence, policyVersion: policy.version, createdAt: this.iso(), updatedAt: this.iso(),
    };
    if (data.cadenceMinutes === undefined) evidence.push('주기는 제안 기본값 60분입니다. 확정 전에 바꿀 수 있습니다.');
    // 화면 양식은 사용자가 직접 확인한 입력이므로 바로 확정할 수 있다. AI 제안은 항상 별도 확정이 필요하다.
    const confirmed = source === 'form' && data.confirm === true;
    const value = confirmed ? { ...mandate, status: 'active' as const, confirmedAt: this.iso(), nextDueAt: startsAt } : mandate;
    this.store.writeBatch([{ kind: 'growth-mandate', id: value.id, value }], [], [{ projectId, kind: confirmed ? 'growth.mandate.active' : 'growth.mandate.proposed',
      message: confirmed ? '요청한 범위와 기간으로 성장 운영 위임을 시작했습니다.' : '성장 운영 위임안을 만들었습니다. 범위·기간·한도를 확인한 뒤 확정해 주세요.', data: { mandateId: value.id, actions, endsAt } }]);
    return value;
  }
  private limits(data: Record<string, unknown>, project: Project, actions: MandateAction[], evidence: string[]): MandateLimits {
    const spends = actions.some(item => ['ads-experiment', 'ads-scale', 'ads-rebalance'].includes(item));
    const currency = data.currency ? text(data.currency, '통화', 3).toUpperCase() : project.policy.currency;
    if (!data.currency) evidence.push(`통화는 프로젝트 정책 통화 ${currency}를 재사용했습니다.`);
    let daily = data.maxDailySpendMicros === undefined ? undefined : micros(data.maxDailySpendMicros, '일일 지출 한도');
    if (daily === undefined) { daily = project.policy.maxDailyBudgetMicros; evidence.push('일일 지출 한도는 프로젝트 일일 광고 예산 한도를 재사용했습니다.'); }
    if (parseMicros(daily) > parseMicros(project.policy.maxDailyBudgetMicros) || currency !== project.policy.currency && spends) throw new AppError('BUDGET_LIMIT', '위임 한도는 프로젝트 광고 예산 한도와 통화를 넘을 수 없습니다.', 403);
    const need = (key: string, label: string) => { if (data[key] === undefined) throw new AppError('INVALID_INPUT', `${label}을 입력해 주세요. 추론할 수 있는 기존 승인값이 없습니다.`); return data[key]; };
    const maxDailyReplies = data.maxDailyReplies !== undefined ? integer(data.maxDailyReplies, '일일 자동 답글 한도', 0, 100)
      : actions.includes('community-reply') && project.socialPolicy ? (evidence.push('일일 답글 한도는 프로젝트 커뮤니티 일일 한도를 재사용했습니다.'), project.socialPolicy.dailyPostLimit) : 0;
    const limits: MandateLimits = {
      currency, maxDailySpendMicros: daily,
      maxTotalSpendMicros: spends ? micros(need('maxTotalSpendMicros', '누적 지출 한도'), '누적 지출 한도') : micros(data.maxTotalSpendMicros ?? '0', '누적 지출 한도'),
      maxLossMicros: spends ? micros(need('maxLossMicros', '누적 손실 한도'), '누적 손실 한도') : micros(data.maxLossMicros ?? '0', '누적 손실 한도'),
      maxBudgetStep: actions.includes('ads-scale') || actions.includes('ads-rebalance') ? ratio(need('maxBudgetStep', '1회 예산 변경 폭'), '1회 예산 변경 폭', 0.01, 1) : 0,
      cooldownHours: actions.includes('ads-scale') || actions.includes('ads-rebalance') ? integer(need('cooldownHours', '예산 변경 간격(시간)'), '예산 변경 간격(시간)', 1, 24 * 30) : 24,
      ...(data.campaignStopRoasBelow !== undefined ? { campaignStopRoasBelow: ratio(data.campaignStopRoasBelow, '캠페인 중지 ROAS 기준', 0, 100) } : {}),
      ...(data.minDecisionSpendMicros !== undefined ? { minDecisionSpendMicros: micros(data.minDecisionSpendMicros, '판단 최소 광고비') } : {}),
      maxDailyReplies,
    };
    if (actions.includes('pricing-change')) {
      const pricing = object(need('pricing', '가격 변경 범위'));
      const bounds = Array.isArray(pricing.bounds) ? pricing.bounds.map(item => { const bound = object(item);
        const floor = micros(bound.floorMicros, '최저 가격'); const ceiling = micros(bound.ceilingMicros, '최고 가격');
        if (parseMicros(floor) > parseMicros(ceiling)) throw new AppError('INVALID_INPUT', '최저 가격이 최고 가격보다 큽니다.');
        return { productId: text(bound.productId, '상품 ID', 200), currency: text(bound.currency, '가격 통화', 3).toUpperCase(), floorMicros: floor, ceilingMicros: ceiling }; }) : [];
      if (!bounds.length) throw new AppError('INVALID_INPUT', '상품별 가격 범위를 입력해 주세요.');
      limits.pricing = { productIds: [...new Set(bounds.map(item => item.productId))], regions: Array.isArray(pricing.regions) ? pricing.regions.map(item => text(item, '지역', 10).toUpperCase()) : [],
        bounds, maxStep: ratio(pricing.maxStep, '1회 가격 변화 폭', 0.01, 0.5), cooldownHours: integer(pricing.cooldownHours, '가격 변경 간격', 24, 24 * 90),
        maxConcurrentExperiments: integer(pricing.maxConcurrentExperiments ?? 1, '동시 가격 실험 수', 1, 5) };
      if (!limits.pricing.regions.length) throw new AppError('INVALID_INPUT', '가격을 바꿀 지역을 입력해 주세요.');
    }
    return limits;
  }
  private mandate(id: string): OperationMandate {
    const mandate = this.store.get<OperationMandate>('growth-mandate', id);
    if (!mandate) throw new AppError('NOT_FOUND', '성장 운영 위임을 찾을 수 없습니다.', 404);
    return mandate;
  }
  confirmMandate(id: string, version: number): OperationMandate {
    const mandate = this.mandate(id);
    if (mandate.status !== 'proposed' || mandate.version !== version) throw new AppError('STALE_MANDATE', '위임안이 바뀌었거나 이미 처리되었습니다. 최신 내용을 확인해 주세요.', 409);
    if (Date.parse(mandate.endsAt) <= this.clock()) throw new AppError('MANDATE_EXPIRED', '위임 기간이 이미 지났습니다. 새로 요청해 주세요.', 409);
    if (this.policy(mandate.projectId).version !== mandate.policyVersion) throw new AppError('STALE_MANDATE', '성장 정책이 바뀌었습니다. 위임안을 다시 만들어 주세요.', 409);
    // 제안 뒤 프로젝트 정책(허용 연결·예산 한도)이 바뀌었으면 확정하지 않는다.
    const project = this.project(mandate.projectId);
    const allowed = new Set([...project.policy.allowedConnectionIds, ...(project.socialPolicy?.connectionIds ?? [])]);
    if (mandate.connectionIds.some(id => !allowed.has(id))) throw new AppError('STALE_MANDATE', '제안 뒤 프로젝트 정책에서 허용 계정이 바뀌었습니다. 위임안을 다시 만들어 주세요.', 409);
    if (parseMicros(mandate.limits.maxDailySpendMicros) > parseMicros(project.policy.maxDailyBudgetMicros)) throw new AppError('STALE_MANDATE', '제안 뒤 프로젝트 일일 예산 한도가 낮아졌습니다. 위임안을 다시 만들어 주세요.', 409);
    const value: OperationMandate = { ...mandate, status: 'active', version: mandate.version + 1, confirmedAt: this.iso(), nextDueAt: mandate.startsAt, updatedAt: this.iso() };
    this.store.writeBatch([{ kind: 'growth-mandate', id, value }], [], [{ projectId: mandate.projectId, kind: 'growth.mandate.active', message: '성장 운영 위임을 확정했습니다. 기간 안에서만 주기 작업을 실행합니다.', data: { mandateId: id } }]);
    return value;
  }
  stopMandate(id: string, reason: string): OperationMandate {
    const mandate = this.mandate(id);
    if (['stopped', 'expired'].includes(mandate.status)) return mandate;
    const value: OperationMandate = { ...mandate, status: 'stopped', version: mandate.version + 1, stoppedAt: this.iso(), stopReason: reason, updatedAt: this.iso() };
    const updates: { kind: 'growth-mandate' | 'response-intent'; id: string; value: unknown }[] = [{ kind: 'growth-mandate', id, value }];
    // 아직 큐에 넣지 않은 자동 승인 답글은 중지와 함께 막는다. 이미 보낸 작업은 기존 큐가 결과를 확인한다.
    for (const intent of this.store.list<ResponseIntent>('response-intent')) if (intent.mandateId === id && intent.status === 'authorized')
      updates.push({ kind: 'response-intent', id: intent.id, value: { ...intent, status: 'draft_ready', blockReasons: ['위임이 중지되어 발송하지 않았습니다.'], updatedAt: this.iso() } });
    this.store.writeBatch(updates, [], [{ projectId: mandate.projectId, kind: 'growth.mandate.stopped', message: '성장 운영 위임을 중지했습니다: ' + reason, level: 'warning', data: { mandateId: id } }]);
    this.cancelPending(link => link.mandateId === id && !link.safety);
    return value;
  }
  private active(mandate: OperationMandate, at = this.clock()): boolean {
    return mandate.status === 'active' && Date.parse(mandate.startsAt) <= at && at < Date.parse(mandate.endsAt) && !this.store.get('settings', 'growth-paused') && !this.store.get('settings', 'device-transferred');
  }
  private allows(mandate: OperationMandate, action: MandateAction, connectionId?: string): string | null {
    if (!this.active(mandate)) return '활성 위임 기간 밖이라 외부 변경을 만들지 않습니다.';
    if (!mandate.actions.includes(action)) return `위임 범위에 '${action}' 동작이 없습니다.`;
    if (connectionId && !mandate.connectionIds.includes(connectionId)) return '위임에 포함되지 않은 계정입니다.';
    return null;
  }
  /** 모든 성장 쓰기의 유일한 출구. 결정적 요청 키로 재시작·중복 평가에서도 한 번만 큐에 넣는다. */
  /** safety는 신규 지출을 멈추거나 원래 값으로 되돌리는 보호 동작이다. 위임 기간이 끝나도 같은 계정 범위 안에서 허용한다. */
  private queueWrite(mandate: OperationMandate, action: MandateAction, connectionId: string, operation: string, input: Record<string, unknown>, identity: string, safety = false): Run {
    const denied = this.allows(mandate, action, connectionId);
    if (denied && !(safety && mandate.connectionIds.includes(connectionId))) throw new AppError('MANDATE_DENIED', denied, 403);
    const key = 'growth_' + sha(identity).slice(0, 64);
    return this.hooks.action(connectionId, { operation, projectId: mandate.projectId, input, idempotencyKey: key }, (run, reused) => {
      if (reused && this.store.requestKey(run.id) !== key) throw new AppError('PROVENANCE_CONFLICT', '다른 성장 의도로 예약한 동일 입력 작업이 있어 출처를 합치지 않았습니다.', 409);
      this.track(run, mandate.id, safety, undefined, reused);
    });
  }
  /** 성장 운영이 만든 외부 작업의 출처. 전송 직전 재검사와 중지·만료 시 미전송 작업 취소에 쓴다. */
  track(run: Run, mandateId: string, safety: boolean, responseId?: string, reused = false): void {
    const previous = this.store.document('growth-run', run.id);
    if (previous && (previous.mandateId !== mandateId || previous.safety !== safety || previous.responseId !== responseId) || !previous && reused)
      throw new AppError('PROVENANCE_CONFLICT', '기존 작업의 성장 출처가 다르거나 없습니다. 새 위임으로 덮어쓰지 않았습니다.', 409);
    if (!previous) this.store.putDocument('growth-run', run.id, { runId: run.id, mandateId, safety, source: mandateId ? 'mandate' : 'operator', ...(responseId ? { responseId } : {}), at: this.iso() });
  }
  /**
   * 큐가 외부 요청을 보내기 직전에 호출한다. 예약 뒤 위임이 중지·만료되거나 답글 대상이 수신 거부·삭제·승인 철회되면
   * 전송하지 않는다(효과는 prepared로 남아 중복 없이 종료된다). 보호 동작(중지·원복)은 위임이 끝나도 보낸다.
   */
  assertDispatch(run: Run): void {
    const link = this.store.document('growth-run', run.id);
    if (!link) {
      if (/^(growth_|reply_|recall_)/.test(this.store.requestKey(run.id) ?? '')) throw new AppError('PROVENANCE_REQUIRED', '성장 작업의 출처가 없어 전송하지 않았습니다.', 409);
      return;
    }
    const mandate = this.store.get<OperationMandate>('growth-mandate', link.mandateId);
    if (link.source !== 'operator' && (!mandate || mandate.projectId !== run.projectId || !mandate.connectionIds.includes(run.connectionId ?? ''))) throw new AppError('MANDATE_DENIED', '작업의 위임 출처와 프로젝트·계정이 일치하지 않습니다.', 403);
    if (!link.safety && link.source !== 'operator' && (!mandate || !this.active(mandate))) throw new AppError('MANDATE_DENIED', '위임이 중지·만료되었거나 자동화가 멈춰 예약된 외부 변경을 보내지 않았습니다.', 403);
    if (link.responseId && !link.safety) {
      const reasons = this.community.dispatchReasons(link.responseId, mandate);
      if (reasons.length) throw new AppError('PRESEND_BLOCKED', reasons.join(' '), 403);
    }
  }
  /** 전송 전(prepared) 작업만 취소한다. 이미 보낸 작업은 기존 큐가 결과를 확인한다. */
  private cancelPending(filter: (link: { mandateId: string; safety: boolean; responseId?: string }) => boolean): number {
    let cancelled = 0;
    for (const link of this.store.list<{ runId: string; mandateId: string; safety: boolean; responseId?: string }>('growth-run')) {
      if (!filter(link)) continue;
      const run = this.store.getRun(link.runId);
      if (!run || !['queued', 'retry_wait'].includes(run.status) || this.store.effectState(run.id) !== 'prepared') continue;
      try { this.hooks.cancel(run.id); cancelled++; } catch { /* 이미 진행 중이면 전송 직전 재검사가 막는다. */ }
    }
    return cancelled;
  }
  private queueRead(connectionId: string, projectId: string, operation: string, input: Record<string, unknown>): Run | undefined {
    const connection = this.store.get<Connection>('connection', connectionId);
    if (!connection || connection.status === 'disconnected' || !this.hooks.supported(connection.provider, operation)) return undefined;
    if (this.store.hasRuns({ connectionId, kinds: [operation], statuses: [...pending], input })) return undefined;
    return this.hooks.action(connectionId, { operation, projectId, input });
  }

  // ── 실험 ──────────────────────────────────────────────
  /**
   * 공급자 실험 목록에서 우리 arm(역할·캠페인)과 공급자 arm을 대응시킨다. 대조군 여부와 캠페인이 정확히 맞아야 하고,
   * 하나라도 맞지 않으면 null이다. 매핑 전에는 공급자 배정 fact를 arm에 붙일 수 없어 판정하지 않는다.
   */
  private mapProviderArms(connectionId: string, providerExperimentId: string, arms: ExperimentArm[]): ExperimentArm[] | null {
    const resource = this.store.list<ExternalResource>('resource').find(item => item.kind === 'experiment' && item.connectionId === connectionId && item.externalId === providerExperimentId);
    const provider = Array.isArray(resource?.data.arms) ? resource!.data.arms as Array<{ resourceName?: string; control?: boolean; campaigns?: string[] }> : [];
    if (!provider.length) return null;
    const mapped = arms.map(arm => {
      const match = provider.filter(item => Boolean(item.control) === (arm.role === 'control') && (item.campaigns ?? []).some(campaign => campaign === arm.campaignId || campaign.endsWith('/campaigns/' + arm.campaignId)));
      return match.length === 1 && match[0]!.resourceName ? { ...arm, externalId: match[0]!.resourceName } : null;
    });
    return mapped.every(Boolean) ? mapped as ExperimentArm[] : null;
  }
  private experiment(id: string): Experiment {
    const experiment = this.store.get<Experiment>('growth-experiment', id);
    if (!experiment) throw new AppError('NOT_FOUND', '실험을 찾을 수 없습니다.', 404);
    return experiment;
  }
  createExperiment(data: Record<string, unknown>): Experiment {
    const mandate = this.mandate(text(data.mandateId, '위임 ID', 100));
    if (!['proposed', 'active'].includes(mandate.status)) throw new AppError('MANDATE_DENIED', '진행 중인 위임에서만 실험을 준비할 수 있습니다.', 409);
    const policy = this.policy(mandate.projectId);
    const kind = ['ads', 'monetization', 'pricing', 'product'].includes(String(data.kind)) ? data.kind as Experiment['kind'] : undefined;
    if (!kind) throw new AppError('INVALID_INPUT', '실험 종류를 선택해 주세요.');
    const connectionId = text(data.connectionId, '실험 계정', 100);
    if (!mandate.connectionIds.includes(connectionId)) throw new AppError('MANDATE_DENIED', '위임에 포함된 계정에서만 실험할 수 있습니다.', 403);
    const connection = this.store.get<Connection>('connection', connectionId);
    if (!connection) throw new AppError('NOT_FOUND', '연결된 계정을 찾을 수 없습니다.', 404);
    const h = object(data.hypothesis);
    const primaryMetric = h.primaryMetric as MetricKey;
    if (!METRICS.includes(primaryMetric)) throw new AppError('INVALID_INPUT', '주 지표를 선택해 주세요.');
    const guardrails = Array.isArray(h.guardrails) ? h.guardrails.map(item => { const g = object(item);
      if (!METRICS.includes(g.metric as MetricKey) || !['min', 'max'].includes(String(g.direction))) throw new AppError('INVALID_INPUT', '보호 지표를 확인해 주세요.');
      return { metric: g.metric as MetricKey, direction: g.direction as 'min' | 'max', threshold: ratio(g.threshold, '보호 지표 기준', -1e9, 1e9) }; }) : [];
    const hypothesis: ExperimentHypothesis = {
      change: text(h.change, '주 변경', 500), cohort: text(h.cohort, '대상 집단', 300), primaryMetric,
      ...(h.revenueBasis ? { revenueBasis: BASES.includes(h.revenueBasis as RevenueBasis) ? h.revenueBasis as RevenueBasis : (() => { throw new AppError('INVALID_INPUT', '수익 기준을 확인해 주세요.'); })() } : {}),
      guardrails, minimumEffect: ratio(h.minimumEffect, '최소 실질 효과', 0.001, 10),
      attributionWindowDays: integer(h.attributionWindowDays, '귀속 창(일)', 0, 365),
      minDurationDays: integer(h.minDurationDays, '최소 관찰 기간(일)', 1, 365), maxDurationDays: integer(h.maxDurationDays, '최대 관찰 기간(일)', 1, 365),
      minSamplePerArm: integer(h.minSamplePerArm, 'arm별 최소 표본', 1, 1e9),
    };
    if (hypothesis.maxDurationDays < hypothesis.minDurationDays) throw new AppError('INVALID_INPUT', '최대 관찰 기간은 최소 관찰 기간 이상이어야 합니다.');
    if (!Array.isArray(data.arms) || data.arms.length < 2 || data.arms.length > 6) throw new AppError('INVALID_INPUT', '대조군 1개와 실험군 1~5개가 필요합니다.');
    const arms: ExperimentArm[] = data.arms.map((item, index) => { const arm = object(item);
      const role = arm.role === 'control' ? 'control' : arm.role === 'treatment' ? 'treatment' : (() => { throw new AppError('INVALID_INPUT', 'arm 역할을 확인해 주세요.'); })();
      return { id: arm.id ? text(arm.id, 'arm ID', 200) : `arm-${index + 1}`, role, label: text(arm.label, 'arm 이름', 100),
        ...(arm.externalId ? { externalId: text(arm.externalId, '공급자 arm ID', 300) } : {}), ...(arm.campaignId ? { campaignId: text(arm.campaignId, '캠페인 ID', 100) } : {}),
        ...(arm.trafficShare !== undefined ? { trafficShare: ratio(arm.trafficShare, '트래픽 비율', 0.01, 0.99) } : {}) }; });
    if (arms.filter(arm => arm.role === 'control').length !== 1) throw new AppError('INVALID_INPUT', '대조군은 정확히 1개여야 합니다.');
    if (new Set(arms.map(arm => arm.id)).size !== arms.length) throw new AppError('INVALID_INPUT', 'arm ID가 중복되었습니다.');
    const native = PROVIDER_WRITES[connection.provider] && data.design !== 'observational_comparison';
    if (native && data.providerExperimentId && connection.provider === 'google-ads') {
      const mapped = this.mapProviderArms(connectionId, text(data.providerExperimentId, '공급자 실험 ID', 300), arms);
      if (!mapped) throw new AppError('EXPERIMENT_SYNC_REQUIRED', '지정한 공급자 실험을 목록에서 찾지 못했거나 arm의 대조군·캠페인이 일치하지 않습니다. 실험 목록을 동기화한 뒤 다시 확인해 주세요.', 409);
      arms.splice(0, arms.length, ...mapped);
    }
    const stoppingKind = data.stopping ? object(data.stopping).kind : policy.defaultStopping;
    let stopping: StoppingRule;
    if (stoppingKind === 'sequential') {
      const looks = Array.isArray(object(data.stopping ?? {}).looks) ? (object(data.stopping).looks as unknown[]).map(item => iso(item, 'look 시각')) : [];
      if (looks.length < 2 || looks.length > 10) throw new AppError('INVALID_INPUT', '순차 검정은 2~10개의 look 시각을 사전 등록해야 합니다.');
      if (looks.some((item, index) => index && Date.parse(item) <= Date.parse(looks[index - 1]!))) throw new AppError('INVALID_INPUT', 'look 시각은 증가하는 순서여야 합니다.');
      const spending = object(data.stopping ?? {}).spending === 'pocock' ? 'pocock' : 'obrien_fleming';
      stopping = { kind: 'sequential', looks, spending };
    } else stopping = { kind: 'fixed_horizon' };
    if (this.store.list<Experiment>('growth-experiment').some(item => item.connectionId === connectionId && item.kind === kind && ['scheduled', 'exploring', 'observing', 'evaluating', 'winner_scaling'].includes(item.status)
      && item.arms.some(arm => arms.some(candidate => candidate.campaignId && candidate.campaignId === arm.campaignId)))) throw new AppError('EXPERIMENT_CONFLICT', '같은 캠페인을 사용하는 실험이 이미 진행 중입니다.', 409);
    const experiment: Experiment = {
      id: randomUUID(), projectId: mandate.projectId, mandateId: mandate.id, version: 1, kind, provider: connection.provider, connectionId,
      ...(data.providerExperimentId ? { providerExperimentId: text(data.providerExperimentId, '공급자 실험 ID', 300) } : {}),
      design: native ? 'native_ab' : 'observational_comparison', hypothesis, stopping, alpha: policy.alpha, multiplicity: policy.multiplicity,
      arms, status: 'draft', looksUsed: 0, runIds: [], policyVersion: policy.version, createdAt: this.iso(), updatedAt: this.iso(),
      ...(data.supersedes ? { supersedes: text(data.supersedes, '이전 실험 ID', 100) } : {}),
      ...(data.providerConfig ? { providerConfig: object(data.providerConfig) } : {}),
    };
    if (!native) experiment.statusReason = '공급자가 무작위 대조군 배정을 보장하지 않아 관찰 비교로만 기록합니다. 승자 자동 확대는 하지 않습니다.';
    this.store.writeBatch([{ kind: 'growth-experiment', id: experiment.id, value: experiment }], [], [{ projectId: experiment.projectId, kind: 'growth.experiment.draft', message: '실험 가설을 준비했습니다. 사전 등록 후 변경할 수 없습니다.', data: { experimentId: experiment.id, design: experiment.design } }]);
    return experiment;
  }
  private saveExperiment(previous: Experiment, next: Partial<Experiment>, event?: Parameters<Store['addEvent']>[0], extra: { kind: 'growth-decision'; id: string; value: unknown }[] = []): Experiment {
    const current = this.experiment(previous.id);
    if (current.version !== previous.version) throw new AppError('STALE_EXPERIMENT', '실험 상태가 동시에 바뀌었습니다. 최신 상태를 확인해 주세요.', 409);
    const value: Experiment = { ...current, ...next, version: current.version + 1, updatedAt: this.iso() };
    this.store.writeBatch([{ kind: 'growth-experiment', id: value.id, value }, ...extra], [], event ? [event] : []);
    return value;
  }
  registerExperiment(id: string, version: number): Experiment {
    const experiment = this.experiment(id);
    if (experiment.version !== version || experiment.status !== 'draft') throw new AppError('STALE_EXPERIMENT', '초안 상태의 최신 실험만 사전 등록할 수 있습니다.', 409);
    const mandate = this.mandate(experiment.mandateId);
    if (mandate.status !== 'active') throw new AppError('MANDATE_DENIED', '확정된 위임에서만 실험을 등록할 수 있습니다.', 409);
    const start = Math.max(this.clock(), Date.parse(mandate.startsAt));
    const horizon = start + (experiment.hypothesis.minDurationDays + experiment.hypothesis.attributionWindowDays) * 86_400_000;
    const maxEnd = start + (experiment.hypothesis.maxDurationDays + experiment.hypothesis.attributionWindowDays) * 86_400_000;
    if (maxEnd > Date.parse(mandate.endsAt)) throw new AppError('MANDATE_PERIOD', '실험의 최대 관찰 기간과 귀속 창이 위임 기간 안에 끝나야 합니다.', 409);
    if (experiment.stopping.kind === 'sequential' && (Date.parse(experiment.stopping.looks[0]!) < horizon - experiment.hypothesis.attributionWindowDays * 86_400_000 || Date.parse(experiment.stopping.looks.at(-1)!) > maxEnd)) {
      throw new AppError('INVALID_INPUT', '순차 검정 look은 최소 관찰 기간 이후, 최대 기간 이전이어야 합니다.');
    }
    const capability = this.store.get<ProviderExperimentCapability>('growth-capability', experiment.connectionId + ':' + (experiment.provider === 'applovin-max' ? 'max_ad_unit_experiment' : 'ads_native_experiment'));
    const nativeReady = experiment.design !== 'native_ab' || Boolean(experiment.providerExperimentId) || ['test_write', 'write'].includes(capability?.level ?? '');
    return this.saveExperiment(experiment, { registeredAt: this.iso(), horizonAt: new Date(horizon).toISOString(), status: nativeReady ? 'scheduled' : 'validating',
      statusReason: nativeReady ? experiment.statusReason : '공급자 실험 쓰기 기능을 확인 중입니다. 확인 전에는 외부 실험을 만들지 않습니다.' },
    { projectId: experiment.projectId, kind: 'growth.experiment.registered', message: '실험을 사전 등록했습니다. 가설·주 지표·중지 규칙은 이제 고정됩니다.', data: { experimentId: id, horizonAt: new Date(horizon).toISOString() } });
  }
  startExperiment(id: string): Experiment {
    return this.store.transaction(() => {
      const experiment = this.experiment(id);
      if (experiment.status !== 'scheduled') throw new AppError('INVALID_STATE', '사전 등록을 마친 실험만 시작할 수 있습니다.', 409);
      const mandate = this.mandate(experiment.mandateId);
      const writes = PROVIDER_WRITES[experiment.provider];
      if (experiment.design === 'native_ab' && !experiment.providerExperimentId && writes) {
        const run = this.queueWrite(mandate, writes.action, experiment.connectionId, writes.create, this.createInput(experiment), 'create:' + experiment.id);
        return this.saveExperiment(experiment, { status: 'exploring', startedAt: this.iso(), runIds: [...new Set([...experiment.runIds, run.id])] },
          { projectId: experiment.projectId, kind: 'growth.experiment.start', message: '공급자 실험 생성을 큐에 넣었습니다.', data: { experimentId: id, runId: run.id } });
      }
      const denied = this.allows(mandate, 'observe');
      if (denied) throw new AppError('MANDATE_DENIED', denied, 403);
      return this.saveExperiment(experiment, { status: 'observing', startedAt: this.iso() }, { projectId: experiment.projectId, kind: 'growth.experiment.start', message: experiment.design === 'native_ab' ? '기존 공급자 실험의 관찰을 시작했습니다.' : '관찰 비교를 시작했습니다.', data: { experimentId: id } });
    });
  }
  /** 공급자 커넥터의 생성 입력. 요청 키는 실험 ID라 응답 유실 뒤에도 같은 이름으로 찾아 재사용한다. */
  private createInput(experiment: Experiment): Record<string, unknown> {
    const control = experiment.arms.find(arm => arm.role === 'control')!;
    const treatments = experiment.arms.filter(arm => arm.role === 'treatment');
    if (experiment.provider === 'applovin-max') {
      const share = treatments[0]?.trafficShare;
      return { ...experiment.providerConfig, adUnitId: control.externalId ?? control.campaignId, experimentName: 'appops-' + experiment.id.slice(0, 8), ...(share ? { testGroupAllocation: Math.round(share * 100) } : {}) };
    }
    if (treatments.length !== 1) throw new AppError('INVALID_INPUT', 'Google Ads Campaign Mix 실험은 실험군 캠페인 1개만 지원합니다.');
    return { name: 'appops-' + experiment.id.slice(0, 8), requestKey: experiment.id, description: experiment.hypothesis.change.slice(0, 200), controlCampaignId: control.campaignId, treatmentCampaignId: treatments[0]!.campaignId,
      controlTrafficSplit: Math.round((control.trafficShare ?? 1 - (treatments[0]!.trafficShare ?? 0.5)) * 100), schedule: true,
      startDate: new Date(this.clock() + 86_400_000).toISOString().slice(0, 10), endDate: new Date(this.clock() + (experiment.hypothesis.maxDurationDays + 1) * 86_400_000).toISOString().slice(0, 10) };
  }
  private endInput(experiment: Experiment): Record<string, unknown> {
    return experiment.provider === 'applovin-max' ? { adUnitId: experiment.arms.find(arm => arm.role === 'control')?.externalId, experimentName: experiment.providerExperimentId } : { experimentId: experiment.providerExperimentId };
  }
  /** 조치 필요 실험을 운영자가 공급자 상태를 확인한 뒤 관찰로 되돌린다. 무효화된 승자는 자동 재확대하지 않고 관찰만 재개한다. */
  resumeExperiment(id: string, note: string): Experiment {
    const experiment = this.experiment(id);
    if (experiment.status !== 'action_required') throw new AppError('INVALID_STATE', '조치가 필요한 실험만 재개할 수 있습니다.', 409);
    if (note.length < 5) throw new AppError('INVALID_INPUT', '공급자에서 확인한 내용을 기록해 주세요.');
    if (experiment.design === 'native_ab' && !experiment.providerExperimentId) throw new AppError('INVALID_STATE', '공급자 실험 ID가 확인되지 않아 재개할 수 없습니다. 실험 목록을 동기화해 주세요.', 409);
    const denied = this.allows(this.mandate(experiment.mandateId), 'observe');
    if (denied) throw new AppError('MANDATE_DENIED', denied, 403);
    return this.saveExperiment(experiment, { status: 'observing', winnerDecisionId: undefined, statusReason: '운영자 확인 후 관찰 재개: ' + note },
      { projectId: experiment.projectId, kind: 'growth.experiment.resumed', message: '운영자 확인 후 실험 관찰을 재개했습니다.', data: { experimentId: id } });
  }
  stopExperiment(id: string, reason: string): Experiment {
    return this.store.transaction(() => {
      const experiment = this.experiment(id);
      if (['completed', 'inconclusive', 'stopped', 'failed'].includes(experiment.status)) return experiment;
      const runs = this.stopWrites(experiment, this.mandate(experiment.mandateId), 'manual-stop');
      return this.saveExperiment(experiment, { status: 'stopped', statusReason: reason, runIds: [...new Set([...experiment.runIds, ...runs])] },
        { projectId: experiment.projectId, kind: 'growth.experiment.stopped', message: '실험을 중지했습니다: ' + reason, level: 'warning', data: { experimentId: id } });
    });
  }
  /** 중지는 예산 초과·위임 만료 뒤에도 허용한다(신규 지출을 멈추는 방향). */
  private stopWrites(experiment: Experiment, mandate: OperationMandate, reason: string): string[] {
    const ids: string[] = [];
    const stop = planStop({ mandate, now: new Date(this.clock()) });
    if (!stop.allowed) return ids;
    const writes = PROVIDER_WRITES[experiment.provider];
    try {
      if (experiment.design === 'native_ab' && experiment.providerExperimentId && writes && ['exploring', 'observing', 'evaluating', 'winner_scaling'].includes(experiment.status))
        ids.push(this.queueWrite(mandate, 'ads-stop', experiment.connectionId, writes.end, this.endInput(experiment), 'end:' + experiment.id, true).id);
      if (experiment.kind === 'ads') for (const arm of experiment.arms.filter(item => item.role === 'treatment' && item.campaignId))
        ids.push(this.queueWrite(mandate, 'ads-stop', experiment.connectionId, 'pause-campaign', { externalId: arm.campaignId }, `pause:${experiment.id}:${arm.id}:${reason}`, true).id);
    } catch (error) {
      this.store.addEvent({ projectId: experiment.projectId, kind: 'growth.stop_waiting', message: error instanceof AppError ? error.message : '실험 중지 작업을 예약하지 못했습니다.', level: 'warning', data: { experimentId: experiment.id } });
    }
    return ids;
  }

  // ── 스케줄러 ──────────────────────────────────────────
  cycle(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runCycle().catch(error => {
      try { this.store.addEvent({ kind: 'growth.cycle_error', message: error instanceof Error ? error.message : '성장 운영 주기를 실행하지 못했습니다.', level: 'warning' }); } catch { /* 소유권이 바뀐 경우 */ }
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async stop(): Promise<void> { this.abort.abort(); await this.running?.catch(() => {}); this.abort = new AbortController(); }
  private async runCycle(): Promise<void> {
    const at = this.clock();
    this.syncRuns();
    this.community.refreshProductLinks();
    for (const mandate of this.store.list<OperationMandate>('growth-mandate')) {
      if (this.abort.signal.aborted) return;
      if (mandate.status !== 'active') continue;
      if (at >= Date.parse(mandate.endsAt)) { this.expire(mandate); continue; }
      if (this.store.get('settings', 'growth-paused') || this.store.get('settings', 'device-transferred') || at < Date.parse(mandate.startsAt) || (mandate.nextDueAt && at < Date.parse(mandate.nextDueAt))) continue;
      await this.runMandate(mandate);
    }
    // 만료·중지된 위임의 이미 보낸 답글·실험 작업은 결과만 반영한다(새 effect 없음).
    this.community.syncResponses();
    // 가격 관찰과 guardrail 원복은 위임이 끝난 뒤에도 고객 보호를 위해 계속한다. 복원 직후에는 멈춘다.
    if (!this.store.get('settings', 'growth-paused')) for (const projectId of new Set(this.store.list<PricingChange>('pricing-change').map(item => item.projectId))) this.pricing.cycle(projectId);
  }
  private expire(mandate: OperationMandate): void {
    const value: OperationMandate = { ...mandate, status: 'expired', version: mandate.version + 1, updatedAt: this.iso() };
    this.cancelPending(link => link.mandateId === mandate.id && !link.safety);
    this.store.writeBatch([{ kind: 'growth-mandate', id: mandate.id, value }], [], [{ projectId: mandate.projectId, kind: 'growth.mandate.expired', message: '위임 기간이 끝나 새 평가·외부 변경을 멈췄습니다. 이미 보낸 작업의 결과 확인만 계속합니다.', level: 'warning', data: { mandateId: mandate.id } }]);
  }
  async runMandateNow(id: string): Promise<OperationMandate> {
    const mandate = this.mandate(id);
    if (!this.active(mandate)) throw new AppError('MANDATE_DENIED', '활성 위임 기간 안에서만 주기 작업을 실행합니다.', 409);
    // 스케줄러 주기와 겹치면 같은 항목을 두 번 분류하거나 실험 상태가 충돌한다. 진행 중이면 다음 주기를 기다린다.
    if (this.running) throw new AppError('GROWTH_BUSY', '성장 운영 주기가 이미 실행 중입니다. 끝난 뒤 다시 실행해 주세요.', 409);
    this.running = this.runMandate(mandate).finally(() => { this.running = undefined; });
    await this.running;
    return this.mandate(id);
  }
  private async runMandate(mandate: OperationMandate): Promise<void> {
    const cycle: GrowthCycleState = { ...this.store.get<GrowthCycleState>('growth-cycle', mandate.id) ?? { mandateId: mandate.id, watermarks: {}, blockers: [] }, blockers: [] };
    try {
      this.store.transaction(() => {
        this.observe(mandate, cycle);
        this.experiments(mandate, cycle);
        if (mandate.actions.includes('ads-stop') || mandate.actions.includes('ads-rebalance')) this.campaignRules(mandate, cycle);
        this.store.put('growth-cycle', mandate.id, cycle);
      });
      if (mandate.actions.includes('community-draft') || mandate.actions.includes('community-reply') || mandate.actions.includes('feedback-triage')) await this.community.cycle(mandate, cycle);
      delete cycle.lastError;
    } catch (error) {
      cycle.watermarks = this.store.get<GrowthCycleState>('growth-cycle', mandate.id)?.watermarks ?? {};
      cycle.lastError = error instanceof Error ? error.message : '성장 주기 실행에 실패했습니다.';
      this.store.addEvent({ projectId: mandate.projectId, kind: 'growth.cycle_error', message: cycle.lastError, level: 'warning', data: { mandateId: mandate.id } });
    }
    const at = new Date(this.clock());
    const next = new Date(at.getTime() + mandate.cadenceMinutes * 60_000).toISOString();
    const current = this.mandate(mandate.id);
    this.store.writeBatch([
      { kind: 'growth-cycle', id: mandate.id, value: { ...cycle, lastRunAt: at.toISOString(), nextDueAt: next } },
      ...(current.status === 'active' ? [{ kind: 'growth-mandate' as const, id: mandate.id, value: { ...current, lastCycleAt: at.toISOString(), nextDueAt: next } }] : []),
    ]);
  }
  private observe(mandate: OperationMandate, cycle: GrowthCycleState): void {
    // 생성 응답이 유실된 실험은 목록 동기화로 결정적 이름을 찾아 확인한다. 다시 생성하지 않는다.
    for (const experiment of this.store.list<Experiment>('growth-experiment').filter(item => item.mandateId === mandate.id && item.provider === 'google-ads' && ((item.status === 'exploring' && !item.providerExperimentId) || (item.providerExperimentId && item.arms.some(arm => !arm.externalId) && ['observing', 'evaluating'].includes(item.status)))))
      this.queueRead(experiment.connectionId, experiment.projectId, 'list-experiments', {});
    for (const connectionId of mandate.connectionIds) {
      const connection = this.store.get<Connection>('connection', connectionId);
      if (!connection) { cycle.blockers.push('위임한 계정 연결이 해제되었습니다.'); continue; }
      if (!['connected', 'unverified', 'recovering'].includes(connection.status)) { cycle.blockers.push(`${connection.label}: 계정 연결 확인이 필요합니다.`); continue; }
      const probe = connection.provider === 'google-ads' ? 'probe-experiments' : connection.provider === 'applovin-max' ? 'probe-ad-unit-experiments' : undefined;
      const key = 'probe:' + connectionId;
      if (probe && this.clock() - Date.parse(cycle.watermarks[key] ?? '1970-01-01') > 86_400_000 && this.queueRead(connectionId, mandate.projectId, probe, {})) cycle.watermarks[key] = this.iso();
    }
    for (const experiment of this.store.list<Experiment>('growth-experiment').filter(item => item.mandateId === mandate.id && item.providerExperimentId && ['exploring', 'observing', 'evaluating', 'winner_scaling'].includes(item.status))) {
      const key = 'metrics:' + experiment.id;
      if (this.clock() - Date.parse(cycle.watermarks[key] ?? '1970-01-01') < 3_600_000) continue;
      const startDate = (experiment.startedAt ?? experiment.createdAt).slice(0, 10);
      const operation = experiment.provider === 'google-ads' ? 'experiment-metrics' : experiment.provider === 'applovin-max' ? 'list-ad-unit-experiments' : undefined;
      if (!operation) continue;
      const input = experiment.provider === 'google-ads' ? { experimentId: experiment.providerExperimentId, startDate, endDate: new Date(this.clock()).toISOString().slice(0, 10), attributionWindowDays: experiment.hypothesis.attributionWindowDays }
        : { adUnitId: experiment.arms.find(arm => arm.role === 'control')?.externalId };
      if (this.queueRead(experiment.connectionId, experiment.projectId, operation, input)) cycle.watermarks[key] = this.iso();
    }
  }
  /** 큐 작업 결과를 실험 상태와 capability에 반영한다. 응답 유실 시에는 실험 목록 동기화 결과로 확인한다. */
  private syncRuns(): void {
    const runs = this.store.findRuns({ kinds: ['probe-experiments', 'probe-ad-unit-experiments'], statuses: ['succeeded'] });
    for (const kind of ['probe-experiments', 'probe-ad-unit-experiments'] as const) {
      const capabilityKind = kind === 'probe-experiments' ? 'ads_native_experiment' : 'max_ad_unit_experiment';
      const latest = new Map<string, Run>();
      for (const run of runs) if (run.kind === kind && run.status === 'succeeded' && run.connectionId && !latest.has(run.connectionId)) latest.set(run.connectionId, run);
      for (const [connectionId, run] of latest) {
        const capability = run.result?.capability as Partial<ProviderExperimentCapability> | undefined;
        const id = connectionId + ':' + capabilityKind;
        const stored = this.store.get<ProviderExperimentCapability>('growth-capability', id);
        const connection = this.store.get<Connection>('connection', connectionId);
        if (!capability || !connection || (stored && stored.checkedAt >= (run.finishedAt ?? run.updatedAt))) continue;
        const level = capability.level ?? 'unsupported';
        // 운영자가 검증한 쓰기 수준은 조회가 계속 가능한 동안 유지하고, 조회 권한을 잃으면 바로 낮춘다.
        const keep = stored && ['test_write', 'write'].includes(stored.level) && level === 'read';
        this.store.put('growth-capability', id, keep ? { ...stored, checkedAt: run.finishedAt ?? run.updatedAt } : { connectionId, provider: connection.provider, kind: capabilityKind, level,
          reasons: Array.isArray(capability.reasons) ? capability.reasons.map(String) : [], checkedAt: run.finishedAt ?? run.updatedAt, verification: capability.verification ?? 'fixture' } satisfies ProviderExperimentCapability);
      }
    }
    const resources = this.store.list<ExternalResource>('resource').filter(item => item.kind === 'experiment');
    for (const experiment of this.store.list<Experiment>('growth-experiment').filter(item => ['exploring', 'winner_scaling'].includes(item.status))) {
      const writes = PROVIDER_WRITES[experiment.provider];
      for (const run of experiment.runIds.map(id => this.store.getRun(id)).filter((item): item is Run => Boolean(item))) {
        if (run.kind === writes?.create && experiment.status === 'exploring' && !experiment.providerExperimentId) {
          const listed = resources.find(item => item.connectionId === experiment.connectionId && (item.name.endsWith(`[gso:${experiment.id}]`) || item.name === 'appops-' + experiment.id.slice(0, 8)));
          const externalId = ['succeeded', 'waiting_external'].includes(run.status) ? run.result?.experimentId ?? run.result?.experimentName ?? listed?.externalId : listed?.externalId;
          if (externalId) this.saveExperiment(experiment, { providerExperimentId: String(externalId), status: 'observing' }, { projectId: experiment.projectId, kind: 'growth.experiment.created', message: '공급자 실험 생성을 확인해 관찰을 시작합니다.', data: { experimentId: experiment.id } });
          else if (run.status === 'failed') this.saveExperiment(experiment, { status: 'failed', statusReason: run.error ?? '공급자가 실험 생성을 거절했습니다.' });
          else if (run.status === 'action_required') this.saveExperiment(experiment, { status: 'action_required', statusReason: run.error ?? '공급자 실험 생성 결과를 확인해야 합니다. 중복 생성을 막기 위해 다시 보내지 않았습니다.' });
        } else if (run.kind === writes?.promote && experiment.status === 'winner_scaling' && run.status === 'succeeded' && experiment.kind !== 'ads') {
          this.saveExperiment(experiment, { status: 'completed', statusReason: '승자 적용을 공급자에서 확인했습니다.' }, { projectId: experiment.projectId, kind: 'growth.experiment.completed', message: '승자 적용을 확인하고 실험을 마쳤습니다.', data: { experimentId: experiment.id } });
        }
      }
    }
  }
  private experiments(mandate: OperationMandate, cycle: GrowthCycleState): void {
    const policy = this.policy(mandate.projectId);
    const all = this.store.list<AttributionFact>('attribution-fact').filter(fact => fact.projectId === mandate.projectId);
    const fx = this.store.list<FxSnapshot>('fx-snapshot');
    for (let experiment of this.store.list<Experiment>('growth-experiment').filter(item => item.mandateId === mandate.id)) {
      if (this.abort.signal.aborted) return;
      if (experiment.status === 'validating') {
        const capability = this.store.get<ProviderExperimentCapability>('growth-capability', experiment.connectionId + ':' + (experiment.provider === 'applovin-max' ? 'max_ad_unit_experiment' : 'ads_native_experiment'));
        if (capability && ['test_write', 'write'].includes(capability.level)) experiment = this.saveExperiment(experiment, { status: 'scheduled', statusReason: undefined });
        else if (capability && ['unsupported', 'action_required'].includes(capability.level)) { this.saveExperiment(experiment, { status: 'action_required', statusReason: 'native 실험을 사용할 수 없습니다: ' + capability.reasons.join(' ') + ' 관찰 비교로 새 실험을 만들어야 합니다.' }); continue; }
        else { cycle.blockers.push('공급자 실험 기능 확인을 기다립니다.'); continue; }
      }
      if (experiment.status === 'completed') { this.checkInvalidation(experiment, all, policy, mandate, fx); continue; }
      if (!['observing', 'evaluating', 'winner_scaling'].includes(experiment.status)) continue;
      if (experiment.design === 'native_ab' && experiment.provider === 'google-ads' && experiment.providerExperimentId && experiment.arms.some(arm => !arm.externalId)) {
        const mapped = this.mapProviderArms(experiment.connectionId, experiment.providerExperimentId, experiment.arms);
        if (!mapped) { cycle.blockers.push('공급자 실험 arm과 대조군·캠페인 매핑을 확인하는 중입니다. 매핑 전에는 판정하지 않습니다.'); continue; }
        experiment = this.saveExperiment(experiment, { arms: mapped });
      }
      const facts = this.scopedFacts(experiment, all);
      const decision = evaluateExperiment({ experiment, facts, policy, mandate, fx, now: new Date(this.clock()), agentTaskId: mandate.origin.agentTaskId });
      if (this.store.get('growth-decision', decision.id)) continue;
      // 내용이 같은 주기 점검 스냅샷은 다시 쌓지 않는다(판정·효능·중지 결정은 모두 보존).
      const last = experiment.lastDecisionId ? this.store.get<DecisionSnapshot>('growth-decision', experiment.lastDecisionId) : undefined;
      if (decision.kind === 'quality_check' && last?.kind === 'quality_check' && last.outcome === decision.outcome && last.policyVersion === decision.policyVersion
        && last.factIds.join() === decision.factIds.join() && last.reasons.join() === decision.reasons.join()) continue;
      const event = { projectId: experiment.projectId, kind: 'growth.decision', message: `실험 판단: ${decision.outcome}. ${decision.reasons.slice(0, 2).join(' ')}`, level: ['stop_guardrail', 'stop_loss', 'invalidated'].includes(decision.outcome) ? 'warning' as const : 'info' as const, data: { experimentId: experiment.id, decisionId: decision.id } };
      const record = [{ kind: 'growth-decision' as const, id: decision.id, value: decision }];
      if (decision.outcome === 'stop_guardrail' || decision.outcome === 'stop_loss') {
        const runs = this.stopWrites(experiment, mandate, decision.outcome);
        this.saveExperiment(experiment, { lastDecisionId: decision.id, status: 'stopped', statusReason: decision.reasons.join(' '), runIds: [...new Set([...experiment.runIds, ...runs])] }, event, record);
        continue;
      }
      if (experiment.status === 'winner_scaling') { this.continueScaling(experiment, mandate, decision, cycle, record); continue; }
      const consumed = decision.kind === 'efficacy';
      const base: Partial<Experiment> = { lastDecisionId: decision.id, looksUsed: experiment.looksUsed + (consumed ? 1 : 0) };
      if (decision.outcome === 'winner') {
        const runs = this.scaleWinner(experiment, mandate, decision, cycle, true);
        this.saveExperiment(experiment, { ...base, winnerDecisionId: decision.id, status: runs.length ? 'winner_scaling' : 'completed', statusReason: runs.length ? '승자를 한 단계씩 확대하며 다시 관찰합니다.' : '승자를 확인했습니다. 위임 범위에 확대 동작이 없거나 한도에 도달해 기록만 했습니다.', runIds: [...new Set([...experiment.runIds, ...runs])] }, event, record);
      } else if (decision.outcome === 'no_effect' || decision.outcome === 'inconclusive') {
        this.saveExperiment(experiment, { ...base, status: decision.outcome === 'no_effect' ? 'completed' : 'inconclusive', statusReason: decision.reasons.join(' ') }, event, record);
      } else {
        this.saveExperiment(experiment, { ...base, status: consumed ? 'evaluating' : 'observing' }, consumed || decision.outcome === 'blocked' ? event : undefined, record);
        if (decision.outcome === 'blocked') cycle.blockers.push(...decision.reasons.slice(0, 3));
      }
    }
  }
  /** 승자 확대 단계: 매 주기 guardrail을 다시 보고, cooldown 뒤 최신 데이터 품질로 다음 한 단계를 계획한다. 한도에 닿으면 완료한다. */
  private continueScaling(experiment: Experiment, mandate: OperationMandate, check: DecisionSnapshot, cycle: GrowthCycleState, record: { kind: 'growth-decision'; id: string; value: unknown }[]): void {
    const winner = experiment.winnerDecisionId ? this.store.get<DecisionSnapshot>('growth-decision', experiment.winnerDecisionId) : undefined;
    const writes = PROVIDER_WRITES[experiment.provider];
    const promotePending = experiment.runIds.some(id => { const run = this.store.getRun(id); return Boolean(run && run.kind === writes?.promote && !['succeeded', 'failed', 'cancelled'].includes(run.status)); });
    if (!winner) { this.saveExperiment(experiment, { lastDecisionId: check.id, status: 'action_required', statusReason: '승자 결정 기록을 찾을 수 없어 확대를 멈췄습니다.' }, undefined, record); return; }
    const runs = this.scaleWinner(experiment, mandate, { ...winner, quality: check.quality }, cycle, false);
    const reasons = cycle.blockers.filter(reason => reason.includes('한도') || reason.includes('위임'));
    const done = !runs.length && !promotePending && (reasons.length > 0 || experiment.kind !== 'ads');
    this.saveExperiment(experiment, { lastDecisionId: check.id, runIds: [...new Set([...experiment.runIds, ...runs])], ...(done ? { status: 'completed' as const, statusReason: '승자 확대를 마쳤습니다: ' + (reasons[0] ?? '공급자 적용을 확인했습니다.') } : {}) },
      runs.length || done ? { projectId: experiment.projectId, kind: done ? 'growth.experiment.completed' : 'growth.scale', message: done ? '승자 확대를 마쳤습니다.' : '승자 예산을 한 단계 더 올렸습니다.', data: { experimentId: experiment.id } } : undefined, record);
  }
  /** 이상 성과 중지와 총액 유지 재배분. 감액을 먼저 보내고, 증액은 감액이 공급자에서 확인된 뒤 보낸다. */
  private campaignRules(mandate: OperationMandate, cycle: GrowthCycleState): void {
    const policy = this.policy(mandate.projectId);
    const campaigns = this.store.list<ExternalResource>('resource').filter(item => item.kind === 'campaign' && item.projectId === mandate.projectId && mandate.connectionIds.includes(item.connectionId));
    const experimentCampaigns = new Set(this.store.list<Experiment>('growth-experiment').filter(item => !['completed', 'inconclusive', 'stopped', 'failed'].includes(item.status)).flatMap(item => item.arms.map(arm => item.connectionId + ':' + arm.campaignId)));
    // 진행 중 실험의 arm 캠페인은 실험 규칙이 관리한다. 운영 규칙이 예산을 바꾸면 실험 비교가 오염된다.
    const managed = campaigns.filter(item => !experimentCampaigns.has(item.connectionId + ':' + item.externalId));
    for (const [key, value] of Object.entries(cycle.watermarks).filter(([key]) => key.startsWith('pending-increase:'))) {
      const [runId, budget] = value.split('|');
      const [, connectionId, campaignId] = key.split(':');
      const run = this.store.getRun(runId!);
      if (!run || ['failed', 'cancelled', 'action_required'].includes(run.status)) { delete cycle.watermarks[key]; cycle.blockers.push('예산 재배분 감액이 확인되지 않아 증액을 보내지 않았습니다.'); continue; }
      if (run.status !== 'succeeded') continue;
      try {
        this.queueWrite(mandate, 'ads-rebalance', connectionId!, 'update-campaign', { externalId: campaignId, dailyBudgetMicros: budget, currency: mandate.limits.currency }, `rebalance-up:${runId}`);
        cycle.watermarks['budget-change:' + connectionId + ':' + campaignId] = this.iso(); delete cycle.watermarks[key];
      } catch (error) { cycle.blockers.push(error instanceof AppError ? error.message : '재배분 증액을 예약하지 못했습니다.'); }
    }
    const goal = mandate.goals.roas;
    const performance = campaignPerformance({ campaigns: managed, facts: this.store.list<AttributionFact>('attribution-fact').filter(fact => fact.projectId === mandate.projectId), policy, now: new Date(this.clock()),
      windowDays: goal?.windowDays ?? 0, basis: goal?.basis ?? 'gross_conversion_value', lookbackDays: 14 });
    const lastChangeAt = Object.fromEntries(Object.entries(cycle.watermarks).filter(([key]) => key.startsWith('budget-change:')).map(([key, value]) => [key.slice('budget-change:'.length), value]));
    const plan = planCampaignRules({ mandate, performance, lastChangeAt, now: new Date(this.clock()) });
    cycle.blockers.push(...plan.blockers.slice(0, 5));
    for (const stop of plan.stops) {
      try { this.queueWrite(mandate, 'ads-stop', stop.connectionId, 'pause-campaign', { externalId: stop.campaignId }, `rule-stop:${mandate.id}:${stop.connectionId}:${stop.campaignId}:${this.iso().slice(0, 10)}`, true);
        this.store.addEvent({ projectId: mandate.projectId, kind: 'growth.campaign_stop', message: '성과 규칙으로 캠페인 중지를 예약했습니다: ' + stop.reason, level: 'warning', data: { campaignId: stop.campaignId } }); }
      catch (error) { cycle.blockers.push(error instanceof AppError ? error.message : '캠페인 중지를 예약하지 못했습니다.'); }
    }
    for (const move of plan.moves) {
      if (Object.keys(cycle.watermarks).some(key => key.startsWith('pending-increase:'))) break;
      try {
        const down = this.queueWrite(mandate, 'ads-rebalance', move.from.connectionId, 'update-campaign', { externalId: move.from.campaignId, dailyBudgetMicros: move.fromBudgetMicros, currency: mandate.limits.currency }, `rebalance-down:${mandate.id}:${move.from.campaignId}:${move.fromBudgetMicros}:${this.iso().slice(0, 13)}`);
        cycle.watermarks['budget-change:' + move.from.connectionId + ':' + move.from.campaignId] = this.iso();
        cycle.watermarks[`pending-increase:${move.to.connectionId}:${move.to.campaignId}`] = down.id + '|' + move.toBudgetMicros;
        this.store.addEvent({ projectId: mandate.projectId, kind: 'growth.rebalance', message: move.reason, data: { from: move.from.campaignId, to: move.to.campaignId } });
      } catch (error) { cycle.blockers.push(error instanceof AppError ? error.message : '예산 재배분을 예약하지 못했습니다.'); }
    }
  }
  private scaleWinner(experiment: Experiment, mandate: OperationMandate, decision: DecisionSnapshot, cycle: GrowthCycleState, promote: boolean): string[] {
    if (experiment.design !== 'native_ab') return [];
    const writes = PROVIDER_WRITES[experiment.provider];
    const runs: string[] = [];
    const scaleAction: MandateAction = experiment.provider === 'applovin-max' ? 'max-experiment' : 'ads-scale';
    const denied = this.allows(mandate, scaleAction, experiment.connectionId);
    if (denied) { cycle.blockers.push(denied); return runs; }
    if (promote && writes?.promote && experiment.providerExperimentId) runs.push(this.queueWrite(mandate, scaleAction, experiment.connectionId, writes.promote, this.endInput(experiment), 'promote:' + experiment.id).id);
    const winner = experiment.arms.find(arm => arm.id === decision.winnerArmId);
    if (experiment.kind !== 'ads' || !winner?.campaignId) return runs;
    const campaign = this.store.list<ExternalResource>('resource').find(item => item.kind === 'campaign' && item.connectionId === experiment.connectionId && item.externalId === winner.campaignId);
    if (!campaign) { cycle.blockers.push('승자 캠페인을 동기화한 뒤 예산을 조정합니다.'); return runs; }
    const today = new Date(this.clock()).toISOString().slice(0, 10);
    const spend = withoutOverlap(currentFacts(this.store.list<AttributionFact>('attribution-fact').filter(fact => fact.projectId === mandate.projectId)).facts, 'campaign')
      .filter(fact => fact.kind === 'spend' && fact.currency === mandate.limits.currency && fact.eventDate >= mandate.startsAt.slice(0, 10));
    const sum = (items: AttributionFact[]) => items.reduce((total, fact) => total + parseMicros(fact.amountMicros ?? '0'), 0n).toString();
    // 위임 일일 한도는 위임 계정의 다른 활성 캠페인 예산과 대기 중 예산 변경까지 합쳐 검사한다.
    const others = new Map<string, bigint>();
    for (const item of this.store.list<ExternalResource>('resource').filter(resource => resource.kind === 'campaign' && resource.projectId === mandate.projectId && mandate.connectionIds.includes(resource.connectionId)
      && !['PAUSED', 'REMOVED', 'DELETED'].includes(resource.status.toUpperCase()) && !(resource.connectionId === campaign.connectionId && resource.externalId === campaign.externalId) && resource.data.currency === mandate.limits.currency))
      others.set(item.connectionId + ':' + item.externalId, parseMicros(String(item.data.dailyBudgetMicros ?? '0')));
    for (const run of this.store.pendingCampaigns(mandate.projectId)) {
      if (!run.input.dailyBudgetMicros || (run.connectionId === campaign.connectionId && run.input.externalId === campaign.externalId)) continue;
      const key = run.connectionId + ':' + String(run.input.externalId ?? 'new-' + run.id); const value = parseMicros(run.input.dailyBudgetMicros);
      if (value > (others.get(key) ?? 0n)) others.set(key, value);
    }
    const pendingBudget = [...others.values()].reduce((total, value) => total + value, 0n).toString();
    const key = 'scale:' + campaign.externalId;
    const plan = planBudgetStep({ mandate, currentBudgetMicros: String(campaign.data.dailyBudgetMicros ?? '0'), lastScaleAt: cycle.watermarks[key], spentTodayMicros: sum(spend.filter(fact => fact.eventDate === today)), spentTotalMicros: sum(spend), pendingBudgetMicros: pendingBudget, now: new Date(this.clock()), decision });
    if (!plan.allowed || !plan.budgetMicros) { cycle.blockers.push(...plan.reasons); return runs; }
    try {
      runs.push(this.queueWrite(mandate, 'ads-scale', experiment.connectionId, 'update-campaign', { externalId: campaign.externalId, dailyBudgetMicros: plan.budgetMicros, currency: mandate.limits.currency }, `budget:${experiment.id}:${campaign.externalId}:${plan.budgetMicros}`).id);
      cycle.watermarks[key] = this.iso();
    } catch (error) { cycle.blockers.push(error instanceof AppError ? error.message : '예산 조정을 예약하지 못했습니다.'); }
    return runs;
  }
  /** 공급자 실험·arm 식별자로 수집한 fact를 내부 실험·arm ID로 맞춘다. 다른 실험의 fact는 제외한다. */
  private scopedFacts(experiment: Experiment, all: AttributionFact[]): AttributionFact[] {
    const arms = new Map(experiment.arms.filter(arm => arm.externalId).map(arm => [arm.externalId!, arm.id]));
    return currentFacts(all.filter(fact => !fact.experimentId || fact.experimentId === experiment.id || fact.experimentId === experiment.providerExperimentId)
      .map(fact => ({ ...fact, ...(fact.experimentId ? { experimentId: experiment.id } : {}), ...(fact.armId && arms.has(fact.armId) ? { armId: arms.get(fact.armId)! } : {}) }))).facts;
  }
  private checkInvalidation(experiment: Experiment, all: AttributionFact[], policy: GrowthPolicy, mandate: OperationMandate, fx: FxSnapshot[]): void {
    const previous = experiment.winnerDecisionId ? this.store.get<DecisionSnapshot>('growth-decision', experiment.winnerDecisionId) : undefined;
    if (!previous || previous.outcome !== 'winner') return;
    const facts = this.scopedFacts(experiment, all);
    const invalidation = invalidateDecision(previous, experiment, facts, policy, mandate, fx, new Date(this.clock()));
    if (!invalidation || this.store.get('growth-decision', invalidation.id)) return;
    this.saveExperiment(experiment, { status: 'action_required', lastDecisionId: invalidation.id, statusReason: '늦게 들어온 정정 자료로 이전 승자 판단이 무효가 되었습니다. 자동 재확대는 하지 않습니다.' },
      { projectId: experiment.projectId, kind: 'growth.decision_invalidated', message: '정정 자료로 이전 승자 판단을 무효화했습니다. 운영자 확인이 필요합니다.', level: 'warning', data: { experimentId: experiment.id, decisionId: invalidation.id } },
      [{ kind: 'growth-decision', id: invalidation.id, value: invalidation }]);
  }

  recordFx(data: Record<string, unknown>): FxSnapshot {
    const base = text(data.base, '기준 통화', 3).toUpperCase(); const quote = text(data.quote, '대상 통화', 3).toUpperCase();
    const rate = text(data.rate, '환율', 30);
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || base === quote || !/^\d{1,12}(\.\d{1,10})?$/.test(rate) || Number(rate) <= 0) throw new AppError('INVALID_INPUT', '통화 코드와 환율을 확인해 주세요.');
    const date = text(data.date, '환율 기준일', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('INVALID_INPUT', '환율 기준일은 YYYY-MM-DD 형식입니다.');
    const source = text(data.source, '환율 출처', 100);
    const id = sha([source, date, base, quote].join('|'));
    const previous = this.store.get<FxSnapshot>('fx-snapshot', id);
    const value: FxSnapshot = { id, source, date, base, quote, rate, recordedAt: this.iso(), version: (previous?.version ?? 0) + 1 };
    this.store.put('fx-snapshot', id, value); return value;
  }
  resume(): { resumed: true } {
    this.store.remove('settings', 'growth-paused');
    this.store.addEvent({ kind: 'growth.resumed', message: '성장 운영 자동화를 다시 허용했습니다. 복원 전 위임은 중지 상태이므로 필요한 범위를 새로 확정해 주세요.' });
    return { resumed: true };
  }
}
