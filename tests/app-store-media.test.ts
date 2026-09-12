import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { test } from 'node:test';

import { AppError } from '../packages/domain/errors.js';
import { DEFAULT_POLICY, type Connection, type Project } from '../packages/domain/index.js';
import { appStoreConnector } from '../packages/connectors/app-store.js';
import { inspectScreenshotBytes } from '../packages/connectors/apple-media.js';
import type { ConnectorContext, ProviderRequest, VerifiedArtifact } from '../packages/connectors/types.js';

interface RecordedRequest { url: string; options: ProviderRequest }

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function png(width: number, height: number, colorType = 2): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc((width * (colorType === 6 ? 4 : 3) + 1) * height))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function createContext(options: {
  artifact?: VerifiedArtifact;
  handler: (url: string, request: ProviderRequest) => unknown;
}): Promise<{ context: ConnectorContext; requests: RecordedRequest[]; checkpoints: Array<Record<string, unknown>> }> {
  const workDirectory = await mkdtemp(join(tmpdir(), 'apple-media-'));
  const requests: RecordedRequest[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  const connection: Connection = {
    id: 'conn-1', provider: 'app-store', label: 'test', accountId: 'acct-1', status: 'connected',
    createdAt: now, updatedAt: now, lastCheckedAt: null, lastError: null, authKind: 'api-key-jwt', credentialFields: [],
  };
  const project: Project = {
    id: 'proj-1', createdAt: now, updatedAt: now, policy: DEFAULT_POLICY,
    rootPath: workDirectory, name: 'demo', engine: 'unknown', engineVersion: null,
    appIdentifier: 'com.example.demo', targets: [], findings: [], inspectedAt: now,
  };
  const context: ConnectorContext = {
    connection,
    credentials: {},
    project,
    signal: new AbortController().signal,
    artifact: options.artifact,
    workDirectory,
    markDispatched: () => undefined,
    checkpoint: data => { checkpoints.push({ ...data }); },
    saveCredentials: async () => undefined,
    accessToken: async () => 'test-token',
    request: async <T>(url: string, request: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      return options.handler(url, request) as T;
    },
    progress: () => undefined,
  };
  return { context, requests, checkpoints };
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

async function artifactPng(directory: string, width: number, height: number, name = 'shot.png', colorType = 2): Promise<VerifiedArtifact> {
  const bytes = png(width, height, colorType);
  const path = join(directory, name);
  await writeFile(path, bytes);
  return { path, name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'file' };
}

const APP = 'https://api.appstoreconnect.apple.com';
const PUT_URL = 'https://store-030.blobstore.apple.com/assets-massilia-030001/PurpleSource62/shot?partNumber=1';

function json(request: RecordedRequest): Record<string, unknown> {
  return (request.options.json ?? {}) as Record<string, unknown>;
}

function appleApp() {
  return { data: [{ id: 'app-99', type: 'apps', attributes: { name: 'Demo', bundleId: 'com.example.demo' } }] };
}

function versionDoc(appId = 'app-99') {
  return {
    data: {
      id: 'ver-1', type: 'appStoreVersions',
      attributes: { versionString: '1.2.0', platform: 'IOS' },
      relationships: { app: { data: { type: 'apps', id: appId } } },
    },
  };
}

function localizationDoc() {
  return {
    data: {
      id: 'loc-1', type: 'appStoreVersionLocalizations',
      attributes: { locale: 'ko' },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'ver-1' } } },
    },
  };
}

function setDoc() {
  return {
    data: {
      id: 'set-1', type: 'appScreenshotSets',
      attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
      relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: 'loc-1' } } },
    },
  };
}

function screenshotDoc(state: string, extras: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'ss-1', type: 'appScreenshots',
      attributes: {
        fileName: 'shot.png',
        fileSize: extras.fileSize,
        sourceFileChecksum: extras.sourceFileChecksum ?? null,
        assetDeliveryState: { state, errors: extras.errors ?? [] },
        uploadOperations: extras.uploadOperations,
      },
      relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: 'set-1' } } },
    },
  };
}

function uploadOperations(fileSize: number) {
  return [{
    method: 'PUT',
    url: PUT_URL,
    offset: 0,
    length: fileSize,
    requestHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Content-Length', value: String(fileSize) }],
  }];
}

function defaultHandler(fileSize: number, options: { existingSet?: boolean; existingShot?: boolean; afterState?: string } = {}) {
  const after = options.afterState ?? 'COMPLETE';
  return (url: string, request: ProviderRequest): unknown => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp();
    if (url.includes('/appStoreVersions/ver-1/appStoreVersionLocalizations')) {
      return { data: [localizationDoc().data] };
    }
    if (url.includes('/v1/appStoreVersions/ver-1')) return versionDoc();
    if (url.includes('/appStoreVersionLocalizations/loc-1/appScreenshotSets') && !request.method) {
      return { data: options.existingSet ? [setDoc().data] : [] };
    }
    if (url.includes('/v1/appScreenshotSets') && request.method === 'POST') return setDoc();
    if (url.includes('/v1/appScreenshotSets/set-1?include=')) return setDoc();
    if (url.includes('/appScreenshotSets/set-1/appScreenshots') && !request.method) {
      return { data: options.existingShot ? [screenshotDoc('AWAITING_UPLOAD', { fileSize, uploadOperations: uploadOperations(fileSize) }).data] : [] };
    }
    if (url.includes('/v1/appScreenshots') && request.method === 'POST') {
      return screenshotDoc('AWAITING_UPLOAD', { fileSize, uploadOperations: uploadOperations(fileSize) });
    }
    if (url === PUT_URL) return '';
    if (url.includes('/v1/appScreenshots/ss-1') && request.method === 'PATCH') {
      return screenshotDoc('UPLOAD_COMPLETE', { fileSize });
    }
    if (url.includes('/v1/appScreenshots/ss-1') && !request.method) {
      return screenshotDoc(after, { fileSize, sourceFileChecksum: 'md5' });
    }
    throw new Error(url);
  };
}

test('inspectScreenshotBytes reads PNG size and rejects alpha', async () => {
  const rgb = png(1290, 2796, 2);
  const info = await inspectScreenshotBytes('shot.png', rgb);
  assert.equal(info.width, 1290);
  assert.equal(info.height, 2796);
  assert.equal(info.mime, 'image/png');
  await assert.rejects(() => inspectScreenshotBytes('shot.png', png(10, 10, 6)), (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT');
  await assert.rejects(() => inspectScreenshotBytes('shot.webp', rgb), (error: unknown) => error instanceof AppError && error.code === 'INVALID_INPUT');
  await assert.rejects(() => inspectScreenshotBytes('shot.png', rgb.subarray(0,33)), {code:'INVALID_INPUT'});
});

test('upload-listing-image reserves, PUTs Apple byte range with request headers, commits MD5, and reports COMPLETE', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-shot-'));
  const artifact = await artifactPng(directory, 1290, 2796);
  const md5 = createHash('md5').update(await (await import('node:fs/promises')).readFile(artifact.path)).digest('hex');
  const { context, requests, checkpoints } = await createContext({
    artifact,
    handler: defaultHandler(artifact.size),
  });
  const result = await appStoreConnector.execute('upload-listing-image', {
    appStoreVersionId: 'ver-1', locale: 'ko', screenshotDisplayType: 'APP_IPHONE_67',
  }, context);
  assert.equal(result.summary.confirmed, true);
  assert.equal(result.summary.appScreenshotId, 'ss-1');
  assert.equal(result.waitingExternal, false);
  const createShot = requests.find(item => item.url.endsWith('/v1/appScreenshots') && item.options.method === 'POST')!;
  const createData = (json(createShot).data as { attributes: Record<string, unknown>; relationships: Record<string, unknown> });
  assert.equal(createData.attributes.fileName, 'shot.png');
  assert.equal(createData.attributes.fileSize, artifact.size);
  const put = requests.find(item => item.url === PUT_URL)!;
  assert.equal(put.options.method, 'PUT');
  assert.equal(put.options.write, true);
  assert.equal(put.options.headers?.['Content-Type'], 'image/png');
  assert.equal((put.options.body as Uint8Array).byteLength, artifact.size);
  const commit = requests.find(item => item.url.includes('/v1/appScreenshots/ss-1') && item.options.method === 'PATCH')!;
  const commitAttrs = (json(commit).data as { attributes: Record<string, unknown> }).attributes;
  assert.equal(commitAttrs.uploaded, true);
  assert.equal(commitAttrs.sourceFileChecksum, md5);
  assert.ok(checkpoints.some(item => item.phase === 'committed'));
});

test('existing screenshot set is reused but an unrelated reservation with the same name and size is not overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-reuse-'));
  const artifact = await artifactPng(directory, 1290, 2796);
  const { context, requests } = await createContext({
    artifact,
    handler: defaultHandler(artifact.size, { existingSet: true, existingShot: true }),
  });
  await appStoreConnector.execute('upload-listing-image', {
    appStoreVersionId: 'ver-1', locale: 'ko', screenshotDisplayType: 'APP_IPHONE_67',
  }, context);
  assert.equal(requests.filter(item => item.url.endsWith('/v1/appScreenshotSets') && item.options.method === 'POST').length, 0);
  assert.equal(requests.filter(item => item.url.endsWith('/v1/appScreenshots') && item.options.method === 'POST').length, 1);
  assert.ok(requests.some(item => item.url === PUT_URL));
});

test('wrong pixel size, missing artifact, other-app version, and preview video fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-bad-'));
  const small = await artifactPng(directory, 10, 10);
  const { context: wrongSize } = await createContext({ artifact: small, handler: defaultHandler(small.size) });
  await expectCode(appStoreConnector.execute('upload-listing-image', {
    appStoreVersionId: 'ver-1', locale: 'ko', screenshotDisplayType: 'APP_IPHONE_67',
  }, wrongSize), 'INVALID_INPUT');

  const ok = await artifactPng(directory, 1290, 2796, 'ok.png');
  const { context: missing } = await createContext({ handler: defaultHandler(ok.size) });
  await expectCode(appStoreConnector.execute('upload-listing-image', {
    appStoreVersionId: 'ver-1', locale: 'ko', screenshotDisplayType: 'APP_IPHONE_67',
  }, missing), 'MISSING_REQUIREMENT');

  const { context: otherApp } = await createContext({
    artifact: ok,
    handler: (url, request) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp();
      if (url.includes('/v1/appStoreVersions/ver-1')) return versionDoc('app-other');
      return defaultHandler(ok.size)(url, request);
    },
  });
  await expectCode(appStoreConnector.execute('upload-listing-image', {
    appStoreVersionId: 'ver-1', locale: 'ko', screenshotDisplayType: 'APP_IPHONE_67',
  }, otherApp), 'INVALID_INPUT');

  const { context: preview } = await createContext({ artifact: ok, handler: defaultHandler(ok.size) });
  await expectCode(appStoreConnector.execute('upload-listing-image', {
    appStoreVersionId: 'ver-1', locale: 'ko', screenshotDisplayType: 'APP_IPHONE_67', previewType: 'IPHONE_67',
  }, preview), 'UNSUPPORTED_OPERATION');
});

test('FAILED assetDeliveryState never confirms and reconcile maps COMPLETE/FAILED/processing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-state-'));
  const artifact = await artifactPng(directory, 1290, 2796);
  const { context: failed } = await createContext({
    artifact,
    handler: defaultHandler(artifact.size, { afterState: 'FAILED' }),
  });
  await expectCode(appStoreConnector.execute('upload-listing-image', {
    appStoreVersionId: 'ver-1', locale: 'ko', screenshotDisplayType: 'APP_IPHONE_67',
  }, failed), 'PROVIDER_REJECTED');

  const { context: recon } = await createContext({
    handler: (url) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp();
      if (url.includes('/v1/appScreenshots/ss-1')) return screenshotDoc('COMPLETE', { fileSize: 1 });
      if (url.includes('/v1/appScreenshotSets/set-1')) return setDoc();
      if (url.includes('/appStoreVersionLocalizations/loc-1')) return localizationDoc();
      if (url.includes('/v1/appStoreVersions/ver-1')) return versionDoc();
      throw new Error(url);
    },
  });
  const complete = await appStoreConnector.execute('reconcile', { appScreenshotId: 'ss-1' }, recon);
  assert.equal(complete.summary.confirmed, true);
  assert.equal(complete.waitingExternal, false);

  const { context: wait } = await createContext({
    handler: (url) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp();
      if (url.includes('/v1/appScreenshots/ss-1')) return screenshotDoc('UPLOAD_COMPLETE', { fileSize: 1 });
      if (url.includes('/v1/appScreenshotSets/set-1')) return setDoc();
      if (url.includes('/appStoreVersionLocalizations/loc-1')) return localizationDoc();
      if (url.includes('/v1/appStoreVersions/ver-1')) return versionDoc();
      throw new Error(url);
    },
  });
  const processing = await appStoreConnector.execute('reconcile', { appScreenshotId: 'ss-1' }, wait);
  assert.equal(processing.summary.confirmed, false);
  assert.equal(processing.waitingExternal, true);

  const { context: dead } = await createContext({
    handler: (url) => {
      if (url.includes('/v1/apps?filter[bundleId]=')) return appleApp();
      if (url.includes('/v1/appScreenshots/ss-1')) return screenshotDoc('FAILED', { fileSize: 1, errors: [{ code: 'IMAGE_INVALID', description: 'bad' }] });
      if (url.includes('/v1/appScreenshotSets/set-1')) return setDoc();
      if (url.includes('/appStoreVersionLocalizations/loc-1')) return localizationDoc();
      if (url.includes('/v1/appStoreVersions/ver-1')) return versionDoc();
      throw new Error(url);
    },
  });
  const rejected = await appStoreConnector.execute('reconcile', { appScreenshotId: 'ss-1' }, dead);
  assert.equal(rejected.failed, true);
  assert.equal(rejected.summary.confirmed, false);
});

test('Apple capability lists upload-listing-image and screenshot display types', () => {
  assert.ok(appStoreConnector.capability.operations.includes('upload-listing-image'));
  const fields = appStoreConnector.capability.operationFields?.['upload-listing-image'] ?? [];
  assert.ok(fields.some(item => item.key === 'screenshotDisplayType' && item.required));
  assert.ok(fields.some(item => item.key === 'appStoreVersionId' && item.required));
  assert.ok(!appStoreConnector.capability.operations.includes('upload-app-preview'));
});
