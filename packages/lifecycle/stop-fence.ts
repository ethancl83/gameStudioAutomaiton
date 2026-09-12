// 내구성 있는 "명시적 중지" 표식(intentional-stop fence).
//
// 사용자가 제어 서비스를 명시적으로 중지하면 이 표식 파일을 남긴다. 자식 프로세스 정리를 위해
// SIGKILL 승격이 일어나 서비스 매니저(systemd Restart=on-failure 등)가 프로세스를 자동
// 재기동하려 해도, 제어 서비스 진입점이 이 표식을 보고 기동을 건너뛴다. 즉 "명시적 중지는
// 자동 재기동하지 않는다"는 계약이 강제 종료(SIGKILL) 경로에서도 유지된다.
//
// 명시적 시작(앱 재실행/다시 시작 버튼/런처 --force)은 기동 전에 표식을 지운다. 따라서 진입
// 시점에 표식이 남아 있다는 것은 이번 기동이 서비스 매니저의 자동 재기동이거나 명시적 중지 이후의
// 로그인 자동 시작임을 뜻한다 — 두 경우 모두 기동하지 않아야 한다.
//
// 부수효과는 주입한 fs로 수행해 테스트에서 실제 호스트를 건드리지 않는다. 경로는 데이터
// 디렉터리(controller.json이 있는 곳) 기준이며 진입점·앱·런처가 모두 동일하게 계산한다.

import { dirname, join } from 'node:path';
import type { FsLike } from './types.js';

export const STOP_FENCE_FILENAME = 'controller.stop';

// 데이터 디렉터리 아래의 표식 경로.
export function stopFencePath(dataDir: string): string {
  return join(dataDir, STOP_FENCE_FILENAME);
}

export interface StopFenceRecord {
  stoppedAt: string;
  pid?: number;
  reason?: string;
}

// 명시적 중지 표식을 남긴다(내구성). 이미 있으면 갱신한다.
export async function markIntentionalStop(
  fs: FsLike,
  dataDir: string,
  record: { pid?: number; reason?: string; stoppedAt?: string } = {},
): Promise<void> {
  const body: StopFenceRecord = {
    stoppedAt: record.stoppedAt ?? new Date().toISOString(),
    pid: record.pid,
    reason: record.reason,
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(stopFencePath(dataDir), JSON.stringify(body), { mode: 0o600 });
}

// 표식을 지운다(명시적 시작). 없으면 무시한다.
export async function clearIntentionalStop(fs: FsLike, dataDir: string): Promise<void> {
  await fs.rm(stopFencePath(dataDir), { force: true });
}

// 명시적 중지 표식이 있는지 확인한다.
export async function isIntentionalStop(fs: FsLike, dataDir: string): Promise<boolean> {
  try {
    await fs.access(stopFencePath(dataDir));
    return true;
  } catch {
    return false;
  }
}

// 표식 내용을 읽는다(없거나 파싱 실패면 null).
export async function readIntentionalStop(fs: FsLike, dataDir: string): Promise<StopFenceRecord | null> {
  try {
    const raw = await fs.readFile(stopFencePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as StopFenceRecord;
    return typeof parsed?.stoppedAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// 데이터 디렉터리를 controller.json 경로에서 유도하는 편의 함수.
export function dataDirOfControllerInfoPath(controllerInfoPath: string): string {
  return dirname(controllerInfoPath);
}
