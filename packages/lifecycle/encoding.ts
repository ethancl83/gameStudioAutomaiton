// 플랫폼별 인자/명령 인코딩. 경로에 공백·특수문자가 있어도 안전하게 자동 시작 아티팩트를 생성한다.
// 각 규칙은 공식 명세를 따른다:
// - Desktop Entry Exec: freedesktop.org Desktop Entry Specification
// - Windows argv: CommandLineToArgvW 규칙
// - systemd ExecStart: systemd.service 인용 규칙

// 어떤 자동 시작 아티팩트에서도 안전하게 인코딩할 수 없는 문자(개행·복귀·NUL·기타 C0/C1
// 제어문자). 유닛/Desktop Entry/plist/schtasks 인자 어디에 들어가도 지시문 주입·파싱 파손을
// 일으키므로 렌더링 전에 거부한다.
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

// 값에 제어문자가 있으면 예외를 던진다. 렌더러/타깃 빌더의 공통 입력 방어.
export function assertNoControlChars(label: string, value: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new Error(`자동 시작 값에 허용되지 않는 제어문자가 있습니다: ${label}`);
  }
}

// Desktop Entry 명세가 인용을 요구하는 예약 문자.
const DESKTOP_RESERVED = /[ \t\n"'\\><~|&;$*?#()`]/;

// .desktop Exec 인자 하나를 인코딩한다.
// - 필드 코드 오해를 막기 위해 리터럴 '%'는 항상 '%%'로 이스케이프한다(인용 여부와 무관).
// - 예약 문자가 있으면 큰따옴표로 감싸고, 내부의 " ` $ \ 를 백슬래시로 이스케이프한다.
export function escapeDesktopExecArg(arg: string): string {
  const percentSafe = arg.replace(/%/g, '%%');
  if (percentSafe.length > 0 && !DESKTOP_RESERVED.test(percentSafe)) return percentSafe;
  const escaped = percentSafe.replace(/(["`$\\])/g, '\\$1');
  return `"${escaped}"`;
}

export function buildDesktopExec(program: string, args: string[]): string {
  return [program, ...args].map(escapeDesktopExecArg).join(' ');
}

// systemd ExecStart 인자 하나를 인코딩한다. 공백/따옴표/백슬래시가 있으면 큰따옴표로 감싼다.
export function escapeSystemdArg(arg: string): string {
  if (arg.length > 0 && !/[\s"'\\]/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, '\\$1')}"`;
}

export function buildSystemdExec(program: string, args: string[]): string {
  return [program, ...args].map(escapeSystemdArg).join(' ');
}

// systemd 환경 변수 이름 규칙(POSIX): 첫 글자는 문자/밑줄, 이후 문자/숫자/밑줄.
const SYSTEMD_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// systemd `Environment=` 한 줄을 안전하게 만든다.
// 값에 공백이 있으면 분리돼 잘못된 할당이 되므로 항상 `Environment="KEY=value"` 형태로 감싸고,
// 값 안의 " 와 \ 를 이스케이프한다(개행/제어문자는 호출 전에 거부). 키가 규칙을 어기면 거부한다.
export function buildSystemdEnvLine(key: string, value: string): string {
  if (!SYSTEMD_ENV_KEY.test(key)) {
    throw new Error(`systemd 환경 변수 이름이 올바르지 않습니다: ${key}`);
  }
  const escaped = value.replace(/([\\"])/g, '\\$1');
  return `Environment="${key}=${escaped}"`;
}

// CommandLineToArgvW 규칙에 따라 Windows 인자 하나를 인용한다.
export function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[ \t"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      // 따옴표 앞의 백슬래시는 2배로, 그리고 따옴표 자체를 이스케이프.
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    if (backslashes > 0) {
      result += '\\'.repeat(backslashes);
      backslashes = 0;
    }
    result += ch;
  }
  // 닫는 따옴표 앞의 백슬래시는 2배로.
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

export function buildWindowsCommand(program: string, args: string[]): string {
  return [program, ...args].map(quoteWindowsArg).join(' ');
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
