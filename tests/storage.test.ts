import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage/index.js';

function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'appops-db-'));
  const store = new Store(directory, { heartbeat: false });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}
test('report replacement commits atomically and rolls back deletion on failed insertion', t => {
  const { store } = setup(t); store.put('metric', 'old', { amountMicros: '100' });
  assert.throws(() => store.writeBatch([{ kind: 'metric', id: 'new', value: { invalid: 1n } }], [{ kind: 'metric', id: 'old' }]));
  assert.deepEqual(store.get('metric', 'old'), { amountMicros: '100' });
  assert.equal(store.get('metric', 'new'), undefined);
  store.writeBatch([{ kind: 'metric', id: 'new', value: { amountMicros: '-20' } }], [{ kind: 'metric', id: 'old' }]);
  assert.equal(store.get('metric', 'old'), undefined); assert.deepEqual(store.get('metric', 'new'), { amountMicros: '-20' });
});
test('external intent is durable, idempotent and rejects key reuse with different input', t => {
  const { store } = setup(t);
  const input = { connectionId: 'account', kind: 'create-campaign', label: '광고', input: { name: 'campaign' }, writeEffect: true, idempotencyKey: 'request-0001' };
  const first = store.createRun(input);
  assert.equal(store.createRun(input).id, first.id);
  assert.throws(() => store.createRun({ ...input, input: { name: 'other' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => store.createRun({ ...input, idempotencyKey: undefined }), { code: 'IDEMPOTENCY_REQUIRED' });
  assert.equal(store.effectState(first.id), 'prepared');
  assert.equal(store.runs().length, 1);
});
test('response loss survives restart and cannot be blindly retried', t => {
  const { store, directory } = setup(t);
  const run = store.createRun({ connectionId: 'account', kind: 'create-campaign', label: '광고', input: { name: 'test' }, writeEffect: true, idempotencyKey: 'request-0002' });
  const claimed = store.claim()!;
  store.markDispatched(run.id, claimed.token);
  store.close();
  const restored = new Store(directory, { heartbeat: false });
  t.after(() => restored.close());
  assert.equal(restored.getRun(run.id)?.status, 'action_required');
  assert.throws(() => restored.retry(run.id), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(restored.claim(), undefined);
});
test('same write intent with a new key is deduplicated during deferred retry', t => {
  const { store } = setup(t);
  const input = { connectionId: 'account', projectId: 'project', kind: 'create-product', label: '상품', input: { productId: 'coins' }, writeEffect: true, idempotencyKey: 'deferred-key-one' };
  const first = store.createRun(input); const claimed = store.claim()!;
  store.defer(first.id, claimed.token, '일시 오류', 60_000);
  assert.equal(store.getRun(first.id)?.status, 'retry_wait');
  assert.equal(store.createRun({ ...input, idempotencyKey: 'deferred-key-two' }).id, first.id);
  assert.equal(store.runs().length, 1);
});
test('connections serialize jobs and cancellation fences a late result', t => {
  const { store } = setup(t);
  const first = store.createRun({ connectionId: 'same', kind: 'read', label: 'A', input: {} });
  store.createRun({ connectionId: 'same', kind: 'read', label: 'B', input: {} });
  store.createRun({ connectionId: 'other', kind: 'read', label: 'C', input: {} });
  const one = store.claim()!;
  const two = store.claim()!;
  assert.equal(one.run.id, first.id);
  assert.equal(two.run.connectionId, 'other');
  assert.equal(store.claim(), undefined);
  store.cancel(first.id);
  assert.throws(() => store.finish(first.id, one.token, 'succeeded'), { code: 'RUN_FENCED' });
  assert.equal(store.claim()?.run.label, 'B');
});
test('second controller is denied and expired controller is fenced', t => {
  const directory = mkdtempSync(join(tmpdir(), 'appops-fence-'));
  let now = Date.now();
  const first = new Store(directory, { clock: () => now, heartbeat: false });
  assert.throws(() => new Store(directory, { clock: () => now, heartbeat: false }), { code: 'CONTROLLER_RUNNING' });
  now += 61_000;
  const second = new Store(directory, { clock: () => now, heartbeat: false });
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.throws(() => first.put('settings', 'item', {}), { code: 'CONTROLLER_FENCED' });
  second.put('settings', 'item', { valid: true });
  assert.deepEqual(second.get('settings', 'item'), { valid: true });
});
test('credentials cannot enter persisted job inputs or event details', t => {
  const { store } = setup(t);
  assert.throws(() => store.createRun({ kind: 'test', label: 'test', input: { nested: { accessToken: 'secret' } } }), { code: 'SECRET_IN_JOB' });
  assert.throws(() => store.addEvent({ kind: 'test', message: 'test', data: { apiKey: 'secret' } }), { code: 'SECRET_IN_JOB' });
});
test('write success cannot skip dispatch and safe authentication waits resume without resending an unknown effect', t => {
  const { store } = setup(t);
  const input = { connectionId: 'account', kind: 'create-campaign', label: '광고', input: {}, writeEffect: true, idempotencyKey: 'resume-auth-001' };
  const first = store.createRun(input); const claimed = store.claim()!;
  assert.throws(() => store.finish(first.id, claimed.token, 'succeeded', {}), { code: 'UNDISPATCHED_EFFECT' });
  store.finish(first.id, claimed.token, 'action_required', { failureCode: 'VAULT_LOCKED' });
  assert.equal(store.effectState(first.id), 'prepared'); assert.equal(store.resumeConnection('account'), 1);
  const resumed = store.claim()!; store.markDispatched(first.id, resumed.token);
  store.finish(first.id, resumed.token, 'action_required', { failureCode: 'AUTH_REQUIRED' });
  assert.equal(store.resumeConnection('account'), 0); assert.equal(store.getRun(first.id)?.status, 'action_required');
});
test('history pages preserve all records and filters across the live state window', t => {
  const { store } = setup(t);
  for (let index = 0; index < 240; index++) store.createRun({ projectId: index % 2 ? 'one' : 'two', kind: 'read', label: String(index), input: {} });
  const first = store.history({ kind: 'runs', projectId: 'one' });
  assert.equal(first.runs.length, 100); assert.ok(first.nextCursor);
  const second = store.history({ kind: 'runs', projectId: 'one', before: first.nextCursor! });
  assert.equal(second.runs.length, 20); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.runs, ...second.runs].map(run => run.id)).size, 120);
});
