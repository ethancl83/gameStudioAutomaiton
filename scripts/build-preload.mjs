import { build } from 'esbuild';

// Sandboxed Electron preloads execute as plain JavaScript. Keep Electron external
// so its restricted preload require() supplies the bridge without Node access.
// https://www.electronjs.org/docs/latest/tutorial/esm#sandboxed-preload-scripts-cant-use-esm-imports
await build({
  entryPoints: ['apps/desktop/electron/preload.ts'],
  outfile: 'dist/apps/desktop/electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'warning',
});
