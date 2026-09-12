// Linux Electron/Chromium 샌드박스 기동 진단 및 앱 범위 해결책 출력.
// 이 스크립트는 절대 sudo를 실행하지 않는다 — root가 검토·실행할 명령과 AppArmor 프로필만 출력한다.
// 전역 sysctl 비활성화나 --no-sandbox를 권하지 않는다.
//
// 실행(TS 패키지 사용, tsx 필요):
//   node --import tsx scripts/install-sandbox.mjs [--binary <앱 바이너리 경로>] [--out <AppArmor 프로필 저장 경로>]

import { stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inspectLinuxSandbox, renderAppArmorProfile, sandboxChmodCommands } from '../packages/lifecycle/index.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

if (process.platform !== 'linux') {
  process.stdout.write('이 스크립트는 Linux 전용입니다. 현재 OS에서는 별도 조치가 필요 없습니다.\n');
  process.exit(0);
}

const binary = arg('--binary', process.execPath);
const sandboxPath = join(dirname(binary), 'chrome-sandbox');
const profileName = 'appops-desktop';

const status = await inspectLinuxSandbox({
  statSandbox: async () => {
    try {
      const s = await stat(sandboxPath);
      return { mode: s.mode, uid: s.uid };
    } catch {
      return null;
    }
  },
  readUsernsRestrict: async () => {
    try {
      const raw = await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8');
      const v = Number(raw.trim());
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  },
});

process.stdout.write('== Linux 샌드박스 진단 ==\n');
process.stdout.write(`앱 바이너리: ${binary}\n`);
process.stdout.write(`chrome-sandbox: ${sandboxPath}\n`);
process.stdout.write(`  ${status.setuidSandbox.detail}\n`);
process.stdout.write(`user namespace: ${status.userNamespaces.detail}\n`);
process.stdout.write(`판정: ${status.ok ? '정상 (네이티브 창 기동 가능)' : '조치 필요'}\n\n`);

if (status.ok) process.exit(0);

process.stdout.write('권장: ' + status.recommendation + '\n\n');
process.stdout.write('== 방법 A: setuid 샌드박스 (deb/rpm 설치 시 postinst가 자동 처리) ==\n');
process.stdout.write('root로 1회 실행:\n');
for (const cmd of sandboxChmodCommands(sandboxPath)) process.stdout.write('  ' + cmd + '\n');

process.stdout.write('\n== 방법 B: 앱 전용 AppArmor 프로필 (전역 설정 변경 없음) ==\n');
const profile = renderAppArmorProfile(profileName, binary);
const out = arg('--out', null);
if (out) {
  await writeFile(out, profile);
  process.stdout.write(`프로필을 저장했습니다: ${out}\n`);
  process.stdout.write(`root로 1회 실행:\n  sudo install -m 644 ${out} /etc/apparmor.d/${profileName}\n  sudo apparmor_parser -r /etc/apparmor.d/${profileName}\n`);
} else {
  process.stdout.write(`아래 내용을 /etc/apparmor.d/${profileName}에 저장하고 root로 로드하세요.\n`);
  process.stdout.write('--- 8< ---\n' + profile + '--- >8 ---\n');
  process.stdout.write(`  sudo apparmor_parser -r /etc/apparmor.d/${profileName}\n`);
}
process.stdout.write('\n두 방법 중 하나면 충분합니다. 시스템 전역 sysctl을 끄거나 --no-sandbox를 쓰지 마세요.\n');
