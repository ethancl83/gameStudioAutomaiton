import { AppError, text } from '../domain/errors.js';
import type { ConnectorContext, ConnectorResult, ResourceInput } from './types.js';

const API = 'https://partner.steam-api.com';
const EVENTS_DOC = 'https://partner.steamgames.com/doc/marketing/event_tools';
const SET_LIVE = '/ISteamApps/SetAppBuildLive/v2/';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function entries(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  const nested = record.app ?? record.build;
  if (Array.isArray(nested)) return nested.map(asRecord);
  return Object.entries(record).map(([id, item]) => ({ id, ...asRecord(item) }));
}

function requireApiKey(context: ConnectorContext): string {
  const key = context.credentials.apiKey;
  if (!key) throw new AppError('MISSING_REQUIREMENT', 'Steamworks 파트너 Web API 키(apiKey)가 필요합니다.');
  return key;
}

function requireAppId(context: ConnectorContext): string {
  const appId = context.project?.appIdentifier;
  if (!appId || !/^\d{1,10}$/.test(appId)) {
    throw new AppError('MISSING_REQUIREMENT', '이 작업에는 Steam App ID가 확인된 프로젝트 연결이 필요합니다.');
  }
  return appId;
}

function branchKey(value: unknown): string {
  const raw = text(value, '브랜치', 64);
  if (raw === 'default') return 'public';
  if (raw === 'public' || /^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  throw new AppError('INVALID_INPUT', 'Steam 브랜치 이름은 public 또는 영문/숫자/_-만 사용할 수 있습니다.');
}

function steamId(value: unknown, label: string): string {
  const id = text(value, label, 20);
  if (!/^\d{15,20}$/.test(id)) throw new AppError('INVALID_INPUT', `${label}는 숫자 SteamID64여야 합니다.`);
  return id;
}

async function liveBranches(context: ConnectorContext, appId: string, key: string): Promise<Map<string, string>> {
  const payload = await context.request<Record<string, unknown>>(
    `${API}/ISteamApps/GetAppBetas/v1/?key=${encodeURIComponent(key)}&appid=${encodeURIComponent(appId)}`,
  );
  const betas = asRecord(asRecord(payload.response).betas ?? asRecord(payload.response));
  const live = new Map<string, string>();
  for (const [branch, info] of Object.entries(betas)) {
    const buildId = String(asRecord(info).BuildID ?? asRecord(info).buildid ?? '');
    if (buildId && (!['public','default'].includes(live.get(buildId) ?? '') || ['public','default'].includes(branch))) live.set(buildId, branch);
  }
  return live;
}

export async function setSteamBuildLive(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const key = requireApiKey(context);
  const appId = requireAppId(context);
  const buildId = text(input.buildId ?? input.externalId, '빌드 ID', 20);
  if (!/^\d{1,12}$/.test(buildId)) throw new AppError('INVALID_INPUT', 'Steam BuildID는 숫자여야 합니다.');
  const betakey = branchKey(input.branch ?? input.track ?? 'beta');
  const description = input.description === undefined ? undefined : text(input.description, '설명', 200);
  const confirmId = input.confirmSteamId ?? context.credentials.confirmSteamId;
  if (betakey === 'public' && !confirmId) {
    return {
      unresolved: true,
      summary: {
        appId,
        buildId,
        branch: betakey,
        requiredAction: '출시된 앱의 public 브랜치 전환은 확인 계정 SteamID64와 Steam 모바일 승인이 필요합니다. 연결 설정의 confirmSteamId 또는 작업 입력에 SteamID64를 넣은 뒤 다시 실행해 주세요.',
        setupUrl: 'https://partner.steamgames.com/doc/webapi/ISteamApps',
      },
    };
  }

  const body = new URLSearchParams({ key, appid: appId, buildid: buildId, betakey });
  if (description) body.set('description', description);
  if (betakey === 'public') body.set('steamid', steamId(confirmId, '확인용 SteamID'));

  context.checkpoint({ steamAppId: appId, steamBuildId: buildId, steamTrack: betakey, phase: 'set-live-started' });
  await context.request<Record<string, unknown>>(`${API}${SET_LIVE}`, {
    method: 'POST',
    write: true,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // Official docs: HTTP 201 means mobile confirmation. Transport does not expose status,
  // so we reconcile with GetAppBetas instead of inventing a 201 body.
  const confirmationRequired = betakey === 'public';
  context.checkpoint({ steamAppId: appId, steamBuildId: buildId, steamTrack: betakey, phase: confirmationRequired ? 'confirmation-required' : 'set-live-posted' });

  let liveOn: string | undefined;
  let confirmedRemotely = false;
  try {
    const live = await liveBranches(context, appId, key);
    liveOn = live.get(buildId);
    confirmedRemotely = liveOn === betakey;
  } catch {
    confirmedRemotely = false;
  }

  const resource: ResourceInput = {
    kind: 'release',
    externalId: buildId,
    name: `Build ${buildId}`,
    status: confirmedRemotely ? `live:${betakey}` : (confirmationRequired ? 'awaiting_confirmation' : 'set-live-requested'),
    data: { appId, track: betakey, confirmedRemotely, liveOn: liveOn ?? null },
  };
  return {
    waitingExternal: !confirmedRemotely,
    resources: [resource],
    summary: {
      externalIds: { steamBuildId: buildId },
      appId,
      buildId,
      branch: betakey,
      confirmationRequired,
      confirmedRemotely,
      liveOn: liveOn ?? null,
      note: confirmedRemotely
          ? `GetAppBetas 기준으로 빌드 ${buildId}가 ${betakey} 브랜치에 반영되었습니다.`
        : confirmationRequired
          ? 'public 브랜치 전환은 Steam 모바일 확인이 필요할 수 있습니다. 지정한 계정에서 확인한 뒤 상태 재확인을 실행해 주세요.'
          : 'SetAppBuildLive 요청을 보냈습니다. GetAppBetas로 브랜치 반영을 다시 확인해 주세요.',
    },
  };
}

export async function reconcileSteamLive(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const key = requireApiKey(context);
  const appId = requireAppId(context);
  const buildId = text(input.buildId ?? input.externalId, '빌드 ID', 20);
  const betakey = input.branch === undefined ? undefined : branchKey(input.branch);
  const live = await liveBranches(context, appId, key);
  const liveOn = live.get(buildId);
  const confirmed = betakey ? liveOn === betakey : Boolean(liveOn);
  const buildsPayload = await context.request<Record<string, unknown>>(
    `${API}/ISteamApps/GetAppBuilds/v1/?key=${encodeURIComponent(key)}&appid=${encodeURIComponent(appId)}&count=20`,
  );
  const builds = entries(asRecord(buildsPayload.response).builds ?? asRecord(buildsPayload.response));
  const present = builds.some(build => String(build.BuildID ?? build.buildid ?? build.id) === buildId);
  return {
    waitingExternal: !confirmed,
    summary: {
      appId,
      buildId,
      branch: betakey ?? null,
      liveOn: liveOn ?? null,
      confirmed,
      present,
    },
  };
}

export async function createSteamAnnouncement(context: ConnectorContext): Promise<ConnectorResult> {
  const appId = context.project?.appIdentifier && /^\d{1,10}$/.test(context.project.appIdentifier)
    ? context.project.appIdentifier
    : undefined;
  return {
    unresolved: true,
    summary: {
      appId: appId ?? null,
      publishing: 'unsupported',
      requiredAction: 'Steam은 커뮤니티 공지·이벤트를 만드는 공개 Web API를 문서화하지 않습니다(ISteamNews는 GetNewsForApp·GetNewsForAppAuthed 조회만 제공). Steamworks 이벤트/공지 도구에서 직접 작성해 주세요.',
      setupUrl: EVENTS_DOC,
      consoleUrl: appId ? `https://partner.steamgames.com/apps/landing/${appId}` : 'https://partner.steamgames.com',
    },
  };
}
