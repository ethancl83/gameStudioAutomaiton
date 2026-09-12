# 소셜/커뮤니티 연동 작업 계약

Last Updated: 2026-09-11 (T-12.3 SNS 확장)

`packages/social/**`는 X(구 Twitter)·Threads·Steam 뉴스에 대한 실 제공자 어댑터를
구현한다. 모든 네트워크·비밀·durable 상태는 주입(injection)되며, 어댑터는
순수 함수처럼 동작한다. 이 모듈은 자체 완결형이라 `packages/domain`의 `Provider`
enum에 의존하지 않는다. 코디네이터(root)가 enum 확장·레지스트리 등록·durable 큐·
`CredentialVault`/`TokenManager` 연결·정책 통합을 담당한다.

## 담당 파일

- `packages/social/{index,types,transport,oauth,tokens,validate,helpers,media,x,threads,steam}.ts`
- `packages/connectors/social.ts`
- `tests/social-connectors.test.ts`, `tests/marketing-social-extensions.test.ts`
- `docs/social-operations.md` (이 문서)

이 워커는 그 외 파일을 수정하지 않는다. 실제 자격 증명·계정·게시·네트워크 쓰기는
수행하지 않았다. 검증은 주입한 모의 transport/fetch로 수행했다.

## 공개 API (`packages/social/index.ts`)

- 어댑터: `xAdapter`, `threadsAdapter`, `steamNewsAdapter`, `socialAdapterFor(provider)`,
  `socialAdapters`, `NEW_SOCIAL_PROVIDERS = ['x','threads']`
- 컨텍스트/타입: `SocialProvider`, `SocialContext`, `SocialRequest`, `SocialResult`,
  `SocialResource`, `SocialAdapter`, `SocialCapability`, `SecretStore`
- transport: `createSocialTransport`, `SOCIAL_ORIGINS`
- OAuth: `XOAuthBroker`, `ThreadsOAuthBroker` (+ 고정 엔드포인트 상수)
- 토큰: `SocialTokenManager`, `TokenConnectionRef`
- 검증: `weightedTweetLength`, `assertXText`, `threadsTextLength`, `assertThreadsText`

### SocialContext (root가 브리지)

```ts
interface SocialContext {
  connection: { id; provider; accountId; label? };
  credentials: Record<string,string>;      // 서버 내부 비밀; 응답·로그에 출력 금지
  project?: { appIdentifier: string | null };
  signal: AbortSignal;
  markDispatched();                          // prepared→dispatched 저널
  checkpoint(data);                          // 쓰기 전 durable 저널 훅
  saveCredentials(creds): Promise<void>;     // 회전 토큰 재저장
  accessToken(scopes?): Promise<string>;     // 갱신/회전 후 유효 토큰
  request<T>(url, SocialRequest): Promise<T>;// 고정 origin transport
  progress(msg); now?();
  sleep?(ms, signal): Promise<void>;         // 준비 상태 폴링용 주입형 중단 대기(선택)
}
```

`SocialResult`는 `summary`, 선택적 `resources`, `waitingExternal`, `unresolved`를
가진다. **`unresolved: true`는 전송된 쓰기의 결과를 확인하지 못한 상태**이며, root는
이를 `action_required`로 매핑하고 자동 재시도/재게시하지 않는다.

## 계정 읽기와 프로젝트 소유 쓰기의 분리

- 읽기(`check`, `list-*`, `reconcile`)는 계정 레벨이며 `connection.accountId`를 사용한다.
- 쓰기(`create-post`, `reply`, `delete-post`, `hide-reply`, `prepare-news`)는 프로젝트에 바인딩된 연결을 요구한다(`ctx.project` 필수).
  쓰기 직전 `/me`를 조회해 토큰 소유 계정이 `accountId`와 일치하는지 확인하고,
  불일치 시 `ACCOUNT_MISMATCH`로 거부한다.

## 안전장치 (모든 제공자 공통)

- **효과 분류**: 비-GET 요청은 `write: boolean`을 반드시 선언한다. transport는
  미분류 변경을 네트워크 이전에 거부하고(`EFFECT_CLASSIFICATION_REQUIRED`), 첫 쓰기를
  `markDispatched()`로 저널한 뒤에 전송한다.
- **쓰기 전 저널**: 어댑터는 전송 전에 `checkpoint()`로 의도(operation, textHash,
  Threads의 경우 containerId)를 남긴다. 본문 원문·비밀은 저널에 넣지 않는다.
- **불명확한 결과 = 미해결**: 전송 후 타임아웃/네트워크 손실/일시 오류(5xx·429)는
  결과가 불명확하므로 `unresolved: true`를 반환한다. 절대 자동 재게시하지 않고,
  타이밍/본문 매칭으로 ID를 추측하지 않는다.
- **저장 데이터 최소화**: 원격 ID·타임스탬프·permalink·공식 API가 준 metrics만 저장한다.
  임의 분석치를 만들어내지 않는다.
- **비밀 비노출**: 토큰은 Authorization 헤더로만 전달하며 URL/로그/작업 입력에 넣지 않는다.
  제공자 오류 본문(토큰이 섞일 수 있음)은 안정적인 코드로만 매핑한다.

## 고정 origin 허용목록 (`SOCIAL_ORIGINS`)

| provider | API origin | 출처(확인일 2026-09-11) |
|---|---|---|
| x | `https://api.x.com` | docs.x.com — OAuth2/Posts 참조 |
| threads | `https://graph.threads.net` | developers.facebook.com/docs/threads/posts, .../long-lived-tokens |
| threads | `https://graph.threads.com` | developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions |
| steam | `https://api.steampowered.com` | partner.steamgames.com/doc/webapi/ISteamNews |

> Meta는 현재 Threads 문서에서 `graph.threads.net`(Posts·Long-Lived Token 가이드)와
> `graph.threads.com`(Get Access Tokens 가이드)를 도메인 이전 과정에서 함께 사용하고
> 있어 두 origin 모두 고정했다. 가정적/레거시 호스트(예: `api.twitter.com`)는 추가하지 않았다.

## X (Twitter) API v2

문서: https://docs.x.com — 확인일 2026-09-11.

| 작업 | 메서드·엔드포인트 | 비고 |
|---|---|---|
| check | `GET /2/users/me` | 소유 계정 확인 |
| list-posts | `GET /2/users/:id/tweets` | `max_results`(5–100), `pagination_token`, `meta.next_token` |
| list-mentions | `GET /2/users/:id/mentions` | 멘션 타임라인 |
| create-post | `POST /2/tweets` `{ text }` | 201 → `data.id` |
| reply | `POST /2/tweets` `{ text, reply: { in_reply_to_tweet_id } }` | |
| delete-post | `DELETE /2/tweets/:id` | `data.deleted=true`. 소유 `author_id` 확인 후 삭제 |
| hide-reply | `PUT /2/tweets/:id/hidden` `{ hidden }` | `tweet.moderate.write` |

- OAuth 2.0 Authorization Code + PKCE.
  - authorize: `https://x.com/i/oauth2/authorize`
  - token: `https://api.x.com/2/oauth2/token`
  - 갱신: `grant_type=refresh_token` (범위 `offline.access` 필요). **X는 사용 시마다
    refresh 토큰을 회전**하므로 응답의 새 refresh 토큰을 원자적으로 재저장한다.
  - 기밀 클라이언트는 HTTP Basic로 인증(`client_id:client_secret`), 공개 클라이언트는 PKCE만.
- 자격 증명: `{ clientId, refreshToken, clientSecret? }` (`accountId` = X user id).

### X 텍스트 길이 검증 — 선택과 근거

출처: https://docs.x.com/resources/fundamentals/counting-characters (twitter-text v3 config).

이 모듈은 **평문 텍스트 게시글**과 공식 삭제/숨김을 지원한다. X 미디어는 INIT/APPEND 업로드 API가 필요해 URL 게시를 하지 않는다. 검증은 X의
문서화된 가중 길이(weighted length) 규칙을 그대로 사용한다.

- 기본 문자는 1, 문서의 경량 범위(주로 라틴·기호 일부)는 1, 그 외(CJK·이모지 등)는 2.
- URL은 실제 길이와 무관하게 **23**으로 계산(transformedURLLength). `http(s)://` URL과,
  X가 자동 링크하는 일반적 TLD의 scheme-less 도메인을 23으로 본다.
- 상한은 **280 가중 단위**. 초과 시 `TEXT_TOO_LONG`.

가중 계산은 항상 X의 값 이상으로 보수적으로 잡아 "제출 후 길이 초과 거부"를 사전에
막는다. 다중 코드포인트 이모지(ZWJ 시퀀스)는 구성요소별 2로 약간 과대 계상되는데,
이는 안전한 방향(더 일찍 거부)이다. 전체 linkifier를 이식하지 않고 결정적이고
검증 가능한 규칙만 사용한다.

## Threads (Meta) Graph API

문서: https://developers.facebook.com/docs/threads — 확인일 2026-09-11. Base `graph.threads.net/v1.0`.

| 작업 | 메서드·엔드포인트 | 비고 |
|---|---|---|
| check | `GET /v1.0/me` | 소유 계정 확인 |
| list-posts | `GET /v1.0/:userId/threads` | `limit`, cursor `after`(`paging.cursors.after`) |
| list-replies | `GET /v1.0/:postId/replies` | |
| create-post | `POST /v1.0/:userId/threads` (`media_type=TEXT\|IMAGE\|VIDEO\|CAROUSEL`) → container id | 1단계. IMAGE/VIDEO는 공개 https URL |
| | `GET /v1.0/:containerId?fields=id,status` | 1.5단계: `FINISHED`까지 유한·중단 가능 읽기 폴링(발행 전) |
| | `POST /v1.0/:userId/threads_publish` (`creation_id`) → media id | 2단계: `FINISHED`에서만 1회 발행 |
| list-replies | `GET /v1.0/:postId/replies` | `is_reply_owned_by_me` 포함 요청 → `data.owned` |
| reply | 1단계에 `reply_to_id` 추가 후 발행 | |
| hide-reply | `POST /v1.0/:replyId/manage_reply` `hide=true\|false` | 최상위 답글. 하위 답글은 함께 숨김 |
| delete-post | `DELETE /v1.0/:mediaId` | `threads_delete`, 계정당 하루 100회. `success`+`deleted_id` |
| reconcile | `GET /v1.0/:containerId?fields=status` | **읽기 전용, 발행 안 함**, `error_message` 미요청 |

- **POST 파라미터는 form 본문**으로 전달한다(`media_type`/`text`/`reply_to_id`,
  `creation_id`). 텍스트·토큰이 URL 쿼리에 남지 않으며, root 전송 계층의 브리지가
  `SocialRequest.form`을 `ProviderRequest` 본문(URL-encoded)으로 변환한다.
- **`reconcile` 결과 매핑**: `PUBLISHED`→`confirmed`(해결), `ERROR`/`EXPIRED`→`failed`
  (종결, 재게시 없음), 그 외(`IN_PROGRESS`/`FINISHED`/`UNKNOWN`)→`unknown`
  (`unresolved:true`, root가 action_required 유지). 미디어 ID를 추측하지 않는다.
  자유 텍스트인 `error_message`는 요청·요약에 포함하지 않는다(상태 enum만 노출).
- **답글 소유 플래그**: 답글 조회 시 공식 필드 `is_reply_owned_by_me`
  ("true if your user is the owner of the Threads reply")를 요청해 `data.owned`로
  노출한다. root는 이를 루프 가드(자기 답글에 재반응 방지)로 사용한다.
- 발행 성공 시 확정된 외부 ID(media id)를 permalink 복구 GET **이전에** checkpoint한다.

- **컨테이너 → 발행 2단계 + 발행 전 준비 상태 폴링**. 컨테이너 ID를 **폴링·발행 전에
  `checkpoint()`로 durable 저장**한다. Meta 발행 레퍼런스
  (https://developers.facebook.com/docs/threads/reference/publishing, 확인일 2026-09-11)는
  컨테이너 `status`가 `FINISHED`가 된 뒤에만 `threads_publish`를 호출하도록 요구한다.
  컨테이너가 아직 `IN_PROGRESS`인데 발행하면 실패하므로, 모듈은 발행 직전에
  `GET /:containerId?fields=id,status`를 **유한(bounded)·중단(abort) 가능한 읽기 폴링**으로
  조회하고 **`FINISHED`에서만 정확히 한 번 발행**한다. 폴링은 시도 횟수와 총 경과 시간으로
  상한이 걸려 있어 무한 대기할 수 없고, `ctx.signal` abort 시 즉시 멈춘다.
  기본 간격은 60초, 최대 6회 조회·폴링 시간 예산 5분이며 개별 HTTP 요청 시간은 별도 전송 한도를 따른다.
  상태별 처리: `FINISHED`→발행, `ERROR`/`EXPIRED`→**종결 실패(발행·재게시 없음, `outcome: failed`)**,
  `PUBLISHED`(예기치 못한 선행 발행)·상한 초과·중단→발행하지 않고 컨테이너 ID를 보존한 채
  `unresolved: true, waitingExternal: true`로 반환한다.
  제어 서비스는 `outcome: failed`를 실패 이력과 `resolved_failed` 외부 효과로 저장한다.
  이미 실패가 확인된 컨테이너는 일일 게시 한도를 계속 점유하지 않으며 일반 재시도로 재발행하지 않는다.
- 발행 자체의 결과가 불명확(타임아웃/네트워크 손실/일시 오류)해도 컨테이너 ID를 보존한 채
  `unresolved: true, waitingExternal: true`로 반환하고, 이후 `reconcile`(읽기 전용 상태 조회)로
  결과를 복구한다. **읽기 복구 중에는 절대 재발행하지 않는다.**
- 대기·sleep은 모듈이 **직접, 상한 내에서** 수행한다. 과거 문서가 명시했던 "root durable
  큐가 발행 전 대기를 관리한다"는 설명은 **사실이 아니며 삭제**했다(root에 durable
  continuation은 구현되어 있지 않다). 따라서 폴링 상한을 넘긴 뒤 컨테이너가 나중에
  `FINISHED`가 되더라도 모듈이 자동 발행하지 않으며, root는 `unresolved` 결과를
  action_required로 유지하고 읽기 전용 `reconcile`로만 상태를 확인한다.
- 테스트 용이성과 실제 취소를 위해 `SocialContext`는 선택적 `sleep(ms, signal)`·`now()`를
  주입받는다. 미주입 시 모듈은 `signal`을 존중하는 기본 타이머로 대기한다. 이 값들은
  테스트/컨트롤러가 주입하는 것이며 **사용자·operation 입력으로 제어되지 않는다.**
- OAuth 2.0 Authorization Code(비-PKCE, 기밀 클라이언트).
  - authorize: `https://threads.com/oauth/authorize`
  - 단기 토큰: `POST https://graph.threads.com/oauth/access_token`
    (`grant_type=authorization_code`) → `access_token` + `user_id`
  - 장기(60일) 교환: `GET https://graph.threads.net/access_token`
    (`grant_type=th_exchange_token`, `client_secret`, `access_token`)
  - 갱신: `GET https://graph.threads.net/refresh_access_token`
    (`grant_type=th_refresh_token`). 토큰은 **24시간 이상·미만료** 상태에서만 갱신 가능하며,
    60일간 갱신되지 않으면 만료되어 재연결이 필요하다. 모듈은 만료 임박(≤5일)·24시간 경과
    조건에서만 갱신하고 회전 토큰을 재저장한다.
- 자격 증명: `{ threadsUserId, accessToken(장기), clientSecret }` (`accountId` = threadsUserId).
- 이미지/동영상 URL은 https 공개 서버만 허용한다(localhost·사설망·file/data URI 거부). Meta가 해당 URL을 cURL한다. 로컬 파일 업로드·스크립트 실행은 없다.
- 캐러셀은 자식 컨테이너(`is_carousel_item=true`)를 FINISHED까지 만든 뒤 부모만 `threads_publish` 한다. 자식은 발행하지 않는다(2–20개).
- 기본 범위에 `threads_delete`를 포함한다. 기존 연결은 재인증이 필요할 수 있다.

### Threads 텍스트 길이 검증 — 선택과 근거 (공식 문서 재확인)

출처(정확한 링크, 확인일 2026-09-11): https://developers.facebook.com/docs/threads/posts

공식 문서의 원문 인용(각 ≤25 words):
- 길이: **"Text posts are limited to 500 characters."**
- 이모지: **"Emojis are counted as the number of UTF-8 bytes."**

root의 검증 요청에 따라 위 두 문장을 원문 그대로 재확인했다. 즉 UTF-8 바이트 계산은
추측이 아니라 공식 문서 문구다. 구현은 평문 텍스트만 지원(상한 500)하며, 일반 문자는 1,
**이모지는 문서대로 해당 문자의 UTF-8 바이트 수**로 계산한다(예: 👍 = 4바이트 = 4). CJK
등 비-이모지 문자는 1로 센다. 이모지를 무겁게 세므로 경계에서 보수적으로(더 일찍 거부)
동작한다.

## Steam 뉴스 (읽기 전용) + 게시 미지원 게이트

문서: https://partner.steamgames.com/doc/webapi/ISteamNews — 확인일 2026-09-11.

| 작업 | 메서드·엔드포인트 | 비고 |
|---|---|---|
| list-news | `GET https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/` | `appid`, `count`, `maxlength`, `enddate`. 키 불필요, 읽기 전용 |
| check | 위를 `count=1`로 호출해 도달성 확인 | |
| prepare-news | **플랫폼 조치** | Steamworks `https://partner.steamgames.com/apps/news/{appId}` URL만 반환. `published:false`, `waitingExternal:true`. HTTP 쓰기 없음 |
| publish-news / create-* / reply | **차단** | |

- Steam ISteamNews는 **GetNewsForApp / GetNewsForAppAuthed 읽기만** 문서화한다. 공지 생성 Web API는 없다.
  `prepare-news`는 Steamworks 편집 URL을 반환할 뿐 게시 성공이 아니다. 그 외 게시 계열은
  `UNSUPPORTED_OPERATION`(HTTP 422). 가짜 엔드포인트·쿠키 스크래핑은 사용하지 않는다.
- Steam 뉴스는 root의 기존 `steam` 커넥터에 접붙이는(graft) 작업이며 새 `Provider`가 아니다.
  그래서 `NEW_SOCIAL_PROVIDERS`에는 `x`, `threads`만 포함한다.
- **App ID 검증·전파**: 요청 App ID(숫자, 검증됨)를 응답 봉투의 `appnews.appid` 및 각
  뉴스 항목의 `appid`와 대조한다. 하나라도 불일치하면 `INVALID_PROVIDER_RESPONSE`로
  거부해 잘못된 프로젝트에 뉴스를 귀속시키지 않는다. 검증된 App ID는 **모든 `SocialResource`의
  `data.appId`에 실려** 나가므로, 여러 프로젝트가 하나의 `steam` 연결을 공유해도 root가
  뉴스를 소유 프로젝트로 매핑할 수 있다(root는 이 `data.appId`로 persisted 매핑/브리지를
  보정한다. 기존 정규화는 App ID를 버려 공유 연결에서 매핑이 불가능했다).

## 토큰 관리 (`SocialTokenManager`)

`new SocialTokenManager(vault: SecretStore, { fetch?, now? })`

- `getAccessToken({ id, provider })`: 연결별 비밀을 `vault.get(id)`로 읽어 유효 토큰을 반환.
  필요 시 갱신·회전 후 `vault.set(id, ...)`로 재저장하고 만료까지 캐시한다.
  연결 단위로 갱신을 직렬화하며, **대기 중 작업이 끝나면 락 맵 항목을 정리**해 무한 증가를
  막는다.
- `invalidate(id)`: 넘겨준 토큰이 **401로 거부된 경우**. 캐시를 비우고 "forced" 표시를 설정해
  다음 호출이 **아직 만료되지 않은 저장된 X 액세스 토큰도 무시하고 강제 갱신**하게 한다.
  Threads는 24h 최소 조건을 지켜, 너무 새 토큰이면 갱신 대신 재연결(`AUTH_REQUIRED`)을 요구한다.
- `reset(id)`: **명시적 교체/OAuth 재연결**로 새 비밀이 저장된 경우. 캐시와 forced 표시를 모두
  지워 다음 호출이 새로 저장된 토큰을 그대로 신뢰하게 한다(네트워크 갱신 없음).
- 회전 실패(invalid_grant, 401/400)는 일시 오류로 재시도하지 않고 `AUTH_REQUIRED`로
  올려 재연결을 요구한다. 실패 시 저장된 토큰을 덮어쓰지 않는다.
- Threads 자격 증명에는 `clientId`가 보존되어(장기 토큰 발급 시 저장) 토큰 복구/갱신에 앱
  식별자를 재연결 없이 사용할 수 있다.
- `SecretStore`는 `CredentialVault`의 `get/set` 부분집합이라 root가 실제 vault를 주입할 수 있다.

## v3 작업 분류와 화면 통합

`delete-post`와 `hide-reply`는 프로젝트 소셜 정책·동기화된 자원 소유권을 확인하는 쓰기다. Steam `prepare-news`는 프로젝트가 필요한 수동 게시 준비 안내이며 외부 HTTP 쓰기와 발행 성공을 기록하지 않는다. SDK 안내와 같은 조회 작업은 별도 읽기 분류다.

- 삭제/숨김은 게시 횟수를 소비하지 않는다. 삭제는 본인 글만, 조정은 같은 연결·프로젝트의 자원만 받는다.
- Threads의 본인 글 목록은 `owned:true`를 저장하고 답글은 제공자의 소유권 필드를 따른다.
- 공통 작성 폼에서 Threads TEXT/IMAGE/VIDEO/CAROUSEL을 선택한다. `mediaUrls`는 JSON 배열이며 커넥터가 파싱한다. 미디어는 HTTPS 공개 주소가 필요하다.
- 프로젝트 필터, 예약 생성/취소, 정책·답글 규칙과 공개 출시 공지, 작업 상세 및 실패 알림을 화면에 연결했다.

## 테스트 (`tests/social-connectors.test.ts` + `tests/marketing-social-extensions.test.ts`)

주입한 모의 transport/fetch/secret store로 다음을 검증한다.

- 텍스트 검증: X 가중 길이(CJK×2, URL=23, 280 상한), Threads 길이(이모지 UTF-8 바이트, 500 상한).
- X: 소유 계정 확인/불일치, `create-post`/`reply`의 정확한 페이로드와 쓰기 저널(checkpoint,
  응답 externalId 포함), 프로젝트 필수, 페이지네이션 상한, **타임아웃 시 미해결·비재게시**.
- Threads: **발행 전 컨테이너 ID checkpoint + 발행 후 externalId checkpoint**, form 파라미터,
  `reply_to_id`, **발행 전 준비 상태 폴링**(`IN_PROGRESS`→`FINISHED` 전이 후에만 발행, 주입
  sleep으로 대기 확인, `error_message` 미요청), **`ERROR` 상태 시 미발행·`outcome: failed`**,
  **폴링 상한 초과 시 미발행·컨테이너 보존·미해결**, **폴링 중단(abort) 시 미발행·미해결**,
  **발행 타임아웃 시 컨테이너 보존·미해결·비재발행**, `reconcile` 상태→outcome
  매핑(`error_message` 미노출, 발행 없음), `list-replies`의 `is_reply_owned_by_me`→`owned`,
  페이지네이션 상한.
- Steam: 뉴스 정규화(**검증된 `data.appId` 전파**), **요청/응답·항목 App ID 불일치 거부
  (`INVALID_PROVIDER_RESPONSE`)**, **게시 계열의 명시적 미지원 게이트(네트워크 호출 없음, 422)**.
- transport: origin 고정, 효과 분류 강제, 쓰기의 네트워크 이전 저널, 오류→안정 코드 매핑.
- 토큰: X refresh 회전 저장·캐시, **회전 실패 시 AUTH_REQUIRED·기존 토큰 보존**, 동시성 직렬화,
  **`invalidate` 강제 갱신(미만료 저장 토큰 무시) + `reset` 신뢰 복원**, Threads 조건부 갱신·
  회전 저장·만료 재연결·**forced 시 24h 최소 준수(너무 새 토큰이면 재연결)**.
- OAuth: X PKCE(S256)·state 1회성·만료·refresh 토큰 부재 거부·redirect 검증, Threads
  clientSecret 필수·장기 토큰 완료·**clientId 보존**.

## controller 통합 상태

Provider·registry·OAuth·토큰·큐·정책·예약을 통합했다. `SocialRequest.form`은 공통 transport 본문으로 전달하고, Threads의 중단 가능한 기본 폴링 타이머와 실행 중 갱신되는 queue lease를 사용한다. `UNRESOLVED`는 조치 필요, 확정 실패는 실패로 저장한다. 쓰기 응답이 불명확하면 같은 게시를 다시 보내지 않는다.

Steam 뉴스는 검증된 `data.appId`로 프로젝트에 귀속한다. 같은 계정의 다른 AppID 뉴스가 선택한 프로젝트로 들어가지 않는 회귀 검사를 포함한다. OAuth·명시적 키 교체는 토큰 캐시를 초기화하고 회전 토큰을 암호화 저장한다.

Threads가 폴링 상한 뒤 늦게 FINISHED가 된 경우에는 자동 발행을 이어가지 않으며 컨테이너를 보존해 읽기만 하는 상태 확인을 제공한다. 실계정의 실제 게시·권한·갱신 지속성과 고급 미디어 처리는 별도 실서비스 검증이 필요하다. [검증 기록](verification.md)과 [지원표](integration-capabilities.md)를 따른다.
