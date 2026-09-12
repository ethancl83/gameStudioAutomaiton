# 구현 계약과 편집 담당

Last Updated: 2026-09-11

기준선은 [개발계획 v2](../dev/active/app-operations-platform/app-operations-platform-plan-v2.md)이며 [v1](../dev/active/app-operations-platform/app-operations-platform-plan.md)을 승계한다. 사용자가 Opus·Grok 워커를 기동하고 현재 코디네이터가 고난도 작업을 직접 수행하거나 Fable에 배정하도록 구현을 요청했다. 이 문서는 구현의 공통 계약이며 고정 계획을 변경하지 않는다. 현재 담당·검증 상태는 [작업 맥락](../dev/active/app-operations-platform/app-operations-platform-context.md)을 따른다.

## 첫 배정 기록

- 코디네이터: 루트 패키지·공통 타입·설정, `packages/domain`, `packages/storage`, `packages/connectors`, `packages/metrics`, `apps/controller`, `scripts`, Dev Docs와 통합 테스트. 작업 큐·인증 통합·외부 쓰기 복구를 직접 구현한다.
- Fable: `packages/credentials/**`, `tests/credentials.test.ts`, `docs/credential-lifecycle.md`. OS 보관함·암호화·OAuth/JWT·토큰 회전의 고난도 구현을 담당한다.
- Opus: `apps/desktop` 전체(Electron main/preload, React 화면·스타일). 공통 타입과 아래 HTTP 계약을 소비한다. 패키지와 공통 타입 변경은 코디네이터에게 요청한다.
- Grok: `packages/engines`, `packages/inspection`, `apps/runner`, `tests/engines.test.ts`, `tests/runner.test.ts`. root/desktop/controller/공통 타입을 수정하지 않는다.
- 독립 검토: Sol의 별도 세션에서 공통 계약·인증·동시성 설계를 먼저 검토하고, 구현 결과도 독립 검토한다. 리뷰어는 코드를 수정하지 않는다.

모든 작업은 같은 폴더에서 서로 다른 파일을 편집한다. 새 하위 워커나 별도 Git worktree를 만들지 않는다. 계정 비밀을 찾거나 실제 광고 집행·배포를 임의 수행하지 않는다. 외부 계정·장비가 없으면 그 검증만 미완료로 남기고 가능한 구현과 모의 서버 계약 검증을 수행한다.

위는 초기 배정 기록이다. 이후 Grok은 스토어·광고 어댑터, Opus는 화면·소셜 모듈을 구현했고 코디네이터가 통합·키 관리·신뢰성 수정을 담당했다. Fable로 요청한 세션은 런타임이 Opus 4.8로 자신을 식별해 Fable 수행으로 확정하지 않는다. 완료된 워커의 파일은 코디네이터에게 반환하며 진행 중 배정만 context에 유지한다.

## 실행 환경

Node.js 22.22.1과 npm 9.2.0을 확인했다. 루트 npm 패키지 하나에서 TypeScript 소스 디렉터리를 관리한다. ESM 및 Node 영역의 상대 import는 `.js` 확장자를 사용한다. 공통 타입은 `packages/domain/index.ts`에 있다. Node 영역은 tsc, 화면은 Vite로 빌드한다. 의존성 설치와 루트 설정은 코디네이터만 수행한다.

## 엔진·러너 외부 계약

- `packages/inspection/index.ts`: `inspectProject(directory: string): Promise<ProjectInspection>`. 읽기만 하고 빌드 스크립트를 실행하지 않는다. 경로를 realpath로 정규화하고 판별 충돌·누락 파일을 findings에 기록한다.
- `packages/engines/index.ts`: `scanToolchains(): Promise<Toolchain[]>`, `createBuildPlan(project: ProjectInspection, options: BuildOptions): Promise<BuildPlan>`.
- `apps/runner/index.ts`: `createSnapshot(sourcePath: string, destination: string): Promise<Snapshot>`, `executeBuild(plan: BuildPlan, options?: { signal?: AbortSignal; onOutput?: (output: BuildOutput) => void }): Promise<BuildExecutionResult>`.
- 실행은 shell 없이 인수 배열로 수행한다. root 원본은 수정하지 않는다. 경로 이탈·심볼릭 링크·비밀 파일·출력의 스냅샷 재포함을 방지한다. 빌드 입력은 이미 생성된 스냅샷으로 전달한다. 도구 부재를 가짜 성공이나 미리 만든 바이너리로 대체하지 않는다.
- 빌드 plan은 Godot, Unity, Unreal, Gradle, Xcode의 실제 명령 형식을 사용하고 필요한 preset/scheme/SDK가 없으면 actionable finding을 돌려준다. 기기·엔진 미설치 상태의 실제 빌드 검증을 완료로 표시하지 않는다.

## UI·제어 서비스 계약

기본 API 주소는 `http://127.0.0.1:4317/api`다. 데이터 디렉터리는 OS 사용자 데이터 경로이며 `APPOPS_DATA_DIR`로 검증 시 격리한다. API는 비밀 bearer 토큰을 검사하고 요청 Origin을 제한한다. 토큰은 데이터 폴더의 `controller.json`에서 같은 사용자 프로세스만 읽는다. 이 파일은 제어 서비스가 생성한다.

UI에서 반환값은 `ApiResult<T>`를 해제해 사용한다. Electron에서는 preload의 `window.appOps.request(method,path,body?)`가 main 프로세스를 거쳐 API에 접근하고 bearer를 화면에 노출하지 않는다. 경로는 `/api` 아래의 명시적 작업만 허용한다. `window.appOps.selectFolder()`는 네이티브 폴더 선택, `window.appOps.openExternal(url)`은 허용된 HTTPS 설정 링크 열기다. 브라우저 개발 환경은 같은 계약을 `/api` fetch와 경로 입력으로 제공한다. Vite 프록시 인증 주입은 코디네이터가 구현한다.

| 요청 | 입력 | data 응답 |
|---|---|---|
| GET `/api/health` | 없음 | `{version, startedAt}` |
| GET `/api/state` | 없음 | `AppState` |
| POST `/api/projects` | `{path}` | `Project` |
| DELETE `/api/projects/:id` | 없음 | `{deleted:true}` (원본 폴더 보존) |
| POST `/api/projects/:id/inspect` | 없음 | `Project` |
| PUT `/api/projects/:id/policy` | `AutomationPolicy` | `Project` |
| POST `/api/projects/:id/build` | `{target,configuration?,engineExecutable?,exportPreset?,scheme?}` | `Run` |
| POST `/api/runs/:id/cancel` | 없음 | `Run` |
| POST `/api/runs/:id/retry` | 없음 | `Run` (안전하게 재조회/재시도 가능한 작업만) |
| POST `/api/connections` | `{provider,label,accountId,credentials:Record<string,string>}` | `Connection` |
| POST `/api/connections/:id/check` | 없음 | `Connection` |
| DELETE `/api/connections/:id` | 없음 | `{deleted:true}` |
| POST `/api/connections/:id/actions` | `{operation,projectId?,input,idempotencyKey?}` | `Run` |
| PUT `/api/connections/:id/credentials` | `{credentials}` | `Connection` |
| POST `/api/runs/:id/reconcile` | 없음 | 조회를 통한 복구 `Run` |
| POST `/api/history/query` | `{kind,before?,limit?,projectId?,connectionId?,runId?,status?}` | 커서 페이지 |
| POST `/api/build-credentials` | `{kind,label,credentials}` | 비밀 없는 `BuildCredential` |
| PUT `/api/build-credentials/:id` | `{label?,credentials}` | 새 버전 `BuildCredential` |
| DELETE `/api/build-credentials/:id` | 없음 | `{deleted:true}` (사용 중이면 409) |
| PUT `/api/projects/:id/build-security` | `{androidKeystoreId?,sshDependencies}` | `Project` |
| PUT `/api/projects/:id/social-policy` | `ProjectSocialPolicy` | `Project` |
| POST `/api/social/schedules` | `{projectId,connectionIds,text,scheduledAt}` | `SocialSchedule` |
| DELETE `/api/social/schedules/:id` | 없음 | 취소한 `SocialSchedule` |
| POST `/api/oauth/social/:provider/start` | `{label,accountId?,credentials:{clientId,clientSecret?}}` | `{connectionId,authorizationUrl}` |
| POST `/api/connections/:id/oauth/social/start` | `{credentials?:{clientId?,clientSecret?}}` | `{connectionId,authorizationUrl}` |

소셜 provider는 `x`·`threads`다. OAuth callback은 `GET /api/oauth/social/callback`이며 loopback Host와 일회성 state를 검증한다. 사용자 입력의 빌드 키 버전은 신뢰하지 않고 제어 서비스가 현재 연결에서 캡처한다. 키 원문 조회 API는 없다. 상세 입력은 [빌드 키](build-credentials.md)와 [소셜 운영](social-operations.md)을 따른다.

외부 쓰기 action은 프로젝트와 `idempotencyKey`가 필수다. 조회는 프로젝트 없이 가능하다. 소셜 `create-post`·`reply`에는 별도의 프로젝트 소셜 정책이 적용되고, Steam의 `list-news`는 조회만 지원한다. `AppState`에는 공개 키 메타데이터인 `buildCredentials`, 예약 상태인 `socialSchedules`가 포함된다.

지원 operation 목록과 자격 증명 입력은 `capabilities`에서 공급된다. 첫 화면은 실제 빈 상태로 시작하며 demo 매출·가상 연결을 실제 데이터처럼 표시하지 않는다. 동작 중에는 state를 주기적으로 갱신한다. 프로젝트/연결/빌드/배포/캠페인/수익화/이력/환경 화면의 상태·오류·대기를 구현한다. 기본 동작은 실제 API를 호출해야 한다.

공통 action은 `check`, `sync`, `list-apps`, `list-campaigns`, `create-campaign`, `update-campaign`, `pause-campaign`, `list-products`, `create-product`, `update-product`, `list-ad-units`, `create-ad-unit`, `update-ad-unit`, `upload-build`, `list-releases`다. 공급자별 지원 operation만 UI에 표시한다. 각 공급자 input은 capability와 실제 어댑터 구현에 맞추고 미지원 명령을 가짜 성공으로 반환하지 않는다.

## 무결성·인증 검토 대상

제어 서비스 하나가 SQLite를 소유한다. 각 외부 쓰기에 변경 의도/키/외부 ID를 저장하고 불명확한 결과는 조정 대기 상태로 두며 자동 재전송하지 않는다. 작업 입력·로그·화면에는 계정 비밀을 넣지 않는다. 별도 OS 보관함의 마스터키와 AES-GCM 암호문 저장을 사용하고 보관함 부재/잠김을 명시한다. 테스트는 메모리 key provider와 별도 임시 DB를 사용한다. 실서비스 자격 증명은 사용자가 설정 화면에서 한 번 연결한다.

패키지 설치 전에도 담당 코드를 작성할 수 있다. 설치가 끝나면 `npm run typecheck`, `npm test`, `npm run build`를 실행한다. 공유 설정의 오류는 자신의 담당 범위를 넘어 고치지 말고 코디네이터에게 전달한다. 검증은 동작·실패 경로 중심으로 작성하고 UI의 단순 표시를 따라가는 테스트는 추가하지 않는다.

## 독립 설계 리뷰 반영

Sol의 별도 세션에서 2026-09-11 검토했다. 외부 쓰기에는 `idempotencyKey`가 필수이며 connection+operation+key의 유일성과 canonical input hash 충돌을 검사한다. 변경 의도는 prepared→dispatched→confirmed/action_required를 durable 저장한다. 불명확한 외부 쓰기는 일반 retry로 재전송하지 않는다. 제어 서비스 단일 프로세스 락·작업 lease fencing을 구현한다.

Vite는 개발 시에만 127.0.0.1:5173에 바인딩하고 Host·Origin을 정확히 검사한다. 빌드 실행은 실제 격리 백엔드와 제한된 파일/환경·기본 네트워크 차단이 필요하며 없으면 작업을 중단한다. 임의 executable·cwd·env를 IPC에서 그대로 전달하지 않는다.

## 자격 증명 모듈 계약

진입점은 `packages/credentials/index.ts`다. 아래는 구현된 공개 계약이다. 모델 수행 기록은 위 배정 기록을 따른다.

- `type Credentials = Record<string,string>`.
- `interface KeyProvider { name: string; getKey(): Promise<Buffer | undefined>; setKey(key: Buffer): Promise<void> }`. 테스트는 메모리 구현을 주입하며 운영 평문 대체 경로는 없다.
- `new CredentialVault(directory: string, options?: { keyProvider?: KeyProvider })`: `status(): Promise<{available:boolean;backend:string;reason?:string}>`, `get(id:string):Promise<Credentials>`, `set(id:string,value:Credentials):Promise<void>`, `remove(id:string):Promise<void>`, `has(id:string):Promise<boolean>`.
- OS 보관함 어댑터는 설치된 `@napi-rs/keyring`의 AsyncEntry를 사용한다. 마스터키는 controller 소유이며 임의 기존 계정을 조회하지 않는다. 자신의 service/namespace만 접근한다. 96-bit nonce·AAD(id/schema/keyVersion)·원자 파일 저장, 기존 암호문이 있는데 키가 없으면 새 키 생성 금지. 잠김과 부재를 구분해 fail closed.
- `new TokenManager(vault: CredentialVault, options?: { fetch?: typeof fetch })`: `getAccessToken(connection: {id:string;provider:Provider}, scopes?:string[]):Promise<string>`, `invalidate(id:string):void`.
- Google credentials: `serviceAccountJson` 또는 `clientId`, 선택적 `clientSecret`, `refreshToken`. Google token endpoint를 고정하고 서비스 계정 JSON의 임의 token_uri로 비밀을 전송하지 않는다. scopes별 토큰 캐시·연결별 갱신 직렬화·회전 토큰 저장을 처리한다.
- Apple credentials: `keyId`, `issuerId`, `privateKey`. ES256 JWT를 짧은 유효시간으로 생성하고 검증한다. 다른 공급자는 API 키를 vault.get으로 읽는다.
- `new GoogleOAuthBroker(options?: {fetch?:typeof fetch})`: `begin(input:{clientId:string;clientSecret?:string;redirectUri:string;scopes:string[]}):{state:string;authorizationUrl:string}`, `complete(input:{state:string;code:string}):Promise<Credentials>`. PKCE·난수 state·한 번 사용·TTL과 localhost redirect 검증을 포함한다. 상태와 verifier는 프로세스 메모리에만 둔다.
- 오류는 비밀이 없는 Error.message와 안정적인 `code`를 제공한다. HTTP 임시 오류를 무조건 재로그인으로 분류하지 않는다. crypto/keyring/fetch의 경계별 테스트와 모의 HTTP로 갱신·동시성·키 유실·토큰 회전을 확인한다.
