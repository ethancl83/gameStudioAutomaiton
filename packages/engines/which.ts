import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

export async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    const st = await stat(file);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function pathLookup(names: string[], extraDirs: string[] = []): Promise<string | null> {
  const dirs = [
    ...extraDirs,
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export async function firstExistingFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export async function globDirs(patternParent: string, childPath: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await readdir(patternParent);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    const candidate = join(patternParent, name, childPath);
    if (await isExecutable(candidate)) found.push(candidate);
  }
  return found;
}

export async function readCommandOutput(executable: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.platform==='win32'?`${process.env.SystemRoot||'C:\\Windows'}\\System32`:'/usr/bin:/bin:/usr/local/bin',
        ...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot||'C:\\Windows'}:{}), LANG:'C.UTF-8' } });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if(out.length+chunk.length>64*1024){child.kill('SIGKILL');resolve(null);return;}out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if(out.length+chunk.length>64*1024){child.kill('SIGKILL');resolve(null);return;}out += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code===0?out.trim()||null:null);
    });
  });
}

export function home(): string {
  try {
    return homedir();
  } catch {
    return process.env.HOME ?? '';
  }
}

export function firstLineVersion(text: string | null): string | null {
  if (!text) return null;
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const m = line.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m?.[1] ?? line.slice(0, 80);
}
