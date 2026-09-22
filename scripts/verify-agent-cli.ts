// 기본 진단 전용. 로그인·모델 호출·live 모드는 없다.
// CLI 종료 코드 0은 생성된 argv의 도움말 수락만 뜻한다. 모델 호출 횟수는 세지 않는다.
// Codex 도움말은 stdout, OpenCode 도움말은 stderr에 나온다.
// 기본 로그는 tmp/agent-cli-20260922/report.json 이며 재실행하면 이 증거 파일을 덮어쓴다.
// 같은 진단을 다른 기록으로 남길 때는 runVerification({ logDir })로 경로를 분리한다.
// 실행: node --import tsx scripts/verify-agent-cli.ts
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { cliCommand, discoverAgentRuntimes } from '../packages/agent/cli.js';
import type { AgentProvider } from '../packages/agent/types.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
export const PROMPT_FIXTURE = 'appops-cli-verify-fixture';
export const FIXTURE_SESSION = {
  codex: '11111111-1111-4111-8111-111111111111',
  opencode: 'ses_verifyfixture0001',
} as const;
export const OUTPUT_CAP = 256 * 1024;
export const EVIDENCE_LOG_DIR = 'tmp/agent-cli-20260922';
const DIAGNOSTIC_TOKEN = 'diagnostic-bridge-token';

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  capped: boolean;
}

export interface Check {
  name: string;
  ok: boolean;
  code: string;
  detail: string;
  argv?: string[];
}

export interface VerificationReport {
  mode: 'no-model';
  llmResponseChecked: false;
  loginChecked: false;
  ok: boolean;
  promptFixture: string;
  logDir: string | null;
  providers: Array<{ provider: AgentProvider; executable: string | null; checks: Check[] }>;
  mcp: Check;
}

export function parseArgs(argv: string[]): { ok: true } | { ok: false; detail: string } {
  if (argv.length) return { ok: false, detail: `알 수 없는 인자: ${argv.join(' ')}` };
  return { ok: true };
}

export function productArgs(provider: AgentProvider, kind: 'new' | 'resume', directory: string): string[] {
  const saved = process.env.OPENCODE_CONFIG_CONTENT;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  try {
    return cliCommand({
      provider, executable: provider, directory, prompt: PROMPT_FIXTURE,
      endpoint: 'http://127.0.0.1:9/', token: DIAGNOSTIC_TOKEN,
      bridgeCommand: [process.execPath, '-e', 'process.exit(0)'],
      signal: new AbortController().signal,
      sessionId: kind === 'resume' ? FIXTURE_SESSION[provider] : undefined,
    }).args;
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
    else process.env.OPENCODE_CONFIG_CONTENT = saved;
  }
}

export function helpArgv(args: string[]): string[] {
  return [...args, '--help'];
}

export function redact(value: string, secrets: string[]): string {
  return secrets.reduce((text, secret) => secret ? text.split(secret).join('[비공개]') : text, value);
}

export function redactArgv(args: string[], secrets: string[]): string[] {
  return args.map(arg => redact(arg, secrets));
}

/** null이면 제품 argv 형태가 진단 계약과 맞다. */
export function argvShapeError(provider: AgentProvider, kind: 'new' | 'resume', args: string[]): string | null {
  if (args.at(-1) !== '--help') return 'help flag missing';
  const product = args.slice(0, -1);
  if (product.join('\n').includes(DIAGNOSTIC_TOKEN)) return 'token in argv';
  if (provider === 'codex') {
    if (product[0] !== 'exec' || product.at(-1) !== '-') return 'codex stdin marker missing';
    if (!product.includes('--json') || !product.includes('--skip-git-repo-check') || !product.includes('workspace-write')) return 'codex flags missing';
    if (product.includes('--ephemeral') || product.includes('--last')) return 'codex forbidden flag';
    const resumeAt = product.indexOf('resume');
    if (kind === 'resume') {
      if (resumeAt < 0 || product[resumeAt + 1] !== FIXTURE_SESSION.codex) return 'codex resume id missing';
    } else if (resumeAt >= 0) return 'codex new argv resumes';
    return null;
  }
  if (product[0] !== 'run' || !product.includes('--format') || !product.includes('--dir')) return 'opencode flags missing';
  if (product.includes('--continue') || product.includes('--last')) return 'opencode forbidden flag';
  const sessionAt = product.indexOf('--session');
  if (kind === 'resume') {
    if (sessionAt < 0 || product[sessionAt + 1] !== FIXTURE_SESSION.opencode) return 'opencode session id missing';
  } else if (sessionAt >= 0) return 'opencode new argv resumes';
  return null;
}

export function hasModelEvent(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; sessionID?: string; thread_id?: string };
      if (!event || typeof event !== 'object') continue;
      if (typeof event.sessionID === 'string' || typeof event.thread_id === 'string') return true;
      if (event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'step_start' || event.type === 'text') return true;
    } catch { /* 도움말 본문의 중괄호는 이벤트가 아니다. */ }
  }
  return false;
}

export function acceptVersion(provider: AgentProvider, stdout: string, stderr: string, code: number | null): Check {
  const text = `${stdout}\n${stderr}`;
  const version = provider === 'codex' ? text.match(/codex-cli\s+(\d+\.\d+\.\d+)/)?.[1] : text.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (code !== 0 || !version) return { name: 'version', ok: false, code: 'version-missing', detail: `${provider} 버전을 확인하지 못했습니다.` };
  return { name: 'version', ok: true, code: 'version-ok', detail: `${provider} ${version}` };
}

export function acceptHelp(provider: AgentProvider, stdout: string, stderr: string, code: number | null, timedOut = false, capped = false): Check {
  if (capped) return { name: 'help', ok: false, code: 'output-cap', detail: `${provider} 도움말 출력이 한도를 넘었습니다.` };
  if (timedOut) return { name: 'help', ok: false, code: 'timeout', detail: `${provider} 도움말 확인 시간이 초과되었습니다.` };
  if (hasModelEvent(stdout) || hasModelEvent(stderr)) return { name: 'help', ok: false, code: 'model-event', detail: `${provider} 도움말 확인 중 모델 이벤트가 보여 수락으로 보지 않습니다.` };
  if (code !== 0) return { name: 'help', ok: false, code: 'exit-failed', detail: `${provider} 도움말이 종료 코드 ${code ?? 'unknown'}로 끝났습니다.` };
  if (provider === 'codex') {
    if (!/Usage:/i.test(stdout) || !/\bexec\b/.test(stdout)) return { name: 'help', ok: false, code: 'help-missing', detail: 'Codex 도움말이 stdout에 없습니다.' };
    return { name: 'help', ok: true, code: 'help-ok', detail: 'Codex 도움말이 stdout에 있습니다.' };
  }
  const combined = `${stdout}\n${stderr}`;
  if (!/opencode run/.test(combined) || !/--format/.test(combined) || !/--session/.test(combined)) {
    return { name: 'help', ok: false, code: 'help-missing', detail: 'OpenCode 도움말이 stdout/stderr에 없습니다.' };
  }
  return { name: 'help', ok: true, code: 'help-ok', detail: 'OpenCode 도움말을 stdout/stderr에서 확인했습니다.' };
}

function killProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* 이미 종료됨 */ }
}

export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG || 'C',
    HOME: home, CODEX_HOME: join(home, 'codex'),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
}

export async function runProcess(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let capped = false;
    let settled = false;
    const finish = (result: ProcessResult) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const cap = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString('utf8');
      if (next.length > OUTPUT_CAP) { capped = true; killProcess(child, 'SIGKILL'); return current; }
      return next;
    };
    const timer = setTimeout(() => { timedOut = true; killProcess(child, 'SIGKILL'); }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout = cap(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = cap(stderr, chunk); });
    child.stdin.on('error', () => { /* 조기 종료는 close에서 처리한다. */ });
    child.once('error', error => finish({ code: null, signal: null, stdout, stderr: error.message, timedOut, capped }));
    child.once('close', (code, signal) => finish({ code, signal, stdout, stderr, timedOut, capped }));
    child.stdin.end(options.stdin ?? '');
  });
}

export function listenLoopback(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('loopback port missing'));
      else resolve(address.port);
    });
  });
}

export async function discardDiagnosticDirs(home?: string, work?: string): Promise<void> {
  if (home) await rm(home, { recursive: true, force: true });
  if (work) await rm(work, { recursive: true, force: true });
}

export async function verifyMcpBoundary(timeoutMs = 10_000): Promise<Check> {
  const token = randomBytes(16).toString('hex');
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const expected = `Bearer ${token}`;
      if (request.method !== 'POST' || request.url !== '/' || request.headers.authorization !== expected) {
        response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'fixture' } })); return;
      }
      let name = '';
      try { name = String(JSON.parse(Buffer.concat(chunks).toString('utf8')).name ?? ''); } catch { name = ''; }
      if (name === 'context') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ fixture: 'read-only', projects: [] }));
        return;
      }
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'READ_ONLY', message: 'fixture rejects mutations' } }));
    });
  });
  let port: number;
  try { port = await listenLoopback(server); }
  catch (error) { server.close(); throw error; }
  const endpoint = `http://127.0.0.1:${port}/`;
  const bridge = [process.execPath, '--import', require.resolve('tsx'), fileURLToPath(new URL('../packages/agent/mcp.ts', import.meta.url))];
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'appops-verify', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'store_action', arguments: {} } },
  ].map(message => JSON.stringify(message)).join('\n') + '\n';
  try {
    const result = await runProcess(bridge[0]!, bridge.slice(1), {
      cwd: root, stdin: messages, timeoutMs,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'C', APPOPS_AGENT_ENDPOINT: endpoint, APPOPS_AGENT_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' },
    });
    const output = result.stdout + result.stderr;
    if (output.includes(token)) return { name: 'mcp', ok: false, code: 'mcp-failed', detail: 'MCP 응답에 브리지 토큰이 포함되었습니다.' };
    if (result.timedOut || result.code !== 0) return { name: 'mcp', ok: false, code: result.timedOut ? 'timeout' : 'mcp-failed', detail: 'MCP 브리지가 진단 시간 안에 정상 종료되지 않았습니다.' };
    const replies = result.stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as { result?: { serverInfo?: { name?: string }; tools?: Array<{ name?: string }>; isError?: boolean; content?: Array<{ text?: string }> } });
    const tools = replies[1]?.result?.tools?.map(tool => tool.name) ?? [];
    const readText = replies[2]?.result?.content?.[0]?.text ?? '';
    const read = !replies[2]?.result?.isError && readText.includes('"fixture":"read-only"');
    const writeRejected = replies[3]?.result?.isError === true && (replies[3]?.result?.content?.[0]?.text ?? '').includes('READ_ONLY');
    const ok = replies[0]?.result?.serverInfo?.name === 'appops' && tools.includes('context') && tools.includes('store_action') && read && writeRejected;
    return { name: 'mcp', ok, code: ok ? 'mcp-ok' : 'mcp-failed', detail: ok ? 'MCP initialize, tools/list, 읽기 호출과 쓰기 거부를 확인했습니다.' : 'MCP initialize/tools/list/call 경계가 기대와 다릅니다.' };
  } catch {
    return { name: 'mcp', ok: false, code: 'mcp-failed', detail: 'MCP 브리지 응답을 해석하지 못했습니다.' };
  } finally {
    server.close();
  }
}

export async function runVerification(options: { timeoutMs?: number; logDir?: string | null } = {}): Promise<VerificationReport> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let home: string | undefined;
  let work: string | undefined;
  try {
    home = await mkdtemp(join(tmpdir(), 'appops-cli-home-'));
    work = await mkdtemp(join(tmpdir(), 'appops-cli-work-'));
    const env = isolatedEnv(home);
    const runtimes = await discoverAgentRuntimes();
    const providers = [];
    for (const runtime of runtimes) {
      const checks: Check[] = [];
      if (!runtime.executable) {
        checks.push({ name: 'version', ok: false, code: 'cli-missing', detail: `${runtime.provider} CLI를 찾지 못했습니다.` });
      } else {
        const version = await runProcess(runtime.executable, ['--version'], { cwd: work, env, timeoutMs });
        checks.push(version.capped
          ? { name: 'version', ok: false, code: 'output-cap', detail: `${runtime.provider} 버전 출력이 한도를 넘었습니다.` }
          : version.timedOut
            ? { name: 'version', ok: false, code: 'timeout', detail: `${runtime.provider} 버전 확인 시간이 초과되었습니다.` }
            : acceptVersion(runtime.provider, version.stdout, version.stderr, version.code));
        for (const kind of ['new', 'resume'] as const) {
          const args = helpArgv(productArgs(runtime.provider, kind, work));
          const shape = argvShapeError(runtime.provider, kind, args);
          if (shape) {
            checks.push({ name: `${kind}-help`, ok: false, code: 'argv-invalid', detail: shape, argv: redactArgv(args, [DIAGNOSTIC_TOKEN]) });
            continue;
          }
          const help = await runProcess(runtime.executable, args, { cwd: work, env, stdin: PROMPT_FIXTURE, timeoutMs });
          const check = acceptHelp(runtime.provider, help.stdout, help.stderr, help.code, help.timedOut, help.capped);
          checks.push({ ...check, name: `${kind}-help`, argv: redactArgv(args, [DIAGNOSTIC_TOKEN]) });
        }
      }
      providers.push({ provider: runtime.provider, executable: runtime.executable, checks });
    }
    const mcp = await verifyMcpBoundary(Math.min(timeoutMs, 10_000));
    const ok = providers.every(provider => provider.checks.every(check => check.ok)) && mcp.ok;
    const logDir = options.logDir === null ? null : (options.logDir ?? EVIDENCE_LOG_DIR);
    const report: VerificationReport = { mode: 'no-model', llmResponseChecked: false, loginChecked: false, ok, promptFixture: PROMPT_FIXTURE, logDir, providers, mcp };
    if (logDir) {
      const absolute = logDir.startsWith('/') ? logDir : join(root, logDir);
      await mkdir(absolute, { recursive: true });
      await writeFile(join(absolute, 'report.json'), redact(JSON.stringify(report, null, 2), [DIAGNOSTIC_TOKEN]));
    }
    return report;
  } finally { await discardDiagnosticDirs(home, work); }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(parsed.detail + '\n');
    process.exitCode = 2;
  } else {
    runVerification().then(report => {
      const versions = report.providers.flatMap(provider => provider.checks.filter(check => check.name === 'version').map(check => check.detail));
      process.stdout.write(`${report.ok ? '기본 진단 통과' : '기본 진단 실패'}: ${versions.join(', ') || 'CLI 없음'}. 성공은 도움말 argv 수락과 MCP 경계입니다. 로그인과 모델 응답은 확인하지 않았고 호출 횟수도 세지 않았습니다.\n`);
      process.stdout.write(`이번 증거 로그(재실행 시 덮어씀): ${EVIDENCE_LOG_DIR}/report.json\n`);
      if (!report.ok) process.exitCode = 1;
    }, error => {
      process.stderr.write(String(error instanceof Error ? error.message : error) + '\n');
      process.exitCode = 1;
    });
  }
}
