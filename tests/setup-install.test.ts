import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zipSync } from 'fflate';
import { AppError } from '../packages/domain/errors.js';
import {
  ANDROID_LICENSE_HASHES,
  ANDROID_PACKAGE_SPECS,
  DEFAULT_ANDROID_PACKAGES,
  GITHUB_RELEASE_HOSTS,
  GODOT_TEMPLATE_RELEASE,
  GOOGLE_DL_HOSTS,
  PLAY_TARGET_API,
  TEMURIN_JAVA_VERSION,
  androidSdkVersionKey,
  normalizeAndroidPackages,
  packageFor,
  type DownloadPackage,
} from '../packages/setup/catalog.js';
import { readAndroidReceipt, ToolInstaller, type ToolInstallerOptions } from '../packages/setup/installer.js';
import type { ToolId, ToolInstall, ToolSettings } from '../packages/setup/types.js';

async function tempDir(t: { after: (fn: () => void | Promise<void>) => void }, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

function sha256(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }

function zipPackage(files: Record<string, string | Uint8Array>): {bytes: Uint8Array; sha256: string} {
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, typeof content === 'string' ? Buffer.from(content) : content])));
  return {bytes, sha256: sha256(bytes)};
}

function fixturePackage(kind: DownloadPackage['kind'], files: Record<string, string | Uint8Array>, extra: Partial<DownloadPackage> = {}): {pkg: DownloadPackage; body: Uint8Array} {
  const zipped = zipPackage(files);
  const name = extra.name ?? `${kind}.zip`;
  return {
    body: zipped.bytes,
    pkg: {
      name, url: `https://github.com/godotengine/godot-builds/releases/download/4.3-stable/${name}`,
      sha256: zipped.sha256, version: extra.version ?? '4.3', kind, archive: 'zip', maxBytes: 8 * 1024 * 1024,
      allowedHosts: extra.allowedHosts ?? GITHUB_RELEASE_HOSTS, entry: extra.entry, ...extra,
    },
  };
}

function staticFetch(urlToBody: Record<string, Uint8Array>, onRequest?: (url: string) => void): typeof fetch {
  const bodies = new Map(Object.entries(urlToBody).map(([url, body]) => [new URL(url).href, body]));
  return async (input, init) => {
    const url = new URL(String(input)).href;
    onRequest?.(url);
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), {name: 'AbortError'});
    const body = bodies.get(url);
    if (!body) return new Response(null, {status: 404});
    return new Response(Buffer.from(body), {status: 200, headers: {'content-length': String(body.byteLength)}});
  };
}

async function waitJob(installer: ToolInstaller, id: string, timeoutMs = 8000): Promise<ToolInstall> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = installer.list().find(item => item.id === id);
    if (job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled')) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish: ' + JSON.stringify(installer.list()));
}

function createInstaller(t: { after: (fn: () => void | Promise<void>) => void }, directory: string, options: Partial<ToolInstallerOptions> & {failSettings?: boolean} = {}) {
  let settings: ToolSettings = {...(options as {settings?: ToolSettings}).settings};
  const persisted: ToolInstall[][] = [];
  const installer = new ToolInstaller({
    root: join(directory, 'tools'),
    getSettings: () => settings,
    saveSettings: async next => {
      if (options.failSettings) throw new Error('settings write failed');
      settings = {...next};
    },
    persist: jobs => { persisted.push(jobs.map(job => ({...job}))); },
    fetch: options.fetch,
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    initialJobs: options.initialJobs,
    resolvePackage: options.resolvePackage,
  });
  t.after(() => installer.close());
  return {installer, persisted, settings: () => settings, setSettings: (next: ToolSettings) => { settings = next; }};
}

test('start is synchronous, serializes jobs, and installs Godot and templates into versioned folders', async t => {
  const directory = await tempDir(t, 'appops-inst-');
  const editor = fixturePackage('godot', {'Godot_v4.3-stable_linux.x86_64': '#!/bin/true\n'}, {entry: 'Godot_v4.3-stable_linux.x86_64', name: 'Godot_v4.3-stable_linux.x86_64.zip'});
  const templates = fixturePackage('godot-templates', {'templates/version.txt': '4.3.stable\n', 'templates/linux_release.x86_64': 'template'}, {name: 'Godot_v4.3-stable_export_templates.tpz'});
  const {installer, settings} = createInstaller(t, directory, {
    fetch: staticFetch({[editor.pkg.url]: editor.body, [templates.pkg.url]: templates.body}),
    resolvePackage: (id: ToolId) => id === 'godot' ? editor.pkg : id === 'godot-templates' ? templates.pkg : packageFor(id, 'linux', 'x64'),
  });
  const first = installer.start('godot');
  const second = installer.start('godot-templates');
  assert.equal(first.status, 'queued');
  assert.equal(second.status, 'queued');
  const listed = installer.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[1]?.status, 'queued');
  const done = await waitJob(installer, first.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(settings().godot?.endsWith('Godot_v4.3-stable_linux.x86_64'), true);
  assert.equal(await readFile(settings().godot!, 'utf8'), '#!/bin/true\n');
  const templatesDone = await waitJob(installer, second.id);
  assert.equal(templatesDone.status, 'succeeded');
  assert.ok(settings().godotData);
  assert.equal(await readFile(join(settings().godotData!, 'export_templates', GODOT_TEMPLATE_RELEASE, 'version.txt'), 'utf8'), '4.3.stable\n');
});

test('digest mismatch fails the job and does not change settings', async t => {
  const directory = await tempDir(t, 'appops-digest-');
  const editor = fixturePackage('godot', {'Godot_v4.3-stable_linux.x86_64': 'editor'}, {entry: 'Godot_v4.3-stable_linux.x86_64'});
  const wrong: DownloadPackage = {...editor.pkg, sha256: sha256(Buffer.from('not-the-bytes'))};
  const {installer, settings} = createInstaller(t, directory, {
    fetch: staticFetch({[wrong.url]: editor.body}),
    resolvePackage: () => wrong,
  });
  const job = await waitJob(installer, installer.start('godot').id);
  assert.equal(job.status, 'failed');
  assert.match(job.message, /SHA-256|다릅니다/);
  assert.equal(settings().godot, undefined);
});

test('interrupted jobs fail on restart and leftover stages are removed', async t => {
  const directory = await tempDir(t, 'appops-restart-');
  const stage = join(directory, 'tools', '.stage', 'old-job');
  await mkdir(stage, {recursive: true});
  await writeFile(join(stage, 'partial'), 'leftover');
  const {installer} = createInstaller(t, directory, {
    initialJobs: [{
      id: 'old-job', toolId: 'godot', status: 'downloading', progress: 10, message: '받는 중',
      bytes: 10, totalBytes: 100, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }],
  });
  const recovered = installer.list()[0];
  assert.equal(recovered?.status, 'failed');
  assert.match(recovered?.message ?? '', /중단/);
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(() => readdir(stage));
});

test('settings save failure keeps the previous active version', async t => {
  const directory = await tempDir(t, 'appops-settings-');
  const editor = fixturePackage('godot', {'Godot_v4.3-stable_linux.x86_64': 'new-editor'}, {entry: 'Godot_v4.3-stable_linux.x86_64'});
  const previous = join(directory, 'old-godot');
  await writeFile(previous, 'old-editor');
  const created = createInstaller(t, directory, {
    failSettings: true,
    fetch: staticFetch({[editor.pkg.url]: editor.body}),
    resolvePackage: () => editor.pkg,
  });
  created.setSettings({godot: previous});
  const job = await waitJob(created.installer, created.installer.start('godot').id);
  assert.equal(job.status, 'failed');
  assert.match(job.message, /설정 저장/);
  assert.equal(created.settings().godot, previous);
  assert.equal(await readFile(previous, 'utf8'), 'old-editor');
});

test('cancel stops an in-flight download', async t => {
  const directory = await tempDir(t, 'appops-cancel-');
  const editor = fixturePackage('godot', {'Godot_v4.3-stable_linux.x86_64': 'x'}, {entry: 'Godot_v4.3-stable_linux.x86_64'});
  const fetchSlow: typeof fetch = async (input, init) => new Response(new ReadableStream({
    start(controller) {
      const abort = (): void => controller.error(Object.assign(new Error('aborted'), {name: 'AbortError'}));
      init?.signal?.addEventListener('abort', abort, {once: true});
      controller.enqueue(editor.body.subarray(0, 1));
    },
  }), {status: 200, headers: {'content-length': String(editor.body.byteLength)}});
  const {installer} = createInstaller(t, directory, {fetch: fetchSlow, resolvePackage: () => editor.pkg});
  const started = installer.start('godot');
  await new Promise(resolve => setTimeout(resolve, 30));
  const cancelled = installer.cancel(started.id);
  assert.equal(cancelled?.status, 'cancelled');
  const done = await waitJob(installer, started.id);
  assert.equal(done.status, 'cancelled');
});

function sdkmanagerStub(options: {failPackage?: string; symlink?: 'internal' | 'external'} = {}): string {
  const fail = options.failPackage ?? '';
  const symlink = options.symlink ?? '';
  return `#!/bin/sh
root=""
fail_pkg="${fail}"
symlink_mode="${symlink}"
for argument in "$@"; do
  case "$argument" in
    --sdk_root=*) root=\${argument#--sdk_root=} ;;
    --licenses) echo "licenses are not accepted in bulk" >&2; exit 3 ;;
    -version) echo 'openjdk version "21.0.12"' >&2; exit 0 ;;
  esac
done
if [ -z "$root" ]; then exit 0; fi
env > "$root/env-captured.txt"
for argument in "$@"; do
  if [ -n "$fail_pkg" ] && [ "$argument" = "$fail_pkg" ]; then
    echo "refusing $fail_pkg" >&2
    exit 2
  fi
done
install_one() {
  if [ "$1" = "platform-tools" ]; then
    mkdir -p "$root/platform-tools"
    cat > "$root/platform-tools/source.properties" <<'EOF'
Pkg.Revision=37.0.1
EOF
    cat > "$root/platform-tools/adb" <<'EOF'
#!/bin/sh
echo 'Android Debug Bridge version 1.0.41'
exit 0
EOF
    chmod 755 "$root/platform-tools/adb"
  elif [ "$1" = "platforms;android-34" ]; then
    mkdir -p "$root/platforms/android-34"
    cat > "$root/platforms/android-34/source.properties" <<'EOF'
Pkg.Revision=3
AndroidVersion.ApiLevel=34
EOF
    printf 'jar\\n' > "$root/platforms/android-34/android.jar"
  elif [ "$1" = "platforms;android-35" ]; then
    mkdir -p "$root/platforms/android-35"
    cat > "$root/platforms/android-35/source.properties" <<'EOF'
Pkg.Revision=2
AndroidVersion.ApiLevel=35
EOF
    printf 'jar\\n' > "$root/platforms/android-35/android.jar"
  elif [ "$1" = "platforms;android-36" ]; then
    mkdir -p "$root/platforms/android-36"
    cat > "$root/platforms/android-36/source.properties" <<'EOF'
Pkg.Revision=2
AndroidVersion.ApiLevel=36
EOF
    printf 'jar\\n' > "$root/platforms/android-36/android.jar"
  elif [ "$1" = "build-tools;34.0.0" ] || [ "$1" = "build-tools;35.0.0" ] || [ "$1" = "build-tools;36.0.0" ] || [ "$1" = "build-tools;36.1.0" ]; then
    ver=\${1#build-tools;}
    mkdir -p "$root/build-tools/$ver/lib"
    cat > "$root/build-tools/$ver/source.properties" <<EOF
Pkg.Revision=$ver
EOF
    cat > "$root/build-tools/$ver/aapt2" <<'EOF'
#!/bin/sh
echo 'Android Asset Packaging Tool (aapt) 2.19'
exit 0
EOF
    chmod 755 "$root/build-tools/$ver/aapt2"
    printf 'jar\\n' > "$root/build-tools/$ver/lib/apksigner.jar"
  elif [ "$1" = "ndk;27.3.13750724" ]; then
    mkdir -p "$root/ndk/27.3.13750724"
    cat > "$root/ndk/27.3.13750724/source.properties" <<'EOF'
Pkg.Revision=27.3.13750724
EOF
    cat > "$root/ndk/27.3.13750724/ndk-build" <<'EOF'
#!/bin/sh
exit 0
EOF
    chmod 755 "$root/ndk/27.3.13750724/ndk-build"
  elif [ "$1" = "cmake;3.22.1" ]; then
    mkdir -p "$root/cmake/3.22.1/bin"
    cat > "$root/cmake/3.22.1/source.properties" <<'EOF'
Pkg.Revision=3.22.1
EOF
    cat > "$root/cmake/3.22.1/bin/cmake" <<'EOF'
#!/bin/sh
exit 0
EOF
    chmod 755 "$root/cmake/3.22.1/bin/cmake"
  fi
}
for argument in "$@"; do
  install_one "$argument"
done
if [ "$symlink_mode" = "internal" ]; then
  ln -s adb "$root/platform-tools/adb-alias"
fi
if [ "$symlink_mode" = "external" ]; then
  ln -s /etc/passwd "$root/platform-tools/outside"
fi
exit 0
`;
}

async function writeJavaHome(directory: string, stub: string): Promise<string> {
  const javaHome = join(directory, 'jdk');
  await mkdir(join(javaHome, 'bin'), {recursive: true});
  await writeFile(join(javaHome, 'bin', 'java'), stub, {mode: 0o755});
  await chmod(join(javaHome, 'bin', 'java'), 0o755);
  return javaHome;
}

function androidFixture(): {pkg: DownloadPackage; body: Uint8Array} {
  return fixturePackage('android-sdk', {
    'cmdline-tools/lib/sdkmanager-classpath.jar': 'jar',
    'cmdline-tools/bin/sdkmanager': '#!/bin/sh\nexit 0\n',
  }, {
    name: 'commandlinetools-linux-15859902_latest.zip',
    url: 'https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip',
    version: '15859902',
    allowedHosts: GOOGLE_DL_HOSTS,
    expectedLayout: ['cmdline-tools/latest/lib'],
  });
}

test('android install requires license, uses isolated env, and does not inherit secrets', async t => {
  const directory = await tempDir(t, 'appops-sdk-');
  process.env.APPOPS_TEST_SECRET = 'super-secret-token-value';
  t.after(() => { delete process.env.APPOPS_TEST_SECRET; });
  const sdk = androidFixture();
  const javaHome = await writeJavaHome(directory, sdkmanagerStub());
  const {installer, setSettings, settings} = createInstaller(t, directory, {
    fetch: staticFetch({[sdk.pkg.url]: sdk.body}),
    resolvePackage: (id: ToolId) => id === 'android-sdk' ? sdk.pkg : packageFor(id, 'linux', 'x64'),
  });
  assert.throws(() => installer.start('android-sdk'), (error: unknown) => error instanceof AppError && error.code === 'LICENSE_REQUIRED');
  assert.throws(() => installer.start('android-sdk', {acceptLicense: true, androidPackages: ['platforms;android-99']}),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT');
  setSettings({javaHome});
  const job = await waitJob(installer, installer.start('android-sdk', {acceptLicense: true}).id, 15_000);
  assert.equal(job.status, 'succeeded', job.message);
  const sdkRoot = settings().androidSdk!;
  const envDump = await readFile(join(sdkRoot, 'env-captured.txt'), 'utf8');
  assert.doesNotMatch(envDump, /super-secret-token-value/);
  assert.match(envDump, /JAVA_HOME=/);
  assert.ok(await readdir(join(sdkRoot, 'platform-tools')));
  assert.ok(await readdir(join(sdkRoot, 'platforms', 'android-36')));
  const receipt = await readAndroidReceipt(sdkRoot);
  assert.ok(receipt);
  assert.deepEqual(receipt.packages.map(item => item.id), normalizeAndroidPackages([...DEFAULT_ANDROID_PACKAGES]));
  assert.equal(receipt.packages.find(item => item.id === 'platforms;android-36')?.revision, ANDROID_PACKAGE_SPECS['platforms;android-36']?.revision);
  assert.equal(receipt.packages.find(item => item.id === 'build-tools;36.0.0')?.revision, '36.0.0');
  assert.equal(receipt.packages.find(item => item.id === 'platform-tools')?.revision, ANDROID_PACKAGE_SPECS['platform-tools']?.revision);
  assert.equal(receipt.licenses.length, 1);
  assert.equal(receipt.licenses[0]?.id, 'android-sdk-license');
  assert.ok(receipt.licenses[0]?.hashes.includes(ANDROID_LICENSE_HASHES['android-sdk-license']![0]!));
  assert.equal(job.receipt?.licenses[0]?.id, 'android-sdk-license');
  assert.ok(sdkRoot.endsWith(androidSdkVersionKey('15859902', [...DEFAULT_ANDROID_PACKAGES])));
});

function tarHeader(options: {name: string; size: number; type?: string}): Buffer {
  const header = Buffer.alloc(512);
  header.write(options.name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(options.size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(options.type ?? '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function tarGz(entries: {name: string; content?: Buffer; type?: string}[]): Uint8Array {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    parts.push(tarHeader({name: entry.name, size: content.length, type: entry.type}), content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test('jdk install extracts a pinned tar.gz into a home with bin/java', async t => {
  const directory = await tempDir(t, 'appops-jdk-');
  const javaScript = Buffer.from('#!/bin/sh\necho \'openjdk version "21.0.12.1" 2026-08-18\' >&2\nexit 0\n');
  const javacScript = Buffer.from('#!/bin/sh\necho \'javac 21.0.12.1\' >&2\nexit 0\n');
  const archive = tarGz([
    {name: 'jdk-21.0.12.1+1/bin/', type: '5'},
    {name: 'jdk-21.0.12.1+1/bin/java', content: javaScript, type: '0'},
    {name: 'jdk-21.0.12.1+1/bin/javac', content: javacScript, type: '0'},
    {name: 'jdk-21.0.12.1+1/release', content: Buffer.from('JAVA_VERSION="21.0.12.1"\nIMPLEMENTOR="Eclipse Adoptium"\n'), type: '0'},
  ]);
  const pkg: DownloadPackage = {
    name: 'OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz',
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1+1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz',
    sha256: sha256(archive), version: '21.0.12.1+1', kind: 'jdk', archive: 'tar.gz', maxBytes: 8 * 1024 * 1024,
    allowedHosts: GITHUB_RELEASE_HOSTS, expectedVersion: TEMURIN_JAVA_VERSION, expectedLayout: ['bin/java', 'bin/javac'],
  };
  const {installer, settings} = createInstaller(t, directory, {
    fetch: staticFetch({[pkg.url]: archive}),
    resolvePackage: () => pkg,
  });
  const job = await waitJob(installer, installer.start('jdk').id);
  assert.equal(job.status, 'succeeded', job.message);
  assert.equal(settings().javaHome?.endsWith('jdk-21.0.12.1+1'), true);
  assert.match(await readFile(join(settings().javaHome!, 'bin', 'java'), 'utf8'), /21\.0\.12/);
});

test('jdk install fails closed when java version output drifts from the catalog', async t => {
  const directory = await tempDir(t, 'appops-jdk-drift-');
  const javaScript = Buffer.from('#!/bin/sh\necho \'openjdk version "22.0.1"\' >&2\nexit 0\n');
  const javacScript = Buffer.from('#!/bin/sh\necho \'javac 22.0.1\' >&2\nexit 0\n');
  const archive = tarGz([
    {name: 'jdk-22/bin/', type: '5'},
    {name: 'jdk-22/bin/java', content: javaScript, type: '0'},
    {name: 'jdk-22/bin/javac', content: javacScript, type: '0'},
    {name: 'jdk-22/release', content: Buffer.from('JAVA_VERSION="22.0.1"\n'), type: '0'},
  ]);
  const pkg: DownloadPackage = {
    name: 'OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz',
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1+1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz',
    sha256: sha256(archive), version: '21.0.12.1+1', kind: 'jdk', archive: 'tar.gz', maxBytes: 8 * 1024 * 1024,
    allowedHosts: GITHUB_RELEASE_HOSTS, expectedVersion: TEMURIN_JAVA_VERSION,
  };
  const {installer, settings} = createInstaller(t, directory, {
    fetch: staticFetch({[pkg.url]: archive}),
    resolvePackage: () => pkg,
  });
  const job = await waitJob(installer, installer.start('jdk').id);
  assert.equal(job.status, 'failed', job.message);
  assert.match(job.message, /버전|폴더 구조|다릅니다/);
  assert.equal(settings().javaHome, undefined);
});

test('android package expansion uses a new version path and keeps the previous SDK when install fails', async t => {
  const directory = await tempDir(t, 'appops-sdk-expand-fail-');
  const sdk = androidFixture();
  const javaHome = await writeJavaHome(directory, sdkmanagerStub({failPackage: 'platforms;android-35'}));
  const created = createInstaller(t, directory, {
    fetch: staticFetch({[sdk.pkg.url]: sdk.body}),
    resolvePackage: (id: ToolId) => id === 'android-sdk' ? sdk.pkg : packageFor(id, 'linux', 'x64'),
  });
  created.setSettings({javaHome});
  const first = await waitJob(created.installer, created.installer.start('android-sdk', {acceptLicense: true}).id, 15_000);
  assert.equal(first.status, 'succeeded', first.message);
  const previous = created.settings().androidSdk!;
  assert.ok(await readFile(join(previous, 'platforms/android-36/android.jar')));
  const second = await waitJob(created.installer, created.installer.start('android-sdk', {
    acceptLicense: true, androidPackages: ['platforms;android-35'],
  }).id, 15_000);
  assert.equal(second.status, 'failed', second.message);
  assert.equal(created.settings().androidSdk, previous);
  assert.equal(await readFile(join(previous, 'platforms/android-36/android.jar'), 'utf8'), 'jar\n');
  await assert.rejects(() => readdir(join(previous, 'platforms', 'android-35')));
});

test('android package expansion copies prior components into a new package-set folder', async t => {
  const directory = await tempDir(t, 'appops-sdk-expand-ok-');
  const sdk = androidFixture();
  const javaHome = await writeJavaHome(directory, sdkmanagerStub());
  const created = createInstaller(t, directory, {
    fetch: staticFetch({[sdk.pkg.url]: sdk.body}),
    resolvePackage: (id: ToolId) => id === 'android-sdk' ? sdk.pkg : packageFor(id, 'linux', 'x64'),
  });
  created.setSettings({javaHome});
  const first = await waitJob(created.installer, created.installer.start('android-sdk', {acceptLicense: true}).id, 15_000);
  assert.equal(first.status, 'succeeded', first.message);
  const previous = created.settings().androidSdk!;
  const second = await waitJob(created.installer, created.installer.start('android-sdk', {
    acceptLicense: true, androidPackages: ['platforms;android-35'],
  }).id, 15_000);
  assert.equal(second.status, 'succeeded', second.message);
  const next = created.settings().androidSdk!;
  assert.notEqual(next, previous);
  assert.ok(await readFile(join(previous, 'platforms/android-36/android.jar')));
  assert.ok(await readFile(join(next, 'platforms/android-36/android.jar')));
  assert.ok(await readFile(join(next, 'platforms/android-35/android.jar')));
  const receipt = await readAndroidReceipt(next);
  assert.ok(receipt?.packages.some(item => item.id === 'platforms;android-35' && item.revision === '2'));
  assert.ok(receipt?.packages.some(item => item.id === 'platforms;android-36' && item.revision === '2'));
});

test('android install allows internal symlinks and rejects links that escape the SDK root', async t => {
  const directory = await tempDir(t, 'appops-sdk-links-');
  const sdk = androidFixture();
  const internalHome = await writeJavaHome(join(directory, 'internal'), sdkmanagerStub({symlink: 'internal'}));
  const internal = createInstaller(t, join(directory, 'ok'), {
    fetch: staticFetch({[sdk.pkg.url]: sdk.body}),
    resolvePackage: (id: ToolId) => id === 'android-sdk' ? sdk.pkg : packageFor(id, 'linux', 'x64'),
  });
  internal.setSettings({javaHome: internalHome});
  const ok = await waitJob(internal.installer, internal.installer.start('android-sdk', {acceptLicense: true}).id, 15_000);
  assert.equal(ok.status, 'succeeded', ok.message);

  const externalHome = await writeJavaHome(join(directory, 'external'), sdkmanagerStub({symlink: 'external'}));
  const external = createInstaller(t, join(directory, 'bad'), {
    fetch: staticFetch({[sdk.pkg.url]: sdk.body}),
    resolvePackage: (id: ToolId) => id === 'android-sdk' ? sdk.pkg : packageFor(id, 'linux', 'x64'),
  });
  external.setSettings({javaHome: externalHome});
  const bad = await waitJob(external.installer, external.installer.start('android-sdk', {acceptLicense: true}).id, 15_000);
  assert.equal(bad.status, 'failed', bad.message);
  assert.match(bad.message, /링크|외부/);
  assert.equal(external.settings().androidSdk, undefined);
});

test('android install fails closed when source.properties revision drifts from the catalog', async t => {
  const directory = await tempDir(t, 'appops-sdk-drift-');
  const sdk = androidFixture();
  const stub = sdkmanagerStub().replace('Pkg.Revision=2\nAndroidVersion.ApiLevel=36', 'Pkg.Revision=1\nAndroidVersion.ApiLevel=36');
  const javaHome = await writeJavaHome(directory, stub);
  const created = createInstaller(t, directory, {
    fetch: staticFetch({[sdk.pkg.url]: sdk.body}),
    resolvePackage: (id: ToolId) => id === 'android-sdk' ? sdk.pkg : packageFor(id, 'linux', 'x64'),
  });
  created.setSettings({javaHome});
  const job = await waitJob(created.installer, created.installer.start('android-sdk', {acceptLicense: true}).id, 15_000);
  assert.equal(job.status, 'failed', job.message);
  assert.equal(created.settings().androidSdk, undefined);
});

test('API 34 remains an explicit install option and is not the default', async t => {
  const directory = await tempDir(t, 'appops-sdk-34-');
  const sdk = androidFixture();
  const javaHome = await writeJavaHome(directory, sdkmanagerStub());
  const created = createInstaller(t, directory, {
    fetch: staticFetch({[sdk.pkg.url]: sdk.body}),
    resolvePackage: (id: ToolId) => id === 'android-sdk' ? sdk.pkg : packageFor(id, 'linux', 'x64'),
  });
  created.setSettings({javaHome});
  const job = await waitJob(created.installer, created.installer.start('android-sdk', {
    acceptLicense: true,
    androidPackages: ['platform-tools', 'platforms;android-34', 'build-tools;34.0.0'],
  }).id, 15_000);
  assert.equal(job.status, 'succeeded', job.message);
  const root = created.settings().androidSdk!;
  assert.ok(await readFile(join(root, 'platforms/android-34/android.jar')));
  await assert.rejects(() => readdir(join(root, 'platforms', 'android-36')));
});

test('NDK is installed only when explicitly requested from the pinned catalog', async t => {
  const directory = await tempDir(t, 'appops-sdk-ndk-');
  const sdk = androidFixture();
  const javaHome = await writeJavaHome(directory, sdkmanagerStub());
  const created = createInstaller(t, directory, {
    fetch: staticFetch({[sdk.pkg.url]: sdk.body}),
    resolvePackage: (id: ToolId) => id === 'android-sdk' ? sdk.pkg : packageFor(id, 'linux', 'x64'),
  });
  created.setSettings({javaHome});
  const job = await waitJob(created.installer, created.installer.start('android-sdk', {
    acceptLicense: true,
    androidPackages: [...DEFAULT_ANDROID_PACKAGES, 'ndk;27.3.13750724'],
  }).id, 15_000);
  assert.equal(job.status, 'succeeded', job.message);
  const root = created.settings().androidSdk!;
  assert.ok(await readFile(join(root, 'ndk/27.3.13750724/ndk-build')));
  const receipt = await readAndroidReceipt(root);
  assert.ok(receipt?.packages.some(item => item.id === 'ndk;27.3.13750724'));
});

test('catalog pins expected versions and official Android package revisions', () => {
  const jdk = packageFor('jdk', 'linux', 'x64');
  assert.equal(jdk.expectedVersion, TEMURIN_JAVA_VERSION);
  assert.ok(jdk.expectedLayout?.includes('bin/java'));
  const godot = packageFor('godot', 'linux', 'x64');
  assert.equal(godot.expectedVersion, '4.3');
  assert.equal(PLAY_TARGET_API.newAppsAndUpdates, 36);
  assert.equal(PLAY_TARGET_API.existingAppsDiscoverable, 35);
  assert.equal(PLAY_TARGET_API.tvAndXr, 34);
  assert.deepEqual([...DEFAULT_ANDROID_PACKAGES], ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0']);
  assert.ok(!DEFAULT_ANDROID_PACKAGES.some(name => name.startsWith('ndk;') || name.startsWith('cmake;')));
  assert.equal(ANDROID_PACKAGE_SPECS['platform-tools']?.revision, '37.0.1');
  assert.equal(ANDROID_PACKAGE_SPECS['platforms;android-34']?.revision, '3');
  assert.equal(ANDROID_PACKAGE_SPECS['platforms;android-35']?.revision, '2');
  assert.equal(ANDROID_PACKAGE_SPECS['platforms;android-36']?.revision, '2');
  assert.equal(ANDROID_PACKAGE_SPECS['build-tools;34.0.0']?.revision, '34.0.0');
  assert.equal(ANDROID_PACKAGE_SPECS['build-tools;36.0.0']?.revision, '36.0.0');
  assert.equal(ANDROID_PACKAGE_SPECS['build-tools;36.1.0']?.revision, '36.1.0');
  assert.equal(ANDROID_PACKAGE_SPECS['ndk;27.3.13750724']?.revision, '27.3.13750724');
  assert.equal(ANDROID_PACKAGE_SPECS['cmake;3.22.1']?.revision, '3.22.1');
  assert.deepEqual(normalizeAndroidPackages(['platforms;android-34', 'platform-tools', 'platform-tools']),
    ['platform-tools', 'platforms;android-34']);
  assert.deepEqual(normalizeAndroidPackages(['ndk;27.3.13750724']), ['ndk;27.3.13750724']);
  assert.throws(() => normalizeAndroidPackages(['ndk;26.1.10909125']), (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT');
  assert.throws(() => normalizeAndroidPackages(['cmake;latest']), (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT');
});

test('manual tools stay explicit and unity is never reported as installed from a catalog URL', () => {
  assert.throws(() => packageFor('unity'), (error: unknown) => error instanceof AppError && error.code === 'MANUAL_INSTALL');
  assert.throws(() => packageFor('unreal'), (error: unknown) => error instanceof AppError && error.code === 'MANUAL_INSTALL');
  assert.throws(() => packageFor('xcode'), (error: unknown) => error instanceof AppError && error.code === 'MANUAL_INSTALL');
});
