// preload: renderer에 최소 API(window.appOps)만 노출한다.
// bearer 토큰이나 Node API는 화면에 노출하지 않는다. 모든 특권 작업은 main으로 IPC 전달된다.

import { contextBridge, ipcRenderer } from 'electron';
import type { ApiResult } from '../../../packages/domain/index.js';
import type { PortableBackupImport } from '../../../packages/backup/types.js';

// 수명주기 상태(main.ts의 appops:lifecycle:status 페이로드). renderer는 packages/lifecycle을
// 직접 import하지 않는다(Node 전용 의존성). 필요한 표시용 형태만 여기서 재선언한다.
export interface LifecycleControllerStatus {
  running: boolean;
  adopted: boolean;
  port?: number;
  pid?: number;
  startedAt?: string;
}
export interface AutostartStatusView {
  method: string;
  installed: boolean;
  enabled: boolean;
  path?: string;
  detail?: string;
}
export interface LifecycleStatus {
  controller: LifecycleControllerStatus;
  autostart: AutostartStatusView;
  autostartInstallable: boolean;
  sandbox?: { ok: boolean; detail: string };
}

export interface AppOpsBridge {
  // 논리 경로(/state, /projects ...)로 제어 서비스 API를 호출한다. main이 '/api' 접두사와 bearer를 처리한다.
  request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>>;
  // 네이티브 폴더 선택. 취소 시 null.
  selectArtifact(target: string): Promise<string | null>;
  selectFolder(): Promise<string | null>;
  // 허용된 HTTPS 설정 링크만 시스템 브라우저로 연다.
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
  platform(): Promise<string>;
  // 앱/제어 서비스 수명주기. HTTP가 아닌 IPC로 동작하므로 제어 서비스가 내려가도 사용할 수 있다.
  // 화면 종료와 제어 서비스 종료는 별개이며, 중지/재시작은 명시적 조치다.
  lifecycle: {
    status(): Promise<ApiResult<LifecycleStatus>>;
    stopController(): Promise<ApiResult<{ stopped: boolean; wasRunning: boolean }>>;
    restartController(): Promise<ApiResult<{ running: boolean }>>;
  };
  // OS 로그인 자동 시작(사용자별). enable/disable는 실제 OS 설정을 바꾼다.
  autostart: {
    status(): Promise<ApiResult<AutostartStatusView>>;
    enable(): Promise<ApiResult<AutostartStatusView>>;
    disable(): Promise<ApiResult<AutostartStatusView>>;
  };
  // 실행 모드(데모/실제) 권한 브리지. 권한은 main이 소유·영속하므로 renderer는 여기서 읽고(setMode로)
  // 전환을 요청만 한다. 실제(live) 전환은 main 소유의 확인창을 통과해야 반영된다(취소 시 canceled).
  getMode(): Promise<'demo' | 'live'>;
  setMode(mode: 'demo' | 'live'): Promise<{ ok: boolean; mode: 'demo' | 'live'; canceled?: boolean }>;
  // 전체(포터블) 암호화 백업 파일 브리지. 대용량 파일을 main이 loopback+bearer로 스트리밍한다.
  // renderer는 파일 바이트·경로·토큰을 다루지 않는다. 데모/실제 라우팅은 main이 소유한 모드를 따른다.
  // - savePortableBackup(id): 백업을 내려받아 사용자가 고른 위치에 검증 후 원자적 저장(취소 가능).
  // - importPortableBackup(): 네이티브 dialog로 .appopsbackup을 골라 스트리밍 업로드하고 {id,size}를 반환.
  savePortableBackup(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
  importPortableBackup(): Promise<ApiResult<PortableBackupImport>>;
  // Electron 런타임 여부를 renderer가 구분한다.
  readonly isElectron: true;
}

// 모든 특권 작업은 main이 소유한 실행 모드(effectiveMode)를 기준으로 판정·라우팅한다. preload는 모드
// 문자열을 전달하지 않는다 — renderer가 문자열로 권한을 바꿀 수 없게 하기 위함이다. 전환은 setMode로만.
const bridge: AppOpsBridge = {
  request: (method, path, body) => ipcRenderer.invoke('appops:request', method, path, body),
  selectArtifact: (target) => ipcRenderer.invoke('appops:selectArtifact', target),
  selectFolder: () => ipcRenderer.invoke('appops:selectFolder'),
  openExternal: (url) => ipcRenderer.invoke('appops:openExternal', url),
  platform: () => ipcRenderer.invoke('appops:platform'),
  lifecycle: {
    status: () => ipcRenderer.invoke('appops:lifecycle:status'),
    // 변경 계열은 main이 소유한 모드로 데모를 거부한다(renderer가 모드를 넘기지 않는다).
    stopController: () => ipcRenderer.invoke('appops:lifecycle:stopController'),
    restartController: () => ipcRenderer.invoke('appops:lifecycle:restartController'),
  },
  autostart: {
    status: () => ipcRenderer.invoke('appops:autostart:status'),
    enable: () => ipcRenderer.invoke('appops:autostart:enable'),
    disable: () => ipcRenderer.invoke('appops:autostart:disable'),
  },
  getMode: () => ipcRenderer.invoke('appops:mode:get'),
  setMode: (mode) => ipcRenderer.invoke('appops:mode:set', mode),
  // 파일 브리지의 데모/실제 라우팅도 main이 소유한 모드를 따른다(renderer가 모드를 넘기지 않는다).
  savePortableBackup: (id) => ipcRenderer.invoke('appops:portableBackup:save', id),
  importPortableBackup: () => ipcRenderer.invoke('appops:portableBackup:import'),
  isElectron: true,
};

contextBridge.exposeInMainWorld('appOps', bridge);
