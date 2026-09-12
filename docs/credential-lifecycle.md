# 자격 증명 수명주기

Last Updated: 2026-09-11
담당 모듈: `packages/credentials/` (진입점 `packages/credentials/index.ts`)
계약 원본: [구현 계약 — 자격 증명 모듈 계약](implementation-contract.md#자격-증명-모듈-계약)
관련 작업: [T-2.3](../dev/active/app-operations-platform/app-operations-platform-tasks.md), [개발계획 v1 7절](../dev/active/app-operations-platform/app-operations-platform-plan.md)

v2의 SSH 개인 키·Android 키스토어 버전·사용 중 삭제 보호는 [빌드 키 관리](build-credentials.md), X/Threads의 OAuth·자동 갱신·재연결은 [소셜 운영](social-operations.md)을 따른다. 같은 vault를 사용하며 서비스 비밀과 빌드 비밀의 공개 메타데이터를 분리한다.

## 구성 요소

| 구성 요소 | 역할 |
|---|---|
| `CredentialVault` | 연결 ID별 자격 증명(`Record<string,string>`)을 AES-256-GCM으로 암호화해 파일로 보관 |
| `KeyringKeyProvider` | OS 보관함(`@napi-rs/keyring` 2.0.0 `AsyncEntry`)에서 마스터키를 읽고 쓰는 기본 KeyProvider |
| `TokenManager` | 공급자별 액세스 토큰 발급·캐시·갱신 직렬화·refresh token 회전 저장 |
| `GoogleOAuthBroker` | Google 데스크톱 OAuth의 PKCE·state·loopback redirect 처리 |
| `createAppleJwt` / `verifyAppleJwt` | App Store Connect용 ES256 JWT 생성·검증 |

## 저장 구조와 암호화

- 마스터키: 32바이트 난수. OS 보관함의 자체 네임스페이스(`app-operations-platform` / `credential-vault-master-key`) 한 곳에만 저장한다. 다른 서비스의 항목을 열람·검색하지 않으며 `findCredentials` 계열 API는 사용하지 않는다.
- 자격 증명 파일: vault 디렉터리의 `<id>.cred.json` 하나당 연결 하나. AES-256-GCM, 96-bit(12바이트) 난수 nonce, 16바이트 auth tag, AAD는 `app-ops-credential|schema:1|id:<id>|key:1`이다. id·schema·keyVersion이 AAD에 묶여 있어 파일을 다른 id로 복사하면 복호화가 실패한다.
- 파일 쓰기는 임시 파일(0o600, `wx`) 작성 → fsync → rename의 원자 교체로 수행한다. 디렉터리는 0o700으로 생성한다.
- id 검증: `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` 형식만 허용하고 경로 구분자·`..`·선행 `.`을 거부한다. 추가로 최종 경로가 vault 디렉터리 밖을 가리키면 거부한다(`invalid_id`).
- 평문 저장 경로는 없다. 테스트는 메모리 KeyProvider를 주입하며, 운영 코드에는 평문 fallback이 존재하지 않는다.

### `@napi-rs/keyring` 2.0.0 실측 주의점

`AsyncEntry.getSecret()`의 타입 선언은 `Promise<Uint8Array | undefined>`이지만 실제 네이티브 바인딩은 항목이 없을 때 `null`을 resolve한다. `KeyringKeyProvider`는 `null`/`undefined`를 모두 "키 부재"로 처리하고, promise 거부(잠긴 보관함, secret service 미접근)는 `vault_locked`로 매핑한다.

## 마스터키 상태와 복구

| 상태 | 판정 | 동작 |
|---|---|---|
| 사용 가능 | `status()` → `{available:true, backend:'os-keyring'}` | 정상 읽기/쓰기 |
| 빈 vault + 키 없음 | 사용 가능으로 표시 | 첫 `set()`에서 새 마스터키를 생성해 보관함에 저장 |
| 잠김/접근 불가 | KeyProvider가 거부 → `vault_locked`(retryable) | fail closed. 재로그인이 아니라 보관함 잠금 해제·세션 로그인 후 재시도 |
| 키 유실(암호문 존재) | `master_key_missing` | **새 키를 절대 생성하지 않는다.** 키 백업 복원 또는 사용자가 연결을 해제하고 다시 등록해야 한다 |

키 유실과 잠김은 서로 다른 코드로 구분되며, 잠김을 이유로 재로그인·재발급을 요구하지 않는다.

## 공급자별 인증

| 공급자 | vault 필드 | 발급 방식 |
|---|---|---|
| google-play, google-ads, admob (서비스 계정) | `serviceAccountJson` | RS256 assertion(JWT bearer)으로 액세스 토큰 발급. **assertion의 aud와 POST 대상 모두 고정 endpoint `https://oauth2.googleapis.com/token`이며 JSON의 `token_uri`는 무시한다** |
| google-play, google-ads, admob (OAuth) | `clientId`, `clientSecret?`, `refreshToken` | `refresh_token` grant. scopes를 지정하면 down-scope 요청 |
| app-store | `keyId`, `issuerId`, `privateKey` (EC P-256) | 로컬에서 ES256 JWT 생성(수명 기본 15분, 최대 20분 미만, aud `appstoreconnect-v1`). HTTP 호출 없음 |
| steam, applovin-ads, applovin-max | `apiKey` | vault에서 읽어 그대로 반환 |

### 토큰 캐시·갱신·회전

- 캐시는 연결 ID × 정규화된 scope 집합(중복 제거·정렬) 단위다. 만료 60초 전을 만료로 취급하며, 그보다 짧게 발급된 토큰은 캐시하지 않는다.
- 같은 연결의 갱신은 프로세스 내에서 직렬화된다. 동시 호출은 하나의 HTTP 요청을 공유하고, refresh token 회전 쓰기가 서로 경쟁하지 않는다.
- Google이 새 `refresh_token`을 돌려준 경우에만 vault에 다시 저장한다(기존 필드는 보존). 응답에 없거나 동일하면 저장된 값을 덮어쓰지 않는다.
- `invalidate(id)`는 해당 연결의 캐시를 비워 다음 호출에서 강제로 재발급한다. 연결 해제 시에는 `vault.remove(id)`와 함께 호출한다.

## Google OAuth 흐름 (GoogleOAuthBroker)

1. `begin()`: 난수 state(32바이트)·PKCE verifier(48바이트)를 생성하고 S256 challenge를 포함한 `https://accounts.google.com/o/oauth2/v2/auth` URL을 만든다. `access_type=offline`, `prompt=consent`로 refresh token 발급을 보장한다.
2. redirect URI는 loopback(`localhost`, `127.0.0.1`, `[::1]`)만 허용한다(`invalid_redirect_uri`).
3. state·verifier는 프로세스 메모리에만 존재한다(최대 100건, TTL 10분). 디스크·vault·로그에 기록하지 않는다.
4. `complete()`: state는 네트워크 호출 전에 소모되는 **일회성**이며, 만료 시 `oauth_state_expired`, 재사용·미발급 시 `oauth_state_invalid`다.
5. 교환 결과에 refresh token이 없으면 `oauth_exchange_incomplete`로 실패한다. 성공 시 `{clientId, clientSecret?, refreshToken, grantedScopes?}`를 반환하며, 호출자가 이를 `vault.set(connectionId, …)`으로 저장한 뒤 `TokenManager`가 소비한다.

## 오류 코드

모든 오류는 `CredentialError`이며 `code`(안정 식별자), `retryable`, 비밀이 없는 `message`를 가진다. 토큰·키·verifier·authorization code·자격 증명 값은 어떤 오류 메시지에도 포함하지 않는다. 공급자 오류는 `invalid_grant` 같은 식별자만 포함하고 description은 버린다.

| code | 의미 | 사용자 조치 |
|---|---|---|
| `vault_locked` | OS 보관함 잠김·접근 불가 (retryable) | 보관함 잠금 해제 후 자동 복구 |
| `vault_unavailable` | 보관함 백엔드 로드·파일 접근 실패 | 환경 점검 |
| `master_key_missing` | 암호문 존재 + 마스터키 부재 | 키 복원 또는 연결 재등록 |
| `decrypt_failed` | 무결성 검증 실패(변조·id 복사·다른 키) | 해당 연결 재등록 |
| `storage_corrupted` | 파일 형식·스키마 손상 | 해당 연결 재등록 |
| `credential_not_found` / `invalid_id` / `invalid_credentials` / `invalid_scopes` | 잘못된 조회·입력 | 호출측 수정 |
| `token_temporarily_unavailable` | 429/5xx/네트워크 오류 (retryable) | 자동 재시도. **재로그인으로 분류하지 않는다** |
| `reauthorization_required` | `invalid_grant` 또는 refresh token 부재 | 사용자 재승인 1회 |
| `token_request_rejected` / `token_response_invalid` | 그 외 4xx·비정상 응답 | 원인 확인 |
| `invalid_redirect_uri` / `invalid_oauth_input` / `oauth_state_invalid` / `oauth_state_expired` / `oauth_exchange_incomplete` | OAuth 흐름 오류 | 새 승인 시작 |
| `unsupported_provider` / `jwt_invalid` | 미지원 공급자·JWT 검증 실패 | 호출측 수정 |

## 연결 해제와 재사용

- 연결 등록·수정·OAuth 완료에는 공개 메타데이터만 포함하는 DB 변경 의도를 먼저 기록한다. 임의 커밋 표식을 암호문 안에 함께 저장한 뒤 메타데이터·이력·변경 의도 제거를 하나의 DB 트랜잭션으로 반영한다. 표식은 자격 증명 필드 목록이나 화면에 반환하지 않는다.
- vault 저장 후 DB 반영이 실패하면 다음 상태 갱신 또는 제어 서비스 재시작에서 표식이 일치하는 변경을 복구한다. OAuth 승인을 다시 교환하지 않는다. vault 쓰기 전에 실패한 변경은 이전 암호문의 다른 표식을 보고 폐기하므로 이전 토큰에 새 메타데이터를 연결하지 않는다. OS 보관함이 잠겨 있으면 복구를 대기하고 화면에서 상태를 확인할 수 있다.
- 메타데이터와 이력 저장 실패·DB 재시작 회귀 검사는 `tests/credential-commit.test.ts`에 있다. 시스템 저장 장치가 모두 실패하거나 외부 서비스가 승인 자체를 취소하는 상황까지 인증 지속을 보장하지는 않는다.

- 연결 해제: `tokenManager.invalidate(id)` → `vault.remove(id)`. 파일 삭제는 멱등이다.
- 여러 프로젝트가 같은 연결 ID를 참조하며 자격 증명을 복사하지 않는다. 정상 갱신·재시작·프로젝트 추가에서 재로그인을 요구하지 않는다.

## 검증 상태 (2026-09-11)

- 완료(모의 경계 검증): `tests/credentials.test.ts` 26개 테스트 — AES-GCM 왕복·변조·AAD(id) 교차 복사 차단, 키 유실 시 재생성 금지, 잠김/부재 구분, id path validation, 원자 쓰기 잔류물 없음, 메모리 KeyProvider·모의 fetch 기반 SA assertion(고정 endpoint·RS256 서명 검증), scope별 캐시·동시 갱신 직렬화·회전 저장, 오류 분류(임시 vs invalid_grant)·비밀 없는 메시지, Apple ES256 생성·검증·수명 상한, PKCE challenge/verifier 일치·state 일회성·TTL·loopback 검증. 실행: `node --import tsx --test tests/credentials.test.ts`.
- 완료(실환경 읽기 전용): 이 Linux 장비에서 기본 `KeyringKeyProvider`로 `status()` 확인 — `{available:true, backend:'os-keyring'}`. 실측에서 `getSecret()`의 null 반환 특성을 확인해 반영했다. 마스터키 쓰기는 수행하지 않았다.
- 미완료(실계정 없음): Google/Apple/Steam/AppLovin 실계정 토큰 발급, 실제 refresh token 회전, macOS/Windows 보관함 동작, 보관함 잠김 실환경 재현. V-02의 실계정 게이트는 T-2.1 계정 확보 후 수행한다.
