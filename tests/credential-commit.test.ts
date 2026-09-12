import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppService } from '../apps/controller/service.js';
import { CredentialVault } from '../packages/credentials/index.js';
import { Store } from '../packages/storage/index.js';
import { DEFAULT_POLICY, type Connection, type ExternalResource, type Project } from '../packages/domain/index.js';

test('OAuth credentials and metadata recover after interrupted commit without another authorization exchange', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-oauth-commit-'));
  let store = new Store(directory, { heartbeat: false }); let master: Buffer | undefined;
  const vault = new CredentialVault(join(directory, 'vault'), { keyProvider: { name: 'test', getKey: async () => master, setKey: async key => { master = key; } } });
  let exchanges = 0;
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.x.com');
    if (url.pathname === '/2/oauth2/token') { exchanges++; return Response.json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 7200 }); }
    if (url.pathname === '/2/users/me') return Response.json({ data: { id: '12345' } });
    throw new Error('unexpected request');
  };
  let service = new AppService(store, vault, { fetch, scanToolchains: async () => [] });
  t.after(async () => { await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const begun = await service.beginSocialOAuth('x', { label: 'Test X', credentials: { clientId: 'test-client' } }, 'http://127.0.0.1:4317/api/oauth/social/callback');
  store.db.exec("CREATE TRIGGER fail_connection_event BEFORE INSERT ON events WHEN NEW.kind='connection.authorized' BEGIN SELECT RAISE(ABORT, 'synthetic connection commit failure'); END");
  await assert.rejects(service.completeSocialOAuth(new URL(begun.authorizationUrl).searchParams.get('state')!, 'fake-code'), /synthetic connection commit failure/);
  assert.equal(await vault.has(begun.connectionId), true);
  assert.equal(store.get('connection', begun.connectionId), undefined);
  assert.equal(store.list('connection-commit').length, 1);
  const journal = JSON.stringify(store.list('connection-commit'));
  assert.equal(journal.includes('fake-access'), false); assert.equal(journal.includes('fake-refresh'), false);
  store.db.exec('DROP TRIGGER fail_connection_event'); await service.stop(); store.close();
  store = new Store(directory, { heartbeat: false });
  service = new AppService(store, vault, { fetch, scanToolchains: async () => [] });
  const state = await service.state();
  assert.equal(state.connections.length, 1); assert.equal(state.connections[0]!.status, 'connected');
  assert.equal(state.connections[0]!.accountId, '12345'); assert.equal(exchanges, 1);
  assert.equal(store.list('connection-commit').length, 0);
  assert.equal(store.events().filter(event => event.kind === 'connection.authorized').length, 1);
  assert.equal(JSON.stringify(state).includes('fake-access'), false);
  assert.equal(state.connections[0]!.credentialFields.includes('_appOpsCommit'), false);
  await service.removeConnection(begun.connectionId); assert.equal(await vault.has(begun.connectionId), false);
});

test('an interrupted credential update cannot publish metadata for the previous ciphertext', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-credential-commit-')); const store = new Store(directory, { heartbeat: false });
  let master: Buffer | undefined;
  const vault = new CredentialVault(join(directory, 'vault'), { keyProvider: { name: 'test', getKey: async () => master, setKey: async key => { master = key; } } });
  const service = new AppService(store, vault); t.after(async () => { await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const connection = await service.addConnection({ provider: 'x', label: 'X', accountId: '123', credentials: { clientId: 'client', refreshToken: 'old-refresh' } });
  const set = vault.set.bind(vault); vault.set = async () => { throw new Error('synthetic vault failure'); };
  await assert.rejects(service.updateCredentials(connection.id, { credentials: { refreshToken: 'new-refresh', clientSecret: 'new-secret' } }), /synthetic vault failure/);
  vault.set = set;
  const state = await service.state();
  assert.deepEqual(state.connections[0]!.credentialFields, connection.credentialFields);
  assert.equal((await vault.get(connection.id)).refreshToken, 'old-refresh');
  assert.equal(store.list('connection-commit').length, 0);
});

test('Steam news on a shared connection keeps exact AppID attribution and separates repeated news IDs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-steam-news-')); const store = new Store(directory, { heartbeat: false });
  let master: Buffer | undefined;
  const vault = new CredentialVault(join(directory, 'vault'), { keyProvider: { name: 'test', getKey: async () => master, setKey: async key => { master = key; } } });
  const connection = { id: 'steam', provider: 'steam', accountId: '440', label: 'Steam', status: 'connected', credentialFields: ['apiKey', 'appId'] } as Connection;
  store.put('connection', connection.id, connection); await vault.set(connection.id, { apiKey: 'synthetic', appId: '440' });
  for (const appId of ['440', '570']) store.put('project', 'p' + appId, { id: 'p' + appId, name: appId, rootPath: directory, appIdentifier: appId, policy: DEFAULT_POLICY,
    engine: 'unknown', engineVersion: null, targets: [], findings: [], inspectedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    socialPolicy: { enabled: true, connectionIds: ['steam'], dailyPostLimit: 5, autoReleaseAnnouncements: false, releaseTemplate: 'test', autoReply: false, replyRules: [] } } as Project);
  const service = new AppService(store, vault, { fetch: async input => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://api.steampowered.com');
    return Response.json({ appnews: { appid: Number(url.searchParams.get('appid')), newsitems: [{ gid: '123456', title: 'Synthetic news', date: 1_700_000_000 }] } });
  } });
  t.after(async () => { await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  for (const [projectId, input] of [['p440', {}], ['p570', {}], ['p440', { appId: '730' }]] as const) {
    const run = service.action(connection.id, { operation: 'list-news', projectId, input });
    for (let attempt = 0; attempt < 200 && ['queued', 'running'].includes(store.getRun(run.id)!.status); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(store.getRun(run.id)!.status, 'succeeded');
  }
  const news = store.list<ExternalResource>('resource').filter(item => item.kind === 'news');
  assert.equal(news.length, 3);
  assert.deepEqual(Object.fromEntries(news.map(item => [item.data.appId, item.projectId])), { '440': 'p440', '570': 'p570', '730': null });
});

test('Threads container rejection is recorded as a confirmed failure without publishing or consuming future quota', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-threads-failure-')); const store = new Store(directory, { heartbeat: false });
  let master: Buffer | undefined; let publishes = 0;
  const vault = new CredentialVault(join(directory, 'vault'), { keyProvider: { name: 'test', getKey: async () => master, setKey: async key => { master = key; } } });
  const connection: Connection = { id: 'threads', provider: 'threads', accountId: '1000', label: 'Threads', status: 'connected', credentialFields: [], authKind: 'oauth2-longlived', lastCheckedAt: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  store.put('connection', connection.id, connection);
  await vault.set(connection.id, { threadsUserId: '1000', accessToken: 'fake-token', clientSecret: 'fake-secret', tokenObtainedAt: String(Date.now()), tokenExpiresAt: String(Date.now() + 30 * 86_400_000) });
  const project: Project = { id: 'project', name: 'Test', rootPath: directory, engine: 'unknown', engineVersion: null, appIdentifier: null, targets: [], findings: [], inspectedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), policy: DEFAULT_POLICY, socialPolicy: { enabled: true, connectionIds: ['threads'], dailyPostLimit: 1, autoReply: false, autoReleaseAnnouncements: false, releaseTemplate: 'test', replyRules: [] } };
  store.put('project', project.id, project);
  const service = new AppService(store, vault, { fetch: async input => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://graph.threads.net');
    if (url.pathname.endsWith('/me')) return Response.json({ id: '1000' });
    if (url.pathname.endsWith('/threads_publish')) { publishes++; throw new Error('must not publish'); }
    if (url.pathname.endsWith('/threads')) return Response.json({ id: '7000' });
    if (url.pathname.endsWith('/7000')) return Response.json({ id: '7000', status: 'ERROR', error_message: 'fake-secret' });
    throw new Error('unexpected request');
  } });
  t.after(async () => { await service.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const run = service.action(connection.id, { operation: 'create-post', projectId: project.id, input: { text: 'post' }, idempotencyKey: 'threads-terminal-failure' });
  for (let attempt = 0; attempt < 200 && ['queued', 'running'].includes(store.getRun(run.id)!.status); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  const finished = store.getRun(run.id)!;
  assert.equal(finished.status, 'failed'); assert.equal(publishes, 0);
  assert.equal(store.effectState(run.id), 'resolved_failed');
  assert.equal(JSON.stringify(finished).includes('fake-secret'), false);
  assert.throws(() => store.retry(run.id), { code: 'RECONCILIATION_REQUIRED' });
  assert.doesNotThrow(() => service.social.enforceWrite(project, connection, 'create-post', { text: 'new post' }));
});
