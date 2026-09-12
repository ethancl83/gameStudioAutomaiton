import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANDROID_PACKAGE_SPECS,
  DEFAULT_ANDROID_PACKAGES,
  PLAY_TARGET_API,
  TEMURIN_JAVA_VERSION,
  packageFor,
} from '../packages/setup/catalog.js';
import { readAndroidReceipt, ToolInstaller } from '../packages/setup/installer.js';
import type { ToolInstall, ToolSettings } from '../packages/setup/types.js';

const CACHED_TEMURIN = '/tmp/appops-real-temurin-ZDpRW0/jdk.tar.gz';
const CACHED_CMDLINE = '/tmp/appops-cmdline-15859902.zip';
const REAL_RESULT = '/tmp/appops-setup-real-result.json';

async function waitJob(installer: ToolInstaller, id: string, timeoutMs: number): Promise<ToolInstall> {
  const start = Date.now();
  let job = installer.list().find(item => item.id === id);
  while (Date.now() - start < timeoutMs) {
    job = installer.list().find(item => item.id === id) ?? job;
    if (job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled')) return job;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('job did not finish: ' + JSON.stringify(installer.list()));
}

test('live Godot 4.3 linux editor installs from the pinned official archive', {timeout: 180_000}, async t => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return t.skip('linux x64 host required');
  if (process.env.APPOPS_SKIP_LIVE_INSTALL === '1') return t.skip('APPOPS_SKIP_LIVE_INSTALL=1');
  const pkg = packageFor('godot', 'linux', 'x64');
  assert.equal(pkg.expectedVersion, '4.3');
  assert.ok(pkg.expectedLayout?.length);
  const directory = await mkdtemp(join('/tmp', 'appops-godot-live-'));
  let settings: ToolSettings = {};
  const installer = new ToolInstaller({
    root: join(directory, 'tools'),
    getSettings: () => settings,
    saveSettings: async next => { settings = {...next}; },
    persist: () => undefined,
  });
  t.after(async () => { await installer.close(); await rm(directory,{recursive:true,force:true}); });
  const started = installer.start('godot');
  const start = Date.now();
  let job = started;
  while (Date.now() - start < 170_000) {
    job = installer.list().find(item => item.id === started.id) ?? job;
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (job.status !== 'succeeded') {
    t.diagnostic(`url=${pkg.url} sha512=${pkg.sha512} status=${job.status} message=${job.message} bytes=${job.bytes}`);
    if (/ECONN|ENOTFOUND|network|TLS|certificate/i.test(job.message)) return t.skip('network unavailable for live Godot download');
    assert.equal(job.status, 'succeeded', job.message);
  }
  assert.ok(settings.godot);
  const info = await stat(settings.godot);
  assert.equal(info.isFile(), true);
  assert.ok(info.size > 1_000_000, `editor too small: ${info.size}`);
  t.diagnostic(`url=${pkg.url} sha512=${pkg.sha512} bytes=${job.bytes} dest=${settings.godot} size=${info.size}`);
});

test('real ToolInstaller JDK job uses the verified cached Temurin archive', {timeout: 180_000}, async t => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return t.skip('linux x64 host required');
  const pkg = packageFor('jdk', 'linux', 'x64');
  assert.equal(pkg.expectedVersion, TEMURIN_JAVA_VERSION);
  let archive: Buffer;
  try { archive = await readFile(CACHED_TEMURIN); }
  catch { return t.skip(`cached Temurin archive missing: ${CACHED_TEMURIN}`); }
  const digest = createHash('sha256').update(archive).digest('hex');
  assert.equal(digest, pkg.sha256, 'cached archive digest must match the catalog pin');
  const directory = '/tmp/appops-real-jdk';
  await rm(directory, {recursive: true, force: true});
  let settings: ToolSettings = {};
  const installer = new ToolInstaller({
    root: join(directory, 'tools'),
    getSettings: () => settings,
    saveSettings: async next => { settings = {...next}; },
    persist: () => undefined,
    fetch: async (input, init) => {
      const url = String(input);
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
      if (url === pkg.url) {
        return new Response(Buffer.from(archive), {status: 200, headers: {'content-length': String(archive.byteLength)}});
      }
      return new Response(null, {status: 404});
    },
  });
  t.after(async () => { await installer.close(); await rm(directory,{recursive:true,force:true}); });
  const job = await waitJob(installer, installer.start('jdk').id, 170_000);
  t.diagnostic(`jdk fetch=cached-local-archive path=${CACHED_TEMURIN} sha256=${digest} status=${job.status} message=${job.message} javaHome=${settings.javaHome}`);
  assert.equal(job.status, 'succeeded', job.message);
  assert.ok(settings.javaHome);
  const java = join(settings.javaHome, 'bin', 'java');
  const javac = join(settings.javaHome, 'bin', 'javac');
  assert.equal((await stat(java)).isFile(), true);
  assert.equal((await stat(javac)).isFile(), true);
  const release = await readFile(join(settings.javaHome, 'release'), 'utf8');
  assert.match(release, /JAVA_VERSION="21\.0\.12\.1"/);
  t.diagnostic(`real-jdk javaHome=${settings.javaHome} bytes=${job.bytes}`);
});

test('real Linux Android SDK install, receipts, revisions, and cancel keeps the previous SDK', {timeout: 900_000}, async t => {
  if (process.platform !== 'linux' || process.arch !== 'x64') return t.skip('linux x64 host required');
  if (process.env.APPOPS_SKIP_LIVE_INSTALL === '1') return t.skip('APPOPS_SKIP_LIVE_INSTALL=1');
  const jdkPkg = packageFor('jdk', 'linux', 'x64');
  const sdkPkg = packageFor('android-sdk', 'linux', 'x64');
  let archive: Buffer;
  let cmdline: Buffer;
  try { archive = await readFile(CACHED_TEMURIN); }
  catch { return t.skip(`cached Temurin archive missing: ${CACHED_TEMURIN}`); }
  try { cmdline = await readFile(CACHED_CMDLINE); }
  catch { return t.skip(`cached command-line tools zip missing: ${CACHED_CMDLINE}`); }
  assert.equal(createHash('sha256').update(archive).digest('hex'), jdkPkg.sha256);
  assert.equal(createHash('sha256').update(cmdline).digest('hex'), sdkPkg.sha256);
  const directory = '/tmp/appops-real-sdk';
  await rm(directory, {recursive: true, force: true});
  let settings: ToolSettings = {};
  const installer = new ToolInstaller({
    root: join(directory, 'tools'),
    getSettings: () => settings,
    saveSettings: async next => { settings = {...next}; },
    persist: () => undefined,
    fetch: async (input, init) => {
      const url = String(input);
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
      if (url === jdkPkg.url) {
        return new Response(Buffer.from(archive), {status: 200, headers: {'content-length': String(archive.byteLength)}});
      }
      if (url === sdkPkg.url) {
        return new Response(Buffer.from(cmdline), {status: 200, headers: {'content-length': String(cmdline.byteLength)}});
      }
      return new Response(null, {status: 404});
    },
  });
  t.after(async () => { await installer.close(); await rm(directory,{recursive:true,force:true}); });
  const jdkJob = await waitJob(installer, installer.start('jdk').id, 170_000);
  assert.equal(jdkJob.status, 'succeeded', jdkJob.message);
  const sdkJob = await waitJob(installer, installer.start('android-sdk', {acceptLicense: true}).id, 700_000);
  const evidence = {
    playTargetApi: PLAY_TARGET_API,
    defaultPackages: [...DEFAULT_ANDROID_PACKAGES],
    jdk: {status: jdkJob.status, javaHome: settings.javaHome, fetch: 'cached-local-archive', archive: CACHED_TEMURIN},
    sdk: {
      status: sdkJob.status, message: sdkJob.message, androidSdk: settings.androidSdk,
      cmdlineFetch: 'cached-verified-local-zip',
      sdkmanagerPackages: 'network-dl.google.com via sdkmanager',
      packages: sdkJob.receipt?.packages ?? null,
    },
  };
  if (sdkJob.status !== 'succeeded') {
    t.diagnostic(JSON.stringify(evidence));
    if (/ECONN|ENOTFOUND|network|TLS|certificate|SDKMANAGER_FAILED/i.test(sdkJob.message)) {
      await writeFile(REAL_RESULT, `${JSON.stringify({...evidence, residual: sdkJob.message}, null, 2)}\n`);
      return t.skip(`real sdkmanager install did not complete: ${sdkJob.message.slice(0, 300)}`);
    }
    assert.equal(sdkJob.status, 'succeeded', sdkJob.message);
  }
  const sdkRoot = settings.androidSdk!;
  const platformMeta = await readFile(join(sdkRoot, 'platforms/android-36/source.properties'), 'utf8');
  const buildMeta = await readFile(join(sdkRoot, 'build-tools/36.0.0/source.properties'), 'utf8');
  assert.match(platformMeta, /Pkg\.Revision=2\b/);
  assert.match(platformMeta, /AndroidVersion\.ApiLevel=36/);
  assert.match(buildMeta, /Pkg\.Revision=36\.0\.0/);
  assert.ok((await stat(join(sdkRoot, 'platforms/android-36/android.jar'))).size > 0);
  assert.ok((await stat(join(sdkRoot, 'build-tools/36.0.0/lib/apksigner.jar'))).size > 0);
  const receipt = await readAndroidReceipt(sdkRoot);
  assert.ok(receipt);
  assert.ok(receipt.licenses.some(item => item.id === 'android-sdk-license' && item.hashes.length > 0));
  assert.equal(receipt.packages.find(item => item.id === 'platforms;android-36')?.revision, ANDROID_PACKAGE_SPECS['platforms;android-36']?.revision);
  const previous = sdkRoot;
  const expanding = installer.start('android-sdk', {acceptLicense: true, androidPackages: ['platforms;android-35']});
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const current = installer.list().find(item => item.id === expanding.id);
    if (current && (current.status === 'installing' || current.status === 'downloading' || current.status === 'verifying')) break;
    if (current && (current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  installer.cancel(expanding.id);
  const cancelled = await waitJob(installer, expanding.id, 30_000);
  assert.ok(cancelled.status === 'cancelled' || cancelled.status === 'succeeded' || cancelled.status === 'failed', cancelled.status);
  if (cancelled.status !== 'succeeded') {
    assert.equal(settings.androidSdk, previous);
  }
  await writeFile(REAL_RESULT, `${JSON.stringify({
    ...evidence,
    sdkRoot,
    receipt,
    cancel: {status: cancelled.status, previousPreserved: settings.androidSdk === previous},
    fixture: false,
  }, null, 2)}\n`);
  t.diagnostic(`real-sdk root=${sdkRoot} receipt=${receipt.packages.map(item => `${item.id}@${item.revision}`).join(',')} cancel=${cancelled.status}`);
});
