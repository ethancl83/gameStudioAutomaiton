// OS 사용자별 로그인 자동 시작 설치/상태/제거.
// - Linux: systemd user 유닛 또는 XDG 데스크톱 자동 시작
// - macOS: LaunchAgent (~/Library/LaunchAgents)
// - Windows: 예약 작업(schtasks, ONLOGON)
//
// 로그인 시 기동하는 대상은 "제어 서비스"다. 화면이 없어도 인가된 자동화가 실행된다.
// 재시작 정책은 명시적 중지를 존중한다: 정상 종료(SIGTERM/exit 0)는 자동 재기동하지 않는다
// (systemd Restart=on-failure, LaunchAgent KeepAlive=false, schtasks 단발 ONLOGON).
//
// 모든 부수효과는 주입한 fs/runner로 수행해 실제 호스트를 건드리지 않고 테스트한다.

import {
  assertNoControlChars,
  buildDesktopExec,
  buildSystemdEnvLine,
  buildSystemdExec,
  buildWindowsCommand,
  escapeDesktopExecArg,
  escapeXml,
} from './encoding.js';
import type {
  AutostartMethod,
  AutostartStatus,
  AutostartTarget,
  CommandRunner,
  FsLike,
  Platform,
} from './types.js';

// 렌더링 전에 대상의 모든 문자열 필드에서 제어문자(개행·NUL 포함)를 거부한다.
// 타깃이 어떤 경로로 만들어졌든(빌더/수기 구성/main의 재설정) 렌더 시점에 불변식을 강제한다.
export function validateAutostartTarget(target: AutostartTarget): void {
  assertNoControlChars('id', target.id);
  assertNoControlChars('label', target.label);
  if (target.description !== undefined) assertNoControlChars('description', target.description);
  assertNoControlChars('program', target.program);
  target.args.forEach((arg, i) => assertNoControlChars(`args[${i}]`, arg));
  if (target.workingDirectory !== undefined) assertNoControlChars('workingDirectory', target.workingDirectory);
  if (target.env) {
    for (const [key, value] of Object.entries(target.env)) {
      assertNoControlChars(`env key`, key);
      assertNoControlChars(`env[${key}]`, value);
    }
  }
}

export interface AutostartDeps {
  fs: FsLike;
  runner?: CommandRunner;
  // 파일 기반 방식의 설정 루트. 미지정 시 각 install/status/remove가 경로를 요구한다.
  configHome?: string; // Linux: ~/.config
  launchAgentsDir?: string; // macOS: ~/Library/LaunchAgents
}

export function defaultAutostartMethod(platform: Platform): AutostartMethod {
  switch (platform) {
    case 'darwin':
      return 'launchagent';
    case 'win32':
      return 'schtasks';
    default:
      return 'systemd-user';
  }
}

// ---------------------------------------------------------------------------
// 콘텐츠 렌더러 (순수 함수, 스크립트·테스트에서 직접 사용 가능)
// ---------------------------------------------------------------------------

export function renderSystemdUnit(target: AutostartTarget): string {
  validateAutostartTarget(target);
  const exec = buildSystemdExec(target.program, target.args);
  const env = target.env
    ? Object.entries(target.env)
        .map(([key, value]) => buildSystemdEnvLine(key, value))
        .join('\n') + '\n'
    : '';
  const workdir = target.workingDirectory ? `WorkingDirectory=${target.workingDirectory}\n` : '';
  return `[Unit]
Description=${target.description ?? target.label}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${env}${workdir}ExecStart=${exec}
Restart=on-failure
RestartSec=5
# 명시적 중지가 자식 프로세스 정리를 위해 SIGKILL로 승격되어도 자동 재기동으로 이어지지 않게 한다.
# 내구성 있는 중지 표식(controller.stop)이 근본 방어이고, 이 줄은 systemd가 재기동을 시도조차
# 하지 않도록 하는 이중 안전장치다.
SuccessExitStatus=SIGKILL

[Install]
WantedBy=default.target
`;
}

export function renderDesktopEntry(target: AutostartTarget): string {
  validateAutostartTarget(target);
  // env는 Exec 앞에 env(1) 래퍼로 주입한다(Linux 표준 유틸리티).
  // 접두 토큰(KEY=value)도 Exec 인자이므로 반드시 escapeDesktopExecArg를 거쳐 공백·예약문자·%를
  // 안전하게 인코딩한다.
  const envPrefix = target.env
    ? 'env ' +
      Object.entries(target.env)
        .map(([key, value]) => escapeDesktopExecArg(`${key}=${value}`))
        .join(' ') +
      ' '
    : '';
  const exec = envPrefix + buildDesktopExec(target.program, target.args);
  const path = target.workingDirectory ? `Path=${target.workingDirectory}\n` : '';
  return `[Desktop Entry]
Type=Application
Name=${target.label}
Comment=${target.description ?? target.label}
Exec=${exec}
${path}Terminal=false
X-GNOME-Autostart-enabled=true
Hidden=false
`;
}

export function renderLaunchAgentPlist(target: AutostartTarget): string {
  validateAutostartTarget(target);
  const argv = [target.program, ...target.args]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');
  const envBlock = target.env
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n` +
      Object.entries(target.env)
        .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
        .join('\n') +
      `\n  </dict>\n`
    : '';
  const workdir = target.workingDirectory
    ? `  <key>WorkingDirectory</key>\n  <string>${escapeXml(target.workingDirectory)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(target.id)}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
${envBlock}${workdir}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
}

// cmd(1) 메타문자. `cmd /c "set ... & program"` 래퍼의 set 값에 들어가면 명령 주입이 가능하므로
// 환경 키/값에 하나라도 있으면 설치를 실패시킨다(정적 방어; Windows 런타임 증거는 별도).
const CMD_META = /["&|<>^%()!]/;

// schtasks /TR 문자열의 역사적 상한. 초과하면 작업 등록이 조용히 잘리거나 실패한다.
const SCHTASKS_TR_MAX = 261;

// schtasks 인자. env는 cmd /c 래퍼의 set으로 주입한다.
// - 제어문자(개행·NUL 등)는 validateAutostartTarget으로 거부.
// - cmd 메타문자(" & | < > ^ % ( ) !)가 env 키/값에 있으면 주입 위험이므로 설치를 거부.
// - 최종 /TR 문자열이 상한을 넘으면 거부.
export function buildSchtasksCreateArgs(target: AutostartTarget): string[] {
  validateAutostartTarget(target);
  let command = buildWindowsCommand(target.program, target.args);
  if (target.env) {
    const sets = Object.entries(target.env)
      .map(([key, value]) => {
        if (CMD_META.test(key) || CMD_META.test(value)) {
          throw new Error(`자동 시작 환경 값에 cmd 메타문자가 있어 거부합니다: ${key}`);
        }
        return `set "${key}=${value}"`;
      })
      .join(' & ');
    command = `cmd /c "${sets} & ${command}"`;
  }
  if (command.length > SCHTASKS_TR_MAX) {
    throw new Error(`schtasks /TR 명령이 상한(${SCHTASKS_TR_MAX}자)을 초과합니다: ${command.length}자`);
  }
  return ['/Create', '/TN', target.id, '/TR', command, '/SC', 'ONLOGON', '/F', '/RL', 'LIMITED'];
}

export function buildSchtasksDeleteArgs(id: string): string[] {
  return ['/Delete', '/TN', id, '/F'];
}

// 상세 목록 형식으로 조회한다. 종료 코드만으로는 비활성(Disabled) 작업을 구분할 수 없으므로
// "Scheduled Task State"를 파싱하려면 /V(자세히) + /FO LIST가 필요하다.
export function buildSchtasksQueryArgs(id: string): string[] {
  return ['/Query', '/TN', id, '/FO', 'LIST', '/V'];
}

// schtasks /FO LIST /V 출력에서 작업 상태(enabled/disabled/ready/running/…)를 추출한다.
// 없으면 null. 영어 로케일 필드명을 기준으로 한다.
export function parseSchtasksState(stdout: string): string | null {
  const state = stdout.match(/Scheduled Task State:\s*(\S+)/i);
  if (state) return state[1].toLowerCase();
  const status = stdout.match(/(?:^|\n)\s*Status:\s*(\S+)/i);
  if (status) return status[1].toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// 경로 헬퍼
// ---------------------------------------------------------------------------

function systemdUnitPath(deps: AutostartDeps, id: string): string {
  requireConfigHome(deps);
  return `${deps.configHome}/systemd/user/${id}.service`;
}

function desktopEntryPath(deps: AutostartDeps, id: string): string {
  requireConfigHome(deps);
  return `${deps.configHome}/autostart/${id}.desktop`;
}

function launchAgentPath(deps: AutostartDeps, id: string): string {
  if (!deps.launchAgentsDir) throw new Error('launchAgentsDir가 필요합니다.');
  return `${deps.launchAgentsDir}/${id}.plist`;
}

function requireConfigHome(deps: AutostartDeps): void {
  if (!deps.configHome) throw new Error('configHome가 필요합니다.');
}

function requireRunner(deps: AutostartDeps): CommandRunner {
  if (!deps.runner) throw new Error('runner가 필요합니다.');
  return deps.runner;
}

async function exists(fs: FsLike, path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFileEnsured(deps: AutostartDeps, path: string, content: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) await deps.fs.mkdir(dir, { recursive: true });
  await deps.fs.writeFile(path, content, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// install / status / remove
// ---------------------------------------------------------------------------

export async function installAutostart(
  method: AutostartMethod,
  target: AutostartTarget,
  deps: AutostartDeps,
): Promise<AutostartStatus> {
  switch (method) {
    case 'systemd-user': {
      const path = systemdUnitPath(deps, target.id);
      await writeFileEnsured(deps, path, renderSystemdUnit(target));
      const runner = requireRunner(deps);
      await runner('systemctl', ['--user', 'daemon-reload']);
      const result = await runner('systemctl', ['--user', 'enable', `${target.id}.service`]);
      return {
        method,
        installed: true,
        enabled: result.code === 0,
        path,
        detail: result.code === 0 ? undefined : result.stderr.trim() || 'systemctl enable 실패',
      };
    }
    case 'xdg-autostart': {
      const path = desktopEntryPath(deps, target.id);
      await writeFileEnsured(deps, path, renderDesktopEntry(target));
      return { method, installed: true, enabled: true, path };
    }
    case 'launchagent': {
      const path = launchAgentPath(deps, target.id);
      await writeFileEnsured(deps, path, renderLaunchAgentPlist(target));
      const runner = requireRunner(deps);
      // bootstrap이 없으면 load -w로 대체(구버전 macOS 호환).
      const result = await runner('launchctl', ['load', '-w', path]);
      return {
        method,
        installed: true,
        enabled: result.code === 0,
        path,
        detail: result.code === 0 ? undefined : result.stderr.trim() || 'launchctl load 실패',
      };
    }
    case 'schtasks': {
      const runner = requireRunner(deps);
      const result = await runner('schtasks', buildSchtasksCreateArgs(target));
      return {
        method,
        installed: result.code === 0,
        enabled: result.code === 0,
        path: target.id,
        detail: result.code === 0 ? undefined : result.stderr.trim() || 'schtasks /Create 실패',
      };
    }
  }
}

export async function getAutostartStatus(
  method: AutostartMethod,
  target: AutostartTarget,
  deps: AutostartDeps,
): Promise<AutostartStatus> {
  switch (method) {
    case 'systemd-user': {
      const path = systemdUnitPath(deps, target.id);
      const installed = await exists(deps.fs, path);
      if (!installed) return { method, installed: false, enabled: false, path };
      const runner = requireRunner(deps);
      const result = await runner('systemctl', ['--user', 'is-enabled', `${target.id}.service`]);
      const enabled = result.code === 0 && result.stdout.trim() === 'enabled';
      return { method, installed, enabled, path, detail: result.stdout.trim() || undefined };
    }
    case 'xdg-autostart': {
      const path = desktopEntryPath(deps, target.id);
      const installed = await exists(deps.fs, path);
      if (!installed) return { method, installed: false, enabled: false, path };
      const content = await deps.fs.readFile(path, 'utf8');
      const hidden = /(^|\n)Hidden\s*=\s*true/i.test(content);
      const disabled = /(^|\n)X-GNOME-Autostart-enabled\s*=\s*false/i.test(content);
      return { method, installed, enabled: !hidden && !disabled, path };
    }
    case 'launchagent': {
      const path = launchAgentPath(deps, target.id);
      const installed = await exists(deps.fs, path);
      if (!installed) return { method, installed: false, enabled: false, path };
      const content = await deps.fs.readFile(path, 'utf8');
      // RunAtLoad가 true면 로그인 시 실행된다.
      const enabled = /<key>RunAtLoad<\/key>\s*<true\/>/.test(content);
      return { method, installed, enabled, path };
    }
    case 'schtasks': {
      const runner = requireRunner(deps);
      const result = await runner('schtasks', buildSchtasksQueryArgs(target.id));
      const installed = result.code === 0;
      if (!installed) return { method, installed: false, enabled: false, path: target.id, detail: '작업 없음' };
      // 종료 코드 0은 비활성(Disabled) 작업도 반환한다. 상태를 파싱해 거짓 "켜짐"을 방지한다.
      const state = parseSchtasksState(result.stdout);
      const enabled = state ? state !== 'disabled' : true;
      return { method, installed, enabled, path: target.id, detail: state ? `상태: ${state}` : undefined };
    }
  }
}

export async function removeAutostart(
  method: AutostartMethod,
  target: AutostartTarget,
  deps: AutostartDeps,
): Promise<AutostartStatus> {
  switch (method) {
    case 'systemd-user': {
      const path = systemdUnitPath(deps, target.id);
      const runner = requireRunner(deps);
      await runner('systemctl', ['--user', 'disable', `${target.id}.service`]);
      await deps.fs.rm(path, { force: true });
      await runner('systemctl', ['--user', 'daemon-reload']);
      return { method, installed: false, enabled: false, path };
    }
    case 'xdg-autostart': {
      const path = desktopEntryPath(deps, target.id);
      await deps.fs.rm(path, { force: true });
      return { method, installed: false, enabled: false, path };
    }
    case 'launchagent': {
      const path = launchAgentPath(deps, target.id);
      const runner = requireRunner(deps);
      await runner('launchctl', ['unload', '-w', path]);
      await deps.fs.rm(path, { force: true });
      return { method, installed: false, enabled: false, path };
    }
    case 'schtasks': {
      const runner = requireRunner(deps);
      const result = await runner('schtasks', buildSchtasksDeleteArgs(target.id));
      return { method, installed: false, enabled: false, path: target.id, detail: result.code === 0 ? undefined : result.stderr.trim() };
    }
  }
}
