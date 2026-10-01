import { access, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { BuildPlan, CommandSpec } from '../domain/index.js';
import { managedToolPath } from '../engines/toolchains.js';
import { SANDBOX_EXEC, SEATBELT_PATH, hostReadRoots, probeSeatbelt, seatbeltProfile } from './seatbelt.js';

export interface IsolationProbe {
  available: boolean;
  backend: 'bwrap' | 'seatbelt' | 'none';
  executable: string | null;
  version: string | null;
  reason?: string;
}

export interface IsolationOptions {
  launcher?: { executable: string; prefixArgs: string[] };
  forceUnavailable?: boolean;
}

const BWRAP = '/usr/bin/bwrap';
const FORBIDDEN_ENV = /^(dbus_|xdg_runtime_dir|ssh_|gnome_keyring|kwallet|appops_|gpg_|gnupghome|aws_|google_application_credentials)/i;
const SECRET_ENV = /token|secret|password|passwd|keyring|credential|authorization/i;
const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh']);

let cachedProbe: IsolationProbe | null = null;
let cachedProbeAt = 0;
// A failed probe is retried after this window (e.g. after the host is fixed);
// a successful one is kept for the process lifetime.
const FAILED_PROBE_TTL_MS = 30_000;

function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

async function existingRealpath(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

function forbiddenBases(): string[] {
  const bases = ['/home', '/root', '/etc', '/run', '/var/run', '/var/lib', '/boot'];
  try {
    bases.push(homedir());
  } catch { /* ignore */ }
  const data = process.env.APPOPS_DATA_DIR;
  if (data) bases.push(resolve(data));
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) bases.push(resolve(runtime));
  return bases;
}

function isDangerousBind(real: string): boolean {
  const bases = forbiddenBases().map((b) => b.replace(/\/+$/, ''));
  for (const base of bases) {
    if (real === base || real === '/') return true;
  }
  if (real.startsWith('/run/user/')) return true;
  if (real.includes(`${sep}bus`) && real.includes('dbus')) return true;
  // Never mount user-home dotfile trees (~/.gradle, ~/.ssh, ~/.config, …):
  // they carry credentials and per-user tool state that must not reach builds.
  try {
    const h = homedir();
    if (h) {
      const prefix = h.endsWith(sep) ? h : h + sep;
      if (real.startsWith(prefix)) {
        const first = real.slice(prefix.length).split(sep)[0] ?? '';
        if (first.startsWith('.')) return true;
      }
    }
  } catch { /* no home */ }
  return false;
}

export async function probeIsolation(): Promise<IsolationProbe> {
  if (cachedProbe && (cachedProbe.available || Date.now() - cachedProbeAt < FAILED_PROBE_TTL_MS)) return cachedProbe;
  cachedProbe = await detectIsolation();
  cachedProbeAt = Date.now();
  return cachedProbe;
}

async function detectIsolation(): Promise<IsolationProbe> {
  if (process.platform === 'darwin') {
    return probeSeatbelt();
  }
  if (process.platform !== 'linux') {
    return {
      available: false,
      backend: 'none',
      executable: null,
      version: null,
      reason: `${process.platform}에는 검증된 빌드 격리 러너가 없습니다. Linux bubblewrap(bwrap) 또는 macOS Seatbelt가 필요합니다.`,
    };
  }
  try {
    await access(BWRAP);
  } catch {
    return {
      available: false,
      backend: 'none',
      executable: null,
      version: null,
      reason: `${BWRAP} 를 찾지 못했습니다. 격리 없이 빌드를 실행하지 않습니다.`,
    };
  }
  const ok = await new Promise<boolean>((resolveProbe) => {
    const child = spawn(BWRAP, [
      '--unshare-user-try',
      '--unshare-pid',
      '--unshare-net',
      '--unshare-ipc',
      '--ro-bind', '/usr', '/usr',
      '--symlink', 'usr/bin', '/bin',
      '--symlink', 'usr/lib', '/lib',
      '--symlink', 'usr/lib64', '/lib64',
      '--dev', '/dev',
      '--proc', '/proc',
      '--die-with-parent',
      '--tmpfs', '/tmp',
      '--clearenv',
      '--setenv', 'PATH', '/usr/bin:/bin',
      '--',
      '/bin/true',
    ], { shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveProbe(false);
    }, 4000);
    child.on('error', () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveProbe(code === 0);
    });
  });
  if (!ok) {
    return {
      available: false,
      backend: 'none',
      executable: BWRAP,
      version: null,
      reason: 'bwrap 네임스페이스 초기화에 실패했습니다. 격리 없이 빌드를 실행하지 않습니다.',
    };
  }
  const version = await new Promise<string | null>((resolveVersion) => {
    const child = spawn(BWRAP, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.on('error', () => resolveVersion(null));
    child.on('close', () => resolveVersion(out.trim().split('\n')[0] ?? null));
  });
  return { available: true, backend: 'bwrap', executable: BWRAP, version };
}

export function resetIsolationProbe(): void {
  cachedProbe = null;
  cachedProbeAt = 0;
}

function rejectShell(command: CommandSpec): string | null {
  const name = basename(command.executable).toLowerCase();
  if (SHELL_NAMES.has(name) && command.args.some((a) => a === '-c' || a === '/c' || a === '-Command')) {
    return '셸 문자열 실행은 허용되지 않습니다.';
  }
  return null;
}

export async function assertCommandSafe(command: CommandSpec, plan: BuildPlan): Promise<string | null> {
  const shell = rejectShell(command);
  if (shell) return shell;
  if (!command.executable) return '실행 파일이 비어 있습니다.';
  const execResolved = isAbsolute(command.executable)
    ? command.executable
    : resolve(command.cwd, command.executable);
  const execReal = await existingRealpath(execResolved);
  if (!execReal) return `실행 파일을 찾을 수 없습니다: ${command.executable}`;
  try {
    const st = await stat(execReal);
    if (!st.isFile()) return `실행 파일이 일반 파일이 아닙니다: ${execReal}`;
  } catch {
    return `실행 파일을 열 수 없습니다: ${execReal}`;
  }
  const cwdReal = await existingRealpath(command.cwd);
  if (!cwdReal) return `작업 디렉터리를 찾을 수 없습니다: ${command.cwd}`;
  const sourceReal = await existingRealpath(plan.sourcePath) ?? resolve(plan.sourcePath);
  if (!isInside(sourceReal, cwdReal)) {
    return '빌드 cwd는 스냅샷 경로 안에 있어야 합니다.';
  }
  if (isDangerousBind(cwdReal) && cwdReal === (await existingRealpath(homedir()).catch(() => '')) ) {
    return '사용자 홈 디렉터리에서 빌드할 수 없습니다.';
  }
  for (const [key, value] of Object.entries(command.env ?? {})) {
    if (FORBIDDEN_ENV.test(key) || SECRET_ENV.test(key)) {
      return `환경 변수 ${key} 는 샌드박스에 전달할 수 없습니다.`;
    }
    if (value.includes('\0')) return `환경 변수 ${key} 에 잘못된 문자가 있습니다.`;
  }
  return null;
}

async function collectBinds(command: CommandSpec, plan: BuildPlan): Promise<{ rw: string[]; ro: string[] }> {
  const rw = new Set<string>();
  const ro = new Set<string>();
  const sourceReal = await existingRealpath(plan.sourcePath);
  if (sourceReal) rw.add(sourceReal);
  const outReal = await existingRealpath(plan.outputPath);
  if (outReal && (!sourceReal || !isInside(sourceReal, outReal))) rw.add(outReal);
  else if (!outReal) {
    const parent = dirname(resolve(plan.outputPath));
    const parentReal = await existingRealpath(parent);
    if (parentReal && (!sourceReal || !isInside(sourceReal, parentReal))) rw.add(parentReal);
  }
  const execReal = await existingRealpath(
    isAbsolute(command.executable) ? command.executable : resolve(command.cwd, command.executable),
  );
  const homeReal = await existingRealpath(homedir());
  // Under the user home only managed tool roots are trusted as directories;
  // anything else (e.g. ~/Downloads/godot) exposes just the file itself.
  const unmanagedHomePath = async (real: string) =>
    Boolean(homeReal && isInside(homeReal, real) && !await managedToolPath(real, plan.managedToolRoot));
  if (execReal) {
    const dir = dirname(execReal);
    const covered = [...rw, ...ro].some((p) => isInside(p, execReal));
    if (!covered && !isDangerousBind(dir) && !await unmanagedHomePath(execReal)) ro.add(dir);
    else if (!covered) ro.add(execReal);
  }
  // Validated tool roots are mounted read-only. These keys are set only by the
  // plan builder after host-side validation (JDK, SDK, engine, caches); their
  // values are absolute paths outside the user home.
  const READONLY_TOOL_KEYS = new Set([
    'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT',
    'GRADLE_TOOLS_ROOT', 'GRADLE_RO_DEP_CACHE',
    'UE_ENGINE_ROOT', 'GODOT_TEMPLATES_SOURCE',
  ]);
  // Per-run writable caches created under the output directory.
  const WRITABLE_CACHE_KEYS = new Set(['GRADLE_USER_HOME', 'XDG_DATA_HOME']);
  for (const [key, value] of Object.entries(command.env ?? {})) {
    if (!isAbsolute(value)) continue;
    const real = await existingRealpath(value);
    if (!real) continue;
    const writable = WRITABLE_CACHE_KEYS.has(key);
    const readonlyTool = READONLY_TOOL_KEYS.has(key);
    if (!writable && !readonlyTool && !key.endsWith('HOME') && !key.includes('SDK') && !key.includes('ROOT')) continue;
    const covered = [...rw, ...ro].some((p) => isInside(p, real));
    if (covered) continue;
    // The plan builder already requires tool roots outside the home; the
    // runner enforces the same so a plan env cannot re-open home data.
    if (await unmanagedHomePath(real)) continue;
    const managed = readonlyTool && await managedToolPath(real, plan.managedToolRoot);
    if (!managed && (isDangerousBind(real) || isDangerousBind(dirname(real)))) continue;
    try {
      const st = await lstat(real);
      const dir = st.isDirectory() ? real : (isDangerousBind(dirname(real)) ? real : dirname(real));
      if (writable) rw.add(dir);
      else ro.add(dir);
    } catch { /* skip */ }
  }
  return { rw: [...rw], ro: [...ro] };
}

/** Plan env that may enter a sandbox: no credential names, and paths only inside allowed mounts. */
async function allowedEnvEntries(env: Record<string, string>, allowedMounts: string[]): Promise<[string, string][]> {
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(env)) {
    if (FORBIDDEN_ENV.test(key) || SECRET_ENV.test(key)) continue;
    if (isAbsolute(value)) {
      const real = await existingRealpath(value);
      if (real && !allowedMounts.some((m) => isInside(m, real))) continue;
    }
    entries.push([key, value]);
  }
  return entries;
}

export async function wrapIsolatedCommand(command: CommandSpec, plan: BuildPlan): Promise<CommandSpec> {
  const binds = await collectBinds(command, plan);
  const args: string[] = [
    '--unshare-user-try',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--dir', '/tmp/appops-home',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--ro-bind-try', '/etc/ld.so.conf.d', '/etc/ld.so.conf.d',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin:/usr/local/bin',
    '--setenv', 'HOME', '/tmp/appops-home',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', process.env.LANG || 'C.UTF-8',
  ];
  for (const dir of binds.rw) {
    args.push('--bind', dir, dir);
  }
  for (const dir of binds.ro) {
    args.push('--ro-bind', dir, dir);
  }
  const cwdReal = await existingRealpath(command.cwd);
  if (cwdReal) args.push('--chdir', cwdReal);
  for (const [key, value] of await allowedEnvEntries(command.env ?? {}, [...binds.rw, ...binds.ro])) {
    args.push('--setenv', key, value);
  }
  const execReal = await existingRealpath(
    isAbsolute(command.executable) ? command.executable : resolve(command.cwd, command.executable),
  );
  args.push('--', execReal ?? command.executable, ...command.args);
  return {
    executable: BWRAP,
    args,
    cwd: command.cwd,
    label: `bwrap:${command.label}`,
  };
}

/** The `.app` bundle containing an executable, so its Resources/Frameworks stay readable. */
function appBundleOf(executable: string): string | null {
  const marker = `.app${sep}Contents${sep}`;
  const index = executable.lastIndexOf(marker);
  return index < 0 ? null : executable.slice(0, index + '.app'.length);
}

/**
 * macOS: runs the command under a generated Seatbelt profile. Reads of the
 * host home, other users, temp roots and app data are denied except the
 * snapshot/output/validated tool roots; writes are limited to the snapshot,
 * output and a per-run HOME/TMPDIR under the output task cache; no network.
 */
export async function wrapSeatbeltCommand(command: CommandSpec, plan: BuildPlan): Promise<CommandSpec> {
  const binds = await collectBinds(command, plan);
  const execReal = await existingRealpath(
    isAbsolute(command.executable) ? command.executable : resolve(command.cwd, command.executable),
  ) ?? command.executable;
  // Same task-cache directory the executor clears before each attempt and
  // excludes from artifact checks.
  const runRoot = join(await existingRealpath(plan.outputPath) ?? resolve(plan.outputPath), '.appops-task-cache', 'sandbox');
  const home = join(runRoot, 'home');
  const tmp = join(runRoot, 'tmp');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const bundle = appBundleOf(execReal);
  const profile = seatbeltProfile({
    ...await hostReadRoots(),
    readAllow: [...binds.rw, ...binds.ro, runRoot, ...(bundle && !isDangerousBind(bundle) ? [bundle] : [])],
    writeAllow: [...binds.rw, runRoot],
    executable: execReal,
  });
  const env: Record<string, string> = { PATH: SEATBELT_PATH, LANG: process.env.LANG || 'C.UTF-8' };
  for (const [key, value] of await allowedEnvEntries(command.env ?? {}, [...binds.rw, ...binds.ro])) env[key] = value;
  env.HOME = home;
  env.TMPDIR = tmp + sep;
  return {
    executable: SANDBOX_EXEC,
    args: ['-p', profile, execReal, ...command.args],
    cwd: await existingRealpath(command.cwd) ?? command.cwd,
    env,
    label: `seatbelt:${command.label}`,
  };
}

export async function applyIsolation(
  command: CommandSpec,
  plan: BuildPlan,
  isolation: IsolationOptions | undefined,
): Promise<{ command: CommandSpec } | { error: string }> {
  const unsafe = await assertCommandSafe(command, plan);
  if (unsafe) return { error: unsafe };
  if (isolation?.launcher) {
    const launcher = isolation.launcher;
    const execReal = await existingRealpath(
      isAbsolute(command.executable) ? command.executable : resolve(command.cwd, command.executable),
    );
    return {
      command: {
        executable: launcher.executable,
        args: [...launcher.prefixArgs, execReal ?? command.executable, ...command.args],
        cwd: command.cwd,
        env: command.env,
        label: `injected:${command.label}`,
      },
    };
  }
  if (isolation?.forceUnavailable) {
    return { error: '격리 백엔드를 사용할 수 없습니다. 격리 없이 빌드를 실행하지 않습니다.' };
  }
  const probe = await probeIsolation();
  if (!probe.available) {
    return { error: probe.reason ?? '격리 백엔드를 사용할 수 없습니다.' };
  }
  if (probe.backend === 'seatbelt') {
    try {
      return { command: await wrapSeatbeltCommand(command, plan) };
    } catch (error) {
      return { error: `Seatbelt 격리 구성에 실패했습니다: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { command: await wrapIsolatedCommand(command, plan) };
}
