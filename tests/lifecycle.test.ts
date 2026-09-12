import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureController,
  stopController,
  restartController,
  getControllerStatus,
  inspectLinuxSandbox,
  renderAppArmorProfile,
  sandboxChmodCommands,
  buildControllerAutostartTarget,
} from '../packages/lifecycle/index.js';
import type { ControllerDeps, ControllerInfo } from '../packages/lifecycle/index.js';

const noDelay = async () => {};

test('ensureController adopts a healthy existing controller without spawning (single instance)', async () => {
  const info: ControllerInfo = { port: 4317, token: 't', pid: 100, startedAt: 'A' };
  let spawns = 0;
  const deps: ControllerDeps = {
    readInfo: async () => info,
    checkHealth: async () => true,
    spawnController: () => {
      spawns++;
      return { pid: 999 };
    },
    killPid: () => true,
    delay: noDelay,
  };
  const out = await ensureController(deps);
  assert.equal(out.status, 'adopted');
  assert.equal(spawns, 0);
});

test('ensureController spawns and reports started once healthy', async () => {
  let info: ControllerInfo | null = null;
  let healthy = false;
  let spawns = 0;
  const deps: ControllerDeps = {
    readInfo: async () => info,
    checkHealth: async () => healthy,
    spawnController: () => {
      spawns++;
      info = { port: 4317, token: 't', pid: 200, startedAt: 'B' };
      healthy = true;
      return { pid: 200 };
    },
    killPid: () => true,
    delay: noDelay,
  };
  const out = await ensureController(deps, { startTimeoutMs: 5000, pollIntervalMs: 10 });
  assert.equal(out.status, 'started');
  assert.equal(spawns, 1);
  assert.equal(out.status === 'started' ? out.info.pid : undefined, 200);
});

test('ensureController times out and kills the orphaned spawned process (orphan prevention)', async () => {
  const killed: Array<[number, string]> = [];
  let clock = 0;
  const deps: ControllerDeps = {
    readInfo: async () => null,
    checkHealth: async () => false,
    spawnController: () => ({ pid: 555 }),
    killPid: (pid, signal) => {
      killed.push([pid, String(signal)]);
      return true;
    },
    delay: noDelay,
    now: () => (clock += 500),
  };
  const out = await ensureController(deps, { startTimeoutMs: 1000, pollIntervalMs: 100 });
  assert.equal(out.status, 'failed');
  assert.equal(out.status === 'failed' ? out.error.code : '', 'start_timeout');
  assert.deepEqual(killed, [[555, 'SIGTERM']]);
});

test('stopController does NOT signal a PID that fails identity verification (PID reuse safety)', async () => {
  const info: ControllerInfo = { port: 4317, token: 't', pid: 12345, startedAt: 'A' };
  const killed: number[] = [];
  const deps: ControllerDeps = {
    readInfo: async () => info,
    checkHealth: async () => false, // stale controller.json: instance not verified alive/ours
    spawnController: () => ({}),
    killPid: (pid) => {
      killed.push(pid);
      return true;
    },
    delay: noDelay,
  };
  const out = await stopController(deps);
  assert.equal(out.stopped, false);
  assert.equal(out.wasRunning, false);
  assert.deepEqual(killed, [], 'must never kill an unverified (possibly reused) pid');
});

test('stopController SIGTERMs a verified controller and confirms shutdown', async () => {
  let alive = true;
  const info: ControllerInfo = { port: 4317, token: 't', pid: 777, startedAt: 'A' };
  const killed: Array<[number, string]> = [];
  const deps: ControllerDeps = {
    readInfo: async () => (alive ? info : null),
    checkHealth: async () => alive,
    spawnController: () => ({}),
    killPid: (pid, signal) => {
      killed.push([pid, String(signal)]);
      if (signal === 'SIGTERM') alive = false;
      return true;
    },
    delay: noDelay,
    now: () => Date.now(),
  };
  const out = await stopController(deps);
  assert.equal(out.stopped, true);
  assert.equal(out.wasRunning, true);
  assert.deepEqual(killed, [[777, 'SIGTERM']]);
});

test('stopController escalates to SIGKILL when a verified controller ignores SIGTERM', async () => {
  const info: ControllerInfo = { port: 4317, token: 't', pid: 888, startedAt: 'A' };
  const killed: Array<[number, string]> = [];
  let clock = 0;
  const deps: ControllerDeps = {
    readInfo: async () => info, // never goes away
    checkHealth: async () => true,
    spawnController: () => ({}),
    killPid: (pid, signal) => {
      killed.push([pid, String(signal)]);
      return true;
    },
    delay: noDelay,
    now: () => (clock += 500),
  };
  const out = await stopController(deps, { stopTimeoutMs: 1000, pollIntervalMs: 100 });
  assert.deepEqual(killed, [[888, 'SIGTERM'], [888, 'SIGKILL']]);
  assert.equal(out.stopped, true);
});

test('restartController stops then starts a fresh controller', async () => {
  let alive = true;
  let info: ControllerInfo | null = { port: 4317, token: 't', pid: 1, startedAt: 'A' };
  const events: string[] = [];
  const deps: ControllerDeps = {
    readInfo: async () => info,
    checkHealth: async () => alive,
    spawnController: () => {
      events.push('spawn');
      info = { port: 4317, token: 't', pid: 2, startedAt: 'B' };
      alive = true;
      return { pid: 2 };
    },
    killPid: (_pid, signal) => {
      if (signal === 'SIGTERM') {
        alive = false;
        info = null;
        events.push('term');
      }
      return true;
    },
    delay: noDelay,
    now: () => Date.now(),
  };
  const out = await restartController(deps, { startTimeoutMs: 3000, pollIntervalMs: 10 });
  assert.equal(out.status, 'started');
  assert.deepEqual(events, ['term', 'spawn']);
});

test('getControllerStatus reports running only when verified', async () => {
  const info: ControllerInfo = { port: 4317, token: 't', pid: 5, startedAt: 'A' };
  const running = await getControllerStatus({
    readInfo: async () => info,
    checkHealth: async () => true,
    spawnController: () => ({}),
    killPid: () => true,
  });
  assert.equal(running.running, true);
  const stale = await getControllerStatus({
    readInfo: async () => info,
    checkHealth: async () => false,
    spawnController: () => ({}),
    killPid: () => true,
  });
  assert.equal(stale.running, false);
});

// --- Linux 샌드박스 진단 (Ubuntu 24.04 chrome-sandbox / AppArmor userns) ---

test('inspectLinuxSandbox flags a non-setuid sandbox under userns restriction', async () => {
  const s = await inspectLinuxSandbox({
    statSandbox: async () => ({ mode: 0o755, uid: 1000 }),
    readUsernsRestrict: async () => 1,
  });
  assert.equal(s.setuidSandbox.present, true);
  assert.equal(s.setuidSandbox.setuidRoot, false);
  assert.equal(s.userNamespaces.restricted, true);
  assert.equal(s.ok, false);
  assert.ok(s.recommendation && s.recommendation.length > 0);
});

test('inspectLinuxSandbox is ok when chrome-sandbox is setuid root', async () => {
  const s = await inspectLinuxSandbox({
    statSandbox: async () => ({ mode: 0o4755, uid: 0 }),
    readUsernsRestrict: async () => 1,
  });
  assert.equal(s.setuidSandbox.setuidRoot, true);
  assert.equal(s.ok, true);
  assert.equal(s.recommendation, null);
});

test('inspectLinuxSandbox is ok when user namespaces are not restricted', async () => {
  const s = await inspectLinuxSandbox({
    statSandbox: async () => ({ mode: 0o755, uid: 1000 }),
    readUsernsRestrict: async () => 0,
  });
  assert.equal(s.userNamespaces.restricted, false);
  assert.equal(s.ok, true);
});

test('AppArmor profile grants userns to the exact app binary and does not disable globally', () => {
  const profile = renderAppArmorProfile('appops-desktop', '/opt/AppOperations/app-operations');
  assert.match(profile, /profile appops-desktop \/opt\/AppOperations\/app-operations flags=\(unconfined\)/);
  assert.match(profile, /\buserns,/);
  assert.doesNotMatch(profile, /--no-sandbox/);
  assert.doesNotMatch(profile, /apparmor_restrict_unprivileged_userns=0/);
  const cmds = sandboxChmodCommands('/opt/AppOperations/chrome-sandbox');
  assert.ok(cmds.some((c) => c.includes('chmod 4755')));
  assert.ok(cmds.some((c) => c.includes('chown root:root')));
});

test('buildControllerAutostartTarget targets the controller headless with a stable id', () => {
  const target = buildControllerAutostartTarget({
    program: '/opt/AppOperations/app-operations',
    controllerEntry: '/opt/AppOperations/resources/app/dist/apps/controller/main.js',
    runAsNode: false,
  });
  assert.equal(target.id, 'local.appops.controller');
  assert.equal(target.program, '/opt/AppOperations/app-operations');
});
