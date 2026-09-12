import type { AppOpsBridge } from '../electron/preload';

declare global {
  interface Window {
    // Electron preload가 주입한다. 브라우저 개발 모드에서는 undefined.
    appOps?: AppOpsBridge;
  }
}

export {};
