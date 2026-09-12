#!/usr/bin/env node
// 헤드리스 제어 서비스 런처.
// - 로그인 자동 시작(systemd user ExecStart 등)이나 수동 실행에 사용한다.
// - 이미 건강한 제어 서비스가 있으면 새로 띄우지 않는다(단일 인스턴스 존중).
// - 기본은 포그라운드 실행(systemd/launchd가 수명 관리). --detach는 기동 후 종료.
// - 순수 Node 스크립트다(로그인 시 tsx 없이 실행 가능). 데이터 경로·헬스 로직은
//   packages/domain/paths.ts와 동일한 규칙을 의도적으로 복제했다.
// - 헬스 확인은 유한 시간(HEALTH_TIMEOUT_MS) 안에 공개 /api/health(startedAt 일치)와 인증된
//   /api/state(bearer 수락)를 모두 검사한다(PID 재사용/타 프로세스 방어).
// - 내구성 있는 명시적 중지 표식(controller.stop)이 있으면 기동을 건너뛴다(로그인 자동 시작으로도
//   쓰이므로). 수동 재시작은 --force로 표식을 지우고 기동한다(HTTP가 내려가 있어도 동작).
//
// 사용법: node scripts/launch.mjs [--detach] [--status] [--force]

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

// HTTP 신원 확인은 반드시 유한 시간 안에 끝나야 한다(응답이 없는 PID·다른 프로세스가 포트를 잡은
// 경우에도 매달리지 않도록). 로컬 loopback 호출이라 짧은 상한으로 충분하다.
const HEALTH_TIMEOUT_MS = 2500;

function dataDir() {
  if (process.env.APPOPS_DATA_DIR) return resolve(process.env.APPOPS_DATA_DIR);
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'app-operations');
}

// 내구성 있는 명시적 중지 표식(packages/lifecycle과 동일한 경로 규칙: controller.json 옆).
function stopFencePath() {
  return join(dataDir(), 'controller.stop');
}

async function readInfo() {
  try {
    return JSON.parse(await readFile(join(dataDir(), 'controller.json'), 'utf8'));
  } catch {
    return null;
  }
}

// 유한 시간 fetch. 상한 초과·연결 오류는 모두 거부(살아 있지 않음)로 처리한다.
async function boundedFetch(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
}

// 우리 인스턴스가 살아 있는지 인증된 신원까지 확인한다(PID 재사용/타 프로세스 방어).
//  - 공개 /api/health: startedAt이 controller.json과 일치(그 포트의 인스턴스가 우리가 기록한 그것).
//  - 인증된 /api/state: 우리 bearer 토큰을 수락(그 인스턴스가 우리 제어 서비스임을 증명).
// 두 확인 모두 유한 시간 안에 끝난다. main.ts verifyOwnController와 같은 판정이다.
async function healthy(info) {
  if (!info?.port || !info?.token) return false;
  const base = `http://127.0.0.1:${info.port}/api`;
  try {
    const healthRes = await boundedFetch(`${base}/health`, { headers: { accept: 'application/json' } });
    if (!healthRes.ok) return false;
    const body = await healthRes.json().catch(() => null);
    if (info.startedAt && body?.data?.startedAt && body.data.startedAt !== info.startedAt) return false;
    const stateRes = await boundedFetch(`${base}/state`, {
      headers: { authorization: `Bearer ${info.token}`, accept: 'application/json' },
    });
    return stateRes.ok;
  } catch {
    return false;
  }
}

function controllerCommand() {
  const built = join(ROOT, 'dist', 'apps', 'controller', 'main.js');
  if (existsSync(built)) return { cmd: process.execPath, args: [built] };
  // 소스 실행 경로(개발): tsx가 필요하다.
  return { cmd: process.execPath, args: ['--import', 'tsx', join(ROOT, 'apps', 'controller', 'main.ts')] };
}

const detach = process.argv.includes('--detach');
const statusOnly = process.argv.includes('--status');
// 명시적 중지 표식을 무시하고 강제로 기동한다(수동 재시작). 표식을 지운 뒤 기동한다.
const force = process.argv.includes('--force');

const existing = await readInfo();
if (await healthy(existing)) {
  process.stdout.write(`제어 서비스가 이미 실행 중입니다: http://127.0.0.1:${existing.port} (pid ${existing.pid ?? '?'})\n`);
  process.exit(0);
}
if (statusOnly) {
  const fenced = existsSync(stopFencePath());
  process.stdout.write(fenced ? '제어 서비스가 명시적으로 중지된 상태입니다(자동 시작 보류).\n' : '제어 서비스가 실행 중이 아닙니다.\n');
  process.exit(1);
}

// 내구성 있는 명시적 중지 표식을 존중한다. 이 런처는 로그인 자동 시작(ExecStart)으로도 쓰일 수
// 있으므로, 표식이 있으면 기동하지 않는다(명시적 중지가 자동 재기동으로 번지지 않게 함).
// 수동 재시작은 --force로 표식을 지우고 기동한다(HTTP가 내려가 있어도 동작).
if (existsSync(stopFencePath())) {
  if (!force) {
    process.stdout.write(
      '제어 서비스가 명시적으로 중지되어 기동을 건너뜁니다. 다시 시작하려면 --force 또는 앱의 다시 시작을 사용하세요.\n',
    );
    process.exit(0);
  }
  try {
    rmSync(stopFencePath(), { force: true });
  } catch {
    /* 이미 없으면 무시 */
  }
}

const { cmd, args } = controllerCommand();

if (detach) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await healthy(await readInfo())) {
      process.stdout.write(`제어 서비스를 백그라운드로 기동했습니다 (pid ${child.pid}).\n`);
      process.exit(0);
    }
  }
  process.stderr.write('제어 서비스가 제한 시간 내에 준비되지 않았습니다.\n');
  process.exit(1);
} else {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}
