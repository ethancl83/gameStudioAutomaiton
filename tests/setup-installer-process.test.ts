import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { GOOGLE_DL_HOSTS } from '../packages/setup/catalog.js';
import { INSTALLER_CLOSE_TIMEOUT_MS, runIsolated, ToolInstaller } from '../packages/setup/installer.js';
import type { DownloadPackage } from '../packages/setup/catalog.js';
import type { ToolInstall, ToolSettings } from '../packages/setup/types.js';

async function tempDir(t: { after: (fn: () => void | Promise<void>) => void }, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

function sha256(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }

function androidZip(): {pkg: DownloadPackage; body: Uint8Array} {
  const bytes = zipSync({
    'cmdline-tools/lib/sdkmanager-classpath.jar': Buffer.from('jar'),
    'cmdline-tools/bin/sdkmanager': Buffer.from('#!/bin/sh\nexit 0\n'),
  });
  return {
    body: bytes,
    pkg: {
      name: 'commandlinetools-linux-15859902_latest.zip',
      url: 'https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip',
      sha256: sha256(bytes), version: '15859902', kind: 'android-sdk', archive: 'zip',
      maxBytes: 8 * 1024 * 1024, allowedHosts: GOOGLE_DL_HOSTS,
    },
  };
}

async function waitStatus(installer: ToolInstaller, id: string, status: ToolInstall['status'] | ToolInstall['status'][], timeoutMs = 8000): Promise<ToolInstall> {
  const wanted = new Set(Array.isArray(status) ? status : [status]);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = installer.list().find(item => item.id === id);
    if (job && wanted.has(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('job did not reach ' + [...wanted].join(',') + ': ' + JSON.stringify(installer.list()));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

test('runIsolated abort kills descendant processes and settles before the command timeout', async t => {
  const directory = await tempDir(t, 'appops-proc-abort-');
  const marker = join(directory, 'out.txt');
  const pidFile = join(directory, 'grandchild.pid');
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 250);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    () => runIsolated('/bin/sh', [
      '-c',
      'sh -c \'echo $$ > "$1"; while true; do echo x >> "$2"; sleep 0.05; done\' inline "$1" "$2" & sleep 60',
      'wrapper',
      pidFile,
      marker,
    ], {
      cwd: directory,
      env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: directory},
      signal: controller.signal,
      timeoutMs: 30_000,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.ok(Date.now() - started < 2_000, `abort waited too long: ${Date.now() - started}ms`);
  await new Promise(resolve => setTimeout(resolve, 250));
  const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
  if (pid) assert.equal(alive(pid), false, `grandchild ${pid} still running`);
  const size1 = (await stat(marker).catch(() => ({size: 0}))).size;
  await new Promise(resolve => setTimeout(resolve, 300));
  const size2 = (await stat(marker).catch(() => ({size: 0}))).size;
  assert.equal(size2, size1);
});

test('installer close aborts a live sdkmanager tree within the close bound', async t => {
  const directory = await tempDir(t, 'appops-proc-close-');
  const sdk = androidZip();
  const javaHome = join(directory, 'jdk');
  await mkdir(join(javaHome, 'bin'), {recursive: true});
  const hang = `#!/bin/sh
root=""
for argument in "$@"; do
  case "$argument" in
    --sdk_root=*) root=\${argument#--sdk_root=} ;;
  esac
done
if [ -n "$root" ]; then
  echo $$ > "$root/sdkmanager.pid"
  sh -c 'echo $$ > "$1/grandchild.pid"; while true; do sleep 1; done' inline "$root" &
fi
sleep 60
`;
  await writeFile(join(javaHome, 'bin', 'java'), hang, {mode: 0o755});
  await chmod(join(javaHome, 'bin', 'java'), 0o755);
  let settings: ToolSettings = {javaHome};
  const installer = new ToolInstaller({
    root: join(directory, 'tools'),
    getSettings: () => settings,
    saveSettings: async next => { settings = {...next}; },
    persist: () => undefined,
    fetch: async () => new Response(Buffer.from(sdk.body), {status: 200, headers: {'content-length': String(sdk.body.byteLength)}}),
    platform: 'linux',
    arch: 'x64',
    resolvePackage: () => sdk.pkg,
  });
  t.after(() => installer.close());
  const started = installer.start('android-sdk', {acceptLicense: true});
  await waitStatus(installer, started.id, 'installing', 10_000);
  const stage = join(directory, 'tools', '.stage', started.id);
  const pidDeadline = Date.now() + 5_000;
  let sdkPid = 0;
  let grandPid = 0;
  while (Date.now() < pidDeadline) {
    sdkPid = Number((await readFile(join(stage, 'sdkmanager.pid'), 'utf8').catch(() => '')).trim());
    grandPid = Number((await readFile(join(stage, 'grandchild.pid'), 'utf8').catch(() => '')).trim());
    if (sdkPid) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(sdkPid, 'sdkmanager pid was not captured');
  const begin = Date.now();
  await installer.close();
  const elapsed = Date.now() - begin;
  assert.ok(elapsed < INSTALLER_CLOSE_TIMEOUT_MS + 1_000, `close took ${elapsed}ms`);
  const job = installer.list().find(item => item.id === started.id);
  assert.equal(job?.status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(alive(sdkPid), false, `sdkmanager ${sdkPid} still running`);
  if (grandPid) assert.equal(alive(grandPid), false, `grandchild ${grandPid} still running`);
});
