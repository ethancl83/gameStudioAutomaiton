import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError, object, text } from '../../packages/domain/errors.js';
import type { ApiResult } from '../../packages/domain/index.js';
import { Store } from '../../packages/storage/index.js';
import { CredentialVault } from '../../packages/credentials/index.js';
import { getDataDirectory } from '../../packages/domain/paths.js';
import { AppService, type ServiceOptions } from './service.js';
import { normalizeError } from './validation.js';
import { DemoService } from './demo.js';
import { activatePendingRestore } from '../../packages/backup/activation.js';

async function readBody(request: IncomingMessage): Promise<unknown> {
  const maximum = /^\/api\/(?:demo\/)?media$/.test(request.url ?? '') ? 22 * 1024 * 1024 : 2 * 1024 * 1024;
  const length = Number(request.headers['content-length'] ?? 0);
  if (length > maximum) throw new AppError('BODY_TOO_LARGE', '요청 데이터가 너무 큽니다.', 413);
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json' && length > 0) throw new AppError('JSON_REQUIRED', 'JSON 요청이 필요합니다.', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new AppError('BODY_TOO_LARGE', '요청 데이터가 너무 큽니다.', 413);
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('INVALID_JSON', '요청 데이터 형식을 확인해 주세요.'); }
}
function send(response: ServerResponse, status: number, result: ApiResult<unknown>): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
  response.end(JSON.stringify(result));
}
function authenticated(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export interface ControllerOptions extends ServiceOptions {
  directory?: string; port?: number; vault?: CredentialVault;
}
export interface RunningController {
  port: number; token: string; directory: string; service: AppService; close(): Promise<void>;
}
export async function startController(options: ControllerOptions = {}): Promise<RunningController> {
  const configuredDirectory = resolve(options.directory ?? getDataDirectory());
  await mkdir(dirname(configuredDirectory), { recursive: true, mode: 0o700 });
  let directory = join(await realpath(dirname(configuredDirectory)), basename(configuredDirectory));
  try { await lstat(directory); directory = await realpath(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Recovery can have moved the old directory already. Do not create an empty
  // replacement until the authenticated transaction has finished its rename.
  const activation = await activatePendingRestore(directory);
  let store: Store;
  let service: AppService;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    store = new Store(directory);
    const vaultPath = join(directory, 'credentials');
    const vault = activation ? (options.backupVaultFactory?.(vaultPath) ?? new CredentialVault(vaultPath))
      : options.vault ?? options.backupVaultFactory?.(vaultPath) ?? new CredentialVault(vaultPath);
    service = new AppService(store, vault, options);
    if (activation) {
      if (!(await vault.status()).available) throw new AppError('RESTORE_VAULT', '복원한 보관함을 열 수 없습니다. 이전 데이터로 되돌립니다.');
      for (const id of await vault.listIds()) await vault.get(id);
    }
  } catch (error) {
    try { store!?.close(); } finally { await activation?.rollback(); }
    if (activation) return startController(options);
    throw error;
  }
  const token = randomBytes(32).toString('base64url');
  let port = options.port ?? 4317;
  const devPort = Number(process.env.APPOPS_DEV_PORT ?? 5173);
  let closed = false;
  let demo: DemoService | undefined;
  let demoOpening: Promise<DemoService> | undefined;
  let demoRequests = 0;
  let resettingDemo = false;
  const demoRoot = directory + '.demo';
  const getDemo = async (): Promise<DemoService> => {
    if (demo) return demo;
    if (!demoOpening) demoOpening = (async () => {
      const demoDirectory = join(demoRoot, 'data');
      const restored = await activatePendingRestore(demoDirectory);
      let demoStore: Store | undefined; let created: DemoService | undefined;
      try { demoStore = new Store(demoDirectory); created = new DemoService(demoStore, demoRoot); await created.seed(); await created.start(); await restored?.commit(); demo = created; return created; }
      catch (error) { await created?.stop(); demoStore?.close(); await restored?.rollback(); throw error; }
    })().finally(() => { demoOpening = undefined; });
    return demoOpening;
  };
  const server = createServer(async (request, response) => {
    let inDemo = false;
    let leaveMutation: (() => void) | undefined;
    try {
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '')) throw new AppError('INVALID_HOST', '허용되지 않은 요청 주소입니다.', 403);
      // Validate the wire path before WHATWG URL parsing can remove dot segments
      // and accidentally change a demo request into a live request.
      const rawTarget = request.url ?? '/';
      const rawPath = rawTarget.split('?')[0]!;
      if (!/^\/[A-Za-z0-9/_-]*$/.test(rawPath) || rawPath.includes('//')) {
        throw new AppError('INVALID_PATH', '요청 경로 형식을 확인해 주세요.', 400);
      }
      const url = new URL(rawTarget, `http://127.0.0.1:${port}`);
      const callback = ['/api/oauth/google/callback', '/api/oauth/social/callback'].includes(url.pathname) && request.method === 'GET';
      const origin = request.headers.origin;
      if (!callback && origin && !['app://appops', `http://127.0.0.1:${devPort}`, `http://localhost:${devPort}`, `http://127.0.0.1:${port}`].includes(origin)) {
        throw new AppError('INVALID_ORIGIN', '허용되지 않은 요청 출처입니다.', 403);
      }
      if (callback) {
        let succeeded = false;
        try {
          leaveMutation = service.enterMutation();
          if (url.pathname === '/api/oauth/social/callback') await service.completeSocialOAuth(url.searchParams.get('state') ?? '', url.searchParams.get('code') ?? '');
          else await service.completeOAuth(url.searchParams.get('state') ?? '', url.searchParams.get('code') ?? '');
          succeeded = true;
        } catch {}
        response.writeHead(succeeded ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        response.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>계정 연결</title><h1>${succeeded ? '계정 연결을 완료했습니다.' : '계정 연결을 완료하지 못했습니다.'}</h1><p>${succeeded ? '운영 앱으로 돌아가면 연결 상태가 반영됩니다. 이 창을 닫아도 됩니다.' : '운영 앱의 연결 화면에서 다시 시작해 주세요.'}</p></html>`);
        return;
      }
      if (url.pathname === '/api/health' && request.method === 'GET') {
        send(response, 200, { ok: true, data: { version: '0.1.0', startedAt: service.startedAt } }); return;
      }
      if (!authenticated(request, token)) throw new AppError('UNAUTHORIZED', '앱의 제어 서비스 인증이 필요합니다.', 401);
      const requestedDemo = url.pathname === '/api/demo' || url.pathname.startsWith('/api/demo/');
      if (requestedDemo) {
        if (resettingDemo) throw new AppError('DEMO_RESETTING', '데모를 초기화하고 있습니다. 잠시 후 다시 시도해 주세요.', 409);
        inDemo = true; demoRequests++;
      }
      const activeService = inDemo ? await getDemo() : service;
      const activeStore = activeService.store;
      const path = inDemo ? '/api' + url.pathname.slice('/api/demo'.length) : url.pathname;
      const method = request.method;
      if (['POST', 'PUT', 'DELETE'].includes(method ?? '')) leaveMutation = activeService.enterMutation();
      if (method === 'POST' && path === '/api/operations/portable-backups/import') {
        if (!['application/octet-stream','application/vnd.appops.backup'].includes(request.headers['content-type']?.split(';')[0]?.trim() ?? '')) throw new AppError('BACKUP_FORMAT', '암호화된 전체 백업 파일이 필요합니다.', 415);
        const length = request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length']);
        const imported = await activeService.backups.import(request, length);
        send(response, 200, { ok: true, data: imported }); return;
      }
      const download = /^\/api\/operations\/portable-backups\/([a-f0-9-]{36})\/download$/.exec(path);
      if (method === 'GET' && download) {
        const { record, file } = await activeService.backups.download(download[1]!);
        response.writeHead(200, { 'Content-Type': 'application/vnd.appops.backup', 'Content-Length': record.size,
          'X-AppOps-SHA256': record.sha256!, 'Content-Disposition': `attachment; filename="${record.id}.appopsbackup"`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        try { await pipeline(file.createReadStream({ autoClose: false }), response); } finally { await file.close(); }
        return;
      }
      const match = /^\/api\/(projects|connections|runs|build-credentials)\/([a-zA-Z0-9-]{1,100})(?:\/(inspect|relink|policy|social-policy|build-security|build|publish|artifacts|check|actions|cancel|retry|reconcile|resolve|credentials|oauth\/start|oauth\/social\/start))?$/.exec(path);
      const socialStart = /^\/api\/oauth\/social\/(x|threads)\/start$/.exec(path);
      const socialSchedule = /^\/api\/social\/schedules\/([a-zA-Z0-9-]{1,100})$/.exec(path);
      const body = ['POST', 'PUT'].includes(method ?? '') ? await readBody(request) : {};
      let data: unknown;
      if (inDemo && method === 'POST' && path === '/api/scenario') data = (activeService as DemoService).scenario(body);
      else if (inDemo && method === 'POST' && path === '/api/reset') {
        if (demoRequests > 1 || activeStore.runs(100_000).some(run => ['queued','running','retry_wait','waiting_external','action_required'].includes(run.status))) throw new AppError('DEMO_BUSY', '진행 중인 데모 작업을 완료하거나 취소한 뒤 초기화해 주세요.', 409);
        resettingDemo = true;
        try {
          await activeService.stop(); activeStore.close(); demo = undefined;
          await rm(demoRoot, { recursive: true, force: true });
          data = await (await getDemo()).state();
        } finally { resettingDemo = false; }
      }
      else if (method === 'GET' && path === '/api/state') data = await activeService.state();
      else if (method === 'GET' && path === '/api/setup') data = await activeService.preparation.state();
      else if (/^\/api\/projects\/[a-zA-Z0-9-]{1,100}\/integration(?:\/(preview|apply|rollback))?$/.test(path)) {
        const id=path.split('/')[3]!; const action=path.split('/')[5];
        if(method==='GET'&&!action)data=await activeService.integrations.state(id);
        else if(method==='POST'&&action==='preview')data=await activeService.integrations.preview(id,body);
        else if(method==='POST'&&action==='apply')data=await activeService.integrations.apply(id,body);
        else if(method==='POST'&&action==='rollback')data=await activeService.integrations.rollback(id,body);
        else throw new AppError('NOT_FOUND','지원하지 않는 SDK 요청입니다.',404);
      }
      else if (method === 'PUT' && /^\/api\/projects\/[a-zA-Z0-9-]{1,100}\/store-app$/.test(path)) data = activeService.saveStoreApp(path.split('/')[3]!,body);
      else if (method === 'POST' && /^\/api\/projects\/[a-zA-Z0-9-]{1,100}\/store-app\/check$/.test(path)) data = await activeService.verifyStoreApp(path.split('/')[3]!,body);
      else if (method === 'PUT' && path === '/api/setup/tools') data = await activeService.preparation.saveTools(body);
      else if (method === 'POST' && path === '/api/setup/rescan') data = await activeService.preparation.rescan();
      else if (method === 'POST' && path === '/api/setup/install') data = activeService.preparation.startInstall(body);
      else if (method === 'POST' && /^\/api\/setup\/install\/[a-zA-Z0-9-]{1,100}\/cancel$/.test(path)) data = activeService.preparation.cancelInstall(path.split('/')[4]!);
      else if (method === 'PUT' && /^\/api\/projects\/[a-zA-Z0-9-]{1,100}\/preparation$/.test(path)) data = activeService.preparation.savePreferences(path.split('/')[3]!,body);
      else if (method === 'GET' && path === '/api/operations') data = await activeService.operations.state();
      else if (path === '/api/operations/portable-backups' && method === 'GET') data = await activeService.backups.state();
      else if (path === '/api/operations/portable-backups' && method === 'POST') data = await activeService.backups.create(body);
      else if (method === 'POST' && /^\/api\/operations\/portable-backups\/[a-f0-9-]{36}\/prepare-restore$/.test(path)) data = await activeService.backups.prepare(path.split('/')[4]!, body);
      else if (path === '/api/operations/portable-backups/commit-restore' && method === 'POST') {
        if (inDemo && demoRequests > 1) throw new AppError('DEMO_BUSY', '다른 데모 요청이 끝난 뒤 복원해 주세요.', 409);
        data = await activeService.backups.commit(body);
        if (inDemo) {
          resettingDemo = true;
          try {
            await activeService.stop(); activeStore.close(); demo = undefined;
            await getDemo(); data = { restartRequired: false, restored: true };
          } finally { resettingDemo = false; }
        }
      }
      else if (method === 'PUT' && path === '/api/operations/settings') data = activeService.operations.saveSettings(body);
      else if (method === 'POST' && path === '/api/operations/backup') data = await activeService.operations.backup(body);
      else if (method === 'POST' && path === '/api/operations/restore') data = await activeService.operations.restore(body);
      else if (method === 'POST' && path === '/api/operations/diagnostics') data = await activeService.operations.diagnostics();
      else if (method === 'POST' && path === '/api/operations/runners') data = await activeService.operations.registerRunner(body);
      else if (/^\/api\/operations\/runners\/[a-zA-Z0-9-]{1,100}(?:\/check)?$/.test(path)) {
        const id=path.split('/')[4]!;
        if (method === 'POST' && path.endsWith('/check')) data = await activeService.operations.checkRunner(id);
        else if (method === 'DELETE' && !path.endsWith('/check')) data = await activeService.operations.removeRunner(id);
        else throw new AppError('NOT_FOUND','지원하지 않는 러너 요청입니다.',404);
      }
      else if (method === 'POST' && path === '/api/history/query') {
        const query = object(body);
        if (!['runs', 'events'].includes(String(query.kind))) throw new AppError('INVALID_INPUT', '조회할 이력 종류를 선택해 주세요.');
        if (query.before !== undefined && (!Number.isSafeInteger(query.before) || Number(query.before) < 1)) throw new AppError('INVALID_INPUT', '이력 페이지 위치가 올바르지 않습니다.');
        data = activeStore.history({ kind: query.kind as 'runs' | 'events', before: query.before as number | undefined,
          projectId: query.projectId ? text(query.projectId, '프로젝트 ID', 100) : undefined,
          runId: query.runId ? text(query.runId, '작업 ID', 100) : undefined,
          status: query.status ? text(query.status, '작업 상태', 30) : undefined });
      }
      else if (method === 'POST' && path === '/api/media') data = await activeService.addMedia(body);
      else if (method === 'POST' && path === '/api/projects') data = await activeService.addProject(body);
      else if (method === 'POST' && path === '/api/connections') data = await activeService.addConnection(body);
      else if (method === 'POST' && path === '/api/build-credentials') data = await activeService.saveBuildCredential(body);
      else if (method === 'POST' && path === '/api/social/schedules') data = activeService.social.schedule(body);
      else if (method === 'DELETE' && socialSchedule) data = activeService.social.cancelSchedule(socialSchedule[1]!);
      else if (method === 'POST' && socialStart) data = await activeService.beginSocialOAuth(socialStart[1] as 'x' | 'threads', body, `http://127.0.0.1:${port}/api/oauth/social/callback`);
      else if (method === 'POST' && path === '/api/oauth/google/start') data = await activeService.beginOAuth(body, `http://127.0.0.1:${port}/api/oauth/google/callback`);
      else if (method === 'POST' && /^\/api\/pipelines\/[a-zA-Z0-9-]{1,100}\/cancel$/.test(path)) data = activeService.pipelines.cancel(path.split('/')[3]!);
      else if (match) {
        const [, group, id, action] = match;
        if (group === 'projects') {
          if (method === 'DELETE' && !action) data = await activeService.removeProject(id);
          else if (method === 'POST' && action === 'inspect') data = await activeService.inspect(id);
          else if (method === 'POST' && action === 'relink') data = await activeService.relinkProject(id, body);
          else if (method === 'PUT' && action === 'policy') data = activeService.savePolicy(id, body);
          else if (method === 'PUT' && action === 'build-security') data = activeService.saveBuildSecurity(id, body);
          else if (method === 'PUT' && action === 'social-policy') data = activeService.social.savePolicy(id, body);
          else if (method === 'POST' && action === 'artifacts') data = await activeService.importArtifact(id, body);
          else if (method === 'POST' && action === 'publish') data = await activeService.publish(id, body);
          else if (method === 'POST' && action === 'build') data = activeService.build(id, body);
          else throw new AppError('NOT_FOUND', '지원하지 않는 프로젝트 요청입니다.', 404);
        } else if (group === 'connections') {
          if (method === 'DELETE' && !action) data = await activeService.removeConnection(id);
          else if (method === 'POST' && action === 'check') data = await activeService.checkConnection(id);
          else if (method === 'POST' && action === 'actions') data = activeService.action(id, body);
          else if (method === 'PUT' && action === 'credentials') data = await activeService.updateCredentials(id, body);
          else if (method === 'POST' && action === 'oauth/start') data = await activeService.beginOAuth(body, `http://127.0.0.1:${port}/api/oauth/google/callback`, id);
          else if (method === 'POST' && action === 'oauth/social/start') {
            const connection = activeStore.get<import('../../packages/domain/index.js').Connection>('connection', id);
            if (!connection || !['x', 'threads'].includes(connection.provider)) throw new AppError('PROVIDER_MISMATCH', '소셜 OAuth를 지원하는 연결이 아닙니다.');
            data = await activeService.beginSocialOAuth(connection.provider as 'x' | 'threads', body, `http://127.0.0.1:${port}/api/oauth/social/callback`, id);
          }
          else throw new AppError('NOT_FOUND', '지원하지 않는 계정 요청입니다.', 404);
        } else if (group === 'build-credentials') {
          if (method === 'PUT' && !action) data = await activeService.saveBuildCredential(body, id);
          else if (method === 'DELETE' && !action) data = await activeService.removeBuildCredential(id);
          else throw new AppError('NOT_FOUND', '지원하지 않는 빌드 키 요청입니다.', 404);
        } else {
          if (method === 'POST' && action === 'cancel') data = activeService.queue.cancel(id);
          else if (method === 'POST' && action === 'retry') { data = activeStore.retry(id); activeService.queue.tick(); }
          else if (method === 'POST' && action === 'reconcile') data = activeService.reconcile(id);
          else if (method === 'POST' && action === 'resolve') data = activeService.resolveRun(id, body);
          else throw new AppError('NOT_FOUND', '지원하지 않는 작업 요청입니다.', 404);
        }
      } else throw new AppError('NOT_FOUND', '요청을 찾을 수 없습니다.', 404);
      send(response, 200, { ok: true, data });
    } catch (error) {
      const normalized = normalizeError(error);
      if (response.headersSent) response.destroy();
      else send(response, normalized.status, { ok: false, error: { code: normalized.code, message: normalized.message } });
    } finally { leaveMutation?.(); if (inDemo) demoRequests--; }
  });
  server.requestTimeout = 130_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
  const infoPath = join(directory, 'controller.json');
  try {
    await service.start();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Controller address unavailable');
    port = address.port;
    const temporary = infoPath + '.' + randomBytes(8).toString('hex') + '.tmp';
    await writeFile(temporary, JSON.stringify({ port, token, pid: process.pid, startedAt: service.startedAt }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, infoPath);
    await activation?.commit();
  } catch (error) { await service.stop(); store.close(); server.close(); await activation?.rollback(); if (activation) return startController(options); throw error; }
  return {
    port, token, directory, service,
    async close(): Promise<void> {
      if (closed) return; closed = true;
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.stop();
      if (demoOpening) await demoOpening.catch(() => {});
      if (demo) { await demo.stop(); demo.store.close(); }
      try { if (JSON.parse(await readFile(infoPath, 'utf8')).token === token) await rm(infoPath, { force: true }); } catch {}
      store.close();
    },
  };
}
