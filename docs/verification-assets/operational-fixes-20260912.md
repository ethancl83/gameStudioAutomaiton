# 실사용 검토 후속 수정 — 2026-09-12

[수정 전 검토](operational-review-20260912.md) · [외부 결과물 사용법](../external-artifacts.md) · [작업 목록](../../dev/active/app-operations-platform/app-operations-platform-tasks.md) · [맥락](../../dev/active/app-operations-platform/app-operations-platform-context.md)

사용자가 수정하도록 요청한 운영 문제 4개와 외부 결과물 배포 경로, Apple 이미지 검사 오류를 수정했다. 게임 빌드는 외부에서 수행하는 사용 방식을 기본 출시 화면에 반영했다.

## 수정과 회귀 근거

| 항목 | 결과 | 검증 |
|---|---|---|
| 외부 요청 거절 | 첫 HTTP 변경 요청의 명확한 거절은 전송 전 상태로 되돌려 실패/인증 복구/일시 오류 재시도를 허용한다. 네트워크·408·5xx·앞선 변경/CLI 효과는 확인 대기를 보존한다. | 실제 X 커넥터+큐+SQLite: HTTP 400 뒤 한도 해제, 재시도 가능, 응답 유실 뒤 재전송 금지 |
| 수동 확인 | 이력에서 서비스 확인 내용·결과·리소스 ID를 기록해 대기를 종결한다. 확인 체크·조회 시각 일치·진행 중 재확인 차단을 적용한다. | 근거/확인 누락·오래된 시각 거부, 실패 확정 후 한도 해제, 같은 변경 재시도 금지; 실제 모드 UI 저장 확인 |
| 다중 앱 | 프로젝트별 `sync-app`, 최근 출시 후 짧은 간격 조회, 상품·출시 조회의 프로젝트 선택기를 연결했다. | 같은 Play 연결의 A/B 모두 조회, 계정 sync 1개, 반복/재시작 중복 없음 |
| 캠페인 삭제 | Google Ads·AppLovin Ads 전체 목록 성공 시 사라진 캠페인을 원자적으로 제거한다. | 기존 USD 100 캠페인 제거 후 새 USD 50 허용; 실패·부분 결과·다른 계정 자료 보존 |
| 출시 공지 | 스토어의 실제 공개 상태 관측과 앱·버전 식별자를 저장한다. 초기 과거 목록은 기준선으로만 기록한다. | Play 승격/외부 신규 버전, Apple 승인 후 공개, Steam public 전환, 초기 과거 버전·내부 업로드 제외·중복 방지 |
| 외부 결과물 | 외부 AAB/APK/IPA/Steam 폴더를 복사·검사·보관하고 내부 빌드 없이 업로드한다. | 앱 식별자·서명 정보·손상·프로젝트 귀속·변조·원본 권한 보존·재시작·내부 링크·비밀/외부 링크 차단 |
| Apple 이미지 | 정상 IDAT가 있는 PNG fixture와 await/rejects를 사용한다. 기존 스크린샷 세트 재사용과 별도 예약 생성의 기대값을 실제 계약에 맞췄다. | Apple 이미지 6개 통과, 전체 타입 검사 통과 |

주요 회귀 파일: `tests/operational-fixes.test.ts`, `tests/imported-artifacts.test.ts`, `tests/social-automation.test.ts`, `tests/demo-workflows.test.ts`, `tests/app-store-media.test.ts`.

## 실행 결과

- 전체 `npm test`: **434/434 통과**, 실패·건너뜀 0. `/tmp/appops-fixes-full-tests-final.log`.
- 마지막 데모 상태/수동 기록 UI 보완 후 관련 검사: **27/27 통과**. `/tmp/appops-fixes-final-regression.log`.
- `npm run typecheck`, `npm run build`: 통과. `/tmp/appops-fixes-typecheck-final3.log`, `/tmp/appops-fixes-build-final.log`. 이 빌드는 운영 앱의 TypeScript/Vite 검증이며 게임 빌드를 출시 경로에서 수행한 것이 아니다.
- 초기 전체 검사에서 데모 신규 자동 동기화가 오류 시나리오·백업과 경합한 문제를 수정했다. Android SDK 실설치 테스트의 취소 후 임시 폴더 정리도 installer 종료를 먼저 기다리도록 수정했다. SDK 제품 기능 변경 없이 재검사 전체 통과.
- 브라우저에서 데모와 실제 모드의 결과물 가져오기→업로드 완료를 각각 조작했다. 실제 모드에서는 원본/엔진 없는 프로젝트와 모의 Play 커넥터를 사용했다. 가져오기 API는 실제 파일 복사/검사 경로를 실행했다. 결과 불명 작업의 확인 근거 저장도 화면에서 검증했다. 아래 증거 화면과 `/tmp/appops-fixes-ui/` 실행 로그를 참조한다.

## 범위

실계정 로그인·스토어 배포·광고 집행·SNS 게시 요청은 실행하지 않았다. HTTP 모의 응답, 임시 DB와 메모리 키 보관함으로 검증했다. 이미지/모바일 바이너리 fixture의 서명은 구조 검사 전용이며 실제 배포 인증서 검증을 증명하지 않는다. 네이티브 파일 선택 대화상자는 타입/IPC 경계 검사로 확인했고 실제 화면 조작은 Chromium 브라우저에서 수행했다. 기존 AppImage는 다시 패키징하지 않았다.

화면 증거: [데모 가져오기](external-artifact-demo-20260912.png) · [실제 파일 가져오기](external-artifact-live-20260912.png) · [업로드 완료](external-artifact-upload-20260912.png) · [수동 결과 확인](manual-resolution-20260912.png).
