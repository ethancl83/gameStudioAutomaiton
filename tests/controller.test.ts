import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { startController } from '../apps/controller/server.js';
import { attestArtifact, stageSteamArtifacts } from '../apps/controller/service.js';
import { CredentialVault, type KeyProvider } from '../packages/credentials/index.js';
import { DEFAULT_POLICY, type ApiResult, type Connection, type Project, type Run } from '../packages/domain/index.js';
import type { Connector } from '../packages/connectors/types.js';
import { AppError } from '../packages/domain/errors.js';
import { xConnector } from '../packages/connectors/social.js';

async function setup(t: TestContext, connector?: Connector, fetcher?: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'appops-controller-'));
  const projectPath = await mkdtemp(join(tmpdir(), 'appops-project-'));
  let key: Buffer | undefined;
  const keyProvider: KeyProvider = { name: 'test-memory', getKey: async () => key, setKey: async value => { key = value; } };
  const vault = new CredentialVault(join(directory, 'credentials'), { keyProvider });
  const controller = await startController({ directory, port: 0, vault, connectors: connector ? [connector] : [],
    fetch: fetcher, scanToolchains: async () => [] });
  t.after(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); await rm(projectPath, { recursive: true, force: true }); });
  await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n[application]\nconfig/name="API 검증"\n');
  await writeFile(join(projectPath, 'export_presets.cfg'), '[preset.0]\nname="Android"\nplatform="Android"\n[preset.0.options]\npackage/unique_name="com.example.fixture"\n');
  async function api<T>(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${controller.port}/api${path}`, { method,
      headers: { Authorization: 'Bearer ' + controller.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() as ApiResult<T> };
  }
  return { controller, directory, projectPath, vault, api };
}
function unwrap<T>(value: ApiResult<T>): T { assert.equal(value.ok, true, JSON.stringify(value)); return (value as { ok: true; data: T }).data; }
const capability: Connector['capability'] = {
  provider: 'google-ads', name: 'Test Ads', category: 'marketing', description: '테스트 전용', authKind: 'OAuth',
  fields: [], operations: ['check', 'create-campaign', 'sync'], setupUrl: 'https://developers.google.com/google-ads/api/docs/start', limitations: [],
};
const credentials = { clientId: 'test-client', refreshToken: 'never-persist-this-secret' };

test('advertising creates reject a different project app before queuing or spending', async t => {
  for (const provider of ['google-ads','applovin-ads','applovin-max'] as const) {
    let writes = 0;
    const operation = provider === 'applovin-max' ? 'create-ad-unit' : 'create-campaign';
    const connector: Connector = {capability:{...capability,provider,operations:[operation]},async execute(_op,_input,ctx){ctx.markDispatched();writes++;return{summary:{}};}};
    const{api,projectPath,controller}=await setup(t,connector);
    const project=unwrap((await api<Project>('/projects','POST',{path:projectPath})).value);
    const connection=unwrap((await api<Connection>('/connections','POST',{provider,label:provider,accountId:'account',credentials:provider==='google-ads'?credentials:{}})).value);
    await api('/projects/'+project.id+'/policy','PUT',{...DEFAULT_POLICY,allowedConnectionIds:[connection.id],allowCampaignWrites:true,allowMonetizationWrites:true,maxDailyBudgetMicros:'9000000'});
    const result=await api('/connections/'+connection.id+'/actions','POST',{operation,projectId:project.id,input:{name:'Wrong app',dailyBudgetMicros:'1000000',currency:'USD',[provider==='google-ads'?'appId':'packageName']:'com.other.app'},idempotencyKey:'cross-app-create'});
    assert.equal(result.status,409);assert.equal(writes,0);assert.equal(controller.service.store.runs().length,0);
  }
});

test('live store inspection and review/branch reconciliation never resend the original mutation', async t => {
  for (const provider of ['app-store', 'steam'] as const) {
    let writes = 0;
    const operation = provider === 'app-store' ? 'submit-review' : 'set-live';
    const connector: Connector = { capability: {...capability, provider, category:'store', operations:['check','list-listings',operation,'reconcile']}, async execute(op,input,ctx) {
      if (op === operation) {ctx.markDispatched();writes++;ctx.checkpoint(provider==='app-store'?{appleReviewSubmissionId:'submission-42'}:{steamBuildId:'build-42',steamTrack:'beta'});return{waitingExternal:true,summary:{}};}
      if (op === 'reconcile') {assert.deepEqual(input,provider==='app-store'?{reviewSubmissionId:'submission-42'}:{buildId:'build-42',branch:'beta'});return{summary:{confirmed:true}};}
      return{summary:{count:0}};
    }};
    const{controller,api,projectPath}=await setup(t,connector);
    const project=unwrap((await api<Project>('/projects','POST',{path:projectPath})).value);
    const connection=unwrap((await api<Connection>('/connections','POST',{provider,label:provider,accountId:'test-account',credentials:{}})).value);
    await api('/projects/'+project.id+'/policy','PUT',{...DEFAULT_POLICY,allowedConnectionIds:[connection.id]});
    const settled=async(id:string)=>{for(let i=0;i<100;i++){const r=controller.service.store.getRun(id)!;if(!['queued','running'].includes(r.status))return r;await new Promise(resolve=>setTimeout(resolve,15));}throw new Error('timeout');};
    if(provider==='app-store') {
      const read=unwrap((await api<Run>('/connections/'+connection.id+'/actions','POST',{operation:'list-listings',projectId:project.id,input:{}})).value);
      assert.equal((await settled(read.id)).status,'succeeded');assert.equal(controller.service.store.effectState(read.id),undefined);
    }
    const original=unwrap((await api<Run>('/connections/'+connection.id+'/actions','POST',{operation,projectId:project.id,input:{},idempotencyKey:'store-reconcile-intent'})).value);
    assert.equal((await settled(original.id)).status,'waiting_external');
    const check=unwrap((await api<Run>('/runs/'+original.id+'/reconcile','POST',{})).value);assert.equal((await settled(check.id)).status,'succeeded');
    assert.equal(controller.service.store.getRun(original.id)?.status,'succeeded');assert.equal(writes,1);assert.equal(controller.service.store.effectState(original.id),'confirmed');
  }
});

test('HTTP controller enforces bearer, Host and Origin and writes private metadata', async t => {
  const { controller, directory } = await setup(t);
  const url = `http://127.0.0.1:${controller.port}/api/state`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + controller.token, Origin: 'https://attacker.example' } })).status, 403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(url, { headers: { Authorization: 'Bearer ' + controller.token, Host: `attacker.example:${controller.port}` } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + controller.token } })).status, 200);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer ' + controller.token, Origin: 'app://appops' } })).status, 200);
  assert.equal((await stat(join(directory, 'controller.json'))).mode & 0o777, 0o600);
});

test('Steam content staging keeps executable and PCK together and rejects changed sidecars', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appops-steam-content-'));
  const artifactsRoot = join(root, 'artifacts'); const content = join(root, 'operations', 'steam-content');
  await mkdir(artifactsRoot); t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(artifactsRoot, 'game'); const pck = join(artifactsRoot, 'game.pck');
  await writeFile(executable, 'export-template'); await writeFile(pck, 'fresh-project-content');
  const artifacts = [await attestArtifact(executable, artifactsRoot), await attestArtifact(pck, artifactsRoot)];
  const combined = await stageSteamArtifacts(artifacts, artifactsRoot, content);
  assert.equal(combined.kind, 'directory');
  assert.equal(await readFile(join(combined.path, 'game.pck'), 'utf8'), 'fresh-project-content');
  assert.equal(await readFile(join(combined.path, 'game'), 'utf8'), 'export-template');
  const { chmod } = await import('node:fs/promises'); await chmod(pck, 0o600); await writeFile(pck, 'tampered');
  await assert.rejects(stageSteamArtifacts(artifacts, artifactsRoot, content), { code: 'ARTIFACT_CHANGED' });
});
test('project registration inspects real files, deduplicates and removal preserves original', async t => {
  const { api, projectPath, directory } = await setup(t);
  const project = unwrap((await api<Project>('/projects', 'POST', { path: projectPath })).value);
  assert.equal(project.engine, 'godot'); assert.equal(project.appIdentifier, 'com.example.fixture');
  assert.equal(unwrap((await api<Project>('/projects', 'POST', { path: projectPath })).value).id, project.id);
  const protectedPath = await api('/projects', 'POST', { path: directory });
  assert.equal(protectedPath.status, 400);
  assert.equal((await api('/projects/' + project.id, 'DELETE')).status, 200);
  assert.match(await readFile(join(projectPath, 'project.godot'), 'utf8'), /config_version=5/);
});
test('external writes require saved policy and idempotency, and response loss is never retried', async t => {
  let writes = 0;
  const connector: Connector = { capability, async execute(operation, _input, context) {
    if (operation === 'create-campaign') { context.markDispatched(); writes++; context.checkpoint({ externalId: 'created-42' }); throw new AppError('TEMPORARY', '응답 유실', 503); }
    return { summary: {} };
  } };
  const { api, controller, projectPath } = await setup(t, connector);
  const project = unwrap((await api<Project>('/projects', 'POST', { path: projectPath })).value);
  const connection = unwrap((await api<Connection>('/connections', 'POST', { provider: 'google-ads', label: '광고', accountId: '123', credentials })).value);
  const input = { operation: 'create-campaign', projectId: project.id, input: { name: 'Test', dailyBudgetMicros: '1000000', currency: 'USD' }, idempotencyKey: 'test-idempotency-1' };
  assert.equal((await api('/connections/' + connection.id + '/actions', 'POST', input)).status, 403);
  assert.equal(writes, 0);
  await api('/projects/' + project.id + '/policy', 'PUT', { ...DEFAULT_POLICY, allowedConnectionIds: [connection.id], allowCampaignWrites: true, maxDailyBudgetMicros: '2000000' });
  assert.equal((await api('/connections/' + connection.id + '/actions', 'POST', { ...input, idempotencyKey: undefined })).status, 400);
  const first = unwrap((await api<Run>('/connections/' + connection.id + '/actions', 'POST', input)).value);
  const second = unwrap((await api<Run>('/connections/' + connection.id + '/actions', 'POST', input)).value);
  assert.equal(first.id, second.id);
  for (let attempt = 0; attempt < 100 && controller.service.store.getRun(first.id)?.status !== 'action_required'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const run = controller.service.store.getRun(first.id)!;
  assert.equal(run.status, 'action_required'); assert.equal(run.result?.externalId, 'created-42');
  assert.equal(writes, 1);
  assert.equal((await api('/runs/' + first.id + '/retry', 'POST', {})).status, 409);
  const state = (await api<Record<string, unknown>>('/state')).value;
  assert.ok(!JSON.stringify(state).includes(credentials.refreshToken));
});
test('read authentication rejection refreshes automatically once without changing credentials in UI', async t => {
  let tokenCalls = 0; let checks = 0;
  const fetcher: typeof fetch = async () => { tokenCalls++; return Response.json({ access_token: 'new-token-' + tokenCalls, expires_in: 3600 }); };
  const connector: Connector = { capability, async execute(operation, _input, context) {
    if (operation === 'sync') { const token = await context.accessToken(['https://www.googleapis.com/auth/adwords']); checks++;
      if (checks === 1) throw new AppError('AUTH_REQUIRED', 'expired', 401);
      assert.equal(token, 'new-token-2');
    }
    return { summary: { count: 0 } };
  } };
  const { api, controller } = await setup(t, connector, fetcher);
  const connection = unwrap((await api<Connection>('/connections', 'POST', { provider: 'google-ads', label: '광고', accountId: '123', credentials })).value);
  const run = unwrap((await api<Run>('/connections/' + connection.id + '/actions', 'POST', { operation: 'sync', input: {} })).value);
  for (let attempt = 0; attempt < 100 && controller.service.store.getRun(run.id)?.status !== 'succeeded'; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(controller.service.store.getRun(run.id)?.status, 'succeeded');
  assert.equal(tokenCalls, 2); assert.equal(checks, 2);
  assert.equal(controller.service.store.get<Connection>('connection', connection.id)?.status, 'connected');
});
test('Google OAuth callback is single-use and credentials remain encrypted across controller reopen', async t => {
  let exchanges = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    exchanges++; const body = new URLSearchParams(String(init?.body));
    assert.ok(body.get('code_verifier')); assert.equal(body.get('code'), 'provider-code');
    return Response.json({ access_token: 'short-lived', refresh_token: 'private-rotatable-refresh', expires_in: 3600 });
  };
  const { api, controller, directory, vault } = await setup(t, { capability, execute: async () => ({ summary: {} }) }, fetcher);
  const begun = unwrap((await api<{ connectionId: string; authorizationUrl: string }>('/oauth/google/start', 'POST', {
    provider: 'google-ads', label: '브라우저 연결', accountId: '123', credentials: { clientId: 'client' },
  })).value);
  const authorization = new URL(begun.authorizationUrl);
  const callback = new URL(authorization.searchParams.get('redirect_uri')!);
  callback.searchParams.set('state', authorization.searchParams.get('state')!); callback.searchParams.set('code', 'provider-code');
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await fetch(callback)).status, 400); assert.equal(exchanges, 1);
  assert.equal((await vault.get(begun.connectionId)).refreshToken, 'private-rotatable-refresh');
  assert.equal(controller.service.store.get<Connection>('connection', begun.connectionId)?.status, 'unverified');
  await controller.close();
  const reopened = await startController({ directory, vault, port: 0, connectors: [], scanToolchains: async () => [] });
  t.after(() => reopened.close());
  assert.equal((await reopened.service.state()).connections[0].id, begun.connectionId);
  assert.ok(!JSON.stringify(await reopened.service.state()).includes('private-rotatable-refresh'));
});
test('manual connection check refreshes a stale token once without reauthorization', async t => {
  let tokenCalls = 0; let checks = 0;
  const connector: Connector = { capability, async execute(_operation, _input, context) {
    const token = await context.accessToken(['https://www.googleapis.com/auth/adwords']); checks++;
    if (token === 'manual-token-1') throw new AppError('AUTH_REQUIRED', 'expired', 401);
    assert.equal(token, 'manual-token-2'); return { summary: {} };
  } };
  const { api } = await setup(t, connector, async () => Response.json({ access_token: 'manual-token-' + ++tokenCalls, expires_in: 3600 }));
  const connection = unwrap((await api<Connection>('/connections', 'POST', { provider: 'google-ads', label: '광고', accountId: '123', credentials })).value);
  const checked = unwrap((await api<Connection>('/connections/' + connection.id + '/check', 'POST', {})).value);
  assert.equal(checked.status, 'connected'); assert.equal(tokenCalls, 2); assert.equal(checks, 2);
});
test('real social connector bridge enforces policy and journals an ambiguous post without retry', async t => {
  let writes = 0;
  const fetcher: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw));
    if (url.pathname === '/2/oauth2/token') return Response.json({ access_token: 'test-access', expires_in: 3600 });
    if (url.pathname === '/2/users/me') return Response.json({ data: { id: '111', username: 'test' } });
    if (url.pathname === '/2/tweets' && init?.method === 'POST') { writes++; throw new Error('simulated lost response'); }
    throw new Error('Unexpected fake HTTP path ' + url.pathname);
  };
  const { api, controller, projectPath } = await setup(t, xConnector, fetcher);
  const project = unwrap((await api<Project>('/projects', 'POST', { path: projectPath })).value);
  const connection = unwrap((await api<Connection>('/connections', 'POST', { provider: 'x', label: 'X channel', accountId: '111', credentials: { clientId: 'test-client', refreshToken: 'test-refresh' } })).value);
  const action = { operation: 'create-post', projectId: project.id, input: { text: 'test post' }, idempotencyKey: 'social-post-0001' };
  assert.equal((await api('/connections/' + connection.id + '/actions', 'POST', action)).status, 403);
  assert.equal((await api('/projects/' + project.id + '/social-policy', 'PUT', { enabled: true, connectionIds: [connection.id], dailyPostLimit: 1, autoReleaseAnnouncements: false, releaseTemplate: '{projectName}', autoReply: false, replyRules: [] })).status, 200);
  const run = unwrap((await api<Run>('/connections/' + connection.id + '/actions', 'POST', action)).value);
  for (let i = 0; i < 100 && controller.service.store.getRun(run.id)?.status !== 'action_required'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(controller.service.store.getRun(run.id)?.status, 'action_required'); assert.equal(writes, 1);
  assert.equal(controller.service.store.effectState(run.id), 'action_required');
  assert.equal((await api('/runs/' + run.id + '/retry', 'POST', {})).status, 409);
  assert.equal((await api('/connections/' + connection.id + '/actions', 'POST', { ...action, input: { text: 'another post' }, idempotencyKey: 'social-post-0002' })).status, 403);
});
test('connection deletion resumes a vault cleanup failure from a disconnected tombstone', async t => {
  const { api, vault, controller } = await setup(t, { capability, execute: async () => ({ summary: {} }) });
  const connection = unwrap((await api<Connection>('/connections', 'POST', { provider: 'google-ads', label: '광고', accountId: '123', credentials })).value);
  const remove = vault.remove.bind(vault); let attempts = 0;
  vault.remove = async id => { if (++attempts === 1) throw new Error('Injected cleanup failure'); await remove(id); };
  assert.equal((await api('/connections/' + connection.id, 'DELETE')).status, 500);
  assert.equal(controller.service.store.get<Connection>('connection', connection.id)?.status, 'disconnected');
  assert.equal(await vault.has(connection.id), true);
  assert.equal((await api('/connections/' + connection.id, 'DELETE')).status, 200);
  assert.equal(await vault.has(connection.id), false);
  assert.equal(controller.service.store.get('connection', connection.id), undefined);
});
test('campaign ingestion attributes appId only when exactly one project matches', async t => {
  const connector: Connector = { capability, async execute() { return { summary: {}, resources: [{ kind: 'campaign', externalId: 'known-app', name: 'C', status: 'PAUSED', data: { appId: 'com.example.fixture', currency: 'USD', dailyBudgetMicros: '100' } }] }; } };
  const { api, controller, projectPath } = await setup(t, connector);
  const project = unwrap((await api<Project>('/projects', 'POST', { path: projectPath })).value);
  const connection = unwrap((await api<Connection>('/connections', 'POST', { provider: 'google-ads', label: '광고', accountId: '123', credentials })).value);
  const run = unwrap((await api<Run>('/connections/' + connection.id + '/actions', 'POST', { operation: 'sync', input: {} })).value);
  for (let i = 0; i < 100 && controller.service.store.getRun(run.id)?.status !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(controller.service.store.list<{ projectId: string }>('resource')[0].projectId, project.id);
});
test('symlinked controller data roots cannot be registered through their real parent project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'appops-symlink-'));
  await mkdir(join(root, 'project/data'), { recursive: true });
  await symlink(join(root, 'project/data'), join(root, 'data-alias'));
  await writeFile(join(root, 'project/project.godot'), 'config_version=5');
  const controller = await startController({ directory: join(root, 'data-alias'), port: 0, connectors: [], scanToolchains: async () => [] });
  t.after(async () => { await controller.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(controller.directory, join(root, 'project/data'));
  await assert.rejects(controller.service.addProject({ path: join(root, 'project') }), { code: 'PROTECTED_DIRECTORY' });
});
test('unresolved external effects keep their account and project available for reconciliation', async t => {
  const { api, controller, projectPath, vault } = await setup(t, { capability, execute: async () => ({ summary: {} }) });
  const project = unwrap((await api<Project>('/projects', 'POST', { path: projectPath })).value);
  const connection = unwrap((await api<Connection>('/connections', 'POST', { provider: 'google-ads', label: '광고', accountId: '123', credentials })).value);
  const store = controller.service.store;
  const run = store.createRun({ projectId: project.id, connectionId: connection.id, kind: 'create-campaign', label: '전송 대기', input: {}, writeEffect: true, idempotencyKey: 'unresolved-delete-1' });
  const claimed = store.claim()!; store.markDispatched(run.id, claimed.token); store.finish(run.id, claimed.token, 'waiting_external', { externalId: 'remote' });
  assert.equal((await api('/connections/' + connection.id, 'DELETE')).status, 409);
  assert.equal((await api('/projects/' + project.id, 'DELETE')).status, 409);
  assert.equal(await vault.has(connection.id), true); assert.ok(store.get('project', project.id));
});
