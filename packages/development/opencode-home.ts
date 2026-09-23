import { mkdir, readFile, writeFile, stat, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { command } from './process.js';
import { AppError } from '../domain/errors.js';

/** Only native CLI authentication and the requested conversation enter a task's home. */
export async function prepareOpenCodeHome(directory: string, executable: string, env: Record<string, string>, sessionId?: string, selectedModel?: string) {
  const home = homedir();
  const originalData = process.env.XDG_DATA_HOME || join(home, '.local/share');
  Object.assign(env, {
    XDG_CONFIG_HOME: directory, XDG_DATA_HOME: join(directory, 'data'),
    XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
    OPENCODE_CONFIG_DIR: join(directory, 'opencode'), OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_PURE: '1',
  });
  let inherited: {model?: string; provider?: unknown; enabled_providers?: unknown; disabled_providers?: unknown} = {};
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    try {
      const content = await readFile(join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode', name), 'utf8');
      try { const parsed = JSON.parse(content); inherited = {model: parsed.model, provider: parsed.provider, enabled_providers: parsed.enabled_providers, disabled_providers: parsed.disabled_providers}; }
      catch { inherited.model = content.match(/"model"\s*:\s*"([^"]+)"/)?.[1]; }
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await mkdir(env.OPENCODE_CONFIG_DIR!, {recursive: true, mode: 0o700});
  const data = join(env.XDG_DATA_HOME!, 'opencode');
  await mkdir(data, {recursive: true, mode: 0o700});
  // The public model catalog is data; global packages/plugins and sessions are not.
  const cache=join(env.XDG_CACHE_HOME!, 'opencode');
  await mkdir(cache,{recursive:true,mode:0o700});
  for(const name of ['version','models.json']) {
    try { await copyFile(join(process.env.XDG_CACHE_HOME || join(home,'.cache'),'opencode',name),join(cache,name)); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
  }
  await writeFile(join(env.OPENCODE_CONFIG_DIR!, 'opencode.json'), JSON.stringify({...inherited, share: 'disabled', autoupdate: false, mcp: {}, plugin: []}), {mode: 0o600});
  const sourceAuth = join(originalData, 'opencode/auth.json');
  let auth: Record<string, unknown> = {};
  try { auth = JSON.parse(await readFile(sourceAuth, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const provider = (selectedModel || inherited.model)?.split('/')[0];
  const selectedAuth = provider ? {[provider]: auth[provider]} : auth;
  const targetAuth = join(data, 'auth.json');
  // Preserve refreshed native credentials until the user logs in/out again.
  const stamp = join(directory, 'auth-source.json');
  const signature = JSON.stringify({provider, mtime: (await stat(sourceAuth).catch(() => ({mtimeMs: 0}))).mtimeMs});
  if (await readFile(stamp, 'utf8').catch(() => '') !== signature) {
    await writeFile(targetAuth, JSON.stringify(selectedAuth), {mode: 0o600});
    await writeFile(stamp, signature, {mode: 0o600});
  }
  if (sessionId) {
    if (!/^ses_[a-zA-Z0-9]{1,140}$/.test(sessionId)) throw new AppError('SESSION_INVALID', 'OpenCode 세션 ID를 확인하세요.');
    // CLI export/import preserves native IDs; never grant the agent global database access.
    const marker = join(directory, `session-${sessionId}`);
    if (!(await stat(marker).catch(() => null))) {
      const local = await command(executable, ['export', sessionId, '--pure'], {env, cwd: directory}).then(v => { try { return JSON.parse(v)?.info?.id === sessionId; } catch { return false; } }).catch(() => false);
      if (!local) {
        const exported = await command(executable, ['export', sessionId, '--pure'], {env: {...env, XDG_DATA_HOME: originalData}, cwd: directory});
        let parsed: {info?: {id?: string}};
        try { parsed = JSON.parse(exported); } catch { throw new AppError('SESSION_MIGRATION', '기존 OpenCode 세션을 내보내지 못했습니다.'); }
        if (parsed.info?.id !== sessionId) throw new AppError('SESSION_MIGRATION', '기존 OpenCode 세션 ID가 일치하지 않습니다.');
        const file = join(directory, `session-${sessionId}.json`);
        await writeFile(file, exported, {mode: 0o600});
        await command(executable, ['import', file, '--pure'], {env, cwd: directory});
        await rm(file);
      }
      await writeFile(marker, '', {mode: 0o600});
    }
  }
  const secrets: string[] = [];
  const collect = (value: unknown) => { if (typeof value === 'string' && value.length >= 8) secrets.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
  collect(JSON.parse(await readFile(targetAuth, 'utf8')));
  return secrets;
}
