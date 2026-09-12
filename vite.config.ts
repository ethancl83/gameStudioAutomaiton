import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { getControllerInfoPath, getDataDirectory } from './packages/domain/paths.js';
import { DevSession } from './packages/dev-session/index.js';

const port = Number(process.env.APPOPS_DEV_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid APPOPS_DEV_PORT');
const apiPort = Number(process.env.APPOPS_PORT ?? 4317);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw new Error('Invalid APPOPS_PORT');
const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
export default defineConfig({
  root: 'apps/desktop',
  base: './',
  plugins: [react(), {
    name: 'local-api-origin-check',
    configureServer(server) {
      const session = new DevSession(getDataDirectory(), port);
      server.middlewares.use((request, response, next) => {
        const bootstrap = request.url === '/__appops_dev_session';
        if (!bootstrap && !request.url?.startsWith('/api')) return next();
        const host = request.headers.host;
        const origin = request.headers.origin;
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? '') || (origin && !origins.has(origin))) {
          response.writeHead(403).end('Origin not allowed');
          return;
        }
        if (bootstrap) {
          if (request.method !== 'POST' || !origin || !origins.has(origin) || !session.acceptsBootstrap(request.headers['x-appops-preview'] as string | undefined)) {
            response.writeHead(403, { 'Cache-Control': 'no-store' }).end('Preview session rejected'); return;
          }
          response.writeHead(204, { 'Set-Cookie': session.cookie(), 'Cache-Control': 'no-store' }).end(); return;
        }
        if (!session.acceptsCookie(request.headers.cookie)) {
          response.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: false, error: {
            code: 'PREVIEW_AUTH_REQUIRED', message: '이 브라우저의 로컬 미리보기 연결이 필요합니다. 데스크톱 앱 또는 개발 미리보기 실행 명령을 사용해 주세요.',
          } })); return;
        }
        next();
      });
    },
  }],
  build: { outDir: '../../dist/apps/desktop/renderer', emptyOutDir: true },
  server: {
    host: '127.0.0.1', port, strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', request => {
            try {
              const info = JSON.parse(readFileSync(getControllerInfoPath(), 'utf8')) as { token: string };
              request.setHeader('authorization', `Bearer ${info.token}`);
            } catch { request.removeHeader('authorization'); }
          });
        },
      },
    },
  },
});
