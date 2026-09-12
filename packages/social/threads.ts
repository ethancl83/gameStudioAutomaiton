// Threads (Meta) API adapter.
//
// Endpoints (verified against developers.facebook.com/docs/threads, 2026-09-11):
//   check        GET  /v1.0/me
//   list-posts   GET  /v1.0/:userId/threads          (own-user; data.owned=true)
//   list-replies GET  /v1.0/:postId/replies
//   create-post  POST /v1.0/:userId/threads (media_type=TEXT) -> container id
//                POST /v1.0/:userId/threads_publish (creation_id) -> media id
//   reply        as create-post with reply_to_id
//   reconcile    GET  /v1.0/:containerId?fields=status  (READ ONLY; never publishes)
//
// The container id is checkpointed BEFORE publishing so an ambiguous publish can
// be reconciled by a safe read instead of a blind repost.

import { createHash } from 'node:crypto';

import { AppError, object, text } from '../domain/errors.js';
import { asArray, asRecord, boundedInt, isAmbiguousWriteError } from './helpers.js';
import { assertPublicHttpsUrl, parseCarouselItems, threadsMediaKind } from './media.js';
import { assertThreadsText } from './validate.js';
import type { SocialAdapter, SocialCapability, SocialContext, SocialResource, SocialResult } from './types.js';

const API = 'https://graph.threads.net/v1.0';
const SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_read_replies', 'threads_delete'];
const MAX_PAGES = 5;
// Bounded pre-publish readiness polling. Meta's publishing reference
// (developers.facebook.com/docs/threads/reference/publishing, verified
// 2026-09-11) recommends waiting until the container status is FINISHED before
// calling threads_publish; a premature publish fails because the container is
// still IN_PROGRESS. These bounds are module-owned (never user input): the wait
// can never run unbounded, and abort stops it immediately.
const PUBLISH_POLL_INTERVAL_MS = 60_000;
const PUBLISH_POLL_MAX_ATTEMPTS = 6;
const PUBLISH_POLL_MAX_ELAPSED_MS = 300_000;
const POST_FIELDS = 'id,text,permalink,timestamp,media_type,username,shortcode';
// Replies additionally carry is_reply_owned_by_me: "true if your user is the
// owner of the Threads reply." The controller uses this ownership flag as a
// loop guard so the automation never replies to / acts on its own replies.
const REPLY_FIELDS = `${POST_FIELDS},is_reply_owned_by_me,hide_status`;

async function bearer(ctx: SocialContext): Promise<Record<string, string>> {
  // Long-lived token is sent as a bearer header, never in the URL, so it does
  // not land in request logs.
  return { Authorization: `Bearer ${await ctx.accessToken(SCOPES)}` };
}

function threadsUserId(ctx: SocialContext): string {
  const id = ctx.connection.accountId;
  if (!id || !/^\d{1,25}$/.test(id)) throw new AppError('MISSING_REQUIREMENT', 'Threads 사용자 ID(accountId)가 필요합니다.');
  return id;
}

function postResource(row: Record<string, unknown>, kind: 'post' | 'reply', owned?: boolean): SocialResource {
  const id = String(row.id ?? '');
  const data: Record<string, unknown> = {
    mediaType: row.media_type,
    username: row.username,
    shortcode: row.shortcode,
  };
  // Own-user GET /{user-id}/threads rows are the authenticated account's posts
  // (`owned: true`) so a first sync can satisfy root's project-owned delete
  // guard. Reply/mention rows must not inherit that; replies use the official
  // `is_reply_owned_by_me` field as a loop guard.
  if (typeof owned === 'boolean') data.owned = owned;
  else if (typeof row.is_reply_owned_by_me === 'boolean') data.owned = row.is_reply_owned_by_me;
  if (typeof row.hide_status === 'string') data.hideStatus = row.hide_status;
  return {
    kind,
    externalId: id,
    ...(typeof row.permalink === 'string' ? { permalink: row.permalink } : {}),
    ...(typeof row.timestamp === 'string' ? { createdAt: row.timestamp } : {}),
    ...(typeof row.text === 'string' ? { text: row.text } : {}),
    data,
  };
}

async function readMedia(ctx: SocialContext, mediaId: string): Promise<SocialResource> {
  const payload = await ctx.request<Record<string, unknown>>(
    `${API}/${encodeURIComponent(mediaId)}?fields=${POST_FIELDS}`,
    { headers: await bearer(ctx) },
  );
  return postResource(asRecord(payload), 'post');
}

async function listThreads(ctx: SocialContext, path: string, kind: 'post' | 'reply', input: Record<string, unknown>, fields = POST_FIELDS, owned?: boolean): Promise<SocialResult> {
  const limit = boundedInt(input, 'limit', 25, 1, 100);
  const maxPages = boundedInt(input, 'maxPages', 1, 1, MAX_PAGES);
  const resources: SocialResource[] = [];
  let after = '';
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    if (seen.has(after)) break;
    seen.add(after);
    const url = new URL(`${API}/${path}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('limit', String(limit));
    if (after) url.searchParams.set('after', after);
    const payload = await ctx.request<Record<string, unknown>>(url.toString(), { headers: await bearer(ctx) });
    for (const row of asArray(payload.data)) resources.push(postResource(asRecord(row), kind, owned));
    const cursors = asRecord(asRecord(payload.paging).cursors);
    after = typeof cursors.after === 'string' ? cursors.after : '';
    if (!after) break;
  }
  return { summary: { provider: 'threads', count: resources.length }, resources };
}

async function assertOwnedAccount(ctx: SocialContext): Promise<string> {
  const payload = await ctx.request<Record<string, unknown>>(`${API}/me?fields=id,username`, { headers: await bearer(ctx) });
  const id = typeof payload.id === 'string' ? payload.id : '';
  if (!id) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Threads 계정 식별자를 확인할 수 없습니다.');
  if (id !== ctx.connection.accountId) {
    throw new AppError('ACCOUNT_MISMATCH', '연결된 Threads 계정과 현재 토큰의 계정이 일치하지 않습니다.');
  }
  return id;
}

// READ ONLY container status lookup, shared by the pre-publish readiness poll
// and the `reconcile` recovery path. We deliberately request only `id,status`
// and never `error_message`: the status enum is a fixed, safe vocabulary while
// error_message is raw provider free text that must not surface.
async function fetchContainerStatus(ctx: SocialContext, containerId: string): Promise<string> {
  const payload = await ctx.request<Record<string, unknown>>(
    `${API}/${encodeURIComponent(containerId)}?fields=id,status`,
    { headers: await bearer(ctx) },
  );
  return typeof payload.status === 'string' && ['IN_PROGRESS', 'FINISHED', 'ERROR', 'EXPIRED', 'PUBLISHED'].includes(payload.status) ? payload.status : 'UNKNOWN';
}

// Signal-aware fallback delay used when the controller does not inject `sleep`.
// Rejects with a CANCELLED AppError the moment the abort signal fires so a
// cancelled job never keeps waiting.
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new AppError('CANCELLED', 'Threads 대기가 취소되었습니다.')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new AppError('CANCELLED', 'Threads 대기가 취소되었습니다.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type Readiness = { decision: 'ready' | 'failed' | 'unresolved'; status: string };

// Bounded, abortable poll of the container status BEFORE the first publish.
// Returns:
//   ready       -> status FINISHED: safe to publish exactly once.
//   failed      -> status ERROR/EXPIRED: terminal, never publish, never repost.
//   unresolved  -> abort, exhausted attempts/elapsed, or an unexpected PUBLISHED
//                  (state we cannot safely turn into a media id here): keep the
//                  container id for a later read-only reconcile; never publish.
// It never calls threads_publish and never guesses a media id.
async function awaitContainerReady(ctx: SocialContext, containerId: string): Promise<Readiness> {
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? defaultSleep;
  const start = now();
  let status = 'UNKNOWN';
  for (let attempt = 0; attempt < PUBLISH_POLL_MAX_ATTEMPTS; attempt += 1) {
    if (ctx.signal.aborted) return { decision: 'unresolved', status };
    try {
      status = await fetchContainerStatus(ctx, containerId);
    } catch (error) {
      // Abort during the read -> stop (unresolved). A transient read failure is
      // retried within the same bounds; any other error propagates.
      if (error instanceof AppError && error.code === 'CANCELLED') return { decision: 'unresolved', status };
      if (error instanceof AppError && error.code === 'TEMPORARY') status = 'UNKNOWN';
      else throw error;
    }
    if (status === 'FINISHED') return { decision: 'ready', status };
    if (status === 'ERROR' || status === 'EXPIRED') return { decision: 'failed', status };
    if (status === 'PUBLISHED') return { decision: 'unresolved', status };
    // IN_PROGRESS / UNKNOWN / any other value -> keep waiting within the bounds.
    if (attempt + 1 >= PUBLISH_POLL_MAX_ATTEMPTS || now() - start >= PUBLISH_POLL_MAX_ELAPSED_MS) return { decision: 'unresolved', status };
    try {
      await sleep(PUBLISH_POLL_INTERVAL_MS, ctx.signal);
    } catch {
      return { decision: 'unresolved', status }; // aborted while sleeping
    }
    if (now() - start > PUBLISH_POLL_MAX_ELAPSED_MS) return { decision: 'unresolved', status };
  }
  return { decision: 'unresolved', status };
}

async function createReadyContainer(
  ctx: SocialContext,
  operation: string,
  containerForm: Record<string, string>,
  journal: Record<string, unknown>,
): Promise<SocialResult & { containerId?: string }> {
  const userId = threadsUserId(ctx);
  ctx.checkpoint({ provider: 'threads', operation, stage: 'container', ...journal });
  let container: Record<string, unknown>;
  try {
    container = await ctx.request<Record<string, unknown>>(`${API}/${encodeURIComponent(userId)}/threads`, {
      method: 'POST', headers: await bearer(ctx), form: containerForm, write: true,
    });
  } catch (error) {
    if (isAmbiguousWriteError(error)) {
      return { summary: { provider: 'threads', operation, stage: 'container', outcome: 'unknown' }, unresolved: true };
    }
    throw error;
  }
  const containerId = typeof container.id === 'string' ? container.id : '';
  if (!containerId) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Threads 컨테이너 ID를 확인할 수 없습니다.');
  ctx.checkpoint({ provider: 'threads', operation, stage: 'container_created', containerId, ...journal });
  const readiness = await awaitContainerReady(ctx, containerId);
  if (readiness.decision === 'failed') {
    return { summary: { provider: 'threads', operation, stage: 'container_status', containerId, status: readiness.status, outcome: 'failed' }, containerId };
  }
  if (readiness.decision !== 'ready') {
    return {
      summary: { provider: 'threads', operation, stage: 'container_status', containerId, status: readiness.status, outcome: 'unknown' },
      unresolved: true,
      waitingExternal: true,
      containerId,
    };
  }
  return { summary: { provider: 'threads', operation, stage: 'container_ready', containerId, status: readiness.status }, containerId };
}

async function createAndPublish(
  ctx: SocialContext,
  operation: 'create-post' | 'reply',
  containerForm: Record<string, string>,
  journal: Record<string, unknown>,
): Promise<SocialResult> {
  const prepared = await createReadyContainer(ctx, operation, containerForm, journal);
  if (prepared.unresolved || prepared.summary.outcome === 'failed' || !prepared.containerId) return prepared;
  const containerId = prepared.containerId;
  const userId = threadsUserId(ctx);

  // Publish only after a confirmed FINISHED status.
  let published: Record<string, unknown>;
  try {
    published = await ctx.request<Record<string, unknown>>(`${API}/${encodeURIComponent(userId)}/threads_publish`, {
      method: 'POST', headers: await bearer(ctx), form: { creation_id: containerId }, write: true,
    });
  } catch (error) {
    if (isAmbiguousWriteError(error)) {
      // Publish outcome unknown. Keep the container id so a later `reconcile`
      // read can recover the result; never auto-publish again here.
      return {
        summary: { provider: 'threads', operation, stage: 'publish', containerId, outcome: 'unknown' },
        unresolved: true,
        waitingExternal: true,
      };
    }
    throw error;
  }
  const mediaId = typeof published.id === 'string' ? published.id : '';
  if (!mediaId) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Threads 게시 결과 ID를 확인할 수 없습니다.');
  // Journal the confirmed external id BEFORE the optional recovery GET, so the
  // result is durably known even if the permalink read fails.
  ctx.checkpoint({ provider: 'threads', operation, stage: 'published', containerId, externalId: mediaId, ...journal });
  // Safe read to recover the permalink/timestamp of the published post.
  let resource: SocialResource;
  try {
    resource = await readMedia(ctx, mediaId);
  } catch {
    resource = { kind: operation === 'reply' ? 'reply' : 'post', externalId: mediaId, data: { containerId } };
  }
  if (operation === 'reply') resource.kind = 'reply';
  return {
    summary: { provider: 'threads', operation, containerId, externalId: mediaId, permalink: resource.permalink },
    resources: [resource],
  };
}

function optionalCaption(input: Record<string, unknown>): string | undefined {
  if (input.text === undefined || input.text === null || input.text === '') return undefined;
  return assertThreadsText(input.text);
}

function mediaContainerForm(input: Record<string, unknown>, replyToId?: string): Record<string, string> {
  const kind = threadsMediaKind(input.mediaType);
  const form: Record<string, string> = { media_type: kind };
  if (kind === 'TEXT') form.text = assertThreadsText(input.text);
  else if (kind === 'IMAGE') {
    form.image_url = assertPublicHttpsUrl(text(input.imageUrl, 'imageUrl', 2000), 'imageUrl');
    const caption = optionalCaption(input);
    if (caption) form.text = caption;
  } else if (kind === 'VIDEO') {
    form.video_url = assertPublicHttpsUrl(text(input.videoUrl, 'videoUrl', 2000), 'videoUrl');
    const caption = optionalCaption(input);
    if (caption) form.text = caption;
  } else {
    throw new AppError('INVALID_INPUT', '캐러셀은 mediaUrls JSON 배열을 사용하세요.');
  }
  if (replyToId) form.reply_to_id = replyToId;
  return form;
}

function journalFromForm(form: Record<string, string>, replyToId?: string): Record<string, unknown> {
  const source = form.text || form.image_url || form.video_url || form.children || '';
  const textHash = createHash('sha256').update(source, 'utf8').digest('hex');
  return { textHash, mediaType: form.media_type, ...(replyToId ? { replyToId } : {}) };
}

async function publishCarousel(ctx: SocialContext, operation: 'create-post' | 'reply', input: Record<string, unknown>, replyToId?: string): Promise<SocialResult> {
  const items = parseCarouselItems(input.mediaUrls);
  const children: string[] = [];
  for (const [index, item] of items.entries()) {
    const childForm: Record<string, string> = {
      media_type: item.kind,
      is_carousel_item: 'true',
      ...(item.kind === 'VIDEO' ? { video_url: item.url } : { image_url: item.url }),
    };
    const child = await createReadyContainer(ctx, operation, childForm, { stage: 'carousel_child', index, textHash: createHash('sha256').update(item.url, 'utf8').digest('hex') });
    if (child.unresolved || child.summary.outcome === 'failed' || !child.containerId) return child;
    children.push(child.containerId);
  }
  const caption = optionalCaption(input);
  const parent: Record<string, string> = { media_type: 'CAROUSEL', children: children.join(',') };
  if (caption) parent.text = caption;
  if (replyToId) parent.reply_to_id = replyToId;
  return createAndPublish(ctx, operation, parent, journalFromForm(parent, replyToId));
}

function mediaId(input: Record<string, unknown>, label: string): string {
  const id = text(input.postId ?? input.externalId ?? input.replyToId, label, 40);
  if (!/^\d{1,25}$/.test(id)) throw new AppError('INVALID_INPUT', `${label}는 숫자 ID여야 합니다.`);
  return id;
}

async function hideReply(ctx: SocialContext, input: Record<string, unknown>): Promise<SocialResult> {
  const id = mediaId(input, '답글 ID');
  const hide = input.hide === true || input.hide === 'true';
  if (input.hide !== true && input.hide !== false && input.hide !== 'true' && input.hide !== 'false') {
    throw new AppError('INVALID_INPUT', 'hide는 true 또는 false 여야 합니다.');
  }
  await assertOwnedAccount(ctx);
  ctx.checkpoint({ provider: 'threads', operation: 'hide-reply', replyId: id, hide });
  let payload: Record<string, unknown>;
  try {
    payload = await ctx.request<Record<string, unknown>>(`${API}/${encodeURIComponent(id)}/manage_reply`, {
      method: 'POST', headers: await bearer(ctx), form: { hide: hide ? 'true' : 'false' }, write: true,
    });
  } catch (error) {
    if (isAmbiguousWriteError(error)) return { summary: { provider: 'threads', operation: 'hide-reply', replyId: id, outcome: 'unknown' }, unresolved: true };
    throw error;
  }
  if (payload.success !== true) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Threads 답글 숨김 결과를 확인할 수 없습니다.');
  return { summary: { provider: 'threads', operation: 'hide-reply', externalId: id, hidden: hide, success: true } };
}

async function deletePost(ctx: SocialContext, input: Record<string, unknown>): Promise<SocialResult> {
  const id = mediaId(input, '게시글 ID');
  await assertOwnedAccount(ctx);
  ctx.checkpoint({ provider: 'threads', operation: 'delete-post', postId: id });
  let payload: Record<string, unknown>;
  try {
    payload = await ctx.request<Record<string, unknown>>(`${API}/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: await bearer(ctx), write: true,
    });
  } catch (error) {
    if (isAmbiguousWriteError(error)) return { summary: { provider: 'threads', operation: 'delete-post', postId: id, outcome: 'unknown' }, unresolved: true };
    throw error;
  }
  if (payload.success !== true) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Threads 게시글 삭제 결과를 확인할 수 없습니다.');
  ctx.checkpoint({ provider: 'threads', operation: 'delete-post', stage: 'deleted', externalId: id });
  return { summary: { provider: 'threads', operation: 'delete-post', externalId: id, deletedId: payload.deleted_id, deleted: true } };
}

const capability: SocialCapability = {
  provider: 'threads',
  name: 'Threads',
  description: 'Threads Graph API로 조회, 텍스트·이미지 URL·캐러셀 게시, 답글 숨김, 게시글 삭제를 수행합니다.',
  authKind: 'oauth2-longlived',
  fields: [
    { key: 'threadsUserId', label: 'Threads User ID', required: true },
    { key: 'accessToken', label: 'Long-Lived Access Token', secret: true, required: true },
    { key: 'clientSecret', label: 'App Secret', secret: true, required: true },
  ],
  readOperations: ['check', 'list-posts', 'list-replies', 'reconcile'],
  writeOperations: ['create-post', 'reply', 'hide-reply', 'delete-post'],
  operationFields: {
    'create-post': [
      { key: 'text', label: '게시 문구', type: 'textarea', required: false, hint: 'TEXT는 필수. IMAGE/VIDEO/CAROUSEL은 선택.' },
      { key: 'mediaType', label: '미디어 형식', type: 'select', options: [
        { value: 'TEXT', label: '텍스트' }, { value: 'IMAGE', label: '이미지 URL' },
        { value: 'VIDEO', label: '동영상 URL' }, { value: 'CAROUSEL', label: '캐러셀' },
      ] },
      { key: 'imageUrl', label: '이미지 https URL', type: 'text', hint: '공개 서버 URL. 로컬 파일·스크립트 실행 없음.' },
      { key: 'videoUrl', label: '동영상 https URL', type: 'text' },
      { key: 'mediaUrls', label: '캐러셀 URL JSON 배열', type: 'textarea', hint: '["https://..."] 2–20개. 공개 https만.' },
    ],
    reply: [
      { key: 'replyToId', label: '답글 대상 ID', required: true },
      { key: 'text', label: '답글 문구', type: 'textarea', required: true },
    ],
    'list-replies': [{ key: 'postId', label: '게시글 ID', required: true }],
    'hide-reply': [
      { key: 'postId', label: '답글 ID', type: 'text', required: true, hint: '최상위 답글만 숨길 수 있습니다. 하위 답글은 함께 숨겨집니다.' },
      { key: 'hide', type: 'select', required: true, label: '숨김', options: [{ value: 'true', label: '숨김' }, { value: 'false', label: '숨김 해제' }] },
    ],
    'delete-post': [{ key: 'postId', label: '게시글 ID', type: 'text', required: true, hint: '본인 게시글만 삭제. threads_delete 권한 필요.' }],
  },
  scopes: SCOPES,
  setupUrl: 'https://developers.facebook.com/docs/threads/posts',
  limitations: [
    '텍스트와 공개 https image_url/video_url, 캐러셀(2–20)만 지원합니다. 로컬 파일 업로드·임의 스크립트 실행은 없습니다.',
    '게시글 길이는 500자이며 이모지는 UTF-8 바이트 수로 계산합니다.',
    '답글 숨김은 POST /{id}/manage_reply (hide=true|false). 삭제는 DELETE /{id} (threads_delete, 계정당 하루 100회).',
    '발행 전 컨테이너 status가 FINISHED가 될 때까지 유한(bounded)·중단 가능한 읽기 폴링을 수행하며, FINISHED에서만 정확히 한 번 발행합니다.',
    '폴링이 한도(시도/경과 시간)를 넘기거나 중단되면 발행하지 않고 컨테이너 ID를 남겨 reconcile(읽기 전용)로 복구하며 자동 재발행하지 않습니다.',
  ],
};

export const threadsAdapter: SocialAdapter = {
  capability,
  async execute(operation, rawInput, ctx): Promise<SocialResult> {
    const input = object(rawInput ?? {});
    switch (operation) {
      case 'check': {
        const id = await assertOwnedAccount(ctx);
        const payload = await ctx.request<Record<string, unknown>>(
          `${API}/me?fields=id,username,name,threads_profile_picture_url`,
          { headers: await bearer(ctx) },
        );
        const resource: SocialResource = {
          kind: 'account',
          externalId: id,
          data: { username: payload.username, name: payload.name },
        };
        return { summary: { provider: 'threads', operation, userId: id, username: payload.username }, resources: [resource] };
      }
      case 'list-posts':
        return listThreads(ctx, `${encodeURIComponent(threadsUserId(ctx))}/threads`, 'post', input, POST_FIELDS, true);
      case 'list-replies': {
        const postId = text(input.postId, 'postId', 40);
        if (!/^\d{1,25}$/.test(postId)) throw new AppError('INVALID_INPUT', 'postId는 숫자 게시글 ID여야 합니다.');
        return listThreads(ctx, `${encodeURIComponent(postId)}/replies`, 'reply', input, REPLY_FIELDS);
      }
      case 'reconcile': {
        // READ ONLY container-status lookup for a previously checkpointed
        // container. This never calls threads_publish.
        const containerId = text(input.containerId, 'containerId', 40);
        if (!/^\d{1,25}$/.test(containerId)) throw new AppError('INVALID_INPUT', 'containerId는 숫자 컨테이너 ID여야 합니다.');
        // Reuses the shared read-only status lookup, which requests only
        // `id,status` and never `error_message` (raw provider free text).
        const status = await fetchContainerStatus(ctx, containerId);
        // PUBLISHED -> confirmed; ERROR/EXPIRED -> failed (terminal, no repost);
        // anything else (IN_PROGRESS/FINISHED/UNKNOWN) -> unknown, so the
        // controller keeps it action_required. No media id is ever guessed.
        const outcome = status === 'PUBLISHED' ? 'confirmed' : status === 'ERROR' || status === 'EXPIRED' ? 'failed' : 'unknown';
        return {
          summary: { provider: 'threads', operation, containerId, status, outcome },
          unresolved: outcome === 'unknown',
        };
      }
      case 'create-post': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '게시글 작성에는 프로젝트에 바인딩된 연결이 필요합니다.');
        await assertOwnedAccount(ctx);
        if (threadsMediaKind(input.mediaType) === 'CAROUSEL') return publishCarousel(ctx, 'create-post', input);
        const form = mediaContainerForm(input);
        return createAndPublish(ctx, 'create-post', form, journalFromForm(form));
      }
      case 'reply': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '답글 작성에는 프로젝트에 바인딩된 연결이 필요합니다.');
        const replyTo = text(input.replyToId, 'replyToId', 40);
        if (!/^\d{1,25}$/.test(replyTo)) throw new AppError('INVALID_INPUT', 'replyToId는 숫자 게시글 ID여야 합니다.');
        await assertOwnedAccount(ctx);
        if (threadsMediaKind(input.mediaType) === 'CAROUSEL') return publishCarousel(ctx, 'reply', input, replyTo);
        const form = mediaContainerForm(input, replyTo);
        return createAndPublish(ctx, 'reply', form, journalFromForm(form, replyTo));
      }
      case 'hide-reply': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '답글 숨김에는 프로젝트에 바인딩된 연결이 필요합니다.');
        return hideReply(ctx, input);
      }
      case 'delete-post': {
        if (!ctx.project) throw new AppError('MISSING_REQUIREMENT', '게시글 삭제에는 프로젝트에 바인딩된 연결이 필요합니다.');
        return deletePost(ctx, input);
      }
      default:
        throw new AppError('UNSUPPORTED_OPERATION', `Threads 커넥터가 지원하지 않는 작업입니다: ${operation}`);
    }
  },
};
