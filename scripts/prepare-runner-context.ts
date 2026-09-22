import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only application source is copied from these trees, never runtime data or dependencies.
export const RUNNER_SOURCE_DIRECTORIES = [
  'apps/runner', 'packages/build-credentials', 'packages/domain', 'packages/engines',
  'packages/inspection', 'packages/remote-runner', 'packages/metrics',
  'packages/credentials', 'packages/storage',
];
export const RUNNER_CONTEXT_FILES = [
  'package.json', 'package-lock.json', 'tsconfig.json', '.dockerignore',
  'apps/controller/validation.ts', 'packages/connectors/types.ts',
  'docker/runner/Dockerfile',
  'docker/runner/start.sh', 'docker/runner/install-godot.sh',
  'docker/runner/healthcheck.mjs', 'docker/runner/seccomp-bwrap.json',
];
const excluded = new Set(['node_modules', 'tmp', 'vault', 'dist', 'data']);

export async function prepareRunnerContext(source: string, destination: string): Promise<string[]> {
  const files = [...RUNNER_CONTEXT_FILES];
  async function collect(relative: string): Promise<void> {
    if (!(await lstat(join(source, relative))).isDirectory()) throw new Error(`Expected source directory: ${relative}`);
    for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Runner context rejects symbolic links: ${path}`);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  }
  for (const directory of RUNNER_SOURCE_DIRECTORIES) await collect(directory);
  // Validate before creating the output; an existing context is never merged or deleted.
  for (const file of files) {
    const info = await lstat(join(source, file));
    if (!info.isFile() || info.nlink !== 1) throw new Error(`Runner context requires a regular, unlinked file: ${file}`);
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (!(await lstat(join(source, ...parts.slice(0, i)))).isDirectory()) throw new Error(`Runner context rejects linked directories: ${file}`);
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { mode: 0o700 });
  for (const file of files.sort()) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(source, file), target);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const destination = resolve(process.argv[2] ?? join(source, 'tmp/docker-runner-context'));
  await prepareRunnerContext(source, destination);
  process.stdout.write(destination + '\n');
}
