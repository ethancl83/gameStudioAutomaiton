import type { Run, RunStatus } from '../../packages/domain/index.js';
import { redact } from '../../packages/domain/errors.js';
import { Store } from '../../packages/storage/index.js';

export interface ExecutionContext {
  signal: AbortSignal; markDispatched(): void; progress(message: string): void;
  markRejected?(): void;
  checkpoint(data: Record<string, unknown>): void;
}
export type RunHandler = (run: Run, context: ExecutionContext) => Promise<{ result: Record<string, unknown>; status?: RunStatus; effectResolved?: boolean }>;

export class JobQueue {
  private active = new Map<string, { abort: AbortController; task: Promise<void> }>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(private store: Store, private handler: RunHandler, private concurrency = 2) {}
  start(): void {
    clearInterval(this.interval);
    this.stopped = false;
    this.interval = setInterval(() => this.tick(), 300);
    this.interval.unref();
    this.tick();
  }
  tick(): void {
    if (this.stopped) return;
    try {
      while (this.active.size < this.concurrency) {
        const claimed = this.store.claim();
        if (!claimed) break;
        const abort = new AbortController();
        const { run, token } = claimed;
        const task = Promise.resolve().then(async () => {
          try {
            const value = await this.handler(run, {
              signal: abort.signal,
              markDispatched: () => this.store.markDispatched(run.id, token),
              markRejected: () => this.store.markRejected(run.id, token),
              checkpoint: data => this.store.checkpoint(run.id, token, data),
              progress: message => this.store.addEvent({ projectId: run.projectId, runId: run.id, kind: 'progress', message }),
            });
            this.store.finish(run.id, token, value.status ?? 'succeeded', value.result, null, value.effectResolved === true);
          } catch (error) {
            const current = this.store.getRun(run.id);
            if (current?.status !== 'running') return;
            const code = (error as { code?: string }).code;
            const message = redact(error instanceof Error ? error.message : '작업 처리 중 오류가 발생했습니다.');
            const uncertain = this.store.effectState(run.id) === 'dispatched';
            if (!uncertain && code === 'TEMPORARY' && run.attempt < 3 && !abort.signal.aborted) {
              this.store.defer(run.id, token, message, Math.min(30_000, 1000 * 2 ** run.attempt));
            } else {
              const actionRequired = uncertain || ['VAULT_LOCKED','VAULT_UNAVAILABLE','KEY_MISSING','AUTH_REVOKED','AUTH_REQUIRED','PERMISSION_REQUIRED','ISOLATION_UNAVAILABLE','RECONCILIATION_REQUIRED'].includes(code ?? '');
              this.store.finish(run.id, token, actionRequired ? 'action_required' : abort.signal.aborted ? 'cancelled' : 'failed', { failureCode: code ?? 'INTERNAL_ERROR' },
                uncertain ? '외부 요청 전송 후 결과가 확정되지 않았습니다. 중복 방지를 위해 다시 보내지 않았습니다. ' + message : message);
            }
          }
        }).catch(() => {
          // A fenced controller cannot settle an old task; the new owner reconciles it.
        }).finally(() => { this.active.delete(run.id); });
        this.active.set(run.id, { abort, task });
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'CONTROLLER_FENCED') {
        this.stopped = true;
        for (const task of this.active.values()) task.abort.abort();
      } else throw error;
    }
  }
  cancel(id: string): Run {
    const run = this.store.cancel(id);
    this.active.get(id)?.abort.abort();
    return run;
  }
  get activeCount():number{return this.active.size;}
  pause():void{this.stopped=true;clearInterval(this.interval);}
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.interval);
    for (const [id, task] of this.active) {
      try { this.store.cancel(id); } catch {}
      task.abort.abort();
    }
    await Promise.allSettled([...this.active.values()].map(task => task.task));
  }
}
