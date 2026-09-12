import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../packages/connectors/transport.js';

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
