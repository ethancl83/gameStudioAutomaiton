import { command, executable, requireTool } from "./process.js";
import type { CliConnection, StudioTool } from "./types.js";
import type { StudioTerminals } from "./terminal.js";
export const STUDIO_TOOLS: StudioTool[] = [
  "codex",
  "opencode",
  "github",
  "netlify",
  "vercel",
];
const probes: Record<StudioTool, string[]> = {
  codex: ["login", "status"],
  opencode: ["auth", "list"],
  github: ["api", "user", "--jq", ".login"],
  netlify: ["status", "--json"],
  vercel: ["whoami"],
};
const logins: Record<StudioTool, string[]> = {
  codex: ["login"],
  opencode: ["auth", "login"],
  github: [
    "auth",
    "login",
    "--hostname",
    "github.com",
    "--git-protocol",
    "https",
    "--web",
    "--skip-ssh-key",
  ],
  netlify: ["login"],
  vercel: ["login"],
};
export async function connection(
  tool: StudioTool,
  check = false,
): Promise<CliConnection> {
  const file = await executable(tool);
  if (!file)
    return {
      tool,
      executable: null,
      status: "missing",
      message: "CLI 설치가 필요합니다.",
    };
  if (!check)
    return {
      tool,
      executable: file,
      status: "unchecked",
      message: "설치됨 · 연결 검사를 실행하세요.",
    };
  try {
    const result = await command(file, probes[tool], {
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 15000,
      includeStderr: true,
    });
    const empty =
      tool === "opencode" &&
      /0 credentials|0 자격|no credentials/i.test(result);
    return {
      tool,
      executable: file,
      status: empty ? "login_required" : "connected",
      message: empty
        ? "로그인이 필요합니다."
        : "CLI 인증 검사를 통과했습니다. 모델/저장소별 접근 권한은 실행 시 확인합니다.",
    };
  } catch {
    return {
      tool,
      executable: file,
      status: "login_required",
      message: "로그인 또는 연결 상태를 확인해 주세요.",
    };
  }
}
export async function login(
  tool: StudioTool,
  terminals: StudioTerminals,
  cwd: string,
) {
  return terminals.open(
    `${tool} 로그인`,
    cwd,
    await requireTool(tool),
    logins[tool],
  );
}

const packages: Partial<Record<StudioTool, string>> = {
  codex: '@openai/codex@0.156.1', opencode: 'opencode-ai@1.18.32',
  netlify: 'netlify-cli@27.8.1', vercel: 'vercel@59.25.4',
};
export async function install(tool: StudioTool, terminals: StudioTerminals, cwd: string) {
  const { pathLookup } = await import('../engines/which.js');
  const { managedCliRoot } = await import('./process.js');
  if (tool === 'github') {
    const brew = await pathLookup(['brew'], ['/opt/homebrew/bin','/usr/local/bin']);
    if (!brew) throw new (await import('../domain/errors.js')).AppError('INSTALL_REQUIRED', 'GitHub CLI(gh)는 공식 패키지 관리자로 설치해 주세요.');
    return terminals.open('GitHub CLI 설치', cwd, brew, ['install','gh']);
  }
  const npm = await pathLookup(['npm'], ['/opt/homebrew/bin','/usr/local/bin']);
  if (!npm) throw new (await import('../domain/errors.js')).AppError('INSTALL_REQUIRED', 'Node.js LTS를 먼저 설치해 주세요.');
  return terminals.open(`${tool} CLI 설치`, cwd, npm, ['install','--prefix',managedCliRoot,'--no-audit','--no-fund',packages[tool]!]);
}
export async function models(tool: 'codex' | 'opencode'): Promise<string[]> {
  if (tool === 'opencode') return (await command(await requireTool(tool), ['models'], { timeout: 30000 })).split(/\r?\n/).filter(v => /^[\w.-]+\/[\w.:@/-]+$/.test(v)).sort();
  const { readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  try {
    const cache = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    return (cache.models ?? []).map((m: {slug?: string}) => m.slug).filter((v: unknown) => typeof v === 'string');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function logout(tool: StudioTool, terminals: StudioTerminals, cwd: string) {
  const args: Record<StudioTool, string[]> = { codex: ['logout'], opencode: ['auth','logout'], github: ['auth','logout','--hostname','github.com'], netlify: ['logout'], vercel: ['logout'] };
  return terminals.open(`${tool} 로그아웃`, cwd, await requireTool(tool), args[tool]);
}
