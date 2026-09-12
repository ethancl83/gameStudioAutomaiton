// Linux(특히 Ubuntu 24.04+)에서 Electron/Chromium 샌드박스 기동을 진단하고
// 앱 범위로 한정된(전역 비활성화·--no-sandbox 없이) 해결책을 제시한다.
//
// 정상 창 기동을 막는 두 가지 흔한 원인:
//  1) chrome-sandbox가 setuid root(소유자 root, 모드 4755)가 아니다 → SUID 샌드박스 실패.
//  2) kernel.apparmor_restrict_unprivileged_userns=1 → 네임스페이스 샌드박스 차단(Ubuntu 24.04 기본).
//
// 두 해결책 모두 root 권한이 한 번 필요하다(설치/패키징 단계). 앱 바이너리에 한정하며
// 시스템 전역 sysctl을 끄거나 --no-sandbox로 우회하지 않는다.

export interface SandboxProbe {
  // chrome-sandbox 파일 정보. 없으면 null.
  statSandbox: () => Promise<{ mode: number; uid: number } | null>;
  // kernel.apparmor_restrict_unprivileged_userns 값(0/1). 읽을 수 없으면 null.
  readUsernsRestrict: () => Promise<number | null>;
}

export interface SandboxStatus {
  ok: boolean;
  setuidSandbox: { present: boolean; setuidRoot: boolean; detail: string };
  userNamespaces: { restricted: boolean; detail: string };
  recommendation: string | null;
}

export async function inspectLinuxSandbox(probe: SandboxProbe): Promise<SandboxStatus> {
  const stat = await probe.statSandbox();
  const present = stat !== null;
  const setuidRoot = stat !== null && (stat.mode & 0o4000) !== 0 && stat.uid === 0;
  const usernsValue = await probe.readUsernsRestrict();
  const restricted = usernsValue === 1;

  const setuidSandbox = {
    present,
    setuidRoot,
    detail: !present
      ? 'chrome-sandbox 파일을 찾지 못했습니다.'
      : setuidRoot
        ? 'setuid root(4755)로 올바르게 구성되어 있습니다.'
        : 'chrome-sandbox가 setuid root가 아닙니다. SUID 샌드박스가 동작하지 않습니다.',
  };
  const userNamespaces = {
    restricted,
    detail:
      usernsValue === null
        ? 'apparmor_restrict_unprivileged_userns 값을 확인할 수 없습니다.'
        : restricted
          ? 'AppArmor가 비특권 user namespace를 제한합니다(Ubuntu 24.04 기본). 네임스페이스 샌드박스가 차단됩니다.'
          : 'user namespace 제한이 없습니다.',
  };

  // 정상: setuid 샌드박스가 구성돼 있거나, user namespace가 제한되지 않은 경우.
  const ok = setuidRoot || !restricted;
  let recommendation: string | null = null;
  if (!ok) {
    recommendation =
      'chrome-sandbox를 setuid root(chown root:root; chmod 4755)로 설정하거나, 앱 바이너리용 AppArmor 프로필을 설치해 userns를 허용하세요. 두 방법 모두 root 권한이 한 번 필요합니다.';
  }
  return { ok, setuidSandbox, userNamespaces, recommendation };
}

// SUID 샌드박스 구성 명령(패키징/설치 단계에서 root로 1회 실행).
export function sandboxChmodCommands(sandboxPath: string): string[] {
  return [`sudo chown root:root ${JSON.stringify(sandboxPath)}`, `sudo chmod 4755 ${JSON.stringify(sandboxPath)}`];
}

// 앱 바이너리에 user namespace를 허용하는 AppArmor 프로필.
// Ubuntu 24.04가 chromium/chrome/code용으로 배포하는 표준 패턴과 동일하다.
export function renderAppArmorProfile(profileName: string, binaryPath: string): string {
  return `# ${profileName} — 앱 운영 데스크톱 바이너리에 user namespace를 허용한다.
# 설치: sudo install -m 644 이 파일 /etc/apparmor.d/${profileName}
#       sudo apparmor_parser -r /etc/apparmor.d/${profileName}
# 전역 sysctl을 끄지 않고 이 바이너리에만 적용된다.
abi <abi/4.0>,
include <tunables/global>

profile ${profileName} ${binaryPath} flags=(unconfined) {
  userns,

  include if exists <local/${profileName}>
}
`;
}
