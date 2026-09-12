import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installAutostart,
  getAutostartStatus,
  removeAutostart,
  defaultAutostartMethod,
  renderSystemdUnit,
  renderDesktopEntry,
  renderLaunchAgentPlist,
  buildSchtasksCreateArgs,
  escapeDesktopExecArg,
  quoteWindowsArg,
  buildWindowsCommand,
  buildDesktopExec,
  escapeSystemdArg,
} from '../packages/lifecycle/index.js';
import type { AutostartDeps, AutostartTarget, CommandResult, CommandRunner } from '../packages/lifecycle/index.js';

// 실제 fs를 임시 디렉터리에 한정해 사용한다. 실제 호스트의 자동 시작 설정은 절대 건드리지 않는다.
const realFs = { readFile, writeFile, mkdir, rm, access };

function recordingRunner(log: string[][], responses: Record<string, CommandResult> = {}): CommandRunner {
  return async (command, args) => {
    log.push([command, ...args]);
    if (command === 'systemctl' && args.includes('is-enabled')) {
      return responses['is-enabled'] ?? { code: 0, stdout: 'enabled\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

async function scratch(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `appops-autostart-${prefix}-`));
}

const target: AutostartTarget = {
  id: 'local.appops.controller',
  label: '앱 운영 제어 서비스',
  description: '로그인 시 자동화 실행',
  program: '/opt/App Operations/app-operations',
  args: ['--flag', '/home/u/data dir'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

// ---------------------------------------------------------------------------
// 인코딩 규칙
// ---------------------------------------------------------------------------

test('defaultAutostartMethod maps each platform', () => {
  assert.equal(defaultAutostartMethod('linux'), 'systemd-user');
  assert.equal(defaultAutostartMethod('darwin'), 'launchagent');
  assert.equal(defaultAutostartMethod('win32'), 'schtasks');
});

test('escapeDesktopExecArg quotes reserved characters per Desktop Entry spec', () => {
  assert.equal(escapeDesktopExecArg('/usr/bin/app'), '/usr/bin/app');
  assert.equal(escapeDesktopExecArg('a b'), '"a b"');
  assert.equal(escapeDesktopExecArg('a$b'), '"a\\$b"');
  assert.equal(escapeDesktopExecArg('a"b'), '"a\\"b"');
  assert.equal(escapeDesktopExecArg('a`b'), '"a\\`b"');
});

test('buildDesktopExec quotes program and args with spaces', () => {
  const exec = buildDesktopExec('/opt/My App/run', ['--data', '/home/u/a b']);
  assert.equal(exec, '"/opt/My App/run" --data "/home/u/a b"');
});

test('quoteWindowsArg follows CommandLineToArgvW rules', () => {
  assert.equal(quoteWindowsArg('simple'), 'simple');
  assert.equal(quoteWindowsArg('has space'), '"has space"');
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"');
  // 따옴표 앞 백슬래시는 2배, 그 외 백슬래시는 그대로.
  assert.equal(quoteWindowsArg('C:\\Program Files\\app.exe'), '"C:\\Program Files\\app.exe"');
  assert.equal(buildWindowsCommand('C:\\a b\\x.exe', ['--p']), '"C:\\a b\\x.exe" --p');
});

test('escapeSystemdArg quotes whitespace-bearing arguments', () => {
  assert.equal(escapeSystemdArg('/opt/app'), '/opt/app');
  assert.equal(escapeSystemdArg('/opt/a b'), '"/opt/a b"');
});

// ---------------------------------------------------------------------------
// 콘텐츠 렌더러
// ---------------------------------------------------------------------------

test('renderSystemdUnit produces a login user service that respects explicit stop', () => {
  const unit = renderSystemdUnit(target);
  assert.match(unit, /Type=simple/);
  // 환경 변수는 공백 파손·주입을 막기 위해 Environment="KEY=value" 형태로 감싼다.
  assert.match(unit, /Environment="ELECTRON_RUN_AS_NODE=1"/);
  assert.match(unit, /ExecStart="\/opt\/App Operations\/app-operations" --flag "\/home\/u\/data dir"/);
  assert.match(unit, /Restart=on-failure/); // 정상 종료(SIGTERM)는 재기동하지 않는다
  // SIGKILL 승격이 자동 재기동으로 이어지지 않도록 성공 종료로 처리한다.
  assert.match(unit, /SuccessExitStatus=SIGKILL/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('renderDesktopEntry injects env and enables autostart', () => {
  const entry = renderDesktopEntry(target);
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /Exec=env ELECTRON_RUN_AS_NODE=1 "\/opt\/App Operations\/app-operations" --flag "\/home\/u\/data dir"/);
  assert.match(entry, /X-GNOME-Autostart-enabled=true/);
  assert.match(entry, /Hidden=false/);
});

test('renderLaunchAgentPlist runs at load but does not KeepAlive (respects explicit stop)', () => {
  const plist = renderLaunchAgentPlist(target);
  assert.match(plist, /<key>Label<\/key>\s*<string>local\.appops\.controller<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /<key>EnvironmentVariables<\/key>/);
});

test('buildSchtasksCreateArgs uses ONLOGON with the identifier and encoded command', () => {
  const winTarget: AutostartTarget = {
    id: 'local.appops.controller',
    label: 'x',
    program: 'C:\\Program Files\\App Operations\\app.exe',
    args: [],
    env: { APPOPS_CONTROLLER_ONLY: '1' },
  };
  const args = buildSchtasksCreateArgs(winTarget);
  assert.ok(args.includes('/Create'));
  assert.equal(args[args.indexOf('/TN') + 1], 'local.appops.controller');
  assert.equal(args[args.indexOf('/SC') + 1], 'ONLOGON');
  const tr = args[args.indexOf('/TR') + 1]!;
  assert.match(tr, /set "APPOPS_CONTROLLER_ONLY=1"/);
  assert.match(tr, /"C:\\Program Files\\App Operations\\app\.exe"/);
});

// ---------------------------------------------------------------------------
// install / status / remove (임시 디렉터리 + 목 러너)
// ---------------------------------------------------------------------------

test('systemd-user install writes the unit, enables it, and remove disables it', async () => {
  const dir = await scratch('systemd');
  const log: string[][] = [];
  const deps: AutostartDeps = { fs: realFs, runner: recordingRunner(log), configHome: dir };
  try {
    const installed = await installAutostart('systemd-user', target, deps);
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, true);
    const path = join(dir, 'systemd/user/local.appops.controller.service');
    await access(path); // 파일이 생성됨
    assert.ok(log.some((c) => c[0] === 'systemctl' && c.includes('enable') && c.includes('local.appops.controller.service')));

    const status = await getAutostartStatus('systemd-user', target, deps);
    assert.equal(status.installed, true);
    assert.equal(status.enabled, true);

    await removeAutostart('systemd-user', target, deps);
    assert.ok(log.some((c) => c[0] === 'systemctl' && c.includes('disable')));
    await assert.rejects(access(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('xdg-autostart install writes a .desktop, status reads enabled, Hidden=true disables', async () => {
  const dir = await scratch('xdg');
  const deps: AutostartDeps = { fs: realFs, configHome: dir };
  try {
    await installAutostart('xdg-autostart', target, deps);
    const path = join(dir, 'autostart/local.appops.controller.desktop');
    const content = await readFile(path, 'utf8');
    assert.match(content, /Exec=env ELECTRON_RUN_AS_NODE=1 "\/opt\/App Operations\/app-operations"/);

    let status = await getAutostartStatus('xdg-autostart', target, deps);
    assert.equal(status.enabled, true);

    // 사용자가 Hidden=true로 비활성화한 경우.
    await writeFile(path, content.replace('Hidden=false', 'Hidden=true'));
    status = await getAutostartStatus('xdg-autostart', target, deps);
    assert.equal(status.installed, true);
    assert.equal(status.enabled, false);

    await removeAutostart('xdg-autostart', target, deps);
    await assert.rejects(access(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status reports not-installed before install', async () => {
  const dir = await scratch('empty');
  const deps: AutostartDeps = { fs: realFs, configHome: dir, runner: recordingRunner([]) };
  try {
    const status = await getAutostartStatus('xdg-autostart', target, deps);
    assert.equal(status.installed, false);
    assert.equal(status.enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('launchagent install writes the plist and loads it, status detects RunAtLoad', async () => {
  const dir = await scratch('launchagent');
  const log: string[][] = [];
  const deps: AutostartDeps = { fs: realFs, runner: recordingRunner(log), launchAgentsDir: dir };
  try {
    await installAutostart('launchagent', target, deps);
    const path = join(dir, 'local.appops.controller.plist');
    await access(path);
    assert.ok(log.some((c) => c[0] === 'launchctl' && c.includes('load')));

    const status = await getAutostartStatus('launchagent', target, deps);
    assert.equal(status.enabled, true);

    await removeAutostart('launchagent', target, deps);
    assert.ok(log.some((c) => c[0] === 'launchctl' && c.includes('unload')));
    await assert.rejects(access(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('schtasks install/status/remove drive schtasks with the identifier', async () => {
  const log: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    log.push([command, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps: AutostartDeps = { fs: realFs, runner };
  const winTarget: AutostartTarget = {
    id: 'local.appops.controller',
    label: 'x',
    program: 'C:\\App\\app.exe',
    args: [],
    env: { APPOPS_CONTROLLER_ONLY: '1' },
  };
  const installed = await installAutostart('schtasks', winTarget, deps);
  assert.equal(installed.installed, true);
  assert.ok(log.some((c) => c[0] === 'schtasks' && c.includes('/Create')));

  await getAutostartStatus('schtasks', winTarget, deps);
  assert.ok(log.some((c) => c[0] === 'schtasks' && c.includes('/Query')));

  await removeAutostart('schtasks', winTarget, deps);
  assert.ok(log.some((c) => c[0] === 'schtasks' && c.includes('/Delete')));
});
