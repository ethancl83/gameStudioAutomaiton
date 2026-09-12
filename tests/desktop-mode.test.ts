// 실행 모드 권한 경계(main 소유)와 요청 네임스페이스 결속의 행위 검증.
// main.ts는 Electron 런타임이라 직접 단위 테스트가 어렵지만, 권한 판정의 핵심(네임스페이스 결속·신뢰
// 프레임 URL·저장 모드 정규화·다운로드 무결성 헤더 필수)은 security.ts의 순수 함수로 분리돼 있어
// 여기서 직접 검증한다. 이 함수들이 곧 main이 특권 요청/파일 브리지에서 강제하는 규칙이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedApiPath,
  isTrustedFrameUrl,
  normalizeStoredMode,
  parseDownloadExpectation,
  requestNamespaceMatches,
} from '../apps/desktop/electron/security.js';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

// ---------------------------------------------------------------------------
// 요청 네임스페이스는 main 소유의 실행 모드에 결속된다(renderer 문자열로 권한을 못 바꾼다).
// ---------------------------------------------------------------------------
test('데모 모드는 /demo 네임스페이스만 허용하고 실제 경로를 거부한다', () => {
  assert.equal(requestNamespaceMatches('demo', '/demo/state'), true);
  assert.equal(requestNamespaceMatches('demo', '/demo'), true);
  assert.equal(requestNamespaceMatches('demo', '/demo/operations/portable-backups'), true);
  // 데모 세션에서 실제(비-데모) 경로를 밀어 넣으면 불일치 → main이 거부한다(D2 방어의 핵심).
  assert.equal(requestNamespaceMatches('demo', '/state'), false);
  assert.equal(requestNamespaceMatches('demo', '/operations/portable-backups'), false);
  assert.equal(requestNamespaceMatches('demo', '/connections/c1/actions'), false);
});

test('실제 모드는 비-데모 경로만 허용하고 /demo 경로를 거부한다', () => {
  assert.equal(requestNamespaceMatches('live', '/state'), true);
  assert.equal(requestNamespaceMatches('live', '/operations/portable-backups'), true);
  // 실제 세션에서 /demo 경로는 불일치 → 거부(엄격 일치).
  assert.equal(requestNamespaceMatches('live', '/demo/state'), false);
  assert.equal(requestNamespaceMatches('live', '/demo'), false);
  assert.equal(requestNamespaceMatches('live', '/demo/reset'), false);
});

test('허용 경로여도 네임스페이스가 실행 모드와 어긋나면 결합 판정은 거부한다(경로 스왑 방지)', () => {
  // 손상된 renderer가 데모 세션에서 실제 상태를 노리는 경우: isAllowedApiPath는 통과할 수 있으나
  // 네임스페이스 결속이 거부한다. main은 두 판정을 모두 요구하므로 실제로 라우팅되지 않는다.
  const method = 'GET';
  const livePath = '/state';
  assert.equal(isAllowedApiPath(method, livePath), true); // 경로 자체는 허용 목록에 있음
  assert.equal(requestNamespaceMatches('demo', livePath), false); // 그러나 데모 모드에선 네임스페이스 불일치
  // 반대로 데모 세션의 올바른 경로는 둘 다 통과한다.
  assert.equal(isAllowedApiPath(method, '/demo/state'), true);
  assert.equal(requestNamespaceMatches('demo', '/demo/state'), true);
});

// ---------------------------------------------------------------------------
// 저장된 로컬 모드 선호 정규화: 'live'만 실제, 그 외/누락/손상은 데모(안전 기본값).
// ---------------------------------------------------------------------------
test('normalizeStoredMode는 live만 실제로, 나머지는 데모로 정규화한다', () => {
  assert.equal(normalizeStoredMode({ mode: 'live' }), 'live');
  assert.equal(normalizeStoredMode({ mode: 'demo' }), 'demo');
  assert.equal(normalizeStoredMode('live'), 'live'); // 평문도 허용
  assert.equal(normalizeStoredMode('demo'), 'demo');
  // 누락·손상·대소문자 불일치·잘못된 타입은 모두 데모(안전 기본값).
  assert.equal(normalizeStoredMode({}), 'demo');
  assert.equal(normalizeStoredMode({ mode: 'LIVE' }), 'demo');
  assert.equal(normalizeStoredMode({ mode: 1 }), 'demo');
  assert.equal(normalizeStoredMode(null), 'demo');
  assert.equal(normalizeStoredMode(undefined), 'demo');
  assert.equal(normalizeStoredMode('garbage'), 'demo');
});

// ---------------------------------------------------------------------------
// 신뢰 프레임 URL: 프로덕션은 정확한 진입 URL만, 개발은 loopback dev 서버만.
// ---------------------------------------------------------------------------
test('프로덕션: 정확한 패키지 진입 URL만 신뢰하고 임의 file://은 거부한다', () => {
  const entry = 'file:///opt/appops/resources/app/dist/apps/desktop/renderer/index.html';
  const opts = { devServerUrl: null, entryUrl: entry };
  assert.equal(isTrustedFrameUrl(entry, opts), true);
  // 같은 디렉터리의 다른 파일·상위 경로·유사 경로는 모두 거부(정확 일치).
  assert.equal(isTrustedFrameUrl('file:///opt/appops/resources/app/dist/apps/desktop/renderer/evil.html', opts), false);
  assert.equal(isTrustedFrameUrl('file:///etc/passwd', opts), false);
  assert.equal(isTrustedFrameUrl('file:///opt/appops/resources/app/dist/apps/desktop/renderer/', opts), false);
  assert.equal(isTrustedFrameUrl(`${entry}#x`, opts), false);
  assert.equal(isTrustedFrameUrl('https://evil.example.com', opts), false);
  // entryUrl 미설정이면 어떤 것도 신뢰하지 않는다.
  assert.equal(isTrustedFrameUrl(entry, { devServerUrl: null, entryUrl: null }), false);
});

test('개발: loopback dev 서버(프로토콜·호스트 일치)만 신뢰한다', () => {
  const opts = { devServerUrl: 'http://127.0.0.1:5173', entryUrl: null };
  assert.equal(isTrustedFrameUrl('http://127.0.0.1:5173/', opts), true);
  assert.equal(isTrustedFrameUrl('http://127.0.0.1:5173/index.html', opts), true);
  // 다른 호스트·프로토콜·포트는 거부.
  assert.equal(isTrustedFrameUrl('http://127.0.0.1:5999/', opts), false);
  assert.equal(isTrustedFrameUrl('https://127.0.0.1:5173/', opts), false);
  assert.equal(isTrustedFrameUrl('http://evil.example.com', opts), false);
  assert.equal(isTrustedFrameUrl('file:///x', opts), false);
});

// ---------------------------------------------------------------------------
// 네이티브 다운로드 무결성 헤더 필수(fail-closed): Content-Length + SHA-256 둘 다 있어야 저장한다.
// ---------------------------------------------------------------------------
test('parseDownloadExpectation은 길이·SHA-256이 모두 유효할 때만 통과한다', () => {
  const sha = 'a'.repeat(64);
  const ok = parseDownloadExpectation('1024', sha);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.length, 1024);
    assert.equal(ok.value.sha256, sha);
  }
  // SHA-256 대문자도 소문자로 정규화해 저장한다.
  const up = parseDownloadExpectation('10', 'A'.repeat(64));
  assert.equal(up.ok, true);
  if (up.ok) assert.equal(up.value.sha256, 'a'.repeat(64));
});

test('parseDownloadExpectation은 누락·잘못된 헤더를 거부한다(과거 fail-open 제거)', () => {
  const sha = 'a'.repeat(64);
  // SHA 누락/형식 오류
  assert.deepEqual(parseDownloadExpectation('1024', null), { ok: false, reason: 'missing_sha256' });
  assert.deepEqual(parseDownloadExpectation('1024', ''), { ok: false, reason: 'missing_sha256' });
  assert.deepEqual(parseDownloadExpectation('1024', 'xyz'), { ok: false, reason: 'missing_sha256' });
  assert.deepEqual(parseDownloadExpectation('1024', 'a'.repeat(63)), { ok: false, reason: 'missing_sha256' });
  // 길이 누락/비정수/0 이하
  assert.deepEqual(parseDownloadExpectation(null, sha), { ok: false, reason: 'missing_length' });
  assert.deepEqual(parseDownloadExpectation('', sha), { ok: false, reason: 'missing_length' });
  assert.deepEqual(parseDownloadExpectation('0', sha), { ok: false, reason: 'bad_length' });
  assert.deepEqual(parseDownloadExpectation('-5', sha), { ok: false, reason: 'bad_length' });
  assert.deepEqual(parseDownloadExpectation('12.5', sha), { ok: false, reason: 'bad_length' });
  assert.deepEqual(parseDownloadExpectation('abc', sha), { ok: false, reason: 'bad_length' });
  // 상한 초과
  const over = parseDownloadExpectation(String(512 * 1024 ** 3 + 1), sha);
  assert.deepEqual(over, { ok: false, reason: 'too_large' });
});
