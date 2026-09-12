import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AppError } from '../packages/domain/errors.js';
import { DEFAULT_POLICY, type Connection, type Project } from '../packages/domain/index.js';
import { appStoreConnector } from '../packages/connectors/app-store.js';
import { reconcileAppleReview } from '../packages/connectors/store-apple-ops.js';
import { googlePlayConnector } from '../packages/connectors/google-play.js';
import { steamConnector } from '../packages/connectors/steam.js';
import type { Connector, ConnectorContext, ProviderRequest, VerifiedArtifact } from '../packages/connectors/types.js';

interface RecordedRequest { url: string; options: ProviderRequest }

async function createContext(options: {
  provider: 'google-play' | 'app-store' | 'steam';
  credentials?: Record<string, string>;
  appIdentifier?: string;
  artifact?: VerifiedArtifact;
  handler?: (url: string, request: ProviderRequest) => unknown;
}): Promise<{
  context: ConnectorContext;
  requests: RecordedRequest[];
  checkpoints: Array<Record<string, unknown>>;
  dispatchedCount: () => number;
}> {
  const workDirectory = await mkdtemp(join(tmpdir(), 'store-ext-'));
  const requests: RecordedRequest[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  let dispatched = 0;
  const now = new Date().toISOString();
  const connection: Connection = {
    id: 'conn-1', provider: options.provider, label: 'test', accountId: 'acct-1', status: 'connected',
    createdAt: now, updatedAt: now, lastCheckedAt: null, lastError: null, authKind: 'test', credentialFields: [],
  };
  const project: Project | undefined = options.appIdentifier === undefined ? undefined : {
    id: 'proj-1', createdAt: now, updatedAt: now, policy: DEFAULT_POLICY,
    rootPath: workDirectory, name: 'demo', engine: 'unknown', engineVersion: null,
    appIdentifier: options.appIdentifier, targets: [], findings: [], inspectedAt: now,
  };
  const context: ConnectorContext = {
    connection,
    credentials: { ...(options.credentials ?? {}) },
    project,
    signal: new AbortController().signal,
    artifact: options.artifact,
    workDirectory,
    markDispatched: () => { dispatched += 1; },
    checkpoint: data => { checkpoints.push({ ...data }); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'test-token',
    request: async <T>(url: string, request: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      if (request.write) dispatched += 1;
      if (!options.handler) throw new Error(`unexpected request: ${url}`);
      return (await options.handler(url, request)) as T;
    },
    progress: () => undefined,
  };
  return { context, requests, checkpoints, dispatchedCount: () => dispatched };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  throw new Error(`expected AppError ${code}, nothing thrown`);
}

function jsonBody(request: RecordedRequest): Record<string, unknown> {
  return (request.options.json ?? {}) as Record<string, unknown>;
}

const appleApp = { data: [{ id: 'app-99', type: 'apps', attributes: { name: 'Demo', bundleId: 'com.example.demo', sku: 'DEMO1' } }] };
const otherAppId = 'app-other';

function appleAppLink(appId = 'app-99') {
  return { data: { type: 'apps', id: appId } };
}

function appleVersionDoc(id: string, appId = 'app-99', attributes: Record<string, unknown> = {}) {
  return {
    data: {
      id,
      type: 'appStoreVersions',
      attributes: { versionString: '1.2.0', platform: 'IOS', ...attributes },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
    included: [{ id: appId, type: 'apps', attributes: { name: 'Demo', bundleId: appId === 'app-99' ? 'com.example.demo' : 'com.other.app' } }],
  };
}

function appleLocalizationDoc(id: string, versionId: string, locale: string) {
  return {
    data: {
      id,
      type: 'appStoreVersionLocalizations',
      attributes: { locale, description: '설명', whatsNew: '새 기능' },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
    },
    included: [{ id: versionId, type: 'appStoreVersions', attributes: { versionString: '1.2.0' } }],
  };
}

function appleAppInfoLocalizationDoc(id: string, appInfoId: string, locale: string) {
  return {
    data: {
      id,
      type: 'appInfoLocalizations',
      attributes: { locale, name: 'Demo' },
      relationships: { appInfo: { data: { type: 'appInfos', id: appInfoId } } },
    },
    included: [{ id: appInfoId, type: 'appInfos' }],
  };
}

function appleReviewDoc(id: string, appId: string, state: string) {
  return {
    data: {
      id,
      type: 'reviewSubmissions',
      attributes: { state, platform: 'IOS' },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
    included: [{ id: appId, type: 'apps', attributes: { bundleId: appId === 'app-99' ? 'com.example.demo' : 'com.other.app' } }],
  };
}

const appleCredentials = { keyId: 'K', issuerId: 'I', privateKey: 'P' };

// ---------------------------------------------------------------------------
// Google Play listings, images, staged rollout, new-app gate
// ---------------------------------------------------------------------------

test('Play list-listings uses a discarded edit and never commits', async () => {
  const { context, requests, checkpoints } = await createContext({
    provider: 'google-play',
    appIdentifier: 'com.example.demo',
    handler: (url, request) => {
      if (url.endsWith('/edits') && request.method === 'POST') return { id: 'edit-1' };
      if (url.endsWith('/edits/edit-1/listings')) {
        return { listings: [{ language: 'en-US', title: 'Demo', shortDescription: 'short', fullDescription: 'full', video: '' }] };
      }
      if (url.includes('/listings/en-US/')) return { images: [{ id: 'img-1', url: 'https://lh3.googleusercontent.com/x', sha256: 'abc' }] };
      if (url.endsWith('/edits/edit-1') && request.method === 'DELETE') return {};
      throw new Error(url);
    },
  });
  const result = await googlePlayConnector.execute('list-listings', {}, context);
  assert.equal(result.resources?.length, 1);
  assert.equal(result.resources?.[0]?.kind, 'creative');
  assert.equal(result.resources?.[0]?.data.language, 'en-US');
  const images = result.resources?.[0]?.data.images as Record<string, Array<{ id: string }>>;
  assert.equal(images.icon[0].id, 'img-1');
  assert.equal(result.summary.editDiscarded, true);
  assert.ok(checkpoints.some(item => item.editId === 'edit-1'));
  assert.ok(requests.some(item => item.url.endsWith('/edits') && item.options.method === 'POST' && item.options.write === true));
  assert.ok(requests.some(item => item.url.endsWith('/edits/edit-1') && item.options.method === 'DELETE' && item.options.write === true));
  assert.ok(!requests.some(item => item.url.includes(':commit')));
});

test('Play update-listing validates then commits via the official edit lifecycle', async () => {
  const { context, requests, checkpoints } = await createContext({
    provider: 'google-play',
    appIdentifier: 'com.example.demo',
    handler: (url, request) => {
      if (url.endsWith('/edits') && request.method === 'POST') return { id: 'edit-2' };
      if (url.endsWith('/listings/ko-KR') && request.method === 'PUT') return { language: 'ko-KR', title: '데모', shortDescription: '짧은', fullDescription: '긴 설명' };
      if (url.endsWith(':validate') || url.endsWith(':commit')) return { id: 'edit-2' };
      throw new Error(url);
    },
  });
  const result = await googlePlayConnector.execute('update-listing', {
    language: 'ko-KR', title: '데모', shortDescription: '짧은', fullDescription: '긴 설명',
  }, context);
  assert.equal(result.summary.committed, true);
  assert.equal(result.resources?.[0]?.kind, 'creative');
  const put = requests.find(item => item.options.method === 'PUT')!;
  assert.deepEqual(jsonBody(put), { language: 'ko-KR', title: '데모', shortDescription: '짧은', fullDescription: '긴 설명' });
  const order = requests.map(item => `${item.options.method ?? 'GET'} ${item.url.split('applications/com.example.demo')[1] ?? item.url}`);
  assert.ok(order.indexOf('POST /edits') < order.findIndex(item => item.startsWith('PUT ')));
  assert.ok(order.findIndex(item => item.includes(':validate')) < order.findIndex(item => item.includes(':commit')));
  assert.ok(checkpoints.some(item => item.phase === 'listing-updated'));
  assert.ok(checkpoints.some(item => item.committed === true));
});

test('Play promote-release sends staged rollout userFraction on edits.tracks', async () => {
  const { context, requests } = await createContext({
    provider: 'google-play',
    appIdentifier: 'com.example.demo',
    handler: (url, request) => {
      if (url.endsWith('/edits') && request.method === 'POST') return { id: 'edit-3' };
      if (url.endsWith('/tracks/production') && !request.method) return { track: 'production', releases: [{ versionCodes: ['88'], status: 'completed' }] };
      if (url.endsWith('/tracks/production') && request.method === 'PUT') return { track: 'production' };
      if (url.endsWith(':validate') || url.endsWith(':commit')) return { id: 'edit-3' };
      throw new Error(url);
    },
  });
  const result = await googlePlayConnector.execute('promote-release', {
    track: 'production', versionCodes: '99', status: 'inProgress', userFraction: '0.05',
  }, context);
  assert.equal(result.resources?.[0]?.kind, 'release');
  assert.equal(result.summary.status, 'inProgress');
  const put = requests.find(item => item.options.method === 'PUT')!;
  const body = jsonBody(put) as { track: string; releases: Array<{ versionCodes: string[]; status: string; userFraction: number }> };
  assert.equal(body.track, 'production');
  assert.equal(body.releases[0].status, 'inProgress');
  assert.equal(body.releases[0].userFraction, 0.05);
  assert.deepEqual(body.releases[0].versionCodes, ['99', '88']);
});

test('Play promote-release rejects userFraction outside (0, 1) before any edit', async () => {
  const { context, requests } = await createContext({
    provider: 'google-play',
    appIdentifier: 'com.example.demo',
    handler: () => { throw new Error('no http'); },
  });
  await expectAppError(googlePlayConnector.execute('promote-release', {
    track: 'production', versionCodes: '99', status: 'inProgress', userFraction: '1',
  }, context), 'INVALID_INPUT');
  assert.equal(requests.length, 0);
});

test('Play create-app returns Console action_required when the package is absent', async () => {
  const { context, requests } = await createContext({
    provider: 'google-play',
    appIdentifier: 'com.example.missing',
    handler: url => {
      if (url.includes('/oneTimeProducts')) {
        throw new AppError('RESOURCE_NOT_FOUND', '없음', 404);
      }
      throw new Error(url);
    },
  });
  const result = await googlePlayConnector.execute('create-app', {}, context);
  assert.equal(result.unresolved, true);
  assert.equal(result.summary.exists, false);
  assert.match(String(result.summary.requiredAction), /Play Console/);
  assert.equal(result.summary.setupUrl, 'https://play.google.com/console');
  assert.ok(!requests.some(item => item.options.write === true));
});

test('Play upload-listing-image posts media to the official upload path and commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'play-img-'));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const path = join(directory, 'icon.png');
  await writeFile(path, png);
  const artifact: VerifiedArtifact = { path, name: 'icon.png', size: png.length, sha256: createHash('sha256').update(png).digest('hex'), kind: 'file' };
  const { context, requests } = await createContext({
    provider: 'google-play',
    appIdentifier: 'com.example.demo',
    artifact,
    handler: (url, request) => {
      if (url.endsWith('/edits') && request.method === 'POST') return { id: 'edit-4' };
      if (url.includes('/upload/androidpublisher/v3/') && url.includes('/icon?uploadType=media')) {
        return { image: { id: 'im-9', sha256: artifact.sha256, url: 'https://lh3.googleusercontent.com/y' } };
      }
      if (url.endsWith(':validate') || url.endsWith(':commit')) return { id: 'edit-4' };
      throw new Error(url);
    },
  });
  const result = await googlePlayConnector.execute('upload-listing-image', { language: 'en-US', imageType: 'icon' }, context);
  assert.equal(result.resources?.[0]?.kind, 'creative');
  assert.equal(result.summary.imageId, 'im-9');
  assert.equal(result.summary.committed, true);
  const upload = requests.find(item => item.url.includes('/upload/androidpublisher/v3/'))!;
  assert.equal(upload.options.method, 'POST');
  assert.equal(upload.options.write, true);
  assert.equal(upload.options.headers?.['Content-Type'], 'image/png');
});

test('Play operations are listed on the capability for the dynamic UI', () => {
  for (const operation of ['list-listings', 'update-listing', 'upload-listing-image', 'promote-release', 'create-app']) {
    assert.ok(googlePlayConnector.capability.operations.includes(operation), operation);
    assert.ok(googlePlayConnector.capability.operationFields?.[operation], operation);
  }
});

// ---------------------------------------------------------------------------
// App Store Connect metadata, TestFlight, review, release
// ---------------------------------------------------------------------------

test('Apple create-app does not POST /v1/apps and returns Console prerequisite when missing', async () => {
  const { context, requests } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.missing',
    credentials: { keyId: 'K', issuerId: 'I', privateKey: 'P' },
    handler: url => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return { data: [] };
      throw new Error(url);
    },
  });
  const result = await appStoreConnector.execute('create-app', {}, context);
  assert.equal(result.unresolved, true);
  assert.equal(result.summary.exists, false);
  assert.match(String(result.summary.requiredAction), /4\.4\.1/);
  assert.equal(result.summary.setupUrl, 'https://appstoreconnect.apple.com/apps');
  assert.ok(!requests.some(item => item.options.method === 'POST'));
});

test('Apple update-listing POSTs AppStoreVersionLocalizationCreateRequest with the exact version id', async () => {
  const { context, requests, checkpoints } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: (url, request) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/appStoreVersions/ver-1?include=app')) return appleVersionDoc('ver-1');
      if (url.endsWith('/v1/appStoreVersionLocalizations') && request.method === 'POST') {
        return { data: { id: 'loc-1', type: 'appStoreVersionLocalizations', attributes: { locale: 'ko', description: '설명', whatsNew: '새 기능' } } };
      }
      throw new Error(url);
    },
  });
  const result = await appStoreConnector.execute('update-listing', {
    appStoreVersionId: 'ver-1', locale: 'ko', description: '설명', whatsNew: '새 기능',
  }, context);
  assert.equal(result.resources?.[0]?.kind, 'creative');
  assert.equal(result.summary.localizationId, 'loc-1');
  const body = jsonBody(requests.find(item => item.options.method === 'POST')!);
  assert.deepEqual(body, {
    data: {
      type: 'appStoreVersionLocalizations',
      attributes: { locale: 'ko', description: '설명', whatsNew: '새 기능' },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'ver-1' } } },
    },
  });
  assert.ok(checkpoints.some(item => item.appleAppStoreVersionId === 'ver-1'));
});

test('Apple create-version requires platform and versionString per OpenAPI', async () => {
  const { context, requests } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: (url, request) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/builds/build-3/relationships/app')) return appleAppLink();
      if (url.endsWith('/v1/appStoreVersions') && request.method === 'POST') {
        return { data: { id: 'ver-9', type: 'appStoreVersions', attributes: { versionString: '1.2.0', platform: 'IOS', appVersionState: 'PREPARE_FOR_SUBMISSION' } } };
      }
      throw new Error(url);
    },
  });
  const result = await appStoreConnector.execute('create-version', { versionString: '1.2.0', platform: 'IOS', buildId: 'build-3' }, context);
  assert.equal(result.summary.appStoreVersionId, 'ver-9');
  const body = jsonBody(requests.find(item => item.url.endsWith('/v1/appStoreVersions'))!);
  assert.deepEqual(body, {
    data: {
      type: 'appStoreVersions',
      attributes: { platform: 'IOS', versionString: '1.2.0' },
      relationships: {
        app: { data: { type: 'apps', id: 'app-99' } },
        build: { data: { type: 'builds', id: 'build-3' } },
      },
    },
  });
});

test('Apple distribute-build links an exact build id onto a beta group', async () => {
  const { context, requests } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: (url, request) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/betaGroups/grp-1/relationships/app')) return appleAppLink();
      if (url.includes('/v1/builds/build-7/relationships/app')) return appleAppLink();
      if (url.includes('/v1/betaGroups/grp-1') && url.includes('/relationships/builds') && request.method === 'POST') return {};
      if (url.includes('/v1/betaGroups/grp-1/relationships/builds')) return { data: [] };
      if (url.includes('/v1/betaGroups/grp-1')) return { data: { id: 'grp-1', type: 'betaGroups', attributes: { name: 'QA', isInternalGroup: false } } };
      throw new Error(url);
    },
  });
  const result = await appStoreConnector.execute('distribute-build', { betaGroupId: 'grp-1', buildId: 'build-7' }, context);
  assert.equal(result.summary.alreadyLinked, false);
  const post = requests.find(item => item.options.method === 'POST')!;
  assert.equal(post.url, 'https://api.appstoreconnect.apple.com/v1/betaGroups/grp-1/relationships/builds');
  assert.deepEqual(jsonBody(post), { data: [{ type: 'builds', id: 'build-7' }] });
});

test('Apple submit-review uses reviewSubmissions + items + submitted:true with the version id', async () => {
  const { context, requests, checkpoints } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: (url, request) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/appStoreVersions/ver-1?include=app')) {
        return appleVersionDoc('ver-1', 'app-99', { appVersionState: 'READY_FOR_REVIEW' });
      }
      if (url.includes('/v1/reviewSubmissions?filter[app]=')) return { data: [] };
      if (url.endsWith('/v1/reviewSubmissions') && request.method === 'POST') {
        return { data: { id: 'rs-1', type: 'reviewSubmissions', attributes: { state: 'READY_FOR_REVIEW', platform: 'IOS' } } };
      }
      if (url.endsWith('/v1/reviewSubmissionItems') && request.method === 'POST') {
        return { data: { id: 'rsi-1', type: 'reviewSubmissionItems', attributes: { state: 'READY_FOR_REVIEW' } } };
      }
      if (url.endsWith('/v1/reviewSubmissions/rs-1') && request.method === 'PATCH') {
        return { data: { id: 'rs-1', type: 'reviewSubmissions', attributes: { state: 'WAITING_FOR_REVIEW' } } };
      }
      throw new Error(url);
    },
  });
  const result = await appStoreConnector.execute('submit-review', { appStoreVersionId: 'ver-1', platform: 'IOS' }, context);
  assert.equal(result.waitingExternal, true);
  assert.equal(result.summary.reviewSubmissionId, 'rs-1');
  assert.equal(result.summary.appStoreVersionId, 'ver-1');
  assert.equal(result.summary.confirmed, false);
  assert.equal(result.summary.failed, false);
  assert.equal(result.summary.unresolved, false);
  const create = jsonBody(requests.find(item => item.url.endsWith('/v1/reviewSubmissions') && item.options.method === 'POST')!);
  assert.deepEqual(create, {
    data: {
      type: 'reviewSubmissions',
      attributes: { platform: 'IOS' },
      relationships: { app: { data: { type: 'apps', id: 'app-99' } } },
    },
  });
  const item = jsonBody(requests.find(item => item.url.endsWith('/v1/reviewSubmissionItems'))!);
  assert.deepEqual(item, {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: 'rs-1' } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: 'ver-1' } },
      },
    },
  });
  const patch = jsonBody(requests.find(item => item.options.method === 'PATCH')!);
  assert.deepEqual(patch, { data: { type: 'reviewSubmissions', id: 'rs-1', attributes: { submitted: true } } });
  assert.ok(checkpoints.some(item => item.phase === 'submitted'));
});

test('Apple release-version posts AppStoreVersionReleaseRequest for PENDING_DEVELOPER_RELEASE', async () => {
  const { context, requests } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: (url, request) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/appStoreVersions/ver-2?include=app')) {
        return appleVersionDoc('ver-2', 'app-99', { appVersionState: 'PENDING_DEVELOPER_RELEASE' });
      }
      if (url.endsWith('/v1/appStoreVersionReleaseRequests') && request.method === 'POST') {
        return { data: { id: 'rel-1', type: 'appStoreVersionReleaseRequests' } };
      }
      throw new Error(url);
    },
  });
  const result = await appStoreConnector.execute('release-version', { appStoreVersionId: 'ver-2', action: 'release' }, context);
  assert.equal(result.waitingExternal, true);
  assert.deepEqual(jsonBody(requests.find(item => item.options.method === 'POST')!), {
    data: {
      type: 'appStoreVersionReleaseRequests',
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'ver-2' } } },
    },
  });
});

test('Apple review and TestFlight operations require exact resource ids', async () => {
  const { context } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: { keyId: 'K', issuerId: 'I', privateKey: 'P' },
    handler: () => { throw new Error('no http'); },
  });
  await expectAppError(appStoreConnector.execute('submit-review', {}, context), 'INVALID_INPUT');
  await expectAppError(appStoreConnector.execute('distribute-build', { betaGroupId: 'grp' }, context), 'INVALID_INPUT');
  await expectAppError(appStoreConnector.execute('link-build', { appStoreVersionId: 'ver-1' }, context), 'INVALID_INPUT');
});

test('Apple list-beta-groups and list-review-submissions are GET-only', async () => {
  const { context, requests } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: url => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/betaGroups')) return { data: [{ id: 'g1', type: 'betaGroups', attributes: { name: 'Internal', isInternalGroup: true } }] };
      if (url.includes('/reviewSubmissions')) return { data: [{ id: 'rs1', type: 'reviewSubmissions', attributes: { state: 'IN_REVIEW', platform: 'IOS' } }] };
      throw new Error(url);
    },
  });
  const groups = await appStoreConnector.execute('list-beta-groups', {}, context);
  const reviews = await appStoreConnector.execute('list-review-submissions', { platform: 'IOS' }, context);
  assert.equal(groups.resources?.[0]?.externalId, 'g1');
  assert.equal(reviews.resources?.[0]?.status, 'IN_REVIEW');
  assert.ok(requests.every(item => !item.options.method || item.options.method === 'GET'));
});

test('Apple same-app version, localization, build, group, and phased release IDs succeed with official relationship evidence', async () => {
  const { context, requests } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: (url, request) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/appStoreVersions/ver-1?include=app')) return appleVersionDoc('ver-1');
      if (url.includes('/v1/appStoreVersionLocalizations/loc-1?include=appStoreVersion')) return appleLocalizationDoc('loc-1', 'ver-1', 'ko');
      if (url.includes('/v1/appStoreVersionLocalizations/loc-1') && request.method === 'PATCH') {
        return { data: { id: 'loc-1', type: 'appStoreVersionLocalizations', attributes: { locale: 'ko', description: '수정' } } };
      }
      if (url.includes('/v1/apps/app-99/appInfos')) return { data: [{ id: 'info-1', type: 'appInfos' }] };
      if (url.includes('/v1/appInfoLocalizations/ail-1?include=appInfo')) return appleAppInfoLocalizationDoc('ail-1', 'info-1', 'ko');
      if (url.includes('/v1/appInfoLocalizations/ail-1') && request.method === 'PATCH') {
        return { data: { id: 'ail-1', type: 'appInfoLocalizations', attributes: { locale: 'ko', name: '데모' } } };
      }
      if (url.includes('/v1/builds/build-7/relationships/app')) return appleAppLink();
      if (url.includes('/v1/appStoreVersions/ver-1/relationships/build') && request.method === 'PATCH') return {};
      if (url.includes('/v1/appStoreVersions/ver-2?include=app')) {
        return appleVersionDoc('ver-2', 'app-99', { appVersionState: 'PENDING_DEVELOPER_RELEASE' });
      }
      if (url.includes('/v1/appStoreVersions/ver-2/relationships/appStoreVersionPhasedRelease')) {
        return { data: { type: 'appStoreVersionPhasedReleases', id: 'pr-1' } };
      }
      if (url.includes('/v1/appStoreVersionPhasedReleases/pr-1') && request.method === 'PATCH') {
        return { data: { id: 'pr-1', type: 'appStoreVersionPhasedReleases', attributes: { phasedReleaseState: 'PAUSED' } } };
      }
      throw new Error(url);
    },
  });

  const listing = await appStoreConnector.execute('update-listing', {
    appStoreVersionId: 'ver-1', localizationId: 'loc-1', locale: 'ko', description: '수정',
  }, context);
  assert.equal(listing.summary.localizationId, 'loc-1');
  assert.ok(requests.some(item => item.url.includes('/v1/appStoreVersions/ver-1?include=app')));
  assert.ok(requests.some(item => item.url.includes('/v1/appStoreVersionLocalizations/loc-1?include=appStoreVersion')));

  const appInfo = await appStoreConnector.execute('update-app-info', {
    localizationId: 'ail-1', locale: 'ko', name: '데모',
  }, context);
  assert.equal(appInfo.summary.localizationId, 'ail-1');
  assert.ok(requests.some(item => item.url.includes('/v1/appInfoLocalizations/ail-1?include=appInfo')));

  const linked = await appStoreConnector.execute('link-build', { appStoreVersionId: 'ver-1', buildId: 'build-7' }, context);
  assert.equal(linked.summary.buildId, 'build-7');
  assert.ok(requests.some(item => item.url.endsWith('/v1/builds/build-7/relationships/app')));

  const paused = await appStoreConnector.execute('release-version', {
    appStoreVersionId: 'ver-2', action: 'phased-pause', phasedReleaseId: 'pr-1',
  }, context);
  assert.equal(paused.summary.phasedReleaseId, 'pr-1');
  assert.ok(requests.some(item => item.url.endsWith('/v1/appStoreVersions/ver-2/relationships/appStoreVersionPhasedRelease')));
});

test('Apple rejects cross-app version, localization, app-info, build, group, phased-release, and review IDs before writes', async () => {
  async function appleContext(handler: (url: string, request: ProviderRequest) => unknown) {
    return createContext({
      provider: 'app-store',
      appIdentifier: 'com.example.demo',
      credentials: appleCredentials,
      handler,
    });
  }

  const listings = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/appStoreVersions/ver-x?include=app')) return appleVersionDoc('ver-x', otherAppId);
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('list-listings', { appStoreVersionId: 'ver-x' }, listings.context), 'INVALID_INPUT');
  assert.ok(!listings.requests.some(item => item.options.write === true));

  const listing = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/appStoreVersions/ver-1?include=app')) return appleVersionDoc('ver-1');
    if (url.includes('/v1/appStoreVersionLocalizations/loc-x?include=appStoreVersion')) return appleLocalizationDoc('loc-x', 'ver-other', 'ko');
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('update-listing', {
    appStoreVersionId: 'ver-1', localizationId: 'loc-x', locale: 'ko', description: '설명',
  }, listing.context), 'INVALID_INPUT');
  assert.ok(!listing.requests.some(item => item.options.write === true));

  const localeMismatch = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/appStoreVersions/ver-1?include=app')) return appleVersionDoc('ver-1');
    if (url.includes('/v1/appStoreVersionLocalizations/loc-1?include=appStoreVersion')) return appleLocalizationDoc('loc-1', 'ver-1', 'ja');
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('update-listing', {
    appStoreVersionId: 'ver-1', localizationId: 'loc-1', locale: 'ko', description: '설명',
  }, localeMismatch.context), 'INVALID_INPUT');

  const appInfo = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/apps/app-99/appInfos')) return { data: [{ id: 'info-1', type: 'appInfos' }] };
    if (url.includes('/v1/appInfoLocalizations/ail-x?include=appInfo')) return appleAppInfoLocalizationDoc('ail-x', 'info-other', 'ko');
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('update-app-info', {
    localizationId: 'ail-x', locale: 'ko', name: '데모',
  }, appInfo.context), 'INVALID_INPUT');
  assert.ok(!appInfo.requests.some(item => item.options.write === true));

  const distribute = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/betaGroups/grp-x/relationships/app')) return appleAppLink(otherAppId);
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('distribute-build', { betaGroupId: 'grp-x', buildId: 'build-7' }, distribute.context), 'INVALID_INPUT');
  assert.ok(!distribute.requests.some(item => item.options.write === true));

  const build = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/appStoreVersions/ver-1?include=app')) return appleVersionDoc('ver-1');
    if (url.includes('/v1/builds/build-x/relationships/app')) return appleAppLink(otherAppId);
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('link-build', { appStoreVersionId: 'ver-1', buildId: 'build-x' }, build.context), 'INVALID_INPUT');
  assert.ok(!build.requests.some(item => item.options.write === true));

  const createVersion = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/builds/build-x/relationships/app')) return appleAppLink(otherAppId);
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('create-version', {
    versionString: '1.2.0', platform: 'IOS', buildId: 'build-x',
  }, createVersion.context), 'INVALID_INPUT');
  assert.ok(!createVersion.requests.some(item => item.options.write === true));

  const phased = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/appStoreVersions/ver-2?include=app')) {
      return appleVersionDoc('ver-2', 'app-99', { appVersionState: 'PENDING_DEVELOPER_RELEASE' });
    }
    if (url.includes('/v1/appStoreVersions/ver-2/relationships/appStoreVersionPhasedRelease')) {
      return { data: { type: 'appStoreVersionPhasedReleases', id: 'pr-other' } };
    }
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('release-version', {
    appStoreVersionId: 'ver-2', action: 'phased-complete', phasedReleaseId: 'pr-1',
  }, phased.context), 'INVALID_INPUT');
  assert.ok(!phased.requests.some(item => item.options.write === true));

  const review = await appleContext(url => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
    if (url.includes('/v1/reviewSubmissions/rs-x?include=app')) return appleReviewDoc('rs-x', otherAppId, 'COMPLETE');
    throw new Error(url);
  });
  await expectAppError(appStoreConnector.execute('reconcile', { reviewSubmissionId: 'rs-x' }, review.context), 'INVALID_INPUT');
});

test('Apple fails closed when official include or linkage relationships are missing', async () => {
  const version = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: url => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/appStoreVersions/ver-1?include=app')) {
        return { data: { id: 'ver-1', type: 'appStoreVersions', attributes: { versionString: '1.2.0' } } };
      }
      throw new Error(url);
    },
  });
  await expectAppError(appStoreConnector.execute('submit-review', { appStoreVersionId: 'ver-1', platform: 'IOS' }, version.context), 'INVALID_PROVIDER_RESPONSE');
  assert.ok(!version.requests.some(item => item.options.write === true));

  const build = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: url => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/betaGroups/grp-1/relationships/app')) return appleAppLink();
      if (url.includes('/v1/builds/build-7/relationships/app')) return { data: null };
      throw new Error(url);
    },
  });
  await expectAppError(appStoreConnector.execute('distribute-build', { betaGroupId: 'grp-1', buildId: 'build-7' }, build.context), 'INVALID_PROVIDER_RESPONSE');
  assert.ok(!build.requests.some(item => item.options.write === true));
});

test('Apple review submit and reconcile map official states and never confirm READY_FOR_REVIEW, missing, or unknown', async () => {
  async function submitWithState(state: string | undefined) {
    const { context } = await createContext({
      provider: 'app-store',
      appIdentifier: 'com.example.demo',
      credentials: appleCredentials,
      handler: (url, request) => {
        if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
        if (url.includes('/v1/appStoreVersions/ver-1?include=app')) {
          return appleVersionDoc('ver-1', 'app-99', { appVersionState: 'READY_FOR_REVIEW' });
        }
        if (url.includes('/v1/reviewSubmissions?filter[app]=')) return { data: [] };
        if (url.endsWith('/v1/reviewSubmissions') && request.method === 'POST') {
          return { data: { id: 'rs-1', type: 'reviewSubmissions', attributes: { state: 'READY_FOR_REVIEW', platform: 'IOS' } } };
        }
        if (url.endsWith('/v1/reviewSubmissionItems') && request.method === 'POST') {
          return { data: { id: 'rsi-1', type: 'reviewSubmissionItems' } };
        }
        if (url.endsWith('/v1/reviewSubmissions/rs-1') && request.method === 'PATCH') {
          return { data: { id: 'rs-1', type: 'reviewSubmissions', attributes: state === undefined ? {} : { state } } };
        }
        throw new Error(url);
      },
    });
    return appStoreConnector.execute('submit-review', { appStoreVersionId: 'ver-1', platform: 'IOS' }, context);
  }

  async function reconcileWithState(state: string | undefined) {
    const { context } = await createContext({
      provider: 'app-store',
      appIdentifier: 'com.example.demo',
      credentials: appleCredentials,
      handler: url => {
        if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
        if (url.includes('/v1/reviewSubmissions/rs-1?include=app')) {
          const document = appleReviewDoc('rs-1', 'app-99', state ?? '');
          if (state === undefined) delete (document.data.attributes as { state?: string }).state;
          else document.data.attributes.state = state;
          return document;
        }
        throw new Error(url);
      },
    });
    return appStoreConnector.execute('reconcile', { reviewSubmissionId: 'rs-1' }, context);
  }

  const complete = await reconcileWithState('COMPLETE');
  assert.deepEqual(
    { confirmed: complete.summary.confirmed, failed: complete.failed, waiting: complete.waitingExternal, unresolved: complete.unresolved },
    { confirmed: true, failed: false, waiting: false, unresolved: false },
  );

  const issues = await reconcileWithState('UNRESOLVED_ISSUES');
  assert.deepEqual(
    { confirmed: issues.summary.confirmed, failed: issues.failed, waiting: issues.waitingExternal, unresolved: issues.unresolved },
    { confirmed: false, failed: true, waiting: false, unresolved: false },
  );

  for (const state of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'COMPLETING', 'CANCELING']) {
    const pending = await reconcileWithState(state);
    assert.deepEqual(
      { confirmed: pending.summary.confirmed, failed: pending.failed, waiting: pending.waitingExternal, unresolved: pending.unresolved },
      { confirmed: false, failed: false, waiting: true, unresolved: false },
      state,
    );
  }

  for (const state of ['READY_FOR_REVIEW', 'MYSTERY', undefined]) {
    const uncertain = await reconcileWithState(state);
    assert.equal(uncertain.summary.confirmed, false, String(state));
    assert.equal(uncertain.failed, false, String(state));
    assert.equal(uncertain.waitingExternal, false, String(state));
    assert.equal(uncertain.unresolved, true, String(state));
  }

  const submittedComplete = await submitWithState('COMPLETE');
  assert.equal(submittedComplete.summary.confirmed, true);
  assert.equal(submittedComplete.failed, false);

  const submittedIssues = await submitWithState('UNRESOLVED_ISSUES');
  assert.equal(submittedIssues.failed, true);
  assert.equal(submittedIssues.summary.confirmed, false);

  const submittedReady = await submitWithState('READY_FOR_REVIEW');
  assert.equal(submittedReady.unresolved, true);
  assert.equal(submittedReady.summary.confirmed, false);
  assert.equal(submittedReady.waitingExternal, false);

  const submittedMissing = await submitWithState(undefined);
  assert.equal(submittedMissing.unresolved, true);
  assert.equal(submittedMissing.summary.confirmed, false);
});

test('Apple review reconcile uses explicit reviewSubmissionId even when externalId differs', async () => {
  const { context, requests } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: url => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/reviewSubmissions/rs-explicit?include=app')) return appleReviewDoc('rs-explicit', 'app-99', 'COMPLETE');
      throw new Error(url);
    },
  });
  const viaExecute = await appStoreConnector.execute('reconcile', {
    reviewSubmissionId: 'rs-explicit',
    externalId: 'rs-other',
  }, context);
  assert.equal(viaExecute.summary.reviewSubmissionId, 'rs-explicit');
  assert.equal(viaExecute.summary.confirmed, true);
  assert.ok(requests.some(item => item.url.includes('/v1/reviewSubmissions/rs-explicit?include=app')));
  assert.ok(!requests.some(item => item.url.includes('/v1/reviewSubmissions/rs-other')));

  const { context: fallbackContext, requests: fallbackRequests } = await createContext({
    provider: 'app-store',
    appIdentifier: 'com.example.demo',
    credentials: appleCredentials,
    handler: url => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp;
      if (url.includes('/v1/reviewSubmissions/rs-fallback?include=app')) return appleReviewDoc('rs-fallback', 'app-99', 'IN_REVIEW');
      throw new Error(url);
    },
  });
  const viaFallback = await reconcileAppleReview({ externalId: 'rs-fallback' }, fallbackContext);
  assert.equal(viaFallback.summary.reviewSubmissionId, 'rs-fallback');
  assert.equal(viaFallback.waitingExternal, true);
  assert.ok(fallbackRequests.some(item => item.url.includes('/v1/reviewSubmissions/rs-fallback?include=app')));
});

// ---------------------------------------------------------------------------
// Steam SetAppBuildLive + announcement gate
// ---------------------------------------------------------------------------

test('Steam set-live POSTs official SetAppBuildLive v2 form fields and reconciles GetAppBetas', async () => {
  const { context, requests, checkpoints } = await createContext({
    provider: 'steam',
    appIdentifier: '480',
    credentials: { apiKey: 'publisher-key' },
    handler: url => {
      if (url.includes('/ISteamApps/SetAppBuildLive/v2/')) return { response: { result: 1 } };
      if (url.includes('/ISteamApps/GetAppBetas/v1/')) return { response: { betas: { beta: { BuildID: '9001' } } } };
      throw new Error(url);
    },
  });
  const result = await steamConnector.execute('set-live', { buildId: '9001', branch: 'beta' }, context);
  assert.equal(result.summary.confirmedRemotely, true);
  assert.equal(result.waitingExternal, false);
  const post = requests.find(item => item.url.includes('SetAppBuildLive'))!;
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.write, true);
  assert.equal(post.options.headers?.['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(String(post.options.body));
  assert.equal(body.get('key'), 'publisher-key');
  assert.equal(body.get('appid'), '480');
  assert.equal(body.get('buildid'), '9001');
  assert.equal(body.get('betakey'), 'beta');
  assert.ok(checkpoints.some(item => item.phase === 'set-live-posted'));
});

test('Steam public set-live without SteamID returns platform action instead of posting', async () => {
  const { context, requests } = await createContext({
    provider: 'steam',
    appIdentifier: '480',
    credentials: { apiKey: 'publisher-key' },
    handler: () => { throw new Error('no http'); },
  });
  const result = await steamConnector.execute('set-live', { buildId: '9001', branch: 'public' }, context);
  assert.equal(result.unresolved, true);
  assert.match(String(result.summary.requiredAction), /SteamID64/);
  assert.equal(requests.length, 0);
});

test('Steam create-announcement does not invent an endpoint and points at the official tools', async () => {
  const { context, requests } = await createContext({
    provider: 'steam',
    appIdentifier: '480',
    credentials: { apiKey: 'publisher-key' },
    handler: () => { throw new Error('no http'); },
  });
  const result = await steamConnector.execute('create-announcement', { title: 'v1.2' }, context);
  assert.equal(result.unresolved, true);
  assert.equal(result.summary.publishing, 'unsupported');
  assert.equal(result.summary.setupUrl, 'https://partner.steamgames.com/doc/marketing/event_tools');
  assert.equal(result.summary.consoleUrl, 'https://partner.steamgames.com/apps/landing/480');
  assert.equal(requests.length, 0);
});

test('store connectors expose Korean operationFields for every new live operation', () => {
  const expected: Array<[Connector, string[]]> = [
    [googlePlayConnector, ['list-listings', 'update-listing', 'upload-listing-image', 'promote-release', 'create-app']],
    [appStoreConnector, ['create-app', 'create-version', 'list-listings', 'update-listing', 'update-app-info', 'list-beta-groups', 'create-beta-group', 'distribute-build', 'link-build', 'submit-review', 'list-review-submissions', 'release-version']],
    [steamConnector, ['set-live', 'create-announcement']],
  ];
  for (const [connector, operations] of expected) {
    for (const operation of operations) {
      assert.ok(connector.capability.operations.includes(operation), `${connector.capability.provider} ${operation}`);
      const fields = connector.capability.operationFields?.[operation];
      assert.ok(fields, `${connector.capability.provider} ${operation} fields`);
    }
  }
});
