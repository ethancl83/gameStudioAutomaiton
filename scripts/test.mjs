import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await findTests(path));
    else if (entry.name.endsWith('.test.ts')) result.push(path);
  }
  return result.sort();
}
const files = await findTests('tests');
if (!files.length) throw new Error('No behavioral tests have been implemented.');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
