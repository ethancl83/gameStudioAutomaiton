import electron from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, realpath, rename, symlink } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));

async function trustedSandbox(path) {
  try {
    if (await realpath(path) !== path) return false;
    const leaf = await lstat(path);
    if (!leaf.isFile() || leaf.uid !== 0 || (leaf.mode & 0o4777) !== 0o4755) return false;
    for (let parent = dirname(path);; parent = dirname(parent)) {
      const item = await lstat(parent);
      if (!item.isDirectory() || item.uid !== 0 || (item.mode & 0o022)) return false;
      if (parent === parse(parent).root) break;
    }
    return true;
  } catch { return false; }
}

// Development checkout only. Installed deb packages use electron-builder's
// root-owned sandbox/AppArmor installation; no host settings are changed here.
if (process.platform === 'linux') {
  const helper = join(dirname(electron), 'chrome-sandbox');
  if (!(await trustedSandbox(helper)) && spawnSync('/usr/bin/unshare', ['--user', 'true'], {stdio:'ignore'}).status !== 0) {
    let current;
    try { current = await lstat(helper); } catch {}
    const candidates = ['/opt/google/chrome/chrome-sandbox', '/opt/microsoft/msedge/chrome-sandbox'];
    let selected;
    for (const path of candidates) if (await trustedSandbox(path)) { selected = path; break; }
    if (selected && (!current?.isSymbolicLink() || await realpath(helper) !== selected)) {
      const saved = helper + '.bundled';
      if (current?.isSymbolicLink()) throw new Error('기존 sandbox 연결을 확인해 주세요. 자동으로 덮어쓰지 않았습니다.');
      let savedExists = false;
      try { await lstat(saved); savedExists = true; } catch {}
      if (savedExists) throw new Error('보존된 sandbox 파일을 확인해 주세요. 자동으로 덮어쓰지 않았습니다.');
      if (current) await rename(helper, saved);
      try { await symlink(selected, helper); }
      catch (error) { if (current) await rename(saved, helper); throw error; }
    }
    if (!selected) throw new Error('Linux sandbox를 준비할 수 없습니다. 배포한 deb 설치본을 사용하거나 scripts/install-sandbox.mjs의 설치 안내를 확인해 주세요.');
  }
}

const child = spawn(electron, [project, ...process.argv.slice(2)], {stdio:'inherit', env:process.env});
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
