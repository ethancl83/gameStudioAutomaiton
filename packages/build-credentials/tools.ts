import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import { AppError } from '../domain/errors.js';
import { probeIsolation } from '../../apps/runner/sandbox.js';

export async function secretWorkspace<T>(namespace: string, callback: (directory: string) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux' || (await statfs('/dev/shm')).type !== 0x01021994) {
    throw new AppError('KEY_RUNTIME_UNAVAILABLE', '키를 사용하는 작업에는 메모리 임시 저장소를 갖춘 Linux 러너가 필요합니다.');
  }
  const prefix = 'appops-key-' + createHash('sha256').update(namespace).digest('hex').slice(0, 12) + '-';
  const directory = await mkdtemp(join('/dev/shm', prefix)); await chmod(directory, 0o700);
  try { return await callback(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
export async function privateFile(directory: string, name: string, value: string | Uint8Array): Promise<string> {
  const path = join(directory, name); await writeFile(path, value, { mode: 0o600, flag: 'wx' }); return path;
}
export async function javaTool(name: 'keytool' | 'jarsigner'): Promise<{ executable: string; javaHome: string }> {
  const candidates = [process.env.APPOPS_JAVA_HOME, process.env.JAVA_HOME].filter(Boolean).map(home => join(home!, 'bin', name));
  candidates.push('/usr/bin/' + name);
  for (const candidate of candidates) {
    try { const executable = await realpath(candidate); await access(executable); return { executable, javaHome: dirname(dirname(executable)) }; } catch {}
  }
  throw new AppError('SIGNING_TOOL_REQUIRED', `Android 서명 키 검증에 JDK ${name}가 필요합니다.`);
}

/** Only controller-owned tool invocations use this API; engine/project scripts never receive these mounts. */
export async function runTrustedTool(executable: string, args: string[], options: {
  cwd: string; readRoots?: string[]; writeRoots?: string[]; environment?: Record<string, string>;
  signal?: AbortSignal; network?: boolean; timeoutMs?: number;
  scripts?: Record<string, string>;
}): Promise<{ stdout: string; stderr: string }> {
  const probe = await probeIsolation();
  if (!probe.available || !probe.executable) throw new AppError('ISOLATION_UNAVAILABLE', '키 작업을 격리할 수 없어 실행하지 않았습니다.');
  const tool = await realpath(executable);
  const roots = new Set<string>();
  for (const root of options.readRoots ?? []) roots.add(await realpath(root));
  roots.add(dirname(tool));
  // Distribution JDK conf files may point outside JAVA_HOME. Bind only its resolved public config files.
  const javaHome = options.environment?.JAVA_HOME;
  if (javaHome) {
    roots.add(await realpath(javaHome));
    for (const file of ['security/java.security', 'security/java.policy', 'security/default.policy', 'security/cacerts', 'security/blocked.certs',
      'security/policy/limited/default_US_export.policy', 'security/policy/limited/default_local.policy',
      'security/policy/unlimited/default_US_export.policy', 'security/policy/unlimited/default_local.policy', 'net.properties']) {
      try { roots.add(await realpath(join(javaHome, 'conf', file))); } catch {}
    }
  }
  const flags = ['--unshare-user-try', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/appops-home', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache', '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--ro-bind-try', '/etc/passwd', '/etc/passwd', '--ro-bind-try', '/etc/group', '/etc/group',
    '--clearenv', '--setenv', 'HOME', '/tmp/appops-home', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8'];
  if (!options.network) flags.push('--unshare-net');
  else {
    flags.push('--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf', '--ro-bind-try', '/etc/hosts', '/etc/hosts', '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf');
  }
  for (const root of roots) {
    if (['/', '/home', '/root', '/etc', '/run', '/dev/shm'].includes(root)) throw new AppError('INVALID_TOOL_ROOT', '도구에 너무 넓은 파일 범위를 전달할 수 없습니다.');
    flags.push('--ro-bind', root, root);
  }
  for (const root of options.writeRoots ?? [options.cwd]) {
    const path = await realpath(root);
    if (path === '/' || path === '/home' || path === '/dev/shm') throw new AppError('INVALID_TOOL_ROOT', '키 작업 경로가 올바르지 않습니다.');
    flags.push('--bind', path, path);
  }
  const scripts = { ...options.scripts, ...(options.environment?.SSH_ASKPASS ? { '/tmp/appops-askpass': '#!/bin/sh\nexec /usr/bin/cat "$APPOPS_PASSPHRASE_FILE"\n' } : {}) };
  for (const [index, path] of Object.keys(scripts).entries()) {
    if (!/^\/tmp\/appops-[a-z-]+$/.test(path)) throw new AppError('INVALID_TOOL_SCRIPT', '도구 보조 파일 경로가 올바르지 않습니다.');
    flags.push('--perms', '0700', '--file', String(index + 3), path);
  }
  for (const [key, value] of Object.entries(options.environment ?? {})) flags.push('--setenv', key, value);
  flags.push('--chdir', await realpath(options.cwd), '--', tool, ...args);
  options.signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const child = spawn(probe.executable!, flags, { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...Object.keys(scripts).map(() => 'pipe' as const)], env: {} });
    for (const [index, script] of Object.values(scripts).entries()) {
      const stream = child.stdio[index + 3] as Writable; stream.on('error', () => {}); stream.end(script);
    }
    let stdout = ''; let stderr = ''; let stopped = false;
    const terminate = () => { stopped = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
    const timeout = setTimeout(terminate, options.timeoutMs ?? 120_000); timeout.unref();
    const onAbort = () => terminate(); options.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener('abort', onAbort); };
    child.stdout!.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) terminate(); });
    child.stderr!.on('data', chunk => { stderr += chunk; if (stderr.length > 2_000_000) terminate(); });
    child.on('error', () => { cleanup(); reject(new AppError('KEY_TOOL_FAILED', '키 처리 도구를 시작할 수 없습니다.')); });
    child.on('close', code => {
      cleanup();
      if (options.signal?.aborted) reject(new AppError('CANCELLED', '키 사용 작업을 취소했습니다.'));
      else if (stopped) reject(new AppError('KEY_TOOL_TIMEOUT', '키 처리 도구의 시간 또는 출력 한도를 넘었습니다.'));
      else if (code !== 0) reject(new AppError('KEY_TOOL_FAILED', `${basename(tool)} 키 처리에 실패했습니다. 키·암호·별칭·도구 설정을 확인해 주세요.`));
      else done({ stdout, stderr });
    });
  });
}

export async function sshEnvironment(directory: string, credentials: Record<string, string>): Promise<Record<string, string>> {
  const pass = await privateFile(directory, 'passphrase', credentials.passphrase ?? '');
  return { SSH_ASKPASS: '/tmp/appops-askpass', SSH_ASKPASS_REQUIRE: 'force', APPOPS_PASSPHRASE_FILE: pass, DISPLAY: ':0' };
}
