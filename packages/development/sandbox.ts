import { createRequire } from "node:module";
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, realpath, writeFile, readFile, copyFile, readdir, rm, stat, chmod } from "node:fs/promises";
import { AppError } from "../domain/errors.js";
import { prepareOpenCodeHome } from './opencode-home.js';
import { quote } from "./process.js";
import type { AgentProvider } from "../agent/types.js";
export function cleanEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
  ])
    if (process.env[key]) result[key] = process.env[key]!;
  result.PATH = `${result.PATH ?? "/usr/bin:/bin"}:/opt/homebrew/bin:/usr/local/bin`;
  result.ELECTRON_RUN_AS_NODE = "1";
  result.TMUX = "";
  result.TMUX_PANE = "";
  return result;
}
export async function sandboxLaunch(input: {
  directory: string;
  worktree: string;
  executable: string;
  args: string[];
  provider?: AgentProvider;
  prompt?: string;
  extraRead?: string[];
  extraDomains?: string[];
  denyRead?: string[];
  sessionId?: string;
  model?: string;
  readonlyPaths?: string[];
}) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new AppError(
      "ISOLATION_UNAVAILABLE",
      "이 실행은 macOS 또는 Linux 격리가 필요합니다.",
    );
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const home = homedir();
  const scratch = await mkdtemp("/tmp/appops-sandbox-");
  const realExecutable = await realpath(input.executable);
  const require = createRequire(import.meta.url);
  const env = cleanEnvironment();
  env.TMPDIR = scratch;
  env.CLAUDE_CODE_TMPDIR = scratch;
  env.TSX_DISABLE_CACHE = "1";
  env.APPOPS_OWNER_PID = String(process.pid);
  env.SSL_CERT_FILE = "/etc/ssl/cert.pem";
  const providerPaths: string[] = [];
  let secrets: string[] = [];
  // Reuse CLI credentials, but never inherit global MCP servers, plugins or hooks.
  const privateConfig = join(input.directory, 'cli');
  if (input.provider) await mkdir(privateConfig, { recursive: true, mode: 0o700 });
  if (input.provider === 'codex') {
    const sourceHome = process.env.CODEX_HOME || join(home, '.codex');
    env.CODEX_HOME = privateConfig;
    providerPaths.push(privateConfig);
    try {
      const auth = join(sourceHome, 'auth.json');
      const target = join(privateConfig, 'auth.json');
      if ((await stat(auth)).mtimeMs > (await stat(target).catch(() => ({ mtimeMs: 0 }))).mtimeMs)
        await copyFile(auth, target);
      await chmod(target, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await rm(join(privateConfig, 'auth.json'), { force: true }); }
    try { const auth=JSON.parse(await readFile(join(privateConfig,'auth.json'),'utf8')); const collect=(v:unknown)=>{if(typeof v==='string'&&v.length>=8)secrets.push(v);else if(v&&typeof v==='object')Object.values(v).forEach(collect);}; collect(auth); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
    let model = '';
    try { model = (await readFile(join(sourceHome, 'config.toml'), 'utf8')).match(/^model\s*=\s*("[^"\n]+")/m)?.[1] ?? ''; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(join(privateConfig, 'config.toml'), `${model ? 'model = ' + model + '\n' : ''}cli_auth_credentials_store = "file"\n[features]\napps = false\nplugins = false\nhooks = false\nbrowser_use = false\ncomputer_use = false\nmulti_agent = false\n`, { mode: 0o600 });
    // Keep pre-existing native conversations resumable without exposing other sessions.
    if (input.sessionId) {
      const sessions = join(sourceHome, 'sessions');
      for (const path of await readdir(sessions, { recursive: true }).catch(() => [] as string[])) {
        if (!path.endsWith(`-${input.sessionId}.jsonl`)) continue;
        const destination = join(privateConfig, 'sessions', path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        try { await copyFile(join(sessions, path), destination, 1); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
    }
  } else if (input.provider === 'opencode') {
    secrets = await prepareOpenCodeHome(privateConfig, realExecutable, env, input.sessionId, input.model);
    providerPaths.push(privateConfig);
  }
  const config = {
    allowPty: true,
    network: {
      strictAllowlist: true,
      allowedDomains: input.provider
        ? [
            "chatgpt.com",
            "*.chatgpt.com",
            "api.openai.com",
            "auth.openai.com",
            "api.anthropic.com",
            "generativelanguage.googleapis.com",
            "oauth2.googleapis.com",
            "openrouter.ai",
            "opencode.ai",
            "models.dev",
            ...(input.extraDomains ?? []),
          ]
        : (input.extraDomains ?? []),
      deniedDomains: [
        "github.com",
        "*.github.com",
        "netlify.com",
        "*.netlify.com",
        "vercel.com",
        "*.vercel.com",
      ],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [
        home,
        tmpdir(),
        "/tmp",
        "/private/tmp",
        "**/.env",
        "**/.env.*",
        "**/client_secret_*.json",
        ...(input.denyRead ?? []),
      ],
      allowRead: [
        input.worktree,
        dirname(realExecutable),
        dirname(await realpath(process.execPath)),
        ...(input.provider === "codex" ? [dirname(dirname(dirname(realExecutable)))] : []),
        ...providerPaths,
        ...(input.extraRead ?? []),
      ],
      allowWrite: [input.worktree, scratch, ...providerPaths],
      denyWrite: [
        ...(input.readonlyPaths ?? []),
        join(input.worktree, ".git"),
        join(home, ".codex/config.toml"),
        join(home, ".codex/AGENTS.md"),
        join(home, ".codex/skills"),
        join(home, ".codex/plugins"),
        join(home, ".config/opencode"),
        join(home, ".opencode"),
      ],
    },
  };
  const configFile = join(input.directory, "sandbox.json");
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  // All shell fragments are generated here from argument arrays. No issue text is shell code.
  let line = [quote(realExecutable), ...input.args.map(quote)].join(" ");
  if (input.prompt !== undefined) {
    const promptFile = join(input.directory, "prompt.txt");
    await writeFile(promptFile, input.prompt, { mode: 0o600 });
    config.filesystem.allowRead.push(promptFile);
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    line += ` < ${quote(promptFile)}`;
  }
  return {
    file: process.execPath,
    args: import.meta.url.endsWith('.ts') ? ['--import', require.resolve('tsx'), fileURLToPath(new URL('./sandbox-runner.ts', import.meta.url)), configFile, line] : [fileURLToPath(new URL('./sandbox-runner.js', import.meta.url)), configFile, line],
    env,
    secrets,
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}
