# 앱 운영 플랫폼 개발계획 v10 — AI 설정·GitHub 개발 작업·웹 배포

Created: 2026-09-24
Last Updated: 2026-09-24
Description: In-app AI configuration, GitHub issue and PR development workflows, and web deployment

## 요약

앱에서 사용할 AI 연결과 모델을 설정하고, 프로젝트의 GitHub 이슈·PR을 문서로 가져와 tmux 터미널에서 분석·구현·검증한 뒤 승인 또는 저장된 자동화 정책으로 커밋·푸시·웹 배포까지 이어간다. 사용자의 직접 입력은 최초 로그인·권한 동의·필수 비밀값·실제로 판단이 필요한 선택으로 줄인다.

이번 산출물은 구현계획이다. Phase 16–22는 모두 예정이며 실제 코드 변경·외부 계정 등록·커밋·푸시·배포를 실행한 것으로 취급하지 않는다. 기존 plan v1–v9는 보존한다. v8의 일반 AI 버튼은 채팅만 여는 계약, v9의 앱 종료 시 소유 프로세스 정리는 유지하며, 새 `가져오기` 버튼에만 명시된 분석·문서 생성 흐름을 추가한다. 기존 장기 수용 항목 42개와 별도 성장 운영 계획을 완료 처리하지 않는다.

## 현재 상태 분석

| 근거 | 현재 상태와 확장 지점 |
|---|---|
| `apps/desktop/src/App.tsx`, `views/SettingsView.tsx` | 설정 메뉴가 이미 있다. 런타임·보관함·빌드 키·도구 표시를 보존하고 AI 설정을 추가한다. |
| `packages/agent/types.ts`, `cli.ts`, `AgentPanel.tsx` | Codex/OpenCode CLI와 `auto` 선택만 지원한다. 모델·인증은 CLI 설정에 의존하며 PTY 대신 pipe로 비대화형 실행한다. |
| `apps/controller/agent.ts` | 프로젝트별 대화·native 세션 ID·resume/clear·종료 처리가 있다. 이슈별 개발 작업은 별도 식별하고 기존 운영 대화를 덮어쓰지 않는다. |
| `apps/controller/oauth-clients.ts`, `packages/credentials/` | OAuth 앱 재사용·암호화 보관함을 재사용한다. GitHub·Netlify·Vercel 인증은 추가해야 한다. |
| `packages/storage/`, `apps/controller/queue.ts` | 문서 저장·작업 소유권·취소·외부 효과 불명 상태를 재사용한다. 단계별 체크포인트와 재조정을 연결한다. |
| `packages/domain/index.ts`, `packages/inspection/`, `packages/connectors/` | 게임·모바일 프로젝트와 스토어 중심이다. Git 연결, 웹 프로젝트와 웹 배포 공급자 구분이 필요하다. |
| `apps/desktop/electron/security.ts`, `preload.ts`, `apps/controller/server.ts` | 신규 API와 터미널 입력·출력에도 기존 인증·IPC·origin 경계를 적용해야 한다. |
| `gecko_dev`의 `TerminalView.swift`, `TerminalStream.swift`, `AppState+SessionRuntime.swift`, `src/session/tmux.rs` | xterm 화면–PTY–tmux 연결, resize, 오래된 출력 연결 구분, attach/종료 분리를 참고한다. Swift/Rust 코드를 그대로 의존하지 않는다. |

현재 `electron-builder.json` 삭제와 `.DS_Store` 미추적 상태는 기존 변경이다. 문서 작업에서 변경하지 않는다. 이후 패키징 검증 시 삭제 의도를 확인하고 필수 설정을 해결해야 하며 자동 복원하지 않는다.

## 목표 상태

### 범위와 가정

- 배포 대상은 이 앱에서 관리하는 웹 프로젝트다. 이 Electron 앱 자체의 SaaS 전환은 가정에 포함하지 않는다. SaaS 전환 요청이라면 로컬 실행기·원격 인증·영속 작업 실행을 별도 설계한다.
- AI 설정은 제품 내부의 분석·문서·코딩·리뷰·운영 대화에 적용한다. 관리 대상 게임/앱에 AI SDK나 키를 삽입하는 기능이 아니다.
- 연결 방식은 CLI와 API 모두를 지원하는 제안이다. 사용자에게 선호 방식을 질문했으며, 구체적인 공급자 목록은 확정 지시가 아닌 아래 초기 제안으로 기록한다.
- 실행 환경은 기존 실측 환경인 macOS·Linux를 먼저 검증한다. Windows는 tmux 실행 호스트로 WSL/원격 Linux가 필요하므로 후속 호환성 항목으로 표시하고 지원 완료를 주장하지 않는다.
- `netlify/vercel 등`의 첫 공급자는 두 서비스다. 임의의 추가 호스팅·도메인 구매·DNS 이전은 포함하지 않는다.

### 화면과 사용 흐름

| 위치 | 구성과 주요 동작 |
|---|---|
| 설정 → AI 프로바이더 | 연결 목록, 추가·검사·연결 해제, 로그인/키 등록, 모델 선택, 용도별 기본값, 고급 실행 제한 |
| 설정 → 기존 항목 | 런타임·보관함·빌드 키·도구 체인을 유지한다. 프로젝트 자동화 정책은 프로젝트별로 관리한다. |
| 계정 연결 | GitHub·Netlify·Vercel 버튼, 브라우저 인증, 조직/팀 선택, 권한·재연결 상태 |
| 개발 작업 → Git | 프로젝트/저장소 연결·clone·init, 브랜치·상태·diff·stage/unstage·commit·fetch/pull/push·이력 |
| 개발 작업 → 이슈·PR | 상태·라벨·담당자 검색/필터, 페이지네이션, 원문·댓글·리뷰·CI·diff, 가져오기 |
| 개발 작업 → 작업 상세 | 왼쪽 작업 목록, 중앙 원본/계획/변경/검증 탭, 하단 접이식 터미널, 진행 상태와 승인 버튼 |
| 웹 배포 | 프로젝트/팀 연결·생성, 자동 감지 설정, Preview/Production 구분, 로그·상태·URL·이력 |

기본 경로: AI 연결 확인 → GitHub 로그인 → 프로젝트의 remote 자동 감지 또는 저장소 선택 → 이슈/PR 가져오기 → 문서 저장·worktree 준비·터미널 열기 → 분석·Dev Docs 생성 → 작업 시작 또는 자동 구현 → 검증 → 승인/자동 커밋·푸시 → 선택적 PR → 승인/자동 배포.

가져오기 버튼 옆에 `자료 저장 후 분석·계획을 생성합니다`와 적용할 AI를 표시한다. AI 미설정 시에는 자료를 보존하고 작업 상세에서 설정으로 연결한다. 분석 실패를 가져오기 전체 실패나 성공으로 뭉개지 않는다. 일반 화면 진입·설정 저장·AI 채팅 열기는 실행을 시작하지 않는다.

### AI 프로바이더 설정 계약

1. **실행 방식과 공급자를 구분한다.** CLI 프로필은 실행 도구·공급자 설정 상속을, API 프로필은 공급자·endpoint·credentialRef·model을 가진다. Codex/OpenCode는 실행 도구이고 OpenAI 등은 모델 공급자다. 단일 enum에 혼합하지 않는다.
2. **초기 제안:** 기존 Codex/OpenCode CLI 로그인·설정을 재사용하고 OpenAI API 및 명시적으로 등록한 OpenAI 호환 endpoint를 추가한다. 다른 네이티브 공급자는 사용자 지정 또는 실제 사용처가 확인될 때 범위를 확정한다. 호환 endpoint의 도구 호출·스트리밍·이미지 기능은 검사 전 지원으로 표시하지 않는다.
3. **입력 최소화:** CLI 설치 경로·버전·사용 가능한 인증 상태를 탐지한다. 지원되는 공식 로그인 절차를 터미널/브라우저로 연다. API는 키를 한 번 저장하고 endpoint 기본값과 조회 가능한 모델 목록을 제공한다. 조회 API가 없거나 모델을 열거할 수 없을 때만 고급 수동 입력을 노출한다. CLI 인증을 일반 API 키로 변환하거나 타 앱의 토큰을 추출하지 않는다.
4. **설정 필드:** 연결 이름·방식·공급자·연결 상태·기본 모델. 고급 항목은 지원되는 추론 강도, 최대 출력·실행 시간·재시도 한도만 노출한다. 특정 최신 모델·가격을 코드에 근거 없이 고정하지 않는다. 모델 목록 조회 성공과 실제 추론/도구 사용 가능 여부를 구분한다.
5. **용도별 기본값:** 앱 공통 기본 AI 하나와 분석/문서, 코딩, 리뷰, 운영 대화의 선택적 재정의를 둔다. 미지정 용도는 공통값을 따른다. 현재 이미지 생성 경로가 제공하는 기능도 capability로 표시하되 텍스트 모델 선택으로 이미지 지원을 가장하지 않는다.
6. **작업 고정:** 시작 시 AI 프로필 버전·모델·허용 도구·제한을 저장한다. 설정 변경은 새 작업부터 적용한다. 실행 중 공급자 교체·실패 시 다른 공급자 자동 전송은 하지 않는다. 명시적 재시작은 기존 산출물과 재개 가능성을 안내한다.
7. **실행 연결:** 기존 CLI 어댑터와 직접 API 어댑터는 공통 작업 상태·취소·도구 권한을 사용한다. API의 분석/문서 생성도 실제 저장 결과를 검증한다. API 기반 코딩에는 파일 읽기/패치/테스트 도구를 호출하는 제한된 실행 루프가 필요하며, 텍스트 응답만으로 코딩 지원 완료를 표시하지 않는다. 터미널에는 실제 작업 runner를 실행하고 같은 작업 ID로 결과 이벤트를 연결한다.
8. **비밀 보관:** 기존 보관함에 비밀을, SQLite에 참조와 공개 설정만 저장한다. renderer·프롬프트·명령 인자·진단·일반 내보내기에 키를 반환하지 않는다. 임의 endpoint로 공식 공급자의 자격 증명을 전달하지 않는다. 연결 삭제는 사용 중 참조를 확인하고 새 실행을 차단한다.
9. **상태:** 미설치/미연결/검사 중/사용 가능/인증 만료/모델 접근 불가/할당량 제한/보관함 잠김을 구분한다. 연결 검사는 저장 동작과 분리하며 실제 요청이 발생함을 표시한다. 데모는 실 API/CLI를 호출하지 않는다.

공식 Codex 인증·설정 방식과 API 키 인증은 별개이므로 구독 로그인만으로 범용 API 호출이 가능하다고 가정하지 않는다. [Codex 인증](https://learn.chatgpt.com/docs/auth), [설정](https://learn.chatgpt.com/docs/config-file/config-basic), [API 인증](https://developers.openai.com/api/reference/overview), [모델 조회](https://developers.openai.com/api/reference/resources/models).

### Git·OAuth·문서 가져오기 계약

- 기존 Git 실행 파일을 shell 없이 인자 배열로 호출한다. 상태는 기계 판독 형식으로 읽고 경로·ref·remote를 검증한다. dirty 원본을 reset/stash/checkout하지 않고 작업별 worktree로 분리한다. worktree는 파일 분리이며 프로세스 보안 격리를 대신하지 않는다.
- 저장소 연결은 canonical 경로와 Git common directory, remote, GitHub repository ID를 함께 확인한다. fork·여러 remote·monorepo 루트가 모호한 경우에만 선택을 요청한다. 새 저장소 생성은 사용자의 생성 동작에서 공개 범위를 선택받는다.
- GitHub App 기반 사용자 인증과 저장소 선택 설치를 우선한다. 이슈/PR 읽기와 Git contents 쓰기 등 실제 기능에 필요한 권한만 요청한다. API 인증뿐 아니라 clone/fetch/push용 HTTPS credential 전달도 구현하며 remote URL에 토큰을 저장하지 않는다. [GitHub Apps](https://docs.github.com/en/apps/overview).
- 공통 앱 등록·고정 HTTPS callback·비밀키 관리·일회용 결과 전달을 담당하는 작은 OAuth 중계 서비스를 계획에 포함한다. Electron에 client secret/private key를 내장하지 않는다. state·만료·재사용 차단·앱 인스턴스 바인딩, 지원 시 PKCE, 계정/설치 매핑과 철회 처리를 검증한다. 중계 배포는 구현계획과 별도 외부 배포 행위다.
- Netlify OAuth 앱과 Vercel Integration 등록도 같은 최초 준비 작업에 포함한다. GitHub 로그인만으로 배포 서비스의 저장소 접근 설치가 끝났다고 가정하지 않는다. 서비스별 팀·저장소 추가 동의가 필요하면 공식 화면으로 이어준다. [Netlify](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/), [Vercel](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations).
- 데스크톱 실행 중 새로고침/주기 조회로 목록을 갱신한다. 최초 버전에서 webhook 인프라를 필수로 만들지 않는다. 권한 철회·페이지 중간 실패·rate limit 시 마지막 성공 자료와 오래된 상태를 구분한다.
- 가져오기 키는 repository ID + 종류(issue/PR) + 번호다. 본문·댓글·리뷰의 ID/작성자/시각·URL·updatedAt, PR base/head SHA·diff·CI를 저장한다. 제한으로 수집이 잘리면 누락을 표시한다. PR fork 쓰기 권한이 없으면 승인된 별도 브랜치/PR 경로를 제시하고 원본 PR push를 성공으로 표시하지 않는다.
- 대상 저장소의 지침·기존 Dev Docs를 재사용한다. 기본 제안은 `dev/active/github-issue-123/` 또는 `github-pr-456/` 아래 원본 Markdown와 plan/context/tasks다. 원본 스냅샷과 AI 분석은 별도 파일이며 갱신 시 사용자 수정과 기존 plan을 덮어쓰지 않는다. 대상 저장소가 생성 확인을 요구하면 그 규칙을 처리하고 해당 생성 단계만 대기한다.
- 이슈/댓글/PR 코드는 분석 입력이며 실행 권한을 주는 지시가 아니다. 문서 경로 이탈, 마크다운 active HTML, 명령 삽입을 차단한다. 최초 가져오기와 재가져오기·중복 클릭·작성 중 실패를 구분한다.

### tmux와 작업 수명주기 계약

- UI는 xterm 계열 터미널, controller 측은 PTY를 통해 앱 전용 tmux 서버/socket에 attach하는 구조를 제안한다. 필요한 PTY/터미널 의존성과 Electron ABI·패키징은 Phase 18에서 검증 후 고정한다.
- 패널 닫기/화면 이동은 attach 연결만 해제한다. 작업 중지는 해당 runner를 취소하고 체크포인트를 남긴다. 명시적 세션 종료와 worktree 삭제는 별도이며 미커밋 자료를 보존한다.
- 마지막 창 닫기·앱 종료는 v9대로 앱 소유 runner·PTY·tmux 세션/서버를 정리한다. 다른 앱/사용자의 tmux에는 영향을 주지 않는다. 앱 종료 후 무인 실행은 이번 초기 범위에서 활성화하지 않는다.
- 비정상 종료 후 남은 앱 전용 세션을 조회하여 실제 실행 여부와 작업 소유권을 대조한다. 살아 있는 runner를 중복 실행하지 않는다. 중단됐으면 새 tmux에서 저장된 CLI ID/작업 체크포인트로 명시적으로 재개한다. 재부팅 뒤 프로세스가 살아 있다고 표시하지 않는다.
- 한 작업에는 한 자동화 runner만 둔다. 입력·한글/붙여넣기·resize·스크롤백·출력량 제한·재연결을 지원하고 오래된 surface/세대의 출력은 새 세션에 섞지 않는다. 터미널 문자열을 작업 성공 판정의 유일한 근거로 삼지 않는다.
- tmux/CLI 미설치는 운영 준비로 연결하고 설치가 필요함을 표시한다. Windows는 지원되는 WSL/원격 호스트가 연결되기 전 작업 실행을 막고 원인을 표시한다.

### 승인·자동화·완료 계약

상태 흐름은 `가져옴 → 준비 → 분석 → 계획 준비 → 구현 → 검증 → 반영 대기 → 커밋됨 → 푸시됨 → PR/배포 추적`이다. 실패·취소·입력 대기·외부 결과 불명은 해당 단계와 증거를 보존한다. 브랜치 수정 완료, PR 병합, 이슈 종료, 배포 성공은 각각 별도 상태다.

- 가져오기는 원본 저장·터미널 열기·분석·Dev Docs 생성까지 승인하는 제품 동작이다. 구현은 `작업 시작` 또는 저장된 `가져온 뒤 자동 구현` 정책으로 시작한다.
- 프로젝트 정책은 자동 구현/커밋/푸시/PR 생성·갱신/Preview 배포를 각각 구분한다. 초기 외부 쓰기 자동화는 꺼진 상태이며 사용자가 켠 범위는 매번 재승인받지 않는다. 수동 승인도 그 작업·대상·현재 결과에 한정해 기록한다.
- merge·이슈 직접 닫기·Production 배포는 자동 푸시에 포함하지 않는다. 별도 사용 동작/정책으로 다룬다. 기본 이슈 해결은 연결된 PR이 기본 브랜치에 병합됐음을 확인하는 흐름이다. [GitHub 이슈 연결](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue).
- 외부 변경 직전에 최신 정책과 승인 대상 SHA·diff/검증 결과를 재검사한다. 사용자가 코드를 바꾸면 이전 검증·승인을 재사용하지 않는다. 취소/정책 철회는 아직 보내지 않은 작업을 막고 이미 보낸 작업은 읽기로 재조정한다.
- 커밋은 작업 worktree의 검토된 변경만 포함한다. 비밀·원래 사용자 변경을 섞지 않는다. fast-forward 불가·충돌·보호 브랜치·필수 CI 실패는 조치 상태로 남긴다. force push는 기본 자동화에 포함하지 않는다.
- AI에 GitHub/배포 쓰기 자격 증명을 전달하지 않는다. agent의 shell·Git 설정·공유 홈·credential helper·네트워크 접근을 제한하고 Git/배포 반영은 controller의 정책 검사 경로로만 수행한다. 기존 CLI의 상속 환경과 임의 도구 실행을 그대로 두면 승인 버튼이 우회되므로 구현 전 이 경계를 먼저 검토한다. 제한을 강제할 수 없는 실행 방식은 무인 실행을 지원 완료로 표시하지 않는다.
- 루프는 실행 시간·수정/검증 재시도 한도를 두며 실패를 성공으로 꾸미지 않는다. 비용은 공급자가 준 usage만 기록하고 모르는 구독 비용을 추산해 확정값으로 표시하지 않는다.
- 검증 command/exit code·대상 SHA·diff·commit SHA·remote SHA·PR URL·deployment ID/URL을 근거로 저장한다. push/배포 응답 유실은 조회 후 확정하며 무조건 재전송하지 않는다.

### 웹 배포 계약

- 프로젝트의 웹 루트·framework·lockfile·package scripts·기존 공급자 설정에서 빌드 설정을 감지한다. monorepo의 후보가 여럿일 때만 선택한다. 감지할 수 없는 환경변수·외부 DB 설정·도메인 값은 질문한다. 모바일/데스크톱 산출물을 웹 배포 가능으로 오인하지 않는다.
- 기존 팀·프로젝트를 조회해 연결하고 사용자 생성 동작으로 새 프로젝트를 만든다. 환경변수는 Preview/Production 범위를 표시하고 비밀을 저장소에 기록하지 않는다.
- 우선 Git 연동 배포를 사용하며 commit SHA로 실행을 추적한다. 플랫폼 자동 빌드가 실행되는 저장소에 API 배포까지 중복 요청하지 않는다. 정적 산출물 업로드는 해당 공급자가 지원하는 경로로 명시 선택할 때 사용한다.
- Preview 성공은 실제 공급자의 완료 상태와 URL 접근으로 확인한다. Production은 별도 승인/정책과 검증된 commit을 사용한다. 실패 로그·취소·재시도·토큰 철회·이전 배포 조회를 지원한다. 롤백 동작은 공급자별 지원을 확인한 경우에만 제공한다.

### 책임과 저장 모델

| 경계 | 계획 |
|---|---|
| `packages/agent/`, controller agent | AI 프로필·모델·capability·CLI/API 실행, 기존 대화 호환 유지 |
| credentials / connectors | 비밀 보관·공급자 인증/조회/쓰기, 계정별 연결 재사용 |
| Git / terminal 모듈 | Git 명령·worktree 잠금과 PTY·tmux 생명주기를 별도 책임으로 추가 |
| controller 개발 작업 | 가져오기·문서·실행 단계·승인·복구를 기존 큐/이력과 연결 |
| desktop UI | 새 화면·설정, 상태 구독, 승인과 터미널 표시; renderer에서 직접 shell/secret 접근 금지 |
| OAuth 중계 | 공통 앱의 비밀·callback·인스턴스 바인딩; 로컬 코드 작업 실행은 담당하지 않음 |

기존 SQLite 문서 저장을 우선 사용한다. 필요한 레코드는 AI 연결/프로필·용도별 기본값, 저장소 연결, 가져온 항목/스냅샷, 개발 작업(worktree·세션·단계·고정 AI), 작업 승인/정책 버전, 배포 연결이다. 실행 이력·효과 상태는 기존 Run/events를 재사용한다. 저장소+항목 중복과 한 작업의 활성 runner 제약은 트랜잭션으로 강제한다. 새 테이블은 실제 쿼리/무결성 요구가 기존 저장으로 해결되지 않을 때만 추가한다.

기존 `AgentSettings.provider`는 대응 CLI 프로필/공통 기본값으로 멱등 이관한다. 기존 세션의 provider·native ID는 유지하고 `auto`는 최초 새 실행에서 선택한 도구를 기록한다. 연결 제거·프로젝트 삭제·백업 복원 시 참조 무결성, 키 재연결, 살아 있는 세션·외부 효과 재확인 조건을 정의한다.

## Phase 실행 지도

실행 순서: 16 → 17 → 18 → 19 → 20 → 21 → 22. OAuth 공통 앱 등록 준비는 17에서 시작해 21 전에 실연결을 검증한다. 각 단계는 앞 단계의 실제 완료 근거를 따른다.

### Phase 16 — 설정과 앱 내부 AI 연결

- 목표: 설정 화면 한 곳에서 앱의 AI를 연결·선택하고 실제 작업에 적용한다.
- 작업: T-16.1 설정/권한/실행 계약 검토, T-16.2 프로필·보관함·기존 설정 이관, T-16.3 CLI/API 실행·모델/capability 검사, T-16.4 설정 UI·용도별 기본값·기존 채팅 통합.
- Acceptance Criteria: 저장·재시작 후 설정 유지, 연결 검사와 실제 모델 응답, 모델 제한/잘못된 키의 정확한 오류, 설정 변경 중 기존 세션 유지, 비밀 미노출, 데모 외부 실행 0건.
- 검증 게이트: `tests/project-agent.test.ts`, `tests/credentials.test.ts`, `tests/desktop-security.test.ts`와 새 설정/어댑터 행동 검사. 실제 사용 계정은 요청이 승인된 검사만 수행하고 mock·실계정 근거를 구분한다.

### Phase 17 — Git 관리와 GitHub 연결

- 목표: 수동 토큰 복사 없이 저장소를 연결하고 Git·이슈·PR을 조회한다.
- 작업: T-17.1 공통 OAuth 앱/중계와 권한 흐름, T-17.2 Git 조작·credential 전달·잠금, T-17.3 저장소/이슈/PR 조회·가져오기 저장, T-17.4 Git·목록·연결 UI.
- Acceptance Criteria: 기존 remote 감지와 clone/init, diff/stage/commit, 로그인 취소/철회/재연결, 전체 페이지 조회, 반복 가져오기 중복 없음, 사용자 변경 보존. fetch/push 인증은 로컬 bare remote 검사와 승인된 GitHub 실검사를 구분한다.
- 검증 게이트: 임시 저장소·bare remote 행동 검사, OAuth state/일회용 응답/권한 음성 검사, API/UI 연결 검사. 실계정 앱 등록이 미완료면 통합 완료를 표시하지 않는다.

### Phase 18 — 개발 작업 공간과 tmux 터미널

- 목표: 가져오기에서 작업 상세와 지속 연결 가능한 대화형 터미널을 연다.
- 작업: T-18.1 worktree·tmux·PTY 수명주기, T-18.2 터미널 UI/입출력/resize/재접속, T-18.3 소유권·앱 종료·충돌 후 복구.
- Acceptance Criteria: 한글/붙여넣기·화면 resize, 패널 닫기 후 작업 유지·재연결, 앱 종료 후 소유 프로세스 정리, 무관한 tmux 보존, crash 후 중복 실행 없음, dirty worktree 보존.
- 검증 게이트: macOS/Linux 실제 tmux·PTY·Electron, 종료 중 입력·늦은 출력·고출력 backpressure, 설치 패키지의 네이티브 모듈 로드 확인. `gecko_dev`는 동작 참고이며 자체 검증을 대체하지 않는다.

### Phase 19 — 이슈 분석과 Dev Docs 생성

- 목표: 원본에서 요구사항·계획·할 일을 생성하고 재개 가능한 근거를 남긴다.
- 작업: T-19.1 저장소 지침/자료 수집과 원본 스냅샷, T-19.2 분석·plan/context/tasks 생성·갱신, T-19.3 문서/계획 UI와 가져오기 연결.
- Acceptance Criteria: 이슈와 PR 각각 본문·댓글/리뷰·SHA 추적, 저장 경로 준수, 기존 문서/사용자 변경 보존, 불명확한 요구만 질문, AI 미설정/취소/출력 불량/부분 저장에서 복구.
- 검증 게이트: 임시 fixture 저장소에서 첫 생성·재가져오기·원본 변경·손상 출력·경로 이탈 검사, 실제 선택 AI의 분석 결과와 생성 파일 확인.

### Phase 20 — 자동 구현·검증·승인·커밋·푸시

- 목표: 사용자가 허용한 범위 안에서 이슈 수정과 Git 반영을 이어간다.
- 작업: T-20.1 CLI/API 작업 runner·도구 경계·검증 루프, T-20.2 정책/승인·commit/push·PR 반영, T-20.3 단계 체크포인트·외부 효과 재조정·상태 UI.
- Acceptance Criteria: 자동 옵션 꺼짐/켜짐 모두 동작, 검증 실패 시 반영 중단, 승인 이후 코드 변경 감지, 권한 우회 차단, 충돌·push 거절·fork 권한 부족 표시, 성공 응답 유실에서 중복 커밋/PR 없음.
- 검증 게이트: 정상/실패 fixture 이슈의 실제 파일 수정·테스트·bare remote SHA 확인, 취소/정책 철회 경합, 민감 환경/credential helper 접근 음성 검사. 승인된 시험 저장소에서 실제 PR까지 확인한다.

### Phase 21 — Netlify·Vercel 웹 배포

- 목표: OAuth 연결과 설정 감지로 프로젝트를 Preview/Production에 배포한다.
- 작업: T-21.1 웹 프로젝트 감지·팀/프로젝트 매핑·설정 UI, T-21.2 두 공급자 OAuth·실제 배포/로그/URL 조회, T-21.3 Git 연동·중복 방지·Production 승인/복구.
- Acceptance Criteria: 두 공급자 각각 로그인→프로젝트 연결→Preview URL 확인, 저장 설정 재사용, Git 자동 배포와 API 요청 중복 없음, Production 분리, 실패/권한 철회/응답 유실 재조정.
- 검증 게이트: 공급자 계약 테스트와 승인된 시험 프로젝트 실제 배포. SSR/정적/monorepo는 지원 선언한 형태를 각각 확인하고 미검증 조합을 지원 완료로 표시하지 않는다.

### Phase 22 — 통합 수용·패키징·사용 안내

- 목표: 설정에서 이슈 작업과 배포까지 실제 사용자 경로를 완성한다.
- 작업: T-22.1 데모/실제 화면 전체 흐름·회귀, T-22.2 OS/패키징·인증/실행/복구 경계 수용, T-22.3 기존 사용법·지원 범위·검증 기록 동기화.
- Acceptance Criteria: 최초 연결 후 저장소/이슈 선택만으로 분석·문서·터미널, 자동 옵션에 따른 구현/푸시/배포, 재시작 후 연결·작업 보존. CLI/API 각각의 실제 선택 적용과 모든 필수 실패 경로 근거가 있어야 한다.
- 검증 게이트: `npm run typecheck`, `npm test`, `npm run build`, 패키징 설정 해결 후 `npm run pack`; 실제 Electron 및 macOS/Linux tmux. 테스트 성공만으로 실계정 OAuth/AI/배포 완료를 대체하지 않는다.

## 리스크와 완화 전략

| 리스크 | 영향 | 완화 |
|---|---|---|
| 인증 공통 앱·callback 미준비 | 직접 입력 없는 로그인 불가 | Phase 17 초기 실연결 검증, 제품 제공 설정과 사용자 계정 설정 구분 |
| CLI 구독과 API 인증 혼동 | 연결은 됐지만 모델 호출 실패 | 연결 방식 분리, 모델/도구 capability 검사 |
| 에이전트 shell이 승인 경계 우회 | 미승인 push·배포 | 비밀 격리·도구/네트워크 경계·controller 반영, 구현 전 독립 검토 |
| worktree·tmux·DB 상태 불일치 | 중복 실행·자료 손실 | 소유권·generation·체크포인트·실제 프로세스 재조정 |
| PR fork/보호 브랜치·dirty 원본 | push 실패·기존 변경 혼입 | 대상 ref 고정·검증·분리된 worktree·명시적 충돌 상태 |
| 공급자/모델·배포 규격 차이 | 거짓 호환·배포 실패 | 실제 어댑터 검사와 지원표, 모델명/설정 추측 금지 |
| 기존 종료·채팅·데모 계약 회귀 | 고아 프로세스·의도치 않은 실행 | v8/v9 회귀·모드 분리·실제 Electron 종료 검사 |

## 미결 사항과 구현 착수 조건

- AI 연결 방식과 추가 필수 공급자는 사용자 답변을 반영한다. 현재 기본 제안으로 문서 작성은 완료할 수 있으나 지원 공급자 추가를 확정 완료로 간주하지 않는다.
- OAuth 공통 앱의 소유 계정·callback 도메인·중계 배포 위치·시험 프로젝트는 구현 초기에 확인한다. 실제 앱 등록/외부 배포 승인이 필요한 시점에는 구현·로컬 검증 결과를 준비한 뒤 해당 행동만 확인한다.
- 저장소 기반 배포 접근·설치 승인, macOS/Linux 실제 tmux, CLI/API 모델 사용 권한은 별도 실행 환경 조건이다.
- 인증/권한·에이전트 실행 격리·승인 상태 계약은 AGENTS.md에 따라 구현 전에 독립 검토한다. 이번 문서 작성은 자체 정합성 검토이며 독립 검토 완료로 표시하지 않는다. 일반 UI는 별도 리뷰를 자동 추가하지 않는다.
- 최초 실행 대상은 T-16.1이며 구현 착수 요청 이후 진행한다. 이 계획의 제품 자동화 옵션은 이번 세션의 외부 쓰기 승인이 아니다.

## 참조와 기록

- [작업 목록](app-operations-platform-tasks.md), [재개 맥락](app-operations-platform-context.md), [카탈로그](../../dev-catalog.md)
- 기존 계약: [AI 운영](../../../docs/ai-operations.md), [인증 수명주기](../../../docs/credential-lifecycle.md), [작업 복구](../../../docs/workflow-contract.md), [자동화 정책](../../../docs/automation-policies.md), [검증 기록](../../../docs/verification.md)
- 참고 프로젝트: `/Users/ethan/Workspace/dev/gecko_dev`의 터미널/tmux 구현. [Orca](https://github.com/stablyai/orca)는 MIT 라이선스 공개 프로젝트이며 화면·worktree 동작을 참고한다. 코드 재사용 시 해당 파일/의존성 라이선스를 확인하고 필요한 고지를 유지한다.
- 공식 문서는 2026-09-24에 확인했다. API 존재 확인과 실제 계정·모델·배포 검증은 구분하며 구현 시 변경된 계약을 다시 확인한다.
