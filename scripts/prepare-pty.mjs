import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// npm tarballs may lose the executable bit on node-pty's macOS spawn helper.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  const metadata = await stat(helper);
  if (!(metadata.mode & 0o111)) await chmod(helper, metadata.mode | 0o111);
}
