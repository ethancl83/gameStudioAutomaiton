import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../packages/storage/index.js';
import { JobQueue } from '../apps/controller/queue.js';
import { GrowthOperations } from '../apps/controller/growth.js';

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atomic-store-'));
  const store = new Store(directory, { heartbeat: false });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}
const intent = { projectId: 'p', connectionId: 'c', kind: 'create-campaign', label: 'write', input: { name: 'one' }, writeEffect: true, idempotencyKey: 'growth_fixture' };

test('enqueue rolls back run/effect/provenance/business docs and never wakes before commit', t => {
  const { store } = setup(t); let wakes = 0;
  store.db.exec("CREATE TRIGGER fault BEFORE INSERT ON documents WHEN NEW.kind='pricing-change' BEGIN SELECT RAISE(ABORT,'disk fault'); END");
  const reserve = () => store.transaction(() => {
    const run = store.createRun(intent, run => store.put('growth-run', run.id, { runId: run.id, mandateId: 'm', safety: false, at: '' }));
    store.afterCommit(() => { wakes++; assert.ok(store.get('pricing-change', 'price')); });
    assert.equal(wakes, 0);
    store.put('pricing-change', 'price', { runId: run.id });
    return run;
  });
  assert.throws(reserve, /disk fault/); assert.equal(store.runs().length, 0); assert.equal(store.list('growth-run').length, 0); assert.equal(wakes, 0);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM effects').get() as {n:number}).n, 0);
  store.db.exec('DROP TRIGGER fault'); const run = reserve();
  assert.equal(wakes, 1); assert.equal(store.effectState(run.id), 'prepared');
});

test('idempotent reuse checks provenance and missing growth provenance fails closed', t => {
  const { store } = setup(t);
  const growth = new GrowthOperations(store, { mode: 'live', action: () => { throw Error('unused'); }, cancel: () => {}, supported: () => true });
  const first = store.createRun(intent, (run, reused) => growth.track(run, 'first', false, undefined, reused));
  assert.equal(store.createRun(intent, (run, reused) => growth.track(run, 'first', false, undefined, reused)).id, first.id);
  assert.throws(() => store.createRun({ ...intent, idempotencyKey: 'growth_second' }, (run, reused) => growth.track(run, 'second', false, undefined, reused)), { code: 'PROVENANCE_CONFLICT' });
  assert.equal(store.document('growth-run', first.id)?.mandateId, 'first');
  store.remove('growth-run', first.id);
  assert.throws(() => growth.assertDispatch(first), { code: 'PROVENANCE_REQUIRED' });
  assert.throws(() => store.createRun(intent, (run, reused) => growth.track(run, 'first', false, undefined, reused)), { code: 'PROVENANCE_CONFLICT' });
});

async function drain(queue: JobQueue) {
  for (let i = 0; i < 100 && queue.activeCount; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(queue.activeCount, 0);
}
for (const fault of ['documents', 'completion', 'events'] as const) test(`settlement ${fault} failure rolls back results, halts queue, and restart never resends`, async t => {
  const { store, directory } = setup(t); let sends = 0;
  const run = store.createRun(intent);
  if (fault === 'documents') store.db.exec("CREATE TRIGGER fault BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'settlement fault'); END");
  if (fault === 'completion') store.db.exec("CREATE TRIGGER fault BEFORE UPDATE ON runs WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'settlement fault'); END");
  if (fault === 'events') store.db.exec("CREATE TRIGGER fault BEFORE INSERT ON events WHEN NEW.kind='succeeded' BEGIN SELECT RAISE(ABORT,'settlement fault'); END");
  const queue = new JobQueue(store, async (_run, context) => { context.markDispatched(); sends++; return { result: { ok: true }, commit: () => store.put('settings', 'result', { ok: true }) }; }, 1);
  queue.tick(); await drain(queue);
  assert.match(queue.error ?? '', /settlement fault/); assert.equal(store.get('settings', 'result'), undefined);
  assert.equal(store.getRun(run.id)?.status, 'running'); assert.equal(store.effectState(run.id), 'dispatched');
  assert.ok(store.events().some(event => event.kind === 'queue.halted'));
  const next = store.createRun({ kind: 'read', label: 'next', input: {} }); queue.tick(); assert.equal(store.getRun(next.id)?.status, 'queued');
  await queue.stop(); store.db.exec('DROP TRIGGER fault'); store.close();
  const reopened = new Store(directory, { heartbeat: false }); t.after(() => reopened.close());
  assert.equal(reopened.getRun(run.id)?.status, 'action_required'); assert.equal(sends, 1);
  assert.throws(() => reopened.retry(run.id), { code: 'RECONCILIATION_REQUIRED' });
});

test('reconciliation target, result docs and checking run roll back together', async t => {
  const { store } = setup(t); const original = store.createRun(intent); const claimed = store.claim()!;
  store.markDispatched(original.id, claimed.token); store.finish(original.id, claimed.token, 'waiting_external');
  const expected = store.getRun(original.id)!;
  const check = store.createRun({ kind: 'reconcile', label: 'check', input: { targetRunId: original.id } });
  store.db.exec(`CREATE TRIGGER fault BEFORE UPDATE ON runs WHEN NEW.id='${check.id}' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'check fault'); END`);
  const queue = new JobQueue(store, async () => ({ result: {}, commit: () => { store.put('settings', 'collected', {}); store.reconcile(original.id, expected.updatedAt, 'succeeded', { checked: true }); } }));
  queue.tick(); await drain(queue); assert.ok(queue.error); assert.equal(store.get('settings', 'collected'), undefined);
  assert.equal(store.getRun(original.id)?.status, 'waiting_external'); assert.equal(store.effectState(original.id), 'dispatched');
  assert.equal(store.getRun(check.id)?.status, 'running'); await queue.stop();
});

test('fencing is expected and does not report a queue storage failure', async t => {
  const { store } = setup(t); const run = store.createRun({ kind: 'read', label: 'read', input: {} });
  const queue = new JobQueue(store, async () => { store.cancel(run.id); return { result: {}, commit: () => store.put('settings', 'late', {}) }; });
  queue.tick(); await drain(queue); assert.equal(queue.error, undefined); assert.equal(store.get('settings', 'late'), undefined); await queue.stop();
});

test('100001 later successes never hide older active work or effects independent of run status', t => {
  const { store } = setup(t); const old = store.createRun({ ...intent, input: { runnerId: 'runner', targetRunId: 'target', pipelineId: 'pipeline' } });
  const claim = store.claim()!; store.markDispatched(old.id, claim.token);
  store.db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100001)
    INSERT INTO runs(id,kind,label,status,input_json,input_hash,created_at,updated_at,lock_key)
    SELECT 'history-'||i,'read','history','succeeded','{}','hash','2099-01-01','2099-01-01','history' FROM n`);
  assert.equal(store.runs(100000).some(run => run.id === old.id), false);
  assert.equal(store.hasRuns({ projectId: 'p', statuses: ['running'] }), true);
  assert.equal(store.hasRuns({ runnerId: 'runner', statuses: ['running'] }), true);
  assert.equal(store.findRuns({ targetRunId: 'target' })[0]?.id, old.id);
  assert.equal(store.findRuns({ pipelineId: 'pipeline' })[0]?.id, old.id);
  store.db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(old.id);
  assert.equal(store.unresolvedEffects({ projectId: 'p' })[0]?.id, old.id);
  assert.equal(store.unresolvedEffects({ connectionId: 'c' })[0]?.id, old.id);
  assert.deepEqual(store.unresolvedEffects({ projectId: 'unrelated' }), []);
});

test('schema v0/v1 open compatibly; newer version is rejected without changing it', t => {
  for (const version of [0, 1, 2, 99]) {
    const directory = mkdtempSync(join(tmpdir(), 'schema-version-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'operations.sqlite'); const db = new DatabaseSync(path); db.exec(`PRAGMA user_version=${version}`); db.close();
    if (version > 1) assert.throws(() => new Store(directory, { heartbeat: false }), { code: 'UNSUPPORTED_DATABASE_VERSION' });
    else { const store = new Store(directory, { heartbeat: false }); store.put('settings', 'small', { unchanged: true }); store.close(); }
    const read = new DatabaseSync(path); assert.equal(Number(read.prepare('PRAGMA user_version').get()!.user_version), version > 1 ? version : 1); read.close();
  }
});

test('typed document identities reject wrong kind payloads and generic settings remain compatible', t => {
  const { store } = setup(t);
  const source = { runId: 'run', mandateId: 'm', safety: false, at: '' };
  store.putDocument('growth-run', 'run', source); assert.deepEqual(store.document('growth-run', 'run'), source);
  assert.throws(() => store.putDocument('growth-run', 'different', source), { code: 'INVALID_DOCUMENT' });
  store.put('growth-run', 'bad', { id: 'bad', provider: 'x' }); assert.throws(() => store.document('growth-run', 'bad'), { code: 'INVALID_DOCUMENT' });
  store.put('settings', 'tiny', false); assert.equal(store.get('settings', 'tiny'), false);
  store.put('pricing-change', 'a', { projectId: 'a' }); store.put('pricing-change', 'b', { projectId: 'b' });
  assert.deepEqual(store.documents('pricing-change', { projectId: 'a' }), [{ projectId: 'a' }]);
});
