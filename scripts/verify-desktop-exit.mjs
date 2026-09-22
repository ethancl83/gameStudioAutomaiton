// npm run build 후 node scripts/verify-desktop-exit.mjs.
// 임시 데이터와 가짜 Codex 실행기를 사용하되 앱·제어 서비스·프로세스 종료 경로는 제품 코드다.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(50); }
  throw new Error(label + ' timed out');
}
async function json(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

if (process.env.APPOPS_EXIT_CONTROLLER === '1') {
  const { startController } = await import('../dist/apps/controller/server.js');
  const controller = await startController({ port: Number(process.env.APPOPS_PORT), scanToolchains: async () => [],
    agent: { discover: async () => [{ provider: 'codex', executable: process.env.APPOPS_EXIT_CLI }] },
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void controller.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} else if (process.versions.electron) {
  const { app, BrowserWindow } = await import('electron');
  const directory = process.env.APPOPS_DATA_DIR;
  const fail = error => {
    console.error(error);
    writeFileSync(join(directory, 'failure.txt'), String(error));
    app.quit(); // 실패해도 제품의 종료 정리를 거친다.
  };
  process.on('unhandledRejection', fail);
  app.setPath('userData', join(directory, 'electron'));
  void (async () => {
    try {
      await import('../dist/apps/desktop/electron/main.js');
      const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
      const kind = process.env.APPOPS_EXIT_CASE;
      if (kind === 'startup') { win.close(); return; }
      const info = await until(async () => {
        const found = await json(join(directory, 'controller.json'));
        if (!found) return null;
        return (await fetch(`http://127.0.0.1:${found.port}/api/health`).catch(() => null))?.ok ? found : null;
      }, 'controller');
      await writeFile(join(directory, 'report.json'), JSON.stringify({ pid: info.pid, port: info.port }));
      if (kind === 'quit') {
        const response = await fetch(`http://127.0.0.1:${info.port}/api/agent/requests`, {
          method: 'POST', headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ screen: 'agent', message: '종료 검사: 대기해 줘.' }),
        });
        assert.equal(response.ok, true);
        await until(() => json(join(directory, 'cli-pids.json')), 'fixture CLI');
        app.quit();
      } else win.close();
    } catch (error) { fail(error); }
  })();
} else {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const { default: electron } = await import('electron');
  const directory = await mkdtemp(join(tmpdir(), 'appops-exit-'));
  try {
    for (const kind of ['window', 'quit', 'startup']) {
      const data = join(directory, kind); await mkdir(data);
      const bin = join(data, 'bin'); await mkdir(bin);
      await writeFile(join(bin, 'codex'), `#!/usr/bin/env node
const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
writeFileSync(process.env.APPOPS_DATA_DIR+'/cli-pids.json',JSON.stringify([process.pid,child.pid]));
console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
`, { mode: 0o700 });
      if (kind === 'quit') await writeFile(join(data, 'desktop-mode.json'), JSON.stringify({ mode: 'live' }));
      const reservation = createServer();
      await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      if (kind === 'quit') {
        // 기존 discover 주입 경계로 CLI만 대체한다. PATH보다 우선하는 사용자 CLI는 실행하지 않는다.
        spawn(process.execPath, [fileURLToPath(import.meta.url)], { cwd: root, stdio: 'inherit', env: {
          ...process.env, APPOPS_DATA_DIR: data, APPOPS_PORT: String(port),
          APPOPS_EXIT_CONTROLLER: '1', APPOPS_EXIT_CLI: join(bin, 'codex'),
        } });
        await until(() => json(join(data, 'controller.json')), 'fixture controller');
      }
      const child = spawn(electron, [fileURLToPath(import.meta.url)], { cwd: root, stdio: 'inherit', env: {
        ...process.env, APPOPS_DATA_DIR: data, APPOPS_PORT: String(port), APPOPS_EXIT_CASE: kind,
        APPOPS_DEV_SERVER_URL: '', APPOPS_API_URL: '',
      } });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 35000);
      try {
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
        assert.equal(code, 0, kind + ': application must exit');
        await assert.rejects(readFile(join(data, 'failure.txt')), { code: 'ENOENT' }, 'Electron must not report an error');
        const report = await json(join(data, 'report.json'));
        if (report) await until(() => !alive(report.pid), kind + ': controller exit', 3000);
        if (report) await readFile(join(data, 'controller.stop'));
        const pids = await json(join(data, 'cli-pids.json'));
        if (kind === 'quit') assert.equal(pids?.length, 2);
        for (const pid of pids ?? []) await until(() => !alive(pid), 'CLI descendant exit', 3000);
        assert.equal(await json(join(data, 'controller.json')), null, 'controller record must be removed');
        await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }));
        console.log(`PASS ${kind}: 앱·제어 서비스·포트 종료${pids ? ', CLI 및 자식 종료' : ''}`);
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        const info = await json(join(data, 'report.json')) ?? await json(join(data, 'controller.json'));
        for (const pid of [...(await json(join(data, 'cli-pids.json')) ?? []), ...(info?.pid ? [info.pid] : [])]) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
        }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
