// npm run build 후 실행. 격리한 제어 서비스와 실제 Electron 창에서 모드 전환을 검증한다.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function until(read, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`${description}: 5초 안에 완료되지 않았습니다.`);
}

if (process.versions.electron) {
  const { app, BrowserWindow, dialog } = await import('electron');
  app.setPath('userData', join(process.env.APPOPS_DATA_DIR, 'electron'));
  let response = 0;
  let confirmations = 0;
  // 외부 작업 없이 확인창의 취소/승인 결과만 주입한다. 모드 IPC와 탐색 핸들러는 제품 코드다.
  dialog.showMessageBox = async () => { confirmations++; return { response, checkboxChecked: false }; };
  // Electron의 ready 이벤트가 발생하도록 진입 모듈의 평가를 먼저 끝낸다.
  async function verify() {
    try {
      await import('../dist/apps/desktop/electron/main.js');
      const win = await until(() => BrowserWindow.getAllWindows()[0], '창 생성');
      const wc = win.webContents;
      const read = expression => wc.executeJavaScript(expression);
      const ready = mode => until(() => read(`!!document.querySelector('.mode-switch--${mode}') && !!document.querySelector('.agent-chat')`), `${mode} 화면 전환`);
      const click = mode => read(`document.querySelector('.mode-switch__toggle button:nth-child(${mode === 'demo' ? 1 : 2})').click(); true`);
      await ready('demo');
      const originalPage = await read('performance.timeOrigin');
      await click('live');
      await until(() => confirmations === 1, '실제 모드 확인창');
      assert.equal(await read('window.appOps.getMode()'), 'demo');
      assert.equal(await read('performance.timeOrigin'), originalPage, '취소 시 기존 화면 보존');
      console.log('PASS 실제 모드 전환 취소');

      response = 1;
      for (const mode of ['live', 'demo', 'live', 'demo']) {
        const previousPage = await read('performance.timeOrigin');
        const started = Date.now();
        await click(mode);
        await ready(mode);
        assert.notEqual(await read('performance.timeOrigin'), previousPage, '새 클라이언트로 재로딩');
        assert.equal(await read('window.appOps.getMode()'), mode);
        const state = await read(`window.appOps.request('GET', '${mode === 'demo' ? '/demo' : ''}/state')`);
        assert.equal(state.ok, true);
        assert.equal(state.data.runtime.mode, mode, '화면과 데이터 모드 일치');
        const wrong = await read(`window.appOps.request('GET', '${mode === 'demo' ? '' : '/demo'}/state')`);
        assert.equal(wrong.error?.code, 'mode_mismatch', '다른 모드 요청 차단');
        console.log(`PASS ${mode} 전환 ${Date.now() - started}ms`);
      }
      assert.equal(confirmations, 3, '실제 전환 시에만 한 번씩 확인');
      // 제품에 등록된 핸들러를 직접 호출해 외부/다른 로컬 페이지 차단도 확인한다.
      for (const url of ['https://example.com', new URL('./other.html', wc.getURL()).href]) {
        let blocked = false;
        wc.emit('will-navigate', { preventDefault() { blocked = true; } }, url);
        assert.equal(blocked, true, `비신뢰 탐색 차단: ${url}`);
      }
      console.log('PASS 비신뢰 탐색 차단');
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  }
  void verify();
} else {
  const { spawn } = await import('node:child_process');
  const { default: electron } = await import('electron');
  const { startController } = await import('../dist/apps/controller/server.js');
  const directory = await mkdtemp(join(tmpdir(), 'appops-mode-check-'));
  let controller;
  try {
    controller = await startController({ directory, port: 0, scanToolchains: async () => [] });
    const child = spawn(electron, [fileURLToPath(import.meta.url)], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, APPOPS_DATA_DIR: directory, APPOPS_DEV_SERVER_URL: '', APPOPS_API_URL: '' },
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => resolve(code ?? 1));
      });
    } finally { clearTimeout(timer); }
  } finally {
    await controller?.close();
    await rm(directory, { recursive: true, force: true });
    await rm(directory + '.demo', { recursive: true, force: true });
  }
}
