import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const base = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support')
  : process.platform === 'win32' ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local')
  : process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share');
const directory = process.env.APPOPS_DATA_DIR ?? join(base, 'app-operations');
try {
  const info = JSON.parse(readFileSync(join(directory, 'dev-session.json'), 'utf8'));
  const url = `http://127.0.0.1:${info.port}/#preview-token=${encodeURIComponent(info.bootstrapToken)}`;
  // Preview-only capability travels once in a fragment and is removed by the page before API use.
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => { process.stderr.write('시스템 브라우저를 열지 못했습니다. 데스크톱 앱을 사용해 주세요.\n'); });
  child.unref();
} catch { process.stderr.write('같은 데이터 폴더로 npm run dev를 먼저 실행해 주세요.\n'); process.exitCode = 1; }
