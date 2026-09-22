import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

try {
  const path = join(process.env.APPOPS_RUNNER_DATA_DIR ?? '/data/runner', 'pairing-code');
  if (((await stat(path)).mode & 0o777) !== 0o600) process.exit(1);
  const token = await readFile(path, 'utf8');
  const response = await fetch(`http://127.0.0.1:${process.env.APPOPS_RUNNER_PORT ?? 4320}/health`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
  });
  const health = await response.json();
  process.exit(response.ok && health.protocol === 'appops-runner-v1' && health.ready === true ? 0 : 1);
} catch {
  // Docker records healthcheck output; never include authentication or response bodies.
  process.exit(1);
}
