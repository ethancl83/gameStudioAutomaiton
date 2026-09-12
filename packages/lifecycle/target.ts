// 로그인 자동 시작이 기동할 "제어 서비스" 대상을 구성한다.
// 패키지 앱에서는 앱 바이너리를 ELECTRON_RUN_AS_NODE=1로 실행해 화면 없이 제어 서비스만 띄운다.

import { validateAutostartTarget } from './autostart.js';
import type { AutostartTarget } from './types.js';

export const CONTROLLER_AUTOSTART_ID = 'local.appops.controller';
export const CONTROLLER_AUTOSTART_LABEL = '앱 운영 제어 서비스';

export interface ControllerTargetOptions {
  // 실행 파일 경로. 패키지 앱은 앱 바이너리(process.execPath).
  program: string;
  // 제어 서비스 진입 스크립트(main.js). ELECTRON_RUN_AS_NODE로 Node처럼 실행한다.
  controllerEntry: string;
  // 데이터 디렉터리를 고정해야 하면 지정한다(멀티 프로필 격리).
  dataDir?: string;
  // 앱 바이너리를 Node로 실행할지 여부. 기본 true(패키지 앱).
  runAsNode?: boolean;
  workingDirectory?: string;
}

export function buildControllerAutostartTarget(options: ControllerTargetOptions): AutostartTarget {
  const runAsNode = options.runAsNode ?? true;
  const env: Record<string, string> = {};
  if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  if (options.dataDir) env.APPOPS_DATA_DIR = options.dataDir;
  const target: AutostartTarget = {
    id: CONTROLLER_AUTOSTART_ID,
    label: CONTROLLER_AUTOSTART_LABEL,
    description: '로그인 시 앱 운영 자동화(빌드/게시/SNS 예약)를 백그라운드에서 실행합니다.',
    program: options.program,
    args: [options.controllerEntry],
    env: Object.keys(env).length > 0 ? env : undefined,
    workingDirectory: options.workingDirectory,
  };
  // 진입점에서 개행·NUL 등 제어문자를 한 번에 거부한다(program·args·env·workingDirectory).
  validateAutostartTarget(target);
  return target;
}
