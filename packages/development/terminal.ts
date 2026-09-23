import { randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { AppError, redact } from "../domain/errors.js";
import { command, requireTool, quote } from "./process.js";
import type { TerminalSession, TerminalOutput } from "./types.js";
import { environmentSecrets, terminalRedactor } from './terminal-redaction.js';
interface LiveTerminal {
  session: TerminalSession;
  pty: IPty;
  output: string;
  offset: number;
  done: Promise<number>;
  direct?: boolean;
}
export class StudioTerminals {
  private live = new Map<string, LiveTerminal>();
  private opening = new Set<Promise<unknown>>();
  private closed = false;
  private initialized?: Promise<void>;
  private archives = new Map<string, TerminalOutput>();
  private saving = new Set<Promise<unknown>>();
  constructor(
    private directory: string,
    private demo: boolean,
    private archiveDirectory = join(directory, "logs"),
  ) {}
  list(): TerminalSession[] {
    return [...this.archives.values()].filter(v => !this.live.has(v.session.id)).map(v => v.session).concat([...this.live.values()].map((value) => ({ ...value.session })));
  }
  get busy() {
    return [...this.live.values()].some(
      (value) => value.session.status === "running",
    );
  }
  async initialize() {
    if (this.demo) return;
    return this.initialized ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const st = await lstat(this.directory);
      if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077))
        throw new AppError('TERMINAL_DIRECTORY', '터미널 전용 폴더의 소유권과 권한을 확인하세요.');
      await mkdir(this.archiveDirectory, { recursive: true, mode: 0o700 });
      for (const name of (await readdir(this.archiveDirectory)).filter(n => /^[a-f0-9-]+\.json$/.test(n))) {
        try { const saved = JSON.parse(await readFile(join(this.archiveDirectory, name), 'utf8')) as TerminalOutput;
          saved.session.status = 'exited'; saved.session.exitCode ??= -1;
          this.archives.set(saved.session.id, saved);
        } catch { /* Incomplete crash-time logs do not prevent controller startup. */ }
      }
      const socket = join(this.directory, 'tmux.sock');
      const existing = await lstat(socket).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) {
        if (!existing.isSocket()) throw new AppError('TERMINAL_SOCKET', '터미널 소켓 경로가 올바르지 않습니다.');
        // Kill only this app's private server after a controller crash.
        try { await command(await requireTool('tmux'), ['-S', socket, 'kill-server']); }
        catch (error) { if (!/no server running|Connection refused|No such file/.test(String(error))) throw error; }
      }
    })();
  }
  async installHost(cwd: string) {
    if (this.demo || this.closed) throw new AppError('TERMINAL_UNAVAILABLE', '실제 운영 모드에서 터미널을 준비하세요.');
    const { pathLookup } = await import('../engines/which.js');
    const brew = process.platform === 'darwin' ? await pathLookup(['brew'], ['/opt/homebrew/bin','/usr/local/bin']) : null;
    if (!brew) throw new AppError('HOST_SETUP_REQUIRED', process.platform === 'darwin' ? 'Homebrew 설치 후 터미널 준비를 다시 누르세요.' : '시스템 패키지 관리자로 tmux를 설치하세요. Linux는 bubblewrap과 socat도 필요합니다.');
    const { spawn } = await import('node-pty');
    const id=randomUUID(); const pty=spawn(brew,['install','tmux'],{cwd,cols:100,rows:28,name:'xterm-256color',env:{...process.env,TMUX:'',TMUX_PANE:''}});
    const session:TerminalSession={id,title:'tmux 터미널 설치',status:'running',createdAt:new Date().toISOString()};
    let finish!:(code:number)=>void;
    const value:LiveTerminal={session,pty,output:'',offset:0,direct:true,done:new Promise(resolve=>{finish=resolve;})};
    this.live.set(id,value);
    const accept=terminalRedactor(environmentSecrets(process.env),false,data=>{value.output+=data;if(value.output.length>1024*1024){const trim=value.output.length-512*1024;value.output=value.output.slice(trim);value.offset+=trim;}});
    pty.onData(data=>accept(data));
    pty.onExit(({exitCode})=>{accept('',true);session.status='exited';session.exitCode=exitCode;finish(exitCode);});
    return {...session};
  }
  async open(
    title: string,
    cwd: string,
    file: string,
    args: string[],
    env?: Record<string, string>,
    secrets: string[] = [],
  ): Promise<TerminalSession> {
    if (this.demo)
      throw new AppError(
        "DEMO_BLOCKED",
        "실제 터미널은 실제 운영 모드에서 실행하세요.",
      );
    if (this.closed)
      throw new AppError("CLOSED", "터미널 서비스가 종료되었습니다.");
    const promise = this.create(title, cwd, file, args, env, secrets);
    this.opening.add(promise);
    try {
      return await promise;
    } finally {
      this.opening.delete(promise);
    }
  }
  private async create(
    title: string,
    cwd: string,
    file: string,
    args: string[],
    env?: Record<string, string>,
    secrets: string[] = [],
  ): Promise<TerminalSession> {
    await this.initialize();
    const tmux = await requireTool("tmux");
    const { spawn } = await import("node-pty");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const socket = join(this.directory, "tmux.sock");
    const launch = [
      ...(env
        ? [
            "env",
            "-i",
            ...Object.entries(env).map(([k, v]) => quote(`${k}=${v}`)),
          ]
        : []),
      quote(file),
      ...args.map(quote),
    ].join(" ");
    await command(tmux, [
      "-S",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      id,
      "-c",
      cwd,
      "-x",
      "100",
      "-y",
      "28",
      "/bin/sleep 86400",
    ]);
    try {
      await command(tmux, ['-S', socket, 'set-option', '-g', 'default-shell', '/bin/sh']);
      await command(tmux, ['-S', socket, 'set-option', '-g', 'prefix', 'None']);
      await command(tmux, ['-S', socket, 'set-option', '-g', 'prefix2', 'None']);
      await command(tmux, ['-S', socket, 'set-option', '-g', 'status', 'off']);
      await command(tmux, ['-S', socket, 'set-option', '-g', 'remain-on-exit-format', '']);
      await command(tmux, ['-S', socket, 'unbind-key', '-a', '-T', 'root']);
      await command(tmux, [
        "-S",
        socket,
        "set-option",
        "-t",
        id,
        "remain-on-exit",
        "on",
      ]);
      await command(tmux, [
        "-S",
        socket,
        "respawn-pane",
        "-k",
        "-t",
        id,
        launch,
      ]);
      if (this.closed)
        throw new AppError("CLOSED", "터미널 서비스가 종료되었습니다.");
      const pty = spawn(tmux, ["-S", socket, "attach-session", "-t", id], {
        name: "xterm-256color",
        cols: 100,
        rows: 28,
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          TMUX: "",
          TMUX_PANE: "",
        },
      });
      const session: TerminalSession = {
        id,
        title,
        status: "running",
        createdAt: new Date().toISOString(),
      };
      let finish!: (code: number) => void;
      const live: LiveTerminal = {
        session,
        pty,
        output: "",
        offset: 0,
        done: new Promise((resolve) => {
          finish = resolve;
        }),
      };
      this.live.set(id, live);
      if (env) {
        const saving = live.done.then(async () => {
          const saved = this.read(id); saved.data = redact(saved.data);
          await writeFile(join(this.archiveDirectory, `${id}.json`), JSON.stringify(saved), { mode: 0o600 });
        }).finally(() => this.saving.delete(saving));
        this.saving.add(saving);
        void saving.catch(() => { live.output += '\r\n[로그 파일을 저장하지 못했습니다.]\r\n'; });
      }
      const accept = terminalRedactor([...environmentSecrets(process.env), ...environmentSecrets(env ?? {}), ...secrets], !!env, data => {
        live.output += data;
        if (live.output.length > 1024 * 1024) {
          const trim = live.output.length - 512 * 1024;
          live.output = live.output.slice(trim);
          live.offset += trim;
        }
      });
      pty.onData(data => accept(data));
      const timer = setInterval(async () => {
        try {
          const state = (
            await command(
              tmux,
              [
                "-S",
                socket,
                "display-message",
                "-p",
                "-t",
                id,
                "#{pane_dead}:#{pane_dead_status}",
              ],
              { timeout: 5000 },
            )
          ).trim();
          if (state.startsWith("1:")) {
            clearInterval(timer);
            session.status = "exited";
            session.exitCode = Number(state.slice(2));
            accept('', true);
            finish(session.exitCode);
          }
        } catch {
          clearInterval(timer);
          session.status = "exited";
          session.exitCode ??= -1;
          accept('', true);
          finish(session.exitCode);
        }
      }, 600);
      timer.unref();
      pty.onExit(() => {
        clearInterval(timer);
        session.status = "exited";
        session.exitCode ??= -1;
        accept('', true);
        finish(session.exitCode);
      });
      return { ...session };
    } catch (error) {
      await command(tmux, ["-S", socket, "kill-session", "-t", id]).catch(
        () => {},
      );
      throw error;
    }
  }
  private terminal(id: string) {
    const value = this.live.get(id);
    if (!value)
      throw new AppError("NOT_FOUND", "터미널 세션을 찾을 수 없습니다.", 404);
    return value;
  }
  read(id: string, cursor = 0): TerminalOutput {
    const archived = this.archives.get(id);
    if (!this.live.has(id) && archived) return { ...archived, data: cursor === archived.cursor ? '' : archived.data, reset: cursor !== archived.cursor };
    const t = this.terminal(id);
    const end = t.offset + t.output.length;
    const reset =
      !Number.isSafeInteger(cursor) || cursor < t.offset || cursor > end;
    return {
      data: t.output.slice(reset ? 0 : cursor - t.offset),
      cursor: end,
      reset,
      session: { ...t.session },
    };
  }
  input(id: string, data: string) {
    const t = this.terminal(id);
    if (t.session.status !== "running")
      throw new AppError("EXITED", "종료된 터미널입니다.");
    if (data.length > 65536)
      throw new AppError("INPUT_LIMIT", "입력이 너무 큽니다.");
    t.pty.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      rows < 2 ||
      cols > 500 ||
      rows > 200
    )
      throw new AppError("INVALID_SIZE", "터미널 크기를 확인하세요.");
    if (this.archives.has(id) && !this.live.has(id)) return;
    this.terminal(id).pty.resize(cols, rows);
  }
  wait(id: string) {
    return this.terminal(id).done;
  }
  async stop(id: string) {
    if (this.archives.has(id) && !this.live.has(id)) return;
    const t = this.terminal(id);
    if (t.session.status === 'exited') return;
    if (t.direct) { t.pty.kill(); return; }
    await command(await requireTool("tmux"), [
      "-S",
      join(this.directory, "tmux.sock"),
      "kill-session",
      "-t",
      id,
    ]);
    t.pty.kill();
    t.session.status = "exited";
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.opening]);
    if (this.live.size) {
      if ([...this.live.values()].some(v=>!v.direct)) await command(await requireTool("tmux"), [
        "-S",
        join(this.directory, "tmux.sock"),
        "kill-server",
      ]).catch(() => {});
      for (const value of this.live.values()) value.pty.kill();
    }
    await Promise.allSettled([...this.saving]);
    this.live.clear();
  }
}
