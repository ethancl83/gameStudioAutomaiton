import { spawn, type ChildProcess } from 'node:child_process';
import { access, cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { BuildExecutionResult, BuildOutput, BuildPlan, CommandSpec } from '../domain/index.js';
import { prepareTaskCaches } from './prepare.js';
import { applyIsolation, type IsolationOptions } from './sandbox.js';
import { ProcessTree } from './process-tree.js';

const MAX_STREAM_BYTES = 1_048_576;
const KILL_GRACE_MS = 2000;
// Per-run writable tool caches (Gradle home, Godot XDG data) live here so they
// are cleared with the output and never counted as build artifacts.
const TASK_CACHE_DIR = '.appops-task-cache';

function nowIso(): string {
  return new Date().toISOString();
}

function systemOutput(text: string, onOutput?: (output: BuildOutput) => void): void {
  const output: BuildOutput = { stream: 'system', text, at: nowIso() };
  onOutput?.(output);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function isInsidePath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

async function sourceRootOf(plan: BuildPlan): Promise<string> {
  try {
    return await realpath(plan.sourcePath);
  } catch {
    return resolve(plan.sourcePath);
  }
}

/**
 * Expected artifact paths are validated BEFORE any command runs: they must
 * stay inside the snapshot or the per-run output directory (never a host
 * path), and their shape must be consistent with the build target. This is
 * the runner's own boundary, independent of controller-side invariants.
 */
async function validateExpectedArtifacts(plan: BuildPlan): Promise<string | null> {
  const outputRoot = resolve(plan.outputPath);
  const sourceRoot = await sourceRootOf(plan);
  for (const expected of plan.expectedArtifacts) {
    if (!expected || expected.includes('\0')) return `기대 결과물 경로가 올바르지 않습니다: ${expected}`;
    const resolved = resolve(expected);
    if (!isInsidePath(outputRoot, resolved) && !isInsidePath(sourceRoot, resolved)) {
      return `기대 결과물 경로가 스냅샷/출력 디렉터리 밖을 가리킵니다: ${expected}`;
    }
    if (resolved === sourceRoot) return '기대 결과물이 스냅샷 루트 전체일 수 없습니다.';
    if (plan.target === 'android' && !/\.(apk|aab)$/i.test(resolved)) {
      return `android 대상 결과물은 .apk 또는 .aab 파일이어야 합니다: ${expected}`;
    }
    if (plan.target === 'ios' && !/(\.ipa|\.zip|\.xcarchive)$/i.test(resolved)) {
      return `ios 대상 결과물은 .ipa/.zip/.xcarchive 여야 합니다: ${expected}`;
    }
  }
  return null;
}

/**
 * A retried run may still see artifacts from an earlier attempt — either in
 * the per-run output directory or copied into the snapshot at the expected
 * source path. They are removed before the first command so that a later
 * zero-exit command can never re-attest a stale artifact as newly built.
 * Removal only ever touches validated paths inside those two roots.
 */
async function clearStaleArtifacts(plan: BuildPlan, onOutput?: (output: BuildOutput) => void): Promise<void> {
  const outputRoot = resolve(plan.outputPath);
  await rm(resolve(outputRoot, TASK_CACHE_DIR), { recursive: true, force: true });
  for (const expected of plan.expectedArtifacts) {
    const resolved = resolve(expected);
    if (resolved === outputRoot) {
      const names = await readdir(outputRoot).catch(() => [] as string[]);
      for (const name of names) {
        systemOutput(`이전 시도의 출력물을 제거합니다: ${name}`, onOutput);
        await rm(resolve(outputRoot, name), { recursive: true, force: true });
      }
      continue;
    }
    const existing = await lstat(resolved).catch(() => null);
    if (existing) {
      systemOutput(`이전 시도의 기대 결과물을 제거합니다: ${expected}`, onOutput);
      await rm(resolved, { recursive: true, force: true });
    }
  }
}

/** Returns null when the artifact is acceptable, otherwise the reason. */
async function verifyArtifact(target: string): Promise<string | null> {
  let st;
  try {
    st = await lstat(target);
  } catch {
    return '파일이 존재하지 않습니다';
  }
  if (st.isSymbolicLink()) return '심볼릭 링크 결과물은 허용되지 않습니다';
  if (st.isFile()) return st.size > 0 ? null : '0바이트 파일입니다';
  if (st.isDirectory()) {
    const names = (await readdir(target).catch(() => [] as string[])).filter((name) => name !== TASK_CACHE_DIR);
    return names.length > 0 ? null : '빈 결과물 디렉터리입니다';
  }
  return '일반 파일이나 디렉터리가 아닙니다';
}

function killWindowsTree(child: ChildProcess): void {
  if (!child.pid) return;
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
}

function pipeLimited(
  child: ChildProcess,
  stream: 'stdout' | 'stderr',
  onOutput?: (output: BuildOutput) => void,
): void {
  const readable = child[stream];
  if (!readable) return;
  let bytes = 0;
  let truncated = false;
  readable.on('data', (chunk: Buffer) => {
    // 한도를 넘긴 뒤에도 파이프를 비워 자식이 stdout에 막히지 않게 한다.
    if (truncated) return;
    const next = bytes + chunk.byteLength;
    if (next > MAX_STREAM_BYTES) {
      const allowed = MAX_STREAM_BYTES - bytes;
      if (allowed > 0) {
        onOutput?.({ stream, text: chunk.subarray(0, allowed).toString('utf8'), at: nowIso() });
      }
      truncated = true;
      onOutput?.({ stream: 'system', text: `${stream} 출력이 ${MAX_STREAM_BYTES}바이트에서 잘렸습니다.`, at: nowIso() });
      return;
    }
    bytes = next;
    onOutput?.({ stream, text: chunk.toString('utf8'), at: nowIso() });
  });
}

async function runCommand(
  command: CommandSpec,
  signal: AbortSignal | undefined,
  onOutput?: (output: BuildOutput) => void,
): Promise<{ exitCode: number; cancelled: boolean }> {
  if (signal?.aborted) return { exitCode: 143, cancelled: true };
  try {
    await access(command.executable, constants.X_OK);
  } catch {
    const exists = await pathExists(command.executable);
    systemOutput(
      exists
        ? `실행 파일에 실행 권한이 없습니다: ${command.executable}`
        : `도구를 찾을 수 없습니다: ${command.executable}. 설치 후 engineExecutable 또는 PATH를 확인하세요.`,
      onOutput,
    );
    return { exitCode: 127, cancelled: false };
  }

  await mkdir(command.cwd, { recursive: true });

  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      // A launcher receives no controller credentials, even before its sandbox starts.
      env: { PATH: process.platform === 'win32' ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32` : '/usr/bin:/bin:/usr/local/bin',
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot || 'C:\\Windows', WINDIR: process.env.SystemRoot || 'C:\\Windows' } : {}),
        LANG: 'C.UTF-8', ...command.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let settled = false;
    const finish = (exitCode: number, cancelled: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, cancelled });
    };

    // Nothing a command started may outlive it: on exit, failure or cancel
    // the whole process group and every tracked descendant get SIGKILL
    // before the next command runs or artifacts are checked.
    const tree = child.pid && process.platform !== 'win32' ? new ProcessTree(child) : null;
    let reaping: Promise<void> | null = null;
    const reap = () => (reaping ??= (tree?.signal('SIGKILL') ?? Promise.resolve()).finally(() => tree?.stop()));

    const onAbort = () => {
      systemOutput(`취소 신호로 프로세스를 종료합니다: ${command.label}`, onOutput);
      if (process.platform === 'win32') {
        killWindowsTree(child);
        setTimeout(() => killWindowsTree(child), KILL_GRACE_MS).unref();
        return;
      }
      void tree?.signal('SIGTERM');
      setTimeout(() => void reap(), KILL_GRACE_MS).unref();
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      tree?.stop();
      if (err.code === 'ENOENT') {
        systemOutput(`도구를 찾을 수 없습니다: ${command.executable}`, onOutput);
        finish(127, false);
        return;
      }
      systemOutput(`프로세스 시작 실패: ${err.message}`, onOutput);
      finish(1, false);
    });

    pipeLimited(child, 'stdout', onOutput);
    pipeLimited(child, 'stderr', onOutput);

    child.on('exit', () => {
      void reap().then(() => {
        // A process that escaped tracking may still hold the pipes; it must not keep the run open.
        setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, KILL_GRACE_MS).unref();
      });
    });

    child.on('close', (code) => {
      void reap().then(() => {
        if (signal?.aborted) finish(code ?? 143, true);
        else finish(code ?? 1, false);
      });
    });

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * The seal directory must be outside every path the sandbox may write (the
 * snapshot and the output) and must not contain them, since it is recreated.
 */
async function sealRootFor(plan: BuildPlan, sealTo: string): Promise<string | { error: string }> {
  const requested = resolve(sealTo);
  let parent: string;
  try {
    parent = await realpath(dirname(requested));
  } catch {
    return { error: `결과물 봉인 폴더의 상위 경로가 없습니다: ${sealTo}` };
  }
  const root = join(parent, basename(requested));
  const writable = [await sourceRootOf(plan), await realpath(plan.outputPath).catch(() => resolve(plan.outputPath))];
  if (writable.some((w) => isInsidePath(w, root) || isInsidePath(root, w))) {
    return { error: '결과물 봉인 폴더는 스냅샷·출력 폴더와 겹칠 수 없습니다.' };
  }
  return root;
}

/**
 * Copies verified artifacts to the seal directory (new inodes, outside the
 * sandbox's writable paths) after the process tree is gone. A process that
 * escaped tracking can still change the originals, but not these copies:
 * Seatbelt denies writes and hard links outside the writable paths.
 */
async function sealArtifacts(artifacts: string[], root: string): Promise<string[] | { error: string }> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sealed: string[] = [];
  for (const [index, artifact] of artifacts.entries()) {
    const destination = join(root, `${index}-${basename(artifact)}`);
    try {
      await cp(artifact, destination, {
        recursive: true, dereference: false, force: false, errorOnExist: true,
        filter: (source) => basename(source) !== TASK_CACHE_DIR,
      });
    } catch (error) {
      return { error: `결과물을 봉인하지 못했습니다 (${error instanceof Error ? error.message : String(error)}): ${artifact}` };
    }
    const problem = await verifyArtifact(destination);
    if (problem) return { error: `봉인한 결과물 검증 실패 (${problem}): ${artifact}` };
    sealed.push(destination);
  }
  return sealed;
}

export interface ExecuteBuildOptions {
  signal?: AbortSignal;
  onOutput?: (output: BuildOutput) => void;
  isolation?: IsolationOptions;
  /**
   * Directory outside the snapshot/output that receives copies of the
   * verified artifacts; the returned `artifacts` then point there
   * (`<sealTo>/<index>-<basename>`). It is deleted and recreated per run.
   */
  sealTo?: string;
}

export async function executeBuild(plan: BuildPlan, options?: ExecuteBuildOptions): Promise<BuildExecutionResult> {
  const startedAt = nowIso();
  const onOutput = options?.onOutput;
  const signal = options?.signal;

  if (plan.commands.length === 0) {
    systemOutput('실행할 빌드 명령이 없습니다. 누락된 도구·프리셋·스킴을 확인하세요.', onOutput);
    return { exitCode: 1, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: Boolean(signal?.aborted) };
  }

  const invalidExpected = await validateExpectedArtifacts(plan);
  if (invalidExpected) {
    systemOutput(invalidExpected, onOutput);
    return { exitCode: 1, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: false };
  }
  await mkdir(plan.outputPath, { recursive: true }).catch(() => undefined);
  const sealRoot = options?.sealTo ? await sealRootFor(plan, options.sealTo) : null;
  if (sealRoot && typeof sealRoot !== 'string') {
    systemOutput(sealRoot.error, onOutput);
    return { exitCode: 1, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: false };
  }
  await clearStaleArtifacts(plan, onOutput);
  for (const expected of plan.expectedArtifacts) {
    await mkdir(dirname(expected), { recursive: true }).catch(() => undefined);
  }

  for (const command of plan.commands) {
    if (signal?.aborted) {
      return { exitCode: 143, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: true };
    }
    const prepError = await prepareTaskCaches(command, plan);
    if (prepError) {
      systemOutput(prepError, onOutput);
      return { exitCode: 1, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: false };
    }
    const isolated = await applyIsolation(command, plan, options?.isolation);
    if ('error' in isolated) {
      systemOutput(isolated.error, onOutput);
      return { exitCode: 1, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: false };
    }
    systemOutput(`실행: ${isolated.command.label} (${isolated.command.executable})`, onOutput);
    const result = await runCommand(isolated.command, signal, onOutput);
    if (result.cancelled) {
      return { exitCode: 143, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: true };
    }
    if (result.exitCode !== 0) {
      systemOutput(`명령이 종료 코드 ${result.exitCode} 로 실패했습니다: ${command.label}`, onOutput);
      return { exitCode: result.exitCode, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: false };
    }
  }

  const artifacts: string[] = [];
  for (const expected of plan.expectedArtifacts) {
    const problem = await verifyArtifact(expected);
    if (problem === null) artifacts.push(expected);
    else systemOutput(`기대 결과물 검증 실패 (${problem}): ${expected}`, onOutput);
  }
  if (artifacts.length !== plan.expectedArtifacts.length) {
    systemOutput('필수 결과물 중 일부가 없거나 검증되지 않아 실패로 처리합니다.', onOutput);
    return { exitCode: 1, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: false };
  }
  if (sealRoot) {
    const sealed = await sealArtifacts(artifacts, sealRoot);
    if ('error' in sealed) {
      systemOutput(sealed.error, onOutput);
      return { exitCode: 1, artifacts: [], startedAt, finishedAt: nowIso(), cancelled: false };
    }
    return { exitCode: 0, artifacts: sealed, startedAt, finishedAt: nowIso(), cancelled: false };
  }

  return { exitCode: 0, artifacts, startedAt, finishedAt: nowIso(), cancelled: false };
}
