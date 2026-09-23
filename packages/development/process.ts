import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError, redact } from "../domain/errors.js";
import { pathLookup } from "../engines/which.js";
import type { StudioTool } from "./types.js";
const names: Record<StudioTool | "git" | "tmux", string> = {
  codex: "codex",
  opencode: "opencode",
  github: "gh",
  netlify: "netlify",
  vercel: "vercel",
  git: "git",
  tmux: "tmux",
};
export const managedCliRoot = join(homedir(), '.local/share/appops/cli');
export async function executable(
  tool: keyof typeof names,
): Promise<string | null> {
  return pathLookup(
    [names[tool]],
    [
      join(managedCliRoot, 'node_modules/.bin'),
      join(homedir(), ".bun/bin"),
      join(homedir(), ".local/bin"),
      join(homedir(), ".opencode/bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
    ],
  );
}
export async function requireTool(tool: keyof typeof names): Promise<string> {
  const path = await executable(tool);
  if (!path)
    throw new AppError(
      tool === 'tmux' ? 'TERMINAL_HOST_MISSING' : "TOOL_MISSING",
      `${names[tool]} CLI를 설치한 뒤 다시 검사해 주세요.`,
    );
  return path;
}
export function command(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    signal?: AbortSignal;
    input?: string | Uint8Array;
    maxBytes?: number;
    includeStderr?: boolean;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let error = "";
    let bytes = 0;
    let failure: Error | undefined;
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const stop = () => {
      failure ??= new AppError("CANCELLED", "작업이 중지되었습니다.");
      kill();
    };
    const timer = setTimeout(() => {
      failure = new AppError("TIMEOUT", "CLI 응답 시간이 초과되었습니다.");
      kill();
    }, options.timeout ?? 30_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) stop();
    const read = (data: Buffer, stderr: boolean) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) {
        failure = new AppError("OUTPUT_LIMIT", "CLI 출력 한도를 초과했습니다.");
        kill();
        return;
      }
      if (stderr) error += data.toString();
      else output += data.toString();
    };
    child.stdout.on("data", (data) => read(data, false));
    child.stderr.on("data", (data) => read(data, true));
    child.once("error", (value) => {
      failure = value;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new AppError(
            "CLI_FAILED",
            redact([error, output].filter(Boolean).join("\n") || `CLI 종료 코드: ${code}`).slice(-4000),
          ),
        );
      else resolve(options.includeStderr ? output + "\n" + error : output);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
export const quote = (value: string) =>
  "'" + value.replace(/'/g, "'\\''") + "'";
