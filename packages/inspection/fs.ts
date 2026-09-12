import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    const st = await lstat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function readTextFile(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

export async function readRootNames(root: string): Promise<string[]> {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

export function joinRoot(root: string, ...parts: string[]): string {
  return join(root, ...parts);
}

export async function resolveExisting(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

export async function readIfExists(root: string, rel: string): Promise<string | null> {
  return readTextFile(join(root, rel));
}

export async function existsIn(root: string, rel: string): Promise<boolean> {
  return pathExists(join(root, rel));
}
