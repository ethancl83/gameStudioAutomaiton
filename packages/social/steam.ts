// Steam news adapter (read-only) with an explicit unsupported-publishing gate.
//
// Steam exposes a documented, key-less public endpoint to READ app news:
//   GET https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/
// (verified against partner.steamgames.com/doc/webapi/ISteamNews, 2026-09-11).
//
// Steam does NOT publish a documented public Web API to CREATE or PUBLISH a news
// post / community announcement. This adapter therefore refuses every write with
// a clear gate. It never invents an endpoint and never scrapes session cookies.
//
// The controller already owns a `steam` connector; these operations are grafted
// onto it (this is not a new Provider).

import { AppError, object } from '../domain/errors.js';
import { asArray, asRecord, boundedInt } from './helpers.js';
import type { SocialAdapter, SocialCapability, SocialContext, SocialResource, SocialResult } from './types.js';

const NEWS_ENDPOINT = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
const PARTNER_NEWS = 'https://partner.steamgames.com/apps/news/';

// Operations a caller might expect to publish with; each is explicitly gated.
const UNSUPPORTED_WRITES = new Set(['publish-news', 'create-news', 'create-announcement', 'create-post', 'reply', 'update-news', 'delete-news']);

function appId(ctx: SocialContext, input: Record<string, unknown>): string {
  const raw = input.appId ?? ctx.project?.appIdentifier ?? ctx.connection.accountId;
  const value = raw == null ? '' : String(raw);
  if (!/^\d{1,10}$/.test(value)) {
    throw new AppError('MISSING_REQUIREMENT', 'Steam App ID(appId)가 필요합니다. 숫자 App ID를 확인해 주세요.');
  }
  return value;
}

function newsResource(row: Record<string, unknown>, appIdValue: string): SocialResource {
  const gid = String(row.gid ?? '');
  const date = typeof row.date === 'number' ? new Date(row.date * 1000).toISOString() : undefined;
  // Each GetNewsForApp item carries its own `appid`; when a Steam connection is
  // shared across projects the per-item app id must equal the app we requested,
  // otherwise the item cannot be safely mapped back to a project. A mismatch is
  // rejected rather than mislabeled.
  if (row.appid != null && String(row.appid) !== appIdValue) {
    throw new AppError('INVALID_PROVIDER_RESPONSE', `Steam 뉴스 항목의 App ID(${String(row.appid)})가 요청한 App ID(${appIdValue})와 일치하지 않습니다.`);
  }
  return {
    kind: 'news',
    externalId: gid,
    ...(typeof row.url === 'string' ? { permalink: row.url } : {}),
    ...(date ? { createdAt: date } : {}),
    ...(typeof row.title === 'string' ? { text: row.title } : {}),
    data: {
      // The validated app id travels on every resource so root can map a shared
      // connection's news back to the owning project.
      appId: appIdValue,
      author: row.author,
      feedlabel: row.feedlabel,
      feedname: row.feedname,
      contents: typeof row.contents === 'string' ? row.contents : undefined,
    },
  };
}

async function listNews(ctx: SocialContext, input: Record<string, unknown>): Promise<SocialResult> {
  const id = appId(ctx, input);
  const count = boundedInt(input, 'count', 20, 1, 50);
  const maxLength = boundedInt(input, 'maxLength', 600, 0, 8000);
  const url = new URL(NEWS_ENDPOINT);
  url.searchParams.set('appid', id);
  url.searchParams.set('count', String(count));
  url.searchParams.set('maxlength', String(maxLength));
  const endDate = boundedInt(input, 'endDate', 0, 0, 4102444800);
  if (endDate > 0) url.searchParams.set('enddate', String(endDate));
  const payload = await ctx.request<Record<string, unknown>>(url.toString());
  const appnews = asRecord(payload.appnews);
  // The envelope echoes the requested app id; a mismatch means the response is
  // not for the app we asked about, so reject instead of attributing its news
  // to the wrong project.
  if (appnews.appid != null && String(appnews.appid) !== id) {
    throw new AppError('INVALID_PROVIDER_RESPONSE', `Steam 응답 App ID(${String(appnews.appid)})가 요청한 App ID(${id})와 일치하지 않습니다.`);
  }
  const resources = asArray(appnews.newsitems).map(row => newsResource(asRecord(row), id));
  return { summary: { provider: 'steam', operation: 'list-news', appId: id, count: resources.length }, resources };
}

const capability: SocialCapability = {
  provider: 'steam',
  name: 'Steam News',
  description: 'Steam 공식 뉴스(공지)를 읽습니다. 공개 쓰기 API가 없어 게시는 지원하지 않습니다.',
  authKind: 'none',
  fields: [],
  readOperations: ['check', 'list-news'],
  writeOperations: ['prepare-news'],
  operationFields: {
    'list-news': [{ key: 'appId', label: 'Steam 앱 ID', required: false, hint: '선택한 프로젝트 또는 연결의 App ID를 사용합니다.' }],
    'prepare-news': [{ key: 'appId', label: 'Steam 앱 ID', required: false, hint: '공개 쓰기 API가 없어 Steamworks 공지 편집 URL만 반환합니다. 게시 성공으로 표시하지 않습니다.' }],
  },
  scopes: [],
  setupUrl: 'https://partner.steamgames.com/doc/webapi/ISteamNews',
  limitations: [
    '뉴스 조회만 지원합니다(공개 GetNewsForApp, 인증 키 불필요).',
    'ISteamNews는 GetNewsForApp(읽기)와 GetNewsForAppAuthed(읽기)만 문서화되어 있습니다. 공지 생성 Web API는 없습니다.',
    'prepare-news는 Steamworks 공지 URL만 반환하며 게시에 성공했다고 표시하지 않습니다. 가짜 엔드포인트·쿠키 스크래핑은 사용하지 않습니다.',
  ],
};

export const steamNewsAdapter: SocialAdapter = {
  capability,
  async execute(operation, rawInput, ctx): Promise<SocialResult> {
    const input = object(rawInput ?? {});
    if (UNSUPPORTED_WRITES.has(operation)) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Steam은 뉴스·공지 게시를 위한 공식 공개 Web API를 제공하지 않습니다. 이 작업은 지원되지 않으며, 게시는 Steamworks 파트너 사이트에서 수동으로 진행해야 합니다.',
        422,
      );
    }
    switch (operation) {
      case 'check': {
        const result = await listNews(ctx, { ...input, count: 1 });
        return {
          summary: {
            provider: 'steam',
            operation: 'check',
            appId: result.summary.appId,
            reachable: true,
            publishing: 'unsupported',
          },
        };
      }
      case 'list-news':
        return listNews(ctx, input);
      case 'prepare-news': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '공지 준비에는 프로젝트에 바인딩된 연결이 필요합니다.');
        const id = appId(ctx, input);
        return {
          summary: {
            provider: 'steam',
            operation: 'prepare-news',
            appId: id,
            published: false,
            platformAction: true,
            actionUrl: `${PARTNER_NEWS}${id}`,
            note: 'Steam은 공지 쓰기 공개 Web API를 제공하지 않습니다. Steamworks에서 직접 작성하세요. 이 작업은 게시 성공이 아닙니다.',
          },
          unresolved: true,
        };
      }
      default:
        throw new AppError('UNSUPPORTED_OPERATION', `Steam 뉴스 커넥터가 지원하지 않는 작업입니다: ${operation}`);
    }
  },
};
