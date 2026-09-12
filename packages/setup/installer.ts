import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { AppError, redact } from '../domain/errors.js';
import type { AndroidSdkReceipt, ToolId, ToolInstall, ToolSettings } from './types.js';
import { extractZip } from './archive.js';
import {
  ANDROID_LICENSE_HASHES,
  ANDROID_PACKAGE_PATTERN,
  DEFAULT_ANDROID_PACKAGES,
  GODOT_TEMPLATE_RELEASE,
  androidLicensesFor,
  androidPackageSpec,
  androidSdkVersionKey,
  catalogItem,
  normalizeAndroidPackages,
  packageFor,
  type DownloadPackage,
} from './catalog.js';
import { assertTreeSafe, downloadVerified, extractTarGz } from './download.js';
import { validatedAndroidSdk, validatedJavaHome } from '../engines/toolchains.js';

const TERMINAL = new Set<ToolInstall['status']>(['succeeded', 'failed', 'cancelled']);
const HEX40 = /^[0-9a-f]{40}$/i;
const LICENSE_ID = /^[a-z0-9._-]+$/i;
export const INSTALLER_CLOSE_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 200;
const VERSION_PROBE_MS = 15_000;
const RECEIPT_NAME = '.appops-receipt.json';

export interface ToolInstallStartOptions { acceptLicense?: boolean; androidPackages?: string[] }
export interface ToolInstallerOptions {
  root: string;
  getSettings: () => ToolSettings;
  saveSettings: (settings: ToolSettings) => Promise<void>;
  persist: (jobs: ToolInstall[]) => void;
  initialJobs?: ToolInstall[];
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  resolvePackage?: typeof packageFor;
}

function now(): string { return new Date().toISOString(); }
function copy(job: ToolInstall): ToolInstall { return {...job, receipt: job.receipt ? structuredClone(job.receipt) : undefined}; }

async function isFile(path: string): Promise<boolean> {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}
async function isDir(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory(); } catch { return false; }
}

function isolatedEnv(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(values)) if (value) env[key] = value;
  return env;
}

function javaName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'java.exe' : 'java';
}
function javacName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'javac.exe' : 'javac';
}
function nativeName(platform: NodeJS.Platform, name: string): string {
  if (platform !== 'win32') return name;
  if (name.endsWith('.exe') || name.endsWith('.jar') || name.includes('/')) return name;
  return `${name}.exe`;
}

function resolvePackageFile(platform: NodeJS.Platform, file: string): string {
  if (platform !== 'win32') return file;
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (base === 'ndk-build') return file.replace(/ndk-build$/, 'ndk-build.cmd');
  if (base === 'adb' || base === 'aapt2' || base === 'cmake') {
    return file.replace(new RegExp(`${base}$`), `${base}.exe`);
  }
  return file;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..`) && !isAbsolute(rel));
}

async function findJavaHome(root: string, platform: NodeJS.Platform, depth = 0): Promise<string | null> {
  if (depth > 4) return null;
  if (await isFile(join(root, 'bin', javaName(platform)))) return root;
  if (!(await isDir(root))) return null;
  for (const name of await readdir(root)) {
    const child = join(root, name);
    if (await isDir(child)) {
      const found = await findJavaHome(child, platform, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function hasEntries(path: string): Promise<boolean> {
  try { return (await readdir(path)).length > 0; } catch { return false; }
}

async function arrangeTemplates(stage: string): Promise<void> {
  const dest = join(stage, 'export_templates', GODOT_TEMPLATE_RELEASE);
  if (await isDir(dest) && await hasEntries(dest)) return;
  const templates = join(stage, 'templates');
  if (!(await isDir(templates) && await hasEntries(templates))) {
    throw new AppError('INVALID_LAYOUT', 'Godot 템플릿 폴더 구조가 예상과 다릅니다.');
  }
  await mkdir(join(stage, 'export_templates'), {recursive: true, mode: 0o700});
  await rename(templates, dest);
}

async function arrangeAndroidTools(stage: string): Promise<void> {
  const ct = join(stage, 'cmdline-tools');
  if (await isDir(join(ct, 'latest', 'lib')) || await isDir(join(ct, 'latest', 'bin'))) return;
  if (!(await isDir(join(ct, 'bin')) || await isDir(join(ct, 'lib')))) {
    throw new AppError('INVALID_LAYOUT', 'Android 명령 도구 폴더 구조가 예상과 다릅니다.');
  }
  const latest = join(ct, 'latest');
  await mkdir(latest, {recursive: true, mode: 0o700});
  for (const name of await readdir(ct)) {
    if (name === 'latest') continue;
    await rename(join(ct, name), join(latest, name));
  }
}

async function sdkmanagerClasspath(toolsDir: string): Promise<string> {
  const lib = join(toolsDir, 'lib');
  const preferred = join(lib, 'sdkmanager-classpath.jar');
  if (await isFile(preferred)) return preferred;
  const jars = (await readdir(lib).catch(() => [] as string[])).filter(name => name.endsWith('.jar'));
  const named = jars.find(name => name.includes('sdkmanager')) ?? (jars.length === 1 ? jars[0] : undefined);
  if (!named) throw new AppError('INVALID_LAYOUT', 'sdkmanager 실행 파일을 찾지 못했습니다.');
  return join(lib, named);
}

function failMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '설치를 취소했습니다.';
  return '설치에 실패했습니다.';
}

function destroyStdio(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch { /* already closed */ }
  }
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {shell: false, stdio: 'ignore'});
      return;
    }
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { child.kill('SIGTERM'); }
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
  }
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {shell: false, stdio: 'ignore'});
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
}

export async function assertSdkTreeSafe(root: string): Promise<void> {
  const realRoot = await realpath(root);
  const stack = [realRoot];
  while (stack.length) {
    const directory = stack.pop()!;
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const target = join(directory, entry.name);
      const info = await lstat(target);
      if (info.isFIFO() || info.isSocket() || info.isCharacterDevice() || info.isBlockDevice()) {
        throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 링크나 특수 파일이 있습니다.');
      }
      if (info.isSymbolicLink()) {
        let resolved: string;
        try { resolved = await realpath(target); }
        catch { throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 외부 링크가 있습니다.'); }
        if (!inside(realRoot, resolved)) throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 외부 링크가 있습니다.');
        continue;
      }
      if (info.isDirectory()) stack.push(target);
    }
  }
}

async function copyManagedTree(src: string, dest: string): Promise<void> {
  const realSrc = await realpath(src);
  await mkdir(dest, {recursive: true, mode: 0o700});
  const walk = async (from: string, to: string): Promise<void> => {
    for (const name of await readdir(from)) {
      const srcPath = join(from, name);
      const destPath = join(to, name);
      const info = await lstat(srcPath);
      if (info.isFIFO() || info.isSocket() || info.isCharacterDevice() || info.isBlockDevice()) {
        throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 링크나 특수 파일이 있습니다.');
      }
      if (info.isSymbolicLink()) {
        let resolved: string;
        try { resolved = await realpath(srcPath); }
        catch { throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 외부 링크가 있습니다.'); }
        if (!inside(realSrc, resolved)) throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 외부 링크가 있습니다.');
        const targetInfo = await lstat(resolved);
        if (targetInfo.isDirectory()) {
          await mkdir(destPath, {recursive: true, mode: 0o700});
          await walk(resolved, destPath);
        } else if (targetInfo.isFile()) {
          await copyFile(resolved, destPath);
          await chmod(destPath, targetInfo.mode & 0o111 ? 0o700 : 0o600);
        } else {
          throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 링크나 특수 파일이 있습니다.');
        }
        continue;
      }
      if (info.isDirectory()) {
        await mkdir(destPath, {recursive: true, mode: 0o700});
        await walk(srcPath, destPath);
      } else if (info.isFile()) {
        await copyFile(srcPath, destPath);
        await chmod(destPath, info.mode & 0o111 ? 0o700 : 0o600);
      } else {
        throw new AppError('UNSAFE_ARCHIVE', '설치 결과에 링크나 특수 파일이 있습니다.');
      }
    }
  };
  await walk(realSrc, dest);
  await assertSdkTreeSafe(dest);
}

async function readRevision(directory: string): Promise<{revision: string | null; apiLevel: string | null; text: string}> {
  const text = await readFile(join(directory, 'source.properties'), 'utf8').catch(() => '');
  return {
    text,
    revision: /^Pkg\.Revision=(.+)$/m.exec(text)?.[1]?.trim() ?? null,
    apiLevel: /^AndroidVersion\.ApiLevel=(.+)$/m.exec(text)?.[1]?.trim() ?? null,
  };
}

function parseLicenseHashes(text: string): string[] {
  const hashes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (HEX40.test(value)) hashes.push(value.toLowerCase());
  }
  return [...new Set(hashes)];
}

export async function readAndroidReceipt(sdkRoot: string): Promise<AndroidSdkReceipt | undefined> {
  const raw = await readFile(join(sdkRoot, RECEIPT_NAME), 'utf8').catch(() => '');
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const data = parsed as Partial<AndroidSdkReceipt>;
  if (!Array.isArray(data.licenses) || !Array.isArray(data.packages) || typeof data.recordedAt !== 'string') return undefined;
  const licenses = data.licenses.flatMap(item => {
    if (!item || typeof item.id !== 'string' || !LICENSE_ID.test(item.id) || !Array.isArray(item.hashes)) return [];
    const hashes = item.hashes.filter((hash): hash is string => typeof hash === 'string' && HEX40.test(hash));
    return hashes.length ? [{id: item.id, hashes}] : [];
  });
  const packages = data.packages.flatMap(item => {
    if (!item || typeof item.id !== 'string' || typeof item.revision !== 'string') return [];
    if (!ANDROID_PACKAGE_PATTERN.test(item.id)) return [];
    return [{id: item.id, revision: item.revision}];
  });
  return {licenses, packages, recordedAt: data.recordedAt};
}

async function writeAndroidReceipt(sdkRoot: string, receipt: AndroidSdkReceipt): Promise<void> {
  await writeFile(join(sdkRoot, RECEIPT_NAME), `${JSON.stringify(receipt)}\n`, {mode: 0o600});
}

export async function runIsolated(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs: number;
    stdin?: string;
    children?: Set<ChildProcess>;
  },
): Promise<{code: number; output: string}> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    options.children?.add(child);
    let output = '';
    const append = (chunk: Buffer): void => {
      if (output.length < 512 * 1024) output += chunk.toString('utf8').slice(0, 512 * 1024 - output.length);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.stdin);
    }
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      options.children?.delete(child);
      action();
    };
    const stop = (immediate: boolean): void => {
      killProcessTree(child);
      const killer = setTimeout(() => forceKill(child), KILL_GRACE_MS);
      killer.unref();
      destroyStdio(child);
      if (immediate) {
        finish(() => rejectPromise(options.signal?.aborted
          ? Object.assign(new Error('aborted'), {name: 'AbortError'})
          : new AppError('INSTALL_TIMEOUT', '설치 명령이 제한 시간을 넘겼습니다.')));
      }
    };
    const timer = setTimeout(() => stop(true), options.timeoutMs);
    const onAbort = (): void => { stop(true); };
    options.signal?.addEventListener('abort', onAbort, {once: true});
    if (options.signal?.aborted) onAbort();
    child.on('error', error => finish(() => rejectPromise(error)));
    child.on('close', code => finish(() => {
      if (options.signal?.aborted) rejectPromise(Object.assign(new Error('aborted'), {name: 'AbortError'}));
      else resolvePromise({code: code ?? 1, output});
    }));
  });
}

export class ToolInstaller {
  readonly #root: string;
  readonly #getSettings: () => ToolSettings;
  readonly #saveSettings: (settings: ToolSettings) => Promise<void>;
  readonly #persist: (jobs: ToolInstall[]) => void;
  readonly #fetch: typeof fetch;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #packageFor: typeof packageFor;
  readonly #jobs: ToolInstall[];
  readonly #starts = new Map<string, ToolInstallStartOptions>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #children = new Set<ChildProcess>();
  readonly #ready: Promise<void>;
  #running?: Promise<void>;
  #closed = false;
  #lastPersist = 0;

  constructor(options: ToolInstallerOptions) {
    this.#root = options.root;
    this.#getSettings = options.getSettings;
    this.#saveSettings = options.saveSettings;
    this.#persist = options.persist;
    this.#fetch = options.fetch ?? fetch;
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    this.#packageFor = options.resolvePackage ?? packageFor;
    this.#jobs = (options.initialJobs ?? []).map(job => TERMINAL.has(job.status)
      ? {...job}
      : {...job, status: 'failed', message: '중단된 설치를 복구했습니다.', updatedAt: now()});
    this.#persist(this.list());
    this.#ready = this.#cleanupOrphans();
  }

  start(toolId: ToolId, options: ToolInstallStartOptions = {}): ToolInstall {
    if (this.#closed) throw new AppError('INSTALLER_CLOSED', '설치 관리자가 종료되었습니다.');
    const item = catalogItem(toolId);
    if (!item?.installable) throw new AppError('MANUAL_INSTALL', '해당 도구는 공식 설치 프로그램·라이선스 확인 후 기존 경로를 연결합니다.');
    this.#packageFor(toolId, this.#platform, this.#arch);
    if (toolId === 'android-sdk' && !options.acceptLicense) {
      throw new AppError('LICENSE_REQUIRED', 'Android SDK 라이선스에 동의한 뒤에만 설치할 수 있습니다.');
    }
    const androidPackages = this.#androidPackages(toolId, options);
    const job: ToolInstall = {
      id: randomUUID(), toolId, status: 'queued', progress: 0, message: '설치 대기 중',
      bytes: 0, totalBytes: null, createdAt: now(), updatedAt: now(),
    };
    this.#jobs.push(job);
    this.#starts.set(job.id, {...options, androidPackages});
    this.#persist(this.list());
    this.#pump();
    return copy(job);
  }

  list(): ToolInstall[] { return this.#jobs.map(copy); }

  cancel(id: string): ToolInstall | undefined {
    const job = this.#jobs.find(item => item.id === id);
    if (!job) return undefined;
    if (TERMINAL.has(job.status)) return copy(job);
    this.#controllers.get(id)?.abort();
    this.#update(job, {status: 'cancelled', message: '설치를 취소했습니다.'}, true);
    return copy(job);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs) {
      if (!TERMINAL.has(job.status)) {
        this.#controllers.get(job.id)?.abort();
        this.#update(job, {status: 'cancelled', message: '설치를 취소했습니다.'}, true);
      }
    }
    if (!this.#running) return;
    const running = this.#running.catch(() => undefined);
    const timedOut = await Promise.race([
      running.then(() => false),
      new Promise<boolean>(resolvePromise => {
        const timer = setTimeout(() => resolvePromise(true), INSTALLER_CLOSE_TIMEOUT_MS);
        running.finally(() => clearTimeout(timer));
      }),
    ]);
    if (timedOut) {
      for (const child of this.#children) forceKill(child);
      for (const child of this.#children) {
        destroyStdio(child);
        try { child.unref(); } catch { /* gone */ }
      }
      await this.#cleanupOrphans();
    }
  }

  #androidPackages(toolId: ToolId, options: ToolInstallStartOptions): string[] {
    if (toolId !== 'android-sdk') return [];
    const packages = options.androidPackages?.length ? options.androidPackages : [...DEFAULT_ANDROID_PACKAGES];
    return normalizeAndroidPackages(packages);
  }

  #cancelled(job: ToolInstall): boolean { return job.status === 'cancelled'; }

  #update(job: ToolInstall, patch: Partial<ToolInstall>, force = false): void {
    const statusChanged = Boolean(patch.status && patch.status !== job.status);
    Object.assign(job, patch, {updatedAt: now()});
    const stamp = Date.now();
    if (force || statusChanged || stamp - this.#lastPersist > 200) {
      this.#lastPersist = stamp;
      this.#persist(this.list());
    }
  }

  #pump(): void {
    if (this.#running || this.#closed) return;
    this.#running = this.#loop().finally(() => {
      this.#running = undefined;
      if (!this.#closed && this.#jobs.some(job => job.status === 'queued')) this.#pump();
    });
  }

  async #loop(): Promise<void> {
    await this.#ready;
    while (!this.#closed) {
      const next = this.#jobs.find(job => job.status === 'queued');
      if (!next) return;
      await this.#run(next);
    }
  }

  async #run(job: ToolInstall): Promise<void> {
    if (job.status !== 'queued') return;
    const controller = new AbortController();
    this.#controllers.set(job.id, controller);
    try {
      await this.#install(job, controller.signal);
    } catch (error) {
      if (this.#cancelled(job) || controller.signal.aborted) {
        if (!this.#cancelled(job)) this.#update(job, {status: 'cancelled', message: '설치를 취소했습니다.'}, true);
      } else {
        this.#update(job, {status: 'failed', message: failMessage(error)}, true);
      }
    } finally {
      this.#controllers.delete(job.id);
      await this.#cleanupJob(job.id);
    }
  }

  async #install(job: ToolInstall, signal: AbortSignal): Promise<void> {
    const pkg = this.#packageFor(job.toolId, this.#platform, this.#arch);
    const requested = this.#starts.get(job.id)?.androidPackages ?? [...DEFAULT_ANDROID_PACKAGES];
    const priorSdk = job.toolId === 'android-sdk' ? this.#getSettings().androidSdk : undefined;
    const priorPackages = priorSdk ? await this.#scanAndroidPackages(priorSdk) : [];
    const packages = job.toolId === 'android-sdk' ? normalizeAndroidPackages([...priorPackages, ...requested]) : requested;
    const versionDir = join(
      this.#root,
      job.toolId,
      job.toolId === 'android-sdk' ? androidSdkVersionKey(pkg.version, packages) : pkg.version,
    );
    if (await this.#validInstall(job.toolId, pkg, versionDir, packages)) {
      await this.#activateSettings(job, pkg, versionDir);
      return;
    }
    if (await isDir(versionDir)) throw new AppError('INSTALL_EXISTS', '기존 설치 폴더가 불완전합니다. 수동으로 확인한 뒤 다시 시도해 주세요.');

    const downloads = join(this.#root, '.downloads', job.id);
    const stage = join(this.#root, '.stage', job.id);
    const expand = job.toolId === 'android-sdk' && priorSdk && priorSdk !== versionDir && await this.#validCmdlineTools(priorSdk);
    await mkdir(downloads, {recursive: true, mode: 0o700});
    if (expand) {
      this.#update(job, {status: 'installing', message: '기존 SDK를 복사한 뒤 구성 요소를 추가합니다.', progress: 20}, true);
      signal.throwIfAborted();
      await copyManagedTree(priorSdk!, stage);
    } else {
      this.#update(job, {status: 'downloading', message: '공식 파일을 받는 중입니다.', progress: 1});
      const archivePath = join(downloads, pkg.name);
      const downloaded = await downloadVerified({
        url: pkg.url, destination: archivePath, sha256: pkg.sha256, sha512: pkg.sha512,
        maxBytes: pkg.maxBytes, allowedHosts: pkg.allowedHosts, fetch: this.#fetch, signal,
        onProgress: (bytes, total) => this.#update(job, {
          bytes, totalBytes: total, progress: total ? Math.min(80, Math.round((bytes / total) * 80)) : job.progress,
        }),
      });
      this.#update(job, {status: 'verifying', bytes: downloaded.bytes, message: '파일 무결성을 확인했습니다.', progress: 82}, true);
      signal.throwIfAborted();
      this.#update(job, {status: 'installing', message: '압축을 해제하는 중입니다.', progress: 85}, true);
      if (pkg.archive === 'zip') await extractZip(archivePath, stage, signal);
      else await extractTarGz(archivePath, stage, signal, {materializeInternalLinks: true});
      await assertTreeSafe(stage);
      await this.#layout(job.toolId, pkg, stage);
    }
    if (job.toolId === 'android-sdk') {
      await this.#installAndroidPackages(job, stage, packages, signal);
      await assertSdkTreeSafe(stage);
    }
    if (!(await this.#validInstall(job.toolId, pkg, stage, packages))) {
      throw new AppError('INVALID_LAYOUT', '설치 결과의 구성 요소 버전이나 폴더 구조가 카탈로그와 다릅니다.');
    }
    if (this.#cancelled(job) || signal.aborted) return;
    await mkdir(dirname(versionDir), {recursive: true, mode: 0o700});
    await rename(stage, versionDir);
    await this.#activateSettings(job, pkg, versionDir);
  }

  async #activateSettings(job: ToolInstall, pkg: DownloadPackage, versionDir: string): Promise<void> {
    if (this.#cancelled(job)) return;
    this.#update(job, {progress: 95, message: '설정을 저장하는 중입니다.'}, true);
    const patch = await this.#settingsPatch(job.toolId, pkg, versionDir);
    const receipt = job.toolId === 'android-sdk' ? await readAndroidReceipt(versionDir) : undefined;
    try {
      await this.#saveSettings({...this.#getSettings(), ...patch});
    } catch {
      throw new AppError('SETTINGS_FAILED', '도구 경로는 설치했지만 설정 저장에 실패했습니다. 이전 설정은 그대로입니다.');
    }
    if (this.#cancelled(job)) return;
    this.#update(job, {
      status: 'succeeded', progress: 100, message: '설치했습니다.',
      destination: patch.godot ?? patch.godotData ?? patch.javaHome ?? patch.androidSdk,
      receipt,
    }, true);
  }

  async #layout(toolId: ToolId, pkg: DownloadPackage, stage: string): Promise<void> {
    if (toolId === 'godot-templates') await arrangeTemplates(stage);
    if (toolId === 'android-sdk') await arrangeAndroidTools(stage);
    if (toolId === 'godot') {
      const editor = join(stage, pkg.entry ?? '');
      if (!(await isFile(editor))) throw new AppError('INVALID_LAYOUT', 'Godot 편집기 실행 파일이 압축 내용에 없습니다.');
      await chmod(editor, 0o700);
    }
    if (toolId === 'jdk' && !(await findJavaHome(stage, this.#platform))) {
      throw new AppError('INVALID_LAYOUT', 'JDK bin/java 실행 파일이 압축 내용에 없습니다.');
    }
  }

  async #validInstall(toolId: ToolId, pkg: DownloadPackage, versionDir: string, packages: string[]): Promise<boolean> {
    if (!(await isDir(versionDir))) return false;
    if (toolId === 'android-sdk') {
      try { await assertSdkTreeSafe(versionDir); } catch { return false; }
      return this.#androidPackagesValid(versionDir, packages);
    }
    try { await assertTreeSafe(versionDir); } catch { return false; }
    if (pkg.expectedLayout) {
      for (const relativePath of pkg.expectedLayout) {
        const target = toolId === 'jdk'
          ? join(await findJavaHome(versionDir, this.#platform) ?? versionDir, relativePath)
          : join(versionDir, relativePath);
        if (!(await isFile(target)) && !(await isDir(target))) return false;
      }
    }
    if (toolId === 'godot') return await isFile(join(versionDir, pkg.entry ?? ''));
    if (toolId === 'godot-templates') {
      return await isDir(join(versionDir, 'export_templates', GODOT_TEMPLATE_RELEASE))
        && await hasEntries(join(versionDir, 'export_templates', GODOT_TEMPLATE_RELEASE));
    }
    if (toolId === 'jdk') {
      const home = await findJavaHome(versionDir, this.#platform);
      if (!home) return false;
      if (!(await this.#javaVersionMatches(home, pkg.expectedVersion))) return false;
      const probe = await validatedJavaHome({javaHome: home, managedRoot: this.#root});
      return Boolean(probe.path);
    }
    return false;
  }

  async #validCmdlineTools(sdkRoot: string): Promise<boolean> {
    if (!(await isDir(join(sdkRoot, 'cmdline-tools', 'latest', 'lib')))) return false;
    try { await assertSdkTreeSafe(sdkRoot); } catch { return false; }
    return true;
  }

  async #javaVersionMatches(home: string, expected?: string): Promise<boolean> {
    const java = join(home, 'bin', javaName(this.#platform));
    const javac = join(home, 'bin', javacName(this.#platform));
    if (!(await isFile(java)) || !(await isFile(javac))) return false;
    if (!expected) return true;
    const release = await readFile(join(home, 'release'), 'utf8').catch(() => '');
    const fromRelease = /JAVA_VERSION="([^"]+)"/.exec(release)?.[1];
    if (fromRelease && !fromRelease.includes(expected)) return false;
    const runtime = await this.#probeVersion(java, ['-version']);
    const compiler = await this.#probeVersion(javac, ['-version']);
    return Boolean(runtime?.includes(expected) && compiler?.includes(expected));
  }

  async #probeVersion(executable: string, args: string[]): Promise<string | null> {
    try {
      const result = await runIsolated(executable, args, {
        cwd: this.#root,
        env: isolatedEnv({
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          SystemRoot: this.#platform === 'win32' ? process.env.SystemRoot ?? 'C:\\Windows' : undefined,
          WINDIR: this.#platform === 'win32' ? process.env.WINDIR : undefined,
        }),
        timeoutMs: VERSION_PROBE_MS,
        children: this.#children,
      });
      return result.output;
    } catch {
      return null;
    }
  }

  async #androidPackagesValid(sdkRoot: string, packages: string[]): Promise<boolean> {
    if (!(await isDir(join(sdkRoot, 'cmdline-tools', 'latest', 'lib')))) return false;
    for (const name of packages) {
      const spec = androidPackageSpec(name);
      const directory = join(sdkRoot, spec.directory);
      if (!(await isDir(directory))) return false;
      const meta = await readRevision(directory);
      if (meta.revision !== spec.revision) return false;
      if (spec.id.startsWith('platforms;android-')) {
        const api = spec.id.slice('platforms;android-'.length);
        if (meta.apiLevel !== api) return false;
      }
      for (const file of spec.files) {
        const target = join(directory, resolvePackageFile(this.#platform, file));
        try {
          const info = await lstat(target);
          if (!info.isFile() || info.size <= 0) return false;
        } catch { return false; }
      }
      if (spec.id === 'platform-tools') {
        const adb = join(directory, nativeName(this.#platform, 'adb'));
        const output = await this.#probeVersion(adb, ['version']);
        if (!output?.includes('Android Debug Bridge')) return false;
      }
      if (spec.id.startsWith('build-tools;')) {
        const aapt = join(directory, nativeName(this.#platform, 'aapt2'));
        const signer = join(directory, 'lib', 'apksigner.jar');
        if (!(await isFile(signer))) return false;
        try { if ((await lstat(signer)).size <= 0) return false; } catch { return false; }
        const output = await this.#probeVersion(aapt, ['version']);
        if (!output?.includes('Android Asset Packaging Tool')) return false;
      }
    }
    const receipt = await readAndroidReceipt(sdkRoot);
    if (receipt) {
      for (const pkg of packages) {
        const spec = androidPackageSpec(pkg);
        const recorded = receipt.packages.find(item => item.id === pkg);
        if (recorded && recorded.revision !== spec.revision) return false;
      }
    }
    const probe = await validatedAndroidSdk({androidSdk: sdkRoot, managedRoot: this.#root});
    return Boolean(probe.path);
  }

  async #scanAndroidPackages(sdkRoot: string): Promise<string[]> {
    if (!(await isDir(sdkRoot))) return [];
    const found: string[] = [];
    const receipt = await readAndroidReceipt(sdkRoot);
    for (const item of receipt?.packages ?? []) found.push(item.id);
    if (await isDir(join(sdkRoot, 'platform-tools'))) found.push('platform-tools');
    for (const name of await readdir(join(sdkRoot, 'platforms')).catch(() => [] as string[])) {
      found.push(`platforms;${name}`);
    }
    for (const name of await readdir(join(sdkRoot, 'build-tools')).catch(() => [] as string[])) {
      found.push(`build-tools;${name}`);
    }
    for (const name of await readdir(join(sdkRoot, 'ndk')).catch(() => [] as string[])) {
      found.push(`ndk;${name}`);
    }
    for (const name of await readdir(join(sdkRoot, 'cmake')).catch(() => [] as string[])) {
      found.push(`cmake;${name}`);
    }
    const known = found.filter(name => ANDROID_PACKAGE_PATTERN.test(name) && androidPackageSpecSafe(name));
    return known.length ? normalizeAndroidPackages(known) : [];
  }

  async #settingsPatch(toolId: ToolId, pkg: DownloadPackage, versionDir: string): Promise<ToolSettings> {
    if (toolId === 'godot') return {godot: join(versionDir, pkg.entry!)};
    if (toolId === 'godot-templates') return {godotData: versionDir};
    if (toolId === 'jdk') {
      const home = await findJavaHome(versionDir, this.#platform);
      if (!home) throw new AppError('INVALID_LAYOUT', 'JDK bin/java 실행 파일이 없습니다.');
      return {javaHome: home};
    }
    if (toolId === 'android-sdk') return {androidSdk: versionDir};
    throw new AppError('MANUAL_INSTALL', '해당 도구는 자동 설치를 지원하지 않습니다.');
  }

  async #installAndroidPackages(job: ToolInstall, sdkRoot: string, packages: string[], signal: AbortSignal): Promise<void> {
    const javaHome = this.#getSettings().javaHome;
    if (!javaHome) throw new AppError('JDK_REQUIRED', 'Android SDK를 설치하려면 먼저 JDK를 설치하거나 연결해 주세요.');
    const java = join(javaHome, 'bin', javaName(this.#platform));
    if (!(await isFile(java))) throw new AppError('JDK_REQUIRED', '설정한 JDK에서 java 실행 파일을 찾지 못했습니다.');
    const toolsDir = join(sdkRoot, 'cmdline-tools', 'latest');
    const classpath = await sdkmanagerClasspath(toolsDir);
    const home = join(this.#root, '.homes', job.id);
    const tmp = join(home, 'tmp');
    const userHome = join(home, '.android');
    await mkdir(tmp, {recursive: true, mode: 0o700});
    const licenseIds = androidLicensesFor(packages);
    await this.#seedLicenses(sdkRoot, userHome, licenseIds);
    const env = isolatedEnv({
      HOME: home,
      USERPROFILE: this.#platform === 'win32' ? home : undefined,
      APPDATA: this.#platform === 'win32' ? join(home, 'AppData', 'Roaming') : undefined,
      LOCALAPPDATA: this.#platform === 'win32' ? join(home, 'AppData', 'Local') : undefined,
      JAVA_HOME: javaHome,
      ANDROID_SDK_ROOT: sdkRoot,
      ANDROID_HOME: sdkRoot,
      ANDROID_USER_HOME: userHome,
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      PATH: [join(javaHome, 'bin'), join(toolsDir, 'bin'), this.#platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin', this.#platform === 'win32' ? undefined : '/bin'].filter(Boolean).join(delimiter),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      SystemRoot: this.#platform === 'win32' ? process.env.SystemRoot ?? 'C:\\Windows' : undefined,
      WINDIR: this.#platform === 'win32' ? process.env.WINDIR : undefined,
    });
    const main = 'com.android.sdklib.tool.sdkmanager.SdkManagerCli';
    const vm = [`-Dcom.android.sdklib.toolsdir=${toolsDir}`, '-classpath', classpath, main];
    this.#update(job, {message: '요청한 Android 구성 요소를 설치합니다.', progress: 88}, true);
    const installed = await runIsolated(java, [...vm, `--sdk_root=${sdkRoot}`, '--install', ...packages], {
      cwd: home, env, signal, timeoutMs: 900_000, children: this.#children,
    });
    if (installed.code !== 0) throw new AppError('SDKMANAGER_FAILED', redact(`Android 구성 요소 설치에 실패했습니다. ${installed.output.trim().slice(-400)}`));
    await this.#persistConsent(sdkRoot, userHome, packages, licenseIds);
  }

  async #seedLicenses(sdkRoot: string, userHome: string, licenseIds: string[]): Promise<void> {
    for (const id of licenseIds) {
      const hashes = ANDROID_LICENSE_HASHES[id];
      if (!hashes?.length) throw new AppError('LICENSE_REQUIRED', '요청한 구성 요소의 라이선스 영수증을 만들 수 없습니다.');
      const body = `${hashes.join('\n')}\n`;
      for (const directory of [join(sdkRoot, 'licenses'), join(userHome, 'licenses')]) {
        await mkdir(directory, {recursive: true, mode: 0o700});
        await writeFile(join(directory, id), body, {mode: 0o600});
      }
    }
  }

  async #persistConsent(sdkRoot: string, userHome: string, packages: string[], licenseIds: string[]): Promise<void> {
    const licenses = [];
    for (const id of licenseIds) {
      const hashes = new Set<string>();
      for (const directory of [join(sdkRoot, 'licenses'), join(userHome, 'licenses')]) {
        const text = await readFile(join(directory, id), 'utf8').catch(() => '');
        for (const hash of parseLicenseHashes(text)) hashes.add(hash);
      }
      if (!hashes.size) throw new AppError('LICENSE_REQUIRED', '동의한 라이선스 영수증을 남기지 못했습니다.');
      const body = `${[...hashes].join('\n')}\n`;
      await mkdir(join(sdkRoot, 'licenses'), {recursive: true, mode: 0o700});
      await writeFile(join(sdkRoot, 'licenses', id), body, {mode: 0o600});
      licenses.push({id, hashes: [...hashes].sort()});
    }
    const recorded = [];
    for (const name of packages) {
      const spec = androidPackageSpec(name);
      const meta = await readRevision(join(sdkRoot, spec.directory));
      if (meta.revision !== spec.revision) {
        throw new AppError('INVALID_LAYOUT', '설치한 Android 구성 요소 버전이 카탈로그와 다릅니다.');
      }
      recorded.push({id: spec.id, revision: spec.revision});
    }
    await writeAndroidReceipt(sdkRoot, {licenses, packages: recorded, recordedAt: now()});
  }

  async #cleanupOrphans(): Promise<void> {
    await mkdir(this.#root, {recursive: true, mode: 0o700});
    for (const name of ['.downloads', '.stage', '.homes']) {
      await rm(join(this.#root, name), {recursive: true, force: true});
    }
  }

  async #cleanupJob(id: string): Promise<void> {
    for (const folder of ['.downloads', '.stage', '.homes']) {
      await rm(join(this.#root, folder, id), {recursive: true, force: true});
    }
  }
}

function androidPackageSpecSafe(id: string): boolean {
  try { androidPackageSpec(id); return true; } catch { return false; }
}
