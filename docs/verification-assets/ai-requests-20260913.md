# AI 요청·세션 유지 검증 — 2026-09-13

## 변경 범위

사용자 명시 요청(채팅·화면 버튼)으로만 실행하는 Codex/OpenCode CLI 연결, 프로젝트/전체 운영 대화 보관, 정확한 native session resume, 실행 중 clear와 응답 격리, 프로젝트 자료·이미지·스토어 도구를 연결했다. 기본 Electron 창의 기존 `isTrustedSender` 재귀가 모든 IPC를 막는 현상을 실제 창에서 재현하고 `isTrustedFrame` 호출로 수정했다.

## 실행 검사

- `node --import tsx --test tests/project-agent.test.ts tests/desktop-mode.test.ts`: **25/25 통과**. 새 AI 검사 17개와 기존 Electron 권한 검사 8개.
- 새 검사: 등록/조회/재시작의 실행 0건, 실제 HTTP/MCP 도구, 분석 근거·PNG 생성·미리보기·큐 반영, 이미지 미반영의 완료 차단, 프로젝트·계정 범위, 인증·Origin·요청 크기, 중복 intent, 취소, 영속 DB 재시작, 제공자 고정, 두 CLI의 정확한 resume 인수, clear 경합과 늦은 응답 차단, ID 누락·변경 거부, native JSON 이벤트 및 실제 subprocess 종료/취소/실패.
- `npm run typecheck`, `npm run build`: 통과. Vite는 단일 JS 청크가 500 kB를 넘는 기존 경고 기준에 도달한다. 설치 패키지 배포는 수행하지 않았다.
- 전체 `npm test`: **451개 중 409 통과, 36 실패, 6 skip**. 동일 macOS 환경의 깨끗한 `HEAD`를 OS 임시 디렉터리에 풀어 재검사한 결과 **434개 중 392 통과, 36 실패, 6 skip**. 실패한 테스트 이름 집합이 정확히 일치하며 신규 실패는 0건이다. 전체 검사가 통과했다고 표시하지 않는다.
- 기존 실패: 개인키 임시 경로/격리 조건, macOS 경로·심볼릭 링크 가정, 백업 복원, SDK 통합/외부 SDK·Godot 도구 환경, Linux bwrap 의존 빌드·SSH 검사. 이번 변경에서 해당 기능을 우회하거나 skip하지 않았다.

원시 로그와 비교 결과는 워크스페이스 `tmp/ai-requests-20260913/`에 보관한다.

## 실제 Electron 화면

Playwright로 macOS Electron 44.3.0의 컴파일된 앱을 기동했다. 별도 데이터 디렉터리·메모리 보관함·CLI 대역과 실제 controller/HTTP/SQLite/MCP/UI를 사용했다. 실제 계정과 모델은 호출하지 않았다. 종료 단계의 Playwright close가 제한 시간 안에 반환하지 않아 검증 전용 PID에 SIGTERM으로 정리했다.

| 확인 항목 | 결과 |
| --- | --- |
| 기동/폴더 등록 후 AI 미실행 | AI task 0건 |
| 프로젝트를 선택한 화면 버튼 | 입력 없이 해당 projectId와 화면 요청이 대화에 기록됨 |
| 버튼 → 추가 채팅 | 같은 native ID, 대화 entry 증가, 제공자 선택 고정 |
| 클리어 → 다음 요청 | 대화 초기화, 제공자 재선택, 이전과 다른 native ID |
| 실행 중 클리어 | CLI 대역 취소, 늦은 응답 없이 빈 대화 유지 |
| 화면 이동·새로고침 | 실행 없이 기존 대화 복원 |
| 전체 화면 | 12개 화면에 공통 AI 요청/대화 버튼, 마케팅의 화면 문구·범위 전달 |
| 네이티브 연결 | 기존 최대 호출 스택 오류 재현 → 수정 후 정상 연결 |
| 화면 배치 | 실행 표시 크기와 모달 입력창 잘림을 수정하고 재확인 |

초기 창 1360×868과 작은 창 1100×728에서 프로젝트/전체 대화, 실행/완료/clear 상태를 확인했다. 창의 대화 입력·클리어·전송이 표시 영역 안에 들어온다. 스크린샷: [채팅](../../tmp/ai-requests-20260913/chat-resume.png), [마케팅 요청](../../tmp/ai-requests-20260913/marketing-request.png), [생성 이미지](../../tmp/ai-requests-20260913/generated-artwork.png), [작은 창](../../tmp/ai-requests-20260913/compact-chat.png).

## 기획 워커와 제한

`$orchestration`/`$ai-team`으로 Orca Run `run_21d450daf360` 안에서 Codex `gpt-5.6-sol/high` 워커를 사용했다. 최초 `task_15b014402343`/`ctx_266e625dfd17`에서 2차 기획을 작성하고, 최신 요청 기준의 `task_998c1daadcfb`/`ctx_4cbb378f28fc`에서 v2·tasks·context를 보완했다. 두 worker_done을 수용했고 마지막 dispatch를 해제한 뒤 delivery를 ack했다. 루트가 문서의 요구사항·링크·미구현 상태를 검토했다. 제품 구현은 루트가 수행했고 독립 구현 리뷰로 표현하지 않는다.

실제 Codex/OpenCode 로그인·모델 호출, 설정된 이미지 생성/브라우저 도구, 스토어 계정 신규 생성·반영과 Windows/Linux 네이티브 동작은 이번 검증에 포함하지 않았다. 로컬 CLI 도움말/공식 이벤트 계약과 CLI 대역 검증을 실서비스 검증으로 간주하지 않는다. 실계정 요청·게시·광고 집행·커밋·push는 0건이다.

[사용법](../ai-operations.md) · [검증 색인](../verification.md) · [계획 v7](../../dev/active/app-operations-platform/app-operations-platform-plan-v7.md)
