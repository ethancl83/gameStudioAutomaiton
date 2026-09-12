// API 클라이언트. 두 실행 환경에서 같은 계약을 제공한다.
// - Electron: window.appOps.request(...)가 main을 거쳐 bearer를 붙여 호출한다.
// - 브라우저 개발 모드: fetch('/api' + path). Vite 프록시가 인증을 주입한다(코디네이터 구현).
// 모든 응답은 계약대로 ApiResult<T>다. 화면은 여기서 해제된 값을 사용한다.
//
// 실행 모드(데모/실제): 같은 화면·요청·작업 계약을 쓰되, 데모는 논리 경로 앞에 `/demo` 를
// 붙여 별도 저장공간·어댑터(루트 구현)로 라우팅한다. 기본값은 데모 미리보기이며, 선호 모드는
// 브라우저 저장소에 보존한다. 모드 전환 시 화면은 상태를 비우고 다시 마운트하므로(appState)
// 이전 모드의 폼이 새 모드를 대상으로 삼지 못한다. 실제 모드도 완전히 동일한 논리 경로를 쓴다.

import type {
  ApiResult,
  AppState,
  ImportedArtifact,
  AutomationPolicy,
  BackupRecord,
  BuildCredential,
  BuildSshDependency,
  Connection,
  OperationsSettings,
  OperationsState,
  Project,
  ProjectSocialPolicy,
  Provider,
  ReleasePipeline,
  RunnerRegistration,
  Run,
  HistoryPage,
  SocialSchedule,
} from '../../../packages/domain';
// 준비(설치) 계약. 타입만 import하므로 Node 전용 구현은 번들에 포함되지 않는다.
import type {
  PreparationPreferences,
  PreparationState,
  ToolId,
  ToolInstall,
  ToolSettings,
} from '../../../packages/setup/types';
// SDK 연동 계약(루트 구현). 순수 타입 파일에서만 가져와 Node 의존성을 번들에서 배제한다.
import type {
  IntegrationApplyResult,
  IntegrationPlatform,
  IntegrationPreview,
  IntegrationProvider,
  IntegrationRollbackResult,
  SdkDetection,
} from '../../../packages/project-integration/types';
// 수명주기 IPC 표시용 타입(preload). 타입만 가져오므로 electron 런타임은 번들되지 않는다.
import type { AutostartStatusView, LifecycleStatus } from '../electron/preload';
// 전체(포터블) 암호화 백업 계약(루트 구현). 타입만 가져와 Node 의존성을 번들에서 배제한다.
import type {
  PortableBackupImport,
  PortableBackupRecord,
  PortableBackupState,
  PortableRestoreRecord,
} from '../../../packages/backup/types';

export type { ApiResult };
export type StoreProvider = 'google-play' | 'app-store' | 'steam';
// GET /projects/:id/integration 응답(루트 구현). previewId/applyId로 상관한다.
export interface ProjectIntegrationState {
  detection: SdkDetection;
  previews: IntegrationPreview[];
  applications: IntegrationApplyResult[];
  recoveryRequired?: {applyId?: string; at: string; reason: string} | null;
}
// POST /projects/:id/integration/preview 입력. 선택한 ID는 저장된 ExternalResource.id다(경로/비밀 아님).
export interface IntegrationPreviewInput {
  provider: IntegrationProvider;
  platform: IntegrationPlatform;
  connectionId: string;
  appId?: string;
  adUnitIds?: string[];
  productIds?: string[];
}

export type RuntimeMode = 'demo' | 'live';
const MODE_KEY = 'appops.runtime.mode';

// 브라우저 폴백(데모·미리보기)에서 메모리로 다루는 전체 백업 크기 상한. 초과 시 데스크톱 앱을 안내한다
// (죽은 버튼 없이 명확한 안내). 네이티브 경로는 디스크 스트리밍이라 이 제한을 받지 않는다.
const BROWSER_PORTABLE_MAX = 128 * 1024 * 1024; // 128 MiB
// 암호화 백업 파일 매직 'APPOPSB1'의 바이트(브라우저 파일 입력 사전 검증). main도 동일 매직을 확인한다.
const BACKUP_MAGIC_BYTES = [0x41, 0x50, 0x50, 0x4f, 0x50, 0x53, 0x42, 0x31];

// 선호 모드를 브라우저 저장소에서 읽는다. 없거나 접근 불가면 데모를 기본값으로 한다.
function readStoredMode(): RuntimeMode {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(MODE_KEY) : null;
    return v === 'live' ? 'live' : 'demo';
  } catch {
    return 'demo';
  }
}

// UI에서 다루기 쉽도록 오류를 던지지 않고 결과 유니온을 그대로 노출한다.
//
// 모드 불변식: 이 클라이언트 인스턴스의 실행 모드는 생성 시 저장소에서 한 번 읽어 고정한다(readonly).
// 모드는 인스턴스 수명 동안 절대 바뀌지 않으므로, 이 클라이언트로 만든 모든 요청·콜백·pending
// promise(폴더 선택 등)는 시작 당시의 모드만 대상으로 삼는다. 전환은 선호만 저장한 뒤 페이지를
// 전체 새로고침(location.reload)하여 새 인스턴스를 만드므로, 이전 모드의 stale promise가 새 트리로
// 들어가거나 다른 모드에 쓰기를 보내는 일이 원천적으로 불가능하다.
export class ApiClient {
  readonly isElectron: boolean;
  // 이 인스턴스의 고정 모드. request()가 데모일 때 논리 경로 앞에 `/demo` 를 붙인다. 네이티브에서는
  // bootstrap()이 main 소유의 권한 모드로 1회 확정하며, 이후에는 절대 바뀌지 않는다(전환=전체 새로고침).
  private currentMode: RuntimeMode;
  private bootstrapped = false;

  constructor() {
    this.isElectron = typeof window !== 'undefined' && !!window.appOps?.isElectron;
    // 동기 최선 추정: 브라우저는 저장소, 네이티브는 부트스트랩 전 임시값(안전 기본값 데모).
    // 네이티브의 진짜 권한 모드는 bootstrap()이 main에서 받아 확정한다(데이터 디스패치 전에 1회).
    this.currentMode = this.isElectron ? 'demo' : readStoredMode();
  }

  // 네이티브: main 소유의 권한 모드를 부트스트랩한다(어떤 데이터 요청/디스패치보다 먼저 1회). 이후 이
  // 인스턴스의 모드는 불변이다 — 전환은 항상 전체 새로고침으로 새 인스턴스를 만들어 적용한다.
  // 브라우저: 생성 시 읽은 저장소 값을 유지한다(별도 조회 없음). 재진입 호출은 무시한다.
  async bootstrap(): Promise<RuntimeMode> {
    if (this.bootstrapped) return this.currentMode;
    if (this.isElectron && window.appOps?.getMode) {
      try {
        const m = await window.appOps.getMode();
        this.currentMode = m === 'live' ? 'live' : 'demo';
      } catch {
        this.currentMode = 'demo'; // 조회 실패 = 안전 기본값
      }
    }
    this.bootstrapped = true;
    return this.currentMode;
  }

  getMode(): RuntimeMode {
    return this.currentMode;
  }

  // 선호 모드만 저장소에 기록한다(브라우저 폴백 전용). 인스턴스 모드는 바꾸지 않는다(불변). 네이티브는
  // 권한을 main이 소유·영속하므로 이 값을 쓰지 않는다. 저장 성공 여부를 반환한다.
  setPreferredMode(mode: RuntimeMode): boolean {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(MODE_KEY, mode);
        return true;
      }
    } catch {
      /* 저장소 접근 불가 */
    }
    return false;
  }

  // 모드 전환 요청. 네이티브: main 소유의 확인창(실제 전환 시 단 하나의 확인)을 거쳐 권한을 바꾸고
  // 결과를 돌려준다(취소 시 canceled). 브라우저: 선호만 저장한다. 어느 경우든 실제 적용은 호출부가
  // 전체 새로고침으로 새 인스턴스를 만들어 수행한다(불변 클라이언트 + reload로 stale 유입 차단).
  async requestModeSwitch(next: RuntimeMode): Promise<{ ok: boolean; canceled?: boolean }> {
    if (next === this.currentMode) return { ok: true };
    if (this.isElectron && window.appOps?.setMode) {
      const r = await window.appOps.setMode(next);
      if (r.ok && r.mode === next) return { ok: true };
      return { ok: false, canceled: r.canceled };
    }
    this.setPreferredMode(next);
    return { ok: true };
  }

  isDemo(): boolean {
    return this.currentMode === 'demo';
  }

  private async browserRequest<T>(method: string, fullPath: string, body?: unknown): Promise<ApiResult<T>> {
    const init: RequestInit = {
      method,
      headers: { accept: 'application/json' },
    };
    if (body !== undefined && body !== null && method !== 'GET') {
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(`/api${fullPath}`, init);
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          return { ok: false, error: { code: 'bad_response', message: '응답을 해석할 수 없습니다.' } };
        }
      }
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
        return parsed as ApiResult<T>;
      }
      if (!res.ok) {
        return { ok: false, error: { code: 'http_error', message: `요청 실패 (HTTP ${res.status}).` } };
      }
      return { ok: true, data: parsed as T };
    } catch {
      return { ok: false, error: { code: 'network_error', message: '제어 서비스에 연결할 수 없습니다.' } };
    }
  }

  // 완성된 전송 경로(`/demo` 접두 포함)로 실제 요청을 보낸다.
  private dispatch<T>(method: string, fullPath: string, body?: unknown): Promise<ApiResult<T>> {
    if (this.isElectron && window.appOps) {
      return window.appOps.request<T>(method, fullPath, body);
    }
    return this.browserRequest<T>(method, fullPath, body);
  }

  // 논리 경로(`/state` 등)를 받아 모드에 따라 `/demo` 를 1회 붙여 전송한다.
  request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const full = this.currentMode === 'demo' ? `/demo${path}` : path;
    return this.dispatch<T>(method, full, body);
  }

  // 데모 전용 경로. 현재 모드와 무관하게 항상 `/demo` 접두를 사용한다(초기화·시나리오).
  private demoRequest<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    return this.dispatch<T>(method, `/demo${path}`, body);
  }

  async selectArtifact(target:string):Promise<string|null> {
    return this.isElectron && window.appOps ? window.appOps.selectArtifact(target) : null;
  }
  importArtifact(projectId:string,input:{path:string;target:string}) {
    return this.request<ImportedArtifact>('POST', `/projects/${encodeURIComponent(projectId)}/artifacts`,input);
  }
  async selectFolder(): Promise<string | null> {
    if (this.isElectron && window.appOps) {
      return window.appOps.selectFolder();
    }
    // 브라우저 개발 모드에는 네이티브 폴더 선택이 없다. 호출부가 경로 입력 폼으로 대체한다.
    return null;
  }

  async openExternal(url: string): Promise<{ ok: boolean; error?: string }> {
    if (this.isElectron && window.appOps) {
      return window.appOps.openExternal(url);
    }
    // 브라우저 모드: 새 탭으로 연다. noopener로 권한 격리.
    window.open(url, '_blank', 'noopener,noreferrer');
    return { ok: true };
  }

  // --- 계약 표의 명시적 작업들 ---

  getHealth() {
    return this.request<{ version: string; startedAt: string }>('GET', '/health');
  }

  getState() {
    return this.request<AppState>('GET', '/state');
  }
  historyQuery(input: { kind: 'runs' | 'events'; before?: number; projectId?: string; runId?: string; status?: string }) {
    return this.request<HistoryPage>('POST', '/history/query', input);
  }

  addProject(path: string) {
    return this.request<Project>('POST', '/projects', { path });
  }

  addMedia(input: {projectId: string; name: string; base64: string}) {
    return this.request<import('../../../packages/domain').MediaAsset>('POST', '/media', input);
  }

  deleteProject(id: string) {
    return this.request<{ deleted: true }>('DELETE', `/projects/${encodeURIComponent(id)}`);
  }

  inspectProject(id: string) {
    return this.request<Project>('POST', `/projects/${encodeURIComponent(id)}/inspect`);
  }
  relinkProject(id: string, path: string) {
    return this.request<Project>('POST', `/projects/${encodeURIComponent(id)}/relink`, { path });
  }

  setPolicy(id: string, policy: AutomationPolicy) {
    return this.request<Project>('PUT', `/projects/${encodeURIComponent(id)}/policy`, policy);
  }

  build(
    id: string,
    input: {
      target: string;
      configuration?: string;
      engineExecutable?: string;
      exportPreset?: string;
      scheme?: string;
      // 준비된 원격 러너(GET /operations)에서 선택. 로컬(현재 OS) 빌드는 비운다.
      runnerId?: string;
    },
  ) {
    return this.request<Run>('POST', `/projects/${encodeURIComponent(id)}/build`, input);
  }

  cancelRun(id: string) {
    return this.request<Run>('POST', `/runs/${encodeURIComponent(id)}/cancel`);
  }

  retryRun(id: string) {
    return this.request<Run>('POST', `/runs/${encodeURIComponent(id)}/retry`);
  }

  // 외부 쓰기 결과의 읽기 전용 재조정(상태 재확인). 쓰기를 재전송하지 않는다.
  reconcileRun(id: string) {
    return this.request<Run>('POST', `/runs/${encodeURIComponent(id)}/reconcile`);
  }
  resolveRun(id: string, input: {outcome:'succeeded'|'failed';note:string;externalId?:string;expectedUpdatedAt:string;confirmed:boolean}) {
    return this.request<Run>('POST', `/runs/${encodeURIComponent(id)}/resolve`, input);
  }

  addConnection(input: {
    provider: Provider;
    label: string;
    accountId: string;
    credentials: Record<string, string>;
  }) {
    return this.request<Connection>('POST', '/connections', input);
  }

  checkConnection(id: string) {
    return this.request<Connection>('POST', `/connections/${encodeURIComponent(id)}/check`);
  }

  deleteConnection(id: string) {
    return this.request<{ deleted: true }>('DELETE', `/connections/${encodeURIComponent(id)}`);
  }

  // Google OAuth 온보딩(신규 연결). 서버가 연결을 만들고 동의 URL을 돌려준다.
  // credentials에는 clientId(필수)·clientSecret?(선택)·packageName? 등 공급자 온보딩 필드만 담는다.
  // refreshToken/serviceAccountJson은 담지 않는다(OAuth 콜백이 갱신 토큰을 대신 저장).
  startGoogleOAuth(body: {
    provider: 'google-play' | 'google-ads' | 'admob';
    label: string;
    accountId: string;
    credentials: Record<string, string>;
  }) {
    return this.request<{ connectionId: string; authorizationUrl: string }>('POST', '/oauth/google/start', body);
  }

  // 기존 Google 연결 재인증. 저장된 클라이언트 설정을 재사용한다(본문 없음).
  startConnectionOAuth(id: string) {
    return this.request<{ connectionId: string; authorizationUrl: string }>(
      'POST',
      `/connections/${encodeURIComponent(id)}/oauth/start`,
      {},
    );
  }

  // 자격 증명 병합 수정(취소된 키 복구). 서버가 기존 값을 노출하지 않고 새 값만 병합한다.
  repairCredentials(id: string, credentials: Record<string, string>) {
    return this.request<Connection>('PUT', `/connections/${encodeURIComponent(id)}/credentials`, { credentials });
  }

  runAction(
    connectionId: string,
    input: {
      operation: string;
      projectId?: string;
      input: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ) {
    return this.request<Run>('POST', `/connections/${encodeURIComponent(connectionId)}/actions`, input);
  }

  // --- 빌드 서명·SSH 자격 증명 ---
  // 비밀 값(privateKey/keystoreBase64/암호 등)은 로컬 API로만 전송되고, 응답에는 메타데이터만 온다.
  // 목록은 AppState.buildCredentials 로 노출되며 개별 조회(비밀 반환) 엔드포인트는 없다.
  addBuildCredential(input: { kind: BuildCredential['kind']; label: string; credentials: Record<string, string> }) {
    return this.request<BuildCredential>('POST', '/build-credentials', input);
  }

  // 라벨 변경 또는 비밀 회전(병합). 빈 credentials는 라벨만 수정한다.
  updateBuildCredential(id: string, input: { label?: string; credentials?: Record<string, string> }) {
    return this.request<BuildCredential>('PUT', `/build-credentials/${encodeURIComponent(id)}`, input);
  }

  // 사용 중이면 서버가 거부한다(프로젝트 빌드 보안에서 먼저 제거해야 함).
  deleteBuildCredential(id: string) {
    return this.request<{ deleted: true }>('DELETE', `/build-credentials/${encodeURIComponent(id)}`);
  }

  // 프로젝트 빌드 보안: Android 서명 키 선택 + SSH 의존성 목록 저장.
  setBuildSecurity(projectId: string, input: { androidKeystoreId?: string; sshDependencies: BuildSshDependency[] }) {
    return this.request<Project>('PUT', `/projects/${encodeURIComponent(projectId)}/build-security`, input);
  }

  // --- 커뮤니티(SNS) ---
  // 프로젝트 소셜 자동화 정책 저장(1회 위임). 전체 정책을 전송한다.
  setSocialPolicy(projectId: string, policy: ProjectSocialPolicy) {
    return this.request<Project>('PUT', `/projects/${encodeURIComponent(projectId)}/social-policy`, policy);
  }

  // 예약 게시(내구성). scheduledAt은 ISO 문자열.
  createSocialSchedule(input: { projectId: string; connectionIds: string[]; text: string; scheduledAt: string }) {
    return this.request<SocialSchedule>('POST', '/social/schedules', input);
  }

  // 예약 취소(대기 중인 항목만 서버가 취소).
  cancelSocialSchedule(id: string) {
    return this.request<{ cancelled: true }>('DELETE', `/social/schedules/${encodeURIComponent(id)}`);
  }

  // 소셜(X/Threads) 브라우저 OAuth 시작(신규 연결). 서버가 연결을 만들고 동의 URL을 돌려준다.
  startSocialOAuth(
    provider: 'x' | 'threads',
    body: { label: string; accountId: string; credentials: Record<string, string> },
  ) {
    return this.request<{ connectionId: string; authorizationUrl: string }>('POST', `/oauth/social/${provider}/start`, body);
  }

  // 기존 소셜 연결 재인증. 저장된 클라이언트 설정을 재사용하며 필요 시 새 credentials만 병합한다.
  startConnectionSocialOAuth(id: string, body: { credentials?: Record<string, string> } = {}) {
    return this.request<{ connectionId: string; authorizationUrl: string }>(
      'POST',
      `/connections/${encodeURIComponent(id)}/oauth/social/start`,
      body,
    );
  }

  // --- 공통 출시 파이프라인 ---
  // 검수→빌드→업로드를 자식 작업으로 저장하는 출시 파이프라인을 시작한다. 진행 상태는
  // AppState.pipelines(ReleasePipeline[])로 조회하고, 자식 작업(buildRunId/uploadRunId)을 드릴다운한다.
  // 실제 운영은 저장된 권한·정책·검증된 빌드만 사용한다(서버가 최종 판단).
  publishProject(
    id: string,
    input: {
      target: string;
      idempotencyKey?: string;
      connectionId: string;
      track?: string;
      version?: string;
      releaseNotes?: string;
      configuration?: string;
      exportPreset?: string;
      scheme?: string;
      buildRunId?: string;
      importedArtifactId?: string;
      // 준비된 원격 러너(GET /operations)에서 선택. 로컬(현재 OS) 빌드는 비운다.
      runnerId?: string;
    },
  ) {
    return this.request<ReleasePipeline>('POST', `/projects/${encodeURIComponent(id)}/publish`, input);
  }

  // --- 운영 준비(러너·준비 상태·백업·설정·진단) ---
  getOperations() {
    return this.request<OperationsState>('GET', '/operations');
  }

  updateOperationsSettings(settings: OperationsSettings) {
    return this.request<OperationsSettings>('PUT', '/operations/settings', settings);
  }

  createBackup(input: { description?: string } = {}) {
    return this.request<BackupRecord>('POST', '/operations/backup', input);
  }

  // 복원 결과: 되돌린 프로젝트 수와 안전을 위해 일시중지된 자동화 수를 반환한다.
  restoreBackup(backupId: string) {
    return this.request<RestoreResult>('POST', '/operations/restore', { backupId });
  }

  // 비밀이 제거된 진단 묶음을 생성한다. 서버가 내용을 구성하며, 화면은 받은 내용만 표시·저장한다.
  runDiagnostics() {
    return this.request<DiagnosticsReport>('POST', '/operations/diagnostics', {});
  }

  // pairingToken은 러너를 최초 결합할 때 쓰는 1회용 비밀이다. 실제 모드에서는 필수이며,
  // 데모에서는 생략한다(루트가 합성 결합).
  registerRunner(input: {
    label: string;
    platform: 'linux' | 'darwin' | 'win32';
    endpoint: string;
    pairingToken?: string;
  }) {
    return this.request<RunnerRegistration>('POST', '/operations/runners', input);
  }

  checkRunner(id: string) {
    return this.request<RunnerRegistration>('POST', `/operations/runners/${encodeURIComponent(id)}/check`);
  }

  deleteRunner(id: string) {
    return this.request<{ deleted: true }>('DELETE', `/operations/runners/${encodeURIComponent(id)}`);
  }

  // --- 운영 준비(설치·엔진/SDK 경로·설치 진행) ---
  // 데모/실제 같은 논리 경로다. 데모는 별도 저장공간·합성 설치, 실제는 검증된 설치를 사용한다(루트 구현).
  getSetup() {
    return this.request<PreparationState>('GET', '/setup');
  }
  // 부분 갱신. 빈 문자열/누락 키는 해당 도구 경로를 지운다(서버가 처리).
  saveTools(partial: Partial<ToolSettings>) {
    return this.request<ToolSettings>('PUT', '/setup/tools', partial);
  }
  rescanSetup() {
    return this.request<PreparationState>('POST', '/setup/rescan', {});
  }
  // 검증된 카탈로그 자원 설치 시작. 라이선스 동의는 도구 동작당 1회 필요할 때만 보낸다.
  startToolInstall(input: { toolId: ToolId; acceptLicense?: boolean; androidPackages?: string[] }) {
    return this.request<ToolInstall>('POST', '/setup/install', input);
  }
  cancelToolInstall(id: string) {
    return this.request<ToolInstall>('POST', `/setup/install/${encodeURIComponent(id)}/cancel`, {});
  }

  // --- 프로젝트 준비 설정(대상·러너·계정·엔진 실행 파일·내보내기 설정) ---
  savePreparation(
    id: string,
    prefs: {
      target: string;
      runnerId?: string;
      connectionId?: string;
      engineExecutable?: string;
      exportPreset?: string;
      scheme?: string;
      sdkRequired?: boolean;
    },
  ) {
    return this.request<PreparationPreferences>('PUT', `/projects/${encodeURIComponent(id)}/preparation`, prefs);
  }

  // --- 스토어 앱 매핑 ---
  // 앱 매핑을 저장하면 서버가 해당 계정을 프로젝트 정책에 부여한다. 저장만으로 확인됨으로 표시하지 않는다.
  saveStoreApp(id: string, input: { provider: StoreProvider; connectionId: string; appId: string }) {
    return this.request<Project>('PUT', `/projects/${encodeURIComponent(id)}/store-app`, input);
  }
  // 실제 읽기 전용 API 조회(데모는 합성 시뮬레이션). verifiedAt은 서버가 조회에 성공해야만 기록한다.
  checkStoreApp(id: string, input: { provider: StoreProvider }) {
    return this.request<Project>('POST', `/projects/${encodeURIComponent(id)}/store-app/check`, input);
  }

  // --- 게임 내 광고/결제 SDK 연동(루트 구현, 여기서는 소비자) ---
  getIntegration(id: string) {
    return this.request<ProjectIntegrationState>('GET', `/projects/${encodeURIComponent(id)}/integration`);
  }
  // 미리보기: 선택한 광고/상품은 저장된 ExternalResource.id다. 원본 보존·변경 미리보기·해시를 돌려준다.
  previewIntegration(id: string, input: IntegrationPreviewInput) {
    return this.request<IntegrationPreview>('POST', `/projects/${encodeURIComponent(id)}/integration/preview`, input);
  }
  applyIntegration(id: string, input: { previewId: string }) {
    return this.request<IntegrationApplyResult>('POST', `/projects/${encodeURIComponent(id)}/integration/apply`, input);
  }
  rollbackIntegration(id: string, input: { applyId: string }) {
    return this.request<IntegrationRollbackResult>('POST', `/projects/${encodeURIComponent(id)}/integration/rollback`, input);
  }

  // --- 앱/제어 서비스 수명주기 (IPC, 데스크톱 전용) ---
  // HTTP가 아닌 IPC로 동작하므로 제어 서비스가 내려가도 상태 조회·재시작이 가능하다.
  // 데모 모드에서는 실제 제어 서비스·OS 자동 시작을 절대 바꾸지 않는다(변경 계열은 차단).
  private desktopOnly<T>(): ApiResult<T> {
    return { ok: false, error: { code: 'desktop_only', message: '수명주기 제어는 데스크톱 앱에서만 사용할 수 있습니다.' } };
  }
  private demoBlocked<T>(): ApiResult<T> {
    return { ok: false, error: { code: 'demo_blocked', message: '데모에서는 실제 제어 서비스·자동 시작을 바꾸지 않습니다.' } };
  }
  async lifecycleStatus(): Promise<ApiResult<LifecycleStatus>> {
    if (this.isElectron && window.appOps) return window.appOps.lifecycle.status();
    return this.desktopOnly<LifecycleStatus>();
  }
  async stopController(): Promise<ApiResult<{ stopped: boolean; wasRunning: boolean }>> {
    if (this.isDemo()) return this.demoBlocked();
    if (this.isElectron && window.appOps) return window.appOps.lifecycle.stopController();
    return this.desktopOnly();
  }
  async restartController(): Promise<ApiResult<{ running: boolean }>> {
    if (this.isDemo()) return this.demoBlocked();
    if (this.isElectron && window.appOps) return window.appOps.lifecycle.restartController();
    return this.desktopOnly();
  }
  async autostartStatus(): Promise<ApiResult<AutostartStatusView>> {
    if (this.isElectron && window.appOps) return window.appOps.autostart.status();
    return this.desktopOnly<AutostartStatusView>();
  }
  async autostartEnable(): Promise<ApiResult<AutostartStatusView>> {
    if (this.isDemo()) return this.demoBlocked();
    if (this.isElectron && window.appOps) return window.appOps.autostart.enable();
    return this.desktopOnly<AutostartStatusView>();
  }
  async autostartDisable(): Promise<ApiResult<AutostartStatusView>> {
    if (this.isDemo()) return this.demoBlocked();
    if (this.isElectron && window.appOps) return window.appOps.autostart.disable();
    return this.desktopOnly<AutostartStatusView>();
  }

  // --- 전체(포터블) 암호화 백업 ---
  // 설정 백업(위)과 별개다. 프로젝트·정책·설정에 더해 자격 증명·산출물·이력까지 암호화 아카이브로 담는다.
  // 모든 경로는 모드에 따라 /api 또는 /api/demo로 라우팅된다(불변 모드 클라이언트). 데모는 격리 저장공간만
  // 대상으로 하며 실제 제어 서비스를 재시작하지 않는다.
  getPortableBackups(): Promise<ApiResult<PortableBackupState>> {
    return this.request<PortableBackupState>('GET', '/operations/portable-backups');
  }
  // 암호는 이 요청에만 쓰이고 저장·기록되지 않는다. 생성은 status:'creating'으로 시작하고 GET으로 폴링한다.
  createPortableBackup(passphrase: string): Promise<ApiResult<PortableBackupRecord>> {
    return this.request<PortableBackupRecord>('POST', '/operations/portable-backups', { passphrase });
  }
  // 복원 준비: 암호로 아카이브를 열어 검증하고 요약(projectCount 등)을 만든다. status:'preparing' → 폴링.
  preparePortableRestore(backupId: string, passphrase: string): Promise<ApiResult<PortableRestoreRecord>> {
    return this.request<PortableRestoreRecord>(
      'POST',
      `/operations/portable-backups/${encodeURIComponent(backupId)}/prepare-restore`,
      { passphrase },
    );
  }
  // 커밋(명시적 덮어쓰기): 실제 모드는 restartRequired:true를 돌려주고 호출부가 명시적으로 재시작한다.
  // 데모는 격리 복원만 수행하고 restartRequired:false(restored:true)를 돌려준다 — 실제 서비스는 손대지 않는다.
  commitPortableRestore(restoreId: string): Promise<ApiResult<{ restartRequired: boolean; restored?: true }>> {
    return this.request<{ restartRequired: boolean; restored?: true }>(
      'POST',
      '/operations/portable-backups/commit-restore',
      { restoreId },
    );
  }

  private modePrefix(): string {
    return this.currentMode === 'demo' ? '/demo' : '';
  }

  // 내보내기(다운로드→디스크). Electron은 네이티브 스트리밍 저장(길이·SHA-256 검증 후 원자적 저장),
  // 브라우저는 인증 세션으로 blob 저장(용량 제한). 어느 경로든 renderer는 토큰을 만지지 않는다.
  async savePortableBackup(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
    if (this.isElectron && window.appOps) return window.appOps.savePortableBackup(id);
    return this.downloadPortableBackupInBrowser(id);
  }

  // 가져오기(Electron): 네이티브 dialog로 .appopsbackup을 골라 스트리밍 업로드하고 {id,size}를 반환한다.
  async importPortableBackupNative(): Promise<ApiResult<PortableBackupImport>> {
    if (this.isElectron && window.appOps) return window.appOps.importPortableBackup();
    return { ok: false, error: { code: 'desktop_only', message: '데스크톱 앱에서 파일을 선택하세요.' } };
  }

  // 가져오기(브라우저): <input type=file>에서 받은 파일을 인증 세션으로 업로드한다(매직·용량 검증).
  async importPortableBackupFromFile(file: File): Promise<ApiResult<PortableBackupImport>> {
    if (this.isElectron) return this.importPortableBackupNative();
    if (!(file.size > 0)) return { ok: false, error: { code: 'empty', message: '빈 파일입니다.' } };
    if (file.size > BROWSER_PORTABLE_MAX) {
      return { ok: false, error: { code: 'too_large', message: '파일이 너무 커서 브라우저에서 가져올 수 없습니다. 데스크톱 앱을 사용하세요.' } };
    }
    try {
      const head = new Uint8Array(await file.slice(0, BACKUP_MAGIC_BYTES.length).arrayBuffer());
      if (head.length < BACKUP_MAGIC_BYTES.length || BACKUP_MAGIC_BYTES.some((b, i) => head[i] !== b)) {
        return { ok: false, error: { code: 'bad_magic', message: 'AppOps 암호화 백업 파일이 아닙니다(.appopsbackup).' } };
      }
    } catch {
      return { ok: false, error: { code: 'read_failed', message: '파일을 읽을 수 없습니다.' } };
    }
    try {
      const res = await fetch(`/api${this.modePrefix()}/operations/portable-backups/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', accept: 'application/json' },
        body: file,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          return { ok: false, error: { code: 'bad_response', message: '응답을 해석할 수 없습니다.' } };
        }
      }
      if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed as ApiResult<PortableBackupImport>;
      if (!res.ok) return { ok: false, error: { code: 'http_error', message: `가져오기 실패 (HTTP ${res.status}).` } };
      return { ok: true, data: parsed as PortableBackupImport };
    } catch {
      return { ok: false, error: { code: 'network_error', message: '제어 서비스에 연결할 수 없습니다.' } };
    }
  }

  // 브라우저 폴백 다운로드. 네이티브만큼의 원자성·덮어쓰기 보장은 없지만, 저장(다운로드 트리거) 전에
  // 데스크톱과 동등하게 선언 길이·SHA-256·매직을 검증한다. 하나라도 불일치/누락이면 저장하지 않는다.
  private async downloadPortableBackupInBrowser(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }> {
    try {
      const res = await fetch(`/api${this.modePrefix()}/operations/portable-backups/${encodeURIComponent(id)}/download`, {
        headers: { accept: 'application/vnd.appops.backup' },
      });
      if (!res.ok) return { ok: false, error: `내보내기 실패 (HTTP ${res.status}).` };
      const lenHeader = res.headers.get('content-length');
      const declaredLen = lenHeader !== null && lenHeader !== '' ? Number(lenHeader) : NaN;
      if (Number.isFinite(declaredLen) && declaredLen > BROWSER_PORTABLE_MAX) {
        return { ok: false, error: '백업이 너무 커서 브라우저에서 내보낼 수 없습니다. 데스크톱 앱을 사용하세요.' };
      }
      const expectedSha = (res.headers.get('x-appops-sha256') ?? '').trim().toLowerCase();
      const buf = await res.arrayBuffer();
      if (buf.byteLength > BROWSER_PORTABLE_MAX) {
        return { ok: false, error: '백업이 너무 커서 브라우저에서 내보낼 수 없습니다. 데스크톱 앱을 사용하세요.' };
      }
      // 선언 길이 검증(정수·양수·수신 바이트와 정확 일치).
      if (!Number.isInteger(declaredLen) || declaredLen <= 0 || buf.byteLength !== declaredLen) {
        return { ok: false, error: '내려받은 백업의 길이 정보가 일치하지 않습니다. 데스크톱 앱을 사용하세요.' };
      }
      // 매직(APPOPSB1) 검증.
      const bytes = new Uint8Array(buf);
      if (bytes.length < BACKUP_MAGIC_BYTES.length || BACKUP_MAGIC_BYTES.some((b, i) => bytes[i] !== b)) {
        return { ok: false, error: 'AppOps 암호화 백업 형식이 아닙니다.' };
      }
      // SHA-256 검증(헤더 필수 + 실제 바이트 해시 일치).
      if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
        return { ok: false, error: '백업 무결성 해시가 없어 내보낼 수 없습니다. 데스크톱 앱을 사용하세요.' };
      }
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = Array.from(new Uint8Array(digest))
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
      if (hex !== expectedSha) {
        return { ok: false, error: '내려받은 백업의 해시가 일치하지 않습니다. 다시 시도해 주세요.' };
      }
      const blob = new Blob([buf], { type: 'application/vnd.appops.backup' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `appops-backup-${id}.appopsbackup`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return { ok: true };
    } catch {
      return { ok: false, error: '내보내기 중 오류가 발생했습니다.' };
    }
  }

  // --- 데모 전용 제어 ---
  // 데모 저장공간만 초기화한다(실제 자원에 영향 없음). 항상 `/demo` 접두를 사용한다.
  resetDemo() {
    return this.demoRequest<{ reset: true }>('POST', '/reset', {});
  }

  // 다음 적합한 데모 작업의 실패·복구 경로를 재현한다(네트워크/인증/심사 오류 등).
  setDemoScenario(scenario: DemoScenario) {
    return this.demoRequest<{ scenario: DemoScenario }>('POST', '/scenario', { scenario });
  }
}

// 데모 시나리오: 다음 적합한 데모 작업에서 재현할 실패·복구 경로.
export type DemoScenario = 'normal' | 'network-error' | 'auth-expired' | 'review-rejected';

// 백업 복원 결과. 백업은 프로젝트·정책·운영 설정의 논리 백업이며 계정 키·거래 원장은 보존한다.
// 복원된 자동화는 안전을 위해 일시중지된다(automationsPaused 수).
export interface RestoreResult {
  restored: boolean;
  projectCount: number;
  automationsPaused: boolean;
}

// 진단 묶음 응답. 서버가 비밀을 제거해 구성한다. 정확한 필드는 서버가 정하며, 화면은
// 요약·내용을 있는 그대로 표시하고 JSON 전체를 내려받기로 제공한다.
export interface DiagnosticsReport {
  id?: string;
  createdAt?: string;
  summary?: string;
  content?: string;
  checks?: { label: string; status: string; detail?: string }[];
  [key: string]: unknown;
}

export const api = new ApiClient();
