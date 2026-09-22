import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { JobQueue, type RunHandler } from '../apps/controller/queue.js';
import { startController } from '../apps/controller/server.js';
import { CredentialVault } from '../packages/credentials/index.js';
import { AppError } from '../packages/domain/errors.js';
import { Store } from '../packages/storage/index.js';
import { dockerKeyCleanupFailure } from '../packages/build-credentials/cleanup.js';

const recovery = { containerId: 'a'.repeat(64), operationId: '11111111-2222-4333-8444-555555555555' };
const cleanupError = () => new AppError('DOCKER_KEY_CLEANUP_FAILED', 'do not expose fixture-secret', 400,
  { ...recovery, privateKey: 'fixture-secret', endpoint: 'fixture-secret' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: TestContext, handler: RunHandler, unblock: () => void) {
  const root = await mkdtemp(join(tmpdir(), 'appops-key-consumer-'));
  const store = new Store(root, { heartbeat: false });
  const queue = new JobQueue(store, handler);
  t.after(async () => { unblock(); await queue.stop(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, queue };
}
async function idle(queue: JobQueue) {
  const deadline = Date.now() + 3000;
  while (queue.activeCount && Date.now() < deadline) await setTimeout(5);
  assert.equal(queue.activeCount, 0);
}

test('cleanup recovery exposes only validated public identifiers and a fixed message', () => {
  const safe = dockerKeyCleanupFailure(cleanupError())!;
  assert.deepEqual(safe.details, recovery);
  assert.ok(safe.message.includes(recovery.containerId));
  assert.ok(!JSON.stringify(safe).includes('fixture-secret'));
  assert.deepEqual(dockerKeyCleanupFailure(new AppError('DOCKER_KEY_CLEANUP_FAILED', 'secret', 400,
    { containerId: 'secret', operationId: 'secret' }))!.details, {});
  assert.equal(dockerKeyCleanupFailure(new AppError('OTHER', 'other', 400, recovery)), undefined);
});

for (const mode of ['failure', 'cancel', 'stop'] as const) {
  test(`build ${mode} persists cleanup failure and recovery identifiers after the worker settles`, async t => {
    const started = deferred(); const release = deferred();
    const { store, queue, root } = await fixture(t, async (_run, context) => {
      started.resolve(); await release.promise;
      if (mode !== 'failure') assert.equal(context.signal.aborted, true);
      throw cleanupError();
    }, release.resolve);
    const run = store.createRun({ kind: 'build', projectId: 'fixture', label: 'key cleanup', input: {} });
    queue.tick(); await started.promise;
    let stopping: Promise<void> | undefined;
    if (mode === 'cancel') assert.equal(queue.cancel(run.id).status, 'running');
    if (mode === 'stop') stopping = queue.stop();
    release.resolve(); await stopping; await idle(queue);
    const result = store.getRun(run.id)!;
    assert.equal(result.status, 'action_required');
    assert.equal(result.result?.failureCode, 'DOCKER_KEY_CLEANUP_FAILED');
    assert.deepEqual(result.result?.cleanup, recovery);
    assert.ok(result.error?.includes(recovery.operationId));
    assert.ok(!JSON.stringify(store.events()).includes('fixture-secret'));
    assert.throws(() => store.retry(run.id), { code: 'RECONCILIATION_REQUIRED' });
    store.close();
    const restored = new Store(root, { heartbeat: false });
    try {
      assert.deepEqual(restored.getRun(run.id)?.result?.cleanup, recovery);
      assert.ok(restored.events().some(event => event.data?.containerId === recovery.containerId));
    } finally { restored.close(); }
  });
}

test('build pre-commit cancellation preserves bytes and does not release the project lock early', async t => {
  const started = deferred(); const release = deferred(); let artifact = '';
  const { store, queue, root } = await fixture(t, async (_run, context) => {
    started.resolve(); await release.promise;
    if (context.signal.aborted) throw new AppError('CANCELLED', 'cancelled');
    await writeFile(artifact, 'signed');
    return { result: {} };
  }, release.resolve);
  artifact = join(root, 'artifact.aab'); await writeFile(artifact, 'original');
  const run = store.createRun({ kind: 'build', projectId: 'fixture', label: 'before commit', input: {} });
  queue.tick(); await started.promise;
  store.createRun({ kind: 'build', projectId: 'fixture', label: 'next build', input: {} });
  assert.equal(queue.cancel(run.id).status, 'running');
  assert.equal(store.claim(), undefined);
  release.resolve(); await idle(queue);
  assert.equal(store.getRun(run.id)?.status, 'cancelled');
  assert.equal(await readFile(artifact, 'utf8'), 'original');
});

test('build cancellation after commit preserves the successful signature and its checkpoint', async t => {
  const committed = deferred(); const release = deferred(); let artifact = '';
  const signatures = [{ keyId: 'fixture', version: 1, fingerprint: 'public', format: 'aab' }];
  const { store, queue, root } = await fixture(t, async (_run, context) => {
    await writeFile(artifact, 'signed'); committed.resolve(); await release.promise;
    assert.equal(context.signal.aborted, true);
    context.checkpoint({ signatures });
    return { result: { signatures, artifacts: [{ path: artifact }] } };
  }, release.resolve);
  artifact = join(root, 'artifact.aab'); await writeFile(artifact, 'original');
  const run = store.createRun({ kind: 'build', label: 'after commit', input: {} });
  queue.tick(); await committed.promise;
  assert.equal(queue.cancel(run.id).status, 'running');
  release.resolve(); await idle(queue);
  assert.equal(store.getRun(run.id)?.status, 'succeeded');
  assert.deepEqual(store.getRun(run.id)?.result?.signatures, signatures);
  assert.equal(await readFile(artifact, 'utf8'), 'signed');
});

test('external dispatched writes retain immediate cancellation and late-result fencing', async t => {
  const started = deferred(); const release = deferred();
  const { store, queue } = await fixture(t, async (_run, context) => {
    context.markDispatched(); started.resolve(); await release.promise;
    return { result: { late: true } };
  }, release.resolve);
  const run = store.createRun({ connectionId: 'fixture', kind: 'publish', label: 'external effect', input: {}, writeEffect: true, idempotencyKey: 'key-cancel-write' });
  queue.tick(); await started.promise;
  assert.equal(queue.cancel(run.id).status, 'action_required');
  release.resolve(); await idle(queue);
  assert.equal(store.getRun(run.id)?.status, 'action_required');
  assert.equal(store.getRun(run.id)?.result, null);
});

test('credential HTTP failure returns and journals only public cleanup recovery metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appops-key-api-')); let key: Buffer | undefined;
  const vault = new CredentialVault(join(root, 'vault'), { keyProvider: { name: 'test', getKey: async () => key, setKey: async value => { key = value; } } });
  const controller = await startController({ directory: root, port: 0, vault, connectors: [], scanToolchains: async () => [] });
  t.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  controller.service.saveBuildCredential = async () => { throw cleanupError(); };
  const response = await fetch(`http://127.0.0.1:${controller.port}/api/build-credentials`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + controller.token, 'Content-Type': 'application/json' }, body: '{}',
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'DOCKER_KEY_CLEANUP_FAILED');
  assert.deepEqual(body.error.details, recovery);
  assert.ok(body.error.message.includes(recovery.containerId));
  assert.ok(!JSON.stringify(body).includes('fixture-secret'));
  assert.ok(controller.service.store.events().some(event => event.data?.operationId === recovery.operationId));
  controller.service.saveBuildCredential = async () => { throw new AppError('OTHER', 'normal error', 400, { privateKey: 'fixture-secret' }); };
  const other = await fetch(`http://127.0.0.1:${controller.port}/api/build-credentials`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + controller.token, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal((await other.json()).error.details, undefined);
});
