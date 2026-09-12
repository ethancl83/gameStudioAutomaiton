import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { AppStateProvider } from './appState';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 요소를 찾을 수 없습니다.');

async function start() {
  if (import.meta.env.DEV) {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('preview-token');
    if (token) {
      window.history.replaceState(null, '', window.location.pathname);
      try { await fetch('/__appops_dev_session', { method: 'POST', headers: { 'x-appops-preview': token } }); } catch {}
    }
  }
  // 네이티브: main 소유의 권한 모드를 데이터 요청/디스패치(AppStateProvider의 최초 폴링) 전에 확정한다.
  // 이후 이 클라이언트의 모드는 불변이다. 브라우저: 즉시 반환(저장소 값 유지).
  await api.bootstrap();
  createRoot(container!).render(
    <StrictMode><AppStateProvider><App /></AppStateProvider></StrictMode>,
  );
}
void start();
