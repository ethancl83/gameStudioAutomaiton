// 앱/제어 서비스 수명주기와 OS 로그인 자동 시작의 공용 타입.
// Electron·OS API에 직접 의존하지 않도록 모든 부수효과는 주입 가능한 의존성으로 분리한다.

export type Platform = 'linux' | 'darwin' | 'win32';

// 제어 서비스가 controller.json에 기록하는 소유권/접속 정보.
// pid는 명시적 중지(SIGTERM)와 단일 인스턴스 판정에 사용한다.
export interface ControllerInfo {
  port: number;
  token: string;
  pid?: number;
  startedAt?: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// systemctl/launchctl/schtasks 등 외부 명령 실행기. 테스트에서는 목으로 주입한다.
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string },
) => Promise<CommandResult>;

// 파일 기반 자동 시작 아티팩트(systemd unit, .desktop, plist)를 다루는 최소 fs 인터페이스.
export interface FsLike {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  access(path: string): Promise<void>;
}

export type AutostartMethod = 'systemd-user' | 'xdg-autostart' | 'launchagent' | 'schtasks';

// 로그인 시 실행할 대상. 인자·환경변수는 인코딩되지 않은 원본을 담고, 렌더러가 플랫폼별로 인코딩한다.
export interface AutostartTarget {
  id: string; // 역DNS 식별자, 예: 'local.appops.controller'
  label: string;
  description?: string;
  program: string; // 실행 파일의 절대 경로
  args: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
}

export interface AutostartStatus {
  method: AutostartMethod;
  installed: boolean; // 설정 아티팩트 존재 여부
  enabled: boolean; // 로그인 시 실제 실행 여부
  path?: string; // 설정 파일 경로 또는 작업 이름
  detail?: string;
}
