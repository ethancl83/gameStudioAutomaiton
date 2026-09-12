import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { startController } from '../apps/controller/server.js';
import { CredentialVault } from '../packages/credentials/index.js';
import { cliCommand, cliEvent, runAgentCli, type AgentInvocation } from '../packages/agent/cli.js';
import { listProjectFiles, readProjectFile } from '../packages/agent/project-files.js';
import { renderArtwork } from '../packages/agent/artwork.js';
import type { AgentState, AgentTask } from '../packages/agent/types.js';
import type { AgentOptions } from '../apps/controller/agent.js';
import type { Connection, Project, Run } from '../packages/domain/index.js';
import type { Connector } from '../packages/connectors/types.js';
import { SCREEN_REQUESTS } from '../packages/agent/requests.js';

const listing = { title: '별자리 퍼즐', shortDescription: '별을 연결해 퍼즐을 풀어요.', fullDescription: '별을 연결하는 퍼즐 게임입니다.', language: 'ko-KR', category: 'GAME_PUZZLE', evidence: ['README.md'] };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#13264b"/><path d="M256 70 L310 206 L455 215 L340 309 L378 452 L256 370 L134 452 L172 309 L57 215 L202 206Z" fill="#ffd15c"/></svg>';
const connector: Connector = { capability: { provider: 'google-play', name: 'Play', category: 'store', authKind: 'OAuth', description: 'Test fixture', setupUrl: 'https://play.google.com/console', fields: [], operations: ['check', 'list-releases', 'create-app', 'update-listing', 'upload-listing-image'], limitations: [] },
  async execute(operation, _input, context) { if (['update-listing', 'upload-listing-image'].includes(operation)) context.markDispatched(); return { summary: { exists: true, packageName: context.project?.appIdentifier, updated: true } }; } };

async function setup(t: TestContext, agent: AgentOptions = {}, customConnector = connector) {
  const directory = await mkdtemp(join(tmpdir(), 'appops-agent-'));
  const projectPath = join(directory, 'source'); const dataPath = join(directory, 'data');
  await mkdir(projectPath);
  await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n[application]\nconfig/name="별자리 퍼즐"\n');
  await writeFile(join(projectPath, 'export_presets.cfg'), '[preset.0]\nname="Android"\nplatform="Android"\n[preset.0.options]\npackage/unique_name="com.example.stars"\n');
  await writeFile(join(projectPath, 'README.md'), '# 별자리 퍼즐\n별을 연결해서 퍼즐을 푸는 게임입니다.');
  let key: Buffer | undefined;
  const vault = new CredentialVault(join(dataPath, 'credentials'), { keyProvider: { name: 'test-memory', getKey: async () => key, setKey: async value => { key = value; } } });
  const options = { directory: dataPath, port: 0, vault, connectors: [customConnector], scanToolchains: async () => [], agent: { ...agent, run: agent.run ? async (invocation: AgentInvocation) => { invocation.onSessionId?.(invocation.sessionId ?? (invocation.provider === 'codex' ? '11111111-1111-4111-8111-111111111111' : 'ses_test123')); await agent.run!(invocation); } : undefined } };
  let controller = await startController(options);
  t.after(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  const connection = await controller.service.addConnection({ provider: 'google-play', accountId: 'test-publisher', label: 'Play', credentials: { clientId: 'test', refreshToken: 'test-secret-token' } });
  async function api<T>(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${controller.port}/api${path}`, { method, headers: { Authorization: `Bearer ${controller.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); return result.data as T;
  }
  return { directory, projectPath, get controller() { return controller; }, connection, api, restart: async () => { await controller.close(); controller = await startController(options); } };
}
function client(invocation: AgentInvocation) {
  return async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await fetch(invocation.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + invocation.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
    const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result as T;
  };
}
async function settled(get: () => AgentTask | undefined) {
  for (let attempt = 0; attempt < 300; attempt++) { const task = get(); if (task && !['running', 'queued'].includes(task.status)) return task; await delay(20); }
  throw new Error('Agent did not settle');
}

test('a screen without a user message cannot launch AI or append an invented request', async t => {
  let calls = 0;
  const fixture = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/fixture' }], run: async () => { calls++; } });
  const project = await fixture.api<Project>('/projects', 'POST', { path: fixture.projectPath });
  for (const screen of Object.keys(SCREEN_REQUESTS)) {
    for (const message of [undefined, '', '   ']) {
      const response = await fetch(`http://127.0.0.1:${fixture.controller.port}/api/agent/requests`, {
        method: 'POST', headers: { Authorization: `Bearer ${fixture.controller.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ screen, projectId: project.id, message }),
      });
      assert.equal(response.status, 400, `${screen}: an explicit message is required`);
    }
  }
  assert.equal(fixture.controller.service.agent.tasks().length, 0);
  assert.equal(calls, 0);
});

test('the exact edited request and current selection reach the same native conversation', async t => {
  const invocations: AgentInvocation[] = [];
  const fixture = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/fixture' }], run: async input => { invocations.push(input); input.onMessage?.('요청한 내용만 답변합니다.'); } });
  const message = '새 계정을 연결하려고 해. 지원하는 서비스부터 설명해 줘. 아직 연결하지 마.';
  const first = await fixture.api<AgentTask>('/agent/requests', 'POST', { screen: 'connections', connectionId: fixture.connection.id, message });
  await settled(() => fixture.controller.service.agent.tasks()[0]);
  while (fixture.controller.service.agent.busy) await delay(5);
  const secondMessage = '광고 성과 표에 대해 설명만 해 줘.';
  await fixture.api('/agent/requests', 'POST', { screen: 'marketing', message: secondMessage });
  const second = await settled(() => fixture.controller.service.agent.tasks()[0]);
  assert.equal(second.id, first.id);
  assert.equal(invocations[1]?.sessionId, second.sessionId);
  assert.deepEqual(second.conversation.filter(entry => entry.role === 'user').map(entry => entry.text), [message, secondMessage]);
  assert.equal(second.requestContext?.screen, 'marketing');
  assert.equal(second.requestContext?.connectionId, undefined, 'previous account selection must not leak');
  assert.ok(invocations[0]?.prompt.endsWith(message));
  assert.ok(invocations[1]?.prompt.endsWith(secondMessage));
  assert.equal(second.runIds.length, 0);
});

test('project registration is passive; an explicit request drives HTTP tools, images and the store queue', async t => {
  let calls = 0;
  const { api, controller, projectPath } = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/test/codex' }], run: async invocation => {
    calls++; const call = client(invocation);
    const context = await call<{ project: Project; connections: Connection[] }>('context');
    assert.ok(!JSON.stringify(context).includes('test-secret-token'));
    await call('read_project', { path: 'README.md' });
    await call('save_listing', listing);
    const artwork = { name: 'star-icon', svg, width: 512, height: 512, purpose: 'icon' };
    const image = await call<{ mediaAssetId: string }>('render_artwork', artwork);
    assert.equal((await call<{ mediaAssetId: string }>('render_artwork', artwork)).mediaAssetId, image.mediaAssetId);
    const connectionId = context.connections[0]!.id;
    await call('bind_store', { connectionId, appId: 'com.example.stars' });
    const input = { connectionId, operation: 'update-listing', input: listing };
    const run = await call<Run>('store_action', input);
    assert.equal((await call<Run>('store_action', input)).id, run.id);
    assert.equal((await call<Run>('run_result', { runId: run.id })).status, 'succeeded');
    await assert.rejects(call('finish', { message: '이미지 반영 전 완료' }), { code: 'AGENT_INCOMPLETE' });
    const upload = await call<Run>('store_action', { connectionId, operation: 'upload-listing-image', input: { language: 'ko-KR', imageType: 'icon', mediaAssetId: image.mediaAssetId } });
    assert.equal((await call<Run>('run_result', { runId: upload.id })).status, 'succeeded');
    await call('finish', { message: '스토어 자료를 등록했습니다.' });
  } });
  const project = await api<Project>('/projects', 'POST', { path: projectPath });
  assert.equal(controller.service.agent.tasks().length, 0);
  await api('/agent/requests', 'POST', { screen: 'projects', projectId: project.id, message: '프로젝트 자료를 준비해서 스토어에 등록해 줘.' });
  const task = await settled(() => controller.service.agent.tasks().find(task => task.projectId === project.id));
  assert.equal(task.status, 'completed', task.message); assert.equal(calls, 1); assert.equal(task.images.length, 1); assert.equal(task.runIds.length, 2);
  const preview = await api<{ dataUrl: string }>(`/agent/${task.id}/image`, 'POST', { mediaAssetId: task.images[0]!.mediaAssetId });
  assert.match(preview.dataUrl, /^data:image\/png;base64,/);
  assert.equal((await api<Project>('/projects', 'POST', { path: projectPath })).id, project.id); assert.equal(calls, 1);
  assert.equal(await readFile(join(projectPath, 'README.md'), 'utf8'), '# 별자리 퍼즐\n별을 연결해서 퍼즐을 푸는 게임입니다.');
});

test('missing selected CLI creates one actionable task without silently switching providers', async t => {
  let calls = 0;
  const { controller, projectPath, api } = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/installed' }, { provider: 'opencode', executable: null }], run: async () => { calls++; } });
  await api('/agent/settings', 'PUT', { provider: 'opencode' });
  const project = await api<Project>('/projects', 'POST', { path: projectPath });
  assert.equal(controller.service.agent.tasks().length, 0);
  await api('/agent/requests', 'POST', { screen: 'projects', projectId: project.id, message: '프로젝트 자료를 준비해서 스토어에 등록해 줘.' });
  const task = await settled(() => controller.service.agent.tasks().find(task => task.projectId === project.id));
  assert.equal(task.status, 'needs_user'); assert.match(task.question!.message, /opencode/); assert.equal(calls, 0);
});

test('necessary input resumes the same task and retains generated copy without repeating questions', async t => {
  let calls = 0;
  const { controller, projectPath, api } = await setup(t, { discover: async () => [{ provider: 'opencode', executable: '/installed' }], run: async invocation => {
    const call = client(invocation); calls++;
    if (calls === 1) { await call('save_listing', listing); await call('ask_user', { kind: 'information', message: '개인정보처리방침 URL이 필요합니다.' }); }
    else { const context = await call<{ task: AgentTask }>('context'); assert.equal(context.task.listing?.title, listing.title); assert.equal(context.task.conversation.at(-1)?.text, 'https://example.com/privacy'); await call('ask_user', { kind: 'login', message: '스토어 로그인만 완료해 주세요.', url: 'https://play.google.com/console' }); }
  } });
  const project = await api<Project>('/projects', 'POST', { path: projectPath });
  await api('/agent/requests', 'POST', { screen: 'projects', projectId: project.id, message: '프로젝트 자료를 준비해서 스토어에 등록해 줘.' });
  const task = await settled(() => controller.service.agent.tasks()[0]);
  while (controller.service.agent.busy) await delay(5);
  await api(`/agent/${task.id}/resume`, 'POST', { answer: 'https://example.com/privacy' });
  const next = await settled(() => controller.service.agent.tasks()[0]);
  assert.equal(next.id, task.id); assert.equal(next.status, 'needs_user'); assert.equal(next.question?.kind, 'login'); assert.equal(calls, 2);
});

test('scope, generated screenshot, script artwork and false completion are rejected by the controller', async t => {
  const checked: string[] = [];
  const { controller, projectPath, api } = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/fixture' }], run: async invocation => {
    const call = client(invocation); const context = await call<{ connections: Connection[] }>('context');
    for (const [name, args, code] of [
      ['store_action', { connectionId: context.connections[0]!.id, operation: 'submit-review' }, 'AGENT_SCOPE_DENIED'],
      ['run_result', { runId: 'another-task-run' }, 'AGENT_SCOPE_DENIED'],
      ['render_artwork', { name: 'fake', svg, width: 512, height: 512, purpose: 'screenshot' }, 'AGENT_IMAGE_SOURCE'],
      ['render_artwork', { name: 'bad', svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', width: 512, height: 512, purpose: 'icon' }, 'AGENT_UNSAFE_SVG'],
      ['finish', { message: '등록 완료' }, 'AGENT_INCOMPLETE'],
      ['ask_user', { message: '로그인', kind: 'login', url: 'https://evil.example' }, 'AGENT_URL_DENIED'],
    ] as const) { await assert.rejects(call(name, args), { code }); checked.push(code); }
    await call('ask_user', { message: '로그인이 필요합니다.', kind: 'login' });
  } });
  const project = await api<Project>('/projects', 'POST', { path: projectPath });
  await api('/agent/requests', 'POST', { screen: 'projects', projectId: project.id, message: '프로젝트 자료를 준비해서 스토어에 등록해 줘.' }); await settled(() => controller.service.agent.tasks()[0]); assert.equal(checked.length, 6);
});

test('task bridge rejects unauthenticated, cross-origin and oversized requests and expires after the worker', async t => {
  let endpoint = ''; let token = '';
  const { controller, projectPath, api } = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/fixture' }], run: async invocation => {
    endpoint = invocation.endpoint; token = invocation.token;
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token, Origin: 'https://evil.example' }, body: '{}' })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: 'x'.repeat(513 * 1024) })).status, 413);
    await client(invocation)('ask_user', { message: '로그인 필요', kind: 'login' });
  } });
  const project = await api<Project>('/projects', 'POST', { path: projectPath });
  await api('/agent/requests', 'POST', { screen: 'projects', projectId: project.id, message: '프로젝트 자료를 준비해서 스토어에 등록해 줘.' }); await settled(() => controller.service.agent.tasks()[0]);
  while (controller.service.agent.busy) await delay(5);
  await assert.rejects(fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: '{}' }));
  assert.ok(!(JSON.stringify(await api('/agent'))).includes(token));
});

test('cancel aborts the running CLI and prevents late completion', async t => {
  let invoked = false;
  const { controller, projectPath, api } = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/fixture' }], run: async invocation => { invoked = true; await delay(30_000, undefined, { signal: invocation.signal }); } });
  const project = await api<Project>('/projects', 'POST', { path: projectPath });
  await api('/agent/requests', 'POST', { screen: 'projects', projectId: project.id, message: '프로젝트 자료를 준비해서 스토어에 등록해 줘.' });
  while (!invoked) await delay(5);
  const task = controller.service.agent.tasks()[0]!;
  await api(`/agent/${task.id}/cancel`, 'POST', {});
  while (controller.service.agent.busy) await delay(5);
  assert.equal(controller.service.agent.tasks()[0]!.status, 'cancelled');
  await assert.rejects(controller.service.agent.callTool(task.id, 'finish', { message: 'done' }, new AbortController().signal), { code: 'AGENT_NOT_RUNNING' });
});

test('recovery preserves copy and requires checking previous external effects before continuation', async t => {
  const { controller, projectPath, api } = await setup(t);
  const project = await api<Project>('/projects', 'POST', { path: projectPath });
  controller.service.agent.ensure(project.id);
  const task = controller.service.agent.tasks()[0]!;
  controller.service.store.put('agent-task', task.id, { ...task, status: 'running', listing });
  controller.service.agent.recover();
  assert.equal(controller.service.agent.tasks()[0]!.status, 'needs_user'); assert.equal(controller.service.agent.tasks()[0]!.listing?.title, listing.title);
});

test('project analysis excludes hidden credentials, external symlinks and secret-bearing text', async t => {
  const { projectPath } = await setup(t);
  await writeFile(join(projectPath, '.env'), 'API_KEY=private');
  await writeFile(join(projectPath, 'service-account.json'), '{"private_key":"secret"}');
  await writeFile(join(projectPath, 'settings.json'), '{"apiKey":"private"}');
  await symlink('/etc/hosts', join(projectPath, 'link.md'));
  assert.ok(!(await listProjectFiles(projectPath)).files.some(file => file.path === '.env' || file.path === 'service-account.json' || file.path === 'link.md'));
  for (const path of ['.env', '../outside.md', 'service-account.json', 'link.md', 'settings.json']) await assert.rejects(readProjectFile(projectPath, path));
});

test('artwork produces a real PNG at the requested dimensions and rejects external references', async () => {
  const bytes = await renderArtwork(svg, 1024, 500); const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 1024); assert.equal(metadata.height, 500); assert.equal(metadata.format, 'png');
  await assert.rejects(renderArtwork('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>', 512, 512));
});

test('both CLI commands preserve user configuration, scope MCP and keep bridge credentials out of argv', () => {
  for (const provider of ['codex', 'opencode'] as const) {
    const command = cliCommand({ provider, executable: '/cli', directory: '/safe path', prompt: 'Generate materials', endpoint: 'http://127.0.0.1:5555/', token: 'private-bridge-token', bridgeCommand: ['/node path', '/bridge.js'], signal: new AbortController().signal });
    assert.ok(!command.args.join(' ').includes('private-bridge-token'));
    assert.equal(command.env.APPOPS_AGENT_TOKEN, 'private-bridge-token');
    if (provider === 'codex') { assert.ok(!command.args.includes('--ephemeral')); assert.equal(command.args.at(-1), '-'); }
    else { const config = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT!); assert.deepEqual(config.mcp.appops.command, ['/node path', '/bridge.js']); assert.equal(config.share, 'disabled'); }
  }
});

for (const provider of ['codex', 'opencode'] as const) test(`${provider}: submitted requests/chat/restart resume the exact session until clear; provider and artifacts are retained`, async t => {
  const invocations: AgentInvocation[] = [];
  const fixture = await setup(t, {
    discover: async () => [{ provider: 'codex', executable: '/fixture' }, { provider: 'opencode', executable: '/fixture' }],
    run: async invocation => { invocations.push(invocation); if (invocations.length === 1) await client(invocation)('save_listing', listing); invocation.onMessage?.('요청을 확인했습니다.'); },
  });
  await fixture.api('/agent/settings', 'PUT', { provider });
  const project = await fixture.api<Project>('/projects', 'POST', { path: fixture.projectPath });
  await fixture.api('/state'); await fixture.api('/agent');
  assert.equal(invocations.length, 0, 'registration and state reads must not execute AI');
  await fixture.api('/agent/requests', 'POST', { screen: 'projects', projectId: project.id, message: '프로젝트 자료를 준비해서 스토어에 등록해 줘.' });
  const original = await settled(() => fixture.controller.service.agent.tasks()[0]);
  assert.ok(original.sessionId); assert.equal(original.conversation.length, 2);
  assert.equal(invocations[0]?.sessionId, undefined);
  while (fixture.controller.service.agent.busy) await delay(5);
  await fixture.restart();
  assert.equal(invocations.length, 1, 'startup must not execute AI');
  await fixture.api('/agent/settings', 'PUT', { provider: provider === 'codex' ? 'opencode' : 'codex' });
  await fixture.api('/agent/requests', 'POST', { screen: 'agent', projectId: project.id, message: '이어서 설명해 줘' });
  await settled(() => fixture.controller.service.agent.tasks()[0]);
  assert.equal(invocations[1]?.provider, provider);
  assert.equal(invocations[1]?.sessionId, original.sessionId);
  assert.equal(invocations[1]?.directory, invocations[0]?.directory);
  const resumed = cliCommand(invocations[1]!);
  assert.ok(resumed.args.includes(original.sessionId!));
  assert.ok(resumed.args.includes(provider === 'codex' ? 'resume' : '--session'));
  assert.ok(!resumed.args.includes('--last') && !resumed.args.includes('--continue'));
  const cleared = await fixture.api<AgentTask>(`/agent/${original.id}/clear`, 'POST', {});
  assert.equal(cleared.sessionId, undefined); assert.equal(cleared.provider, null);
  assert.equal(cleared.conversation.length, 0); assert.equal(cleared.listing?.title, listing.title);
  assert.notEqual(cleared.sessionGeneration, original.sessionGeneration);
  assert.equal(invocations.length, 2, 'clear must not start the next session');
  await fixture.api('/agent/requests', 'POST', { screen: 'projects', projectId: project.id, message: '프로젝트 자료를 준비해서 스토어에 등록해 줘.' });
  await settled(() => fixture.controller.service.agent.tasks()[0]);
  assert.equal(invocations[2]?.sessionId, undefined);
  assert.notEqual(invocations[2]?.provider, provider);
  assert.notEqual(invocations[2]?.directory, invocations[1]?.directory);
});

test('clear waits for the old worker, blocks concurrent requests and fences late messages/session IDs', async t => {
  let running: AgentInvocation | undefined;
  let release!: () => void;
  const fixture = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/fixture' }], run: async invocation => {
    running = invocation; await new Promise<void>(resolve => { release = resolve; });
    invocation.onMessage?.('늦은 응답'); invocation.onSessionId?.('late-session');
  } });
  const task = await fixture.api<AgentTask>('/agent/requests', 'POST', { screen: 'dashboard', message: '현재 상태를 설명해 줘.' });
  while (!running) await delay(5);
  assert.equal(task.projectId, null);
  const clear = fixture.api<AgentTask>(`/agent/${task.id}/clear`, 'POST', {});
  while (!running.signal.aborted) await delay(5);
  assert.throws(() => fixture.controller.service.agent.resume(task.id, { answer: '동시 요청' }), { code: 'AGENT_BUSY' });
  release();
  const cleared = await clear;
  assert.equal(cleared.sessionId, undefined); assert.deepEqual(cleared.conversation, []); assert.equal(cleared.status, 'idle');
  await fixture.restart();
  assert.deepEqual(fixture.controller.service.agent.tasks()[0]?.conversation, []);
});

test('screen requests preserve selected account, expose current data and reject empty or unknown requests', async t => {
  let currentContext: Record<string, unknown> = {};
  const fixture = await setup(t, { discover: async () => [{ provider: 'codex', executable: '/fixture' }], run: async invocation => {
    currentContext = await client(invocation)('context'); invocation.onMessage?.('선택한 계정을 분석했습니다.');
  } });
  const task = await fixture.api<AgentTask>('/agent/requests', 'POST', { screen: 'connections', connectionId: fixture.connection.id, message: '선택한 계정의 연결 상태를 설명해 줘.' });
  await settled(() => fixture.controller.service.agent.tasks()[0]);
  assert.equal(task.requestContext?.screen, 'connections');
  assert.deepEqual((currentContext.connections as Connection[]).map(conn => conn.id), [fixture.connection.id]);
  assert.ok(Array.isArray(currentContext.metrics));
  assert.throws(() => fixture.controller.service.agent.request({ screen: 'invented' }), { code: 'INVALID_INPUT' });
  assert.throws(() => fixture.controller.service.agent.request({ screen: 'agent', message: '' }), { code: 'INVALID_INPUT' });
});

test('native JSON events expose only session IDs and assistant text, never reasoning or tool output', () => {
  assert.equal(cliEvent('codex', '{"type":"thread.started","thread_id":"11111111-1111-4111-8111-111111111111"}').sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(cliEvent('opencode', '{"type":"text","sessionID":"ses_123","part":{"type":"text","text":"답변"}}').message, '답변');
  assert.equal(cliEvent('codex', '{"type":"item.completed","item":{"type":"reasoning","text":"private"}}').message, undefined);
  assert.equal(cliEvent('opencode', '{"type":"tool_use","part":{"type":"tool","text":"private"}}').message, undefined);
  assert.equal(cliEvent('opencode', '{"type":"step_start","sessionID":"--last"}').sessionId, undefined);
  assert.deepEqual(cliEvent('codex', 'plain stderr'), {});
});

test('real CLI subprocess lifecycle handles success, failure and cancellation for both providers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cli-process-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fixture.mjs');
  await writeFile(executable, `#!/usr/bin/env node
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end',()=>{if(prompt === 'fail')process.exit(2);else if(prompt === 'empty')process.exit(0);else if(prompt === 'wait')setInterval(()=>{},1000);else {
  console.log(JSON.stringify(process.argv.includes('exec') ? {type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'} : {type:'step_start',sessionID:'ses_fixture'}));
  console.log(JSON.stringify(process.argv.includes('exec') ? {type:'item.completed',item:{type:'agent_message',text:'검사를 마쳤어요.'}} : {type:'text',sessionID:'ses_fixture',part:{type:'text',text:'검사를 마쳤어요.'}}));
}});
`);
  await chmod(executable, 0o700);
  for (const provider of ['codex', 'opencode'] as const) {
    const args: AgentInvocation = { provider, executable, directory, prompt: 'ok', endpoint: 'http://127.0.0.1:5555/', token: 'test', bridgeCommand: ['/node', '/bridge'], signal: new AbortController().signal };
    const messages: string[] = []; const ids: string[] = [];
    await runAgentCli({ ...args, onMessage: value => messages.push(value), onSessionId: value => ids.push(value) });
    assert.deepEqual(messages, ['검사를 마쳤어요.']); assert.equal(ids.length, 1);
    await assert.rejects(runAgentCli({ ...args, prompt: 'empty' }), { code: 'AGENT_SESSION_MISSING' });
    await assert.rejects(runAgentCli({ ...args, sessionId: provider === 'codex' ? '22222222-2222-4222-8222-222222222222' : 'ses_different' }), { code: 'AGENT_SESSION_MISMATCH' });
    { await assert.rejects(runAgentCli({ ...args, prompt: 'fail' }), { code: 'AGENT_CLI_FAILED' }); const abort = new AbortController(); const pending = runAgentCli({ ...args, prompt: 'wait', signal: abort.signal }); setTimeout(() => abort.abort(), 100); await assert.rejects(pending, { code: 'AGENT_CANCELLED' }); }
  }
});

test('STDIO bridge answers MCP initialize and tools/list without leaking its token', async () => {
  const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), fileURLToPath(new URL('../packages/agent/mcp.ts', import.meta.url))], {
    env: { ...process.env, APPOPS_AGENT_ENDPOINT: 'http://127.0.0.1:5555/', APPOPS_AGENT_TOKEN: 'private-mcp-token' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('bridge exit ' + code))); });
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, 'appops'); assert.ok(replies[1].result.tools.some((tool: { name: string }) => tool.name === 'store_action')); assert.ok(!output.includes('private-mcp-token'));
});
