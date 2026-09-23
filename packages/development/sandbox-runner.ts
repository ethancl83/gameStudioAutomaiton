// Separate process: the proxy and policy must outlive the sandboxed command.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { SandboxManager, SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';

const [configFile, command] = process.argv.slice(2);
if (!configFile || !command) throw new Error('Sandbox launch arguments are missing');
let code = 1;
try {
  const config = SandboxRuntimeConfigSchema.parse(JSON.parse(await readFile(configFile, 'utf8')));
  await SandboxManager.initialize(config);
  const launch = await SandboxManager.wrapWithSandboxArgv(command, '/bin/sh');
  if (process.platform === 'darwin') {
    const marker = "/usr/bin/sandbox-exec -p '(version 1)";
    if (launch.argv[1] !== '-c' || !launch.argv[2]?.includes(marker)) throw new Error('Unsupported sandbox profile format');
    // The pinned SRT wraps its Seatbelt profile in single quotes. This constant
    // contains no apostrophe or shell expansion, and only tightens its policy.
    const deny = '\n(deny mach-lookup (global-name "com.apple.securityd.xpc") (global-name "com.apple.SecurityServer"))\n';
    launch.argv[2] = launch.argv[2].replace(marker, marker + deny)
      .replace('  (global-name "com.apple.securityd.xpc")\n', '')
      .replace('(allow mach-lookup (global-name "com.apple.SecurityServer"))', '(deny mach-lookup (global-name "com.apple.SecurityServer"))');
  }
  code = await new Promise<number>((resolve, reject) => {
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { env: { ...process.env, ...launch.env }, stdio: 'inherit', detached: true });
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } } };
    const owner = Number(process.env.APPOPS_OWNER_PID);
    const watch = setInterval(() => {
      if (!owner) return;
      try { process.kill(owner, 0); } catch { stop(); }
    }, 1000);
    const timeout = setTimeout(stop, 30 * 60_000);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, stop);
    const cleanup = () => { clearInterval(watch); clearTimeout(timeout); stop(); for (const signal of ['SIGTERM','SIGINT','SIGHUP'] as const) process.removeListener(signal, stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', result => { cleanup(); resolve(result ?? 1); });
  });
} catch (error) {
  process.stderr.write(`격리 실행 오류: ${error instanceof Error ? error.message : String(error)}\n`);
} finally { await SandboxManager.reset(); }
process.exitCode = code;
