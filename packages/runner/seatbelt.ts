import { spawn, execFile } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { IsolationProbe } from './sandbox.js';

/*
 * macOS build isolation through a generated Seatbelt profile run by
 * /usr/bin/sandbox-exec, instead of @anthropic-ai/sandbox-runtime (SRT).
 * SRT 0.0.77 cannot express what a build needs:
 * - Its public SandboxManager routes every network-restricted command through
 *   a localhost HTTP/SOCKS proxy it starts (needsNetworkProxy follows any
 *   network config, even an empty allowlist) and allows loopback to it; builds
 *   need no network at all, not an empty-allowlist proxy.
 * - Its profile always allows mach-lookup of com.apple.securityd.xpc and
 *   com.apple.SecurityServer (keychain access). The AI CLI runner has to patch
 *   the generated string to remove them.
 * - It forces TMPDIR=/tmp/claude and wraps the command in a `bash -c` string,
 *   while the build runner's contract is an argv without a shell and a
 *   per-run TMPDIR.
 * - The profile generator itself is not a public export.
 * The base allowances below (process, mach services, IOKit, devices) follow
 * SRT's macOS profile minus the keychain services; file and network rules
 * are specific to builds.
 */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SEATBELT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';

export interface SeatbeltPolicy {
  /** Real path of the user home; every dotfile tree under it stays denied. */
  home: string;
  /** Broad read-denied regions (home, other users, temp roots, app data). */
  readDeny: string[];
  /** Read carve-outs: snapshot, output, validated tool roots, executable bundle. */
  readAllow: string[];
  /** Credential stores denied again after the carve-outs. */
  credentialDeny: string[];
  writeAllow: string[];
  /** Real path of the build executable; readable even under a denied dotfile tree. */
  executable: string;
}

const MACH_SERVICES = [
  'com.apple.audio.systemsoundserver',
  'com.apple.distributed_notifications@Uv3',
  'com.apple.FontObjectsServer',
  'com.apple.fonts',
  'com.apple.logd',
  'com.apple.lsd.mapdb',
  'com.apple.PowerManagement.control',
  'com.apple.system.logger',
  'com.apple.system.notification_center',
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.bsd.dirhelper',
  'com.apple.coreservices.launchservicesd',
];

const WRITABLE_DEVICES = ['/dev/null', '/dev/zero', '/dev/tty', '/dev/stdout', '/dev/stderr', '/dev/dtracehelper'];

function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

async function realOrResolved(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return resolve(target);
  }
}

/** SBPL string literal. Unusual characters fail closed instead of being escaped. */
function str(path: string): string {
  if (!path.startsWith('/') || /["\\\n\r\0]/.test(path)) {
    throw new Error(`Seatbelt 프로필에 넣을 수 없는 경로입니다: ${JSON.stringify(path)}`);
  }
  return `"${path}"`;
}

function regexLiteral(path: string): string {
  str(path);
  return path.replace(/[.*+?^${}()|[\]]/g, '\\$&');
}

function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    result.push(dir);
    if (dir === '/') return result;
  }
}

function rule(action: 'allow' | 'deny', operation: string, filters: string[]): string[] {
  return filters.length === 0 ? [] : [`(${action} ${operation}`, ...filters.map((f) => `  ${f}`), ')'];
}

/** Host regions a build must never read, as real paths. */
export async function hostReadRoots(): Promise<Pick<SeatbeltPolicy, 'home' | 'readDeny' | 'credentialDeny'>> {
  const home = await realOrResolved(homedir());
  const readDeny = ['/Users', home, '/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders', '/Library/Keychains',
    await realOrResolved(tmpdir())];
  if (process.env.APPOPS_DATA_DIR) readDeny.push(await realOrResolved(process.env.APPOPS_DATA_DIR));
  const credentialDeny = ['Library/Keychains', 'Library/Cookies', 'Library/Containers', 'Library/Group Containers']
    .map((rel) => join(home, rel))
    .concat('/Library/Keychains');
  return { home, readDeny: [...new Set(readDeny)], credentialDeny };
}

/**
 * Carve-outs may only narrow a denied region: a path that equals or contains a
 * denied root (e.g. `/Users`, the home itself, or a parent of the app data
 * directory) is dropped so it cannot re-open that region.
 */
export function narrowAllows(allows: string[], readDeny: string[]): string[] {
  return [...new Set(allows)].filter((allow) => !readDeny.some((deny) => isInside(allow, deny)));
}

export function seatbeltProfile(policy: SeatbeltPolicy): string {
  const readAllow = narrowAllows(policy.readAllow, policy.readDeny);
  const writeAllow = narrowAllows(policy.writeAllow, policy.readDeny);
  const metadata = [...new Set(readAllow.flatMap(ancestors))].filter((dir) => !readAllow.some((a) => isInside(a, dir)));
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow process-info* (target same-sandbox))',
    '(allow signal (target same-sandbox))',
    '(allow mach-priv-task-port (target same-sandbox))',
    '(allow user-preference-read)',
    // Keychain daemons (securityd, SecurityServer) are intentionally absent.
    ...rule('allow', 'mach-lookup', MACH_SERVICES.map((name) => `(global-name "${name}")`)),
    '(allow ipc-posix-shm)',
    '(allow ipc-posix-sem)',
    '(allow iokit-open (iokit-registry-entry-class "IOSurfaceRootUserClient") (iokit-registry-entry-class "RootDomainUserClient") (iokit-user-client-class "IOSurfaceSendRight"))',
    '(allow iokit-get-properties)',
    '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
    '(allow sysctl-read)',
    ...rule('allow', 'file-ioctl', ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/dtracehelper', '/dev/tty'].map((p) => `(literal ${str(p)})`)),
    // No network rule: `deny default` covers TCP/UDP and unix-socket connect/bind.
    // Seatbelt is last-match-wins: allow all reads, deny broad regions,
    // re-open carve-outs, then deny credential stores again.
    '(allow file-read*)',
    ...rule('deny', 'file-read*', policy.readDeny.map((p) => `(subpath ${str(p)})`)),
    ...rule('allow', 'file-read*', readAllow.map((p) => `(subpath ${str(p)})`)),
    // realpath()/getcwd() stat each ancestor of a carve-out; no listing or contents.
    ...rule('allow', 'file-read-metadata', metadata.map((p) => `(literal ${str(p)})`)),
    ...rule('deny', 'file-read*', [
      `(regex #"^${regexLiteral(policy.home)}/\\.")`,
      ...policy.credentialDeny.map((p) => `(subpath ${str(p)})`),
    ]),
    `(allow file-read* (literal ${str(policy.executable)}))`,
    ...rule('allow', 'file-write*', [
      ...writeAllow.map((p) => `(subpath ${str(p)})`),
      ...WRITABLE_DEVICES.map((p) => `(literal ${str(p)})`),
      '(subpath "/dev/fd")',
    ]),
  ].join('\n');
}

function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(SANDBOX_EXEC, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.on('error', () => { clearTimeout(timer); resolveRun({ code: null, out }); });
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, out }); });
  });
}

function macosVersion(): Promise<string | null> {
  return new Promise((resolveVersion) => {
    execFile('/usr/bin/sw_vers', ['-productVersion'], (error, stdout) => {
      resolveVersion(error ? null : stdout.trim() || null);
    });
  });
}

/** Runs the real backend: `/usr/bin/true` must succeed and a home secret must stay unreadable. */
export async function probeSeatbelt(): Promise<IsolationProbe> {
  const unavailable = (reason: string, executable: string | null = SANDBOX_EXEC): IsolationProbe =>
    ({ available: false, backend: 'none', executable, version: null, reason });
  try {
    await access(SANDBOX_EXEC);
  } catch {
    return unavailable(`${SANDBOX_EXEC} 를 찾지 못했습니다. 격리 없이 빌드를 실행하지 않습니다.`, null);
  }
  let work: string | null = null;
  let secretDir: string | null = null;
  try {
    work = await realpath(await mkdtemp(join(tmpdir(), 'appops-seatbelt-probe-')));
    const roots = await hostReadRoots();
    secretDir = await mkdtemp(join(roots.home, '.appops-isolation-probe-'));
    const secret = join(secretDir, 'secret.txt');
    const marker = `APPOPS_PROBE_${process.pid}_${Date.now()}`;
    await writeFile(secret, marker, { mode: 0o600 });
    const profile = seatbeltProfile({ ...roots, readAllow: [work], writeAllow: [work], executable: '/bin/cat' });
    const ok = await run(['-p', profile, '/usr/bin/true']);
    if (ok.code !== 0) return unavailable(`Seatbelt 샌드박스 초기화에 실패했습니다: ${ok.out.trim() || `exit ${ok.code}`}`);
    const leak = await run(['-p', profile, '/bin/cat', secret]);
    if (leak.code === 0 || leak.out.includes(marker)) {
      return unavailable('Seatbelt가 홈 디렉터리 비밀 파일 읽기를 차단하지 못했습니다. 격리 없이 빌드를 실행하지 않습니다.');
    }
    const version = await macosVersion();
    return { available: true, backend: 'seatbelt', executable: SANDBOX_EXEC, version: `sandbox-exec (Seatbelt), macOS ${version ?? 'unknown'}` };
  } catch (error) {
    return unavailable(`Seatbelt 격리 검증 중 오류: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
    if (secretDir) await rm(secretDir, { recursive: true, force: true });
  }
}
