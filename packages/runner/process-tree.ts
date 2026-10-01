import { execFile, type ChildProcess } from 'node:child_process';

export interface ProcessRow { pid: number; ppid: number; pgid: number; started: string }
export interface ProcessTreeIO {
  table(): Promise<ProcessRow[]>;
  signal(pid: number, signal: NodeJS.Signals): void;
  self: number;
  parent: number;
  pollMs?: number;
}

function processTable(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-Ao', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(stdout.split('\n').flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4]! }] : [];
      }));
    });
  });
}
const positive = (pid: number) => Number.isSafeInteger(pid) && pid > 1;

/** Only observed identities belong to this tree. An orphan first seen after its
 * parent disappeared cannot be attributed safely; artifact sealing covers it.
 * ps start times have platform resolution, and PID checks cannot make a later
 * kill atomic with observation. The original ChildProcess must still be alive
 * and parented to this controller when its first snapshot arrives; a bare PID
 * is not proof of spawn ownership. Never infer ownership from an absent identity.
 */
export class ProcessTree {
  private readonly root: number;
  private readonly known = new Map<number, string>();
  private readonly rejected = new Set<number>();
  private readonly protectedPids = new Set<number>();
  private readonly io: ProcessTreeIO;
  private readonly poller: NodeJS.Timeout | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private stopped = false;

  constructor(private readonly child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>, io?: ProcessTreeIO) {
    const root = this.root = child.pid ?? 0;
    this.io = io ?? { table: processTable, signal: (pid, signal) => { process.kill(pid, signal); }, self: process.pid, parent: process.ppid };
    this.protectedPids.add(this.io.self);
    this.protectedPids.add(this.io.parent);
    if (!positive(root) || this.protectedPids.has(root)) return;
    void this.enqueue(() => this.collect());
    if (this.io.pollMs !== 0) {
      this.poller = setInterval(() => { void this.enqueue(() => this.collect()); }, this.io.pollMs ?? 250);
      this.poller.unref();
    }
  }

  private rootAlive(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }

  private async collect(): Promise<ProcessRow[]> {
    if (this.stopped) return [];
    const initialize = !this.initialized; this.initialized = true;
    let rows: ProcessRow[];
    try { rows = await this.io.table(); } catch { return []; }
    if (this.stopped) return [];
    const byPid = new Map(rows.map(row => [row.pid, row]));
    // No complete ancestry observation means no authority to send signals.
    if (!byPid.has(this.io.self)) return [];
    let ancestor = this.io.self;
    const seen = new Set<number>();
    while (positive(ancestor) && !seen.has(ancestor)) {
      seen.add(ancestor); this.protectedPids.add(ancestor);
      const row = byPid.get(ancestor);
      if (!row || !Number.isSafeInteger(row.ppid) || row.ppid < 0) return [];
      ancestor = row.ppid;
    }
    if (positive(ancestor) || this.protectedPids.has(this.root)) return [];
    const safe = (row: ProcessRow) => positive(row.pid) && positive(row.pgid) && !!row.started && !this.protectedPids.has(row.pid) && !this.rejected.has(row.pid);
    if (initialize) {
      const root = byPid.get(this.root);
      if (root && this.rootAlive() && root.ppid === this.io.self && safe(root) && root.pgid === this.root) this.known.set(root.pid, root.started);
    }
    for (const [pid, start] of this.known) {
      const row = byPid.get(pid);
      if (!row || row.started !== start || !safe(row) || pid === this.root && !this.rootAlive()) { this.known.delete(pid); this.rejected.add(pid); }
    }
    const tracked = (pid: number) => this.known.has(pid) && this.known.get(pid) === byPid.get(pid)?.started;
    const ownedGroup = tracked(this.root) && byPid.get(this.root)?.pgid === this.root;
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) {
        if (!safe(row) || this.known.has(row.pid)) continue;
        if ((ownedGroup && row.pgid === this.root) || tracked(row.ppid)) {
          this.known.set(row.pid, row.started); grew = true;
        }
      }
    }
    return rows;
  }

  signal(signal: NodeJS.Signals): Promise<void> {
    return this.enqueue(async () => {
      if (!positive(this.root) || this.protectedPids.has(this.root)) return;
      const rows = await this.collect();
      const matches = (row: ProcessRow) => (row.pid !== this.root || this.rootAlive()) && this.known.has(row.pid) && this.known.get(row.pid) === row.started && !this.protectedPids.has(row.pid);
      const group = rows.filter(row => row.pgid === this.root);
      // Preserve detached process-group termination on Linux and macOS only
      // while the original leader and every observed group member are owned.
      if (group.some(row => row.pid === this.root && matches(row)) && group.every(matches)) {
        try { this.io.signal(-this.root, signal); } catch { /* exited since observation */ }
      }
      for (const row of rows) {
        if (matches(row)) { try { this.io.signal(row.pid, signal); } catch { /* exited since observation */ } }
      }
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
  }
}
