import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathLookup } from '../engines/which.js';
import { AppError } from '../domain/errors.js';
import type { AgentProvider, AgentRuntime } from './types.js';

export async function discoverAgentRuntimes(): Promise<AgentRuntime[]> {
  const dirs = [join(homedir(), '.bun/bin'), join(homedir(), '.local/bin'), join(homedir(), '.opencode/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return Promise.all((['codex', 'opencode'] as const).map(async provider => ({
    provider, executable: await pathLookup(process.platform === 'win32' ? [provider + '.exe', provider] : [provider], dirs),
  })));
}

export interface AgentInvocation {
  provider: AgentProvider;
  executable: string;
  directory: string;
  prompt: string;
  endpoint: string;
  token: string;
  bridgeCommand: string[];
  signal: AbortSignal;
  sessionId?: string;
  onSessionId?: (id: string) => void;
  onMessage?: (message: string) => void;
}

export function cliCommand(input: AgentInvocation): { args: string[]; env: NodeJS.ProcessEnv } {
  if (input.sessionId && !validSessionId(input.provider, input.sessionId)) throw new AppError('AGENT_SESSION_INVALID', '저장된 CLI 세션 ID 형식을 확인할 수 없습니다. 클리어하면 새 대화를 시작할 수 있습니다.');
  const env: NodeJS.ProcessEnv = { ...process.env, APPOPS_AGENT_ENDPOINT: input.endpoint, APPOPS_AGENT_TOKEN: input.token };
  // Tokens are inherited by the private MCP process, never interpolated into argv or prompts.
  if (input.provider === 'codex') return {
    args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', input.directory,
      '-c', 'approval_policy="never"',
      '-c', `mcp_servers.appops.command=${JSON.stringify(input.bridgeCommand[0])}`,
      '-c', `mcp_servers.appops.args=${JSON.stringify(input.bridgeCommand.slice(1))}`,
      '-c', 'mcp_servers.appops.env_vars=["APPOPS_AGENT_ENDPOINT","APPOPS_AGENT_TOKEN"]',
      '-c', 'mcp_servers.appops.env.ELECTRON_RUN_AS_NODE="1"',
      '-c', 'mcp_servers.appops.required=true', '-c', 'mcp_servers.appops.tool_timeout_sec=120',
      ...(input.sessionId ? ['resume', input.sessionId] : []), '-'], env,
  };
  let previous: Record<string, unknown> = {};
  if (env.OPENCODE_CONFIG_CONTENT) {
    try { previous = JSON.parse(env.OPENCODE_CONFIG_CONTENT); }
    catch { throw new AppError('AGENT_CONFIG_INVALID', 'OpenCode의 기존 인라인 설정을 읽을 수 없습니다. CLI 설정을 확인해 주세요.'); }
  }
  return {
    args: ['run', '--format', 'json', '--dir', input.directory, ...(input.sessionId ? ['--session', input.sessionId] : [])],
    env: { ...env, OPENCODE_AUTO_SHARE: 'false', OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...previous, share: 'disabled',
      permission: { ...(typeof previous.permission === 'object' ? previous.permission : {}), 'appops_*': 'allow', question: 'deny' },
      mcp: { ...(typeof previous.mcp === 'object' ? previous.mcp : {}), appops: { type: 'local', command: input.bridgeCommand, enabled: true,
        environment: { ELECTRON_RUN_AS_NODE: '1' } } },
    }) },
  };
}

/** Parse only native session IDs and assistant text, never reasoning or raw tool/stderr output. */
function validSessionId(provider: AgentProvider, id: string) {
  return provider === 'codex' ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) : /^ses_[a-zA-Z0-9]{1,140}$/.test(id);
}
export function cliEvent(provider: AgentProvider, line: string): { sessionId?: string; message?: string; failed?: boolean } {
  let event;
  try { event = JSON.parse(line); } catch { return {}; }
  if (!event || typeof event !== 'object') return {};
  const id = provider === 'codex' ? event.type === 'thread.started' ? event.thread_id : undefined : event.sessionID;
  const message = provider === 'codex'
    ? event.type === 'item.completed' && event.item?.type === 'agent_message' ? event.item.text : undefined
    : event.type === 'text' && event.part?.type === 'text' ? event.part.text : undefined;
  return { sessionId: typeof id === 'string' && validSessionId(provider, id) ? id : undefined,
    message: typeof message === 'string' && message.trim() ? message : undefined,
    failed: event.type === 'turn.failed' || event.type === 'error' };
}

export async function runAgentCli(input: AgentInvocation): Promise<void> {
  input.signal.throwIfAborted();
  const { args, env } = cliCommand(input);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.executable, args, { cwd: input.directory, env, shell: false,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let outputBytes = 0;
    let failure: AppError | undefined;
    let sessionId = input.sessionId;
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(() => kill('SIGKILL'), 2000); };
    const timeout = setTimeout(() => { failure = new AppError('AGENT_TIMEOUT', 'AI 작업 시간이 초과되었습니다. 저장된 결과부터 이어서 진행할 수 있습니다.'); stop(); }, 20 * 60_000);
    const consume = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 32 * 1024 * 1024 && !failure) { failure = new AppError('AGENT_OUTPUT_LIMIT', 'CLI 출력 한도를 초과했습니다. 진행 기록을 확인하고 재개해 주세요.'); stop(); }
    };
    const line = (value: string) => {
      if (failure || input.signal.aborted) return;
      try {
        const event = cliEvent(input.provider, value);
        if (event.sessionId) {
          if (sessionId && sessionId !== event.sessionId) throw new AppError('AGENT_SESSION_MISMATCH', 'CLI가 다른 세션을 반환했습니다. 기존 대화를 유지하고 실행을 중단합니다.');
          if (!sessionId) { sessionId = event.sessionId; input.onSessionId?.(sessionId); }
        }
        if (event.message) input.onMessage?.(event.message.split(input.token).join('[비공개]'));
        if (event.failed) throw new AppError('AGENT_CLI_FAILED', `${input.provider}가 요청을 완료하지 못했습니다. CLI 로그인·모델·권한 설정을 확인한 뒤 같은 대화에서 재요청해 주세요.`);
      } catch (error) { failure = error instanceof AppError ? error : new AppError('AGENT_EVENT_FAILED', 'AI 대화 기록을 저장하지 못했습니다.'); stop(); }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      consume(chunk); if (failure) return;
      buffer += decoder.write(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.on('data', consume);
    input.signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); input.signal.removeEventListener('abort', stop); kill('SIGKILL'); };
    child.once('error', () => { cleanup(); reject(new AppError('AGENT_START_FAILED', `${input.provider} CLI를 시작하지 못했습니다. 설치 경로와 실행 권한을 확인해 주세요.`)); });
    // A helper inheriting stdio must not keep this turn alive after the CLI itself exits.
    child.once('exit', () => kill('SIGKILL'));
    child.once('close', code => {
      line(buffer + decoder.end());
      cleanup();
      if (input.signal.aborted) reject(new AppError('AGENT_CANCELLED', 'AI 작업을 중지했습니다.'));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new AppError('AGENT_CLI_FAILED', `${input.provider} CLI가 종료 코드 ${code ?? 'unknown'}로 중단되었습니다. 해당 CLI의 로그인·모델·권한 설정을 확인한 뒤 이어서 진행해 주세요.`));
      else if (!sessionId) reject(new AppError('AGENT_SESSION_MISSING', 'CLI 세션 ID를 받지 못했습니다. 대화를 클리어하기 전에는 새 세션을 만들지 않습니다.'));
      else resolve();
    });
    child.stdin.on('error', () => { /* early CLI exit is handled by close */ });
    child.stdin.end(input.prompt);
    if (input.signal.aborted) stop();
  });
}
