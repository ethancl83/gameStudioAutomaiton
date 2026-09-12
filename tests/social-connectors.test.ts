import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '../packages/domain/errors.js';
import { xAdapter } from '../packages/social/x.js';
import { threadsAdapter } from '../packages/social/threads.js';
import { steamNewsAdapter } from '../packages/social/steam.js';
import { createSocialTransport } from '../packages/social/transport.js';
import { SocialTokenManager } from '../packages/social/tokens.js';
import { XOAuthBroker, ThreadsOAuthBroker } from '../packages/social/oauth.js';
import { weightedTweetLength, assertXText, threadsTextLength, assertThreadsText } from '../packages/social/validate.js';
import type { SocialContext, SocialProvider, SocialRequest } from '../packages/social/types.js';

interface Recorded { url: string; options: SocialRequest }

function createContext(options: {
  provider: SocialProvider;
  accountId?: string;
  appIdentifier?: string | null;
  withProject?: boolean;
  signal?: AbortSignal;
  // Injected abortable delay for readiness polling; defaults to an immediate
  // resolve so tests never wait on real timers. Records each call for asserts.
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  handler: (url: string, request: SocialRequest) => unknown;
}): {
  context: SocialContext;
  requests: Recorded[];
  checkpoints: Array<Record<string, unknown>>;
  dispatched: () => number;
  sleeps: () => number;
} {
  const requests: Recorded[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  let dispatched = 0;
  let sleeps = 0;
  const context: SocialContext = {
    connection: { id: 'conn-1', provider: options.provider, accountId: options.accountId ?? '1000000000000001' },
    credentials: {},
    project: options.withProject === false ? undefined : { appIdentifier: options.appIdentifier ?? 'com.harbor.game' },
    signal: options.signal ?? new AbortController().signal,
    markDispatched: () => { dispatched += 1; },
    checkpoint: data => { checkpoints.push({ ...data }); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'social-access-token',
    request: async <T>(url: string, request: SocialRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      if (request.write) dispatched += 1; // emulate transport journalling a write
      return options.handler(url, request) as T;
    },
    progress: () => undefined,
    sleep: async (ms: number, signal: AbortSignal) => { sleeps += 1; await (options.sleep ? options.sleep(ms, signal) : Promise.resolve()); },
  };
  return { context, requests, checkpoints, dispatched: () => dispatched, sleeps: () => sleeps };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// --- Text validation ----------------------------------------------------------

test('X weighted length counts CJK as 2 and URLs as 23; over-limit is rejected', () => {
  assert.equal(weightedTweetLength('hello'), 5);
  assert.equal(weightedTweetLength('가나다'), 6); // 3 CJK * 2
  assert.equal(weightedTweetLength('see https://example.com/very/long/path/that/exceeds'), 4 + 23); // "see " + one URL
  assert.equal(assertXText('a short plain post'), 'a short plain post');
  assert.throws(() => assertXText('a'.repeat(281)), (error: unknown) => error instanceof AppError && error.code === 'TEXT_TOO_LONG');
  assert.throws(() => assertXText('가'.repeat(141)), (error: unknown) => error instanceof AppError && error.code === 'TEXT_TOO_LONG');
});

test('Threads length counts emoji as UTF-8 bytes and caps at 500', () => {
  assert.equal(threadsTextLength('hello'), 5);
  assert.equal(threadsTextLength('가나다'), 3); // non-emoji characters count as 1 each
  assert.equal(threadsTextLength('👍'), 4); // one emoji = 4 UTF-8 bytes
  assert.equal(assertThreadsText('안녕하세요'), '안녕하세요');
  assert.throws(() => assertThreadsText('a'.repeat(501)), (error: unknown) => error instanceof AppError && error.code === 'TEXT_TOO_LONG');
});

// --- X adapter ----------------------------------------------------------------

function xHandler(overrides: Partial<{ me: unknown; tweet: unknown; timeline: unknown; mentions: unknown }> = {}) {
  return (url: string, request: SocialRequest) => {
    if (url.includes('/users/me')) return overrides.me ?? { data: { id: '1000000000000001', username: 'harbor', name: 'Harbor' } };
    if (url.endsWith('/tweets') && request.method === 'POST') {
      return overrides.tweet ?? { data: { id: '1800000000000000001', text: 'posted' } };
    }
    if (url.includes('/mentions')) return overrides.mentions ?? { data: [{ id: '2', text: 'hi @harbor' }], meta: { result_count: 1 } };
    if (url.includes('/tweets')) return overrides.timeline ?? { data: [{ id: '1', text: 'a' }], meta: { next_token: 'NEXT', result_count: 1 } };
    throw new Error(`unexpected url ${url}`);
  };
}

test('X check verifies account ownership against /me', async () => {
  const ok = createContext({ provider: 'x', handler: xHandler() });
  const result = await xAdapter.execute('check', {}, ok.context);
  assert.equal(result.summary.userId, '1000000000000001');
  assert.equal(result.resources?.[0].kind, 'account');

  const mismatch = createContext({ provider: 'x', accountId: '999', handler: xHandler() });
  await expectCode(xAdapter.execute('check', {}, mismatch.context), 'ACCOUNT_MISMATCH');
});

test('X create-post journals a checkpoint and sends the exact {text} payload as a write', async () => {
  const { context, requests, checkpoints, dispatched } = createContext({ provider: 'x', handler: xHandler() });
  const result = await xAdapter.execute('create-post', { text: 'Harbor v1 is out!' }, context);
  const post = requests.find(item => item.url.endsWith('/tweets') && item.options.method === 'POST');
  assert.ok(post);
  assert.equal(post!.options.write, true);
  assert.deepEqual(post!.options.json, { text: 'Harbor v1 is out!' });
  assert.ok(dispatched() >= 1);
  // pre-write journal recorded before dispatch, with a text hash (not the text)
  const journal = checkpoints.find(item => item.operation === 'create-post');
  assert.ok(journal);
  assert.equal(typeof journal!.textHash, 'string');
  assert.equal(journal!.text, undefined);
  assert.equal(result.resources?.[0].externalId, '1800000000000000001');
  assert.equal(result.resources?.[0].permalink, 'https://x.com/i/web/status/1800000000000000001');
});

test('X reply sends in_reply_to_tweet_id and validates the target id', async () => {
  const { context, requests } = createContext({ provider: 'x', handler: xHandler() });
  await xAdapter.execute('reply', { text: 'thanks!', replyToId: '1700000000000000002' }, context);
  const post = requests.find(item => item.url.endsWith('/tweets') && item.options.method === 'POST');
  assert.deepEqual((post!.options.json as { reply: unknown }).reply, { in_reply_to_tweet_id: '1700000000000000002' });
  const bad = createContext({ provider: 'x', handler: xHandler() });
  await expectCode(xAdapter.execute('reply', { text: 'hi', replyToId: 'not-an-id' }, bad.context), 'INVALID_INPUT');
});

test('X create-post requires a bound project', async () => {
  const { context } = createContext({ provider: 'x', withProject: false, handler: xHandler() });
  await expectCode(xAdapter.execute('create-post', { text: 'hi' }, context), 'MISSING_REQUIREMENT');
});

test('X write with an ambiguous (timeout) result stays unresolved and is not reposted', async () => {
  let posts = 0;
  const { context, requests } = createContext({
    provider: 'x',
    handler: (url, request) => {
      if (url.includes('/users/me')) return { data: { id: '1000000000000001' } };
      if (url.endsWith('/tweets') && request.method === 'POST') {
        posts += 1;
        throw new AppError('TEMPORARY', 'service did not respond', 503);
      }
      throw new Error(url);
    },
  });
  const result = await xAdapter.execute('create-post', { text: 'maybe posted' }, context);
  assert.equal(result.unresolved, true);
  assert.equal(result.resources, undefined);
  assert.equal(posts, 1, 'the write must not be automatically retried/reposted');
  assert.equal(requests.filter(item => item.url.endsWith('/tweets') && item.options.method === 'POST').length, 1);
});

test('X list-posts is bounded to one page by default and clamps max_results', async () => {
  const { context, requests } = createContext({ provider: 'x', handler: xHandler() });
  const result = await xAdapter.execute('list-posts', { maxResults: 500 }, context);
  assert.equal(result.resources?.length, 1);
  const list = requests.find(item => item.url.includes('/tweets') && item.options.method !== 'POST');
  assert.ok(list!.url.includes('max_results=100')); // clamped from 500 to 100
  // only one page fetched even though the response carried next_token
  assert.equal(requests.filter(item => item.url.includes('/tweets')).length, 1);
});

// --- Threads adapter ----------------------------------------------------------

function threadsHandler(overrides: Partial<{ me: unknown; container: unknown; publish: unknown; media: unknown; list: unknown; status: unknown }> = {}) {
  return (url: string, request: SocialRequest) => {
    if (url.includes('/me')) return overrides.me ?? { id: '1000000000000001', username: 'harbor', name: 'Harbor' };
    if (url.includes('/threads_publish')) return overrides.publish ?? { id: '9000000000000000001' };
    if (url.includes('/threads') && request.method === 'POST') return overrides.container ?? { id: '7000000000000000001' };
    if (url.includes('/replies')) return overrides.list ?? { data: [{ id: '5', text: 'nice' }], paging: {} };
    if (url.includes('/threads')) return overrides.list ?? { data: [{ id: '1', text: 'a', permalink: 'https://www.threads.net/@harbor/post/a' }], paging: { cursors: { after: 'CUR' } } };
    if (/\/\d+\?fields=id,status/.test(url)) return overrides.status ?? { id: '7000000000000000001', status: 'FINISHED' };
    return overrides.media ?? { id: '9000000000000000001', permalink: 'https://www.threads.net/@harbor/post/xyz', timestamp: '2026-09-11T00:00:00Z', text: 'posted' };
  };
}

test('Threads create-post records the container id BEFORE publishing, then publishes', async () => {
  const { context, requests, checkpoints } = createContext({ provider: 'threads', handler: threadsHandler() });
  const result = await threadsAdapter.execute('create-post', { text: 'Harbor devlog #1' }, context);
  const container = requests.find(item => item.url.includes('/threads') && !item.url.includes('publish') && item.options.method === 'POST');
  const publish = requests.find(item => item.url.includes('/threads_publish'));
  assert.ok(container && publish);
  // POST params travel in a form body, not the URL (bridgeable to ProviderRequest).
  assert.deepEqual(container!.options.form, { media_type: 'TEXT', text: 'Harbor devlog #1' });
  assert.equal(container!.url.includes('text='), false, 'text must not be in the URL');
  assert.equal(container!.options.write, true);
  assert.equal(publish!.options.form?.creation_id, '7000000000000000001');
  // a read-only status poll runs before publish, and requests only id,status
  const statusRead = requests.find(item => /\/\d+\?fields=id,status/.test(item.url));
  assert.ok(statusRead, 'container status must be polled before publishing');
  assert.equal((statusRead!.options.method ?? 'GET'), 'GET');
  assert.equal(statusRead!.url.includes('error_message'), false, 'status poll must not request error_message');
  assert.ok(requests.indexOf(statusRead!) < requests.indexOf(publish!), 'status poll must precede the publish write');
  // container id checkpointed before the publish request
  const recorded = checkpoints.find(item => item.stage === 'container_created');
  assert.equal(recorded?.containerId, '7000000000000000001');
  // the confirmed external id is journaled before the recovery GET
  const publishedJournal = checkpoints.find(item => item.stage === 'published');
  assert.equal(publishedJournal?.externalId, '9000000000000000001');
  assert.equal(result.resources?.[0].externalId, '9000000000000000001');
  assert.equal(result.summary.containerId, '7000000000000000001');
});

test('Threads reply passes reply_to_id on the container', async () => {
  const { context, requests } = createContext({ provider: 'threads', handler: threadsHandler() });
  await threadsAdapter.execute('reply', { text: 'thanks', replyToId: '6000000000000000001' }, context);
  const container = requests.find(item => item.url.includes('/threads') && !item.url.includes('publish') && item.options.method === 'POST');
  assert.equal(container!.options.form?.reply_to_id, '6000000000000000001');
});

test('Threads list-replies requests is_reply_owned_by_me and surfaces it as owned', async () => {
  const { context, requests } = createContext({
    provider: 'threads',
    handler: (url) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/replies')) return { data: [{ id: '5', text: 'nice', is_reply_owned_by_me: false }], paging: {} };
      throw new Error(url);
    },
  });
  const result = await threadsAdapter.execute('list-replies', { postId: '6000000000000000001' }, context);
  const list = requests.find(item => item.url.includes('/replies'));
  assert.ok(list!.url.includes('is_reply_owned_by_me'), 'ownership field must be requested');
  assert.equal(result.resources?.[0].kind, 'reply');
  assert.equal(result.resources?.[0].data.owned, false);
});

test('Threads publish timeout keeps the container id, stays unresolved, does not re-publish', async () => {
  let publishes = 0;
  const { context, checkpoints } = createContext({
    provider: 'threads',
    handler: (url, request) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/threads_publish')) { publishes += 1; throw new AppError('TEMPORARY', 'no response', 503); }
      if (url.includes('/threads') && request.method === 'POST') return { id: '7000000000000000009' };
      if (/\/\d+\?fields=id,status/.test(url)) return { id: '7000000000000000009', status: 'FINISHED' };
      throw new Error(url);
    },
  });
  const result = await threadsAdapter.execute('create-post', { text: 'devlog' }, context);
  assert.equal(result.unresolved, true);
  assert.equal(result.waitingExternal, true);
  assert.equal(result.summary.containerId, '7000000000000000009');
  assert.equal(publishes, 1);
  assert.ok(checkpoints.some(item => item.containerId === '7000000000000000009'));
});

test('Threads waits for a not-ready container to reach FINISHED before publishing exactly once', async () => {
  let publishes = 0;
  let statusReads = 0;
  const { context, requests, sleeps } = createContext({
    provider: 'threads',
    handler: (url, request) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/threads_publish')) { publishes += 1; return { id: '9000000000000000123' }; }
      if (url.includes('/threads') && request.method === 'POST') return { id: '7000000000000000123' };
      if (/\/\d+\?fields=id,status/.test(url)) {
        statusReads += 1;
        // IN_PROGRESS on the first two reads, then FINISHED.
        return { id: '7000000000000000123', status: statusReads >= 3 ? 'FINISHED' : 'IN_PROGRESS' };
      }
      if (/\/\d+\?fields=id,text/.test(url)) return { id: '9000000000000000123', permalink: 'https://www.threads.net/@harbor/post/z' };
      throw new Error(url);
    },
  });
  const result = await threadsAdapter.execute('create-post', { text: 'devlog #2' }, context);
  assert.equal(statusReads, 3, 'must keep polling status until FINISHED');
  assert.equal(sleeps() >= 2, true, 'must wait between polls via injected sleep');
  assert.equal(publishes, 1, 'must publish exactly once, only after FINISHED');
  assert.equal(result.resources?.[0].externalId, '9000000000000000123');
  // publish happens after the final (FINISHED) status read
  const publishReq = requests.find(item => item.url.includes('/threads_publish'));
  const statusReqs = requests.filter(item => /\/\d+\?fields=id,status/.test(item.url));
  assert.ok(requests.indexOf(statusReqs[statusReqs.length - 1]) < requests.indexOf(publishReq!));
});

test('Threads never publishes when the container status is ERROR (terminal, no repost)', async () => {
  let publishes = 0;
  const { context } = createContext({
    provider: 'threads',
    handler: (url, request) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/threads_publish')) { publishes += 1; return { id: 'should-not-happen' }; }
      if (url.includes('/threads') && request.method === 'POST') return { id: '7000000000000000200' };
      if (/\/\d+\?fields=id,status/.test(url)) return { id: '7000000000000000200', status: 'ERROR', error_message: 'internal provider detail' };
      throw new Error(url);
    },
  });
  const result = await threadsAdapter.execute('create-post', { text: 'devlog' }, context);
  assert.equal(publishes, 0, 'an ERROR container must never be published');
  assert.equal(result.summary.outcome, 'failed');
  assert.equal(result.summary.status, 'ERROR');
  assert.equal(result.summary.errorMessage, undefined, 'raw error_message must never surface');
  assert.equal(result.unresolved, undefined);
});

test('Threads publish readiness poll that never finishes stays unresolved without publishing', async () => {
  let publishes = 0;
  const { context, checkpoints } = createContext({
    provider: 'threads',
    handler: (url, request) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/threads_publish')) { publishes += 1; return { id: 'nope' }; }
      if (url.includes('/threads') && request.method === 'POST') return { id: '7000000000000000300' };
      if (/\/\d+\?fields=id,status/.test(url)) return { id: '7000000000000000300', status: 'IN_PROGRESS' };
      throw new Error(url);
    },
  });
  const result = await threadsAdapter.execute('create-post', { text: 'devlog' }, context);
  assert.equal(publishes, 0, 'must not publish when the container never reaches FINISHED');
  assert.equal(result.unresolved, true);
  assert.equal(result.waitingExternal, true);
  assert.equal(result.summary.containerId, '7000000000000000300');
  assert.ok(checkpoints.some(item => item.stage === 'container_created' && item.containerId === '7000000000000000300'), 'container id checkpointed before the poll');
});

test('Threads publish readiness poll aborts cleanly without publishing', async () => {
  let publishes = 0;
  const controller = new AbortController();
  const { context } = createContext({
    provider: 'threads',
    signal: controller.signal,
    // The injected sleep aborts the job mid-wait, as a real cancellation would.
    sleep: async () => { controller.abort(); },
    handler: (url, request) => {
      if (url.includes('/me')) return { id: '1000000000000001' };
      if (url.includes('/threads_publish')) { publishes += 1; return { id: 'nope' }; }
      if (url.includes('/threads') && request.method === 'POST') return { id: '7000000000000000400' };
      if (/\/\d+\?fields=id,status/.test(url)) return { id: '7000000000000000400', status: 'IN_PROGRESS' };
      throw new Error(url);
    },
  });
  const result = await threadsAdapter.execute('create-post', { text: 'devlog' }, context);
  assert.equal(publishes, 0, 'an aborted readiness wait must never publish');
  assert.equal(result.unresolved, true);
  assert.equal(result.waitingExternal, true);
  assert.equal(result.summary.containerId, '7000000000000000400');
});

test('Threads reconcile maps status to outcome, hides raw error_message, and never publishes', async () => {
  const published = createContext({ provider: 'threads', handler: threadsHandler({ status: { id: '7', status: 'PUBLISHED' } }) });
  const okResult = await threadsAdapter.execute('reconcile', { containerId: '7000000000000000001' }, published.context);
  assert.equal(okResult.summary.status, 'PUBLISHED');
  assert.equal(okResult.summary.outcome, 'confirmed');
  assert.equal(okResult.unresolved, false);
  // never requests error_message, and never publishes
  const reconcileReq = published.requests.find(item => item.url.includes('/7000000000000000001'));
  assert.equal(reconcileReq!.url.includes('error_message'), false);
  assert.equal(okResult.summary.errorMessage, undefined);
  assert.equal(published.requests.some(item => item.url.includes('threads_publish')), false);

  const failed = createContext({ provider: 'threads', handler: threadsHandler({ status: { id: '7', status: 'ERROR', error_message: 'internal detail' } }) });
  const failResult = await threadsAdapter.execute('reconcile', { containerId: '7000000000000000001' }, failed.context);
  assert.equal(failResult.summary.outcome, 'failed');
  assert.equal(failResult.unresolved, false);

  const pending = createContext({ provider: 'threads', handler: threadsHandler({ status: { id: '7', status: 'IN_PROGRESS' } }) });
  const pendingResult = await threadsAdapter.execute('reconcile', { containerId: '7000000000000000001' }, pending.context);
  assert.equal(pendingResult.summary.outcome, 'unknown');
  assert.equal(pendingResult.unresolved, true);
});

test('Threads list-posts is bounded to one page by default', async () => {
  const { context, requests } = createContext({ provider: 'threads', handler: threadsHandler() });
  const result = await threadsAdapter.execute('list-posts', {}, context);
  assert.equal(result.resources?.length, 1);
  assert.equal(requests.filter(item => item.url.includes('/threads') && item.options.method !== 'POST').length, 1);
});

// --- Steam adapter ------------------------------------------------------------

test('Steam list-news reads the public endpoint and normalizes items', async () => {
  const { context, requests } = createContext({
    provider: 'steam',
    accountId: '440',
    handler: () => ({ appnews: { appid: 440, newsitems: [{ gid: 'g1', title: 'Update', url: 'https://store.steampowered.com/news/g1', date: 1_700_000_000, contents: 'notes', feedlabel: 'Community' }] } }),
  });
  const result = await steamNewsAdapter.execute('list-news', { appId: '440', count: 5 }, context);
  assert.equal(result.resources?.[0].kind, 'news');
  assert.equal(result.resources?.[0].externalId, 'g1');
  assert.equal(result.resources?.[0].permalink, 'https://store.steampowered.com/news/g1');
  // the validated app id rides on every resource so a shared connection maps
  // news back to the owning project
  assert.equal(result.resources?.[0].data.appId, '440');
  assert.ok(requests[0].url.startsWith('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/'));
  assert.ok(requests[0].url.includes('appid=440'));
  assert.equal(requests[0].options.method ?? 'GET', 'GET');
});

test('Steam news carries the per-item appId and rejects an app id mismatch', async () => {
  // Per-item appid matches the requested app -> stamped onto data.appId.
  const matching = createContext({
    provider: 'steam', accountId: '620',
    handler: () => ({ appnews: { appid: 620, newsitems: [{ gid: 'p1', title: 'Patch', appid: 620 }] } }),
  });
  const okResult = await steamNewsAdapter.execute('list-news', { appId: '620' }, matching.context);
  assert.equal(okResult.resources?.[0].data.appId, '620');

  // Envelope app id disagrees with the requested app -> reject, don't mislabel.
  const envelopeMismatch = createContext({
    provider: 'steam', accountId: '620',
    handler: () => ({ appnews: { appid: 999, newsitems: [{ gid: 'p1', title: 'Patch' }] } }),
  });
  await expectCode(steamNewsAdapter.execute('list-news', { appId: '620' }, envelopeMismatch.context), 'INVALID_PROVIDER_RESPONSE');

  // A single item belonging to a different app -> reject the batch.
  const itemMismatch = createContext({
    provider: 'steam', accountId: '620',
    handler: () => ({ appnews: { appid: 620, newsitems: [{ gid: 'p1', title: 'Patch', appid: 620 }, { gid: 'p2', title: 'Other', appid: 777 }] } }),
  });
  await expectCode(steamNewsAdapter.execute('list-news', { appId: '620' }, itemMismatch.context), 'INVALID_PROVIDER_RESPONSE');
});

test('Steam publishing is explicitly unsupported (no invented endpoint)', async () => {
  const { context, requests } = createContext({ provider: 'steam', accountId: '440', handler: () => ({}) });
  for (const op of ['publish-news', 'create-announcement', 'create-post', 'reply']) {
    const error = await expectCode(steamNewsAdapter.execute(op, { title: 'x', body: 'y' }, context), 'UNSUPPORTED_OPERATION');
    assert.equal(error.status, 422);
  }
  assert.equal(requests.length, 0, 'no network call is made for an unsupported publish');
});

// --- Transport ----------------------------------------------------------------

test('transport pins origins, forces write classification, and journals before fetch', async () => {
  let journaled = 0;
  let fetched = 0;
  const request = createSocialTransport({
    provider: 'x',
    signal: new AbortController().signal,
    markDispatched: () => { journaled += 1; },
    fetch: async (url) => {
      fetched += 1;
      if (String(url).includes('/tweets')) assert.equal(journaled, 1, 'write must be journalled before the network call');
      return jsonResponse({ data: { id: '1' } });
    },
  });
  // wrong origin is refused before any fetch
  await expectCode(request('https://api.twitter.com/2/tweets', { method: 'POST', write: true }), 'INVALID_PROVIDER_URL');
  // unclassified mutation is refused
  await expectCode(request('https://api.x.com/2/tweets', { method: 'POST' }), 'EFFECT_CLASSIFICATION_REQUIRED');
  // a read classified as write is refused pre-network only for non-GET; GET is fine
  await request('https://api.x.com/2/users/me');
  assert.equal(fetched, 1);
  // a classified write journals then fetches
  await request('https://api.x.com/2/tweets', { method: 'POST', write: true, json: { text: 'hi' } });
  assert.equal(journaled, 1);
  assert.equal(fetched, 2);
});

test('transport maps auth/permission/temporary failures to stable codes without leaking bodies', async () => {
  const make = (status: number) => createSocialTransport({
    provider: 'threads', signal: new AbortController().signal, markDispatched: () => undefined,
    fetch: async () => new Response('secret token abc', { status }),
  });
  await expectCode(make(401)('https://graph.threads.net/v1.0/me'), 'AUTH_REQUIRED');
  await expectCode(make(403)('https://graph.threads.net/v1.0/me'), 'PERMISSION_REQUIRED');
  await expectCode(make(500)('https://graph.threads.net/v1.0/me'), 'TEMPORARY');
  await expectCode(make(404)('https://graph.threads.net/v1.0/me'), 'RESOURCE_NOT_FOUND');
});

// --- Token manager: refresh + rotation ---------------------------------------

function memoryStore(seed: Record<string, Record<string, string>>) {
  const data = new Map<string, Record<string, string>>(Object.entries(seed));
  return {
    store: {
      get: async (id: string) => ({ ...(data.get(id) ?? {}) }),
      set: async (id: string, value: Record<string, string>) => { data.set(id, { ...value }); },
    },
    read: (id: string) => data.get(id) ?? {},
  };
}

test('X token refresh rotates and persists the new refresh token, then caches the access token', async () => {
  const { store, read } = memoryStore({ 'conn-x': { clientId: 'cid', refreshToken: 'r1' } });
  let calls = 0;
  const manager = new SocialTokenManager(store, {
    fetch: async (url) => {
      calls += 1;
      assert.equal(String(url), 'https://api.x.com/2/oauth2/token');
      return jsonResponse({ access_token: 'a1', refresh_token: 'r2', expires_in: 7200, scope: 'tweet.read' });
    },
  });
  const token = await manager.getAccessToken({ id: 'conn-x', provider: 'x' });
  assert.equal(token, 'a1');
  assert.equal(read('conn-x').refreshToken, 'r2', 'rotated refresh token must be persisted');
  // second call is served from cache (no new network exchange)
  const again = await manager.getAccessToken({ id: 'conn-x', provider: 'x' });
  assert.equal(again, 'a1');
  assert.equal(calls, 1);
});

test('X token refresh failure (invalid_grant) surfaces AUTH_REQUIRED and keeps the old token', async () => {
  const { store, read } = memoryStore({ 'conn-x': { clientId: 'cid', refreshToken: 'r1' } });
  const manager = new SocialTokenManager(store, { fetch: async () => new Response('{"error":"invalid_grant"}', { status: 400 }) });
  await expectCode(manager.getAccessToken({ id: 'conn-x', provider: 'x' }), 'AUTH_REQUIRED');
  assert.equal(read('conn-x').refreshToken, 'r1', 'a failed rotation must not clobber the stored token');
});

test('X token refresh is serialized per connection (single exchange under concurrency)', async () => {
  const { store } = memoryStore({ 'conn-x': { clientId: 'cid', refreshToken: 'r1' } });
  let calls = 0;
  const manager = new SocialTokenManager(store, {
    fetch: async () => { calls += 1; return jsonResponse({ access_token: 'a1', refresh_token: 'r2', expires_in: 7200 }); },
  });
  const [a, b] = await Promise.all([
    manager.getAccessToken({ id: 'conn-x', provider: 'x' }),
    manager.getAccessToken({ id: 'conn-x', provider: 'x' }),
  ]);
  assert.equal(a, 'a1');
  assert.equal(b, 'a1');
  assert.equal(calls, 1, 'overlapping requests must not trigger two rotations');
});

test('X invalidate() forces a refresh even when the stored access token is unexpired; reset() restores trust', async () => {
  const future = Date.now() + 3600_000;
  const { store, read } = memoryStore({ 'conn-x': { clientId: 'cid', refreshToken: 'r1', accessToken: 'stored', accessTokenExpiresAt: String(future) } });
  let calls = 0;
  const manager = new SocialTokenManager(store, {
    fetch: async () => { calls += 1; return jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 7200 }); },
  });
  // unexpired stored token is used as-is
  assert.equal(await manager.getAccessToken({ id: 'conn-x', provider: 'x' }), 'stored');
  assert.equal(calls, 0);
  // a 401 invalidation forces a refresh despite the unexpired stored token
  manager.invalidate('conn-x');
  assert.equal(await manager.getAccessToken({ id: 'conn-x', provider: 'x' }), 'a2');
  assert.equal(calls, 1);
  assert.equal(read('conn-x').refreshToken, 'r2');
  // reset() clears the forced flag so a freshly stored token is trusted again
  await store.set('conn-x', { clientId: 'cid', refreshToken: 'r2', accessToken: 'replaced', accessTokenExpiresAt: String(future) });
  manager.invalidate('conn-x');
  manager.reset('conn-x');
  assert.equal(await manager.getAccessToken({ id: 'conn-x', provider: 'x' }), 'replaced');
  assert.equal(calls, 1, 'reset must not trigger a network refresh');
});

test('Threads forced refresh respects the 24h minimum: too-new token requires reconnect', async () => {
  const now = Date.now();
  // token only 1h old -> cannot refresh; forced (401) must escalate to reconnect
  const tooNew = memoryStore({ 'c': { accessToken: 't1', tokenObtainedAt: String(now - 3600_000), tokenExpiresAt: String(now + 60 * 24 * 3600 * 1000) } });
  let calls = 0;
  const tooNewManager = new SocialTokenManager(tooNew.store, { now: () => now, fetch: async () => { calls += 1; return jsonResponse({ access_token: 'x' }); } });
  tooNewManager.invalidate('c');
  await expectCode(tooNewManager.getAccessToken({ id: 'c', provider: 'threads' }), 'AUTH_REQUIRED');
  assert.equal(calls, 0, 'the 24h minimum must be respected — no refresh call for a too-new token');

  // token 2 days old and NOT near expiry -> normally not refreshed, but forced triggers a refresh
  const aged = memoryStore({ 'c': { accessToken: 't1', tokenObtainedAt: String(now - 2 * 24 * 3600 * 1000), tokenExpiresAt: String(now + 40 * 24 * 3600 * 1000) } });
  const agedManager = new SocialTokenManager(aged.store, { now: () => now, fetch: async () => jsonResponse({ access_token: 't2', expires_in: 60 * 24 * 3600 }) });
  agedManager.invalidate('c');
  assert.equal(await agedManager.getAccessToken({ id: 'c', provider: 'threads' }), 't2');
  assert.equal(aged.read('c').accessToken, 't2');
});

test('Threads long-lived token refreshes only when old-enough and near expiry, and persists rotation', async () => {
  const now = Date.now();
  const fresh = memoryStore({ 'c': { accessToken: 't1', tokenObtainedAt: String(now), tokenExpiresAt: String(now + 60 * 24 * 3600 * 1000) } });
  let freshCalls = 0;
  const freshManager = new SocialTokenManager(fresh.store, { now: () => now, fetch: async () => { freshCalls += 1; return jsonResponse({ access_token: 'nope' }); } });
  assert.equal(await freshManager.getAccessToken({ id: 'c', provider: 'threads' }), 't1');
  assert.equal(freshCalls, 0, 'a fresh token must not be refreshed');

  const aging = memoryStore({ 'c': { accessToken: 't1', tokenObtainedAt: String(now - 2 * 24 * 3600 * 1000), tokenExpiresAt: String(now + 3 * 24 * 3600 * 1000) } });
  const agingManager = new SocialTokenManager(aging.store, {
    now: () => now,
    fetch: async (url) => { assert.equal(String(url).split('?')[0], 'https://graph.threads.net/refresh_access_token'); return jsonResponse({ access_token: 't2', expires_in: 60 * 24 * 3600 }); },
  });
  assert.equal(await agingManager.getAccessToken({ id: 'c', provider: 'threads' }), 't2');
  assert.equal(aging.read('c').accessToken, 't2');
});

test('Threads expired long-lived token cannot refresh and requires reconnect', async () => {
  const now = Date.now();
  const { store } = memoryStore({ 'c': { accessToken: 't1', tokenObtainedAt: String(now - 61 * 24 * 3600 * 1000), tokenExpiresAt: String(now - 1000) } });
  const manager = new SocialTokenManager(store, { now: () => now, fetch: async () => jsonResponse({}) });
  await expectCode(manager.getAccessToken({ id: 'c', provider: 'threads' }), 'AUTH_REQUIRED');
});

// --- OAuth brokers ------------------------------------------------------------

test('X OAuth broker issues a PKCE S256 challenge and completes to rotation credentials', async () => {
  const broker = new XOAuthBroker({
    fetch: async (url) => {
      if (String(url).includes('oauth2/token')) return jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 7200, scope: 'tweet.read offline.access' });
      if (String(url).includes('users/me')) return jsonResponse({ data: { id: '42', username: 'harbor' } });
      throw new Error(String(url));
    },
  });
  const begin = broker.begin({ clientId: 'cid', redirectUri: 'https://app.example.com/callback', scopes: ['tweet.read', 'tweet.write', 'offline.access'] });
  const authUrl = new URL(begin.authorizationUrl);
  assert.equal(authUrl.origin + authUrl.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok((authUrl.searchParams.get('code_challenge') ?? '').length > 20);
  assert.equal(authUrl.searchParams.get('state'), begin.state);
  const creds = await broker.complete({ state: begin.state, code: 'auth-code' });
  assert.equal(creds.refreshToken, 'r');
  assert.equal(creds.userId, '42');
  assert.equal(creds.clientId, 'cid');
});

test('X OAuth state is single-use and expires', async () => {
  let clock = 1_000;
  const broker = new XOAuthBroker({
    now: () => clock,
    fetch: async (url) => (String(url).includes('users/me') ? jsonResponse({ data: { id: '1' } }) : jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 7200 })),
  });
  const begin = broker.begin({ clientId: 'cid', redirectUri: 'https://app.example.com/cb' });
  await broker.complete({ state: begin.state, code: 'c1' });
  await expectCode(broker.complete({ state: begin.state, code: 'c1' }), 'OAUTH_STATE_INVALID');
  const second = broker.begin({ clientId: 'cid', redirectUri: 'https://app.example.com/cb' });
  clock += 20 * 60 * 1000; // advance beyond the 10-minute TTL
  await expectCode(broker.complete({ state: second.state, code: 'c2' }), 'OAUTH_STATE_EXPIRED');
});

test('X OAuth rejects a token exchange that returns no refresh token', async () => {
  const broker = new XOAuthBroker({ fetch: async () => jsonResponse({ access_token: 'a', expires_in: 7200 }) });
  const begin = broker.begin({ clientId: 'cid', redirectUri: 'https://app.example.com/cb' });
  await expectCode(broker.complete({ state: begin.state, code: 'c' }), 'OAUTH_EXCHANGE_INCOMPLETE');
});

test('X OAuth rejects a non-https, non-loopback redirect', () => {
  const broker = new XOAuthBroker({ fetch: async () => jsonResponse({}) });
  assert.throws(() => broker.begin({ clientId: 'cid', redirectUri: 'http://example.com/cb' }), (e: unknown) => e instanceof AppError && e.code === 'INVALID_REDIRECT_URI');
});

test('Threads OAuth requires a client secret and completes to a long-lived token', async () => {
  const broker = new ThreadsOAuthBroker({
    fetch: async (url) => {
      const href = String(url);
      if (href.startsWith('https://graph.threads.com/oauth/access_token')) return jsonResponse({ access_token: 'short', user_id: '777' });
      if (href.split('?')[0] === 'https://graph.threads.net/access_token') return jsonResponse({ access_token: 'long', token_type: 'bearer', expires_in: 60 * 24 * 3600 });
      throw new Error(href);
    },
  });
  assert.throws(() => broker.begin({ clientId: 'cid', redirectUri: 'https://app.example.com/cb' }), (e: unknown) => e instanceof AppError && e.code === 'INVALID_OAUTH_INPUT');
  const begin = broker.begin({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://app.example.com/cb' });
  assert.ok(begin.authorizationUrl.startsWith('https://threads.com/oauth/authorize'));
  const creds = await broker.complete({ state: begin.state, code: 'code' });
  assert.equal(creds.threadsUserId, '777');
  assert.equal(creds.accessToken, 'long');
  assert.equal(creds.clientId, 'cid', 'clientId is preserved for later token repair');
  assert.ok(Number(creds.tokenExpiresAt) > Date.now());
});
