import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AppError } from '../domain/errors.js';
import { cliEvent } from './cli.js';
import { sandboxLaunch } from '../development/sandbox.js';
import type { AgentProvider } from './types.js';

export interface StructuredCliInput {
  provider: AgentProvider; executable: string; model?: string;
  prompt: string; signal: AbortSignal; timeoutMs?: number;
  /** 모델이 읽으면 안 되는 운영 데이터·보관함 경로. */
  denyRead: string[];
}

/**
 * 고객응대 분류·초안용 1회성 CLI 호출. 외부 게시물은 비신뢰 입력이므로 MCP 도구·네트워크 쓰기·
 * 대화 세션 재사용 없이 OS 격리 안에서 실행하고 마지막 assistant 메시지만 반환한다.
 * 결과는 호출자가 구조화 스키마로 다시 검증하며, 이 함수의 출력은 권한이 아니다.
 */
export async function runStructuredCli(input: StructuredCliInput): Promise<string> {
  input.signal.throwIfAborted();
  const workspace = await mkdtemp(join(tmpdir(), 'appops-community-'));
  const args = input.provider === 'codex'
    ? ['exec', ...(input.model ? ['--model', input.model] : []), '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', workspace,
      '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '-c', 'features.multi_agent=false', '-c', 'tools.web_search=false', '-']
    : ['run', '--pure', ...(input.model ? ['--model', input.model] : []), '--format', 'json', '--dir', workspace];
  const opencodeConfig = JSON.stringify({ share: 'disabled', mcp: {}, permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', question: 'deny' } });
  let launch: Awaited<ReturnType<typeof sandboxLaunch>> | undefined;
  try {
    launch = await sandboxLaunch({ directory: join(workspace, '.control'), worktree: workspace, executable: input.executable, args, provider: input.provider, denyRead: input.denyRead, model: input.model });
    const env = { ...launch.env, ...(input.provider === 'opencode' ? { OPENCODE_CONFIG_CONTENT: opencodeConfig, OPENCODE_AUTO_SHARE: 'false' } : {}) };
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(launch!.file, launch!.args, { cwd: workspace, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
      const decoder = new StringDecoder('utf8');
      let buffer = ''; let last = ''; let bytes = 0; let failure: AppError | undefined;
      const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* exited */ } };
      const timer = setTimeout(() => { failure = new AppError('AGENT_TIMEOUT', '고객응대 분류 AI 응답 시간이 초과되었습니다.'); kill(); }, input.timeoutMs ?? 120_000);
      const abort = () => { failure = new AppError('AGENT_CANCELLED', '고객응대 분류를 중지했습니다.'); kill(); };
      input.signal.addEventListener('abort', abort, { once: true });
      const line = (value: string) => {
        const event = cliEvent(input.provider, value);
        if (event.message) last = event.message;
        if (event.failed) failure ??= new AppError('AGENT_CLI_FAILED', `${input.provider}가 분류 요청을 완료하지 못했습니다. CLI 로그인·모델 설정을 확인해 주세요.`);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) { failure ??= new AppError('AGENT_OUTPUT_LIMIT', '분류 AI 출력이 한도를 넘었습니다.'); kill(); return; }
        buffer += decoder.write(chunk);
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      });
      child.once('error', () => { failure ??= new AppError('AGENT_START_FAILED', `${input.provider} CLI를 시작하지 못했습니다.`); });
      child.once('close', code => {
        line(buffer + decoder.end());
        clearTimeout(timer); input.signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new AppError('AGENT_CLI_FAILED', `${input.provider} CLI가 종료 코드 ${code ?? 'unknown'}로 중단되었습니다.`));
        else if (!last) reject(new AppError('AGENT_EMPTY_RESULT', '분류 AI가 결과를 반환하지 않았습니다.'));
        else resolve(last);
      });
      child.stdin.on('error', () => { /* close에서 처리 */ });
      child.stdin.end(input.prompt);
    });
  } finally {
    await launch?.cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
}
