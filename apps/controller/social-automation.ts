import { createHash, randomUUID } from 'node:crypto';
import type { Connection, ExternalResource, Project, ProjectSocialPolicy, Run, SocialSchedule } from '../../packages/domain/index.js';
import { AppError, canonical, object, prohibitSecrets, text } from '../../packages/domain/errors.js';
import type { Store } from '../../packages/storage/index.js';

export const isSocialWrite = (operation: string) => operation === 'create-post' || operation === 'reply';
interface Actions { action(connectionId: string, input: unknown): Run; supported(provider: Connection['provider'], operation: string): boolean }
const now = () => new Date().toISOString();
const fail = (message: string, code = 'INVALID_SOCIAL_POLICY'): never => { throw new AppError(code, message, 400); };
const defaults: ProjectSocialPolicy = { enabled: false, connectionIds: [], dailyPostLimit: 10, autoReleaseAnnouncements: false,
  releaseTemplate: '{projectName} {version} 업데이트가 출시되었습니다. ({platform})', autoReply: false, replyRules: [] };
export class SocialAutomation {
  constructor(private store: Store, private actions: Actions, private clock: () => number = Date.now) {}
  listSchedules(): SocialSchedule[] { return this.store.list<SocialSchedule>('social-schedule'); }
  savePolicy(id: string, input: unknown): Project {
    const project = this.store.get<Project>('project', id); if (!project) return fail('프로젝트를 찾을 수 없습니다.', 'NOT_FOUND');
    const data = object(input); prohibitSecrets(data);
    for (const key of ['enabled', 'autoReleaseAnnouncements', 'autoReply']) if (typeof data[key] !== 'boolean') return fail('자동 운영 설정을 확인해 주세요.');
    if (!Number.isSafeInteger(data.dailyPostLimit) || Number(data.dailyPostLimit) < 1 || Number(data.dailyPostLimit) > 100) return fail('일일 게시·답글 한도는 1~100개여야 합니다.');
    if (!Array.isArray(data.connectionIds) || data.connectionIds.length > 20) return fail('운영할 채널을 선택해 주세요.');
    const connectionIds = [...new Set(data.connectionIds.map(id => text(id, '연결 ID', 100)))];
    for (const id of connectionIds) {
      const connection = this.store.get<Connection>('connection', id);
      if (!connection || connection.status === 'disconnected' || !['x', 'threads', 'steam'].includes(connection.provider)) return fail('연결된 소셜·Steam 계정만 선택할 수 있습니다.');
    }
    const releaseTemplate = text(data.releaseTemplate ?? defaults.releaseTemplate, '출시 공지 문구', 500);
    if (!Array.isArray(data.replyRules) || data.replyRules.length > 20) return fail('자동 답글 규칙은 20개 이하여야 합니다.');
    const replyRules = data.replyRules.map(item => { const rule = object(item); return { id: text(rule.id, '규칙 ID', 100), matchText: text(rule.matchText, '찾을 문구', 100), replyText: text(rule.replyText, '답글 문구', 500) }; });
    if (new Set(replyRules.map(rule => rule.id)).size !== replyRules.length) return fail('답글 규칙 ID가 중복되었습니다.');
    const socialPolicy: ProjectSocialPolicy = { enabled: data.enabled as boolean, connectionIds, dailyPostLimit: Number(data.dailyPostLimit),
      autoReleaseAnnouncements: data.autoReleaseAnnouncements as boolean, releaseTemplate, autoReply: data.autoReply as boolean, replyRules };
    if (socialPolicy.enabled && (!project.socialPolicy?.enabled || (!project.socialPolicy.autoReleaseAnnouncements && socialPolicy.autoReleaseAnnouncements))) {
      this.store.put('settings', 'social-enabled-since:' + id, { at: this.clock() });
    }
    if (socialPolicy.autoReply && (!project.socialPolicy?.autoReply || !project.socialPolicy.enabled)) this.store.put('settings', 'social-reply-since:' + id, { at: this.clock() });
    const updated = { ...project, socialPolicy, updatedAt: now() }; this.store.put('project', id, updated);
    this.store.addEvent({ projectId: id, kind: 'social.policy', message: '채널·예약·자동 답글 운영 정책을 저장했습니다.', data: { socialPolicy } });
    return updated;
  }
  enforceWrite(project: Project | undefined, connection: Connection, operation: string, input: Record<string, unknown>, currentRunId?: string): void {
    if (!isSocialWrite(operation)) return;
    const policy = project?.socialPolicy;
    if (!project || !policy?.enabled || !policy.connectionIds.includes(connection.id)) throw new AppError('SOCIAL_POLICY_DENIED', '프로젝트 커뮤니티 정책에서 이 채널의 운영을 허용해 주세요.', 403);
    const since = new Date(this.clock()); since.setUTCHours(0, 0, 0, 0);
    const ordered = this.store.socialWrites(project.id, since.toISOString());
    const position = currentRunId ? ordered.findIndex(run => run.id === currentRunId) : ordered.length;
    if (position < 0) throw new AppError('SOCIAL_POLICY_DENIED', '예약한 소셜 작업을 찾을 수 없습니다.', 403);
    const reserved = ordered.filter((run, index) => {
      if (run.id === currentRunId) return false;
      if (!currentRunId && run.connectionId === connection.id && run.kind === operation && canonical(run.input) === canonical(input) && ['queued', 'running', 'retry_wait', 'action_required', 'waiting_external'].includes(run.status)) return false;
      // Confirmed/uncertain effects always consume quota. Among untouched intents,
      // admit only the earliest reservations, even when different channels run together.
      return run.status === 'succeeded' || this.store.effectState(run.id) !== 'prepared' || index < position;
    });
    if ((!currentRunId || this.store.effectState(currentRunId) === 'prepared') && reserved.length >= policy.dailyPostLimit) throw new AppError('SOCIAL_DAILY_LIMIT', '오늘의 게시·답글과 대기 작업이 프로젝트 일일 한도에 도달했습니다.', 403);
    if (operation === 'reply') {
      const resource = this.store.list<ExternalResource>('resource').find(item => item.connectionId === connection.id && item.externalId === input.replyToId && ['mention', 'reply', 'post'].includes(item.kind));
      if (!resource || resource.projectId !== project.id) throw new AppError('SOCIAL_REPLY_SCOPE', '이 프로젝트에 연결된 게시글·댓글을 먼저 동기화한 뒤 답글을 작성해 주세요.', 403);
    }
  }
  schedule(input: unknown): SocialSchedule {
    const data = object(input); prohibitSecrets(data);
    const projectId = text(data.projectId, '프로젝트 ID', 100); const project = this.store.get<Project>('project', projectId);
    if (!project) return fail('프로젝트를 찾을 수 없습니다.', 'NOT_FOUND');
    const content = text(data.text, '게시 문구', 500);
    const scheduledAt = text(data.scheduledAt, '예약 시간', 40); const timestamp = Date.parse(scheduledAt);
    if (!Number.isFinite(timestamp) || timestamp < this.clock() || timestamp > this.clock() + 366 * 86_400_000) return fail('예약 시간은 지금부터 1년 이내로 지정해 주세요.', 'INVALID_SCHEDULE');
    if (!Array.isArray(data.connectionIds) || !data.connectionIds.length || data.connectionIds.length > 20) return fail('예약할 채널을 선택해 주세요.', 'INVALID_SCHEDULE');
    const connectionIds = [...new Set(data.connectionIds.map(id => text(id, '연결 ID', 100)))];
    for (const id of connectionIds) {
      const connection = this.store.get<Connection>('connection', id);
      if (!connection || !this.actions.supported(connection.provider, 'create-post')) return fail('자동 게시를 지원하는 채널만 예약할 수 있습니다.', 'UNSUPPORTED_OPERATION');
      this.enforceWrite(project, connection, 'create-post', { text: content });
    }
    const schedule: SocialSchedule = { id: randomUUID(), projectId, connectionIds, text: content, scheduledAt: new Date(timestamp).toISOString(), status: 'scheduled', runIds: {}, createdAt: now(), updatedAt: now() };
    this.store.put('social-schedule', schedule.id, schedule);
    this.store.addEvent({ projectId, kind: 'social.scheduled', message: '채널 게시를 예약했습니다.', data: { scheduleId: schedule.id, scheduledAt: schedule.scheduledAt } });
    return schedule;
  }
  cancelSchedule(id: string): SocialSchedule {
    const schedule = this.store.get<SocialSchedule>('social-schedule', id); if (!schedule) return fail('게시 예약을 찾을 수 없습니다.', 'NOT_FOUND');
    if (schedule.status === 'cancelled') return schedule;
    const runs = Object.values(schedule.runIds).map(id => this.store.getRun(id)).filter((run): run is Run => Boolean(run));
    if (runs.some(run => !['queued', 'retry_wait', 'cancelled'].includes(run.status) || this.store.effectState(run.id) !== 'prepared')) throw new AppError('SCHEDULE_DISPATCHED', '이미 전송을 시작한 예약입니다. 실행 이력에서 채널별 결과를 확인해 주세요.', 409);
    for (const run of runs) if (run.status !== 'cancelled') this.store.cancel(run.id);
    const updated: SocialSchedule = { ...schedule, status: 'cancelled', updatedAt: now() }; this.store.put('social-schedule', id, updated); return updated;
  }
  cycle(): void {
    for (const schedule of this.listSchedules()) {
      if (schedule.status !== 'scheduled' || Date.parse(schedule.scheduledAt) > this.clock()) continue;
      for (const id of schedule.connectionIds) {
        if (schedule.runIds[id]) continue;
        try {
          const run = this.actions.action(id, { operation: 'create-post', projectId: schedule.projectId, input: { text: schedule.text }, idempotencyKey: this.key('schedule:' + schedule.id + ':' + id) });
          schedule.runIds[id] = run.id; this.store.put('social-schedule', schedule.id, { ...schedule, updatedAt: now() });
        } catch (error) { this.waiting('schedule:' + schedule.id + ':' + id, schedule.projectId, error); }
      }
      if (Object.keys(schedule.runIds).length === schedule.connectionIds.length) this.store.put('social-schedule', schedule.id, { ...schedule, status: 'queued', updatedAt: now() });
    }
    for (const project of this.store.list<Project>('project')) {
      if (!project.socialPolicy?.enabled) continue;
      this.steamNews(project);
      this.releaseAnnouncements(project);
      this.replies(project);
    }
  }
  private key(value: string): string { return 'social_' + createHash('sha256').update(value).digest('hex'); }
  private steamNews(project: Project): void {
    for (const id of project.socialPolicy!.connectionIds) {
      const connection = this.store.get<Connection>('connection', id);
      if (!connection || connection.provider !== 'steam' || !this.actions.supported('steam', 'list-news')) continue;
      const key = 'social-news:' + project.id + ':' + id;
      if (this.clock() - (this.store.get<{ at: number }>('settings', key)?.at ?? 0) < 3_600_000) continue;
      if (this.store.runs(10_000).some(run => run.connectionId === id && run.kind === 'list-news' && ['queued', 'running', 'retry_wait'].includes(run.status))) continue;
      try { this.actions.action(id, { operation: 'list-news', projectId: project.id, input: {} }); this.store.put('settings', key, { at: this.clock() }); }
      catch (error) { this.waiting(key, project.id, error); }
    }
  }
  private waiting(key: string, projectId: string, error: unknown): void {
    const reason = error instanceof AppError ? error.message : '소셜 자동 실행 조건을 확인해 주세요.';
    if (this.store.get<{ reason: string }>('settings', 'social-wait:' + key)?.reason === reason) return;
    this.store.put('settings', 'social-wait:' + key, { reason });
    this.store.addEvent({ projectId, kind: 'social.waiting', message: reason, level: 'warning' });
  }
  private publishOnce(key: string, project: Project, connectionId: string, input: Record<string, unknown>, operation: string): void {
    if (this.store.get('settings', 'social-sent:' + key)) return;
    const connection = this.store.get<Connection>('connection', connectionId);
    if (!connection || !this.actions.supported(connection.provider, operation)) return;
    try {
      const run = this.actions.action(connectionId, { operation, projectId: project.id, input, idempotencyKey: this.key(key) });
      this.store.put('settings', 'social-sent:' + key, { runId: run.id });
    } catch (error) { this.waiting(key, project.id, error); }
  }
  private releaseAnnouncements(project: Project): void {
    const policy = project.socialPolicy!; if (!policy.autoReleaseAnnouncements) return;
    const enabledAt = this.store.get<{ at: number }>('settings', 'social-enabled-since:' + project.id)?.at ?? this.clock();
    for (const release of this.store.list<import('../../packages/domain/index.js').ReleaseObservation>('release-observation')) {
      if (release.projectId!==project.id||!release.published||!release.publishedAt||Date.parse(release.publishedAt)<enabledAt)continue;
      const content=policy.releaseTemplate.replaceAll('{projectName}',project.name).replaceAll('{version}',release.version).replaceAll('{platform}',release.provider);
      for(const id of policy.connectionIds)this.publishOnce('release:'+release.id+':'+id,project,id,{text:content},'create-post');
    }
  }
  private replies(project: Project): void {
    const policy = project.socialPolicy!; if (!policy.autoReply || !policy.replyRules.length) return;
    const enabledAt = this.store.get<{ at: number }>('settings', 'social-reply-since:' + project.id)?.at ?? this.clock();
    for (const resource of this.store.list<ExternalResource>('resource')) {
      if (resource.projectId !== project.id || !policy.connectionIds.includes(resource.connectionId) || !['mention', 'reply'].includes(resource.kind) ||
        resource.data.owned === true || !Number.isFinite(Date.parse(String(resource.data.createdAt))) || Date.parse(String(resource.data.createdAt)) < enabledAt) continue;
      const content = typeof resource.data.text === 'string' ? resource.data.text : '';
      const rule = policy.replyRules.find(rule => content.toLocaleLowerCase().includes(rule.matchText.toLocaleLowerCase()));
      if (rule) this.publishOnce('reply:' + resource.connectionId + ':' + resource.externalId, project, resource.connectionId, { text: rule.replyText, replyToId: resource.externalId }, 'reply');
    }
  }
}
