import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../packages/connectors/transport.js';

test('Google disabled APIs report setup instructions without copying provider secrets', async () => {
  for (const [provider, host, api] of [
    ['google-play', 'androidpublisher.googleapis.com', 'Google Play Android Developer API'],
    ['google-ads', 'googleads.googleapis.com', 'Google Ads API'],
    ['admob', 'admob.googleapis.com', 'AdMob API'],
  ] as const) {
    const request = createTransport({ provider, signal: new AbortController().signal, markDispatched() {},
      fetch: async () => Response.json({ error: { message: 'secret-never-show', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://secret.example' } }] } }, { status: 403 }) });
    await assert.rejects(request('https://' + host + '/test'), error => {
      assert.equal((error as Error & { code: string }).code, 'PERMISSION_REQUIRED');
      assert.ok((error as Error).message.includes(api));
      assert.ok(!(error as Error).message.includes('secret'));
      return true;
    });
  }
});

test('Google permission diagnostics retain safe fallback for malformed and oversized bodies', async () => {
  for (const body of ['not json secret', JSON.stringify({ error: { details: ['unexpected'] } }), 'x'.repeat(65537)]) {
    const request = createTransport({ provider: 'google-play', signal: new AbortController().signal, markDispatched() {}, fetch: async () => new Response(body, { status: 403 }) });
    await assert.rejects(request('https://androidpublisher.googleapis.com/test'), { code: 'PERMISSION_REQUIRED', message: '이 작업에 필요한 서비스 권한이 없습니다.' });
  }
});

test('Ads production access denial explains Cloud approval without exposing upstream details', async () => {
  const request = createTransport({ provider: 'google-ads', signal: new AbortController().signal, markDispatched() {}, fetch: async () => Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'private-provider-text' }] }] } }, { status: 403 }) });
  await assert.rejects(request('https://googleads.googleapis.com/v25/test'), error => {
    assert.equal((error as {code: string}).code, 'PERMISSION_REQUIRED');
    assert.match((error as Error).message, /Explorer/);
    assert.doesNotMatch((error as Error).message, /private-provider-text/);
    return true;
  });
});

test('transport refuses unclassified writes before network, journals classified writes before fetch', async () => {
  let sent = 0; let journaled = 0;
  const request = createTransport({ provider: 'google-play', signal: new AbortController().signal,
    markDispatched: () => { journaled++; }, fetch: async () => { assert.equal(journaled, 1); sent++; return Response.json({ id: '1' }); } });
  const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/pkg/edits';
  await assert.rejects(request(url, { method: 'POST', json: {} }), { code: 'EFFECT_CLASSIFICATION_REQUIRED' });
  await assert.rejects(request(url, { method: 'POST', json: {}, write: false }), { code: 'INVALID_EFFECT_CLASSIFICATION' });
  assert.equal(sent, 0);
  await request(url, { method: 'POST', json: {}, write: true });
  await request(url, { method: 'POST', json: {}, write: true });
  assert.equal(sent, 2); assert.equal(journaled, 1);
});
test('documented query POST is a read; credentials cannot be redirected to arbitrary hosts', async () => {
  let journaled = 0;
  const request = createTransport({ provider: 'google-ads', signal: new AbortController().signal,
    markDispatched: () => { journaled++; }, fetch: async (_url, init) => { assert.equal(init?.redirect, 'error'); return Response.json({ results: [] }); } });
  await request('https://googleads.googleapis.com/v25/customers/123/googleAds:search', { method: 'POST', json: { query: 'SELECT campaign.id FROM campaign' }, write: false });
  assert.equal(journaled, 0);
  await assert.rejects(request('https://attacker.example/data'), { code: 'INVALID_PROVIDER_URL' });
  await assert.rejects(request('https://secret@googleads.googleapis.com/path'), { code: 'INVALID_PROVIDER_URL' });
});
test('Apple permits only exact upload URLs obtained from authenticated API response', async () => {
  const upload = 'https://upload.apple.com/signed?capability=test-fixture'; let count = 0;
  const request = createTransport({ provider: 'app-store', signal: new AbortController().signal, markDispatched() {},
    fetch: async url => { count++; return String(url).startsWith('https://api.appstoreconnect.apple.com')
      ? Response.json({ data: { attributes: { uploadOperations: [{ url: upload }] } } }) : new Response(null, { status: 204 }); } });
  await assert.rejects(request(upload, { method: 'PUT', write: true }), { code: 'INVALID_PROVIDER_URL' });
  await request('https://api.appstoreconnect.apple.com/v1/buildUploadFiles', { method: 'POST', json: {}, write: true });
  await assert.rejects(request(upload, { method: 'PUT', write: true, headers: { Authorization: 'private' } }), { code: 'INVALID_UPLOAD_HEADERS' });
  await request(upload, { method: 'PUT', write: true, body: Buffer.from('file') });
  await assert.rejects(request(upload + '-other', { method: 'PUT', write: true }), { code: 'INVALID_PROVIDER_URL' });
  assert.equal(count, 2);
});
