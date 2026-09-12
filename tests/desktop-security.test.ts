// 데스크톱 보안 경계 검증. Electron 의존성 없는 순수 로직(security.ts)을 대상으로 한다.
// - IPC 경로/메서드 화이트리스트
// - openExternal 외부 URL 허용 목록(HTTPS, 호스트 제한, 서브도메인 위조 차단)
// - 로그 자격 증명 마스킹
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedApiPath,
  isAllowedExternalUrl,
  isLoopbackDevUrl,
  redactSecrets,
} from '../apps/desktop/electron/security.js';
import { buildOperationInput, mergeOperationFields, specFor } from '../apps/desktop/src/operations.js';
import type { OpField } from '../apps/desktop/src/operations.js';

test('허용된 API 경로만 통과한다', () => {
  // 계약 표의 명시적 작업들
  assert.equal(isAllowedApiPath('GET', '/health'), true);
  assert.equal(isAllowedApiPath('GET', '/state'), true);
  assert.equal(isAllowedApiPath('POST', '/projects'), true);
  assert.equal(isAllowedApiPath('DELETE', '/projects/abc123'), true);
  assert.equal(isAllowedApiPath('POST', '/projects/abc/inspect'), true);
  assert.equal(isAllowedApiPath('PUT', '/projects/abc/policy'), true);
  assert.equal(isAllowedApiPath('POST', '/projects/abc/build'), true);
  assert.equal(isAllowedApiPath('POST', '/runs/r-1/cancel'), true);
  assert.equal(isAllowedApiPath('POST', '/runs/r-1/retry'), true);
  assert.equal(isAllowedApiPath('POST', '/connections'), true);
  assert.equal(isAllowedApiPath('POST', '/connections/c1/check'), true);
  assert.equal(isAllowedApiPath('DELETE', '/connections/c1'), true);
  assert.equal(isAllowedApiPath('POST', '/connections/c1/actions'), true);
  // OAuth 온보딩·재인증, 자격 증명 수정, 외부 쓰기 재조정
  assert.equal(isAllowedApiPath('POST', '/oauth/google/start'), true);
  assert.equal(isAllowedApiPath('POST', '/connections/c1/oauth/start'), true);
  assert.equal(isAllowedApiPath('PUT', '/connections/c1/credentials'), true);
  assert.equal(isAllowedApiPath('POST', '/runs/r-1/reconcile'), true);
  // 빌드 서명·SSH 자격 증명, 프로젝트 빌드 보안
  assert.equal(isAllowedApiPath('POST', '/build-credentials'), true);
  assert.equal(isAllowedApiPath('PUT', '/build-credentials/bc1'), true);
  assert.equal(isAllowedApiPath('DELETE', '/build-credentials/bc1'), true);
  assert.equal(isAllowedApiPath('PUT', '/projects/abc/build-security'), true);
  // 커뮤니티(SNS) 정책·예약·소셜 OAuth
  assert.equal(isAllowedApiPath('PUT', '/projects/abc/social-policy'), true);
  assert.equal(isAllowedApiPath('POST', '/social/schedules'), true);
  assert.equal(isAllowedApiPath('DELETE', '/social/schedules/s1'), true);
  assert.equal(isAllowedApiPath('POST', '/oauth/social/x/start'), true);
  assert.equal(isAllowedApiPath('POST', '/oauth/social/threads/start'), true);
  assert.equal(isAllowedApiPath('POST', '/connections/c1/oauth/social/start'), true);
});

test('커뮤니티(SNS) 경로의 잘못된 메서드·미허용 공급자를 거부한다', () => {
  assert.equal(isAllowedApiPath('POST', '/oauth/social/mastodon/start'), false); // 미허용 공급자
  assert.equal(isAllowedApiPath('GET', '/oauth/social/x/start'), false); // 메서드
  assert.equal(isAllowedApiPath('GET', '/social/schedules'), false); // 목록은 /state로만
  assert.equal(isAllowedApiPath('DELETE', '/social/schedules'), false); // 대상 없는 취소
  assert.equal(isAllowedApiPath('POST', '/projects/abc/social-policy'), false); // 메서드
  assert.equal(isAllowedApiPath('PUT', '/projects/abc/social-policy/extra'), false); // 여분 세그먼트
});

test('빌드 자격 증명 경로의 잘못된 메서드·구조를 거부한다', () => {
  assert.equal(isAllowedApiPath('GET', '/build-credentials'), false); // 목록은 /state로만 노출(비밀 없음)
  assert.equal(isAllowedApiPath('GET', '/build-credentials/bc1'), false); // 개별 조회(비밀 노출) 불가
  assert.equal(isAllowedApiPath('POST', '/build-credentials/bc1'), false); // 메서드
  assert.equal(isAllowedApiPath('PUT', '/build-credentials/bc1/reveal'), false); // 비밀 노출 시도 차단
  assert.equal(isAllowedApiPath('DELETE', '/build-credentials'), false); // 대상 없는 삭제
  assert.equal(isAllowedApiPath('POST', '/projects/abc/build-security'), false); // 메서드
  assert.equal(isAllowedApiPath('PUT', '/projects/abc/build-security/extra'), false); // 여분 세그먼트
  assert.equal(isAllowedApiPath('PUT', '/build-credentials/../secrets'), false); // 경로 이탈
});

test('새 경로도 메서드/구조가 다르면 거부한다', () => {
  assert.equal(isAllowedApiPath('GET', '/oauth/google/start'), false); // 메서드
  assert.equal(isAllowedApiPath('POST', '/oauth/google'), false); // 불완전 경로
  assert.equal(isAllowedApiPath('POST', '/oauth/microsoft/start'), false); // 미허용 공급자 경로
  assert.equal(isAllowedApiPath('PUT', '/connections/c1/credentials/leak'), false); // 여분 세그먼트
  assert.equal(isAllowedApiPath('POST', '/runs/../secrets/reconcile'), false); // 경로 이탈
  assert.equal(isAllowedApiPath('GET', '/connections/c1/credentials'), false); // 저장값 조회 불가(메서드)
});

test('메서드가 다르면 거부한다', () => {
  assert.equal(isAllowedApiPath('DELETE', '/state'), false);
  assert.equal(isAllowedApiPath('GET', '/projects/abc/build'), false);
  assert.equal(isAllowedApiPath('POST', '/health'), false);
  assert.equal(isAllowedApiPath('PATCH', '/projects/abc/policy'), false);
});

test('알 수 없는/위험한 경로를 거부한다', () => {
  assert.equal(isAllowedApiPath('GET', '/admin'), false);
  assert.equal(isAllowedApiPath('POST', '/projects/../secrets'), false);
  assert.equal(isAllowedApiPath('GET', '/state?token=x'), false);
  assert.equal(isAllowedApiPath('GET', '/state#frag'), false);
  assert.equal(isAllowedApiPath('GET', 'http://127.0.0.1/state'), false); // 절대 URL
  assert.equal(isAllowedApiPath('GET', 'state'), false); // 슬래시 없음
  assert.equal(isAllowedApiPath('DELETE', '/projects/a/b'), false); // id에 슬래시 주입
  assert.equal(isAllowedApiPath('DELETE', '/projects/'), false); // 빈 세그먼트
  assert.equal(isAllowedApiPath('POST', '/connections//actions'), false); // 이중 슬래시
  assert.equal(isAllowedApiPath('DELETE', '/projects/..'), false);
  assert.equal(isAllowedApiPath('GET', '/state\\x'), false); // 백슬래시
});

test('외부 URL 허용 목록: HTTPS 허용 호스트만 통과', () => {
  assert.equal(isAllowedExternalUrl('https://play.google.com/console'), true);
  assert.equal(isAllowedExternalUrl('https://appstoreconnect.apple.com'), true);
  assert.equal(isAllowedExternalUrl('https://partner.steamgames.com/doc'), true);
  assert.equal(isAllowedExternalUrl('https://support.applovin.com/en/max'), true);
  // 허용 호스트의 서브도메인
  assert.equal(isAllowedExternalUrl('https://console.developers.google.com/x'), true);
  // Google OAuth 동의 화면(쿼리스트링 포함 허용)
  assert.equal(
    isAllowedExternalUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=y&redirect_uri=http://127.0.0.1:4317/cb'),
    true,
  );
  // 소셜 OAuth 동의 화면
  assert.equal(isAllowedExternalUrl('https://x.com/i/oauth2/authorize?client_id=x&scope=y'), true);
  assert.equal(isAllowedExternalUrl('https://threads.com/oauth/authorize?client_id=x'), true);
  assert.equal(isAllowedExternalUrl('https://threads.net/oauth/authorize?client_id=x'), true);
});

test('외부 URL 허용 목록: 위험한 URL 거부', () => {
  assert.equal(isAllowedExternalUrl('http://play.google.com'), false); // HTTP
  assert.equal(isAllowedExternalUrl('https://evil.example.com'), false); // 미허용 호스트
  // 서브도메인 위조: 허용 호스트를 접두사로 붙인 다른 도메인
  assert.equal(isAllowedExternalUrl('https://play.google.com.evil.com'), false);
  assert.equal(isAllowedExternalUrl('https://x.com.evil.com'), false);
  assert.equal(isAllowedExternalUrl('https://threads.net.evil.com'), false);
  // 자격 증명 포함 URL
  assert.equal(isAllowedExternalUrl('https://user:pass@play.google.com'), false);
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedExternalUrl(''), false);
  // @ts-expect-error 잘못된 타입도 안전하게 거부
  assert.equal(isAllowedExternalUrl(null), false);
});

test('개발 서버 URL: loopback만 창에 로드한다', () => {
  // 허용: loopback 호스트의 http/https
  assert.equal(isLoopbackDevUrl('http://127.0.0.1:5173'), true);
  assert.equal(isLoopbackDevUrl('http://localhost:5173/'), true);
  assert.equal(isLoopbackDevUrl('http://[::1]:5173'), true);
  assert.equal(isLoopbackDevUrl('https://127.0.0.1:5173'), true);
  // 거부: 외부 호스트·비 http(s)·자격 증명 포함·빈 값·잘못된 타입
  assert.equal(isLoopbackDevUrl('http://192.168.0.10:5173'), false);
  assert.equal(isLoopbackDevUrl('http://evil.example.com'), false);
  assert.equal(isLoopbackDevUrl('http://127.0.0.1.evil.com'), false);
  assert.equal(isLoopbackDevUrl('file:///etc/passwd'), false);
  assert.equal(isLoopbackDevUrl('http://user:pass@127.0.0.1:5173'), false);
  assert.equal(isLoopbackDevUrl(''), false);
  assert.equal(isLoopbackDevUrl(null), false);
  assert.equal(isLoopbackDevUrl(undefined), false);
});

test('로그 마스킹: 자격 증명 키를 제거한다', () => {
  const input = {
    label: 'my-connection',
    accountId: 'acc-1',
    credentials: { apiKey: 'super-secret', refreshToken: 'rt-123' },
    nested: { password: 'p', note: 'keep' },
    list: [{ token: 't' }, { plain: 'ok' }],
  };
  const out = redactSecrets(input) as Record<string, unknown>;
  assert.equal(out.label, 'my-connection');
  assert.equal(out.accountId, 'acc-1');
  assert.deepEqual(out.credentials, '[제거됨]'); // 'credentials' 키 자체가 비밀 힌트
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.password, '[제거됨]');
  assert.equal(nested.note, 'keep');
  const list = out.list as Record<string, unknown>[];
  assert.equal(list[0].token, '[제거됨]');
  assert.equal(list[1].plain, 'ok');
});

// --- 마케팅 작업 폼 회귀(P1 #4): 모든 외부 쓰기는 프로젝트 필수, 대상 externalId/다국가 배열/중복 externalId 방지 ---
test('모든 외부 마케팅·수익화 쓰기 작업은 프로젝트가 필수다', () => {
  for (const op of ['create-campaign', 'update-campaign', 'pause-campaign', 'create-ad-unit', 'update-ad-unit', 'create-product', 'update-product']) {
    const spec = specFor(op);
    assert.equal(spec.externalWrite, true, `${op}: externalWrite`);
    assert.equal(spec.needsProject, 'required', `${op}: needsProject required`);
  }
});

test('행(업데이트/일시중지) 작업은 대상 리소스 종류를 가진다(행 프리필 대상)', () => {
  assert.equal(specFor('update-campaign').targetKind, 'campaign');
  assert.equal(specFor('pause-campaign').targetKind, 'campaign');
  assert.equal(specFor('update-ad-unit').targetKind, 'ad-unit');
  assert.equal(specFor('update-product').targetKind, 'product');
});

test('입력 구성: money->micros, 다국가 배열, 통화, 대상 externalId', () => {
  const fields = specFor('create-campaign').fields;
  const input = buildOperationInput(fields, { name: 'Launch', dailyBudgetMicros: '10', country: 'KR, US , JP', objective: '' }, { currency: 'USD', externalId: 'camp-1' });
  assert.equal(input.dailyBudgetMicros, '10000000'); // 10 -> micros
  assert.deepEqual(input.country, ['KR', 'US', 'JP']); // 쉼표 구분 다국가 배열, 공백 정리
  assert.equal(input.currency, 'USD'); // money 필드 존재 -> 통화 포함
  assert.equal(input.externalId, 'camp-1'); // 대상 선택기가 공급
  assert.ok(!('objective' in input)); // 빈 값은 전송하지 않음
});

test('중복 externalId 방지: 스키마에 externalId 입력 필드가 있어도 대상 값만 전송한다', () => {
  const fields: OpField[] = [
    { key: 'externalId', label: '중복', type: 'text' },
    { key: 'status', label: '상태', type: 'select' },
  ];
  const input = buildOperationInput(fields, { externalId: '무시되어야-함', status: 'paused' }, { externalId: 'target-1' });
  assert.equal(input.externalId, 'target-1'); // 필드 값이 아니라 대상 값
  assert.equal(input.status, 'paused');
});

test('mergeOperationFields는 externalId를 추가하지 않는다(root가 제거함)', () => {
  const base = specFor('update-campaign').fields;
  assert.ok(!base.some((f) => f.key === 'externalId'));
  const merged = mergeOperationFields(base, [{ key: 'status', required: true }]);
  assert.ok(!merged.some((f) => f.key === 'externalId'));
});
