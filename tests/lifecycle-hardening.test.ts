// v4 설치·수명주기 리뷰 후속 하드닝 회귀 테스트.
// - P1-2: autostart 아티팩트의 값 인코딩(지시문 주입·공백 파손·% 필드코드·cmd 메타·/TR 상한).
// - P1-1(수명주기): 내구성 있는 명시적 중지 표식(강제 종료 후에도 자동 재기동 차단).
// - P2-5: schtasks 비활성(Disabled) 작업을 "켜짐"으로 보고하지 않음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderSystemdUnit,
  renderDesktopEntry,
  buildSchtasksCreateArgs,
  buildSchtasksQueryArgs,
  parseSchtasksState,
  getAutostartStatus,
  validateAutostartTarget,
  buildControllerAutostartTarget,
  escapeDesktopExecArg,
  buildSystemdEnvLine,
  ensureController,
  stopController,
  markIntentionalStop,
  clearIntentionalStop,
  isIntentionalStop,
  readIntentionalStop,
  stopFencePath,
} from '../packages/lifecycle/index.js';
import type {
  AutostartDeps,
  AutostartTarget,
  CommandRunner,
  ControllerDeps,
  ControllerInfo,
  FsLike,
} from '../packages/lifecycle/index.js';

const realFs: FsLike = { readFile, writeFile, mkdir, rm, access };

function targetWith(overrides: Partial<AutostartTarget>): AutostartTarget {
  return {
    id: 'local.appops.controller',
    label: '앱 운영 제어 서비스',
    description: '로그인 시 자동화',
    program: '/opt/App Operations/app-operations',
    args: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// P1-2: systemd 환경 인코딩
// ---------------------------------------------------------------------------

test('systemd Environment quotes spaces and escapes quotes/backslashes', () => {
  assert.equal(buildSystemdEnvLine('APPOPS_DATA_DIR', '/home/u/My Data'), 'Environment="APPOPS_DATA_DIR=/home/u/My Data"');
  assert.equal(buildSystemdEnvLine('K', 'a"b\\c'), 'Environment="K=a\\"b\\\\c"');
  const unit = renderSystemdUnit(targetWith({ env: { APPOPS_DATA_DIR: '/home/u/My Data' } }));
  assert.match(unit, /Environment="APPOPS_DATA_DIR=\/home\/u\/My Data"/);
  // 공백에서 분리된 잘못된 할당이 생기지 않는다.
  assert.doesNotMatch(unit, /Environment=APPOPS_DATA_DIR=\/home\/u\/My Data\b/);
});

test('systemd rejects a newline-injected env value (no ExecStartPre injection)', () => {
  assert.throws(
    () => renderSystemdUnit(targetWith({ env: { APPOPS_DATA_DIR: '/x\nExecStartPre=/bin/sh -c "id"' } })),
    /제어문자/,
  );
});

test('systemd rejects control chars in workingDirectory and description', () => {
  assert.throws(() => renderSystemdUnit(targetWith({ workingDirectory: '/a\nWorkingDirectory=/evil' })), /제어문자/);
  assert.throws(() => renderSystemdUnit(targetWith({ description: 'x\nExecStart=/evil' })), /제어문자/);
});

// ---------------------------------------------------------------------------
// P1-2: Desktop Entry 인코딩
// ---------------------------------------------------------------------------

test('escapeDesktopExecArg escapes literal percent to %% (field-code safe)', () => {
  assert.equal(escapeDesktopExecArg('/opt/app/%U/x'), '/opt/app/%%U/x');
  // 공백이 함께 있으면 인용 + %% 둘 다 적용.
  assert.equal(escapeDesktopExecArg('/opt/a b/%U'), '"/opt/a b/%%U"');
});

test('renderDesktopEntry encodes env prefix tokens and percent paths', () => {
  const entry = renderDesktopEntry(
    targetWith({ program: '/opt/app/%U/run', env: { APPOPS_DATA_DIR: '/home/u/My Data' } }),
  );
  // env 접두 토큰이 공백에서 깨지지 않도록 인용된다.
  assert.match(entry, /Exec=env "APPOPS_DATA_DIR=\/home\/u\/My Data" \/opt\/app\/%%U\/run/);
});

test('renderDesktopEntry rejects newline injection in a value', () => {
  assert.throws(() => renderDesktopEntry(targetWith({ env: { K: 'v\nExec=/evil' } })), /제어문자/);
});

// ---------------------------------------------------------------------------
// P1-2: schtasks 인코딩 (cmd 메타·/TR 상한)
// ---------------------------------------------------------------------------

test('buildSchtasksCreateArgs rejects cmd metacharacters in env values (injection)', () => {
  assert.throws(() => buildSchtasksCreateArgs(targetWith({ program: 'C:\\App\\a.exe', env: { K: 'v & calc.exe' } })), /메타문자/);
  assert.throws(() => buildSchtasksCreateArgs(targetWith({ program: 'C:\\App\\a.exe', env: { K: 'v"x' } })), /메타문자/);
});

test('buildSchtasksCreateArgs accepts a safe env value and stays under the /TR limit', () => {
  const args = buildSchtasksCreateArgs(targetWith({ program: 'C:\\App\\a.exe', env: { APPOPS_CONTROLLER_ONLY: '1' } }));
  const tr = args[args.indexOf('/TR') + 1]!;
  assert.match(tr, /set "APPOPS_CONTROLLER_ONLY=1"/);
  assert.ok(tr.length <= 261);
});

test('buildSchtasksCreateArgs rejects an over-long /TR command', () => {
  const longPath = 'C:\\' + 'a'.repeat(300) + '\\app.exe';
  assert.throws(() => buildSchtasksCreateArgs(targetWith({ program: longPath, env: { APPOPS_CONTROLLER_ONLY: '1' } })), /상한/);
});

// ---------------------------------------------------------------------------
// P1-2: 진입점 제어문자 거부
// ---------------------------------------------------------------------------

test('buildControllerAutostartTarget rejects control chars in dataDir at the entry point', () => {
  assert.throws(
    () =>
      buildControllerAutostartTarget({
        program: '/opt/app',
        controllerEntry: '/opt/app/main.js',
        dataDir: '/home/u\nEnvironment=EVIL=1',
      }),
    /제어문자/,
  );
});

test('validateAutostartTarget rejects a NUL byte anywhere', () => {
  assert.throws(() => validateAutostartTarget(targetWith({ args: ['ok', 'bad\u0000arg'] })), /제어문자/);
});

// ---------------------------------------------------------------------------
// P2-5: schtasks 비활성 상태
// ---------------------------------------------------------------------------

test('buildSchtasksQueryArgs requests verbose list output for state parsing', () => {
  const args = buildSchtasksQueryArgs('local.appops.controller');
  assert.ok(args.includes('/V'));
  assert.equal(args[args.indexOf('/FO') + 1], 'LIST');
});

test('parseSchtasksState extracts Disabled/Ready', () => {
  assert.equal(parseSchtasksState('Scheduled Task State:                   Disabled'), 'disabled');
  assert.equal(parseSchtasksState('Scheduled Task State:                   Ready'), 'ready');
  assert.equal(parseSchtasksState('nothing here'), null);
});

test('getAutostartStatus reports a disabled schtasks task as NOT enabled (no false green)', async () => {
  const disabledRunner: CommandRunner = async () => ({
    code: 0,
    stdout: 'TaskName: \\local.appops.controller\nScheduled Task State:                   Disabled\n',
    stderr: '',
  });
  const enabledRunner: CommandRunner = async () => ({
    code: 0,
    stdout: 'TaskName: \\local.appops.controller\nScheduled Task State:                   Ready\n',
    stderr: '',
  });
  const win = targetWith({ program: 'C:\\App\\a.exe', env: { APPOPS_CONTROLLER_ONLY: '1' } });
  const disabled = await getAutostartStatus('schtasks', win, { fs: realFs, runner: disabledRunner });
  assert.equal(disabled.installed, true);
  assert.equal(disabled.enabled, false);
  const enabled = await getAutostartStatus('schtasks', win, { fs: realFs, runner: enabledRunner });
  assert.equal(enabled.enabled, true);
});

// ---------------------------------------------------------------------------
// P1-1(수명주기): 내구성 있는 명시적 중지 표식
// ---------------------------------------------------------------------------

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'appops-fence-'));
}

test('stop-fence mark/clear/read round-trips under an injected fs', async () => {
  const dir = await scratchDir();
  try {
    assert.equal(await isIntentionalStop(realFs, dir), false);
    await markIntentionalStop(realFs, dir, { pid: 4242, reason: 'user_explicit_stop' });
    assert.equal(await isIntentionalStop(realFs, dir), true);
    const record = await readIntentionalStop(realFs, dir);
    assert.equal(record?.pid, 4242);
    assert.equal(record?.reason, 'user_explicit_stop');
    assert.ok(record?.stoppedAt && !Number.isNaN(Date.parse(record.stoppedAt)));
    await access(stopFencePath(dir)); // 파일이 실제로 생성됨
    await clearIntentionalStop(realFs, dir);
    assert.equal(await isIntentionalStop(realFs, dir), false);
    await clearIntentionalStop(realFs, dir); // 없어도 안전
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stopController marks the durable stop fence even when it escalates to SIGKILL', async () => {
  const dir = await scratchDir();
  try {
    const info: ControllerInfo = { port: 4317, token: 't', pid: 888, startedAt: 'A' };
    const killed: string[] = [];
    let clock = 0;
    const deps: ControllerDeps = {
      readInfo: async () => info, // 절대 사라지지 않음 → SIGKILL 승격
      checkHealth: async () => true,
      spawnController: () => ({}),
      killPid: (_pid, signal) => {
        killed.push(String(signal));
        return true;
      },
      delay: async () => {},
      now: () => (clock += 500),
      markStopIntent: () => markIntentionalStop(realFs, dir, { pid: info.pid, reason: 'user_explicit_stop' }),
      clearStopIntent: () => clearIntentionalStop(realFs, dir),
    };
    const out = await stopController(deps, { stopTimeoutMs: 1000, pollIntervalMs: 100 });
    assert.deepEqual(killed, ['SIGTERM', 'SIGKILL']);
    assert.equal(out.stopped, true);
    // 강제 종료 후에도 표식이 남아 서비스 매니저 자동 재기동이 진입점에서 차단된다.
    assert.equal(await isIntentionalStop(realFs, dir), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stopController does NOT mark the fence for an unverified (reused) pid', async () => {
  const dir = await scratchDir();
  try {
    const info: ControllerInfo = { port: 4317, token: 't', pid: 12345, startedAt: 'A' };
    const deps: ControllerDeps = {
      readInfo: async () => info,
      checkHealth: async () => false, // 신원 미확인
      spawnController: () => ({}),
      killPid: () => true,
      delay: async () => {},
      markStopIntent: () => markIntentionalStop(realFs, dir, { pid: info.pid }),
      clearStopIntent: () => clearIntentionalStop(realFs, dir),
    };
    const out = await stopController(deps);
    assert.equal(out.stopped, false);
    assert.equal(await isIntentionalStop(realFs, dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureController clears the stop fence before an explicit start', async () => {
  const dir = await scratchDir();
  try {
    await markIntentionalStop(realFs, dir, { reason: 'prev_stop' });
    assert.equal(await isIntentionalStop(realFs, dir), true);
    let info: ControllerInfo | null = null;
    let healthy = false;
    const deps: ControllerDeps = {
      readInfo: async () => info,
      checkHealth: async () => healthy,
      spawnController: () => {
        info = { port: 4317, token: 't', pid: 200, startedAt: 'B' };
        healthy = true;
        return { pid: 200 };
      },
      killPid: () => true,
      delay: async () => {},
      markStopIntent: () => markIntentionalStop(realFs, dir, {}),
      clearStopIntent: () => clearIntentionalStop(realFs, dir),
    };
    const out = await ensureController(deps, { startTimeoutMs: 5000, pollIntervalMs: 10 });
    assert.equal(out.status, 'started');
    // 명시적 시작이 표식을 지웠으므로 이후 진입점이 정상 기동한다.
    assert.equal(await isIntentionalStop(realFs, dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
