# 앱 운영 플랫폼 개발계획 v11 — CLI 로그인 중심 AI와 개발 작업 구현

Created: 2026-09-24
Last Updated: 2026-09-24

사용자가 AI 연결을 **CLI 로그인 방식 중심**으로 확정하고 구현을 요청했다. [v10](app-operations-platform-plan-v10.md)의 Git·이슈/PR·tmux·문서·승인/자동화·웹 배포와 23개 작업을 승계하며 아래 변경을 우선한다.

- AI 초기 지원은 기존 Codex/OpenCode다. 설치 탐지, 공식 로그인 열기, 연결 검사, CLI별 모델과 용도별 기본값을 앱 설정에서 관리한다. 빈 모델은 CLI 기본값을 상속한다. 특정 모델을 임의 기본값으로 고정하지 않는다.
- 직접 AI API 어댑터·API 키 입력·임의 AI endpoint·별도 API 코딩 루프는 초기 범위에서 제외한다. CLI가 제공하는 기존 모델 공급자 연결은 CLI 자체 인증을 사용한다.
- 기존 대화 native ID를 보존한다. 모델/제공자 선택은 작업 시작 시 고정하며 새 설정은 새 작업부터 적용한다. CLI의 전역 모델 설정을 앱 선택 때문에 덮어쓰지 않는다.
- 별도 공통 OAuth 앱 등록이 사용자의 직접 입력을 늘리는 경우 GitHub·Netlify·Vercel의 공식 CLI 브라우저 OAuth를 제품 연결 경로로 사용한다. CLI 로그인/상태/프로젝트 선택을 앱에서 제공하고 CLI가 관리하는 토큰을 프롬프트·일반 로그로 추출하지 않는다. 공급자별 미설치/로그인 필요/권한 오류를 표시하며 로그인 성공과 배포 성공을 구분한다.
- 앱 전용 tmux 서버와 대화형 터미널은 공식 CLI 로그인에도 사용한다. 패널 닫기는 detach, 앱 종료는 소유 프로세스 정리다.
- Git/배포 쓰기는 실행 직전 승인·현재 결과를 확인한다. AI 실행과 수동 로그인 터미널을 구분하고, 자동 실행의 권한 경계는 구현 전 독립 검토 결과를 적용한다.
- 이번 요청은 제품 구현과 로컬 검증을 승인한다. 사용자 실제 저장소 push·PR 등록·서비스 배포를 테스트 명목으로 자동 수행하는 승인은 아니다. 실제 외부 쓰기 검증은 준비된 결과를 기준으로 해당 승인 범위에서만 진행한다.

실행 순서와 수용 조건은 v10의 Phase 16–22를 따르되 CLI/API 양쪽 검사 대신 두 CLI의 설정·실제 호출·로그인/취소/재개를 검사한다. 초기 공급자 선호는 미결 사항이 아니다. 추가 CLI 지원과 실제 배포 계정·대상은 사용처가 확인될 때 결정한다.

근거: [GitHub CLI 브라우저 인증](https://cli.github.com/manual/gh_auth_login), [Netlify CLI OAuth](https://cli.netlify.com/commands/login/), [Vercel CLI OAuth Device Flow](https://vercel.com/changelog/new-vercel-cli-login-flow). 확인일 2026-09-24.

[작업 목록](app-operations-platform-tasks.md) · [현재 실행 맥락](app-operations-platform-context.md)
