import { createHash } from 'node:crypto';
import { access, chmod, constants, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { AppError, redact, text } from '../domain/errors.js';
import type { Capability } from '../domain/index.js';
import { decimalToMicros, renderVdf, runCommand, type VdfNode } from './store-tools.js';
import type { Connector, ConnectorContext, ConnectorResult, MetricInput, ResourceInput } from './types.js';
import { createSteamAnnouncement, reconcileSteamLive, setSteamBuildLive } from './store-steam-ops.js';

const API = 'https://partner.steam-api.com';
const STEAMCMD_TIMEOUT_MS = 45 * 60 * 1000;
// SteamCMD writes its refreshed login session into its own install directory.
// Runs against the same install must not overlap, and we serialize per path.
const steamcmdLocks = new Map<string, Promise<unknown>>();

function requireApiKey(context: ConnectorContext): string {
  const key = context.credentials.apiKey;
  if (!key) {
    throw new AppError('MISSING_REQUIREMENT', 'Steamworks 파트너 Web API 키(apiKey)가 필요합니다. 연결 설정에서 게시자 키를 등록해 주세요.');
  }
  return key;
}

function financialKey(context: ConnectorContext): string {
  const key = context.credentials.financialApiKey || context.credentials.apiKey;
  if (!key) {
    throw new AppError('MISSING_REQUIREMENT', '매출 수집에는 Financial API Group의 Web API 키(financialApiKey)가 필요합니다.');
  }
  return key;
}

function requireAppId(context: ConnectorContext): string {
  const appId = context.project?.appIdentifier;
  if (!appId || !/^\d{1,10}$/.test(appId)) {
    throw new AppError('MISSING_REQUIREMENT', '이 작업에는 Steam App ID가 확인된 프로젝트 연결이 필요합니다. 프로젝트의 앱 식별자가 숫자 App ID인지 확인해 주세요.');
  }
  return appId;
}

function withKey(path: string, key: string, parameters: Record<string, string> = {}): string {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('key', key);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Steam responses vary between arrays and id-keyed objects; normalize both. */
function entries(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  const nested = record.app ?? record.build;
  if (Array.isArray(nested)) return nested.map(asRecord);
  return Object.entries(record).map(([id, item]) => ({ id, ...asRecord(item) }));
}

async function fetchAppList(context: ConnectorContext): Promise<Array<{ appid: string; name: string; type: string }>> {
  const payload = await context.request<Record<string, unknown>>(
    withKey('/ISteamApps/GetPartnerAppListForWebAPIKey/v2/', requireApiKey(context)),
  );
  const applist = asRecord(payload.applist ?? asRecord(payload.response).applist);
  const rows = entries(applist.apps ?? applist);
  return rows
    .map(row => ({
      appid: String(row.appid ?? row.id ?? ''),
      name: typeof row.app_name === 'string' ? row.app_name : typeof row.name === 'string' ? row.name : '',
      type: typeof row.app_type === 'string' ? row.app_type : typeof row.type === 'string' ? row.type : '',
    }))
    .filter(app => /^\d+$/.test(app.appid));
}

interface BuildDeliveryStatus {
  configured: boolean;
  steamcmdFound: boolean;
  sessionCached: boolean;
  reason?: string;
}

async function buildDeliveryStatus(context: ConnectorContext): Promise<BuildDeliveryStatus> {
  const { buildUsername, steamcmdPath } = context.credentials;
  if (!buildUsername || !steamcmdPath) {
    return { configured: false, steamcmdFound: false, sessionCached: false, reason: 'buildUsername/steamcmdPath가 설정되지 않아 빌드 전송을 사용할 수 없습니다.' };
  }
  let steamcmdFound = false;
  try {
    await access(steamcmdPath, constants.X_OK);
    steamcmdFound = (await stat(steamcmdPath)).isFile();
  } catch {
    steamcmdFound = false;
  }
  let sessionCached = Boolean(context.credentials.steamSessionConfig);
  try {
    await access(sessionConfigPath(context), constants.R_OK);
    sessionCached = true;
  } catch {
    /* fall through to the vault copy flag */
  }
  return {
    configured: true,
    steamcmdFound,
    sessionCached,
    reason: steamcmdFound ? undefined : '지정한 SteamCMD 실행 파일을 찾지 못했습니다.',
  };
}

function trustedSteamcmdPath(context: ConnectorContext): string {
  // The executable path comes only from the one-time connection settings,
  // never from action input, and must be a dedicated build-account install.
  const path = context.credentials.steamcmdPath;
  if (!path || !isAbsolute(path) || !['steamcmd', 'steamcmd.sh', 'steamcmd.exe'].includes(basename(path))) {
    throw new AppError('MISSING_REQUIREMENT', '연결 설정의 steamcmdPath가 절대 경로의 steamcmd 실행 파일이 아닙니다. 빌드 계정 전용 SteamCMD 설치 경로를 지정해 주세요.');
  }
  return path;
}

function sessionConfigPath(context: ConnectorContext): string {
  const configured = context.credentials.steamcmdConfigPath;
  if (configured) return configured;
  return join(dirname(context.credentials.steamcmdPath ?? ''), 'config', 'config.vdf');
}

async function restoreSessionConfig(context: ConnectorContext): Promise<void> {
  const stored = context.credentials.steamSessionConfig;
  if (!stored) return;
  const path = sessionConfigPath(context);
  try {
    await access(path, constants.R_OK);
    return; // A live session file exists; SteamCMD's own copy wins.
  } catch {
    /* absent: restore the vault backup */
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, Buffer.from(stored, 'base64'), { mode: 0o600 });
  context.progress('보관함의 SteamCMD 세션 백업을 복원했습니다.');
}

async function persistSessionConfig(context: ConnectorContext): Promise<boolean> {
  const path = sessionConfigPath(context);
  let current: Buffer;
  try {
    current = await readFile(path);
  } catch {
    return false;
  }
  // The dedicated install's session file stays private to this user.
  await chmod(path, 0o600).catch(() => undefined);
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const encoded = current.toString('base64');
  const previous = context.credentials.steamSessionConfig ?? '';
  const changed = createHash('sha256').update(encoded).digest('hex') !== createHash('sha256').update(previous).digest('hex');
  if (!changed) return false;
  // Session rotation: SteamCMD refreshed its login data; keep an encrypted
  // vault backup so a wiped install can be restored without a new login.
  await context.saveCredentials({ ...context.credentials, steamSessionConfig: encoded });
  return true;
}

function detectAuthFailure(output: string): boolean {
  return /steam guard|two-factor|invalid password|cached credentials not found|login failure|account logon denied|password:/i.test(output);
}

async function serialized<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const previous = steamcmdLocks.get(lockKey) ?? Promise.resolve();
  const run = previous.then(task, task);
  steamcmdLocks.set(lockKey, run.catch(() => undefined));
  return run;
}

async function uploadBuild(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const buildRunId = text(input.importedArtifactId ?? input.buildRunId, '결과물 ID', 100);
  const track = input.track === undefined ? 'internal' : text(input.track, 'track', 64);
  if (track === 'public' || track === 'default') {
    throw new AppError('UNSUPPORTED_OPERATION', '기본(공개) 브랜치 전환은 Steamworks의 확인 절차(모바일 승인 포함)가 필요해 자동화하지 않습니다. 업로드 후 Steamworks에서 전환하거나 베타 브랜치 이름을 지정해 주세요.');
  }
  if (track !== 'internal' && !/^[A-Za-z0-9_-]{1,64}$/.test(track)) {
    throw new AppError('INVALID_INPUT', 'Steam 브랜치 이름은 영문/숫자/_-만 사용할 수 있습니다.');
  }
  const appId = requireAppId(context);
  const buildUsername = context.credentials.buildUsername;
  if (!buildUsername || !/^[A-Za-z0-9_-]{2,64}$/.test(buildUsername)) {
    throw new AppError('MISSING_REQUIREMENT', '빌드 전송에는 전용 빌드 계정 이름(buildUsername)이 필요합니다. 연결 설정에서 등록해 주세요.');
  }
  const steamcmd = trustedSteamcmdPath(context);
  const artifact = context.artifact;
  if (!artifact || artifact.kind !== 'directory') {
    throw new AppError('MISSING_REQUIREMENT', 'Steam 업로드에는 디렉터리 형태의 검증된 빌드 결과물(콘텐츠 루트)이 필요합니다. buildRunId가 Steam용 빌드를 가리키는지 확인해 주세요.');
  }
  if (!isAbsolute(artifact.path) || /[\0-\x1f"\x7f]/.test(artifact.path) || /[\0-\x1f"\x7f]/.test(context.workDirectory)) {
    throw new AppError('INVALID_INPUT', '결과물 경로에 사용할 수 없는 문자가 있습니다.');
  }
  if (!(await stat(artifact.path)).isDirectory()) {
    throw new AppError('INVALID_INPUT', '결과물 경로가 디렉터리가 아닙니다.');
  }
  const depotId = context.credentials.depotId || String(Number(appId) + 1);
  if (!/^\d{1,10}$/.test(depotId)) {
    throw new AppError('INVALID_INPUT', '연결 설정의 depotId는 숫자여야 합니다.');
  }

  return serialized(`${steamcmd}`, async () => {
    context.signal.throwIfAborted();
    const outputDirectory = join(context.workDirectory, 'steam-build-output');
    await mkdir(outputDirectory, { recursive: true });
    const description = `AppOps ${buildRunId}`.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 100);
    const script: VdfNode = {
      AppBuild: {
        AppID: appId,
        Desc: description,
        ContentRoot: artifact.path,
        BuildOutput: outputDirectory,
        ...(track === 'internal' ? {} : { SetLive: track }),
        Depots: {
          [depotId]: {
            FileMapping: { LocalPath: '*', DepotPath: '.', Recursive: '1' },
          },
        },
      },
    };
    const scriptPath = join(context.workDirectory, 'app_build.vdf');
    await writeFile(scriptPath, renderVdf(script) + '\n', { mode: 0o600 });

    await restoreSessionConfig(context);
    const secrets = [context.credentials.apiKey, context.credentials.financialApiKey, context.credentials.steamSessionConfig]
      .filter((value): value is string => Boolean(value));

    // External effect starts here (CLI upload). No password in argv: the
    // dedicated build account's cached SteamCMD session is reused, and
    // @NoPromptForPassword makes a missing session fail instead of hanging.
    context.markDispatched();
    context.checkpoint({ steamAppId: appId, steamDepotId: depotId, steamTrack: track, phase: 'steamcmd-started' });
    context.progress(`SteamCMD 빌드 업로드 시작 (app ${appId}, depot ${depotId}${track === 'internal' ? '' : `, 브랜치 ${track}`})`);
    const result = await runCommand(
      steamcmd,
      ['+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1', '+login', buildUsername, '+run_app_build', scriptPath, '+quit'],
      {
        cwd: context.workDirectory,
        signal: context.signal,
        timeoutMs: STEAMCMD_TIMEOUT_MS,
        onLine: line => context.progress(redact(line, secrets).slice(0, 300)),
      },
    );
    if (context.signal.aborted) {
      throw new AppError('CANCELLED', '작업을 취소했습니다. SteamCMD 프로세스 트리를 종료했습니다.');
    }
    const safeOutput = redact(result.output, secrets);
    const sessionSaved = await persistSessionConfig(context).catch(() => false);

    if (result.timedOut) {
      throw new AppError('TEMPORARY', 'SteamCMD 업로드가 제한 시간을 초과했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.', 503);
    }
    if (result.code !== 0) {
      if (detectAuthFailure(safeOutput)) {
        throw new AppError('AUTH_REQUIRED', '빌드 계정의 SteamCMD 세션이 없거나 만료되었습니다. 이 장비의 전용 SteamCMD에서 한 번만 대화형으로 로그인(Steam Guard 확인 포함)한 뒤 다시 실행해 주세요. 비밀번호는 이 앱에 저장되지 않습니다.', 401);
      }
      throw new AppError('PROVIDER_REJECTED', `SteamCMD 빌드 업로드가 실패했습니다 (종료 코드 ${result.code ?? '없음'}). 로그 마지막 부분: ${safeOutput.slice(-500)}`, 422);
    }
    const buildIdMatch = /build ?id[^\d]{0,4}(\d{4,})/i.exec(safeOutput);
    if (!buildIdMatch) {
      throw new AppError('INVALID_PROVIDER_RESPONSE', 'SteamCMD가 성공 코드로 끝났지만 BuildID를 확인하지 못했습니다. Steamworks 빌드 목록에서 상태를 확인해 주세요.', 502);
    }
    const buildId = buildIdMatch[1];
    context.checkpoint({ steamAppId: appId, steamBuildId: buildId, steamTrack: track, phase: 'uploaded' });

    let confirmedRemotely = false;
    if (context.credentials.apiKey) {
      try {
        const payload = await context.request<Record<string, unknown>>(
          withKey('/ISteamApps/GetAppBuilds/v1/', context.credentials.apiKey, { appid: appId, count: '20' }),
        );
        const builds = entries(asRecord(payload.response).builds ?? asRecord(payload.response));
        confirmedRemotely = builds.some(build => String(build.BuildID ?? build.buildid ?? build.id) === buildId);
      } catch {
        confirmedRemotely = false; // Verification is best-effort; the CLI result stands on its own.
      }
    }

    const resource: ResourceInput = {
      kind: 'release',
      externalId: buildId,
      name: description,
      status: track === 'internal' ? 'uploaded' : `live:${track}`,
      data: { appId, depotId, track, buildRunId, confirmedRemotely },
    };
    return {
      summary: {
        externalIds: { steamBuildId: buildId },
        appId,
        depotId,
        track,
        confirmedRemotely,
        sessionBackupUpdated: sessionSaved,
        note: track === 'internal'
          ? '빌드가 업로드되었습니다. 브랜치 전환은 Steamworks 또는 베타 브랜치 지정으로 진행하세요.'
          : `빌드가 업로드되고 ${track} 브랜치에 반영되도록 요청했습니다.`,
      },
      resources: [resource],
    };
  });
}

async function listReleases(context: ConnectorContext): Promise<ConnectorResult> {
  const key = requireApiKey(context);
  const appId = requireAppId(context);
  const buildsPayload = await context.request<Record<string, unknown>>(
    withKey('/ISteamApps/GetAppBuilds/v1/', key, { appid: appId, count: '20' }),
  );
  const betasPayload = await context.request<Record<string, unknown>>(
    withKey('/ISteamApps/GetAppBetas/v1/', key, { appid: appId }),
  );
  const builds = entries(asRecord(buildsPayload.response).builds ?? asRecord(buildsPayload.response));
  const betas = asRecord(asRecord(betasPayload.response).betas ?? asRecord(betasPayload.response));
  const liveBuilds = new Map<string, string>();
  for (const [branch, info] of Object.entries(betas)) {
    const buildId = String(asRecord(info).BuildID ?? asRecord(info).buildid ?? '');
    if (buildId && (!liveBuilds.has(buildId) || ['public','default'].includes(branch))) liveBuilds.set(buildId, branch);
  }
  const resources: ResourceInput[] = builds
    .map(build => {
      const buildId = String(build.BuildID ?? build.buildid ?? build.id ?? '');
      return {
        kind: 'release' as const,
        externalId: buildId,
        name: typeof build.Description === 'string' ? build.Description : `Build ${buildId}`,
        status: liveBuilds.has(buildId) ? `live:${liveBuilds.get(buildId)}` : 'uploaded',
        data: { appId, creationDate: build.CreationDate ?? build.creation_date ?? null },
      };
    })
    .filter(resource => /^\d+$/.test(resource.externalId));
  return {
    summary: { appId, builds: resources.length, branches: Object.keys(betas) },
    resources,
  };
}

async function syncFinancials(context: ConnectorContext): Promise<ConnectorResult> {
  const key = financialKey(context);
  const metrics: MetricInput[] = [];
  const perApp = new Map<string, bigint>();
  const collectedDates: string[] = [];
  let grossUsdMicros = 0n;
  let returnsUsdMicros = 0n;
  const usd = (value: unknown): bigint =>
    typeof value === 'string' ? decimalToMicros(value) : typeof value === 'number' ? decimalToMicros(String(value)) : 0n;
  // GetDetailedSales reports in Pacific time; shift 8 hours so "yesterday" exists.
  const pacificNow = Date.now() - 8 * 60 * 60 * 1000;
  for (let daysAgo = 1; daysAgo <= 7; daysAgo += 1) {
    context.signal.throwIfAborted();
    const date = new Date(pacificNow - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let highwatermark = '0';
    let total = 0n;
    let sawRows = false;
    for (let page = 0; page < 20; page += 1) {
      const payload = await context.request<Record<string, unknown>>(
        withKey('/IPartnerFinancialsService/GetDetailedSales/v001/', key, { date, highwatermark_id: highwatermark }),
      );
      const response = asRecord(payload.response);
      const results = Array.isArray(response.results) ? response.results.map(asRecord) : [];
      if (results.length === 0) break;
      sawRows = true;
      for (const row of results) {
        // Rows are keyed strictly by appid (never by app name) and amounts
        // come from the documented USD fields: net_sales_usd is net of
        // returns and taxes; gross/returns are kept for reconciliation.
        const amount = usd(row.net_sales_usd);
        total += amount;
        grossUsdMicros += usd(row.gross_sales_usd);
        returnsUsdMicros += usd(row.gross_returns_usd);
        const appid = String(row.appid ?? 'unknown');
        perApp.set(appid, (perApp.get(appid) ?? 0n) + amount);
      }
      const maxId = String(response.max_id ?? '');
      if (!maxId || maxId === highwatermark) break;
      highwatermark = maxId;
    }
    if (sawRows) {
      collectedDates.push(date);
      metrics.push({
        date,
        currency: 'USD',
        kind: 'revenue',
        amountMicros: total.toString(),
        basis: 'estimated',
        sourceId: `steam:detailed-sales:${date}`,
      });
    }
  }
  return {
    summary: {
      collectedDates,
      perApp: Object.fromEntries([...perApp].slice(0, 50).map(([appid, amount]) => [appid, amount.toString()])),
      grossUsdMicros: grossUsdMicros.toString(),
      returnsUsdMicros: returnsUsdMicros.toString(),
      note: '세금·환불 차감 후 USD 순매출(net_sales_usd) 합계입니다. Steam 수익 배분 차감 전 금액이라 basis=estimated로 기록합니다.',
    },
    metrics,
  };
}

async function check(context: ConnectorContext): Promise<ConnectorResult> {
  const apps = await fetchAppList(context);
  const delivery = await buildDeliveryStatus(context);
  return {
    summary: {
      ok: true,
      appsVisible: apps.length,
      financialKeyConfigured: Boolean(context.credentials.financialApiKey || context.credentials.apiKey),
      buildDelivery: delivery,
    },
  };
}

async function listApps(context: ConnectorContext): Promise<ConnectorResult> {
  const apps = await fetchAppList(context);
  return { summary: { apps, count: apps.length } };
}

const capability: Capability = {
  provider: 'steam',
  name: 'Steamworks',
  category: 'store',
  description: 'Steamworks 파트너 API로 앱 목록·빌드·브랜치를 조회하고, SetAppBuildLive로 브랜치를 전환하며, 전용 빌드 계정의 SteamCMD 세션으로 빌드를 업로드하고, 일별 순매출을 수집합니다.',
  authKind: 'api-key-cli-session',
  fields: [
    { key: 'apiKey', label: '파트너 Web API 키 (게시자)', secret: true, required: true },
    { key: 'financialApiKey', label: 'Financial API Group 키 (매출용, 선택)', secret: true, required: false },
    { key: 'buildUsername', label: '전용 빌드 계정 이름 (빌드 업로드용)', required: false },
    { key: 'steamcmdPath', label: '전용 SteamCMD 실행 파일 절대 경로 (빌드 업로드용)', required: false, placeholder: '/opt/steamcmd/steamcmd.sh' },
    { key: 'depotId', label: 'Depot ID (선택, 기본값 AppID+1)', required: false },
    { key: 'steamcmdConfigPath', label: 'SteamCMD config.vdf 경로 (선택)', required: false },
    { key: 'confirmSteamId', label: '공개 브랜치 확인용 SteamID64 (선택)', required: false },
  ],
  operations: ['check', 'sync', 'sync-app', 'list-apps', 'list-releases', 'upload-build', 'set-live', 'create-announcement'],
  operationFields: {
    'set-live': [
      { key: 'buildId', label: '빌드 ID', required: true, hint: 'GetAppBuilds의 BuildID입니다.' },
      { key: 'branch', label: '브랜치', required: true, placeholder: 'beta', hint: '베타 브랜치 이름. 공개 기본 브랜치는 public.' },
      { key: 'description', label: '설명' },
      { key: 'confirmSteamId', label: '확인용 SteamID64', hint: 'public 브랜치(출시된 앱)에 필요합니다. 연결 설정 값을 대신 쓸 수 있습니다.' },
    ],
    'create-announcement': [
      { key: 'text', remove: true }, { key: 'title', remove: true },
    ],
  },
  setupUrl: 'https://partner.steamgames.com/doc/webapi_overview/auth',
  limitations: [
    '빌드 업로드는 전용 빌드 계정으로 이 장비의 SteamCMD에 1회 대화형 로그인(Steam Guard)을 마친 뒤 사용할 수 있습니다.',
    '브랜치 전환은 공식 SetAppBuildLive v2를 사용합니다. 출시된 앱의 public 전환은 steamid와 Steam 모바일 승인이 필요하며 GetAppBetas로 반영을 확인합니다.',
    '커뮤니티 공지 작성은 공개 Web API가 없어 Steamworks 이벤트 도구에서 수행해야 합니다. 가짜 엔드포인트를 호출하지 않습니다.',
    '상품/가격 관리는 Steamworks 파트너 사이트 전용이라 지원하지 않습니다.',
    '매출은 USD 순매출 기준이며 Steam 수익 배분 차감 전 금액입니다.',
    '실계정 검증 전입니다. 모든 엔드포인트는 공식 문서 기준으로 구현되었습니다.',
  ],
};

export const steamConnector: Connector = {
  capability,
  async execute(operation, input, context): Promise<ConnectorResult> {
    switch (operation) {
      case 'check': return check(context);
      case 'list-apps': return listApps(context);
      case 'list-releases': return listReleases(context);
      case 'sync-app': return listReleases(context);
      case 'upload-build': return uploadBuild(input, context);
      case 'set-live': return setSteamBuildLive(input, context);
      case 'create-announcement':
      case 'publish-news':
      case 'create-news':
        return createSteamAnnouncement(context);
      case 'reconcile':
        return input.buildId || input.externalId ? reconcileSteamLive(input, context) : listReleases(context);
      case 'sync': return syncFinancials(context);
      default:
        throw new AppError('UNSUPPORTED_OPERATION', `Steam 연결이 지원하지 않는 작업입니다: ${operation}`);
    }
  },
};
