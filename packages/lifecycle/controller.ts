// 앱과 제어 서비스의 수명주기 분리.
// - 앱(화면)이 종료돼도 인가된 제어 서비스 자동화는 계속 실행한다(detached 기동).
// - 건강한 제어 서비스가 이미 있으면 새로 띄우지 않고 인수한다(단일 인스턴스).
// - 명시적 중지만 제어 서비스를 종료하며, 기동 실패 시 남은 프로세스를 정리한다(고아 방지).
//
// 모든 부수효과(파일 읽기, 헬스 체크, 프로세스 기동/종료)는 주입해 독립 테스트가 가능하다.

import type { ControllerInfo } from './types.js';

export interface SpawnResult {
  pid?: number;
}

export interface ControllerDeps {
  // controller.json을 읽는다. force=true면 캐시를 무시한다.
  readInfo: (force?: boolean) => Promise<ControllerInfo | null>;
  // /health 응답이 정상인지 확인한다.
  checkHealth: (info: ControllerInfo) => Promise<boolean>;
  // 제어 서비스를 별도(detached) 프로세스로 기동한다. 실제 구현에서 unref()로 앱 종료와 분리한다.
  spawnController: () => SpawnResult | Promise<SpawnResult>;
  // pid에 신호를 보낸다. 성공하면 true. 존재하지 않으면 false.
  killPid: (pid: number, signal: NodeJS.Signals | number) => boolean;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  // 내구성 있는 명시적 중지 표식. 주입하면 stopController가 표식을 남기고(강제 종료 후에도
  // 자동 재기동을 막음), 명시적 시작(ensureController)이 표식을 지운다. 미주입이면 무동작.
  markStopIntent?: () => void | Promise<void>;
  clearStopIntent?: () => void | Promise<void>;
}

export interface EnsureOptions {
  startTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface StopOptions {
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}

export type EnsureOutcome =
  | { status: 'adopted'; info: ControllerInfo }
  | { status: 'started'; info: ControllerInfo }
  | { status: 'failed'; info: ControllerInfo | null; error: { code: string; message: string } };

export interface StopOutcome {
  stopped: boolean;
  wasRunning: boolean;
  pid?: number;
}

export interface ControllerStatus {
  running: boolean;
  info: ControllerInfo | null;
}

const DEFAULT_START_TIMEOUT = 15_000;
const DEFAULT_STOP_TIMEOUT = 10_000;
const DEFAULT_POLL = 400;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 건강한 제어 서비스가 있으면 인수하고, 없으면 기동해 /health가 응답할 때까지 폴링한다.
// 제한 시간 안에 준비되지 않으면 방금 띄운 프로세스를 정리하고 실패를 반환한다.
export async function ensureController(deps: ControllerDeps, options: EnsureOptions = {}): Promise<EnsureOutcome> {
  const delay = deps.delay ?? defaultDelay;
  const now = deps.now ?? Date.now;

  // 명시적 시작이다. 이전 명시적 중지 표식을 지워, 이번 및 이후 기동이 허용되게 한다.
  // (표식이 남아 있으면 진입점이 기동을 건너뛴다.) 시작 전에 반드시 지운다.
  await deps.clearStopIntent?.();

  let info = await deps.readInfo(true);
  if (info && (await deps.checkHealth(info))) {
    return { status: 'adopted', info };
  }

  let spawnedPid: number | undefined;
  try {
    const spawned = await deps.spawnController();
    spawnedPid = spawned?.pid;
  } catch (error) {
    return { status: 'failed', info, error: { code: 'spawn_failed', message: String((error as Error)?.message ?? error) } };
  }

  const deadline = now() + (options.startTimeoutMs ?? DEFAULT_START_TIMEOUT);
  const poll = options.pollIntervalMs ?? DEFAULT_POLL;
  while (now() < deadline) {
    await delay(poll);
    info = await deps.readInfo(true);
    if (info && (await deps.checkHealth(info))) {
      return { status: 'started', info };
    }
  }

  // 고아 방지: 기동은 됐지만 정상화되지 않은 프로세스를 정리한다.
  if (spawnedPid !== undefined) {
    try {
      deps.killPid(spawnedPid, 'SIGTERM');
    } catch {
      /* 이미 종료된 경우 무시 */
    }
  }
  return {
    status: 'failed',
    info,
    error: { code: 'start_timeout', message: '제어 서비스가 제한 시간 안에 준비되지 않았습니다.' },
  };
}

// 명시적 중지: controller.json의 소유자 pid에 SIGTERM을 보내고 헬스가 내려갈 때까지 기다린다.
// 정상 종료되지 않으면 SIGKILL로 승격한다. 앱 종료(창 닫기)와 구분되는 유일한 종료 경로다.
//
// PID 재사용 안전성: checkHealth는 인증된 신원 확인이어야 한다(우리 토큰을 받아들이고
// controller.json의 startedAt과 일치하는 인스턴스가 지금 살아 있음을 증명). 이 확인을
// 통과하지 못하면 신호를 보내지 않는다 — 죽은 controller.json이 가리키는 재사용된 PID를
// 실수로 종료하지 않기 위해서다.
export async function stopController(deps: ControllerDeps, options: StopOptions = {}): Promise<StopOutcome> {
  const delay = deps.delay ?? defaultDelay;
  const now = deps.now ?? Date.now;

  const info = await deps.readInfo(true);
  if (!info) return { stopped: false, wasRunning: false };
  const wasRunning = await deps.checkHealth(info);
  if (info.pid === undefined) {
    // pid를 모르면 신호를 보낼 수 없다. 실행 여부만 보고한다.
    return { stopped: false, wasRunning, pid: undefined };
  }
  if (!wasRunning) {
    // 신원이 확인되지 않은(또는 이미 죽은) 인스턴스의 PID는 종료하지 않는다.
    return { stopped: false, wasRunning: false, pid: info.pid };
  }

  // 내구성 있는 명시적 중지 표식을 신호 전송 전에 남긴다. 이렇게 하면 정상 종료(SIGTERM)든
  // 강제 종료(SIGKILL 승격)든 이후 서비스 매니저 자동 재기동/로그인 자동 시작이 진입점에서 차단된다.
  await deps.markStopIntent?.();

  deps.killPid(info.pid, 'SIGTERM');

  const deadline = now() + (options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT);
  const poll = options.pollIntervalMs ?? DEFAULT_POLL;
  while (now() < deadline) {
    await delay(poll);
    const current = await deps.readInfo(true);
    if (!current) return { stopped: true, wasRunning, pid: info.pid };
    if (!(await deps.checkHealth(current))) return { stopped: true, wasRunning, pid: info.pid };
  }

  // 정상 종료 실패 시 강제 종료.
  const killed = deps.killPid(info.pid, 'SIGKILL');
  return { stopped: killed, wasRunning, pid: info.pid };
}

export async function restartController(deps: ControllerDeps, options: EnsureOptions & StopOptions = {}): Promise<EnsureOutcome> {
  await stopController(deps, options);
  return ensureController(deps, options);
}

export async function getControllerStatus(deps: ControllerDeps): Promise<ControllerStatus> {
  const info = await deps.readInfo(true);
  const running = info ? await deps.checkHealth(info) : false;
  return { running, info };
}
