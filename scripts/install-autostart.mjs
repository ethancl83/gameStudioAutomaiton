// 사용자별 로그인 자동 시작 설치/상태/제거 CLI.
// packages/lifecycle의 관리자 함수를 실제 OS(현재 사용자)에 적용한다. root 권한이 필요 없다.
//
// 실행(TS 패키지를 사용하므로 tsx 필요):
//   node --import tsx scripts/install-autostart.mjs [명령] [옵션]
// 명령: --status(기본) | --enable | --disable
// 옵션:
//   --method <systemd-user|xdg-autostart|launchagent|schtasks>  (기본: OS 표준)
//   --program <절대경로>   로그인 시 실행할 앱 바이너리(기본: 이 Node 실행 파일 — 데모/개발용)
//   --entry <절대경로>     ELECTRON_RUN_AS_NODE로 구동할 제어 서비스 진입점(program이 Node일 때)
//   --data-dir <경로>      고정 데이터 디렉터리(APPOPS_DATA_DIR)
//   --dry-run              실제 호스트 대신 임시 디렉터리에 생성해 결과만 출력(QA 안전)
//
// 주의: --enable은 실제 로그인 자동 시작을 켠다. QA 중에는 --dry-run 또는 --status만 사용한다.

import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildControllerAutostartTarget,
  defaultAutostartMethod,
  getAutostartStatus,
  installAutostart,
  removeAutostart,
} from '../packages/lifecycle/index.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const command = has('--enable') ? 'enable' : has('--disable') ? 'disable' : 'status';
const method = arg('--method', defaultAutostartMethod(process.platform));
const program = arg('--program', process.execPath);
const entry = arg('--entry', join(process.cwd(), 'dist', 'apps', 'controller', 'main.js'));
const dataDir = arg('--data-dir', process.env.APPOPS_DATA_DIR);
const dryRun = has('--dry-run');

const runner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr || String(err) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

const realFs = { readFile, writeFile, mkdir, rm, access };

const target = buildControllerAutostartTarget({
  program,
  controllerEntry: entry,
  dataDir,
  // program이 Node 실행 파일이면 ELECTRON_RUN_AS_NODE로 진입점을 구동한다.
  runAsNode: program === process.execPath,
});

let deps;
let sandboxDir;
if (dryRun) {
  sandboxDir = await mkdtemp(join(tmpdir(), 'appops-autostart-dryrun-'));
  deps = { fs: realFs, runner: async (c, a) => ({ code: 0, stdout: c === 'systemctl' && a.includes('is-enabled') ? 'enabled\n' : '', stderr: '' }), configHome: sandboxDir, launchAgentsDir: sandboxDir };
  process.stdout.write(`[dry-run] 임시 디렉터리에 생성: ${sandboxDir}\n`);
} else {
  deps = {
    fs: realFs,
    runner,
    configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    launchAgentsDir: join(homedir(), 'Library', 'LaunchAgents'),
  };
}

try {
  let status;
  if (command === 'enable') status = await installAutostart(method, target, deps);
  else if (command === 'disable') status = await removeAutostart(method, target, deps);
  else status = await getAutostartStatus(method, target, deps);
  process.stdout.write(`${command}: ${JSON.stringify(status, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`실패: ${err?.message ?? err}\n`);
  process.exitCode = 1;
} finally {
  if (sandboxDir) await rm(sandboxDir, { recursive: true, force: true });
}
