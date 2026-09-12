import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshot, executeBuild, probeIsolation } from '../apps/runner/index.js';
import type { BuildPlan, CommandSpec } from '../packages/domain/index.js';

async function tempDir(t: { after: (fn: () => void | Promise<void>) => void }, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(root: string, rel: string, contents: string): Promise<void> {
  const target = join(root, rel);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

async function mockBin(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, body, { mode: 0o755, encoding: 'utf8' });
  await chmod(file, 0o755);
  return file;
}

function planWith(command: CommandSpec, expectedArtifacts: string[], outputPath: string): BuildPlan {
  return {
    engine: 'godot',
    target: 'linux',
    sourcePath: command.cwd,
    outputPath,
    commands: [command],
    expectedArtifacts,
    findings: [],
  };
}

test('snapshot preserves restrictive wrapper executability and requires every build artifact', async t => {
  if (!(await probeIsolation()).available) return t.skip('bwrap unavailable');
  const root = await tempDir(t, 'appops-wrapper-');
  const source = join(root, 'source'); await mkdir(source);
  const wrapper = await mockBin(source, 'gradlew', '#!/bin/sh\n/bin/cp "$PWD/payload" "$1"\n');
  await writeFile(join(source, 'payload'), 'actual-wrapper-output');
  const snapshot = await createSnapshot(source, join(root, 'snapshot'));
  assert.equal((await stat(join(snapshot.path, 'gradlew'))).mode & 0o777, 0o700);
  await chmod(wrapper, 0o600);
  const nonExecutable = await createSnapshot(source, join(root, 'snapshot-noexec'));
  assert.notEqual(snapshot.hash, nonExecutable.hash);
  const output = join(root, 'output'); await mkdir(output);
  const artifact = join(output, 'app.aab');
  const plan = planWith({ executable: join(snapshot.path, 'gradlew'), args: [artifact], cwd: snapshot.path, label: 'Gradle wrapper' }, [artifact], output);
  assert.equal((await executeBuild(plan)).exitCode, 0);
  assert.equal(await readFile(artifact, 'utf8'), 'actual-wrapper-output');
  const incomplete = await executeBuild({ ...plan, expectedArtifacts: [artifact, join(output, 'required.pck')] });
  assert.notEqual(incomplete.exitCode, 0); assert.deepEqual(incomplete.artifacts, []);
});

test('createSnapshot copies inputs, skips caches/secrets/symlinks, and leaves the original untouched', async (t) => {
  const root = await tempDir(t, 'appops-snap-');
  const source = join(root, 'src');
  const dest = join(root, 'snap');
  await write(source, 'project.godot', 'config/name="A"\n');
  await write(source, 'scenes/main.tscn', '[gd_scene]\n');
  await write(source, '.godot/imported/cache.bin', 'CACHE');
  await write(source, 'Library/ArtifactDB', 'UNITY-CACHE');
  await write(source, '.env', 'SECRET=1\n');
  await write(source, 'keys/dev.pem', 'PRIVATE KEY\n');
  await write(source, 'id_rsa', 'ssh-secret\n');
  const outside = join(root, 'outside-secret.txt');
  await writeFile(outside, 'LEAK-ME\n');
  await symlink(outside, join(source, 'leak.link'));
  await symlink(join(source, 'scenes/main.tscn'), join(source, 'inside.link'));
  const before = await readFile(join(source, 'project.godot'), 'utf8');
  const secretBefore = await readFile(join(source, '.env'), 'utf8');
  await utimes(join(source, 'project.godot'), new Date(), new Date());
  const beforeStat = await stat(join(source, 'project.godot'));

  const snapshot = await createSnapshot(source, dest);
  assert.ok(snapshot.fileCount >= 2);
  assert.equal(await readFile(join(dest, 'project.godot'), 'utf8'), before);
  assert.equal(await readFile(join(dest, 'scenes/main.tscn'), 'utf8'), '[gd_scene]\n');
  await assert.rejects(readFile(join(dest, '.godot/imported/cache.bin')));
  await assert.rejects(readFile(join(dest, 'Library/ArtifactDB')));
  await assert.rejects(readFile(join(dest, '.env')));
  await assert.rejects(readFile(join(dest, 'keys/dev.pem')));
  await assert.rejects(readFile(join(dest, 'id_rsa')));
  await assert.rejects(readFile(join(dest, 'leak.link')));
  await assert.rejects(readFile(join(dest, 'inside.link')));
  const copied = await readFile(join(dest, 'scenes/main.tscn'), 'utf8');
  assert.equal(copied.includes('LEAK-ME'), false);
  assert.equal(await readFile(join(source, 'project.godot'), 'utf8'), before);
  assert.equal(await readFile(join(source, '.env'), 'utf8'), secretBefore);
  const afterStat = await stat(join(source, 'project.godot'));
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.ok(snapshot.hash.length === 64);
  assert.equal(snapshot.totalBytes > 0, true);
});

test('snapshot hash is deterministic and destination is not copied into itself', async (t) => {
  const root = await tempDir(t, 'appops-snap-hash-');
  const source = join(root, 'src');
  await write(source, 'a.txt', 'alpha\n');
  await write(source, 'b/b.txt', 'beta\n');
  const dest1 = join(root, 's1');
  const dest2 = join(root, 's2');
  const one = await createSnapshot(source, dest1);
  const two = await createSnapshot(source, dest2);
  assert.equal(one.hash, two.hash);
  assert.equal(one.fileCount, two.fileCount);

  const nested = join(source, 'out');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'stale.bin'), 'OLD');
  const third = await createSnapshot(source, nested);
  const manifest = JSON.parse(await readFile(join(nested, '.appops-manifest.json'), 'utf8')) as { files: Array<{ path: string }> };
  assert.equal(manifest.files.some((f) => f.path === 'out/stale.bin' || f.path.startsWith('out/')), false);
  assert.ok(third.fileCount >= 2);
});

test('createSnapshot works without git metadata', async (t) => {
  const root = await tempDir(t, 'appops-snap-nogit-');
  const source = join(root, 'src');
  await write(source, 'readme.txt', 'no git here\n');
  const snap = await createSnapshot(source, join(root, 'dest'));
  assert.equal(snap.fileCount, 1);
  assert.equal(await readFile(join(root, 'dest/readme.txt'), 'utf8'), 'no git here\n');
});

test('executeBuild runs argv spawn, verifies artifacts, and fails on missing tools', async (t) => {
  const root = await tempDir(t, 'appops-exec-');
  const artifact = join(root, 'out', 'game.bin');
  const tool = await mockBin(root, 'fake-godot', `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.ARTIFACT_PATH;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, 'built');
console.log('ok', process.argv.slice(2).join(','));
`);
  const result = await executeBuild(planWith({
    executable: tool,
    args: ['--headless', '--export-release', 'Linux', artifact],
    cwd: root,
    env: { ARTIFACT_PATH: artifact },
    label: 'fake godot',
  }, [artifact], join(root, 'out')));
  assert.equal(result.exitCode, 0);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.artifacts, [artifact]);
  assert.equal(await readFile(artifact, 'utf8'), 'built');

  const missing = await executeBuild(planWith({
    executable: join(root, 'definitely-not-installed'),
    args: ['--version'],
    cwd: root,
    label: 'missing',
  }, [artifact], join(root, 'out')));
  assert.notEqual(missing.exitCode, 0);
  assert.equal(missing.cancelled, false);
  assert.deepEqual(missing.artifacts, []);

  const noArtifactTool = await mockBin(root, 'empty-build', `#!/usr/bin/env node
console.log('pretend success');
process.exit(0);
`);
  const ghost = join(root, 'out', 'ghost.bin');
  const fakeSuccess = await executeBuild(planWith({
    executable: noArtifactTool,
    args: [],
    cwd: root,
    label: 'empty',
  }, [ghost], join(root, 'out')));
  assert.equal(fakeSuccess.exitCode, 1);
  assert.deepEqual(fakeSuccess.artifacts, []);
});

test('executeBuild fails on non-zero exit and does not treat it as success', async (t) => {
  const root = await tempDir(t, 'appops-fail-');
  const tool = await mockBin(root, 'failing', `#!/usr/bin/env node
console.error('compile error');
process.exit(2);
`);
  const result = await executeBuild(planWith({
    executable: tool,
    args: [],
    cwd: root,
    label: 'fail',
  }, [join(root, 'out.bin')], root));
  assert.equal(result.exitCode, 2);
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.artifacts, []);
});

test('AbortSignal terminates the spawned process group', async (t) => {
  const root = await tempDir(t, 'appops-cancel-');
  const beat = join(root, 'beat.txt');
  const tool = await mockBin(root, 'sleeper', `#!/usr/bin/env node
const fs = require('node:fs');
const beat = process.env.BEAT;
setInterval(() => { fs.writeFileSync(beat, String(Date.now())); }, 40);
`);
  const controller = new AbortController();
  const running = executeBuild(planWith({
    executable: tool,
    args: [],
    cwd: root,
    env: { BEAT: beat },
    label: 'sleeper',
  }, [], root), { signal: controller.signal });
  const started = Date.now();
  for (let i = 0; i < 80; i++) {
    try {
      await readFile(beat, 'utf8');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  await readFile(beat, 'utf8');
  controller.abort();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.ok(Date.now() - started < 8000);
  const afterAbort = Number((await readFile(beat, 'utf8')).trim());
  await new Promise((r) => setTimeout(r, 200));
  const later = Number((await readFile(beat, 'utf8')).trim());
  assert.equal(later, afterAbort);
});

test('executeBuild truncates oversized output and never uses a shell string', async (t) => {
  const root = await tempDir(t, 'appops-out-');
  const tool = await mockBin(root, 'noisy', `#!/usr/bin/env node
const chunk = Buffer.alloc(65536, 0x78);
async function main() {
  for (let i = 0; i < 40; i++) {
    const ok = process.stdout.write(chunk);
    if (!ok) await new Promise((resolve) => process.stdout.once('drain', resolve));
  }
}
main();
`);
  const chunks: string[] = [];
  const result = await executeBuild(planWith({
    executable: tool,
    args: [],
    cwd: root,
    label: 'noisy',
  }, [], root), {
    onOutput: (o) => chunks.push(o.text),
  });
  assert.equal(result.exitCode, 0);
  const joined = chunks.join('');
  assert.ok(joined.includes('잘렸습니다'));
  assert.ok(joined.length < 2_000_000);

  const echo = await mockBin(root, 'echo-args', `#!/usr/bin/env node
console.log(JSON.stringify(process.argv.slice(2)));
`);
  const captured: string[] = [];
  await executeBuild(planWith({
    executable: echo,
    args: ['a; rm -rf /', 'hello world'],
    cwd: root,
    label: 'args',
  }, [], root), { onOutput: (o) => { if (o.stream === 'stdout') captured.push(o.text); } });
  assert.equal(captured.join('').trim(), JSON.stringify(['a; rm -rf /', 'hello world']));
});

test('bwrap isolation hides host files and fail-closed when unavailable', async (t) => {
  const probe = await probeIsolation();
  if (process.platform === 'linux') {
    assert.equal(probe.available, true);
    assert.equal(probe.backend, 'bwrap');
  } else {
    assert.equal(probe.available, false);
  }
  const root = await tempDir(t, 'appops-jail-');
  const source = join(root, 'src');
  await mkdir(source);
  const secret = join(root, 'host-secret.txt');
  await writeFile(secret, 'SHOULD_NOT_READ\n');
  const tool = await mockBin(source, 'peeker', `#!/usr/bin/env node
const fs = require('node:fs');
const target = ${JSON.stringify(secret)};
try {
  const text = fs.readFileSync(target, 'utf8');
  console.log('LEAK', text);
  process.exit(2);
} catch {
  console.log('BLOCKED');
  process.exit(0);
}
`);
  const isolated = await executeBuild(planWith({
    executable: tool,
    args: [],
    cwd: source,
    label: 'peeker',
  }, [], source));
  assert.equal(isolated.exitCode, 0);
  assert.equal(isolated.cancelled, false);

  const closed = await executeBuild(planWith({
    executable: tool,
    args: [],
    cwd: source,
    label: 'peeker',
  }, [], source), { isolation: { forceUnavailable: true } });
  assert.equal(closed.exitCode, 1);
  assert.deepEqual(closed.artifacts, []);
});

test('a stale artifact from a prior attempt is removed before the build and not re-attested', async (t) => {
  const root = await tempDir(t, 'appops-stale-');
  const out = join(root, 'out');
  const artifact = join(out, 'game.bin');
  await mkdir(out, { recursive: true });
  await writeFile(artifact, 'STALE-FROM-CRASHED-ATTEMPT');
  // A no-op tool (exit 0, produces nothing) must not accept the stale artifact.
  const noop = await mockBin(root, 'noop', `#!/usr/bin/env node
process.exit(0);
`);
  const result = await executeBuild(planWith({
    executable: noop, args: [], cwd: root, label: 'noop',
  }, [artifact], out));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.artifacts, []);
  await assert.rejects(readFile(artifact), 'the stale artifact must have been removed');
});

test('executeBuild rejects expected paths outside snapshot/output, symlinks, empty dirs, and wrong extensions', async (t) => {
  const root = await tempDir(t, 'appops-artpaths-');
  const source = join(root, 'src');
  const out = join(root, 'out');
  await mkdir(source, { recursive: true });
  await mkdir(out, { recursive: true });
  const tool = await mockBin(source, 'noop', `#!/usr/bin/env node\nprocess.exit(0);\n`);

  // Expected path outside both roots is refused before running.
  const outsidePlan: BuildPlan = {
    engine: 'godot', target: 'linux', sourcePath: source, outputPath: out,
    commands: [{ executable: tool, args: [], cwd: source, label: 'x' }],
    expectedArtifacts: [join(root, 'escape.bin')], findings: [],
  };
  const outside = await executeBuild(outsidePlan, { isolation: { forceUnavailable: false, launcher: { executable: tool, prefixArgs: [] } } });
  assert.equal(outside.exitCode, 1);
  assert.deepEqual(outside.artifacts, []);

  // Wrong extension for the android target is refused.
  const wrongExt: BuildPlan = {
    engine: 'android', target: 'android', sourcePath: source, outputPath: out,
    commands: [{ executable: tool, args: [], cwd: source, label: 'x' }],
    expectedArtifacts: [join(out, 'game.txt')], findings: [],
  };
  const badExt = await executeBuild(wrongExt, { isolation: { launcher: { executable: tool, prefixArgs: [] } } });
  assert.equal(badExt.exitCode, 1);

  // A symlinked artifact is not accepted even after a zero-exit command.
  const realFile = join(root, 'real-outside.bin');
  await writeFile(realFile, 'DATA');
  const linkArtifact = join(out, 'linked.bin');
  const linkTool = await mockBin(source, 'linker', `#!/usr/bin/env node
const fs = require('node:fs');
fs.symlinkSync(${JSON.stringify(realFile)}, ${JSON.stringify(linkArtifact)});
process.exit(0);
`);
  const linkPlan: BuildPlan = {
    engine: 'godot', target: 'linux', sourcePath: source, outputPath: out,
    commands: [{ executable: linkTool, args: [], cwd: source, label: 'link' }],
    expectedArtifacts: [linkArtifact], findings: [],
  };
  const linked = await executeBuild(linkPlan, { isolation: { launcher: { executable: linkTool, prefixArgs: [] } } });
  assert.equal(linked.exitCode, 1, 'a symlinked artifact must be rejected');
  assert.deepEqual(linked.artifacts, []);

  // An empty directory artifact is not a real output.
  const dirTool = await mockBin(source, 'mkdirer', `#!/usr/bin/env node
const fs = require('node:fs');
fs.mkdirSync(${JSON.stringify(join(out, 'bundle'))}, { recursive: true });
process.exit(0);
`);
  const dirPlan: BuildPlan = {
    engine: 'godot', target: 'linux', sourcePath: source, outputPath: out,
    commands: [{ executable: dirTool, args: [], cwd: source, label: 'dir' }],
    expectedArtifacts: [join(out, 'bundle')], findings: [],
  };
  const emptyDir = await executeBuild(dirPlan, { isolation: { launcher: { executable: dirTool, prefixArgs: [] } } });
  assert.equal(emptyDir.exitCode, 1, 'an empty artifact directory must be rejected');
});

test('snapshot excludes a controller data dir under the source and .git at any depth', async (t) => {
  const root = await tempDir(t, 'appops-snap-excl-');
  const source = join(root, 'project');
  await write(source, 'main.gd', 'code\n');
  await write(source, '.appdata/controller.json', '{"bearer":"SECRET-TOKEN"}\n');
  await write(source, 'vendor/lib/.git/config', '[remote]\n url = https://user:pw@host/repo\n');
  await write(source, 'vendor/lib/src.c', 'int main(){}\n');
  // A submodule gitlink FILE named .git must also be excluded.
  await write(source, 'sub/.git', 'gitdir: ../.git/modules/sub\n');
  await write(source, 'sub/code.c', 'x\n');

  const dataReal = join(source, '.appdata');
  const snapshot = await createSnapshot(source, join(root, 'snap'), { excludedRoots: [dataReal] });
  const manifest = JSON.parse(await readFile(join(root, 'snap/.appops-manifest.json'), 'utf8')) as { files: Array<{ path: string }> };
  const paths = manifest.files.map((f) => f.path);
  assert.ok(paths.includes('main.gd'));
  assert.ok(paths.includes('vendor/lib/src.c'));
  assert.ok(paths.includes('sub/code.c'));
  assert.equal(paths.some((p) => p.includes('.appdata')), false, 'controller data dir must be excluded');
  assert.equal(paths.some((p) => p.includes('.git')), false, 'git metadata must be excluded at any depth');
  await assert.rejects(readFile(join(root, 'snap/.appdata/controller.json')));
  await assert.rejects(readFile(join(root, 'snap/vendor/lib/.git/config')));
  await assert.rejects(readFile(join(root, 'snap/sub/.git')));
});

test('snapshot fails loudly on an unreadable directory rather than reporting a partial success', async (t) => {
  if (process.getuid && process.getuid() === 0) return; // root bypasses permission bits
  const root = await tempDir(t, 'appops-snap-unread-');
  const source = join(root, 'project');
  await write(source, 'ok.txt', 'fine\n');
  const locked = join(source, 'locked');
  await mkdir(locked, { recursive: true });
  await writeFile(join(locked, 'inner.txt'), 'secret\n');
  await chmod(locked, 0o000);
  try {
    await assert.rejects(createSnapshot(source, join(root, 'snap')), /읽을 수 없습니다/);
  } finally {
    // Restore perms in-body so the tempDir cleanup hook can remove it.
    await chmod(locked, 0o755).catch(() => undefined);
  }
});

test('empty command plans fail instead of reporting success', async (t) => {
  const root = await tempDir(t, 'appops-empty-plan-');
  const result = await executeBuild({
    engine: 'unknown',
    target: 'linux',
    sourcePath: root,
    outputPath: root,
    commands: [],
    expectedArtifacts: [],
    findings: [],
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.cancelled, false);
});
