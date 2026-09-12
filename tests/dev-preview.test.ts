import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'vite';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('raw originless preview HTTP cannot obtain controller bearer access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-preview-'));
  let forwarded = 0;
  const backend = createHttpServer((request, response) => {
    forwarded++; assert.equal(request.headers.authorization, 'Bearer fixture-private-controller');
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, data: { projects: [] } }));
  });
  await new Promise<void>(done => backend.listen(0, '127.0.0.1', done));
  const backendPort = (backend.address() as { port: number }).port;
  const probe = createHttpServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(done => probe.close(() => done()));
  const old = { directory: process.env.APPOPS_DATA_DIR, port: process.env.APPOPS_PORT, dev: process.env.APPOPS_DEV_PORT };
  process.env.APPOPS_DATA_DIR = directory; process.env.APPOPS_PORT = String(backendPort); process.env.APPOPS_DEV_PORT = String(port);
  await writeFile(join(directory, 'controller.json'), JSON.stringify({ token: 'fixture-private-controller', port: backendPort }), { mode: 0o600 });
  const vite = await createServer({ configFile: resolve('vite.config.ts'), logLevel: 'silent', server: { watch: null } });
  t.after(async () => {
    await vite.close(); await new Promise<void>(done => backend.close(() => done()));
    for (const [key, value] of [['APPOPS_DATA_DIR', old.directory], ['APPOPS_PORT', old.port], ['APPOPS_DEV_PORT', old.dev]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(origin + '/api/state')).status, 401);
  assert.equal((await fetch(origin + '/api/state', { headers: { Origin: origin } })).status, 401);
  assert.equal(forwarded, 0);
  const saved = JSON.parse(await readFile(join(directory, 'dev-session.json'), 'utf8'));
  assert.equal((await stat(join(directory, 'dev-session.json'))).mode & 0o777, 0o600);
  assert.equal((await fetch(origin + '/__appops_dev_session', { method: 'POST', headers: { Origin: 'https://attacker.example', 'x-appops-preview': saved.bootstrapToken } })).status, 403);
  const boot = await fetch(origin + '/__appops_dev_session', { method: 'POST', headers: { Origin: origin, 'x-appops-preview': saved.bootstrapToken } });
  assert.equal(boot.status, 204);
  const cookie = boot.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const response = await fetch(origin + '/api/state', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(response.status, 200); assert.equal(forwarded, 1);
  assert.ok(!(await response.text()).includes('fixture-private-controller'));
});
