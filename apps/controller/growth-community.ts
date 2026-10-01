import { createHash, randomUUID } from 'node:crypto';
import type { Connection, ExternalResource, Project, ReleaseObservation } from '../../packages/domain/index.js';
import { AppError, text } from '../../packages/domain/errors.js';
import type { Store } from '../../packages/storage/index.js';
import type { FeedbackItem, GrowthCycleState, GrowthIncident, GrowthPolicy, IssueCluster, KnowledgeRevision, OperationMandate, OptOutRecord, PlatformApproval, ProductExperimentLink, ResponseIntent } from '../../packages/growth/types.js';
import { approveRevision, createRevision, projectKnowledgeCandidates, retireRevision, searchKnowledge, validateCitations } from '../../packages/growth/knowledge.js';
import { aiPrompt, classifyByRules, decideResponse, externalIdentity, mergeClassification, parseAiResult, presendCheck, redactPii } from '../../packages/growth/community.js';
import { feedbackId, attachRelease, clusterFeedback, issuePriority, mergeClusters, normalizeFeedback, observeLink, proposeLink, splitCluster } from '../../packages/growth/feedback.js';
import type { GrowthHooks } from './growth.js';
import { iso } from './growth-input.js';

export interface CommunityDeps {
  hooks: GrowthHooks; iso(): string; clock(): number; signal(): AbortSignal;
  project(id: string): Project; policy(projectId: string): GrowthPolicy;
  active(mandate: OperationMandate): boolean; stopMandate(id: string, reason: string): OperationMandate;
  track(run: import('../../packages/domain/index.js').Run, mandateId: string, responseId: string, reused?: boolean, safety?: boolean): void;
  cancelResponses(responseIds: string[]): number;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * 고객응대·지식·피드백 이슈 운영. 외부 게시물은 비신뢰 데이터이며, 자동 승인 답글도 발송 직전 재검사와
 * 기존 내구성 큐(authorized→queued→prepared→dispatched)를 반드시 거친다. AI 출력은 권한이 아니다.
 */
export class GrowthCommunity {
  constructor(private store: Store, private deps: CommunityDeps) {}
  async cycle(mandate: OperationMandate, cycle: GrowthCycleState): Promise<void> {
    const project = this.deps.project(mandate.projectId);
    const knowledge = this.store.list<KnowledgeRevision>('knowledge-revision');
    const optOuts = this.store.list<OptOutRecord>('opt-out');
    const salt = this.salt();
    const resources = this.store.list<ExternalResource>('resource').filter(item => item.projectId === project.id && mandate.connectionIds.includes(item.connectionId) && ['mention', 'reply'].includes(item.kind) && item.data.owned !== true
      && Date.parse(String(item.data.createdAt)) >= Date.parse(mandate.startsAt));
    const feedback: FeedbackItem[] = [];
    // 한 주기의 AI·분류 작업량만 제한한다. 이미 처리한 상호작용은 세지 않아 오래된 항목이 앞을 막지 않는다.
    let processed = 0;
    for (const resource of resources.sort((a, b) => String(a.data.createdAt).localeCompare(String(b.data.createdAt)))) {
      if (this.deps.signal().aborted || processed >= 200) break;
      const connection = this.store.get<Connection>('connection', resource.connectionId); if (!connection) continue;
      const content = typeof resource.data.text === 'string' ? resource.data.text : '';
      const authorHash = sha(salt + ':' + connection.provider + ':' + String(resource.data.authorId ?? ''));
      const rules = classifyByRules(content);
      if (mandate.actions.includes('feedback-triage')) {
        const previous = this.store.get<FeedbackItem>('feedback-item', feedbackId(connection.provider, connection.id, resource.externalId));
        const item = normalizeFeedback({ projectId: project.id, provider: connection.provider, connectionId: connection.id, interactionId: resource.externalId, text: content, authorId: String(resource.data.authorId ?? ''), occurredAt: String(resource.data.createdAt), ...(resource.status === 'deleted' ? { deleted: true } : {}) }, rules, this.deps.iso(), salt);
        if (!previous || previous.textHash !== item.textHash || Boolean(previous.deletedAt) !== Boolean(item.deletedAt)) feedback.push({ ...item, ...(previous?.clusterId ? { clusterId: previous.clusterId } : {}), createdAt: previous?.createdAt ?? item.createdAt });
      }
      if (!mandate.actions.includes('community-draft') && !mandate.actions.includes('community-reply')) continue;
      const identity = externalIdentity(connection.provider, connection.accountId, resource.externalId, resource.externalId, 'reply');
      if (this.store.get('response-intent', identity)) continue;
      processed++;
      let intent: ResponseIntent = { id: identity, projectId: project.id, connectionId: connection.id, provider: connection.provider, interactionId: resource.externalId, replyTargetId: resource.externalId,
        externalIdentity: identity, status: 'ingested', excerpt: redactPii(content).slice(0, 200), textHash: sha(content), authorHash, blockReasons: [], knowledgeRevisionIds: [], mandateId: mandate.id, createdAt: this.deps.iso(), updatedAt: this.deps.iso() };
      if (optOuts.some(item => item.connectionId === connection.id && item.authorHash === authorHash)) {
        intent = { ...intent, status: 'blocked', blockReasons: ['이 사용자는 자동 응답을 거부했습니다.'] };
      } else {
        const retrieval = searchKnowledge(knowledge, project.id, content, 5);
        let classification = rules; let draftResult: ReturnType<typeof parseAiResult> | undefined;
        const unsafe = rules.risks.some(risk => ['prompt_injection', 'spam'].includes(risk));
        if (!unsafe && this.deps.hooks.classify && retrieval.length) {
          try {
            const raw = await this.deps.hooks.classify(aiPrompt({ projectName: project.name, interactionText: content, retrieval }), this.deps.signal());
            draftResult = parseAiResult(raw, retrieval.map(item => item.revision), project.id, connection.provider === 'x' ? 280 : 500);
            if (draftResult.ok) classification = mergeClassification(rules, draftResult.classification);
          } catch (error) { cycle.blockers.push(error instanceof AppError ? error.message : '고객응대 AI 분류에 실패했습니다.'); }
        }
        const approval = this.approval(connection);
        const decision = decideResponse({ classification, draftResult, optedOut: false, approval, mandate, now: this.deps.iso() });
        if (classification.risks.includes('opt_out')) this.cancelForAuthor(connection.id, authorHash);
        if (classification.risks.includes('opt_out')) this.store.put('opt-out', sha(connection.id + authorHash), { id: sha(connection.id + authorHash), provider: connection.provider, connectionId: connection.id, authorHash, source: 'user_request', at: this.deps.iso() } satisfies OptOutRecord);
        intent = { ...intent, status: decision.status, classification, blockReasons: decision.blockReasons, ...(decision.escalation ? { escalation: decision.escalation } : {}),
          ...(draftResult?.ok && draftResult.draft ? { draft: draftResult.draft, knowledgeRevisionIds: [...new Set(draftResult.draft.sentences.flatMap(sentence => sentence.citations.map(citation => citation.revisionId)))] } : {}),
          policyVersion: this.deps.policy(project.id).version };
      }
      this.store.writeBatch([{ kind: 'response-intent', id: intent.id, value: intent }], [], intent.status === 'escalated' ? [{ projectId: project.id, kind: 'growth.escalation', message: '사람 확인이 필요한 고객 문의가 있습니다: ' + (intent.escalation?.reason ?? ''), level: 'warning', data: { responseId: intent.id } }] : []);
      if (intent.status === 'draft_ready' && mandate.actions.includes('community-reply')) this.dispatchResponse(intent, mandate, cycle);
    }
    if (feedback.length) this.ingestFeedback(project.id, feedback);
  }
  private salt(): string {
    let value = this.store.get<{ salt: string }>('settings', 'growth-author-salt')?.salt;
    if (!value) { value = randomUUID(); this.store.put('settings', 'growth-author-salt', { salt: value }); }
    return value;
  }
  private approval(connection: Connection): PlatformApproval | undefined {
    return this.store.list<PlatformApproval>('platform-approval').find(item => item.connectionId === connection.id && item.provider === connection.provider && !item.revokedAt && (!item.expiresAt || Date.parse(item.expiresAt) > this.deps.clock()));
  }
  /** 자동 승인도 사람 검토만 생략한다. authorized→queued 경로와 발송 직전 재검사는 항상 거친다. */
  private dispatchResponse(intent: ResponseIntent, mandate: OperationMandate | undefined, cycle?: GrowthCycleState): ResponseIntent {
    const project = this.deps.project(intent.projectId);
    const connection = this.store.get<Connection>('connection', intent.connectionId);
    const resource = this.store.list<ExternalResource>('resource').find(item => item.connectionId === intent.connectionId && item.externalId === intent.interactionId);
    const since = new Date(this.deps.clock()); since.setUTCHours(0, 0, 0, 0);
    const recent = this.store.list<ResponseIntent>('response-intent').filter(item => item.projectId === intent.projectId && item.id !== intent.id && item.draft && ['queued', 'prepared', 'dispatched', 'confirmed'].includes(item.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const authorized: ResponseIntent = { ...intent, status: 'authorized', updatedAt: this.deps.iso() };
    const reasons = presendCheck({ intent: authorized, mandate, approval: connection ? this.approval(connection) : undefined, optOuts: this.store.list<OptOutRecord>('opt-out'),
      interactionStillExists: Boolean(resource && resource.status !== 'deleted'), interactionOwnedByProject: resource?.projectId === project.id,
      existingSameIdentity: this.store.list<ResponseIntent>('response-intent').filter(item => item.externalIdentity === intent.externalIdentity && item.id !== intent.id),
      repliesToday: this.store.socialWrites(project.id, since.toISOString()).filter(run => run.kind === 'reply').length, dailyLimit: project.socialPolicy?.dailyPostLimit ?? 0,
      recentReplyTexts: recent.slice(0, 20).map(item => item.draft!.text).reverse(), now: this.deps.iso(), knowledge: this.store.list<KnowledgeRevision>('knowledge-revision') });
    if (reasons.length || !intent.draft || !connection) {
      const value = { ...intent, blockReasons: reasons.length ? reasons : ['발송할 초안이 없습니다.'], updatedAt: this.deps.iso() };
      this.store.put('response-intent', intent.id, value); cycle?.blockers.push(...value.blockReasons.slice(0, 2)); return value;
    }
    try {
      // 외부 identity 키는 정책·지식 버전과 무관하다. 정책이 바뀌어도 같은 상호작용에 두 번 답하지 않는다.
      let value!: ResponseIntent;
      this.deps.hooks.action(intent.connectionId, { operation: 'reply', projectId: intent.projectId, input: { text: intent.draft.text, replyToId: intent.replyTargetId }, idempotencyKey: 'reply_' + intent.externalIdentity.slice(0, 64) }, (run, reused) => {
        this.deps.track(run, mandate?.id ?? '', intent.id, reused);
        value = { ...authorized, status: 'queued', runId: run.id, blockReasons: [], updatedAt: this.deps.iso() };
        this.store.writeBatch([{ kind: 'response-intent', id: intent.id, value }], [], [{ projectId: intent.projectId, kind: 'growth.reply.queued', message: '근거가 확인된 일반 문의 답글을 내구성 큐에 넣었습니다.', data: { responseId: intent.id, runId: run.id } }]);
      });
      return value;
    } catch (error) {
      const value = { ...intent, blockReasons: [error instanceof AppError ? error.message : '답글을 큐에 넣지 못했습니다.'], updatedAt: this.deps.iso() };
      this.store.put('response-intent', intent.id, value); return value;
    }
  }
  syncResponses(): void {
    for (const intent of this.store.list<ResponseIntent>('response-intent')) {
      for (const [field, recall] of [['runId', false], ['recallRunId', true]] as const) {
        const runId = intent[field]; if (!runId) continue;
        const run = this.store.getRun(runId); if (!run) continue;
        const effect = this.store.effectState(run.id);
        let status: ResponseIntent['status'] = intent.status;
        if (recall) { if (run.status === 'succeeded') status = 'retracted'; else continue; }
        else if (run.status === 'succeeded') status = 'confirmed';
        else if (run.status === 'waiting_external' || effect === 'dispatched') status = 'dispatched';
        else if (run.status === 'action_required') status = effect === 'prepared' ? 'queued' : 'unresolved';
        else if (run.status === 'failed' || run.status === 'cancelled') status = 'closed';
        else status = effect === 'prepared' && run.status === 'running' ? 'prepared' : 'queued';
        if (['retracted', 'closed'].includes(intent.status) && !recall) continue;
        if (status !== intent.status) this.store.put('response-intent', intent.id, { ...intent, status, ...(status === 'closed' ? { blockReasons: [...intent.blockReasons, run.error ?? '발송하지 못했습니다.'] } : {}), updatedAt: this.deps.iso() });
        break;
      }
    }
    for (const incident of this.store.list<GrowthIncident>('growth-incident').filter(item => item.status === 'recalling')) {
      if (incident.recallRunIds.every(id => ['succeeded', 'failed', 'cancelled'].includes(this.store.getRun(id)?.status ?? 'failed')))
        this.store.put('growth-incident', incident.id, { ...incident, status: 'open', notes: [...incident.notes, '회수 작업 결과를 확인했습니다. 후속 응대를 마치면 해결로 표시하세요.'], updatedAt: this.deps.iso() });
    }
  }
  private response(id: string): ResponseIntent {
    const intent = this.store.get<ResponseIntent>('response-intent', id);
    if (!intent) throw new AppError('NOT_FOUND', '고객 응답을 찾을 수 없습니다.', 404);
    return intent;
  }
  authorizeResponse(id: string): ResponseIntent {
    const intent = this.response(id);
    if (intent.status !== 'draft_ready') throw new AppError('INVALID_STATE', '근거가 확인된 초안만 승인할 수 있습니다. 위험·민감 문의는 사람이 직접 응대해 주세요.', 409);
    const mandate = this.store.list<OperationMandate>('growth-mandate').find(item => item.projectId === intent.projectId && this.deps.active(item) && item.actions.includes('community-reply') && item.connectionIds.includes(intent.connectionId));
    const result = this.dispatchResponse(intent, mandate);
    if (result.status !== 'queued') throw new AppError('PRESEND_BLOCKED', result.blockReasons.join(' '), 409);
    return result;
  }
  dismissResponse(id: string, reason: string): ResponseIntent {
    const intent = this.response(id);
    if (!['draft_ready', 'blocked', 'escalated', 'classified', 'ingested'].includes(intent.status)) throw new AppError('INVALID_STATE', '이미 발송 경로에 들어간 응답은 보류할 수 없습니다.', 409);
    const value: ResponseIntent = { ...intent, status: 'closed', blockReasons: [...intent.blockReasons, reason], updatedAt: this.deps.iso() };
    this.store.put('response-intent', id, value); return value;
  }
  recordOptOut(id: string, source: OptOutRecord['source']): OptOutRecord {
    const intent = this.response(id);
    const record: OptOutRecord = { id: sha(intent.connectionId + intent.authorHash), provider: intent.provider, connectionId: intent.connectionId, authorHash: intent.authorHash, source, at: this.deps.iso() };
    const updates: { kind: 'opt-out' | 'response-intent'; id: string; value: unknown }[] = [{ kind: 'opt-out', id: record.id, value: record }];
    for (const item of this.store.list<ResponseIntent>('response-intent')) if (item.authorHash === intent.authorHash && item.connectionId === intent.connectionId && ['draft_ready', 'authorized'].includes(item.status))
      updates.push({ kind: 'response-intent', id: item.id, value: { ...item, status: 'blocked', blockReasons: ['자동 응답 거부'], updatedAt: this.deps.iso() } });
    this.store.writeBatch(updates);
    this.cancelForAuthor(intent.connectionId, intent.authorHash);
    return record;
  }
  /** 수신 거부한 작성자에게 예약만 된 답글은 전송 전에 취소한다. */
  private cancelForAuthor(connectionId: string, authorHash: string): void {
    this.deps.cancelResponses(this.store.list<ResponseIntent>('response-intent').filter(item => item.connectionId === connectionId && item.authorHash === authorHash && item.status === 'queued').map(item => item.id));
  }
  /** 전송 직전 재검사. 예약 뒤 바뀔 수 있는 조건(위임·승인·수신 거부·원문 존재·인용 지식)만 다시 본다. */
  dispatchReasons(responseId: string, mandate: OperationMandate | undefined): string[] {
    const intent = this.store.get<ResponseIntent>('response-intent', responseId);
    if (!intent) return ['답글 기록을 찾을 수 없습니다.'];
    const reasons: string[] = [];
    if (!mandate || !this.deps.active(mandate) || !mandate.actions.includes('community-reply') || !mandate.connectionIds.includes(intent.connectionId)) reasons.push('자동 답글 위임이 활성 상태가 아닙니다.');
    const connection = this.store.get<Connection>('connection', intent.connectionId);
    if (!connection || !this.approval(connection)) reasons.push('플랫폼 자동 답글 승인 근거가 없거나 철회·만료되었습니다.');
    if (this.store.list<OptOutRecord>('opt-out').some(item => item.connectionId === intent.connectionId && item.authorHash === intent.authorHash)) reasons.push('수신 거부한 사용자입니다.');
    const resource = this.store.list<ExternalResource>('resource').find(item => item.connectionId === intent.connectionId && item.externalId === intent.interactionId);
    if (!resource || resource.status === 'deleted' || resource.projectId !== intent.projectId) reasons.push('원문이 삭제되었거나 이 프로젝트의 상호작용이 아닙니다.');
    if (intent.draft) reasons.push(...validateCitations(intent.draft, this.store.list<KnowledgeRevision>('knowledge-revision'), intent.projectId));
    return reasons;
  }
  /** 잘못된 답변: 관련 위임을 즉시 멈추고, 본인 답글만 별도 회수 작업으로 삭제한다. 결과 불명은 재삭제하지 않는다. */
  recallResponse(id: string, reason: string): GrowthIncident {
    const intent = this.response(id);
    if (!['confirmed', 'unresolved', 'dispatched'].includes(intent.status)) throw new AppError('INVALID_STATE', '발송된 답글만 회수할 수 있습니다.', 409);
    const paused: string[] = [];
    for (const mandate of this.store.list<OperationMandate>('growth-mandate').filter(item => item.projectId === intent.projectId && item.status === 'active' && item.actions.includes('community-reply'))) {
      this.deps.stopMandate(mandate.id, '잘못된 답변 회수로 자동 응답을 멈췄습니다: ' + reason); paused.push(mandate.id);
    }
    for (const other of this.store.list<ResponseIntent>('response-intent').filter(item => item.projectId === intent.projectId && item.status === 'queued' && item.runId)) {
      if (this.store.effectState(other.runId!) === 'prepared') { try { this.deps.hooks.cancel(other.runId!); } catch { /* 이미 진행 중이면 큐가 결과를 확인한다. */ } }
    }
    return this.store.transaction(() => {
      const run = intent.runId ? this.store.getRun(intent.runId) : undefined;
      const replyId = run?.result?.externalId;
      const recallRuns: string[] = [];
      if (intent.status === 'confirmed' && typeof replyId === 'string') {
        recallRuns.push(this.deps.hooks.action(intent.connectionId, { operation: 'delete-post', projectId: intent.projectId, input: { postId: replyId }, idempotencyKey: 'recall_' + intent.externalIdentity.slice(0, 64) }, (run, reused) => this.deps.track(run, intent.mandateId ?? '', intent.id, reused, true)).id);
      }
      const incident: GrowthIncident = { id: randomUUID(), projectId: intent.projectId, reason, responseIntentIds: [id], recallRunIds: recallRuns, status: recallRuns.length ? 'recalling' : 'open', pausedMandateIds: paused,
        notes: recallRuns.length ? [] : ['발송 결과가 확정되지 않았거나 답글 ID가 없어 자동 삭제하지 않았습니다. 서비스에서 직접 확인해 주세요.'], createdAt: this.deps.iso(), updatedAt: this.deps.iso() };
      this.store.writeBatch([{ kind: 'growth-incident', id: incident.id, value: incident }, { kind: 'response-intent', id, value: { ...intent, incidentId: incident.id, ...(recallRuns[0] ? { recallRunId: recallRuns[0] } : {}), updatedAt: this.deps.iso() } }], [],
        [{ projectId: intent.projectId, kind: 'growth.incident', message: '답글 회수 사고를 열고 자동 응답을 중지했습니다: ' + reason, level: 'warning', data: { incidentId: incident.id } }]);
      return incident;
    });
  }
  resolveIncident(id: string, note: string): GrowthIncident {
    const incident = this.store.get<GrowthIncident>('growth-incident', id);
    if (!incident) throw new AppError('NOT_FOUND', '사고 기록을 찾을 수 없습니다.', 404);
    if (incident.recallRunIds.some(runId => !['succeeded', 'failed', 'cancelled'].includes(this.store.getRun(runId)?.status ?? 'failed'))) throw new AppError('INVALID_STATE', '회수 작업 결과를 먼저 확인해 주세요.', 409);
    const value: GrowthIncident = { ...incident, status: 'resolved', notes: [...incident.notes, note], updatedAt: this.deps.iso() };
    this.store.put('growth-incident', id, value); return value;
  }
  recordApproval(data: Record<string, unknown>): PlatformApproval {
    const connection = this.store.get<Connection>('connection', text(data.connectionId, '채널', 100));
    if (!connection || !['x', 'threads'].includes(connection.provider)) throw new AppError('INVALID_INPUT', 'X 또는 Threads 채널을 선택해 주세요.');
    const evidence = text(data.evidence, '승인 근거', 2000);
    if (evidence.length < 10) throw new AppError('INVALID_INPUT', '플랫폼 승인 문서나 심사 결과를 구체적으로 기록해 주세요.');
    const record: PlatformApproval = { id: randomUUID(), provider: connection.provider as 'x' | 'threads', connectionId: connection.id, kind: 'ai_reply_automation', evidence,
      approvedAt: iso(data.approvedAt, '승인일'), ...(data.expiresAt ? { expiresAt: iso(data.expiresAt, '만료일') } : {}), recordedAt: this.deps.iso() };
    this.store.writeBatch([{ kind: 'platform-approval', id: record.id, value: record }], [], [{ kind: 'growth.approval', message: `${connection.label}의 AI 자동 답글 플랫폼 승인 근거를 기록했습니다.` }]);
    return record;
  }
  revokeApproval(id: string): PlatformApproval {
    const record = this.store.get<PlatformApproval>('platform-approval', id);
    if (!record) throw new AppError('NOT_FOUND', '승인 기록을 찾을 수 없습니다.', 404);
    const value = { ...record, revokedAt: this.deps.iso() }; this.store.put('platform-approval', id, value); return value;
  }
  saveKnowledge(data: Record<string, unknown>): KnowledgeRevision {
    const projectId = text(data.projectId, '프로젝트 ID', 100); this.deps.project(projectId);
    const sourceKind = String(data.sourceKind) as KnowledgeRevision['sourceKind'];
    if (!['store_listing', 'faq', 'support_policy', 'changelog', 'known_issue', 'analysis'].includes(sourceKind)) throw new AppError('INVALID_INPUT', '지식 종류를 선택해 주세요.');
    const revision = createRevision(this.store.list<KnowledgeRevision>('knowledge-revision'), { projectId, documentKey: text(data.documentKey ?? data.title, '문서 키', 200), sourceKind, title: text(data.title, '제목', 200), body: text(data.body, '본문', 20_000), ...(data.sourceRef ? { sourceRef: text(data.sourceRef, '출처', 500) } : {}) }, this.deps.iso());
    this.store.put('knowledge-revision', revision.id, revision);
    return revision;
  }
  reviseKnowledge(id: string, action: 'approve' | 'retire'): KnowledgeRevision {
    const all = this.store.list<KnowledgeRevision>('knowledge-revision');
    const revision = all.find(item => item.id === id);
    if (!revision) throw new AppError('NOT_FOUND', '지식 문서를 찾을 수 없습니다.', 404);
    const at = this.deps.iso();
    if (action === 'retire') { const value = retireRevision(revision, at); this.store.put('knowledge-revision', id, value); return value; }
    const { approved, retired } = approveRevision(revision, all, at);
    this.store.writeBatch([approved, ...retired].map(item => ({ kind: 'knowledge-revision' as const, id: item.id, value: item })), [], [{ projectId: revision.projectId, kind: 'growth.knowledge', message: `지식 문서 '${revision.title}' v${revision.version}을 승인했습니다. 이후 초안은 이 판을 근거로 사용합니다.` }]);
    return approved;
  }
  async importKnowledge(projectId: string): Promise<KnowledgeRevision[]> {
    const project = this.deps.project(projectId);
    const files = this.deps.hooks.projectFiles ? await this.deps.hooks.projectFiles(project) : [];
    const { candidates } = projectKnowledgeCandidates({ projectId, listing: this.deps.hooks.agentListing?.(projectId), files });
    const saved: KnowledgeRevision[] = [];
    for (const candidate of candidates) {
      const revision = createRevision(this.store.list<KnowledgeRevision>('knowledge-revision'), { ...candidate, projectId }, this.deps.iso());
      this.store.put('knowledge-revision', revision.id, revision); saved.push(revision);
    }
    return saved;
  }
  private ingestFeedback(projectId: string, items: FeedbackItem[]): void {
    const existing = this.store.list<FeedbackItem>('feedback-item').filter(item => item.projectId === projectId);
    const merged = [...existing.filter(item => !items.some(next => next.id === item.id)), ...items];
    const clusters = this.store.list<IssueCluster>('issue-cluster').filter(item => item.projectId === projectId);
    const result = clusterFeedback(merged, clusters, this.deps.iso());
    const assigned = new Map<string, string>();
    for (const cluster of result.clusters) for (const itemId of cluster.itemIds) if (cluster.status !== 'merged') assigned.set(itemId, cluster.id);
    const updates: { kind: 'feedback-item' | 'issue-cluster'; id: string; value: unknown }[] = [];
    for (const item of merged) {
      const clusterId = assigned.get(item.id);
      if (items.includes(item) || clusterId !== item.clusterId) updates.push({ kind: 'feedback-item', id: item.id, value: { ...item, ...(clusterId ? { clusterId } : {}), updatedAt: this.deps.iso() } });
    }
    for (const cluster of result.clusters) {
      const members = merged.filter(item => cluster.itemIds.includes(item.id));
      updates.push({ kind: 'issue-cluster', id: cluster.id, value: { ...cluster, priority: issuePriority(cluster, members, null, this.deps.iso()) } });
    }
    this.store.writeBatch(updates);
  }
  private cluster(id: string): IssueCluster {
    const cluster = this.store.get<IssueCluster>('issue-cluster', id);
    if (!cluster) throw new AppError('NOT_FOUND', '이슈를 찾을 수 없습니다.', 404);
    return cluster;
  }
  updateCluster(id: string, change: (cluster: IssueCluster) => IssueCluster): IssueCluster {
    const value = change(this.cluster(id)); this.store.put('issue-cluster', id, { ...value, updatedAt: this.deps.iso() }); return value;
  }
  mergeCluster(targetId: string, sourceId: string, reason: string): IssueCluster {
    if (targetId === sourceId) throw new AppError('INVALID_INPUT', '서로 다른 이슈를 선택해 주세요.');
    const target = this.cluster(targetId); const source = this.cluster(sourceId);
    if (target.projectId !== source.projectId) throw new AppError('INVALID_INPUT', '같은 프로젝트의 이슈만 합칠 수 있습니다.');
    const result = mergeClusters(target, source, reason, this.deps.iso());
    const items = this.store.list<FeedbackItem>('feedback-item').filter(item => source.itemIds.includes(item.id));
    this.store.writeBatch([{ kind: 'issue-cluster', id: result.target.id, value: result.target }, { kind: 'issue-cluster', id: result.source.id, value: result.source },
      ...items.map(item => ({ kind: 'feedback-item' as const, id: item.id, value: { ...item, clusterId: targetId, updatedAt: this.deps.iso() } }))]);
    return result.target;
  }
  splitIssue(id: string, itemIds: unknown, reason: string): IssueCluster[] {
    if (!Array.isArray(itemIds) || !itemIds.length) throw new AppError('INVALID_INPUT', '분리할 피드백을 선택해 주세요.');
    const ids = itemIds.map(item => text(item, '피드백 ID', 200));
    const result = splitCluster(this.cluster(id), ids, reason, this.deps.iso());
    const items = this.store.list<FeedbackItem>('feedback-item').filter(item => ids.includes(item.id));
    this.store.writeBatch([{ kind: 'issue-cluster', id: result.original.id, value: result.original }, { kind: 'issue-cluster', id: result.created.id, value: result.created },
      ...items.map(item => ({ kind: 'feedback-item' as const, id: item.id, value: { ...item, clusterId: result.created.id, updatedAt: this.deps.iso() } }))]);
    return [result.original, result.created];
  }
  proposeProductLink(clusterId: string, hypothesis: string): ProductExperimentLink {
    const cluster = this.cluster(clusterId);
    if (cluster.status !== 'confirmed') throw new AppError('INVALID_STATE', '운영자가 확인한 이슈에만 제품 개선 가설을 연결할 수 있습니다.', 409);
    const link = proposeLink(cluster, hypothesis, this.deps.iso());
    this.store.put('product-link', link.id, link); return link;
  }
  updateLink(id: string, change: (link: ProductExperimentLink) => ProductExperimentLink): ProductExperimentLink {
    const link = this.store.get<ProductExperimentLink>('product-link', id);
    if (!link) throw new AppError('NOT_FOUND', '제품 개선 연결을 찾을 수 없습니다.', 404);
    const value = change(link); this.store.put('product-link', id, value); return value;
  }
  attachProductRelease(id: string, observationId: string): ProductExperimentLink {
    const observation = this.store.get<ReleaseObservation>('release-observation', observationId);
    if (!observation?.published || !observation.publishedAt) throw new AppError('INVALID_STATE', '공개가 확인된 출시 기록만 연결할 수 있습니다.', 409);
    return this.updateLink(id, link => {
      if (observation.projectId !== link.projectId) throw new AppError('INVALID_INPUT', '같은 프로젝트의 출시만 연결할 수 있습니다.');
      return attachRelease(link, { id: observation.id, version: observation.version, publishedAt: observation.publishedAt! }, this.deps.iso());
    });
  }
  /** 출시 전후 피드백 관찰은 주기와 무관하게 조회 시 갱신한다(외부 쓰기 없음). */
  refreshProductLinks(): void {
    const releases = this.store.list<ReleaseObservation>('release-observation');
    for (const link of this.store.list<ProductExperimentLink>('product-link').filter(item => ['released', 'observing'].includes(item.status))) {
      const cluster = this.store.get<IssueCluster>('issue-cluster', link.clusterId); if (!cluster) continue;
      const items = this.store.list<FeedbackItem>('feedback-item').filter(item => item.projectId === link.projectId);
      const others = releases.filter(item => item.projectId === link.projectId && item.id !== link.releaseObservationId && item.published && item.publishedAt).map(item => ({ version: item.version, publishedAt: item.publishedAt! }));
      const value = observeLink(link, cluster, items, this.deps.iso(), 14, others);
      if (JSON.stringify(value) !== JSON.stringify(link)) this.store.put('product-link', link.id, value);
    }
  }
}
