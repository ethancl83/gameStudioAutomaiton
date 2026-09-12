import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/storage/index.js';
import { DEFAULT_POLICY, type Connection, type Project, type Run } from '../packages/domain/index.js';
import { AutomationScheduler, projectFingerprint } from '../apps/controller/automation.js';

test('file watcher debounces changes and keeps scheduling identity across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-automation-'));
  const root = await mkdtemp(join(tmpdir(), 'appops-watch-'));
  let clock = 1_000_000;
  const store = new Store(directory, { heartbeat: false });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'project.godot'), 'config_version=5');
  const project: Project = { id: 'project', name: 'Watch', rootPath: root, engine: 'godot', engineVersion: '4', appIdentifier: null,
    targets: ['linux'], findings: [], inspectedAt: '', createdAt: '', updatedAt: '', policy: { ...DEFAULT_POLICY, autoBuild: true } };
  store.put('project', project.id, project);
  let builds = 0;
  const actions = { build: () => { builds++; return {} as Run; }, action: () => ({} as Run), reconcile: () => ({} as Run), supported: () => false };
  const scheduler = new AutomationScheduler(store, actions, () => clock);
  scheduler.start(); await scheduler.tick(); assert.equal(builds, 0);
  clock += 30_000; await scheduler.tick(); assert.equal(builds, 1);
  await scheduler.tick(); assert.equal(builds, 1);
  const before = await projectFingerprint(root);
  await writeFile(join(root, '.env'), 'PRIVATE=value');
  assert.equal(await projectFingerprint(root), before);
  await scheduler.stop();
  const resumed = new AutomationScheduler(store, actions, () => clock);
  resumed.start(); await resumed.tick(); assert.equal(builds, 1);
  await writeFile(join(root, 'project.godot'), 'config_version=5\n[application]');
  clock += 30_000; await resumed.tick(); assert.equal(builds, 1);
  clock += 30_000; await resumed.tick(); assert.equal(builds, 2);
  await resumed.stop();
});
test('automatic release only considers new successful matching builds and does not multiply after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-release-'));
  const store = new Store(directory, { heartbeat: false });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const project: Project = { id: 'project', name: 'Release', rootPath: directory, engine: 'android', engineVersion: null, appIdentifier: 'com.test.app',
    targets: ['android'], findings: [], inspectedAt: '', createdAt: '', updatedAt: '', policy: { ...DEFAULT_POLICY, autoRelease: true, allowedConnectionIds: ['play'] } };
  store.put('project', project.id, project);
  store.put<Connection>('connection', 'play', { id: 'play', provider: 'google-play', label: 'Play', accountId: 'account', status: 'connected',
    createdAt: '', updatedAt: '', lastCheckedAt: null, lastError: null, authKind: 'OAuth', credentialFields: [] });
  const first = store.createRun({ projectId: project.id, kind: 'build', label: 'Old', input: { target: 'android' } });
  const oldClaim = store.claim()!; store.finish(first.id, oldClaim.token, 'succeeded', { target: 'android' });
  store.put('settings', 'auto-release-since:project', { at: Date.now() + 1000 });
  let uploads = 0; const keys: string[] = [];
  const actions = { build: () => ({} as Run), action: (_id: string, input: unknown) => { uploads++; keys.push((input as { idempotencyKey: string }).idempotencyKey); return {} as Run; },
    reconcile: () => ({} as Run), supported: () => false };
  const scheduler = new AutomationScheduler(store, actions);
  scheduler.start(); await scheduler.tick(); assert.equal(uploads, 0);
  store.put('settings', 'auto-release-since:project', { at: 0 });
  await scheduler.tick(); assert.equal(uploads, 1); assert.match(keys[0], /^auto_/);
  await scheduler.stop();
  const resumed = new AutomationScheduler(store, actions);
  resumed.start(); await resumed.tick(); assert.equal(uploads, 1); await resumed.stop();
});
