import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessTree, type ProcessRow } from '../packages/runner/process-tree.js';

const row = (pid: number, ppid = 1, pgid = pid, started = 'original'): ProcessRow => ({ pid, ppid, pgid, started });
const child = (pid: number): { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null } => ({ pid, exitCode: null, signalCode: null });
const host = [row(1, 0, 1), row(10, 1), row(20, 10, 10), row(30, 20, 10)];
function fixture(initial: ProcessRow[], root = 100) {
  let rows = initial; const signals: number[] = [];
  const tree = new ProcessTree(child(root), { table: async () => [...host, ...rows], signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
  return { tree, signals, set: (next: ProcessRow[]) => { rows = next; } };
}

test('absent or invalid roots never capture host processes or foreign groups', async () => {
  for (const root of [0, -1, NaN, 1, 10, 20, 30, 999]) {
    const f = fixture([row(40), row(41, 999, 40)], root);
    await f.tree.signal('SIGKILL'); f.tree.stop(); assert.deepEqual(f.signals, []);
  }
  const f = fixture([row(100, 30, 10), row(101, 100, 10)]);
  await f.tree.signal('SIGKILL'); f.tree.stop(); assert.deepEqual(f.signals, []);
});

test('owned detached group and observed setsid descendants are signalled, unrelated host is not', async () => {
  const f = fixture([row(100, 30), row(101, 100, 100), row(102, 101), row(200, 1)]);
  await f.tree.signal('SIGTERM');
  assert.deepEqual(f.signals, [-100, 100, 101, 102]);
  f.signals.length = 0;
  f.set([row(101, 1, 100), row(102, 1), row(200, 1), row(201, 1, 100)]);
  await f.tree.signal('SIGKILL'); f.tree.stop();
  assert.deepEqual(f.signals, [101, 102], 'only observed children survive loss of root authority');
});

test('root and descendant PID reuse cannot acquire new ownership', async () => {
  const f = fixture([row(100, 30), row(101, 100)]);
  await f.tree.signal('SIGTERM'); f.signals.length = 0;
  f.set([row(100, 30, 100, 'replacement'), row(101, 100, 101, 'replacement'), row(102, 101)]);
  await f.tree.signal('SIGKILL'); f.tree.stop(); assert.deepEqual(f.signals, []);
});

test('failed snapshots and missing self ancestry send nothing', async () => {
  let fail = false; const signals: number[] = [];
  const tree = new ProcessTree(child(100), { table: async () => { if (fail) throw Error('ps'); return [...host, row(100, 30)]; }, signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
  await tree.signal('SIGTERM'); signals.length = 0; fail = true;
  await tree.signal('SIGKILL'); tree.stop(); assert.equal(signals.length, 0);
  const unknown = new ProcessTree(child(100), { table: async () => [row(100, 30)], signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
  await unknown.signal('SIGKILL'); unknown.stop(); assert.equal(signals.length, 0);
});

test('overlapping collection is serialized and stop invalidates in-flight samples', async () => {
  let release!: (rows: ProcessRow[]) => void; let reads = 0; const signals: number[] = [];
  const tree = new ProcessTree(child(100), { table: () => { reads++; return reads === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve([...host, row(100, 30, 100, 'reused')]); }, signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
  await Promise.resolve(); const first = tree.signal('SIGTERM'); const second = tree.signal('SIGKILL');
  assert.equal(reads, 1); release([...host, row(100, 30)]); await Promise.all([first, second]);
  assert.equal(signals.length, 0); tree.stop();
  let resume!: (rows: ProcessRow[]) => void;
  const stopped = new ProcessTree(child(100), { table: () => new Promise(resolve => { resume = resolve; }), signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
  await Promise.resolve(); stopped.stop(); resume([...host, row(100, 30)]);
  // No signal request: stopping must also discard the constructor's pending collection.
  await Promise.resolve(); assert.equal(signals.length, 0);
});

test('a missing or failed initial root observation cannot later adopt a recycled root', async () => {
  for (const fail of [false, true]) {
    let calls = 0; const signals: number[] = [];
    const tree = new ProcessTree(child(100), { table: async () => {
      if (calls++ === 0) { if (fail) throw Error('ps failed'); return host; }
      return [...host, row(100, 30), row(101, 100)];
    }, signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
    await tree.signal('SIGKILL'); tree.stop(); assert.equal(signals.length, 0);
  }
});

test('a partial or cyclic self ancestry cannot authorize an ancestor group', async () => {
  for (const rows of [
    [row(30, 20, 10), row(10, 1, 10)],
    [row(30, 20, 10), row(20, 30, 10), row(100, 1)],
  ]) {
    const signals: number[] = [];
    const tree = new ProcessTree(child(rows.length === 2 ? 10 : 100), { table: async () => rows, signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
    await tree.signal('SIGKILL'); tree.stop(); assert.equal(signals.length, 0);
  }
});

test('the first snapshot cannot adopt an unrelated replacement with the spawned PID', async () => {
  const f = fixture([row(100, 1, 100, 'unrelated-reused-pid')]);
  await f.tree.signal('SIGKILL'); f.tree.stop();
  assert.deepEqual(f.signals, []);
});

test('exit during the first pending snapshot rejects a replacement even with the same parent', async () => {
  for (const signalled of [false, true]) {
    const spawned = child(100); const signals: number[] = [];
    let release!: (rows: ProcessRow[]) => void; let calls = 0;
    const replacement = [...host, row(100, 30, 100, 'replacement'), row(101, 100, 100)];
    const tree = new ProcessTree(spawned, { table: () => calls++ === 0 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(replacement), signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
    await Promise.resolve();
    if (signalled) spawned.signalCode = 'SIGTERM'; else spawned.exitCode = 0;
    release(replacement);
    await tree.signal('SIGKILL'); tree.stop();
    assert.deepEqual(signals, []);
  }
});

test('original child exit revokes its root identity while preserving observed setsid children', async () => {
  const spawned = child(100); const signals: number[] = [];
  let rows = [...host, row(100, 30), row(101, 100), row(102, 101)];
  const tree = new ProcessTree(spawned, { table: async () => rows, signal: pid => { signals.push(pid); }, self: 30, parent: 20, pollMs: 0 });
  await tree.signal('SIGTERM'); signals.length = 0;
  spawned.exitCode = 0;
  // The ps start-time resolution can even show the same timestamp for a reused
  // PID: the original ChildProcess lifecycle still revokes root authority.
  rows = [...host, row(100, 30), row(101, 1), row(102, 1), row(103, 100, 100)];
  await tree.signal('SIGKILL'); tree.stop();
  assert.deepEqual(signals, [101, 102]);
});
