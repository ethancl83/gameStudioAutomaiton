import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstExistingFile } from '../engines/which.js';
import { AppError } from '../domain/errors.js';
import { KEY_HELPER_IMAGE, KEY_HELPER_INPUT_LIMIT, KEY_HELPER_LABEL, KEY_HELPER_OUTPUT_LIMIT, parseHelperResponse,
  type KeyHelperMetadata, type KeyHelperRequest } from './docker-protocol.js';

type DockerResult = { code: number | null; stdout: string; stderr: string };
type Mount = { source: string; target: '/work/sign' | '/work/snapshot' | '/work/checkout' };
const ROLE_LABEL = 'appops.role';
const ROLE = 'trusted-key-helper';
const CLI_LIMIT = 128 * 1024;

function cancelled(): AppError { return new AppError('CANCELLED', '키 사용 작업을 취소했습니다.'); }
function cleanupFailed(id?: string, nonce?: string): AppError { return new AppError('DOCKER_KEY_CLEANUP_FAILED', '키 헬퍼 컨테이너 정리를 확인하지 못했습니다. Docker 상태를 확인해 주세요.', 400, { containerId: id, operationId: nonce }); }
type DockerOptions = { input?: string; signal?: AbortSignal; timeoutMs?: number; limit?: number };
type DockerSession = { run: (args: string[], options?: DockerOptions) => Promise<DockerResult>; daemonId: string };
function docker(executable: string, args: string[], env: NodeJS.ProcessEnv, options: DockerOptions = {}): Promise<DockerResult> {
  if (options.signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let failure: AppError | undefined;
    const stop = (error: AppError) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(cancelled());
    const timer = setTimeout(() => stop(new AppError('KEY_TOOL_TIMEOUT', '키 헬퍼의 시간 또는 출력 한도를 넘었습니다.')), options.timeoutMs ?? 30_000);
    timer.unref(); options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const receive = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.limit ?? CLI_LIMIT)) stop(new AppError('KEY_TOOL_TIMEOUT', '키 헬퍼의 시간 또는 출력 한도를 넘었습니다.'));
      else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => receive(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => receive(stderr, chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => { cleanup(); reject(new AppError('KEY_RUNTIME_UNAVAILABLE', 'Docker Linux 키 헬퍼를 시작할 수 없습니다.')); });
    child.on('close', code => {
      cleanup();
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input);
  });
}
async function dockerSession(): Promise<DockerSession> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) if (process.env[key]) env[key] = process.env[key];
  const candidate = await firstExistingFile([...(env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(directory, 'docker')),
    ...(process.platform === 'darwin' ? ['/usr/local/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'] : [])]);
  if (!candidate) throw new AppError('KEY_RUNTIME_UNAVAILABLE', 'Docker CLI를 찾을 수 없습니다.');
  const executable = await realpath(candidate);
  let endpoint = env.DOCKER_CONTEXT ? undefined : env.DOCKER_HOST;
  if (!endpoint) {
    const context = await docker(executable, ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : [])], env);
    try { if (context.code === 0) endpoint = JSON.parse(context.stdout); } catch {}
  }
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///') || /[\r\n\0]/.test(endpoint)) {
    throw new AppError('KEY_RUNTIME_UNAVAILABLE', '키 헬퍼에는 로컬 Docker Unix 소켓이 필요합니다.');
  }
  // Pin the resolved socket, not a mutable context name or symlink; never inherit later process.env changes.
  try { endpoint = 'unix://' + await realpath(endpoint.slice('unix://'.length)); }
  catch { throw new AppError('KEY_RUNTIME_UNAVAILABLE', '로컬 Docker 소켓에 접근할 수 없습니다.'); }
  delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST;
  const run: DockerSession['run'] = (args, options) => docker(executable, ['--host', endpoint!, ...args], env, options);
  const identity = await run(['info', '--format', '{{.ID}}']);
  const daemonId = identity.stdout.trim();
  if (identity.code !== 0 || !/^[a-zA-Z0-9:-]{1,128}$/.test(daemonId)) throw new AppError('KEY_RUNTIME_UNAVAILABLE', '로컬 Docker 식별자를 확인할 수 없습니다.');
  return { run, daemonId };
}
async function sameDaemon(session: DockerSession, id: string | undefined, nonce: string): Promise<void> {
  try {
    const identity = await session.run(['info', '--format', '{{.ID}}']);
    if (identity.code !== 0 || identity.stdout.trim() !== session.daemonId) throw cleanupFailed(id, nonce);
  } catch { throw cleanupFailed(id, nonce); }
}

async function seccompPath(): Promise<string> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'docker/runner/seccomp-bwrap.json')] : []),
    fileURLToPath(new URL('../../docker/runner/seccomp-bwrap.json', import.meta.url)),
    fileURLToPath(new URL('../../../docker/runner/seccomp-bwrap.json', import.meta.url)),
  ];
  for (const candidate of candidates) { try { await access(candidate); return await realpath(candidate); } catch {} }
  throw new AppError('KEY_RUNTIME_UNAVAILABLE', 'Docker 키 헬퍼의 격리 설정 파일이 없습니다.');
}
async function ownedLabels(session: DockerSession, id: string, nonce: string): Promise<boolean> {
  await sameDaemon(session, id, nonce);
  const result = await session.run(['container', 'inspect', '--format', '{{json .Config.Labels}}', id]);
  await sameDaemon(session, id, nonce);
  if (result.code !== 0) {
    // A failed inspect also means the daemon may be unreachable; it is not evidence of deletion.
    if (!result.stderr.includes(id) || !/No such (object|container):/i.test(result.stderr)) throw cleanupFailed(id, nonce);
    return false;
  }
  let labels: Record<string, string>;
  try { labels = JSON.parse(result.stdout); } catch { throw cleanupFailed(id, nonce); }
  if (labels?.[KEY_HELPER_LABEL] !== nonce || labels?.[ROLE_LABEL] !== ROLE) throw cleanupFailed(id, nonce);
  return true;
}
async function removeContainer(session: DockerSession, id: string, nonce: string): Promise<void> {
  try {
    if (!await ownedLabels(session, id, nonce)) return;
    await session.run(['kill', id]);
    const removal = await session.run(['rm', '--force', id]);
    if (removal.code !== 0 || await ownedLabels(session, id, nonce)) throw cleanupFailed(id, nonce);
  } catch { throw cleanupFailed(id, nonce); }
}

async function recoverCreatedContainer(session: DockerSession, nonce: string): Promise<string[]> {
  try {
    await sameDaemon(session, undefined, nonce);
    const found = await session.run(['ps', '--all', '--quiet', '--no-trunc', '--filter', 'label=' + KEY_HELPER_LABEL + '=' + nonce, '--filter', 'label=' + ROLE_LABEL + '=' + ROLE]);
    await sameDaemon(session, undefined, nonce);
    if (found.code !== 0) throw cleanupFailed(undefined, nonce);
    const ids = found.stdout.trim().split('\n').filter(Boolean);
    if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw cleanupFailed(undefined, nonce);
    // Lookup only recovers identities. Removal still rechecks both full labels for every exact ID.
    for (const id of ids) await removeContainer(session, id, nonce);
    return ids;
  } catch (error) {
    if (error instanceof AppError && error.code === 'DOCKER_KEY_CLEANUP_FAILED') throw error;
    throw cleanupFailed(undefined, nonce);
  }
}

/** This describes the Docker backend only; memoryKeyRuntimeAvailable remains a host tmpfs check. */
export async function dockerKeyRuntimeAvailable(): Promise<boolean> {
  try {
    await seccompPath();
    const session = await dockerSession();
    const result = await session.run(['image', 'inspect', '--format', '{{.Os}}', KEY_HELPER_IMAGE]);
    return result.code === 0 && result.stdout.trim() === 'linux';
  } catch { return false; }
}

export async function runDockerKeyHelper(request: KeyHelperRequest, options: {
  mounts?: Mount[]; signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<KeyHelperMetadata> {
  if (options.signal?.aborted) throw cancelled();
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > KEY_HELPER_INPUT_LIMIT) throw new AppError('INVALID_BUILD_CREDENTIAL', '키 헬퍼 입력 크기 한도를 넘었습니다.');
  const seccomp = await seccompPath();
  const session = await dockerSession();
  const nonce = randomUUID();
  const control = await mkdtemp(join(tmpdir(), 'appops-key-control-')); await chmod(control, 0o700);
  const cidfile = join(control, 'container-id');
  let id: string | undefined;
  let createStarted = false; let createFinished = false;
  try {
    const args = ['create', '--pull', 'never', '--interactive', '--init', '--read-only', '--log-driver', 'none',
      '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'SYS_ADMIN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'SETFCAP',
      '--security-opt', 'seccomp=' + seccomp, '--security-opt', 'systempaths=unconfined',
      '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--network', request.operation === 'fetch' ? 'bridge' : 'none',
      '--label', KEY_HELPER_LABEL + '=' + nonce, '--label', ROLE_LABEL + '=' + ROLE, '--cidfile', cidfile];
    const mounts = options.mounts ?? [];
    const targets = request.operation === 'validate' ? [] : request.operation === 'sign' ? ['/work/sign'] : ['/work/snapshot', '/work/checkout'];
    if (mounts.length !== targets.length || new Set(mounts.map(mount => mount.target)).size !== targets.length || mounts.some(mount => !targets.includes(mount.target))) {
      throw new AppError('INVALID_TOOL_ROOT', '키 헬퍼 마운트 범위가 작업과 일치하지 않습니다.');
    }
    for (const mount of mounts) {
      const source = await realpath(mount.source); const info = await lstat(source);
      const expectedStage = mount.target === '/work/sign' ? /^\.appops-sign-[a-zA-Z0-9]{6}$/.test(basename(source)) :
        /^\.appops-fetch-[a-zA-Z0-9]{6}$/.test(basename(dirname(source))) && basename(source) === (mount.target === '/work/snapshot' ? 'snapshot' : 'checkout');
      const contents = await readdir(source);
      const expectedContents = request.operation === 'sign' ? ['artifact.' + request.format] : [];
      if (!expectedStage || source !== resolve(mount.source) || contents.length !== expectedContents.length || contents.some(name => !expectedContents.includes(name)) || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || /[,\r\n]/.test(source)) {
        throw new AppError('INVALID_TOOL_ROOT', '키 헬퍼에는 이번 작업의 전용 임시 폴더만 연결할 수 있습니다.');
      }
      args.push('--mount', `type=bind,source=${source},target=${mount.target}`);
    }
    if (request.operation === 'validate' && options.mounts?.length) throw new AppError('INVALID_TOOL_ROOT', '키 검증에는 호스트 폴더를 연결할 수 없습니다.');
    args.push('--workdir', '/app', '--entrypoint', 'node', KEY_HELPER_IMAGE, '--import', 'tsx', 'apps/runner/key-helper.ts');
    if (options.signal?.aborted) throw cancelled();
    // Creation carries no secret and is allowed to finish even if the caller aborts, so its exact ID is known before attach.
    createStarted = true;
    const created = await session.run(args); createFinished = true;
    if (created.code !== 0) throw new AppError('KEY_RUNTIME_UNAVAILABLE', 'Docker Linux 키 헬퍼 이미지를 실행할 수 없습니다.');
    const returnedId = created.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(returnedId)) throw cleanupFailed(undefined, nonce);
    id = returnedId;
    if ((await readFile(cidfile, 'utf8')).trim() !== id) throw cleanupFailed(id, nonce);
    if (!await ownedLabels(session, id, nonce)) throw cleanupFailed(id, nonce);
    if (options.signal?.aborted) throw cancelled();
    const result = await session.run(['start', '--attach', '--interactive', id], { input, signal: options.signal, timeoutMs: options.timeoutMs ?? 180_000, limit: KEY_HELPER_OUTPUT_LIMIT });
    if (options.signal?.aborted) throw cancelled();
    return parseHelperResponse(result.stdout, request, result.code);
  } finally {
    try {
      if (!id) {
        try { const recorded = (await readFile(cidfile, 'utf8')).trim(); if (/^[a-f0-9]{64}$/.test(recorded)) id = recorded; } catch {}
      }
      if (id) await removeContainer(session, id, nonce);
      else if (createStarted) {
        const recovered = await recoverCreatedContainer(session, nonce);
        if (!createFinished && !recovered.length) throw cleanupFailed(undefined, nonce);
      }
    } finally { await rm(control, { recursive: true, force: true }); }
  }
}
