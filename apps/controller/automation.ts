import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection, Project, Run } from '../../packages/domain/index.js';
import type { Store } from '../../packages/storage/index.js';
import { isExcludedDirectory } from '../runner/excludes.js';
import { isSecretFile } from '../runner/secrets.js';

export interface AutomationActions {
  build(projectId: string, input: unknown): Run;
  action(connectionId: string, input: unknown): Run;
  reconcile(runId: string): Run;
  supported(provider: Connection['provider'], operation: string): boolean;
  socialCycle?(): void;
}
const pending = new Set(['queued', 'running', 'retry_wait']);
export async function projectFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256'); let count = 0;
  async function visit(path: string, prefix: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const relative = prefix ? prefix + '/' + name : name;
      if (isSecretFile(relative) || relative === '.appops-manifest.json') continue;
      const absolute = join(path, name); const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { if (!isExcludedDirectory(relative)) await visit(absolute, relative); }
      else if (stat.isFile()) {
        if (++count > 250_000) throw new Error('자동 감시 파일 수가 250,000개를 넘었습니다. 프로젝트 범위를 줄여 주세요.');
        hash.update(relative + '\0' + stat.size + ':' + stat.mtimeMs + '\0');
      }
    }
  }
  await visit(root, ''); return hash.digest('hex');
}
/** Scheduling intent is persisted; restarting the UI or controller does not multiply actions. */
export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  constructor(private store: Store, private actions: AutomationActions, private clock: () => number = Date.now) {}
  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, 30_000); this.timer.unref();
    void this.tick();
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); await this.running; }
  tick(): Promise<void> {
    if (this.stopped || this.running) return this.running ?? Promise.resolve();
    this.running = this.cycle().catch(error => {
      try { this.store.addEvent({ kind: 'automation.error', message: error instanceof Error ? error.message : '자동화 상태 확인에 실패했습니다.', level: 'warning' }); } catch {}
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private stamp(key: string): number { return this.store.get<{ at: number }>('settings', key)?.at ?? 0; }
  private setStamp(key: string): void { this.store.put('settings', key, { at: this.clock() }); }
  private async cycle(): Promise<void> {
    this.actions.socialCycle?.();
    const projects = this.store.list<Project>('project');
    for (const project of projects) {
      if (this.stopped) return;
      if (project.relinkRequired) continue;
      if (project.policy.autoBuild) await this.scanProject(project);
      if (project.policy.autoRelease) this.releaseBuilds(project);
    }
    const runs = this.store.runs(10_000);
    for (const connection of this.store.list<Connection>('connection')) {
      if (this.stopped) return;
      if (!['connected', 'recovering', 'unverified'].includes(connection.status)) continue;
      const interval = connection.status === 'recovering' || connection.status === 'unverified' ? 60_000 : 3_600_000;
      if (this.actions.supported(connection.provider, 'sync-app')) {
        for (const project of projects) {
          const mapping = project.storeApps?.[connection.provider as 'google-play'|'app-store'|'steam'];
          if (mapping ? mapping.connectionId !== connection.id : !project.appIdentifier || !project.policy.allowedConnectionIds.includes(connection.id)) continue;
          const key = 'auto-app-sync:' + connection.id + ':' + project.id;
          const recentRelease=runs.some(r=>r.connectionId===connection.id&&r.projectId===project.id&&['upload-build','promote-release','release-version','set-live'].includes(r.kind)&&!['failed','cancelled'].includes(r.status)&&Date.parse(r.updatedAt)>this.clock()-86_400_000);
          if (this.clock() - this.stamp(key) < (recentRelease?60_000:interval) || runs.some(r => r.connectionId === connection.id && r.projectId === project.id && r.kind === 'sync-app' && pending.has(r.status))) continue;
          try { this.actions.action(connection.id, {operation:'sync-app',projectId:project.id,input:{}}); this.setStamp(key); }
          catch (error) { this.store.addEvent({projectId:project.id,kind:'automation.sync_error',message:error instanceof Error ? error.message : '앱 동기화를 예약하지 못했습니다.',level:'warning'}); }
        }
      }
      if (!this.actions.supported(connection.provider, 'sync')) continue;
      const key = 'auto-sync:' + connection.id;
      if (this.clock() - this.stamp(key) < interval || runs.some(r => r.connectionId === connection.id && pending.has(r.status))) continue;
      this.actions.action(connection.id, { operation: 'sync', input: {} }); this.setStamp(key);
    }
    for (const run of runs.filter(r => ['upload-build', 'submit-review', 'set-live'].includes(r.kind) && r.status === 'waiting_external')) {
      if (this.stopped) return;
      const key = 'auto-reconcile:' + run.id;
      if (this.clock() - this.stamp(key) < 60_000 || runs.some(r => r.kind === 'reconcile' && r.input.targetRunId === run.id && pending.has(r.status))) continue;
      try { this.actions.reconcile(run.id); this.setStamp(key); } catch {}
    }
  }
  private async scanProject(project: Project): Promise<void> {
    const key = 'watch:' + project.id;
    const previous = this.store.get<{ fingerprint: string; candidate?: string; candidateAt?: number; error?: string }>('settings', key);
    try {
      if (this.store.runs(10_000).some(run => run.projectId === project.id && run.kind === 'build' && pending.has(run.status))) return;
      const fingerprint = await projectFingerprint(project.rootPath);
      if (this.stopped) return;
      if (previous?.fingerprint === fingerprint) return;
      // Wait for a stable second observation to avoid building while an editor is saving many files.
      if (previous?.candidate !== fingerprint) {
        this.store.put('settings', key, { fingerprint: previous?.fingerprint ?? '', candidate: fingerprint, candidateAt: this.clock() }); return;
      }
      if (this.clock() - (previous.candidateAt ?? 0) < 20_000) return;
      const current = this.store.get<Project>('project', project.id);
      if (!current?.policy.autoBuild) return;
      if (!project.targets.length) throw new Error('자동 빌드 대상을 찾지 못했습니다. 프로젝트 내보내기 설정을 확인해 주세요.');
      for (const target of project.targets) this.actions.build(project.id, { target });
      this.store.put('settings', key, { fingerprint });
      this.store.addEvent({ projectId: project.id, kind: 'automation.build', message: '안정된 파일 변경을 확인해 빌드를 예약했습니다.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '프로젝트 자동 감시에 실패했습니다.';
      if (previous?.error !== message) this.store.addEvent({ projectId: project.id, kind: 'automation.watch_error', message, level: 'warning' });
      this.store.put('settings', key, { ...previous, error: message });
    }
  }
  private releaseBuilds(project: Project): void {
    const latest = new Map<string, Run>();
    const enabledAt = this.stamp('auto-release-since:' + project.id);
    for (const run of this.store.runs(10_000)) {
      if (run.projectId === project.id && run.kind === 'build' && !run.input.pipelineId && run.status === 'succeeded' && Date.parse(run.finishedAt ?? run.createdAt) >= enabledAt && !latest.has(String(run.result?.target))) latest.set(String(run.result?.target), run);
    }
    for (const [target, build] of latest) {
      const providers = target === 'android' ? ['google-play'] : target === 'ios' ? ['app-store'] : target === 'macos' ? ['app-store', 'steam'] : ['steam'];
      for (const id of project.policy.allowedConnectionIds) {
        const connection = this.store.get<Connection>('connection', id);
        if (!connection || !providers.includes(connection.provider) || !['connected', 'unverified'].includes(connection.status)) continue;
        const key = `auto-release:${build.id}:${id}`;
        if (this.stamp(key)) continue;
        try {
          this.actions.action(id, { operation: 'upload-build', projectId: project.id,
            input: { buildRunId: build.id, track: 'internal' }, idempotencyKey: 'auto_' + createHash('sha256').update(key).digest('hex') });
          this.setStamp(key);
        } catch (error) {
          const reason = error instanceof Error ? error.message : '자동 배포 조건을 확인해 주세요.';
          if (this.store.get<{ reason: string }>('settings', key)?.reason !== reason) this.store.addEvent({ projectId: project.id, kind: 'automation.release_waiting', message: reason, level: 'warning' });
          this.store.put('settings', key, { at: 0, reason });
        }
      }
    }
  }
}
