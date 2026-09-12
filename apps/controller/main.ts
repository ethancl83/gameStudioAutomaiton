import { startController } from './server.js';
import { normalizeError } from './validation.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDirectory } from '../../packages/domain/paths.js';

if (existsSync(join(getDataDirectory(), 'controller.stop'))) {
  process.stderr.write('제어 서비스가 명시적으로 중지되어 있습니다. 앱에서 다시 시작해 주세요.\n');
  process.exit(0);
}

try {
  const port = Number(process.env.APPOPS_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const controller = await startController({ port });
  process.stdout.write(`gameStudioAutomaiton 제어 서비스: http://127.0.0.1:${controller.port}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void controller.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  const normalized = normalizeError(error);
  process.stderr.write(`${normalized.code}: ${normalized.message}\n`);
  process.exitCode = 1;
}
