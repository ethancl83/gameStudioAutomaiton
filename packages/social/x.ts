// X (formerly Twitter) API v2 adapter.
//
// Endpoints (verified against docs.x.com, 2026-09-11):
//   check         GET  /2/users/me
//   list-posts    GET  /2/users/:id/tweets           (pagination_token, bounded)
//   list-mentions GET  /2/users/:id/mentions
//   create-post   POST /2/tweets                      { text, media.media_ids? }
//   reply         POST /2/tweets                      { text, reply.in_reply_to_tweet_id, media.media_ids? }
//   media (image) POST /2/media/upload                multipart { media, media_category }
//   media (GIF/video, verified 2026-09-24)
//                 POST /2/media/upload/initialize     { media_type, total_bytes, media_category }
//                 POST /2/media/upload/:id/append     multipart { segment_index, media }
//                 POST /2/media/upload/:id/finalize
//                 GET  /2/media/upload?command=STATUS&media_id=:id
//                 (OAuth 2.0 scope media.write)
//   delete-post   DELETE /2/tweets/:id                { data.deleted }
//   hide-reply    PUT  /2/tweets/:id/hidden           { hidden: true|false }
//
// Account-level reads use connection.accountId. Writes re-assert ownership
// (accountId === /me id) before dispatch. An ambiguous write (timeout/5xx)
// stays unresolved: no id is guessed and nothing is reposted.
//
// Media is uploaded BEFORE the post as a journalled write; the confirmed
// media id is checkpointed so a lost post response can be retried later with
// `mediaId` (reusing the upload) instead of uploading the bytes again.

import { createHash } from 'node:crypto';

import { AppError, object, text } from '../domain/errors.js';
import { asArray, asRecord, boundedInt, isAmbiguousWriteError } from './helpers.js';
import { openXMedia, X_CHUNK_BYTES, type XMediaSource } from './media.js';
import { assertXText } from './validate.js';
import type { SocialAdapter, SocialCapability, SocialContext, SocialResource, SocialResult } from './types.js';

const API = 'https://api.x.com/2';
const READ_SCOPES = ['tweet.read', 'users.read'];
const WRITE_SCOPES = ['tweet.read', 'tweet.write', 'users.read'];
const MODERATE_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'tweet.moderate.write'];
const MEDIA_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write'];
const MAX_PAGES = 5;
// Bounded async-processing wait (GIF/video). Module-owned, never user input.
const MEDIA_POLL_MAX_ATTEMPTS = 10;
const MEDIA_POLL_MAX_ELAPSED_MS = 300_000;
const MEDIA_POLL_DEFAULT_MS = 5_000;
const MEDIA_POLL_MAX_INTERVAL_MS = 60_000;

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
      return { summary: { provider: 'x', operation, outcome: 'unknown', ...mediaSummary(journal) }, unresolved: true };
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
  return { summary: { provider: 'x', operation, externalId: id, permalink: resource.permalink, ...mediaSummary(journal) }, resources: [resource] };
}

function mediaSummary(journal: Record<string, unknown>): Record<string, unknown> {
  return typeof journal.mediaId === 'string' ? { mediaId: journal.mediaId } : {};
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new AppError('CANCELLED', 'X 미디어 처리 대기가 취소되었습니다.')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new AppError('CANCELLED', 'X 미디어 처리 대기가 취소되었습니다.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type MediaOutcome = { mediaId: string } | { result: SocialResult };

function mediaIdOf(payload: Record<string, unknown>): string {
  const id = asRecord(payload.data).id;
  if (typeof id !== 'string' || !/^\d{1,19}$/.test(id)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'X 미디어 식별자를 확인할 수 없습니다.');
  return id;
}

function processingOf(payload: Record<string, unknown>): { state?: string; checkAfterMs: number } {
  const info = asRecord(asRecord(payload.data).processing_info);
  const seconds = typeof info.check_after_secs === 'number' && info.check_after_secs > 0 ? info.check_after_secs : 0;
  return {
    state: typeof info.state === 'string' ? info.state.toLowerCase() : undefined,
    checkAfterMs: seconds ? Math.min(MEDIA_POLL_MAX_INTERVAL_MS, seconds * 1000) : MEDIA_POLL_DEFAULT_MS,
  };
}

/** Uploads bytes; every request is a write so the first one journals dispatch. */
async function sendMedia(ctx: SocialContext, media: XMediaSource, onInitialized: (id: string) => void): Promise<Record<string, unknown>> {
  const headers = await bearer(ctx, MEDIA_SCOPES);
  const hash = createHash('sha256');
  if (!media.spec.chunked) {
    const bytes = await media.read(0, media.size);
    media.verify(hash.update(bytes).digest('hex'));
    const form = new FormData();
    form.set('media', new Blob([new Uint8Array(bytes)], { type: media.spec.mimeType }), media.name);
    form.set('media_category', media.spec.category);
    return ctx.request<Record<string, unknown>>(`${API}/media/upload`, { method: 'POST', headers, body: form, write: true });
  }
  const init = await ctx.request<Record<string, unknown>>(`${API}/media/upload/initialize`, {
    method: 'POST', headers, write: true,
    json: { media_type: media.spec.mimeType, total_bytes: media.size, media_category: media.spec.category },
  });
  const id = mediaIdOf(init);
  onInitialized(id);
  for (let offset = 0, segment = 0; offset < media.size; offset += X_CHUNK_BYTES, segment += 1) {
    // Cancellation after INIT leaves an unfinished upload: report it as an
    // ambiguous write (CANCELLED), never as a clean failure.
    if (ctx.signal.aborted) throw new AppError('CANCELLED', 'X 미디어 업로드가 취소되었습니다.');
    const chunk = await media.read(offset, X_CHUNK_BYTES);
    hash.update(chunk);
    const form = new FormData();
    form.set('segment_index', String(segment));
    form.set('media', new Blob([new Uint8Array(chunk)], { type: 'application/octet-stream' }), media.name);
    await ctx.request(`${API}/media/upload/${id}/append`, { method: 'POST', headers, body: form, write: true });
  }
  // Never finalize bytes that differ from the registered file.
  media.verify(hash.digest('hex'));
  return ctx.request<Record<string, unknown>>(`${API}/media/upload/${id}/finalize`, { method: 'POST', headers, write: true });
}

/** Bounded, abortable STATUS poll; never re-uploads. */
async function awaitMediaReady(ctx: SocialContext, mediaId: string, first: { state?: string; checkAfterMs: number }): Promise<'succeeded' | 'failed' | 'unresolved'> {
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? defaultSleep;
  const start = now();
  let current = first;
  for (let attempt = 0; ; attempt += 1) {
    if (!current.state || current.state === 'succeeded') return 'succeeded';
    if (current.state === 'failed') return 'failed';
    if (attempt >= MEDIA_POLL_MAX_ATTEMPTS || now() - start >= MEDIA_POLL_MAX_ELAPSED_MS) return 'unresolved';
    try {
      await sleep(current.checkAfterMs, ctx.signal);
      const payload = await ctx.request<Record<string, unknown>>(
        `${API}/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
        { headers: await bearer(ctx, MEDIA_SCOPES) },
      );
      current = processingOf(payload);
      // A STATUS body without processing_info is not proof of success.
      if (!current.state) current = { state: 'unknown', checkAfterMs: MEDIA_POLL_DEFAULT_MS };
    } catch (error) {
      if (error instanceof AppError && error.code === 'TEMPORARY') { current = { state: 'unknown', checkAfterMs: MEDIA_POLL_DEFAULT_MS }; continue; }
      if (error instanceof AppError && error.code === 'CANCELLED') return 'unresolved';
      if (ctx.signal.aborted) return 'unresolved';
      throw error;
    }
  }
}

/**
 * Resolves the media id to attach. `mediaId` input reuses an upload that an
 * earlier run checkpointed (e.g. after a lost post response); otherwise the
 * verified artifact is uploaded once and its id checkpointed before posting.
 */
async function prepareMedia(ctx: SocialContext, operation: 'create-post' | 'reply', input: Record<string, unknown>): Promise<MediaOutcome | undefined> {
  if (input.mediaId !== undefined && input.mediaId !== null && input.mediaId !== '') {
    const mediaId = text(input.mediaId, 'mediaId', 19);
    if (!/^\d{1,19}$/.test(mediaId)) throw new AppError('INVALID_INPUT', 'mediaId는 숫자 X 미디어 ID여야 합니다.');
    ctx.checkpoint({ provider: 'x', operation, stage: 'media-reused', mediaId });
    return { mediaId };
  }
  if (input.mediaAssetId === undefined || input.mediaAssetId === null || input.mediaAssetId === '') return undefined;
  const media = await openXMedia(ctx.artifact);
  let initializedId: string | undefined;
  try {
    ctx.checkpoint({ provider: 'x', operation, stage: 'media-upload', mediaSha256: ctx.artifact!.sha256, mediaCategory: media.spec.category, mediaBytes: media.size });
    let payload: Record<string, unknown>;
    try {
      payload = await sendMedia(ctx, media, id => {
        initializedId = id;
        ctx.checkpoint({ provider: 'x', operation, stage: 'media-initialized', initializedMediaId: id });
      });
    } catch (error) {
      if (isAmbiguousWriteError(error)) {
        return { result: { summary: { provider: 'x', operation, stage: 'media-upload', outcome: 'unknown', ...(initializedId ? { initializedMediaId: initializedId } : {}) }, unresolved: true } };
      }
      throw error;
    }
    const mediaId = mediaIdOf(payload);
    if (initializedId && mediaId !== initializedId) throw new AppError('INVALID_PROVIDER_RESPONSE', 'X 미디어 업로드 식별자가 일치하지 않습니다.');
    ctx.checkpoint({ provider: 'x', operation, stage: 'media-uploaded', mediaId, mediaCategory: media.spec.category });
    const state = await awaitMediaReady(ctx, mediaId, processingOf(payload));
    if (state === 'failed') {
      // Processing failed before any post was sent: nothing public exists.
      return { result: { summary: { provider: 'x', operation, stage: 'media-processing', mediaId, outcome: 'failed' } } };
    }
    if (state === 'unresolved') {
      return { result: { summary: { provider: 'x', operation, stage: 'media-processing', mediaId, outcome: 'unknown' }, unresolved: true } };
    }
    ctx.checkpoint({ provider: 'x', operation, stage: 'media-ready', mediaId });
    return { mediaId };
  } finally {
    await media.close();
  }
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

const MEDIA_ASSET_FIELD = { key: 'mediaAssetId', label: '첨부 미디어 (선택)', hint: '프로젝트에 등록한 미디어 1개를 먼저 업로드해 첨부합니다. JPEG·PNG·WebP 5MB, GIF 15MB, MP4·MOV 동영상.' };
const MEDIA_ID_FIELD = { key: 'mediaId', label: '업로드된 X 미디어 ID (재시도용)', hint: '이전 실행이 체크포인트한 mediaId를 재사용해 다시 업로드하지 않습니다. X 미디어 ID는 업로드 후 24시간 동안 유효합니다.' };

const capability: SocialCapability = {
  provider: 'x',
  name: 'X (Twitter)',
  description: 'X API v2로 계정 확인, 게시글·멘션 조회, 텍스트·미디어(이미지·GIF·동영상 1개) 게시와 답글을 수행합니다.',
  authKind: 'oauth2-pkce',
  fields: [
    { key: 'clientId', label: 'OAuth 2.0 Client ID', required: true },
    { key: 'clientSecret', label: 'Client Secret (기밀 클라이언트만)', secret: true },
    { key: 'refreshToken', label: 'Refresh Token', secret: true, required: true },
  ],
  readOperations: ['check', 'list-posts', 'list-mentions'],
  writeOperations: ['create-post', 'reply', 'delete-post', 'hide-reply'],
  operationFields: {
    'create-post': [
      { key: 'text', label: '게시 문구', type: 'textarea', required: true },
      MEDIA_ASSET_FIELD,
      MEDIA_ID_FIELD,
    ],
    reply: [
      { key: 'replyToId', label: '답글 대상 ID', required: true },
      { key: 'text', label: '답글 문구', type: 'textarea', required: true },
      MEDIA_ASSET_FIELD,
      MEDIA_ID_FIELD,
    ],
    'delete-post': [{ key: 'postId', label: '게시글 ID', type: 'text', required: true, hint: '연결된 계정이 작성한 게시글만 삭제합니다.' }],
    'hide-reply': [
      { key: 'postId', label: '답글 ID', type: 'text', required: true },
      { key: 'hide', type: 'select', required: true, label: '숨김', options: [{ value: 'true', label: '숨김' }, { value: 'false', label: '숨김 해제' }] },
    ],
  },
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'tweet.moderate.write', 'media.write'],
  setupUrl: 'https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code',
  limitations: [
    '미디어는 게시글당 1개(이미지·GIF·동영상)를 등록 파일에서 업로드해 첨부합니다. 이미지는 POST /2/media/upload, GIF·동영상은 initialize/append/finalize 후 STATUS로 처리 완료를 확인합니다. URL 미디어는 게시하지 않습니다.',
    '미디어 업로드에는 OAuth 2.0 media.write 동의가 필요합니다. 이 범위 추가 전에 연결한 X 계정은 다시 연결해 동의해야 합니다.',
    '게시 응답을 받지 못하면 업로드된 mediaId를 결과에 남깁니다. 게시가 없음을 확인한 뒤 mediaId 입력으로 재시도하면 파일을 다시 올리지 않습니다(24시간 유효).',
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
        const media = await prepareMedia(ctx, 'create-post', input);
        if (media && 'result' in media) return media.result;
        return dispatchPost(ctx, 'create-post', { text: body, ...(media ? { media: { media_ids: [media.mediaId] } } : {}) },
          { textHash, ...(media ? { mediaId: media.mediaId } : {}) });
      }
      case 'reply': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '답글 작성에는 프로젝트에 바인딩된 연결이 필요합니다.');
        const body = assertXText(input.text);
        const replyTo = text(input.replyToId, 'replyToId', 40);
        if (!/^\d{1,19}$/.test(replyTo)) throw new AppError('INVALID_INPUT', 'replyToId는 숫자 게시글 ID여야 합니다.');
        await assertOwnedAccount(ctx);
        const textHash = createHash('sha256').update(body, 'utf8').digest('hex');
        const media = await prepareMedia(ctx, 'reply', input);
        if (media && 'result' in media) return media.result;
        return dispatchPost(ctx, 'reply', { text: body, reply: { in_reply_to_tweet_id: replyTo }, ...(media ? { media: { media_ids: [media.mediaId] } } : {}) },
          { textHash, replyTo, ...(media ? { mediaId: media.mediaId } : {}) });
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
