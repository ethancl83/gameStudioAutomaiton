import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBuildCredential } from '../packages/build-credentials/index.js';
import { KEY_HELPER_OUTPUT_LIMIT, parseHelperResponse, type KeyHelperRequest } from '../packages/build-credentials/docker-protocol.js';

const credentials = normalizeBuildCredential('ssh', { privateKey: 'fixture-private', host: 'EXAMPLE.TEST', port: '00022', knownHosts: 'fixture-pinned' });
const request: KeyHelperRequest = { operation: 'validate', kind: 'ssh', credentials };
const metadata = { fingerprint: 'SHA256:' + 'a'.repeat(43), publicKey: 'ssh-ed25519 AAAA', details: { host: 'example.test', port: '22', username: 'git', algorithm: 'ssh-ed25519' } };
test('normalization is shared without returning credentials through the helper response', () => {
  assert.equal(credentials.privateKey, 'fixture-private\n');
  assert.equal(credentials.knownHosts, 'fixture-pinned\n');
  assert.equal(credentials.passphrase, '');
  assert.equal(credentials.port, '22');
  assert.deepEqual(parseHelperResponse(JSON.stringify({ ok: true, result: metadata }), request, 0), metadata);
  assert.deepEqual(normalizeBuildCredential('android-keystore', { keystoreBase64: 'YQ==', storePassword: 'password', keyAlias: ' release ' }),
    { keystoreBase64: 'YQ==', storePassword: 'password', keyPassword: 'password', keyAlias: 'release' });
});
test('helper responses reject secrets, unknown fields, malformed and partial output and nonzero success', () => {
  for (const output of [
    JSON.stringify({ ok: true, result: { ...metadata, credentials } }),
    JSON.stringify({ ok: true, result: { ...metadata, privateKey: 'secret' } }),
    JSON.stringify({ ok: true, result: { ...metadata, details: { ...metadata.details, passphrase: 'secret' } } }),
    JSON.stringify({ ok: true, result: { ...metadata, details: { ...metadata.details, host: 'rewritten.example.test' } } }),
    JSON.stringify({ ok: true, result: { ...metadata, publicKey: '-----BEGIN PRIVATE KEY-----' } }),
    JSON.stringify({ ok: true, result: metadata }) + '\n{}',
    '{"ok":true,', 'x'.repeat(KEY_HELPER_OUTPUT_LIMIT + 1),
  ]) assert.throws(() => parseHelperResponse(output, request, 0), { code: 'DOCKER_KEY_PROTOCOL' });
  assert.throws(() => parseHelperResponse(JSON.stringify({ ok: true, result: metadata }), request, 1), { code: 'DOCKER_KEY_PROTOCOL' });
});
test('helper failure preserves only original known AppError code', () => {
  assert.throws(() => parseHelperResponse('{"ok":false,"code":"KEY_TOOL_FAILED"}', request, 1), { code: 'KEY_TOOL_FAILED' });
  for (const output of ['{"ok":false,"code":"KEY_TOOL_FAILED","message":"secret"}', '{"ok":false,"code":"secret"}']) {
    assert.throws(() => parseHelperResponse(output, request, 1), { code: 'DOCKER_KEY_PROTOCOL' });
  }
  assert.throws(() => parseHelperResponse('{"ok":false,"code":"KEY_TOOL_FAILED"}', request, 0), { code: 'DOCKER_KEY_PROTOCOL' });
});
