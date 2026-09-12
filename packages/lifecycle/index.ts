// 앱/제어 서비스 수명주기와 OS 자동 시작·Linux 샌드박스 진단의 공개 API.
// Electron·OS에 직접 의존하지 않는 순수 함수와 주입형 관리자만 노출한다.

export * from './types.js';
export {
  ensureController,
  stopController,
  restartController,
  getControllerStatus,
} from './controller.js';
export type {
  ControllerDeps,
  EnsureOptions,
  StopOptions,
  EnsureOutcome,
  StopOutcome,
  ControllerStatus,
  SpawnResult,
} from './controller.js';
export {
  defaultAutostartMethod,
  installAutostart,
  getAutostartStatus,
  removeAutostart,
  renderSystemdUnit,
  renderDesktopEntry,
  renderLaunchAgentPlist,
  buildSchtasksCreateArgs,
  buildSchtasksDeleteArgs,
  buildSchtasksQueryArgs,
  parseSchtasksState,
  validateAutostartTarget,
} from './autostart.js';
export type { AutostartDeps } from './autostart.js';
export {
  escapeDesktopExecArg,
  buildDesktopExec,
  escapeSystemdArg,
  buildSystemdExec,
  buildSystemdEnvLine,
  quoteWindowsArg,
  buildWindowsCommand,
  escapeXml,
  assertNoControlChars,
  CONTROL_CHARS,
} from './encoding.js';
export {
  stopFencePath,
  markIntentionalStop,
  clearIntentionalStop,
  isIntentionalStop,
  readIntentionalStop,
  dataDirOfControllerInfoPath,
  STOP_FENCE_FILENAME,
} from './stop-fence.js';
export type { StopFenceRecord } from './stop-fence.js';
export {
  buildControllerAutostartTarget,
  CONTROLLER_AUTOSTART_ID,
  CONTROLLER_AUTOSTART_LABEL,
} from './target.js';
export type { ControllerTargetOptions } from './target.js';
export {
  inspectLinuxSandbox,
  sandboxChmodCommands,
  renderAppArmorProfile,
} from './linux-sandbox.js';
export type { SandboxProbe, SandboxStatus } from './linux-sandbox.js';
