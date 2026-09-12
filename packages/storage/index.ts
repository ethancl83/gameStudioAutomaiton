import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, canonical, prohibitSecrets, redact } from '../domain/errors.js';
import type { Run, RunStatus, TimelineEvent, Severity, HistoryPage, ReleasePipeline } from '../domain/index.js';

type Row = Record<string, unknown>;
export type DocumentKind = 'project' | 'connection' | 'resource' | 'metric' | 'settings' | 'build-credential' | 'social-schedule' | 'connection-commit' | 'pipeline' | 'runner' | 'media' | 'release-observation' | 'imported-artifact';
export interface RunInput {
  projectId?: string | null; connectionId?: string | null; kind: string; label: string;
  input: Record<string, unknown>; writeEffect?: boolean; idempotencyKey?: string;
  pipeline?: ReleasePipeline;
}
export interface ClaimedRun { run: Run; token: string }

function runFrom(row: Row): Run {
  return {
    id: String(row.id), projectId: row.project_id as string | null, connectionId: row.connection_id as string | null,
    kind: String(row.kind), label: String(row.label), status: row.status as RunStatus, writeEffect: Boolean(row.write_effect),
    input: JSON.parse(String(row.input_json)), result: row.result_json ? JSON.parse(String(row.result_json)) : null,
    error: row.error as string | null, attempt: Number(row.attempt), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at), startedAt: row.started_at as string | null, finishedAt: row.finished_at as string | null,
  };
}

export class Store {
  readonly db: DatabaseSync;
  readonly owner = randomUUID();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private readonly clock: () => number;
  private readonly leaseDuration = 60_000;

  constructor(readonly directory: string, options: { clock?: () => number; heartbeat?: boolean } = {}) {
    this.clock = options.clock ?? Date.now;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'operations.sqlite'));
    chmodSync(join(directory, 'operations.sqlite'), 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS controller (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT, connection_id TEXT, kind TEXT NOT NULL, label TEXT NOT NULL,
        status TEXT NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL, result_json TEXT, error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        lock_key TEXT NOT NULL, owner_token TEXT, lease_until INTEGER, available_at INTEGER NOT NULL DEFAULT 0,
        write_effect INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT,
        UNIQUE(connection_id,kind,dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS runs_ready ON runs(status,available_at,created_at);
      CREATE TABLE IF NOT EXISTS effects (run_id TEXT PRIMARY KEY REFERENCES runs(id), state TEXT NOT NULL, external_id TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, run_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL,
        level TEXT NOT NULL, data_json TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
      PRAGMA user_version=1;
    `);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const current = this.db.prepare('SELECT * FROM controller WHERE id=1').get() as Row | undefined;
      if (current && Number(current.expires_at) > this.clock()) throw new AppError('CONTROLLER_RUNNING', '이 데이터 폴더를 사용하는 제어 서비스가 이미 실행 중입니다.', 409);
      this.db.prepare('INSERT INTO controller VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(this.owner, this.clock() + this.leaseDuration);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.db.close();
      throw error;
    }
    this.recover();
    if (options.heartbeat !== false) {
      this.heartbeat = setInterval(() => { try { this.renew(); } catch { clearInterval(this.heartbeat); } }, 10_000);
      this.heartbeat.unref();
    }
  }
  private iso(): string { return new Date(this.clock()).toISOString(); }
  private assertOwner(): void {
    const row = this.db.prepare('SELECT owner,expires_at FROM controller WHERE id=1').get() as Row | undefined;
    if (!row || row.owner !== this.owner || Number(row.expires_at) <= this.clock()) throw new AppError('CONTROLLER_FENCED', '작업 소유권이 변경되었습니다. 제어 서비스를 다시 연결해 주세요.', 409);
  }
  transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.assertOwner(); const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  renew(): void {
    this.transaction(() => {
      this.db.prepare('UPDATE controller SET expires_at=? WHERE id=1 AND owner=?').run(this.clock() + this.leaseDuration, this.owner);
      this.db.prepare("UPDATE runs SET lease_until=? WHERE status='running' AND owner_token LIKE ?").run(this.clock() + this.leaseDuration, this.owner + ':%');
    });
  }
  private recover(): void {
    this.transaction(() => {
      const interrupted = this.db.prepare("SELECT r.*,e.state AS effect_state FROM runs r LEFT JOIN effects e ON e.run_id=r.id WHERE r.status='running'").all() as Row[];
      for (const row of interrupted) {
        const ambiguous = row.effect_state === 'dispatched';
        const status = ambiguous ? 'action_required' : 'queued';
        this.db.prepare('UPDATE runs SET status=?,owner_token=NULL,lease_until=NULL,updated_at=?,error=? WHERE id=?')
          .run(status, this.iso(), ambiguous ? '이전 실행의 외부 반영 결과를 확인해야 합니다. 중복 방지를 위해 다시 보내지 않았습니다.' : null, String(row.id));
        if (ambiguous) this.db.prepare("UPDATE effects SET state='action_required',updated_at=? WHERE run_id=?").run(this.iso(), String(row.id));
        this.addEventDirect({ projectId: row.project_id as string | null, runId: String(row.id), kind: 'recovery', message: ambiguous ? '외부 반영 확인 대기' : '중단된 작업을 복구했습니다.', level: ambiguous ? 'warning' : 'info' });
      }
    });
  }
  put<T>(kind: DocumentKind, id: string, value: T): T {
    return this.transaction(() => {
      this.db.prepare('INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(kind, id, JSON.stringify(value), this.iso());
      return value;
    });
  }
  get<T>(kind: DocumentKind, id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM documents WHERE kind=? AND id=?').get(kind, id) as Row | undefined;
    return row ? JSON.parse(String(row.payload)) as T : undefined;
  }
  list<T>(kind: DocumentKind): T[] {
    return (this.db.prepare('SELECT payload FROM documents WHERE kind=? ORDER BY updated_at DESC').all(kind) as Row[]).map(row => JSON.parse(String(row.payload)) as T);
  }
  remove(kind: DocumentKind, id: string): void {
    this.transaction(() => this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, id));
  }
  writeBatch(updates: { kind: DocumentKind; id: string; value: unknown }[], removals: { kind: DocumentKind; id: string }[] = [], events: Parameters<Store['addEvent']>[0][] = []): void {
    this.transaction(() => {
      const remove = this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?');
      const put = this.db.prepare('INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at');
      for (const item of removals) remove.run(item.kind, item.id);
      for (const item of updates) put.run(item.kind, item.id, JSON.stringify(item.value), this.iso());
      for (const event of events) this.addEventDirect(event);
    });
  }
  createRun(options: RunInput): Run {
    prohibitSecrets(options.input);
    const encoded = canonical(options.input);
    const hash = createHash('sha256').update(encoded).digest('hex');
    if (options.writeEffect && (!options.connectionId || !options.idempotencyKey || !/^[a-zA-Z0-9_-]{8,128}$/.test(options.idempotencyKey))) {
      throw new AppError('IDEMPOTENCY_REQUIRED', '외부 변경에는 동일 작업을 식별할 요청 키가 필요합니다.');
    }
    return this.transaction(() => {
      if (options.idempotencyKey) {
        const found = this.db.prepare('SELECT * FROM runs WHERE connection_id=? AND kind=? AND dedupe_key=?').get(options.connectionId ?? null, options.kind, options.idempotencyKey) as Row | undefined;
        if (found) {
          if (found.input_hash !== hash || found.project_id !== (options.projectId ?? null)) throw new AppError('IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 변경 내용을 사용할 수 없습니다.', 409);
          return runFrom(found);
        }
      }
      if (options.writeEffect) {
        const pending = this.db.prepare("SELECT * FROM runs WHERE connection_id=? AND kind=? AND project_id IS ? AND input_hash=? AND status IN ('queued','running','retry_wait','action_required','waiting_external')").get(options.connectionId ?? null, options.kind, options.projectId ?? null, hash) as Row | undefined;
        if (pending) return runFrom(pending);
      }
      const id = randomUUID(); const at = this.iso();
      const lock = options.connectionId ? 'connection:' + options.connectionId : options.projectId ? 'project:' + options.projectId : id;
      this.db.prepare(`INSERT INTO runs(id,project_id,connection_id,kind,label,status,input_json,input_hash,created_at,updated_at,lock_key,write_effect,dedupe_key) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,?)`)
        .run(id, options.projectId ?? null, options.connectionId ?? null, options.kind, options.label, encoded, hash, at, at, lock, options.writeEffect ? 1 : 0, options.idempotencyKey ?? null);
      if (options.writeEffect) this.db.prepare("INSERT INTO effects VALUES(?,'prepared',NULL,?)").run(id, at);
      if (options.pipeline) {
        const value = options.kind === 'build' ? { ...options.pipeline, buildRunId: id } : { ...options.pipeline, uploadRunId: id, status: 'uploading' };
        this.db.prepare('INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run('pipeline', options.pipeline.id, JSON.stringify(value), at);
      }
      this.addEventDirect({ projectId: options.projectId ?? null, runId: id, kind: 'queued', message: options.label + ' 작업을 예약했습니다.', level: 'info' });
      return this.getRun(id)!;
    });
  }
  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined;
    return row ? runFrom(row) : undefined;
  }
  runs(limit = 100): Run[] { return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC,rowid DESC LIMIT ?').all(limit) as Row[]).map(runFrom); }
  pendingCampaigns(projectId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE project_id=? AND kind IN ('create-campaign','update-campaign') AND status IN ('queued','running','retry_wait','action_required','waiting_external')").all(projectId) as Row[]).map(runFrom);
  }
  socialWrites(projectId: string, since: string): Run[] {
    return (this.db.prepare(`SELECT r.* FROM runs r LEFT JOIN effects e ON e.run_id=r.id
      WHERE r.project_id=? AND r.kind IN ('create-post','reply') AND
      (r.status IN ('queued','running','retry_wait','waiting_external','action_required') OR
       (r.status='succeeded' AND r.finished_at>=?) OR e.state IN ('dispatched','action_required'))
      ORDER BY r.created_at,r.rowid`).all(projectId, since) as Row[]).map(runFrom);
  }
  claim(): ClaimedRun | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM runs r WHERE r.status IN ('queued','retry_wait') AND r.available_at<=? AND NOT EXISTS(SELECT 1 FROM runs a WHERE a.status='running' AND a.lock_key=r.lock_key) ORDER BY r.created_at,r.rowid LIMIT 1`).get(this.clock()) as Row | undefined;
      if (!row) return undefined;
      const token = this.owner + ':' + randomUUID();
      this.db.prepare("UPDATE runs SET status='running',owner_token=?,lease_until=?,attempt=attempt+1,started_at=?,updated_at=?,error=NULL WHERE id=?")
        .run(token, this.clock() + this.leaseDuration, this.iso(), this.iso(), String(row.id));
      return { run: this.getRun(String(row.id))!, token };
    });
  }
  private assertRunOwner(id: string, token: string): Row {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Row | undefined;
    if (!row || row.status !== 'running' || row.owner_token !== token || Number(row.lease_until) <= this.clock()) throw new AppError('RUN_FENCED', '이미 종료되거나 소유권이 변경된 작업입니다.', 409);
    return row;
  }
  markDispatched(id: string, token: string): void {
    this.transaction(() => {
      this.assertRunOwner(id, token);
      const effect = this.db.prepare('SELECT state FROM effects WHERE run_id=?').get(id) as Row | undefined;
      if (effect && effect.state !== 'prepared') throw new AppError('EFFECT_ALREADY_SENT', '외부 요청이 이미 전송되었습니다.', 409);
      if (effect) this.db.prepare("UPDATE effects SET state='dispatched',updated_at=? WHERE run_id=?").run(this.iso(), id);
    });
  }
  effectState(id: string): string | undefined { return (this.db.prepare('SELECT state FROM effects WHERE run_id=?').get(id) as Row | undefined)?.state as string | undefined; }
  markRejected(id: string, token: string): void {
    this.transaction(() => {
      this.assertRunOwner(id, token);
      if (this.effectState(id) !== 'dispatched') throw new AppError('INVALID_EFFECT_STATE', '요청 전송 상태가 바뀌었습니다.', 409);
      this.db.prepare("UPDATE effects SET state='prepared',updated_at=? WHERE run_id=?").run(this.iso(), id);
      this.addEventDirect({ runId: id, kind: 'effect.rejected', message: '서비스가 첫 변경 요청을 거절했습니다. 외부 변경 없이 재시도할 수 있습니다.', level: 'warning' });
    });
  }
  checkpoint(id: string, token: string, data: Record<string, unknown>): void {
    prohibitSecrets(data);
    this.transaction(() => {
      const row = this.assertRunOwner(id, token);
      const previous = row.result_json ? JSON.parse(String(row.result_json)) : {};
      this.db.prepare('UPDATE runs SET result_json=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...previous, ...data }), this.iso(), id);
    });
  }
  defer(id: string, token: string, message: string, delay: number): void {
    this.transaction(() => {
      this.assertRunOwner(id, token);
      if (this.effectState(id) === 'dispatched') throw new AppError('EFFECT_ALREADY_SENT', '외부 반영 확인 전에는 재시도할 수 없습니다.', 409);
      this.db.prepare("UPDATE runs SET status='retry_wait',available_at=?,error=?,updated_at=?,owner_token=NULL,lease_until=NULL WHERE id=?")
        .run(this.clock() + delay, redact(message), this.iso(), id);
    });
  }
  finish(id: string, token: string, status: RunStatus, result: Record<string, unknown> | null = null, error: string | null = null, effectResolved = false): Run {
    return this.transaction(() => {
      const row = this.assertRunOwner(id, token);
      if (result) prohibitSecrets(result);
      if (row.write_effect && ['succeeded', 'waiting_external'].includes(status) && this.effectState(id) !== 'dispatched') {
        throw new AppError('UNDISPATCHED_EFFECT', '전송 기록이 없는 외부 변경을 완료 처리할 수 없습니다.', 409);
      }
      const previous = row.result_json ? JSON.parse(String(row.result_json)) : null;
      const merged = result ? { ...previous, ...result } : previous;
      this.db.prepare('UPDATE runs SET status=?,result_json=?,error=?,updated_at=?,finished_at=?,owner_token=NULL,lease_until=NULL WHERE id=?')
        .run(status, merged ? JSON.stringify(merged) : null, error ? redact(error) : null, this.iso(), this.iso(), id);
      if (row.write_effect) {
        const previousEffect = this.effectState(id) ?? 'prepared';
        const effect = status === 'succeeded' ? 'confirmed' : status === 'failed' && effectResolved && previousEffect === 'dispatched' ? 'resolved_failed' : status === 'action_required' && previousEffect === 'dispatched' ? 'action_required' : previousEffect;
        this.db.prepare('UPDATE effects SET state=?,updated_at=? WHERE run_id=?').run(effect, this.iso(), id);
      }
      this.addEventDirect({ projectId: row.project_id as string | null, runId: id, kind: status, message: error ?? (String(row.label) + (status === 'succeeded' ? ' 완료' : ' 상태 변경')), level: status === 'succeeded' ? 'info' : status === 'failed' ? 'error' : 'warning' });
      return this.getRun(id)!;
    });
  }
  cancel(id: string): Run {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (!run) throw new AppError('NOT_FOUND', '작업을 찾을 수 없습니다.', 404);
      if (run.status === 'action_required') {
        const effect = this.effectState(id);
        if (effect && effect !== 'prepared') throw new AppError('RECONCILIATION_REQUIRED', '이미 전송한 작업의 결과를 확인한 뒤 정리해 주세요.', 409);
      } else if (!['queued','running','retry_wait'].includes(run.status)) return run;
      const ambiguous = this.effectState(id) === 'dispatched';
      const status = ambiguous ? 'action_required' : 'cancelled';
      this.db.prepare('UPDATE runs SET status=?,error=?,finished_at=?,updated_at=?,owner_token=NULL,lease_until=NULL WHERE id=?').run(status, ambiguous ? '취소 전에 외부 요청이 전송되어 반영 결과 확인이 필요합니다.' : null, this.iso(), this.iso(), id);
      if (ambiguous) this.db.prepare("UPDATE effects SET state='action_required',updated_at=? WHERE run_id=?").run(this.iso(), id);
      this.addEventDirect({ projectId: run.projectId, runId: id, kind: status, message: ambiguous ? '외부 반영 확인 대기' : '작업을 취소했습니다.', level: 'warning' });
      return this.getRun(id)!;
    });
  }
  retry(id: string): Run {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (!run) throw new AppError('NOT_FOUND', '작업을 찾을 수 없습니다.', 404);
      const effect = this.effectState(id);
      if (!['failed','cancelled'].includes(run.status) || (effect && effect !== 'prepared')) throw new AppError('RECONCILIATION_REQUIRED', '외부 반영 여부를 확인한 뒤 재시도해야 합니다. 이 작업을 자동으로 다시 보내지 않습니다.', 409);
      this.db.prepare("UPDATE runs SET status='queued',error=NULL,finished_at=NULL,updated_at=? WHERE id=?").run(this.iso(), id);
      return this.getRun(id)!;
    });
  }
  reconcile(id: string, expectedUpdatedAt: string, status: 'succeeded' | 'failed' | 'waiting_external' | 'action_required', evidence: Record<string, unknown>): Run {
    prohibitSecrets(evidence);
    return this.transaction(() => {
      const run = this.getRun(id);
      if (!run || !['waiting_external', 'action_required'].includes(run.status) || run.updatedAt !== expectedUpdatedAt) {
        throw new AppError('STALE_RECONCILIATION', '다른 작업이 상태를 갱신했습니다. 최신 상태를 다시 확인해 주세요.', 409);
      }
      const result = { ...run.result, reconciliation: evidence };
      this.db.prepare('UPDATE runs SET status=?,result_json=?,error=?,updated_at=?,finished_at=? WHERE id=?')
        .run(status, JSON.stringify(result), status === 'failed' ? '서비스에서 처리 실패를 확인했습니다.' : null, this.iso(), ['succeeded','failed'].includes(status) ? this.iso() : null, id);
      if (this.effectState(id)) this.db.prepare('UPDATE effects SET state=?,updated_at=? WHERE run_id=?')
        .run(status === 'succeeded' ? 'confirmed' : status === 'failed' ? 'resolved_failed' : 'action_required', this.iso(), id);
      this.addEventDirect({ projectId: run.projectId, runId: id, kind: 'reconciled', message: (evidence.method==='operator-confirmed'?'서비스에서 확인한 운영자 판단을 기록했습니다: ':'외부 서비스를 조회해 작업 상태를 확인했습니다: ') + status, level: status === 'failed' ? 'error' : 'info', data: evidence });
      return this.getRun(id)!;
    });
  }
  resumeConnection(id: string): number {
    return this.transaction(() => {
      const candidates = this.db.prepare("SELECT r.*,e.state AS effect_state FROM runs r LEFT JOIN effects e ON e.run_id=r.id WHERE r.connection_id=? AND r.status='action_required'").all(id) as Row[];
      let resumed = 0;
      for (const row of candidates) {
        const run = runFrom(row);
        if (row.effect_state && row.effect_state !== 'prepared') continue;
        if (!['AUTH_REQUIRED','AUTH_REVOKED','VAULT_LOCKED','VAULT_UNAVAILABLE','KEY_MISSING','PERMISSION_REQUIRED'].includes(String(run.result?.failureCode))) continue;
        this.db.prepare("UPDATE runs SET status='queued',error=NULL,finished_at=NULL,updated_at=? WHERE id=?").run(this.iso(), run.id);
        this.addEventDirect({ projectId: run.projectId, runId: run.id, kind: 'connection.resumed', message: '연결이 복구되어 전송 전 대기 작업을 이어서 실행합니다.' });
        resumed++;
      }
      return resumed;
    });
  }
  addEvent(event: { projectId?: string | null; runId?: string | null; kind: string; message: string; level?: Severity; data?: Record<string, unknown> | null }): void {
    this.transaction(() => this.addEventDirect(event));
  }
  private addEventDirect(event: { projectId?: string | null; runId?: string | null; kind: string; message: string; level?: Severity; data?: Record<string, unknown> | null }): void {
    if (event.data) prohibitSecrets(event.data);
    this.db.prepare('INSERT INTO events(project_id,run_id,kind,message,level,data_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(event.projectId ?? null, event.runId ?? null, event.kind, redact(event.message), event.level ?? 'info', event.data ? JSON.stringify(event.data) : null, this.iso());
  }
  events(limit = 200): TimelineEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(row => ({
      id: Number(row.id), projectId: row.project_id as string | null, runId: row.run_id as string | null,
      kind: String(row.kind), message: String(row.message), level: row.level as Severity,
      data: row.data_json ? JSON.parse(String(row.data_json)) : null, createdAt: String(row.created_at),
    }));
  }
  history(options: { kind: 'runs' | 'events'; before?: number; projectId?: string; runId?: string; status?: string; limit?: number }): HistoryPage {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const filters: string[] = []; const values: (string | number)[] = [];
    if (options.before) { filters.push('rowid < ?'); values.push(options.before); }
    if (options.projectId) { filters.push('project_id=?'); values.push(options.projectId); }
    if (options.runId && options.kind === 'events') { filters.push('run_id=?'); values.push(options.runId); }
    if (options.status && options.kind === 'runs') { filters.push('status=?'); values.push(options.status); }
    const table = options.kind === 'events' ? 'events' : 'runs';
    const rows = this.db.prepare(`SELECT rowid AS cursor_id,* FROM ${table}${filters.length ? ' WHERE ' + filters.join(' AND ') : ''} ORDER BY rowid DESC LIMIT ?`).all(...values, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? Number(page.at(-1)!.cursor_id) : null;
    if (options.kind === 'runs') return { runs: page.map(runFrom), events: [], nextCursor };
    return { runs: [], events: page.map(row => ({ id: Number(row.id), projectId: row.project_id as string | null,
      runId: row.run_id as string | null, kind: String(row.kind), message: String(row.message), level: row.level as Severity,
      data: row.data_json ? JSON.parse(String(row.data_json)) : null, createdAt: String(row.created_at) })), nextCursor };
  }
  close(): void {
    if (this.closed) return;
    clearInterval(this.heartbeat);
    try { this.db.prepare('DELETE FROM controller WHERE id=1 AND owner=?').run(this.owner); } finally { this.db.close(); this.closed = true; }
  }
}
