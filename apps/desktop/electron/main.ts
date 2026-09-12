// Electron main 프로세스.
// - 권한 있는 부분(파일 접근, bearer 토큰, 외부 링크, 컨트롤러 기동)을 화면과 분리한다.
// - renderer는 window.appOps만 통해 제어 서비스 API에 접근한다.
// - bearer 토큰은 이 프로세스에서만 controller.json에서 읽고 화면에 노출하지 않는다.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { WebFrameMain } from 'electron';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MAX_PORTABLE_BACKUP_BYTES,
  isAllowedApiPath,
  isAllowedExternalUrl,
  isLoopbackDevUrl,
  isPortableBackupId,
  isTrustedFrameUrl,
  normalizePortableMode,
  normalizeStoredMode,
  openPinnedBackupSource,
  parseDownloadExpectation,
  portableBackupDownloadPath,
  portableBackupImportPath,
  redactSecrets,
  requestNamespaceMatches,
  streamDownloadToFile,
  type PortableBackupMode,
} from './security.js';
import { getControllerInfoPath, getDataDirectory } from '../../../packages/domain/paths.js';
import type { ApiResult } from '../../../packages/domain/index.js';
import {
  buildControllerAutostartTarget,
  clearIntentionalStop,
  defaultAutostartMethod,
  ensureController as ensureControllerLifecycle,
  getAutostartStatus,
  getControllerStatus,
  inspectLinuxSandbox,
  installAutostart,
  isIntentionalStop,
  markIntentionalStop,
  removeAutostart,
  restartController as restartControllerLifecycle,
  stopController as stopControllerLifecycle,
} from '../../../packages/lifecycle/index.js';
import type {
  AutostartDeps,
  AutostartStatus,
  AutostartTarget,
  CommandResult,
  ControllerDeps,
  ControllerInfo as LifecycleControllerInfo,
  Platform,
} from '../../../packages/lifecycle/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// 헤드리스 제어 서비스 모드: 로그인 자동 시작이 화면 없이 제어 서비스만 인프로세스로 실행한다.
// 이 모드에서는 창을 만들지 않고 제어 서비스가 살아 있는 동안 프로세스를 유지한다(자체 마운트도 유지).
const CONTROLLER_ONLY = process.env.APPOPS_CONTROLLER_ONLY === '1';

// 개발 모드에서 Vite dev 서버 URL. scripts/dev.mjs(코디네이터)가 주입한다.
// 보안 경계: loopback(127.0.0.1/localhost/::1) 개발 서버만 창에 로드한다.
// loopback이 아닌 주소가 주입되면 무시하고 컴파일된 파일 경로(file:)만 로드한다.
const RAW_DEV_SERVER_URL = process.env.APPOPS_DEV_SERVER_URL ?? null;
const DEV_SERVER_URL = RAW_DEV_SERVER_URL && isLoopbackDevUrl(RAW_DEV_SERVER_URL) ? RAW_DEV_SERVER_URL : null;
if (RAW_DEV_SERVER_URL && !DEV_SERVER_URL) {
  console.error('[appops] APPOPS_DEV_SERVER_URL이 loopback이 아니어서 무시합니다. 컴파일된 화면을 로드합니다.');
}
// 제어 서비스 실행 파일. dist/apps/desktop/electron/main.js 기준 상대 경로.
const CONTROLLER_ENTRY = join(HERE, '..', '..', 'controller', 'main.js');

// 패키지된 renderer 진입 파일. createWindow의 loadFile과 동일 경로를 써서, 신뢰 프레임 판정이
// 이 정확한 file: URL만 통과하도록 한다(임의의 file://이 아니라 정확 일치).
const RENDERER_INDEX = join(HERE, '..', 'renderer', 'index.html');
const PACKAGED_ENTRY_URL = pathToFileURL(RENDERER_INDEX).href;

interface ControllerInfo {
  port: number;
  token: string;
  pid?: number;
  startedAt?: string;
}

let cached: { info: ControllerInfo | null; readAt: number } | null = null;
let controllerChild: ReturnType<typeof spawn> | null = null;

// 실행 모드(demo/live) 권한은 main이 소유·영속한다(renderer localStorage 밖). 안전 기본값은 데모.
// - 모든 특권 변경(수명주기·자동 시작)·파일 브리지(백업 저장/가져오기)·일반 요청 라우팅이 이 값을
//   기준으로 네임스페이스를 결속한다. renderer 문자열은 이 권한을 바꿀 수 없다.
// - 실제(live) 전환은 setMode 핸들러의 main 소유 확인창을 통과해야만 반영된다.
let effectiveMode: PortableBackupMode = 'demo';
function desktopModePath(): string {
  return join(getDataDirectory(), 'desktop-mode.json');
}
async function loadEffectiveMode(): Promise<void> {
  try {
    const raw = await readFile(desktopModePath(), 'utf8');
    effectiveMode = normalizeStoredMode(JSON.parse(raw));
  } catch {
    effectiveMode = 'demo'; // 파일 없음/파싱 실패 = 안전 기본값(데모)
  }
}
async function persistEffectiveMode(mode: PortableBackupMode): Promise<void> {
  await mkdir(getDataDirectory(), { recursive: true }).catch(() => {});
  await writeFile(desktopModePath(), JSON.stringify({ mode }), { mode: 0o600 });
}

// 신뢰하는 창(BrowserWindow)의 webContents 신원. IPC는 이 창에서만 받는다(임의 webContents 차단).
let mainWindowId: number | null = null;

// controller.json은 제어 서비스가 생성하며 같은 사용자 프로세스만 읽는다({port,token,pid,startedAt}).
// 짧게 캐시하되 서비스 재시작으로 갱신될 수 있어 주기적으로 재확인한다.
async function readControllerInfo(force = false): Promise<ControllerInfo | null> {
  const now = Date.now();
  if (!force && cached && now - cached.readAt < 3000) return cached.info;
  try {
    // APPOPS_API_URL 이 지정되면(검증 격리) 그 주소를 우선한다. 토큰은 여전히 controller.json에서 읽는다.
    const raw = await readFile(getControllerInfoPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ControllerInfo>;
    if (typeof parsed.token === 'string' && parsed.token.length > 0 && typeof parsed.port === 'number') {
      const info: ControllerInfo = { port: parsed.port, token: parsed.token, pid: parsed.pid, startedAt: parsed.startedAt };
      cached = { info, readAt: now };
      return info;
    }
  } catch {
    /* 파일 없음/파싱 실패 = 컨트롤러 미준비 */
  }
  cached = { info: null, readAt: now };
  return null;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

// backend 주소는 loopback으로 고정한다. APPOPS_API_URL(검증 격리)은 loopback일 때만 허용해
// controller bearer가 외부 주소로 전달되지 않게 한다.
function apiBase(info: ControllerInfo): string {
  const override = process.env.APPOPS_API_URL;
  if (override) {
    try {
      const u = new URL(override);
      if (isLoopbackHost(u.hostname)) return override.replace(/\/$/, '');
    } catch {
      /* 무시 */
    }
    console.error('[appops] APPOPS_API_URL이 loopback이 아니어서 무시합니다. 127.0.0.1을 사용합니다.');
  }
  return `http://127.0.0.1:${info.port}/api`;
}

// 로그인/기동 시 제어 서비스를 어떤 실행 경로로 띄울지 결정한다.
// 안정 경로(설치된 앱 또는 AppImage 자신)를 사용해 앱 종료 후에도 실행 파일이 사라지지 않게 한다.
function resolveControllerLaunch(): { program: string; args: string[]; env: Record<string, string> } {
  const appImage = process.env.APPIMAGE;
  if (appImage) {
    // AppImage: 자기 자신을 헤드리스로 재실행하면 독립 마운트를 확보해 앱 종료와 무관하게 유지된다.
    return { program: appImage, args: [], env: { APPOPS_CONTROLLER_ONLY: '1' } };
  }
  if (app.isPackaged) {
    // 설치된 앱(deb/rpm/dmg/nsis): 안정된 실행 파일 경로를 헤드리스 제어 서비스로 실행.
    return { program: process.execPath, args: [], env: { APPOPS_CONTROLLER_ONLY: '1' } };
  }
  // 개발/미설치: Electron을 Node로 실행해 제어 서비스 진입점을 직접 구동한다.
  return { program: process.execPath, args: [CONTROLLER_ENTRY], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// PID 재사용 안전 신원 확인:
//  - 공개 /health의 startedAt이 controller.json의 startedAt과 일치(그 포트의 인스턴스가 우리가 기록한 그 인스턴스)
//  - 인증된 /state가 우리 bearer 토큰을 수락(그 인스턴스가 우리 제어 서비스임을 증명)
// 둘 다 통과할 때만 "살아 있고 우리 것"으로 판정한다. 명시적 중지는 이 판정에서만 PID에 신호를 보낸다.
async function verifyOwnController(info: ControllerInfo): Promise<boolean> {
  try {
    const base = apiBase(info);
    const healthRes = await fetch(`${base}/health`, { headers: { accept: 'application/json' } });
    if (!healthRes.ok) return false;
    const health = (await healthRes.json().catch(() => null)) as { data?: { startedAt?: string } } | null;
    if (info.startedAt && health?.data?.startedAt && health.data.startedAt !== info.startedAt) return false;
    const stateRes = await fetch(`${base}/state`, {
      headers: { authorization: `Bearer ${info.token}`, accept: 'application/json' },
    });
    return stateRes.ok;
  } catch {
    return false;
  }
}

function makeControllerDeps(): ControllerDeps {
  return {
    readInfo: (force) => readControllerInfo(force) as Promise<LifecycleControllerInfo | null>,
    checkHealth: (info) => verifyOwnController(info as ControllerInfo),
    spawnController: () => {
      if (DEV_SERVER_URL) return {}; // 개발: scripts/dev.mjs가 제어 서비스를 담당한다.
      const launch = resolveControllerLaunch();
      const child = spawn(launch.program, launch.args, {
        env: { ...process.env, ...launch.env },
        detached: true, // 앱(화면)이 종료돼도 인가된 자동화가 계속 실행되도록 분리한다.
        stdio: 'ignore',
      });
      child.unref();
      controllerChild = child;
      child.on('exit', () => { if (controllerChild === child) controllerChild = null; });
      return { pid: child.pid };
    },
    killPid: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
    // 내구성 있는 명시적 중지 표식(controller.stop). 강제 종료(SIGKILL) 후에도 서비스 매니저
    // 자동 재기동/로그인 자동 시작이 진입점에서 차단되게 한다. 명시적 시작은 표식을 지운다.
    markStopIntent: () =>
      markIntentionalStop(autostartFs, getDataDirectory(), { pid: cached?.info?.pid, reason: 'user_explicit_stop' }),
    clearStopIntent: () => clearIntentionalStop(autostartFs, getDataDirectory()),
  };
}

// 건강한 제어 서비스가 있으면 인수, 없으면 detached로 기동하고 준비될 때까지 폴링한다.
async function ensureController(): Promise<ControllerInfo | null> {
  const outcome = await ensureControllerLifecycle(makeControllerDeps());
  if (outcome.status === 'failed') {
    // 개발 모드의 start_timeout은 dev 스크립트가 아직 준비 중일 수 있어 조용히 넘어간다.
    if (!(outcome.error.code === 'start_timeout' && DEV_SERVER_URL)) {
      console.error('[appops] 제어 서비스 준비 실패', redactSecrets({ code: outcome.error.code, message: outcome.error.message }));
    }
    return outcome.info as ControllerInfo | null;
  }
  return outcome.info as ControllerInfo;
}

function errorResult(code: string, message: string): ApiResult<never> {
  return { ok: false, error: { code, message } };
}

// systemctl/launchctl/schtasks 등 외부 명령 실행기. stdout/stderr/code를 수집한다.
function nodeRunner(command: string, args: string[], options?: { input?: string }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr || String(err) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (options?.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

const autostartFs = {
  readFile: (p: string, enc: 'utf8') => readFile(p, enc),
  writeFile: (p: string, data: string, opts?: { mode?: number }) => writeFile(p, data, opts),
  mkdir: (p: string, opts: { recursive: true }) => mkdir(p, opts),
  rm: (p: string, opts?: { force?: boolean }) => rm(p, opts),
  access: (p: string) => access(p),
};

// 자동 시작 대상은 반드시 안정된 실행 경로여야 한다. AppImage 임시 마운트(/.mount_*)나 QA
// 언팩 디렉터리(linux-unpacked/win-unpacked), 개발용 electron 바이너리를 가리키면 로그인 시
// 실행 파일이 사라져 자동 시작이 깨진다.
//
// 경로 문자열 패턴은 OS별로 놓치는 부분이 있어(예: Windows %LOCALAPPDATA%\Temp, win-unpacked;
// 정상 설치 경로의 'release' 세그먼트 오탐) 실행 상태로 판정한다:
//  - AppImage: 통합된 .AppImage 파일(process.env.APPIMAGE)이 대상일 때만 안정.
//    (process.execPath는 임시 마운트라 대상으로 쓰지 않는다 — resolveControllerLaunch가 APPIMAGE를 쓴다.)
//  - 그 외: app.isPackaged(설치된 deb/rpm/dmg/nsis)일 때만 안정. 이는 OS 독립적이다.
// program은 resolveControllerLaunch가 정한 자동 시작 대상 실행 파일이다.
function isStableAutostartProgram(program: string): boolean {
  const appImage = process.env.APPIMAGE;
  if (appImage) return program === appImage;
  return app.isPackaged;
}

function autostartContext(): { method: ReturnType<typeof defaultAutostartMethod>; target: AutostartTarget; deps: AutostartDeps; transient: boolean } {
  const platform = process.platform as Platform;
  const method = defaultAutostartMethod(platform);
  const launch = resolveControllerLaunch();
  const target = buildControllerAutostartTarget({
    program: launch.program,
    controllerEntry: launch.args[0] ?? CONTROLLER_ENTRY,
    dataDir: process.env.APPOPS_DATA_DIR,
    runAsNode: 'ELECTRON_RUN_AS_NODE' in launch.env,
  });
  // 헤드리스 실행 대상은 resolveControllerLaunch의 env를 그대로 사용한다.
  target.args = launch.args;
  target.env = Object.keys(launch.env).length > 0 ? { ...launch.env } : undefined;
  if (process.env.APPOPS_DATA_DIR) target.env = { ...(target.env ?? {}), APPOPS_DATA_DIR: process.env.APPOPS_DATA_DIR };
  const deps: AutostartDeps = {
    fs: autostartFs,
    runner: nodeRunner,
    configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    launchAgentsDir: join(homedir(), 'Library', 'LaunchAgents'),
  };
  return { method, target, deps, transient: !isStableAutostartProgram(target.program) };
}

// Linux 샌드박스 기동 준비 상태 요약(다른 OS에서는 undefined).
async function sandboxStatusSummary(): Promise<{ ok: boolean; detail: string } | undefined> {
  if (process.platform !== 'linux') return undefined;
  const result = await inspectLinuxSandbox({
    statSandbox: async () => {
      try {
        const s = await stat(join(dirname(process.execPath), 'chrome-sandbox'));
        return { mode: s.mode, uid: s.uid };
      } catch {
        return null;
      }
    },
    readUsernsRestrict: async () => {
      try {
        const raw = await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8');
        const value = Number(raw.trim());
        return Number.isFinite(value) ? value : null;
      } catch {
        return null;
      }
    },
  });
  return { ok: result.ok, detail: result.recommendation ?? '샌드박스가 정상 구성되어 있습니다.' };
}

async function lifecycleStatusPayload(): Promise<unknown> {
  const controllerStatus = await getControllerStatus(makeControllerDeps());
  const { method, target, deps, transient } = autostartContext();
  let autostart: AutostartStatus | { method: string; installed: boolean; enabled: boolean; detail: string };
  try {
    autostart = await getAutostartStatus(method, target, deps);
  } catch (err) {
    autostart = { method, installed: false, enabled: false, detail: String((err as Error)?.message ?? err) };
  }
  const sandbox = await sandboxStatusSummary();
  return {
    controller: {
      running: controllerStatus.running,
      adopted: controllerStatus.running && controllerChild === null,
      port: controllerStatus.info?.port,
      pid: controllerStatus.info?.pid,
      startedAt: controllerStatus.info?.startedAt,
    },
    autostart,
    autostartInstallable: !transient,
    sandbox,
  };
}

// renderer -> main -> 제어 서비스. 경로/메서드 화이트리스트를 통과한 요청만 전달하고
// bearer 토큰은 여기서만 붙인다. 응답은 계약대로 ApiResult<T>를 해제해 돌려준다.
async function forwardRequest(method: string, path: string, body: unknown): Promise<ApiResult<unknown>> {
  if (!isAllowedApiPath(method, path)) {
    return errorResult('path_not_allowed', `허용되지 않은 요청입니다: ${method} ${path}`);
  }
  // 요청 네임스페이스(/demo 대 실제)는 main 소유의 effectiveMode에 결속한다. 손상된 renderer가
  // 데모 세션에서 실제 경로를(또는 그 반대) 밀어 넣어도 여기서 거부한다(권한은 문자열로 못 바꾼다).
  if (!requestNamespaceMatches(effectiveMode, path)) {
    return errorResult('mode_mismatch', '요청이 현재 실행 모드와 일치하지 않습니다.');
  }
  const info = await readControllerInfo();
  if (!info) {
    return errorResult('controller_unavailable', '제어 서비스가 준비되지 않았습니다. 잠시 후 다시 시도하세요.');
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${info.token}`,
    origin: 'app://appops',
    accept: 'application/json',
  };
  const init: RequestInit = { method: method.toUpperCase(), headers };
  if (body !== undefined && body !== null && method.toUpperCase() !== 'GET') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(`${apiBase(info)}${path}`, init);
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        return errorResult('bad_response', `제어 서비스 응답을 해석할 수 없습니다 (HTTP ${res.status}).`);
      }
    }
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
      return parsed as ApiResult<unknown>;
    }
    if (!res.ok) {
      return errorResult('http_error', `요청이 실패했습니다 (HTTP ${res.status}).`);
    }
    return { ok: true, data: parsed };
  } catch (err) {
    console.error('[appops] request failed', method, path, redactSecrets({ message: String(err) }));
    return errorResult('network_error', '제어 서비스에 연결할 수 없습니다.');
  }
}

// IPC 발신 프레임의 URL 계약을 검사한다: 프로덕션은 패키지된 진입 파일의 정확한 file: URL만,
// 개발은 loopback dev 서버만 신뢰한다(임의 file://·임베드 외부 프레임 차단). 최상위 프레임만 허용한다.
function isTrustedFrame(frame: WebFrameMain | null): boolean {
  if (!frame) return false;
  // 최상위 프레임만 허용(부모가 없음).
  if (frame.parent) return false;
  return isTrustedFrameUrl(frame.url, {
    devServerUrl: DEV_SERVER_URL,
    entryUrl: DEV_SERVER_URL ? null : PACKAGED_ENTRY_URL,
  });
}

// IPC 발신자 검사: 신뢰하는 창의 webContents 신원 + 신뢰 프레임 URL을 모두 요구한다. 우리가 만든
// 그 창의 최상위 프레임에서 온 호출만 특권 작업을 수행한다(다른 webContents·서브프레임·외부 URL 차단).
function isTrustedSender(e: { senderFrame: WebFrameMain | null; sender?: { id: number } }): boolean {
  if (mainWindowId === null || e.sender?.id !== mainWindowId) return false;
  return isTrustedSender(e);
}

// 데모 모드는 실제 제어 서비스·OS 자동 시작을 절대 바꾸지 않는다는 불변식을 main 경계에서 강제한다.
// 권한 판정은 main 소유의 effectiveMode만 근거로 한다(renderer가 넘긴 문자열이 아니다). 'live'가
// 아니면(데모·미상) 실제 변경을 거부한다(안전 기본값).
function demoBlocksMutation(): ApiResult<never> | null {
  if (effectiveMode === 'live') return null;
  return errorResult('demo_blocked', '데모에서는 실제 제어 서비스·자동 시작을 바꾸지 않습니다.');
}

// ---------------------------------------------------------------------------
// 전체(포터블) 암호화 백업 파일 브리지 (대용량 스트리밍).
// - renderer는 파일 바이트·경로·토큰을 절대 다루지 않는다. 파일 선택은 네이티브 dialog, 전송은
//   loopback+bearer로 main만 수행한다. 실행 모드(demo/live)는 main 소유의 effectiveMode를 쓴다.
// - 다운로드: Content-Length+SHA-256을 필수로 요구하고(없으면 저장 거부), 배타적(O_EXCL) 0600 임시
//   파일에 스트리밍하며 정확한 바이트를 해싱해 길이·해시가 일치할 때만 파일+부모 디렉터리를 fsync한
//   뒤 원자적 rename으로 목적지를 교체한다(검증 전 기존 파일 미덮어쓰기, 실패 시 원본 보존).
// - 가져오기: 고른 일반 파일을 O_NOFOLLOW로 한 번 열어 그 디스크립터로 stat·매직·업로드를 모두
//   수행한다(경로 교체 TOCTOU 방지). 정확한 길이/상한을 강제하고 결과는 {id,size}만 반환한다.
// ---------------------------------------------------------------------------
type PortableSaveResult = { ok: boolean; canceled?: boolean; error?: string };

function backupHttpModule(protocol: string): typeof http | typeof https {
  return protocol === 'https:' ? https : http;
}

async function portableBackupSave(id: unknown): Promise<PortableSaveResult> {
  if (!isPortableBackupId(id)) return { ok: false, error: '잘못된 백업 식별자입니다.' };
  const m: PortableBackupMode = effectiveMode;
  const info = await readControllerInfo();
  if (!info) return { ok: false, error: '제어 서비스가 준비되지 않았습니다.' };

  const chosen = await dialog.showSaveDialog({
    title: '전체 백업 내보내기',
    defaultPath: `appops-backup-${id}.appopsbackup`,
    filters: [{ name: 'AppOps 암호화 백업', extensions: ['appopsbackup'] }],
  });
  if (chosen.canceled || !chosen.filePath) return { ok: false, canceled: true };
  const dest = chosen.filePath;

  let res: Response;
  try {
    res = await fetch(`${apiBase(info)}${portableBackupDownloadPath(m, id)}`, {
      headers: {
        authorization: `Bearer ${info.token}`,
        origin: 'app://appops',
        accept: 'application/vnd.appops.backup',
      },
    });
  } catch {
    return { ok: false, error: '제어 서비스에 연결할 수 없습니다.' };
  }
  if (!res.ok || !res.body) {
    return { ok: false, error: `백업을 내려받지 못했습니다 (HTTP ${res.status}).` };
  }
  // 무결성 정보 필수(fail-closed): 유효한 Content-Length와 SHA-256 헤더가 없으면 저장하지 않는다.
  const expectation = parseDownloadExpectation(res.headers.get('content-length'), res.headers.get('x-appops-sha256'));
  if (!expectation.ok) {
    return {
      ok: false,
      error:
        expectation.reason === 'too_large'
          ? '백업이 허용 크기를 초과합니다.'
          : '백업의 무결성 정보(길이·해시)를 확인할 수 없어 저장하지 않았습니다. 기존 파일은 그대로 유지됩니다.',
    };
  }
  try {
    // O_EXCL 0600 임시 파일에 스트리밍 → 정확 바이트 해싱 → 길이·SHA 일치 시 파일+부모 fsync → 원자적 rename.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DOM ReadableStream을 node async iterable로.
    await streamDownloadToFile(Readable.fromWeb(res.body as any), dest, expectation.value);
    return { ok: true };
  } catch (err) {
    console.error('[appops] portable backup save failed', (err as Error)?.name);
    const integrity = err instanceof Error && /mismatch|length|write/.test(err.message);
    return {
      ok: false,
      error: integrity
        ? '내려받은 백업의 무결성 검증에 실패했습니다. 기존 파일은 그대로 유지됩니다.'
        : '백업을 저장하지 못했습니다. 기존 파일은 그대로 유지됩니다.',
    };
  }
}

// 열린(O_NOFOLLOW로 고정된) 디스크립터에서 그대로 스트리밍 업로드한다. 경로가 아니라 inode의 바이트를
// 전송하므로 검증 이후의 경로 교체가 다른 파일을 올리지 못한다. content-length는 검증한 크기로 고정한다.
function streamUploadBackup(
  info: ControllerInfo,
  mode: PortableBackupMode,
  fh: FileHandle,
  size: number,
): Promise<ApiResult<{ id: string; size: number }>> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${apiBase(info)}${portableBackupImportPath(mode)}`);
    const req = backupHttpModule(url.protocol).request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${info.token}`,
          origin: 'app://appops',
          accept: 'application/json',
          'content-type': 'application/octet-stream',
          'content-length': size,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => {
          let parsed: unknown = null;
          if (body.length > 0) {
            try {
              parsed = JSON.parse(body);
            } catch {
              resolve(errorResult('bad_response', '제어 서비스 응답을 해석할 수 없습니다.'));
              return;
            }
          }
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
            resolve(parsed as ApiResult<{ id: string; size: number }>);
            return;
          }
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            resolve(errorResult('http_error', `가져오기가 실패했습니다 (HTTP ${status}).`));
            return;
          }
          resolve({ ok: true, data: parsed as { id: string; size: number } });
        });
      },
    );
    req.on('error', (e) => reject(e));
    // 고정된 디스크립터에서 위치 0부터 읽는다(autoClose:false — 닫기는 호출부가 finally에서 담당).
    const rs = fh.createReadStream({ autoClose: false, start: 0 });
    rs.on('error', (e) => {
      req.destroy(e);
      reject(e);
    });
    rs.pipe(req);
  });
}

async function portableBackupImport(): Promise<ApiResult<{ id: string; size: number }>> {
  const m: PortableBackupMode = effectiveMode;
  const info = await readControllerInfo();
  if (!info) return errorResult('controller_unavailable', '제어 서비스가 준비되지 않았습니다.');

  const chosen = await dialog.showOpenDialog({
    title: '전체 백업 가져오기',
    properties: ['openFile'],
    filters: [{ name: 'AppOps 암호화 백업', extensions: ['appopsbackup'] }],
  });
  if (chosen.canceled || chosen.filePaths.length === 0) {
    return errorResult('canceled', '가져오기를 취소했습니다.');
  }
  const src = chosen.filePaths[0];

  // O_NOFOLLOW로 한 번 열어 stat(일반 파일·크기)과 매직을 같은 디스크립터로 확인하고, 그 디스크립터를
  // 업로드 스트림까지 잡고 있는다(경로 교체 TOCTOU 방지). 실패 시 보안 헬퍼가 디스크립터를 닫는다.
  const opened = await openPinnedBackupSource(src, MAX_PORTABLE_BACKUP_BYTES);
  if (!opened.ok) return errorResult(opened.code, opened.message);
  const { fh, size } = opened.value;
  try {
    return await streamUploadBackup(info, m, fh, size);
  } catch (err) {
    console.error('[appops] portable backup import failed', (err as Error)?.name);
    return errorResult('import_failed', '백업을 가져오지 못했습니다.');
  } finally {
    await fh.close().catch(() => {});
  }
}

function registerIpc(): void {
  ipcMain.handle('appops:request', async (e, method: string, path: string, body: unknown) => {
    if (!isTrustedSender(e)) {
      return errorResult('forbidden', '신뢰할 수 없는 호출입니다.');
    }
    return forwardRequest(method, path, body);
  });

  ipcMain.handle('appops:selectArtifact',async(e,target:unknown)=>{
    if(!isTrustedSender(e)||effectiveMode!=='live'||typeof target!=='string'||!['android','ios','windows','macos','linux'].includes(target))return null;
    const mode=effectiveMode;
    const result=await dialog.showOpenDialog({title:'외부 빌드 결과물 선택',properties:[['android','ios'].includes(target)?'openFile':'openDirectory'],...(['android','ios'].includes(target)?{filters:[{name:'배포 결과물',extensions:target==='android'?['aab','apk']:['ipa']}]}:{})});
    return effectiveMode===mode&&!result.canceled?result.filePaths[0]??null:null;
  });

  ipcMain.handle('appops:selectFolder', async (e) => {
    if (!isTrustedSender(e)) return null;
    const result = await dialog.showOpenDialog({
      title: '프로젝트 폴더 선택',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('appops:openExternal', async (e, url: string) => {
    if (!isTrustedSender(e)) return { ok: false as const, error: '신뢰할 수 없는 호출입니다.' };
    if (!isAllowedExternalUrl(url)) {
      return { ok: false as const, error: '허용되지 않은 외부 링크입니다.' };
    }
    await shell.openExternal(url);
    return { ok: true as const };
  });

  ipcMain.handle('appops:platform', (e) => (isTrustedSender(e) ? process.platform : ''));

  // 수명주기: 상태 조회 / 명시적 중지 / 재시작. 상태도 ApiResult로 일관되게 반환한다.
  ipcMain.handle('appops:lifecycle:status', async (e): Promise<ApiResult<unknown>> => {
    if (!isTrustedSender(e)) return errorResult('forbidden', '신뢰할 수 없는 호출입니다.');
    try {
      return { ok: true, data: await lifecycleStatusPayload() };
    } catch (err) {
      return errorResult('lifecycle_status_failed', String((err as Error)?.message ?? err));
    }
  });

  ipcMain.handle('appops:lifecycle:stopController', async (e): Promise<ApiResult<{ stopped: boolean; wasRunning: boolean }>> => {
    if (!isTrustedSender(e)) return errorResult('forbidden', '신뢰할 수 없는 호출입니다.');
    const blocked = demoBlocksMutation();
    if (blocked) return blocked;
    // 명시적 중지: 창 닫기와 구분되는 유일한 제어 서비스 종료 경로. 신원 확인 후에만 PID를 종료한다.
    const outcome = await stopControllerLifecycle(makeControllerDeps());
    return { ok: true, data: { stopped: outcome.stopped, wasRunning: outcome.wasRunning } };
  });

  ipcMain.handle('appops:lifecycle:restartController', async (e): Promise<ApiResult<{ running: boolean }>> => {
    if (!isTrustedSender(e)) return errorResult('forbidden', '신뢰할 수 없는 호출입니다.');
    const blocked = demoBlocksMutation();
    if (blocked) return blocked;
    const outcome = await restartControllerLifecycle(makeControllerDeps());
    if (outcome.status === 'failed') return errorResult(outcome.error.code, outcome.error.message);
    return { ok: true, data: { running: true } };
  });

  // 자동 시작: 로그인 시 제어 서비스 기동 설치/상태/제거.
  ipcMain.handle('appops:autostart:status', async (e): Promise<ApiResult<AutostartStatus>> => {
    if (!isTrustedSender(e)) return errorResult('forbidden', '신뢰할 수 없는 호출입니다.');
    try {
      const { method, target, deps } = autostartContext();
      return { ok: true, data: await getAutostartStatus(method, target, deps) };
    } catch (err) {
      return errorResult('autostart_status_failed', String((err as Error)?.message ?? err));
    }
  });

  ipcMain.handle('appops:autostart:enable', async (e): Promise<ApiResult<AutostartStatus>> => {
    if (!isTrustedSender(e)) return errorResult('forbidden', '신뢰할 수 없는 호출입니다.');
    const blocked = demoBlocksMutation();
    if (blocked) return blocked;
    const { method, target, deps, transient } = autostartContext();
    if (transient) {
      return errorResult(
        'autostart_unstable_path',
        '앱이 설치된 안정 경로에서 실행 중이 아닙니다. 앱을 설치(deb/rpm/dmg 또는 AppImage 통합)한 뒤 자동 시작을 설정하세요.',
      );
    }
    try {
      return { ok: true, data: await installAutostart(method, target, deps) };
    } catch (err) {
      return errorResult('autostart_enable_failed', String((err as Error)?.message ?? err));
    }
  });

  ipcMain.handle('appops:autostart:disable', async (e): Promise<ApiResult<AutostartStatus>> => {
    if (!isTrustedSender(e)) return errorResult('forbidden', '신뢰할 수 없는 호출입니다.');
    const blocked = demoBlocksMutation();
    if (blocked) return blocked;
    try {
      const { method, target, deps } = autostartContext();
      return { ok: true, data: await removeAutostart(method, target, deps) };
    } catch (err) {
      return errorResult('autostart_disable_failed', String((err as Error)?.message ?? err));
    }
  });

  // 실행 모드 권한 브리지(main 소유). getMode는 현재 effectiveMode를 돌려주고, setMode는 전환을 반영한다.
  // - 실제(live)로의 전환은 main 소유의 명시적 사용자 확인창을 통과해야만 반영된다(renderer 확인창을
  //   대체하는 단 하나의 확인 — 이중 프롬프트·재로그인 없음). 취소하면 모드는 바뀌지 않는다.
  // - 데모로의 전환은 파괴적이지 않으므로 추가 확인 없이 즉시 반영한다.
  // 어느 경우든 renderer가 넘긴 문자열이 권한을 바꾸지 못한다 — 값은 main이 정하고 디스크에 영속한다.
  ipcMain.handle('appops:mode:get', (e): PortableBackupMode => (isTrustedSender(e) ? effectiveMode : 'demo'));

  ipcMain.handle(
    'appops:mode:set',
    async (e, next: unknown): Promise<{ ok: boolean; mode: PortableBackupMode; canceled?: boolean }> => {
      if (!isTrustedSender(e)) return { ok: false, mode: 'demo' };
      const target = normalizePortableMode(next);
      if (target === effectiveMode) return { ok: true, mode: effectiveMode };
      if (target === 'live') {
        const win = BrowserWindow.fromWebContents(e.sender);
        const options = {
          type: 'warning' as const,
          buttons: ['취소', '실제 모드로 전환'],
          defaultId: 1,
          cancelId: 0,
          title: '실제 계정 모드로 전환',
          message: '실제 계정 모드로 전환할까요?',
          detail:
            '실제 모드에서는 연결된 실제 계정과 저장된 권한·정책·검증된 빌드로 작업합니다. 게시·업로드·캠페인 등 외부 쓰기가 실제 공급자에 반영될 수 있습니다. 데모의 실행·자원은 실제 계정으로 복사되지 않습니다.',
          noLink: true,
        };
        const choice = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        if (choice.response !== 1) return { ok: false, mode: effectiveMode, canceled: true };
      }
      effectiveMode = target;
      try {
        await persistEffectiveMode(target);
      } catch (err) {
        console.error('[appops] 실행 모드 저장 실패', (err as Error)?.name);
      }
      return { ok: true, mode: effectiveMode };
    },
  );

  // 전체(포터블) 백업 파일 브리지. 대용량 암호화 파일을 main만 loopback+bearer로 스트리밍한다.
  // 데모/실제 라우팅은 main 소유의 effectiveMode를 따른다(renderer가 모드를 넘기지 않는다).
  ipcMain.handle('appops:portableBackup:save', async (e, id: unknown): Promise<PortableSaveResult> => {
    if (!isTrustedSender(e)) return { ok: false, error: '신뢰할 수 없는 호출입니다.' };
    return portableBackupSave(id);
  });

  ipcMain.handle('appops:portableBackup:import', async (e): Promise<ApiResult<{ id: string; size: number }>> => {
    if (!isTrustedSender(e)) return errorResult('forbidden', '신뢰할 수 없는 호출입니다.');
    return portableBackupImport();
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#16233b',
    title: 'gameStudioAutomaiton',
    show: false,
    webPreferences: {
      // 샌드박스 프리로드는 CommonJS여야 로드된다(ESM .js는 sandbox:true에서 로드되지 않아
      // window.appOps가 노출되지 않는다). 루트의 build-preload가 preload.ts를 preload.cjs로 번들한다.
      preload: join(HERE, 'preload.cjs'),
      // 보안 경계: renderer에서 Node 통합 금지, contextIsolation 유지, sandbox·원격 모듈 금지.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  // IPC 신뢰 판정에 쓸 창의 webContents 신원을 기록한다(이 창에서 온 호출만 특권 작업 수행).
  mainWindowId = win.webContents.id;
  win.on('closed', () => {
    if (mainWindowId === win.webContents.id) mainWindowId = null;
  });

  win.once('ready-to-show', () => win.show());

  // renderer가 외부 페이지로 이동하거나 새 창을 여는 것을 차단한다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const isDev = DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL);
    if (!isDev) event.preventDefault();
  });

  if (DEV_SERVER_URL) {
    await win.loadURL(DEV_SERVER_URL);
  } else {
    // 프로덕션: Vite 빌드 결과(renderer)를 로드한다.
    // main.js는 dist/apps/desktop/electron/에 위치하므로 ../renderer/index.html 로 해석된다.
    // 신뢰 프레임 판정(PACKAGED_ENTRY_URL)과 동일한 경로 상수를 사용한다.
    await win.loadFile(RENDERER_INDEX);
  }
}

// 헤드리스 제어 서비스 모드: 화면·IPC 없이 제어 서비스 진입점을 현재 프로세스에서 구동한다.
// 제어 서비스의 HTTP 서버와 SIGINT/SIGTERM 처리가 프로세스를 유지한다(AppImage면 자체 마운트도 유지).
async function runControllerOnly(): Promise<void> {
  try {
    // 내구성 있는 명시적 중지 표식이 있으면 기동하지 않는다. 이 헤드리스 경로는 서비스 매니저의
    // 자동 재기동(SIGKILL 승격 이후)과 로그인 자동 시작이 통과하는 지점이다. 명시적 시작은
    // 기동 전에 표식을 지우므로, 여기서 표식이 남아 있다는 것은 자동 재기동/중지 후 로그인이다.
    if (await isIntentionalStop(autostartFs, getDataDirectory())) {
      console.error('[appops] 명시적 중지 표식이 있어 제어 서비스를 기동하지 않습니다.');
      process.exit(0);
    }
    await import(pathToFileURL(CONTROLLER_ENTRY).href);
  } catch (err) {
    console.error('[appops] 헤드리스 제어 서비스 기동 실패', redactSecrets({ message: String(err) }));
    process.exit(1);
  }
}

if (CONTROLLER_ONLY) {
  void runControllerOnly();
} else {
  // 단일 인스턴스: 두 번째 창 실행은 기존 창을 활성화하고 종료한다(제어 서비스 소유권은 헬스/토큰으로 판정).
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
    app.whenReady().then(async () => {
      // 실행 모드 권한을 디스크에서 먼저 적재한다(없으면 데모). 창이 뜨기 전에 확정한다.
      await loadEffectiveMode();
      registerIpc();
      // 화면을 먼저 띄우고, 컨트롤러 준비는 백그라운드에서 진행한다(renderer는 준비될 때까지 재시도한다).
      void createWindow();
      void ensureController();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
    });
    app.on('window-all-closed', () => {
      // 화면 종료는 제어 서비스 종료와 별개다: 인가된 자동화는 detached 제어 서비스로 계속 실행된다.
      // 제어 서비스는 renderer의 명시적 중지(appops:lifecycle:stopController)에서만 종료된다.
      if (process.platform !== 'darwin') app.quit();
    });
  }
}
