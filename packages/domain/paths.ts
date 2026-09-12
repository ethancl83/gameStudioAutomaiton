import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function getDataDirectory(): string {
  if (process.env.APPOPS_DATA_DIR) return resolve(process.env.APPOPS_DATA_DIR);
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'app-operations');
}
export function getControllerInfoPath(): string { return join(getDataDirectory(), 'controller.json'); }
