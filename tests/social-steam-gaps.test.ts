import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppError } from '../packages/domain/errors.js';
import type { Connection } from '../packages/domain/index.js';
import { xAdapter } from '../packages/social/x.js';
import { XOAuthBroker, X_DEFAULT_SCOPES } from '../packages/social/oauth.js';
import type { SocialArtifact, SocialContext, SocialRequest } from '../packages/social/types.js';
import { xConnector } from '../packages/connectors/social.js';
import { steamConnector } from '../packages/connectors/steam.js';
import type { ConnectorContext, ProviderRequest } from '../packages/connectors/types.js';

const ACCOUNT = '1000000000000001';
const MEDIA_ID = '1900000000000000001';
const POST_ID = '1800000000000000001';

interface Recorded { url: string; options: SocialRequest }

async function mediaFile(name: string, bytes: Buffer): Promise<SocialArtifact> {
  const dir = await mkdtemp(join(tmpdir(), 'x-media-'));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return { path, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'file' };
}

function png(size: number): Buffer {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return bytes;
}

function mp4(size: number): Buffer {
  const bytes = Buffer.alloc(size, 3);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftypisom', 4, 'ascii');
  return bytes;
}

function xContext(options: { artifact?: SocialArtifact; handler: (url: string, request: SocialRequest) => unknown }) {
  const requests: Recorded[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  let sleeps = 0;
  const context: SocialContext = {
    connection: { id: 'conn-x', provider: 'x', accountId: ACCOUNT },
    credentials: {},
    project: { appIdentifier: 'com.harbor.game' },
    signal: new AbortController().signal,
    artifact: options.artifact,
    markDispatched: () => undefined,
    checkpoint: data => { checkpoints.push({ ...data }); events.push(`checkpoint:${String(data.stage ?? data.operation)}`); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'token',
    request: async <T>(url: string, request: SocialRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      events.push(`${request.method ?? 'GET'} ${new URL(url).pathname}`);
      return options.handler(url, request) as T;
    },
    progress: () => undefined,
    sleep: async () => { sleeps += 1; },
  };
  return { context, requests, checkpoints, events, sleeps: () => sleeps };
}

function baseHandler(url: string, request: SocialRequest): unknown {
  if (url.includes('/users/me')) return { data: { id: ACCOUNT, username: 'harbor' } };
  if (url.endsWith('/2/tweets') && request.method === 'POST') return { data: { id: POST_ID, text: 'posted' } };
  throw new Error(`unexpected ${request.method ?? 'GET'} ${url}`);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}`);
}

// --- X media -----------------------------------------------------------------

test('X image uses one-shot media upload before the post and attaches media.media_ids', async () => {
  const artifact = await mediaFile('shot.png', png(2048));
  const { context, requests, checkpoints, events } = xContext({
    artifact,
    handler: (url, request) => url.endsWith('/2/media/upload') && request.method === 'POST'
      ? { data: { id: MEDIA_ID, media_key: `3_${MEDIA_ID}`, size: 2048 } } : baseHandler(url, request),
  });
  const result = await xAdapter.execute('create-post', { text: 'Harbor screenshot', mediaAssetId: 'asset-1' }, context);

  const upload = requests.find(item => item.url === 'https://api.x.com/2/media/upload');
  assert.ok(upload);
  assert.equal(upload!.options.write, true);
  const form = upload!.options.body as FormData;
  assert.equal(form.get('media_category'), 'tweet_image');
  assert.equal((form.get('media') as Blob).size, 2048);
  assert.equal(form.get('media_type'), null, 'one-shot schema has no media_type field');
  const post = requests.find(item => item.url.endsWith('/2/tweets'));
  assert.deepEqual(post!.options.json, { text: 'Harbor screenshot', media: { media_ids: [MEDIA_ID] } });
  // media is journalled as a write and its id checkpointed before the post leaves.
  assert.ok(events.indexOf('checkpoint:media-upload') < events.indexOf('POST /2/media/upload'));
  assert.ok(events.indexOf('checkpoint:media-uploaded') < events.indexOf('POST /2/tweets'));
  assert.equal(checkpoints.find(item => item.stage === 'media-uploaded')?.mediaId, MEDIA_ID);
  assert.equal(result.summary.mediaId, MEDIA_ID);
  assert.equal(result.resources?.[0].externalId, POST_ID);
});

test('X video uses chunked initialize/append/finalize and waits on STATUS before posting', async () => {
  const size = 4 * 1024 * 1024 + 100;
  const artifact = await mediaFile('clip.mp4', mp4(size));
  const statuses = ['in_progress', 'succeeded'];
  const { context, requests, events, sleeps } = xContext({
    artifact,
    handler: (url, request) => {
      if (url.endsWith('/media/upload/initialize')) return { data: { id: MEDIA_ID, media_key: `7_${MEDIA_ID}`, expires_after_secs: 86400 } };
      if (url.endsWith(`/media/upload/${MEDIA_ID}/append`)) return {};
      if (url.endsWith(`/media/upload/${MEDIA_ID}/finalize`)) return { data: { id: MEDIA_ID, processing_info: { state: 'pending', check_after_secs: 1 } } };
      if (url.includes('/media/upload?command=STATUS')) return { data: { id: MEDIA_ID, processing_info: { state: statuses.shift(), check_after_secs: 2 } } };
      return baseHandler(url, request);
    },
  });
  const result = await xAdapter.execute('create-post', { text: 'trailer', mediaAssetId: 'asset-2' }, context);

  const init = requests.find(item => item.url.endsWith('/initialize'));
  assert.deepEqual(init!.options.json, { media_type: 'video/mp4', total_bytes: size, media_category: 'tweet_video' });
  const appends = requests.filter(item => item.url.endsWith('/append'));
  assert.deepEqual(appends.map(item => (item.options.body as FormData).get('segment_index')), ['0', '1']);
  assert.deepEqual(appends.map(item => ((item.options.body as FormData).get('media') as Blob).size), [4 * 1024 * 1024, 100]);
  assert.ok(requests.filter(item => item.options.method === 'POST').every(item => item.options.write === true));
  const status = requests.filter(item => item.url.includes('command=STATUS'));
  assert.equal(status.length, 2);
  assert.ok(status[0]!.url.includes(`media_id=${MEDIA_ID}`));
  assert.equal(sleeps(), 2);
  assert.ok(events.indexOf(`POST /2/media/upload/${MEDIA_ID}/finalize`) < events.indexOf('POST /2/tweets'));
  const post = requests.find(item => item.url.endsWith('/2/tweets'));
  assert.deepEqual((post!.options.json as { media: unknown }).media, { media_ids: [MEDIA_ID] });
  assert.equal(result.summary.mediaId, MEDIA_ID);
});

test('X failed media processing stops before any post', async () => {
  const artifact = await mediaFile('clip.mp4', mp4(1000));
  const { context, requests } = xContext({
    artifact,
    handler: (url, request) => {
      if (url.endsWith('/initialize')) return { data: { id: MEDIA_ID } };
      if (url.endsWith('/append')) return {};
      if (url.endsWith('/finalize')) return { data: { id: MEDIA_ID, processing_info: { state: 'failed' } } };
      return baseHandler(url, request);
    },
  });
  const result = await xAdapter.execute('create-post', { text: 'trailer', mediaAssetId: 'a' }, context);
  assert.equal(result.summary.outcome, 'failed');
  assert.equal(result.unresolved, undefined);
  assert.equal(requests.some(item => item.url.endsWith('/2/tweets')), false);
});

test('X lost post response keeps the checkpointed media id and a retry reuses it without re-uploading', async () => {
  const artifact = await mediaFile('shot.png', png(512));
  let uploads = 0;
  const first = xContext({
    artifact,
    handler: (url, request) => {
      if (url.endsWith('/2/media/upload')) { uploads += 1; return { data: { id: MEDIA_ID } }; }
      if (url.endsWith('/2/tweets')) throw new AppError('TEMPORARY', 'timeout', 503);
      return baseHandler(url, request);
    },
  });
  const lost = await xAdapter.execute('create-post', { text: 'maybe posted', mediaAssetId: 'asset-1' }, first.context);
  assert.equal(lost.unresolved, true);
  assert.equal(lost.summary.mediaId, MEDIA_ID);
  assert.equal(first.checkpoints.find(item => item.stage === 'media-uploaded')?.mediaId, MEDIA_ID);
  assert.equal(uploads, 1);
  assert.equal(first.requests.filter(item => item.url.endsWith('/2/tweets')).length, 1, 'no automatic repost');

  // Retry after reconciliation: the checkpointed id is supplied, bytes are not sent again.
  const retry = xContext({ artifact, handler: baseHandler });
  const result = await xAdapter.execute('reply', { text: 'retry', replyToId: '1700000000000000002', mediaAssetId: 'asset-1', mediaId: MEDIA_ID }, retry.context);
  assert.equal(retry.requests.some(item => item.url.includes('/media/upload')), false);
  const post = retry.requests.find(item => item.url.endsWith('/2/tweets'));
  assert.deepEqual(post!.options.json, { text: 'retry', reply: { in_reply_to_tweet_id: '1700000000000000002' }, media: { media_ids: [MEDIA_ID] } });
  assert.equal(result.summary.mediaId, MEDIA_ID);
  await expectCode(xAdapter.execute('create-post', { text: 'x', mediaId: 'abc' }, xContext({ handler: baseHandler }).context), 'INVALID_INPUT');
});

test('X ambiguous chunk upload stays unresolved and does not post', async () => {
  const artifact = await mediaFile('anim.gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 1)]));
  const { context, requests } = xContext({
    artifact,
    handler: (url, request) => {
      if (url.endsWith('/initialize')) return { data: { id: MEDIA_ID } };
      if (url.endsWith('/append')) throw new AppError('TEMPORARY', 'timeout', 503);
      return baseHandler(url, request);
    },
  });
  const result = await xAdapter.execute('create-post', { text: 'gif', mediaAssetId: 'a' }, context);
  assert.equal(result.unresolved, true);
  assert.equal(result.summary.initializedMediaId, MEDIA_ID);
  assert.equal(result.summary.mediaId, undefined, 'an unfinalized upload is not offered for reuse');
  assert.equal((requests.find(item => item.url.endsWith('/initialize'))!.options.json as Record<string, unknown>).media_category, 'tweet_gif');
  assert.equal(requests.some(item => item.url.endsWith('/finalize') || item.url.endsWith('/2/tweets')), false);
});

test('X media rejects oversized, unsupported, changed, or missing files before any write', async () => {
  const cases: Array<[SocialArtifact | undefined, string]> = [
    [await mediaFile('big.png', png(5_000_001)), 'INVALID_INPUT'],
    [await mediaFile('notes.txt', Buffer.from('plain text is not media')), 'INVALID_INPUT'],
    [{ ...(await mediaFile('shot.png', png(64))), sha256: '0'.repeat(64) }, 'MEDIA_CHANGED'],
    [undefined, 'ARTIFACT_REQUIRED'],
  ];
  for (const [artifact, code] of cases) {
    const { context, requests } = xContext({ artifact, handler: baseHandler });
    await expectCode(xAdapter.execute('create-post', { text: 'x', mediaAssetId: 'a' }, context), code);
    assert.equal(requests.some(item => item.options.write), false, `${code}: no external write`);
  }
});

test('X connector bridge passes the controller artifact through to reply media upload', async () => {
  const artifact = await mediaFile('shot.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]));
  const requests: Array<{ url: string; options: ProviderRequest }> = [];
  const now = new Date().toISOString();
  const connection = { id: 'conn-x', provider: 'x', label: 'x', accountId: ACCOUNT, status: 'connected', createdAt: now, updatedAt: now,
    lastCheckedAt: null, lastError: null, authKind: 'oauth2-pkce', credentialFields: [] } as unknown as Connection;
  const context = {
    connection, credentials: {}, project: { appIdentifier: 'com.harbor.game' }, signal: new AbortController().signal, artifact, workDirectory: tmpdir(),
    markDispatched: () => undefined, checkpoint: () => undefined, saveCredentials: async () => undefined, accessToken: async () => 'token', progress: () => undefined,
    request: async <T>(url: string, options: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, options });
      return (url.endsWith('/2/media/upload') ? { data: { id: MEDIA_ID } } : baseHandler(url, options as SocialRequest)) as T;
    },
  } as unknown as ConnectorContext;
  const result = await xConnector.execute('reply', { text: 'thanks', replyToId: '1700000000000000002', mediaAssetId: 'asset-1' }, context);
  assert.equal(result.resources?.[0]?.externalId, POST_ID);
  assert.equal(((requests.find(item => item.url.endsWith('/2/media/upload'))!.options.body as FormData).get('media') as Blob).size, 104);
  assert.ok(xConnector.capability.operationFields?.reply?.some(field => field.key === 'mediaAssetId'));
});

test('X OAuth requests media.write by default', () => {
  assert.ok(X_DEFAULT_SCOPES.includes('media.write'));
  assert.ok(xAdapter.capability.scopes.includes('media.write'));
  const begun = new XOAuthBroker().begin({ clientId: 'cid', redirectUri: 'https://app.example.com/callback' });
  assert.ok(new URL(begun.authorizationUrl).searchParams.get('scope')!.split(' ').includes('media.write'));
});

// --- Steam financial corrections --------------------------------------------

function steamContext(credentials: Record<string, string>, handler: (url: URL) => unknown) {
  const requests: URL[] = [];
  const saved: Array<Record<string, string>> = [];
  const now = new Date().toISOString();
  const context: ConnectorContext = {
    connection: { id: 'conn-s', provider: 'steam', label: 's', accountId: 'a', status: 'connected', createdAt: now, updatedAt: now,
      lastCheckedAt: null, lastError: null, authKind: 't', credentialFields: [] },
    credentials: { financialApiKey: 'FINKEY', ...credentials },
    signal: new AbortController().signal,
    workDirectory: tmpdir(),
    markDispatched: () => undefined,
    checkpoint: () => undefined,
    saveCredentials: async value => { saved.push(value); },
    accessToken: async () => '',
    request: async <T>(url: string): Promise<T> => { const parsed = new URL(url); requests.push(parsed); return handler(parsed) as T; },
    progress: () => undefined,
  };
  return { context, requests, saved };
}

function steamHandler(changed: { dates: string[]; hwm: string }, sales: Record<string, Array<Record<string, unknown>>> = {}) {
  return (url: URL): unknown => {
    if (url.pathname.endsWith('/GetChangedDatesForPartner/v001/')) return { response: { dates: changed.dates, result_highwatermark: changed.hwm } };
    if (url.pathname.endsWith('/GetDetailedSales/v001/')) {
      const rows = url.searchParams.get('highwatermark_id') === '0' ? sales[url.searchParams.get('date')!] ?? [] : [];
      return { response: { results: rows, max_id: rows.length ? 10 : 0 } };
    }
    throw new Error(url.toString());
  };
}

const detailedDates = (requests: URL[]) => requests.filter(url => url.pathname.endsWith('/GetDetailedSales/v001/')).map(url => url.searchParams.get('date'));

test('Steam first sync only establishes the changed-dates baseline and keeps the recent window', async () => {
  const { context, requests, saved } = steamContext({}, steamHandler({ dates: ['2019/01/01', '2020/02/02'], hwm: '500' }));
  const result = await steamConnector.execute('sync', {}, context);
  const changed = requests.find(url => url.pathname.endsWith('/GetChangedDatesForPartner/v001/'))!;
  assert.equal(changed.searchParams.get('highwatermark'), '0');
  assert.equal(changed.searchParams.get('key'), 'FINKEY');
  assert.equal(detailedDates(requests).length, 7, 'history is not back-filled on the baseline call');
  assert.equal(result.metricSourcePrefixes, undefined);
  assert.equal(result.summary.financialBaseline, true);
  assert.equal(saved.at(-1)?.steamFinancialHighwatermark, '500');
  assert.equal(saved.at(-1)?.steamFinancialPendingDates, '[]');
});

test('Steam changed dates are re-fetched from highwatermark_id 0 and replace that date through source prefixes', async () => {
  const { context, requests, saved } = steamContext({ steamFinancialHighwatermark: '500' }, steamHandler(
    { dates: ['2025/05/04', '2025/05/03'], hwm: '900' },
    { '2025-05-04': [{ appid: 480, net_sales_usd: '8.0000', gross_sales_usd: '9.0000', gross_returns_usd: '1.0000' }] },
  ));
  const result = await steamConnector.execute('sync', {}, context);
  assert.equal(requests[0]!.searchParams.get('highwatermark'), '500');
  assert.ok(detailedDates(requests).includes('2025-05-04'));
  assert.ok(detailedDates(requests).includes('2025-05-03'));
  assert.deepEqual(result.metricSourcePrefixes, ['steam:detailed-sales:2025-05-04', 'steam:detailed-sales:2025-05-03']);
  const corrected = result.metrics!.find(metric => metric.date === '2025-05-04')!;
  assert.equal(corrected.amountMicros, '8000000');
  assert.equal(corrected.sourceId, 'steam:detailed-sales:2025-05-04');
  // A corrected date whose rows disappeared becomes an explicit zero, not a stale value.
  assert.equal(result.metrics!.find(metric => metric.date === '2025-05-03')?.amountMicros, '0');
  assert.equal(saved.at(-1)?.steamFinancialHighwatermark, '900');
  assert.equal(saved.at(-1)?.financialApiKey, 'FINKEY', 'existing credentials are preserved');
  assert.deepEqual(result.summary.correctedDates, ['2025-05-04', '2025-05-03']);
});

test('Steam without changed dates keeps the existing recent-window sync and does not touch the cursor', async () => {
  const { context, requests, saved } = steamContext({ steamFinancialHighwatermark: '900', steamFinancialPendingDates: '[]' }, steamHandler({ dates: [], hwm: '900' }));
  const result = await steamConnector.execute('sync', {}, context);
  assert.equal(detailedDates(requests).length, 7);
  assert.equal(result.metricSourcePrefixes, undefined);
  assert.equal(saved.length, 0);
});

test('Steam does not advance the highwatermark when a changed date cannot be read', async () => {
  const handler = steamHandler({ dates: ['2025/05/04'], hwm: '900' });
  const { context, saved } = steamContext({ steamFinancialHighwatermark: '500' }, url => {
    if (url.searchParams.get('date') === '2025-05-04') throw new AppError('TEMPORARY', 'down', 503);
    return handler(url);
  });
  await expectCode(steamConnector.execute('sync', {}, context), 'TEMPORARY');
  assert.equal(saved.length, 0);
});

test('Steam bounds corrections per sync and queues the rest without losing them', async () => {
  const dates = Array.from({ length: 40 }, (_, index) => `2024/01/${String(index % 28 + 1).padStart(2, '0')}`)
    .map((date, index) => index < 28 ? date : date.replace('2024/01', '2024/02'));
  const first = steamContext({ steamFinancialHighwatermark: '1' }, steamHandler({ dates, hwm: '2' }));
  const result = await steamConnector.execute('sync', {}, first.context);
  assert.equal(result.metricSourcePrefixes?.length, 31);
  assert.equal(result.summary.pendingCorrectedDates, 9);
  const pending = JSON.parse(first.saved.at(-1)!.steamFinancialPendingDates!) as string[];
  assert.equal(pending.length, 9);
  assert.equal(first.saved.at(-1)?.steamFinancialHighwatermark, '2');

  const second = steamContext(first.saved.at(-1)!, steamHandler({ dates: [], hwm: '2' }));
  const next = await steamConnector.execute('sync', {}, second.context);
  assert.deepEqual(next.metricSourcePrefixes, pending.map(date => `steam:detailed-sales:${date}`));
  assert.equal(second.saved.at(-1)?.steamFinancialPendingDates, '[]');
});
