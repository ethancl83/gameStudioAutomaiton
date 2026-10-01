import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../packages/storage/index.js';
import { WebDeployments } from '../apps/controller/web-deployments.js';
import { git } from '../packages/development/git.js';
import type { StudioTerminals } from '../packages/development/terminal.js';
import type { Project } from '../packages/domain/index.js';
import type { WebDeployment } from '../packages/development/types.js';

async function setup(t: TestContext, stage: 'before' | 'after' | 'start' | 'none' = 'none') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'web-safe-'))); const source = join(directory, 'source'); await mkdir(source);
  const store = new Store(join(directory, 'db'), { heartbeat: false });
  await writeFile(join(source, 'index.html'), 'fixture'); await writeFile(join(source, '.gitignore'), '.vercel\n');
  await git(source, ['init']); await git(source, ['config', 'user.name', 'Fixture']); await git(source, ['config', 'user.email', 'fixture@example.test']);
  await git(source, ['add', '.']); await git(source, ['commit', '-m', 'fixture']);
  await mkdir(join(source, '.vercel')); await writeFile(join(source, '.vercel/project.json'), JSON.stringify({ projectId: 'fixture', orgId: 'team' }));
  let starts = 0;
  const terminals = {
    async open() {
      starts++;
      const doc = store.list<WebDeployment>('web-deployment')[0]!;
      const run = store.deploymentRun(doc.id)!;
      assert.equal(store.effectState(run.id), 'dispatched', 'journal precedes any CLI start');
      assert.equal(doc.dispatched, true); assert.equal(run.connectionId, null);
      if (stage === 'start') throw new Error('spawn ENOENT');
      if (stage === 'after') store.db.exec("CREATE TRIGGER fault BEFORE INSERT ON documents WHEN NEW.kind='web-deployment' AND json_extract(NEW.payload,'$.terminalId')='session' BEGIN SELECT RAISE(ABORT,'post-start fault'); END");
      return { id: 'session' };
    },
    async wait() { return 1; },
  } as unknown as StudioTerminals;
  if (stage === 'before') store.db.exec("CREATE TRIGGER fault BEFORE INSERT ON documents WHEN NEW.kind='web-deployment' AND json_extract(NEW.payload,'$.dispatched')=1 BEGIN SELECT RAISE(ABORT,'pre-start fault'); END");
  const deployments = new WebDeployments({ store, project: () => ({ id: 'p', rootPath: source } as Project) }, terminals, { requireTool: async () => 'fixture-cli' });
  t.after(async () => { await deployments.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, deployments, directory, starts: () => starts, head: (await git(source, ['rev-parse', 'HEAD'])).trim() };
}
for (const stage of ['before', 'after', 'start'] as const) test(`web CLI ${stage} fault preserves the correct durable boundary`, async t => {
  const { store, deployments, starts, head } = await setup(t, stage);
  const record = await deployments.deploy('p', 'vercel', false, head); await deployments.close();
  const run = store.deploymentRun(record.id)!;
  assert.equal(starts(), stage === 'before' ? 0 : 1);
  assert.equal(store.getRun(run.id)?.status, stage === 'before' ? 'failed' : 'action_required');
  assert.equal(store.effectState(run.id), stage === 'before' ? 'prepared' : 'action_required');
  assert.throws(() => store.retry(run.id), { code: 'RECONCILIATION_REQUIRED' });
  if (stage !== 'before') await assert.rejects(deployments.deploy('p', 'vercel', false, head), { code: 'DEPLOY_UNRESOLVED' });
});

test('concurrent deployments reserve once and restart never queues the CLI again', async t => {
  const { store, deployments, starts, head, directory } = await setup(t);
  const first = deployments.deploy('p', 'vercel', false, head);
  await assert.rejects(deployments.deploy('p', 'vercel', false, head), { code: 'DEPLOY_UNRESOLVED' });
  const record = await first; await deployments.close(); assert.equal(starts(), 1);
  store.close(); const restored = new Store(join(directory, 'db'), { heartbeat: false }); t.after(() => restored.close());
  assert.equal(restored.deploymentRun(record.id)?.status, 'action_required'); assert.equal(restored.claim(), undefined);
  assert.equal(restored.hasUnresolvedDeployment('p'), true); assert.equal(restored.unresolvedEffects({ projectId: 'p' }).length, 1);
});

test('legacy running and uncertain records remain blocking after recovery without synthetic connections', async t => {
  const { store, deployments, head } = await setup(t);
  store.put('web-deployment', 'legacy', { id: 'legacy', projectId: 'p', provider: 'vercel', production: false, status: 'running', terminalId: '', message: '', createdAt: '' });
  deployments.recover(); assert.equal(deployments.list()[0]?.status, 'action_required');
  assert.equal(store.list('connection').length, 0); assert.equal(store.deploymentRun('legacy'), undefined);
  await assert.rejects(deployments.deploy('p', 'vercel', false, head), { code: 'DEPLOY_UNRESOLVED' });
  store.put('web-deployment', 'legacy', { ...deployments.list()[0], status: 'uncertain' });
  assert.equal(store.hasUnresolvedDeployment('p'), true);
});

test('an operator cannot release or overlap a deployment while its CLI is still running', async t => {
  const { store, head, directory } = await setup(t);
  let finish!: (code: number) => void;
  const terminals = { open: async () => ({ id: 'live' }), wait: () => new Promise<number>(resolve => { finish = resolve; }) } as unknown as StudioTerminals;
  const deployments = new WebDeployments({ store, project: () => ({ id: 'p', rootPath: join(directory, 'source') } as Project) }, terminals, { requireTool: async () => 'fixture-cli' });
  const record = await deployments.deploy('p', 'vercel', false, head);
  assert.equal(deployments.activeForProject('p'), true);
  // A read-side provider check may temporarily expose action_required while the
  // local CLI has not exited; that does not authorize another local deployment.
  store.put('web-deployment', record.id, { ...record, status: 'action_required' });
  assert.throws(() => deployments.resolve(record.id), { code: 'BUSY' });
  await assert.rejects(deployments.deploy('p', 'vercel', false, head), { code: 'DEPLOY_UNRESOLVED' });
  finish(1); await deployments.close(); assert.equal(deployments.activeForProject('p'), false);
});

test('a delayed provider check preserves manual resolution when HTTP later returns 401', async t => {
  const { store } = await setup(t);
  const record: WebDeployment = { id: 'legacy', projectId: 'p', provider: 'vercel', production: false, status: 'action_required', terminalId: '', message: 'unknown', createdAt: '', url: 'https://fixture.vercel.app' };
  store.put('web-deployment', record.id, record);
  let queried!: () => void; const queryStarted = new Promise<void>(resolve => { queried = resolve; });
  let release!: (value: string) => void;
  const deployments = new WebDeployments({ store, project: () => ({} as Project) }, {} as StudioTerminals, {
    requireTool: async () => 'fixture-cli',
    command: async () => { queried(); return new Promise<string>(resolve => { release = resolve; }); },
    fetch: async () => new Response('protected', { status: 401 }),
  });
  const checking = deployments.check(record.id); await queryStarted;
  const resolved = deployments.resolve(record.id); assert.equal(resolved.resolved, true);
  release(JSON.stringify({ readyState: 'READY', id: 'provider-deployment' }));
  await checking;
  assert.equal(store.get<WebDeployment>('web-deployment', record.id)?.resolved, true);
  assert.equal(store.hasUnresolvedDeployment('p'), false);
});

for (const failure of ['provider', 'http'] as const) test(`a ${failure} read failure does not write an inferred deployment status`, async t => {
  const { store } = await setup(t);
  const record: WebDeployment = { id: 'legacy', projectId: 'p', provider: 'vercel', production: false, status: 'succeeded', terminalId: '', message: 'verified', createdAt: '', url: 'https://fixture.vercel.app' };
  store.put('web-deployment', record.id, record);
  const deployments = new WebDeployments({ store, project: () => ({} as Project) }, {} as StudioTerminals, {
    requireTool: async () => 'fixture-cli',
    command: async () => { if (failure === 'provider') throw new Error('provider read failed'); return JSON.stringify({ readyState: 'READY' }); },
    fetch: async () => { throw new Error('http read failed'); },
  });
  await assert.rejects(deployments.check(record.id), /read failed/);
  assert.deepEqual(store.get('web-deployment', record.id), record);
});

test('a failed provider-check document commit rolls back its effect resolution', async t => {
  const { store } = await setup(t);
  const record: WebDeployment = { id: 'deployment-fixture', projectId: 'p', provider: 'vercel', production: false, status: 'action_required', terminalId: '', message: 'unknown', createdAt: '', url: 'https://fixture.vercel.app' };
  const { run, token } = store.reserveDeployment('p', record.id);
  store.markDispatched(run.id, token); store.finish(run.id, token, 'action_required'); store.put('web-deployment', record.id, record);
  store.db.exec("CREATE TRIGGER check_fault BEFORE INSERT ON documents WHEN NEW.kind='web-deployment' BEGIN SELECT RAISE(ABORT,'check commit failed'); END");
  const deployments = new WebDeployments({ store, project: () => ({} as Project) }, {} as StudioTerminals, {
    requireTool: async () => 'fixture-cli', command: async () => JSON.stringify({ readyState: 'READY' }), fetch: async () => new Response('ready'),
  });
  await assert.rejects(deployments.check(record.id), /check commit failed/);
  assert.equal(store.effectState(run.id), 'action_required'); assert.equal(store.getRun(run.id)?.status, 'action_required');
  assert.deepEqual(store.get('web-deployment', record.id), record);
  store.db.exec('DROP TRIGGER check_fault');
  await deployments.check(record.id);
  assert.equal(store.effectState(run.id), 'confirmed'); assert.equal(store.getRun(run.id)?.status, 'succeeded');
});
