import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { AppError } from '../packages/domain/errors.js';
import { DEFAULT_POLICY, type Connection, type Project } from '../packages/domain/index.js';
import { appStoreConnector } from '../packages/connectors/app-store.js';
import { steamConnector } from '../packages/connectors/steam.js';
import { decimalToMicros, parsePlist, readIpaMetadata, renderVdf } from '../packages/connectors/store-tools.js';
import type { ConnectorContext, ProviderRequest, VerifiedArtifact } from '../packages/connectors/types.js';

// ---------------------------------------------------------------------------
// Test doubles. All HTTP goes through an injected context.request recorder and
// the Steam CLI boundary uses a fake trusted executable — no real Apple/Steam
// account, network write, or spend happens in these tests.
// ---------------------------------------------------------------------------

interface RecordedRequest { url: string; options: ProviderRequest }

interface TestContextResult {
  context: ConnectorContext;
  requests: RecordedRequest[];
  progressLines: string[];
  checkpoints: Array<Record<string, unknown>>;
  savedCredentials: Array<Record<string, string>>;
  dispatchedCount(): number;
}

async function createContext(options: {
  provider: 'app-store' | 'steam';
  credentials?: Record<string, string>;
  appIdentifier?: string;
  artifact?: VerifiedArtifact;
  handler?: (url: string, request: ProviderRequest) => unknown;
}): Promise<TestContextResult> {
  const workDirectory = await mkdtemp(join(tmpdir(), 'store-conn-'));
  const requests: RecordedRequest[] = [];
  const progressLines: string[] = [];
  const checkpoints: Array<Record<string, unknown>> = [];
  const savedCredentials: Array<Record<string, string>> = [];
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
    checkpoint: data => { checkpoints.push(data); },
    saveCredentials: async credentials => { savedCredentials.push(credentials); },
    accessToken: async () => 'test-jwt-token',
    request: async <T>(url: string, request: ProviderRequest = {}): Promise<T> => {
      requests.push({ url, options: request });
      if (request.write) dispatched += 1;
      if (!options.handler) throw new Error(`unexpected request: ${url}`);
      return (await options.handler(url, request)) as T;
    },
    progress: message => { progressLines.push(message); },
  };
  return { context, requests, progressLines, checkpoints, savedCredentials, dispatchedCount: () => dispatched };
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

// Minimal stored-entry ZIP writer for .ipa fixtures (reader ignores CRCs).
function makeZip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    const localFull = Buffer.concat([local, name, file.data]);
    locals.push(localFull);
    offset += localFull.length;
  }
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBlob, eocd]);
}

function infoPlistXml(bundleId: string, shortVersion: string, buildVersion: string): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key>\t<string>${bundleId}</string>
\t<key>CFBundleShortVersionString</key>\t<string>${shortVersion}</string>
\t<key>CFBundleVersion</key>\t<string>${buildVersion}</string>
</dict>
</plist>
`, 'utf8');
}

async function makeIpa(directory: string, bundleId: string, extra?: Buffer): Promise<VerifiedArtifact> {
  const zip = makeZip([
    { name: 'Payload/Demo.app/Info.plist', data: infoPlistXml(bundleId, '1.2.3', '45') },
    { name: 'Payload/Demo.app/Demo', data: extra ?? Buffer.alloc(700, 7) },
  ]);
  const path = join(directory, 'demo.ipa');
  await writeFile(path, zip);
  return { path, name: 'demo.ipa', size: zip.length, sha256: createHash('sha256').update(zip).digest('hex'), kind: 'file' };
}

const jsonApiApp = { data: [{ id: 'app-99', type: 'apps', attributes: { name: 'Demo', bundleId: 'com.example.demo', sku: 'DEMO1' } }] };

// ---------------------------------------------------------------------------
// store-tools unit checks
// ---------------------------------------------------------------------------

test('decimalToMicros converts decimal strings exactly', () => {
  assert.equal(decimalToMicros('12.3456'), 12_345_600n);
  assert.equal(decimalToMicros('0.0001'), 100n);
  assert.equal(decimalToMicros('-3.5'), -3_500_000n);
  assert.equal(decimalToMicros('7'), 7_000_000n);
  assert.throws(() => decimalToMicros('1,000'), (error: unknown) => (error as AppError).code === 'INVALID_PROVIDER_RESPONSE');
});

test('parsePlist reads binary bplist00 dictionaries', () => {
  // Hand-built bplist: {"A": "xy"} — header, 3 objects, offset table, trailer.
  const objects = Buffer.from([0xd1, 0x01, 0x02, 0x51, 0x41, 0x52, 0x78, 0x79]);
  const offsets = Buffer.from([8, 11, 13]);
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(1, 6); // offsetSize
  trailer.writeUInt8(1, 7); // referenceSize
  trailer.writeBigUInt64BE(3n, 8); // objects
  trailer.writeBigUInt64BE(0n, 16); // top object
  trailer.writeBigUInt64BE(BigInt(8 + objects.length), 24); // offset table position
  const plist = Buffer.concat([Buffer.from('bplist00'), objects, offsets, trailer]);
  assert.deepEqual(parsePlist(plist), { A: 'xy' });
});

test('readIpaMetadata extracts CFBundle values from a zipped Info.plist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ipa-fixture-'));
  const artifact = await makeIpa(directory, 'com.example.demo');
  assert.deepEqual(await readIpaMetadata(artifact.path), { bundleId: 'com.example.demo', shortVersion: '1.2.3', buildVersion: '45' });
});

test('renderVdf escapes quotes/backslashes and rejects control characters', () => {
  const rendered = renderVdf({ AppBuild: { Desc: 'quote " and \\ slash', AppID: '480' } });
  assert.ok(rendered.includes('"quote \\" and \\\\ slash"'));
  assert.throws(() => renderVdf({ AppBuild: { Desc: 'bad\nvalue' } }), (error: unknown) => (error as AppError).code === 'INVALID_INPUT');
  assert.throws(() => renderVdf({ 'bad key!': 'x' } as never), (error: unknown) => (error as AppError).code === 'INVALID_INPUT');
});

// ---------------------------------------------------------------------------
// App Store Connect connector
// ---------------------------------------------------------------------------

test('apple upload-build runs the documented buildUploads flow and stays waitingExternal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-upload-'));
  const artifact = await makeIpa(directory, 'com.example.demo');
  const partSize = Math.ceil(artifact.size / 2);
  const uploadHost = 'https://upload-host.example-apple-assets.com';
  const handler = (url: string, request: ProviderRequest): unknown => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return jsonApiApp;
    if (url.endsWith('/v1/buildUploads') && request.method === 'POST') {
      return { data: { id: 'bu-1', type: 'buildUploads', attributes: {} } };
    }
    if (url.endsWith('/v1/buildUploadFiles') && request.method === 'POST') {
      return {
        data: {
          id: 'buf-1',
          type: 'buildUploadFiles',
          attributes: {
            uploadOperations: [
              { method: 'PUT', url: `${uploadHost}/part1`, offset: 0, length: partSize, requestHeaders: [{ name: 'X-Part', value: '1' }] },
              { method: 'PUT', url: `${uploadHost}/part2`, offset: partSize, length: artifact.size - partSize, requestHeaders: [] },
            ],
          },
        },
      };
    }
    if (url.startsWith(uploadHost)) return '';
    if (url.endsWith('/v1/buildUploadFiles/buf-1') && request.method === 'PATCH') return { data: { id: 'buf-1', type: 'buildUploadFiles' } };
    if (url.endsWith('/v1/buildUploads/bu-1')) {
      // Official shape: attributes.state is an object holding the enum.
      return { data: { id: 'bu-1', type: 'buildUploads', attributes: { state: { state: 'PROCESSING', errors: [], warnings: [] } } } };
    }
    throw new Error(`unexpected: ${url}`);
  };
  const { context, requests, checkpoints, dispatchedCount } = await createContext({
    provider: 'app-store', appIdentifier: 'com.example.demo', artifact, handler,
    credentials: { keyId: 'K', issuerId: 'I', privateKey: 'P' },
  });

  const result = await appStoreConnector.execute('upload-build', { buildRunId: 'run-7' }, context);

  assert.equal(result.waitingExternal, true);
  assert.equal(result.summary.state, 'PROCESSING');
  assert.equal(result.summary.confirmed, false);
  assert.equal(result.summary.failed, false);
  assert.deepEqual(result.summary.externalIds, { buildUploadId: 'bu-1', buildUploadFileId: 'buf-1' });
  assert.equal(result.resources?.[0]?.externalId, 'bu-1');
  assert.deepEqual(checkpoints[0], { appleBuildUploadId: 'bu-1' });
  assert.ok(dispatchedCount() >= 1, 'external write must be marked');

  const createUpload = requests.find(request => request.url.endsWith('/v1/buildUploads') && request.options.method === 'POST')!;
  const createBody = createUpload.options.json as { data: { attributes: Record<string, unknown>; relationships: { app: { data: { id: string } } } } };
  assert.deepEqual(createBody.data.attributes, { cfBundleShortVersionString: '1.2.3', cfBundleVersion: '45', platform: 'IOS' });
  assert.equal(createBody.data.relationships.app.data.id, 'app-99');
  assert.equal(createUpload.options.headers?.Authorization, 'Bearer test-jwt-token');

  const parts = requests.filter(request => request.url.startsWith(uploadHost));
  assert.equal(parts.length, 2);
  assert.equal(parts[0].options.write, true);
  assert.equal(parts[0].options.headers?.['X-Part'], '1');
  const zip = await readFile(artifact.path);
  assert.deepEqual(Buffer.from(parts[0].options.body as Uint8Array), zip.subarray(0, partSize));
  assert.deepEqual(Buffer.from(parts[1].options.body as Uint8Array), zip.subarray(partSize));

  const commit = requests.find(request => request.options.method === 'PATCH')!;
  // Official BuildUploadFileUpdateRequest contract: uploaded + sourceFileChecksums.
  const commitBody = commit.options.json as {
    data: { attributes: { uploaded: boolean; sourceFileChecksums: { file: { hash: string; algorithm: string } } } };
  };
  assert.equal(commitBody.data.attributes.uploaded, true);
  assert.deepEqual(commitBody.data.attributes.sourceFileChecksums, { file: { hash: artifact.sha256, algorithm: 'SHA_256' } });
});

test('apple upload-build refuses mismatched bundle ids before any write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-mismatch-'));
  const artifact = await makeIpa(directory, 'com.other.app');
  const { context, requests } = await createContext({
    provider: 'app-store', appIdentifier: 'com.example.demo', artifact,
    handler: url => { if (url.includes('/v1/apps?filter[bundleId]=')) return jsonApiApp; throw new Error(url); },
  });
  await expectAppError(appStoreConnector.execute('upload-build', { buildRunId: 'run-1' }, context), 'INVALID_INPUT');
  assert.ok(requests.every(request => !request.options.write), 'no external write may happen on mismatch');
});

test('apple upload-build validates artifact type and track honestly', async () => {
  const base = { provider: 'app-store' as const, appIdentifier: 'com.example.demo' };
  const bad = await createContext({ ...base, artifact: { path: '/tmp/x.apk', name: 'x.apk', size: 10, sha256: 'a' } });
  await expectAppError(appStoreConnector.execute('upload-build', { buildRunId: 'r' }, bad.context), 'INVALID_INPUT');
  const pkg = await createContext({ ...base, artifact: { path: '/tmp/x.pkg', name: 'x.pkg', size: 10, sha256: 'a' } });
  await expectAppError(appStoreConnector.execute('upload-build', { buildRunId: 'r' }, pkg.context), 'UNSUPPORTED_OPERATION');
  const publicTrack = await createContext({ ...base, artifact: { path: '/tmp/x.ipa', name: 'x.ipa', size: 10, sha256: 'a' } });
  await expectAppError(appStoreConnector.execute('upload-build', { buildRunId: 'r', track: 'appstore' }, publicTrack.context), 'UNSUPPORTED_OPERATION');
  const noArtifact = await createContext({ ...base });
  await expectAppError(appStoreConnector.execute('upload-build', { buildRunId: 'r' }, noArtifact.context), 'MISSING_REQUIREMENT');
});

const TERRITORIES = {
  data: [
    { id: 'USA', type: 'territories', attributes: { currency: 'USD' } },
    { id: 'PRI', type: 'territories', attributes: { currency: 'USD' } },
    { id: 'KOR', type: 'territories', attributes: { currency: 'KRW' } },
    { id: 'DEU', type: 'territories', attributes: { currency: 'EUR' } },
  ],
};
const PRICE_POINTS = {
  data: [
    { id: 'pp-099', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '0.99' } },
    { id: 'pp-199', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '1.99' } },
    { id: 'pp-299', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '2.99' } },
  ],
};

function createProductHandler(scheduleBodies: unknown[]): (url: string, request: ProviderRequest) => unknown {
  return (url, request) => {
    if (url.includes('/v1/apps?filter[bundleId]=')) return jsonApiApp;
    if (url.includes('/v1/territories')) return TERRITORIES;
    if (url.endsWith('/v2/inAppPurchases') && request.method === 'POST') {
      return { data: { id: 'iap-1', type: 'inAppPurchases', attributes: { state: 'MISSING_METADATA' } } };
    }
    if (url.includes('/v2/inAppPurchases/iap-1/pricePoints')) return PRICE_POINTS;
    if (url.endsWith('/v1/inAppPurchasePriceSchedules') && request.method === 'POST') {
      scheduleBodies.push(request.json);
      return { data: { id: 'sched-1', type: 'inAppPurchasePriceSchedules' } };
    }
    throw new Error(url);
  };
}

test('apple create-product validates territory currency officially and applies only the exact price point', async () => {
  const scheduleBodies: unknown[] = [];
  const { context, requests } = await createContext({
    provider: 'app-store', appIdentifier: 'com.example.demo', handler: createProductHandler(scheduleBodies),
  });
  const result = await appStoreConnector.execute(
    'create-product',
    { productId: 'com.example.demo.gems', name: 'Gems', type: 'consumable', priceMicros: 1_990_000, currency: 'USD' },
    context,
  );
  assert.equal(result.summary.appliedCustomerPrice, '1.99');
  assert.equal(result.summary.territory, 'USA');
  assert.equal((result.summary.externalIds as Record<string, string>).inAppPurchaseId, 'iap-1');
  const territoriesCall = requests.findIndex(request => request.url.includes('/v1/territories'));
  const createCall = requests.findIndex(request => request.url.endsWith('/v2/inAppPurchases') && request.options.method === 'POST');
  assert.ok(territoriesCall >= 0 && territoriesCall < createCall, 'currency must be validated before the external mutation');
  const schedule = scheduleBodies[0] as {
    data: { relationships: { baseTerritory: { data: { id: string } }; manualPrices: { data: Array<{ id: string }> } } };
    included: Array<{ id: string; relationships: { inAppPurchasePricePoint: { data: { id: string } } } }>;
  };
  assert.equal(schedule.data.relationships.baseTerritory.data.id, 'USA');
  assert.equal(schedule.data.relationships.manualPrices.data[0].id, schedule.included[0].id);
  assert.equal(schedule.included[0].relationships.inAppPurchasePricePoint.data.id, 'pp-199');
});

test('apple create-product never silently reprices: a miss returns PRICE_POINT_REQUIRED with the options', async () => {
  const scheduleBodies: unknown[] = [];
  const { context, checkpoints } = await createContext({
    provider: 'app-store', appIdentifier: 'com.example.demo', handler: createProductHandler(scheduleBodies),
  });
  const error = await expectAppError(
    appStoreConnector.execute(
      'create-product',
      { productId: 'com.example.demo.gems', name: 'Gems', type: 'consumable', priceMicros: 2_100_000, currency: 'USD' },
      context,
    ),
    'PRICE_POINT_REQUIRED',
  );
  const details = error.details as Record<string, unknown>;
  assert.equal(details.nearestBelow, '1.99');
  assert.equal(details.nearestAbove, '2.99');
  assert.equal(details.createdInAppPurchaseId, 'iap-1', 'the partially created product must stay addressable');
  assert.deepEqual(checkpoints[0], { appleInAppPurchaseId: 'iap-1', bundleId: 'com.example.demo', territory: 'USA', currency: 'USD' });
  assert.equal(scheduleBodies.length, 0, 'no schedule may be written for a non-matching price');
});

test('apple create-product rejects currencies absent from official territory metadata before any mutation', async () => {
  const scheduleBodies: unknown[] = [];
  const { context, requests } = await createContext({
    provider: 'app-store', appIdentifier: 'com.example.demo', handler: createProductHandler(scheduleBodies),
  });
  await expectAppError(
    appStoreConnector.execute(
      'create-product',
      { productId: 'p', name: 'n', type: 'consumable', priceMicros: 1_000_000, currency: 'XXX' },
      context,
    ),
    'INVALID_INPUT',
  );
  assert.ok(requests.every(request => !request.options.write), 'an unknown currency must fail before any external write');
});

test('apple update-product reprices via the spec-valid schedule/baseTerritory hops and rejects status changes', async () => {
  const handler = (url: string, request: ProviderRequest): unknown => {
    if (url.endsWith('/v2/inAppPurchases/iap-1/iapPriceSchedule')) return { data: { id: 'sched-1', type: 'inAppPurchasePriceSchedules' } };
    if (url.endsWith('/v1/inAppPurchasePriceSchedules/sched-1/baseTerritory')) {
      return { data: { id: 'KOR', type: 'territories', attributes: { currency: 'KRW' } } };
    }
    if (url.includes('/v2/inAppPurchases/iap-1/pricePoints')) {
      return { data: [{ id: 'pp-1100', type: 'inAppPurchasePricePoints', attributes: { customerPrice: '1100' } }] };
    }
    if (url.endsWith('/v1/inAppPurchasePriceSchedules') && request.method === 'POST') return { data: { id: 'sched-2', type: 'inAppPurchasePriceSchedules' } };
    throw new Error(url);
  };
  const { context } = await createContext({ provider: 'app-store', handler });
  const result = await appStoreConnector.execute('update-product', { externalId: 'iap-1', priceMicros: '1100000000' }, context);
  assert.equal(result.summary.territory, 'KOR');
  assert.equal(result.summary.currency, 'KRW');
  assert.equal(result.summary.appliedCustomerPrice, '1100');
  await expectAppError(
    appStoreConnector.execute('update-product', { externalId: 'iap-1', status: 'active' }, context),
    'UNSUPPORTED_OPERATION',
  );
});

test('apple sync aggregates developer proceeds per currency and skips missing report days', async () => {
  const tsv = [
    'Provider\tUnits\tDeveloper Proceeds\tCurrency of Proceeds',
    'APPLE\t3\t0.70\tUSD',
    'APPLE\t1\t1.05\tUSD',
    'APPLE\t2\t900\tKRW',
  ].join('\n');
  let salesCalls = 0;
  const handler = (url: string): unknown => {
    if (url.includes('/v1/salesReports')) {
      salesCalls += 1;
      if (salesCalls === 1) throw new AppError('RESOURCE_NOT_FOUND', 'report not ready', 404);
      if (salesCalls === 2) return gzipSync(Buffer.from(tsv, 'utf8'));
      throw new AppError('RESOURCE_NOT_FOUND', 'no more', 404);
    }
    throw new Error(url);
  };
  const { context } = await createContext({
    provider: 'app-store', handler,
    credentials: { keyId: 'K', issuerId: 'I', privateKey: 'P', vendorNumber: '88888888' },
  });
  const result = await appStoreConnector.execute('sync', {}, context);
  assert.equal(result.metrics?.length, 2);
  const usd = result.metrics!.find(metric => metric.currency === 'USD')!;
  assert.equal(usd.amountMicros, String(3 * 700_000 + 1 * 1_050_000));
  assert.equal(usd.basis, 'proceeds');
  const krw = result.metrics!.find(metric => metric.currency === 'KRW')!;
  assert.equal(krw.amountMicros, String(2 * 900_000_000));
  assert.equal((result.summary.missingDates as string[]).length, 4);
});

test('apple sync without vendorNumber fails with an actionable requirement', async () => {
  const { context } = await createContext({ provider: 'app-store', credentials: { keyId: 'K', issuerId: 'I', privateKey: 'P' } });
  const error = await expectAppError(appStoreConnector.execute('sync', {}, context), 'MISSING_REQUIREMENT');
  assert.match(error.message, /vendorNumber/);
});

test('apple reconcile maps the official state enum to confirmed/failed and never confirms FAILED', async () => {
  const stateHandler = (state: unknown) => (url: string): unknown => {
    if (url.endsWith('/v1/buildUploads/bu-9')) return { data: { id: 'bu-9', type: 'buildUploads', attributes: { state } } };
    throw new Error(url);
  };

  const complete = await createContext({ provider: 'app-store', handler: stateHandler({ state: 'COMPLETE', errors: [] }) });
  const completed = await appStoreConnector.execute('reconcile', { externalId: 'bu-9' }, complete.context);
  assert.deepEqual(
    { state: completed.summary.state, confirmed: completed.summary.confirmed, failed: completed.summary.failed, waiting: completed.waitingExternal },
    { state: 'COMPLETE', confirmed: true, failed: false, waiting: false },
  );

  const failedState = { state: 'FAILED', errors: [{ code: 'ASSET_VALIDATION_FAILED', description: 'Invalid signature.' }] };
  const failed = await createContext({ provider: 'app-store', handler: stateHandler(failedState) });
  const failedResult = await appStoreConnector.execute('reconcile', { externalId: 'bu-9' }, failed.context);
  assert.deepEqual(
    { state: failedResult.summary.state, confirmed: failedResult.summary.confirmed, failed: failedResult.summary.failed, waiting: failedResult.waitingExternal },
    { state: 'FAILED', confirmed: false, failed: true, waiting: false },
  );
  const details = failedResult.summary.stateDetails as Array<{ code: string }>;
  assert.equal(details[0].code, 'ASSET_VALIDATION_FAILED');

  const processing = await createContext({ provider: 'app-store', handler: stateHandler({ state: 'PROCESSING' }) });
  const processingResult = await appStoreConnector.execute('reconcile', { externalId: 'bu-9' }, processing.context);
  assert.deepEqual(
    { confirmed: processingResult.summary.confirmed, failed: processingResult.summary.failed, waiting: processingResult.waitingExternal },
    { confirmed: false, failed: false, waiting: true },
  );
});

// ---------------------------------------------------------------------------
// Steam connector
// ---------------------------------------------------------------------------

const STEAM_APP_LIST = {
  applist: { apps: [
    { appid: 480, app_name: 'Demo Game', app_type: 'game' },
    { appid: 481, app_name: 'Demo DLC', app_type: 'dlc' },
  ] },
};

test('steam check validates the partner key and reports build delivery status honestly', async () => {
  const { context, requests } = await createContext({
    provider: 'steam', credentials: { apiKey: 'PARTNERKEY123' },
    handler: url => { if (url.includes('/ISteamApps/GetPartnerAppListForWebAPIKey/v2/')) return STEAM_APP_LIST; throw new Error(url); },
  });
  const result = await steamConnector.execute('check', {}, context);
  assert.equal(result.summary.appsVisible, 2);
  const delivery = result.summary.buildDelivery as { configured: boolean };
  assert.equal(delivery.configured, false);
  assert.ok(new URL(requests[0].url).searchParams.get('key') === 'PARTNERKEY123');
  assert.ok(!JSON.stringify(result.summary).includes('PARTNERKEY123'), 'summaries must not carry the API key');
});

test('steam list-releases merges builds with live branches', async () => {
  const handler = (url: string): unknown => {
    if (url.includes('GetAppBuilds')) {
      return { response: { builds: { 101: { BuildID: 101, Description: 'nightly' }, 102: { BuildID: 102, Description: 'stable' } } } };
    }
    if (url.includes('GetAppBetas')) return { response: { betas: { public: { BuildID: 102 }, beta: { BuildID: 101 } } } };
    throw new Error(url);
  };
  const { context } = await createContext({ provider: 'steam', appIdentifier: '480', credentials: { apiKey: 'K1' }, handler });
  const result = await steamConnector.execute('list-releases', {}, context);
  const byId = new Map(result.resources!.map(resource => [resource.externalId, resource.status]));
  assert.equal(byId.get('102'), 'live:public');
  assert.equal(byId.get('101'), 'live:beta');
  assert.deepEqual((result.summary.branches as string[]).sort(), ['beta', 'public']);
});

async function makeFakeSteamcmd(behavior: 'success' | 'auth-failure' | 'success-no-config'): Promise<{ steamcmdPath: string; stateDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'fake-steamcmd-'));
  const steamcmdPath = join(stateDir, 'steamcmd.sh');
  const script = `#!/usr/bin/env node
const { writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');
const stateDir = ${JSON.stringify(stateDir)};
writeFileSync(join(stateDir, 'argv.json'), JSON.stringify(process.argv.slice(2)));
const behavior = ${JSON.stringify(behavior)};
if (behavior === 'auth-failure') {
  console.log('Connecting anonymously... FAILED (Invalid Password)');
  console.log('Cached credentials not found');
  process.exit(5);
}
const scriptIndex = process.argv.indexOf('+run_app_build') + 1;
if (!existsSync(process.argv[scriptIndex])) { console.log('missing build script'); process.exit(2); }
if (behavior === 'success') {
  mkdirSync(join(stateDir, 'config'), { recursive: true });
  writeFileSync(join(stateDir, 'config', 'config.vdf'), 'refreshed-session-v2');
}
console.log('Building depot 481 ...');
console.log('Successfully finished AppID 480 build (BuildID 123456).');
process.exit(0);
`;
  await writeFile(steamcmdPath, script, { mode: 0o755 });
  await chmod(steamcmdPath, 0o755);
  return { steamcmdPath, stateDir };
}

async function makeContentRoot(): Promise<VerifiedArtifact> {
  const path = await mkdtemp(join(tmpdir(), 'steam-content-'));
  await writeFile(join(path, 'game.bin'), Buffer.alloc(64, 3));
  return { path, name: 'steam-content', size: 64, sha256: 'x'.repeat(64), kind: 'directory' };
}

test('steam upload-build drives SteamCMD without secrets in argv and persists the rotated session', async () => {
  const { steamcmdPath, stateDir } = await makeFakeSteamcmd('success');
  const artifact = await makeContentRoot();
  const handler = (url: string): unknown => {
    if (url.includes('GetAppBuilds')) return { response: { builds: { 123456: { BuildID: 123456, Description: 'AppOps run-9' } } } };
    throw new Error(url);
  };
  const { context, checkpoints, savedCredentials, dispatchedCount } = await createContext({
    provider: 'steam', appIdentifier: '480', artifact, handler,
    credentials: { apiKey: 'PARTNERKEY123', buildUsername: 'builder_bot', steamcmdPath },
  });

  const result = await steamConnector.execute('upload-build', { buildRunId: 'run-9' }, context);

  assert.equal((result.summary.externalIds as Record<string, string>).steamBuildId, '123456');
  assert.equal(result.summary.confirmedRemotely, true);
  assert.equal(result.waitingExternal, undefined);
  assert.equal(result.resources?.[0]?.externalId, '123456');
  assert.ok(dispatchedCount() >= 1, 'CLI external effect must be marked dispatched');
  assert.equal(checkpoints[0]?.phase, 'steamcmd-started', 'dispatch checkpoint must precede the CLI run');

  const argv = JSON.parse(await readFile(join(stateDir, 'argv.json'), 'utf8')) as string[];
  // The exact argv proves the login carries only the account name: no
  // password, token, or API key ever reaches the command line.
  assert.deepEqual(argv, ['+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1', '+login', 'builder_bot', '+run_app_build', argv[7], '+quit']);
  assert.ok(!argv.some(argument => argument.includes('PARTNERKEY123')), 'the API key may not appear in argv');

  const vdf = await readFile(argv[7], 'utf8');
  assert.match(vdf, /"AppID"\t\t"480"/);
  assert.match(vdf, /"481"/);
  assert.match(vdf, /"ContentRoot"\t\t"[^"]*steam-content/);
  assert.ok(!vdf.includes('SetLive'), 'internal track must not set any branch live');

  assert.equal(savedCredentials.length, 1, 'rotated SteamCMD session must be saved back');
  assert.equal(Buffer.from(savedCredentials[0].steamSessionConfig, 'base64').toString('utf8'), 'refreshed-session-v2');
  assert.equal(savedCredentials[0].apiKey, 'PARTNERKEY123', 'other credential fields must survive');
});

test('steam upload-build restores a vaulted session and skips re-saving unchanged config', async () => {
  const { steamcmdPath, stateDir } = await makeFakeSteamcmd('success-no-config');
  const artifact = await makeContentRoot();
  const stored = Buffer.from('vault-session-v1').toString('base64');
  const { context, savedCredentials } = await createContext({
    provider: 'steam', appIdentifier: '480', artifact,
    credentials: { buildUsername: 'builder_bot', steamcmdPath, steamSessionConfig: stored, depotId: '9000' },
  });
  const result = await steamConnector.execute('upload-build', { buildRunId: 'run-2', track: 'beta' }, context);
  assert.equal(await readFile(join(stateDir, 'config', 'config.vdf'), 'utf8'), 'vault-session-v1', 'vault backup must be restored');
  assert.equal(savedCredentials.length, 0, 'unchanged session must not be re-saved');
  assert.equal(result.summary.confirmedRemotely, false, 'no apiKey means no remote confirmation claim');
  const argv = JSON.parse(await readFile(join(stateDir, 'argv.json'), 'utf8')) as string[];
  const vdf = await readFile(argv[7], 'utf8');
  assert.match(vdf, /"SetLive"\t\t"beta"/);
  assert.match(vdf, /"9000"/);
});

test('steam upload-build surfaces a missing SteamCMD session as an explicit one-time login requirement', async () => {
  const { steamcmdPath } = await makeFakeSteamcmd('auth-failure');
  const artifact = await makeContentRoot();
  const { context } = await createContext({
    provider: 'steam', appIdentifier: '480', artifact,
    credentials: { apiKey: 'K', buildUsername: 'builder_bot', steamcmdPath },
  });
  const error = await expectAppError(steamConnector.execute('upload-build', { buildRunId: 'run-3' }, context), 'AUTH_REQUIRED');
  assert.match(error.message, /대화형으로 로그인/);
});

test('steam upload-build enforces trusted configuration and refuses public track automation', async () => {
  const artifact = await makeContentRoot();
  const good = await makeFakeSteamcmd('success');
  const publicTrack = await createContext({
    provider: 'steam', appIdentifier: '480', artifact,
    credentials: { buildUsername: 'b', steamcmdPath: good.steamcmdPath },
  });
  await expectAppError(steamConnector.execute('upload-build', { buildRunId: 'r', track: 'public' }, publicTrack.context), 'UNSUPPORTED_OPERATION');

  const badPath = await createContext({
    provider: 'steam', appIdentifier: '480', artifact,
    credentials: { buildUsername: 'b', steamcmdPath: '/usr/bin/env' },
  });
  await expectAppError(steamConnector.execute('upload-build', { buildRunId: 'r' }, badPath.context), 'MISSING_REQUIREMENT');

  // steamcmdPath comes only from connection settings; action input is ignored.
  const injected = await createContext({
    provider: 'steam', appIdentifier: '480', artifact,
    credentials: { buildUsername: 'b' },
  });
  await expectAppError(
    steamConnector.execute('upload-build', { buildRunId: 'r', steamcmdPath: good.steamcmdPath }, injected.context),
    'MISSING_REQUIREMENT',
  );

  const fileArtifact = await createContext({
    provider: 'steam', appIdentifier: '480',
    artifact: { path: '/tmp/file.zip', name: 'file.zip', size: 1, sha256: 'a', kind: 'file' },
    credentials: { buildUsername: 'b', steamcmdPath: good.steamcmdPath },
  });
  await expectAppError(steamConnector.execute('upload-build', { buildRunId: 'r' }, fileArtifact.context), 'MISSING_REQUIREMENT');
});

test('steam sync pages GetDetailedSales per date and reports USD net sales as estimated', async () => {
  const salesByCall: Array<{ results?: Array<Record<string, unknown>>; max_id?: number }> = [];
  const handler = (url: string): unknown => {
    if (!url.includes('GetDetailedSales')) throw new Error(url);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('key'), 'FINKEY');
    const highwatermark = parsed.searchParams.get('highwatermark_id');
    // Only the first requested date has data, split across two pages.
    if (salesByCall.length === 0 && highwatermark === '0') {
      salesByCall.push({});
      return { response: { results: [{ appid: 480, net_sales_usd: '10.5000', gross_sales_usd: '13.0000', gross_returns_usd: '1.0000' }], max_id: 77 } };
    }
    if (highwatermark === '77') {
      return { response: { results: [{ appid: 481, net_sales_usd: '2.2500', gross_sales_usd: '2.5000', gross_returns_usd: '0.0000' }], max_id: 77 } };
    }
    return { response: { results: [] } };
  };
  const { context } = await createContext({ provider: 'steam', credentials: { apiKey: 'PUBKEY', financialApiKey: 'FINKEY' }, handler });
  const result = await steamConnector.execute('sync', {}, context);
  assert.equal(result.metrics?.length, 1);
  assert.equal(result.metrics![0].currency, 'USD');
  assert.equal(result.metrics![0].basis, 'estimated');
  assert.equal(result.metrics![0].amountMicros, String(10_500_000 + 2_250_000));
  const perApp = result.summary.perApp as Record<string, string>;
  assert.equal(perApp['480'], '10500000');
  assert.equal(perApp['481'], '2250000');
  assert.equal(result.summary.grossUsdMicros, String(13_000_000 + 2_500_000));
  assert.equal(result.summary.returnsUsdMicros, '1000000');
});

test('steam upload-build cancellation kills the whole SteamCMD process tree without leaking secrets', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'fake-steamcmd-cancel-'));
  const steamcmdPath = join(stateDir, 'steamcmd.sh');
  // The fake tool spawns a grandchild and then hangs, like SteamCMD helpers.
  await writeFile(steamcmdPath, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const child = spawn('sleep', ['600'], { stdio: 'ignore' });
writeFileSync(join(${JSON.stringify(stateDir)}, 'pids.json'), JSON.stringify({ parent: process.pid, child: child.pid }));
console.log('logged in; uploading forever...');
setTimeout(() => {}, 600000);
`, { mode: 0o755 });
  await chmod(steamcmdPath, 0o755);
  const artifact = await makeContentRoot();
  const abort = new AbortController();
  const workDirectory = await mkdtemp(join(tmpdir(), 'store-conn-'));
  const now = new Date().toISOString();
  const progressLines: string[] = [];
  const context: ConnectorContext = {
    connection: {
      id: 'conn-1', provider: 'steam', label: 't', accountId: 'a', status: 'connected',
      createdAt: now, updatedAt: now, lastCheckedAt: null, lastError: null, authKind: 't', credentialFields: [],
    },
    credentials: { apiKey: 'PARTNERKEY123', buildUsername: 'builder_bot', steamcmdPath },
    project: {
      id: 'p', createdAt: now, updatedAt: now, policy: DEFAULT_POLICY, rootPath: workDirectory, name: 'demo',
      engine: 'unknown', engineVersion: null, appIdentifier: '480', targets: [], findings: [], inspectedAt: now,
    },
    signal: abort.signal,
    artifact,
    workDirectory,
    markDispatched: () => {},
    checkpoint: () => {},
    saveCredentials: async () => {},
    accessToken: async () => 't',
    request: async () => { throw new Error('no HTTP expected'); },
    progress: message => { progressLines.push(message); },
  };
  const running = steamConnector.execute('upload-build', { buildRunId: 'run-c' }, context);
  // Wait until the fake tool reported its pids, then cancel.
  let pids: { parent: number; child: number } | undefined;
  for (let attempt = 0; attempt < 100 && !pids; attempt += 1) {
    await new Promise(resolvePause => setTimeout(resolvePause, 50));
    pids = await readFile(join(stateDir, 'pids.json'), 'utf8').then(JSON.parse).catch(() => undefined);
  }
  assert.ok(pids, 'fake steamcmd must have started');
  abort.abort();
  await expectAppError(running, 'CANCELLED');
  await new Promise(resolvePause => setTimeout(resolvePause, 200));
  for (const [label, pid] of Object.entries(pids!)) {
    assert.throws(() => process.kill(pid, 0), `${label} process ${pid} must be dead after cancellation`);
  }
  assert.ok(!progressLines.some(line => line.includes('PARTNERKEY123')), 'progress must not leak the API key');
});

test('both connectors reject unknown operations instead of faking support', async () => {
  const apple = await createContext({ provider: 'app-store' });
  await expectAppError(appStoreConnector.execute('create-campaign', {}, apple.context), 'UNSUPPORTED_OPERATION');
  const steam = await createContext({ provider: 'steam' });
  await expectAppError(steamConnector.execute('create-product', {}, steam.context), 'UNSUPPORTED_OPERATION');
  assert.ok(!appStoreConnector.capability.operations.includes('create-campaign'));
  assert.ok(!steamConnector.capability.operations.includes('create-product'));
});
