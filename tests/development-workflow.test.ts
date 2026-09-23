import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { git, gitState, fingerprint, verifiedCommit, safeDiff, recordBaseline } from '../packages/development/git.js';
import { sourceItem, github } from '../packages/development/github.js';
import { executable } from '../packages/development/process.js';
import { DevelopmentTasks } from '../apps/controller/development-tasks.js';
import type { AppService } from '../apps/controller/service.js';
import type { StudioTerminals } from '../packages/development/terminal.js';
import type { DevelopmentTask } from '../packages/development/types.js';
import type { TestContext } from 'node:test';

async function fixture(t: TestContext, setup?: (root: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'development-flow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repository');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.test']);
  await writeFile(join(root, 'code.txt'), 'initial\n');
  await setup?.(root);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'initial']);
  const base = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const worktree = join(directory, 'task', 'worktree');
  await git(root, ['worktree', 'add', '-b', 'appops/fixture', worktree, base]);
  await recordBaseline(worktree, dirname(worktree), base);
  return { directory, root, worktree, base };
}

test('verified commit stores tested bytes without invoking hooks', async t => {
  const f = await fixture(t);
  const marker = join(f.directory, 'executed');
  await mkdir(join(f.worktree, '.hooks'));
  await writeFile(join(f.worktree, '.hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`);
  await git(f.worktree, ['config', 'core.hooksPath', '.hooks']);
  await writeFile(join(f.worktree, 'code.txt'), 'verified bytes\n');
  const expected = await fingerprint(f.worktree);
  assert.match(await safeDiff(f.worktree, dirname(f.worktree), f.base), /verified bytes/);
  const sha = await verifiedCommit(f.worktree, dirname(f.worktree), expected, f.base, 'appops/fixture', 'fixture');
  assert.equal((await git(f.worktree, ['rev-parse', 'HEAD'])).trim(), sha);
  assert.equal(await git(f.worktree, ['show', `${sha}:code.txt`]), 'verified bytes\n');
  await assert.rejects(readFile(marker));
});

test('changed files with clean filters are blocked without running the filter', async t => {
  const f = await fixture(t, root => writeFile(join(root, '.gitattributes'), 'code.txt filter=attack\n'));
  const marker = join(f.directory, 'filter-executed');
  await git(f.worktree, ['config', 'filter.attack.clean', `touch ${marker}`]);
  await writeFile(join(f.worktree, 'code.txt'), 'changed\n');
  const expected = await fingerprint(f.worktree);
  await assert.rejects(verifiedCommit(f.worktree, dirname(f.worktree), expected, f.base, 'appops/fixture', 'fixture'), /변환 속성/);
  await assert.rejects(readFile(marker));
});

test('untouched CRLF checkout bytes retain the base Git blob', async t => {
  const f = await fixture(t, async root => {
    await writeFile(join(root, '.gitattributes'), 'a.txt text eol=crlf\n');
    await writeFile(join(root, 'a.txt'), 'line\n');
  });
  assert.equal(await readFile(join(f.worktree, 'a.txt'), 'utf8'), 'line\r\n');
  await writeFile(join(f.worktree, 'code.txt'), 'changed\n');
  const diff = await safeDiff(f.worktree, dirname(f.worktree), f.base);
  assert.match(diff, /code.txt/);
  assert.doesNotMatch(diff, /a.txt/);
  const sha = await verifiedCommit(f.worktree, dirname(f.worktree), await fingerprint(f.worktree), f.base, 'appops/fixture', 'fixture');
  assert.equal(await git(f.worktree, ['show', `${sha}:a.txt`]), 'line\n');
});

test('untouched large asset keeps its Git blob while a source file changes', async t => {
  const f = await fixture(t, root => writeFile(join(root, 'asset.bin'), Buffer.alloc(21 * 1024 * 1024, 7)));
  await writeFile(join(f.worktree, 'code.txt'), 'changed\n');
  const sha = await verifiedCommit(f.worktree, dirname(f.worktree), await fingerprint(f.worktree), f.base, 'appops/fixture', 'fixture');
  assert.equal((await git(f.worktree, ['rev-parse', `${sha}:asset.bin`])).trim(), (await git(f.worktree, ['rev-parse', `${f.base}:asset.bin`])).trim());
});

test('PR source keeps every comment page, review and CI result', async () => {
  const requested: string[] = [];
  const api: typeof github = async <T>(endpoint: string, args: string[] = []): Promise<T> => {
    requested.push(endpoint);
    if (endpoint.endsWith('/pulls/7')) return { title: 'PR', body: 'details', url: 'https://github.com/owner/repo/pull/7', head: { sha: 'a'.repeat(40) } } as T;
    if (endpoint.includes('/check-runs')) return [{ check_runs: [{ name: 'test', conclusion: 'success' }] }] as T;
    if (endpoint.endsWith('/status')) return { state: 'success' } as T;
    assert.deepEqual(args, ['--paginate', '--slurp']);
    return [[{ page: 1 }], [{ page: 2 }]] as T;
  };
  const result = await sourceItem('owner/repo', 'pr', 7, api);
  assert.deepEqual(result.comments, [{ page: 1 }, { page: 2 }]);
  assert.deepEqual(result.reviewComments, [{ page: 1 }, { page: 2 }]);
  assert.deepEqual(result.reviews, [{ page: 1 }, { page: 2 }]);
  assert.deepEqual(result.files, [{ page: 1 }, { page: 2 }]);
  assert.equal(result.checks.length, 2);
  assert.ok(requested.some(endpoint => endpoint.includes('/pulls/7/reviews')));
  assert.ok(requested.some(endpoint => endpoint.includes('/commits/')));
});

test('non-repository folder has a distinct Git setup error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'development-no-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(gitState(root), { code: 'NOT_GIT_REPOSITORY' });
});

test('verified commit rejects a changed branch or file after verification', async t => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'code.txt'), 'verified\n');
  const expected = await fingerprint(f.worktree);
  await writeFile(join(f.worktree, 'code.txt'), 'later\n');
  await assert.rejects(verifiedCommit(f.worktree, dirname(f.worktree), expected, f.base, 'appops/fixture', 'fixture'), /검증 이후/);
  await writeFile(join(f.worktree, 'code.txt'), 'verified\n');
  await assert.rejects(verifiedCommit(f.worktree, dirname(f.worktree), expected, f.base, 'another-branch', 'fixture'), /branch|브랜치|ref/i);
});

test('aborted verified commit leaves the branch at its original SHA', async t => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'code.txt'), 'changed\n');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(verifiedCommit(f.worktree, dirname(f.worktree), await fingerprint(f.worktree), f.base, 'appops/fixture', 'fixture', true, abort.signal), /중지/);
  assert.equal((await git(f.worktree, ['rev-parse', 'HEAD'])).trim(), f.base);
});

test('automatic commit defers changed validation scripts and cleanup preserves branch', async t => {
  const f = await fixture(t);
  const records = new Map<string, unknown>();
  const key = (kind: string, id: string) => `${kind}:${id}`;
  const store = {
    get: (kind: string, id: string) => records.get(key(kind, id)),
    put: (kind: string, id: string, value: unknown) => { records.set(key(kind, id), value); return value; },
    list: (kind: string) => [...records].filter(([name]) => name.startsWith(`${kind}:`)).map(([, value]) => value),
    remove: (kind: string, id: string) => records.delete(key(kind, id)),
  };
  const service = { store, project: () => ({ id: 'project', rootPath: f.root, relinkRequired: false }), agent: { settings: () => ({}) } } as unknown as AppService;
  const tasks = new DevelopmentTasks(service, { list: () => [] } as unknown as StudioTerminals, f.directory);
  await mkdir(join(f.worktree, 'scripts'));
  await writeFile(join(f.worktree, 'scripts', 'check.mjs'), 'process.exit(0)\n');
  const task: DevelopmentTask = {
    id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: 'https://github.com/owner/repo/issues/1',
    worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1',
    status: 'ready', provider: 'codex', message: '', createdAt: '', updatedAt: '', verifiedFingerprint: await fingerprint(f.worktree), verifiedCommand: 'true',
  };
  store.put('development-task', task.id, task);
  store.put('development-gitdir', task.id, { path: (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim() });
  assert.equal((await readFile(join(f.worktree, '.git'), 'utf8')).trim().replace(/^gitdir: /, ''), (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim());
  store.put('settings', 'development:project', { autoImplement: false, autoCommit: true, autoPush: false, autoPr: false, autoPreview: false, testCommand: 'true' });
  const deferred = await tasks.commit(task.id, true);
  assert.equal(deferred.status, 'ready');
  assert.match(deferred.message, /승인/);
  const committed = await tasks.commit(task.id);
  assert.equal(committed.status, 'committed');
  const result = await tasks.cleanup(task.id);
  assert.deepEqual(result, { cleaned: true, branch: 'appops/fixture' });
  assert.equal(store.list('development-task').length, 0);
  assert.equal((await git(f.root, ['rev-parse', 'appops/fixture'])).trim(), committed.commitSha);
});

test('automatic commit defers a changed Makefile used by validation', async t => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'Makefile'), 'test:\n\ttrue\n');
  await assert.rejects(verifiedCommit(f.worktree, dirname(f.worktree), await fingerprint(f.worktree), f.base, 'appops/fixture', 'fixture', true), { code: 'MANUAL_APPROVAL_REQUIRED' });
});

test('automatic commit checks policy again after asynchronous fingerprinting', async t => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'code.txt'), 'changed\n');
  const records = new Map<string, unknown>();
  const setting = { autoImplement: false, autoCommit: true, autoPush: false, autoPr: false, autoPreview: false, testCommand: 'npm test' };
  const store = { get: (kind: string, id: string) => records.get(`${kind}:${id}`), put: (kind: string, id: string, value: unknown) => { records.set(`${kind}:${id}`, value); return value; }, list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value) };
  const service = { store, project: () => ({ id: 'project', rootPath: f.root, relinkRequired: false }) } as unknown as AppService;
  const hash = async (cwd: string) => { const value = await fingerprint(cwd); store.put('settings', 'development:project', { ...setting, autoCommit: false }); return value; };
  const tasks = new DevelopmentTasks(service, {} as StudioTerminals, f.directory, hash);
  store.put('development-task', 'task', { id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: '', worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1', status: 'ready', provider: 'codex', message: '', createdAt: '', updatedAt: '', verifiedFingerprint: await fingerprint(f.worktree), verifiedCommand: 'npm test' });
  store.put('development-gitdir', 'task', { path: (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim() });
  store.put('settings', 'development:project', setting);
  await assert.rejects(tasks.commit('task', true), { code: 'POLICY_CHANGED' });
  assert.equal((await git(f.worktree, ['rev-parse', 'HEAD'])).trim(), f.base);
});

test('automatic push rechecks policy after credential discovery', async t => {
  if (!await executable('github')) { t.skip('gh CLI is unavailable'); return; }
  const f = await fixture(t);
  let policyReads = 0;
  const gitdir = (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim();
  const task: DevelopmentTask = { id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: '', worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1', status: 'committed', provider: 'codex', message: '', createdAt: '', updatedAt: '', commitSha: f.base };
  const store = {
    get: (kind: string) => kind === 'settings' ? { autoImplement: false, autoCommit: false, autoPush: ++policyReads === 1, autoPr: false, autoPreview: false, testCommand: 'true' } : kind === 'development-task' ? task : kind === 'development-gitdir' ? { path: gitdir } : undefined,
    put: () => { throw new Error('push must not dispatch'); },
    list: () => [task],
  };
  const service = { store, project: () => ({ id: 'project', rootPath: f.root, relinkRequired: false }) } as unknown as AppService;
  const tasks = new DevelopmentTasks(service, {} as StudioTerminals, f.directory);
  await assert.rejects(tasks.push('task', true), { code: 'POLICY_CHANGED' });
  assert.equal(policyReads, 2);
});

test('fork PR cannot be committed or pushed to the source repository', async t => {
  const f = await fixture(t);
  const task: DevelopmentTask = { id: 'task', projectId: 'project', repository: 'owner/repo', number: 7, kind: 'pr', forkPr: true, title: 'Fork', url: '', worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-pr-7', status: 'ready', provider: 'codex', message: '', createdAt: '', updatedAt: '', verifiedFingerprint: await fingerprint(f.worktree), verifiedCommand: 'true' };
  const records = new Map<string, unknown>([['development-task:task', task]]);
  const store = { get: (kind: string, id: string) => records.get(`${kind}:${id}`), put: (kind: string, id: string, value: unknown) => { records.set(`${kind}:${id}`, value); return value; }, list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value) };
  const service = { store, project: () => ({ id: 'project', rootPath: f.root }) } as unknown as AppService;
  const tasks = new DevelopmentTasks(service, {} as StudioTerminals, f.directory);
  await assert.rejects(tasks.commit('task'), /fork PR/);
  store.put('development-task', 'task', { ...task, status: 'committed', commitSha: f.base });
  await assert.rejects(tasks.push('task'), /fork PR/);
});

test('cancel during terminal creation stops the new session before verification runs', async t => {
  const f = await fixture(t);
  const records = new Map<string, unknown>();
  const store = {
    get: (kind: string, id: string) => records.get(`${kind}:${id}`),
    put: (kind: string, id: string, value: unknown) => { records.set(`${kind}:${id}`, value); return value; },
    list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
  };
  let opening!: () => void;
  let release!: () => void;
  const opened = new Promise<void>(resolve => { opening = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  const terminals = {
    open: async () => { opening(); await gate; return { id: 'session' }; },
    stop: async () => { stopped = true; },
    list: () => [],
    wait: () => { throw new Error('verification must not run'); },
  } as unknown as StudioTerminals;
  const service = { store, project: () => ({ id: 'project', rootPath: f.root, relinkRequired: false }) } as unknown as AppService;
  const tasks = new DevelopmentTasks(service, terminals, f.directory);
  const task: DevelopmentTask = { id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: '', worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1', status: 'planned', provider: 'codex', message: '', createdAt: '', updatedAt: '' };
  store.put('development-task', task.id, task);
  store.put('development-gitdir', task.id, { path: (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim() });
  store.put('settings', 'development:project', { autoImplement: false, autoCommit: false, autoPush: false, autoPr: false, autoPreview: false, testCommand: 'true' });
  const running = tasks.start('task', 'verify');
  await opened;
  await tasks.cancel('task');
  release();
  await running;
  for (let i = 0; tasks.busy && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped, true);
  assert.equal(tasks.task('task').status, 'cancelled');
});

test('cancel after test exit cannot restore ready status during final fingerprint', async t => {
  const f = await fixture(t);
  const records = new Map<string, unknown>();
  const store = {
    get: (kind: string, id: string) => records.get(`${kind}:${id}`),
    put: (kind: string, id: string, value: unknown) => { records.set(`${kind}:${id}`, value); return value; },
    list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
  };
  let hashing!: () => void;
  let release!: () => void;
  const afterStarted = new Promise<void>(resolve => { hashing = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let hashes = 0;
  const hash = async (cwd: string) => {
    if (++hashes === 2) { hashing(); await gate; }
    return fingerprint(cwd);
  };
  const terminals = { open: async () => ({ id: 'session' }), wait: async () => 0, list: () => [], stop: async () => {} } as unknown as StudioTerminals;
  const service = { store, project: () => ({ id: 'project', rootPath: f.root, relinkRequired: false }) } as unknown as AppService;
  const tasks = new DevelopmentTasks(service, terminals, f.directory, hash);
  store.put('development-task', 'task', { id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: '', worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1', status: 'planned', provider: 'codex', message: '', createdAt: '', updatedAt: '' });
  store.put('development-gitdir', 'task', { path: (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim() });
  store.put('settings', 'development:project', { autoImplement: false, autoCommit: true, autoPush: true, autoPr: false, autoPreview: false, testCommand: 'true' });
  const running = tasks.start('task', 'verify');
  await afterStarted;
  await tasks.cancel('task');
  release();
  await running;
  for (let i = 0; tasks.busy && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(tasks.task('task').status, 'cancelled');
  assert.equal(tasks.task('task').commitSha, undefined);
});

test('cancel after Git ref update records the commit and prevents automatic push', async t => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'code.txt'), 'changed\n');
  const records = new Map<string, unknown>();
  const store = { get: (kind: string, id: string) => records.get(`${kind}:${id}`), put: (kind: string, id: string, value: unknown) => { records.set(`${kind}:${id}`, value); return value; }, list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value) };
  const service = { store, project: () => ({ id: 'project', rootPath: f.root, relinkRequired: false }) } as unknown as AppService;
  let committed!: () => void;
  let release!: () => void;
  const afterRef = new Promise<void>(resolve => { committed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const delayedCommit: typeof verifiedCommit = async (...args) => { const sha = await verifiedCommit(...args); committed(); await gate; return sha; };
  const tasks = new DevelopmentTasks(service, {} as StudioTerminals, f.directory, fingerprint, delayedCommit);
  const task: DevelopmentTask = { id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: '', worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1', status: 'ready', provider: 'codex', message: '', createdAt: '', updatedAt: '', verifiedFingerprint: await fingerprint(f.worktree), verifiedCommand: 'npm test' };
  store.put('development-task', 'task', task);
  store.put('development-gitdir', 'task', { path: (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim() });
  store.put('settings', 'development:project', { autoImplement: false, autoCommit: true, autoPush: true, autoPr: false, autoPreview: false, testCommand: 'npm test' });
  const running = tasks.commit('task', true);
  await afterRef;
  await tasks.cancel('task');
  release();
  const result = await running;
  assert.equal(result.status, 'committed');
  assert.equal(result.cancelledAfterCommit, true);
  assert.ok(result.commitSha);
  assert.match(result.message, /자동 푸시는 중지/);
});

test('agent refuses a tracked credential file before opening a terminal', async t => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, '.env'), 'TOKEN=fixture\n');
  await git(f.worktree, ['add', '.env']);
  const records = new Map<string, unknown>();
  const store = {
    get: (kind: string, id: string) => records.get(`${kind}:${id}`),
    put: (kind: string, id: string, value: unknown) => { records.set(`${kind}:${id}`, value); return value; },
    list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
  };
  const service = { store, project: () => ({ id: 'project', rootPath: f.root, relinkRequired: false }) } as unknown as AppService;
  const terminals = { open: () => { throw new Error('must not open terminal'); } } as unknown as StudioTerminals;
  const tasks = new DevelopmentTasks(service, terminals, f.directory);
  store.put('development-task', 'task', { id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: '', worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1', status: 'imported', provider: 'codex', message: '', createdAt: '', updatedAt: '' });
  store.put('development-gitdir', 'task', { path: (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim() });
  const result = await tasks.start('task', 'analyze');
  assert.equal(result.status, 'failed');
  assert.match(result.message, /인증 파일/);
});

test('restored task remains read only and cleanup preserves recovered files', async t => {
  const f = await fixture(t);
  const history = join(f.directory, 'restored-history');
  const docs = join(history, 'dev', 'active', 'github-issue-1');
  await mkdir(docs, { recursive: true });
  await writeFile(join(docs, 'plan.md'), 'Recovered plan');
  const records = new Map<string, unknown>();
  const store = {
    get: (kind: string, id: string) => records.get(`${kind}:${id}`),
    put: (kind: string, id: string, value: unknown) => { records.set(`${kind}:${id}`, value); return value; },
    list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value),
    remove: (kind: string, id: string) => records.delete(`${kind}:${id}`),
  };
  const service = { store, project: () => ({ id: 'project', rootPath: f.root }) } as unknown as AppService;
  const tasks = new DevelopmentTasks(service, {} as StudioTerminals, f.directory);
  const restored: DevelopmentTask = { id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: '', worktree: history, branch: 'appops/old', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1', restored: true, status: 'action_required', provider: 'codex', message: '', createdAt: '', updatedAt: '' };
  store.put('development-task', 'task', restored);
  assert.equal((await tasks.document('task', 'plan.md')).text, 'Recovered plan');
  await assert.rejects(tasks.document('task', 'context.md'), { code: 'DOCUMENT_NOT_READY' });
  await assert.rejects(tasks.start('task', 'verify'), /열람 전용/);
  await assert.rejects(tasks.commit('task'), /열람 전용/);
  assert.deepEqual(await tasks.cleanup('task'), { cleaned: true, preserved: true });
  assert.equal(await readFile(join(docs, 'plan.md'), 'utf8'), 'Recovered plan');
});

test('failed push is reconciled by remote SHA without sending another push', async t => {
  if (!await executable('github')) { t.skip('gh CLI is unavailable'); return; }
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'code.txt'), 'changed\n');
  const commitSha = await verifiedCommit(f.worktree, dirname(f.worktree), await fingerprint(f.worktree), f.base, 'appops/fixture', 'fixture');
  const bare = join(f.directory, 'remote.git');
  await mkdir(bare);
  await git(bare, ['init', '--bare']);
  const remoteUrl = `file://${bare}`;
  await git(f.worktree, ['config', `url.${remoteUrl}.insteadOf`, 'https://github.com/owner/repo.git']);
  await mkdir(join(bare, 'hooks'), { recursive: true });
  const marker = join(f.directory, 'push-attempts');
  const hook = join(bare, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh\necho attempt >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  const records = new Map<string, unknown>();
  const store = { get: (kind: string, id: string) => records.get(`${kind}:${id}`), put: (kind: string, id: string, value: unknown) => { records.set(`${kind}:${id}`, value); return value; }, list: (kind: string) => [...records].filter(([key]) => key.startsWith(`${kind}:`)).map(([, value]) => value) };
  const service = { store, project: () => ({ id: 'project', rootPath: f.root, relinkRequired: false }) } as unknown as AppService;
  const tasks = new DevelopmentTasks(service, {} as StudioTerminals, f.directory);
  store.put('development-task', 'task', { id: 'task', projectId: 'project', repository: 'owner/repo', number: 1, kind: 'issue', title: 'Fixture', url: '', worktree: f.worktree, branch: 'appops/fixture', base: f.base, sourceSha: f.base, documentPath: 'dev/active/github-issue-1', status: 'committed', provider: 'codex', message: '', createdAt: '', updatedAt: '', commitSha });
  store.put('development-gitdir', 'task', { path: (await git(f.worktree, ['rev-parse', '--absolute-git-dir'])).trim() });
  await assert.rejects(tasks.push('task'), /pre-receive hook declined|pre-receive hook failed|remote rejected/i);
  assert.equal(tasks.task('task').status, 'action_required');
  assert.equal((await readFile(marker, 'utf8')).trim(), 'attempt');
  const reconciled = await tasks.reconcilePush('task');
  assert.equal(reconciled.status, 'committed');
  assert.equal((await readFile(marker, 'utf8')).trim(), 'attempt');
});
