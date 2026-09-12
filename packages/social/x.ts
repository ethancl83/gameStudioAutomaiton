// X (formerly Twitter) API v2 adapter.
//
// Endpoints (verified against docs.x.com, 2026-09-11):
//   check         GET  /2/users/me
//   list-posts    GET  /2/users/:id/tweets           (pagination_token, bounded)
//   list-mentions GET  /2/users/:id/mentions
//   create-post   POST /2/tweets                      { text }
//   reply         POST /2/tweets                      { text, reply.in_reply_to_tweet_id }
//   delete-post   DELETE /2/tweets/:id                { data.deleted }
//   hide-reply    PUT  /2/tweets/:id/hidden           { hidden: true|false }
//
// Account-level reads use connection.accountId. Writes re-assert ownership
// (accountId === /me id) before dispatch. An ambiguous write (timeout/5xx)
// stays unresolved: no id is guessed and nothing is reposted.

import { createHash } from 'node:crypto';

import { AppError, object, text } from '../domain/errors.js';
import { asArray, asRecord, boundedInt, isAmbiguousWriteError } from './helpers.js';
import { assertXText } from './validate.js';
import type { SocialAdapter, SocialCapability, SocialContext, SocialResource, SocialResult } from './types.js';

const API = 'https://api.x.com/2';
const READ_SCOPES = ['tweet.read', 'users.read'];
const WRITE_SCOPES = ['tweet.read', 'tweet.write', 'users.read'];
const MODERATE_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'tweet.moderate.write'];
const MAX_PAGES = 5;

function permalink(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

async function bearer(ctx: SocialContext, scopes: string[]): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await ctx.accessToken(scopes)}` };
}

async function fetchSelf(ctx: SocialContext): Promise<{ id: string; username?: string; name?: string }> {
  const payload = await ctx.request<Record<string, unknown>>(
    `${API}/users/me?user.fields=username,name`,
    { headers: await bearer(ctx, READ_SCOPES) },
  );
  const data = asRecord(payload.data);
  const id = typeof data.id === 'string' ? data.id : '';
  if (!id) throw new AppError('INVALID_PROVIDER_RESPONSE', 'X 계정 식별자를 확인할 수 없습니다.');
  return { id, username: typeof data.username === 'string' ? data.username : undefined, name: typeof data.name === 'string' ? data.name : undefined };
}

/** Writes must act as the owned account; refuse a token/account mismatch. */
async function assertOwnedAccount(ctx: SocialContext): Promise<{ id: string; username?: string }> {
  const self = await fetchSelf(ctx);
  if (self.id !== ctx.connection.accountId) {
    throw new AppError('ACCOUNT_MISMATCH', '연결된 계정과 현재 토큰의 계정이 일치하지 않습니다. 연결을 다시 확인해 주세요.');
  }
  return self;
}

function postResource(row: Record<string, unknown>, kind: 'post' | 'mention' | 'reply'): SocialResource {
  const id = String(row.id ?? '');
  const metrics: Record<string, number | string> = {};
  const public_metrics = asRecord(row.public_metrics);
  for (const key of ['retweet_count', 'reply_count', 'like_count', 'quote_count', 'impression_count', 'bookmark_count']) {
    if (typeof public_metrics[key] === 'number') metrics[key] = public_metrics[key] as number;
  }
  return {
    kind,
    externalId: id,
    permalink: permalink(id),
    ...(typeof row.created_at === 'string' ? { createdAt: row.created_at } : {}),
    ...(typeof row.text === 'string' ? { text: row.text } : {}),
    ...(Object.keys(metrics).length ? { metrics } : {}),
    data: {
      conversationId: row.conversation_id,
      authorId: row.author_id,
      inReplyToUserId: row.in_reply_to_user_id,
      referencedTweets: row.referenced_tweets,
    },
  };
}

async function listTimeline(ctx: SocialContext, path: 'tweets' | 'mentions', input: Record<string, unknown>): Promise<SocialResult> {
  const maxResults = boundedInt(input, 'maxResults', 25, 5, 100);
  const maxPages = boundedInt(input, 'maxPages', 1, 1, MAX_PAGES);
  const resources: SocialResource[] = [];
  let pageToken = '';
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    if (seen.has(pageToken)) break;
    seen.add(pageToken);
    const url = new URL(`${API}/users/${encodeURIComponent(ctx.connection.accountId)}/${path}`);
    url.searchParams.set('max_results', String(maxResults));
    url.searchParams.set('tweet.fields', 'created_at,public_metrics,conversation_id,author_id,in_reply_to_user_id,referenced_tweets');
    if (pageToken) url.searchParams.set('pagination_token', pageToken);
    const payload = await ctx.request<Record<string, unknown>>(url.toString(), { headers: await bearer(ctx, READ_SCOPES) });
    for (const row of asArray(payload.data)) {
      resources.push(postResource(asRecord(row), path === 'mentions' ? 'mention' : 'post'));
    }
    const meta = asRecord(payload.meta);
    pageToken = typeof meta.next_token === 'string' ? meta.next_token : '';
    if (!pageToken) break;
  }
  return { summary: { count: resources.length, provider: 'x', operation: path === 'mentions' ? 'list-mentions' : 'list-posts' }, resources };
}

async function dispatchPost(
  ctx: SocialContext,
  operation: 'create-post' | 'reply',
  body: Record<string, unknown>,
  journal: Record<string, unknown>,
): Promise<SocialResult> {
  // Pre-write journal: durable intent before the request leaves the process.
  ctx.checkpoint({ provider: 'x', operation, ...journal });
  let payload: Record<string, unknown>;
  try {
    payload = await ctx.request<Record<string, unknown>>(`${API}/tweets`, {
      method: 'POST',
      headers: await bearer(ctx, WRITE_SCOPES),
      json: body,
      write: true,
    });
  } catch (error) {
    if (isAmbiguousWriteError(error)) {
      // The post may or may not exist. We do NOT search-and-match to guess an
      // id (that risks false positives); the controller surfaces this as
      // action_required for a human to reconcile. No automatic repost.
      return { summary: { provider: 'x', operation, outcome: 'unknown' }, unresolved: true };
    }
    throw error;
  }
  const data = asRecord(payload.data);
  const id = typeof data.id === 'string' ? data.id : '';
  if (!id) throw new AppError('INVALID_PROVIDER_RESPONSE', 'X 게시 결과 식별자를 확인할 수 없습니다.');
  // Journal the confirmed external id from the create response before any
  // optional follow-up read, so the result is durably known.
  ctx.checkpoint({ provider: 'x', operation, stage: 'created', externalId: id });
  const resource = postResource({ ...data }, operation === 'reply' ? 'reply' : 'post');
  return { summary: { provider: 'x', operation, externalId: id, permalink: resource.permalink }, resources: [resource] };
}

function postId(input: Record<string, unknown>): string {
  const id = text(input.postId ?? input.externalId, '게시글 ID', 40);
  if (!/^\d{1,19}$/.test(id)) throw new AppError('INVALID_INPUT', '게시글 ID는 숫자여야 합니다.');
  return id;
}

async function assertOwnedPost(ctx: SocialContext, id: string): Promise<void> {
  const payload = await ctx.request<Record<string, unknown>>(
    `${API}/tweets/${encodeURIComponent(id)}?tweet.fields=author_id`,
    { headers: await bearer(ctx, READ_SCOPES) },
  );
  const data = asRecord(payload.data);
  const author = typeof data.author_id === 'string' ? data.author_id : '';
  if (author && author !== ctx.connection.accountId) {
    throw new AppError('ACCOUNT_MISMATCH', '이 게시글은 연결된 X 계정의 소유가 아닙니다.');
  }
  if (!author && !data.id) throw new AppError('RESOURCE_NOT_FOUND', '삭제할 게시글을 찾을 수 없습니다.');
}

async function deletePost(ctx: SocialContext, input: Record<string, unknown>): Promise<SocialResult> {
  const id = postId(input);
  await assertOwnedAccount(ctx);
  await assertOwnedPost(ctx, id);
  ctx.checkpoint({ provider: 'x', operation: 'delete-post', postId: id });
  let payload: Record<string, unknown>;
  try {
    payload = await ctx.request<Record<string, unknown>>(`${API}/tweets/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: await bearer(ctx, WRITE_SCOPES), write: true,
    });
  } catch (error) {
    if (isAmbiguousWriteError(error)) return { summary: { provider: 'x', operation: 'delete-post', postId: id, outcome: 'unknown' }, unresolved: true };
    throw error;
  }
  const deleted = asRecord(payload.data).deleted === true;
  if (!deleted) throw new AppError('INVALID_PROVIDER_RESPONSE', 'X 게시글 삭제 결과를 확인할 수 없습니다.');
  ctx.checkpoint({ provider: 'x', operation: 'delete-post', stage: 'deleted', externalId: id });
  return { summary: { provider: 'x', operation: 'delete-post', externalId: id, deleted: true } };
}

async function hideReply(ctx: SocialContext, input: Record<string, unknown>, hidden: boolean): Promise<SocialResult> {
  const id = postId(input);
  await assertOwnedAccount(ctx);
  ctx.checkpoint({ provider: 'x', operation: 'hide-reply', postId: id, hidden });
  let payload: Record<string, unknown>;
  try {
    payload = await ctx.request<Record<string, unknown>>(`${API}/tweets/${encodeURIComponent(id)}/hidden`, {
      method: 'PUT', headers: await bearer(ctx, MODERATE_SCOPES), json: { hidden }, write: true,
    });
  } catch (error) {
    if (isAmbiguousWriteError(error)) return { summary: { provider: 'x', operation: 'hide-reply', postId: id, outcome: 'unknown' }, unresolved: true };
    throw error;
  }
  const result = asRecord(payload.data).hidden;
  if (typeof result !== 'boolean') throw new AppError('INVALID_PROVIDER_RESPONSE', 'X 답글 숨김 결과를 확인할 수 없습니다.');
  return { summary: { provider: 'x', operation: 'hide-reply', externalId: id, hidden: result } };
}

const capability: SocialCapability = {
  provider: 'x',
  name: 'X (Twitter)',
  description: 'X API v2로 계정 확인, 게시글·멘션 조회, 텍스트 게시와 답글을 수행합니다.',
  authKind: 'oauth2-pkce',
  fields: [
    { key: 'clientId', label: 'OAuth 2.0 Client ID', required: true },
    { key: 'clientSecret', label: 'Client Secret (기밀 클라이언트만)', secret: true },
    { key: 'refreshToken', label: 'Refresh Token', secret: true, required: true },
  ],
  readOperations: ['check', 'list-posts', 'list-mentions'],
  writeOperations: ['create-post', 'reply', 'delete-post', 'hide-reply'],
  operationFields: {
    'create-post': [{ key: 'text', label: '게시 문구', type: 'textarea', required: true }],
    reply: [
      { key: 'replyToId', label: '답글 대상 ID', required: true },
      { key: 'text', label: '답글 문구', type: 'textarea', required: true },
    ],
    'delete-post': [{ key: 'postId', label: '게시글 ID', type: 'text', required: true, hint: '연결된 계정이 작성한 게시글만 삭제합니다.' }],
    'hide-reply': [
      { key: 'postId', label: '답글 ID', type: 'text', required: true },
      { key: 'hide', type: 'select', required: true, label: '숨김', options: [{ value: 'true', label: '숨김' }, { value: 'false', label: '숨김 해제' }] },
    ],
  },
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'tweet.moderate.write'],
  setupUrl: 'https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code',
  limitations: [
    '평문 텍스트 게시글만 지원합니다. X 미디어는 별도 업로드 API가 필요해 URL 게시를 하지 않습니다.',
    '게시글 길이는 X 가중 길이 규칙으로 280 이내여야 합니다.',
    'delete-post는 DELETE /2/tweets/:id 이며 소유 게시글만 삭제합니다. hide-reply는 PUT /2/tweets/:id/hidden 입니다.',
    '전송 후 결과를 읽지 못하면 미해결로 남기며 자동 재게시하지 않습니다.',
  ],
};

export const xAdapter: SocialAdapter = {
  capability,
  async execute(operation, rawInput, ctx): Promise<SocialResult> {
    const input = object(rawInput ?? {});
    switch (operation) {
      case 'check': {
        const self = await fetchSelf(ctx);
        if (self.id !== ctx.connection.accountId) {
          throw new AppError('ACCOUNT_MISMATCH', '연결된 X 계정 ID가 실제 계정과 일치하지 않습니다.');
        }
        const resource: SocialResource = {
          kind: 'account',
          externalId: self.id,
          ...(self.username ? { permalink: `https://x.com/${self.username}` } : {}),
          data: { username: self.username, name: self.name },
        };
        return { summary: { provider: 'x', operation, userId: self.id, username: self.username }, resources: [resource] };
      }
      case 'list-posts':
        return listTimeline(ctx, 'tweets', input);
      case 'list-mentions':
        return listTimeline(ctx, 'mentions', input);
      case 'create-post': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '게시글 작성에는 프로젝트에 바인딩된 연결이 필요합니다.');
        const body = assertXText(input.text);
        await assertOwnedAccount(ctx);
        const textHash = createHash('sha256').update(body, 'utf8').digest('hex');
        return dispatchPost(ctx, 'create-post', { text: body }, { textHash });
      }
      case 'reply': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '답글 작성에는 프로젝트에 바인딩된 연결이 필요합니다.');
        const body = assertXText(input.text);
        const replyTo = text(input.replyToId, 'replyToId', 40);
        if (!/^\d{1,19}$/.test(replyTo)) throw new AppError('INVALID_INPUT', 'replyToId는 숫자 게시글 ID여야 합니다.');
        await assertOwnedAccount(ctx);
        const textHash = createHash('sha256').update(body, 'utf8').digest('hex');
        return dispatchPost(ctx, 'reply', { text: body, reply: { in_reply_to_tweet_id: replyTo } }, { textHash, replyTo });
      }
      case 'delete-post': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '게시글 삭제에는 프로젝트에 바인딩된 연결이 필요합니다.');
        return deletePost(ctx, input);
      }
      case 'hide-reply': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '답글 숨김에는 프로젝트에 바인딩된 연결이 필요합니다.');
        const hide = input.hide === true || input.hide === 'true';
        if (input.hide !== true && input.hide !== false && input.hide !== 'true' && input.hide !== 'false') {
          throw new AppError('INVALID_INPUT', 'hide는 true 또는 false 여야 합니다.');
        }
        return hideReply(ctx, input, hide);
      }
      default:
        throw new AppError('UNSUPPORTED_OPERATION', `X 커넥터가 지원하지 않는 작업입니다: ${operation}`);
    }
  },
};
