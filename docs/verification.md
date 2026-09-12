# 구현 검증 기록

Last Updated: 2026-09-12 (실사용 결함 후속 수정 완료; 아래 v3 검증은 과거 체크포인트)

[계획 v5](../dev/active/app-operations-platform/app-operations-platform-plan-v5.md) · [작업 목록](../dev/active/app-operations-platform/app-operations-platform-tasks.md) · [맥락](../dev/active/app-operations-platform/app-operations-platform-context.md) · [실제 지원 범위](integration-capabilities.md)

## 2026-09-12 실사용 결함 수정

요청 거절 복구·수동 확인, 앱별 동기화, 삭제 캠페인 예산, 실제 공개 공지, 외부 결과물 가져오기/업로드와 Apple 이미지 검사를 수정했다. **전체 434/434**, 마지막 관련 검사 **27/27**, 타입 검사·운영 앱 컴파일 통과. 데모/실제 모드의 외부 결과물 업로드와 수동 확인 화면을 Chromium으로 검증했다. 실계정 요청은 수행하지 않았다. [수정 내용·검사 로그·화면 증거](verification-assets/operational-fixes-20260912.md) · [사용법](external-artifacts.md).

## 2026-09-12 실사용 검토 (수정 전)

계정 연결 완료·앱 내부 빌드 제외 조건에서 운영 결함 4개를 재현하고 외부 결과물 배포 경로 부재를 확인했다. 선택한 기존 검사 262개 중 258 통과·Apple 이미지 4 실패, 전체 typecheck는 테스트 코드의 TS2339 오류 3개로 실패했다. node tsconfig 검사는 통과했다. 제품 코드는 수정하지 않았다. [상세 결과·범위·재현](verification-assets/operational-review-20260912.md) · [결과 JSON](verification-assets/operational-review-20260912.json).

## v3 통합 검증

- `npm test`: **246/246 통과**, 실패·건너뜀 0. `/tmp/appops-full-v3.log`.
- `npm run typecheck`: 화면·Node 타입 검사 통과. `/tmp/appops-typecheck-v3.log`.
- `npm run pack`: TypeScript·Vite와 Linux 패키지 생성 통과. `/tmp/appops-pack-v3.log`.
- `npx electron-builder --linux AppImage --prepackaged release/linux-unpacked --config electron-builder.json`: [Linux AppImage](<../release/App Operations-0.1.0.AppImage>) 생성, 134,080,539 bytes. SHA-256 `0c859b6294b144fab8e9b3a7c3a3e83e459a3c40c545bff77d806750ff1a5d72`. `/tmp/appops-appimage-v3.log`.
- 패키지 Electron Node 프로세스에서 인증 없는 상태 조회 401, 실제 연결/프로젝트 0, 데모 연결 9/프로젝트 5, 데모 검수→빌드→업로드 성공, 설정 백업, 실제 이력 불변을 확인했다. [패키지 증거](verification-assets/v3-packaged-controller.json). 재현: `ELECTRON_RUN_AS_NODE=1 release/linux-unpacked/app-operations scripts/verify-packaged.mjs`.
- 실제 Linux 원격 러너의 Godot export와 회수한 게임 headless 실행 성공. [결과](verification-assets/v3-remote-godot.json). 실행 파일 66,074,584 bytes와 PCK 1,840 bytes를 동일 폴더에 회수했다. 재현 `npx tsx scripts/verify-remote-godot.ts` (아래 Godot 도구 환경 변수 사용).
- Opus와 코디네이터가 실제 브라우저에서 게시·예약·키·소재·파이프라인·러너·진단·백업 복원·모드 전환을 확인했다. 새 데모 제어 화면에서 네트워크 오류→자동 재시도(2번째 성공), 초기화→기본 9개 연결·5개 프로젝트 복귀와 실제 공간 보존도 확인했다. [Opus 화면 기록](verification-assets/v3-browser-report.md), [코디네이터 화면 기록](verification-assets/v3-root-ui-report.md), [초기화 후 대시보드](verification-assets/v3-demo-reset-dashboard.png).
- 독립 Sol 리뷰의 화면·광고·백엔드 지적을 수정하고 재검토를 마쳤다. Apple 리소스 소유권·심사 상태는 Grok이 수정했고 별도 Sol이 검증했다. 알림 만료 시간과 검수 단계 설명도 정정했다. [최종 리뷰 목록](verification-assets/v3-final-review-summary.md), [백엔드 수정 확인](verification-assets/v3-backend-fix-verification.md). 남아 있는 지적 없이 요청한 v3 개발 검증 범위를 마쳤으며 완료 워커는 모두 해제했다.

v3 추가 검사에는 영속 데모·모드 전환 경계, 5개 엔진 합성 출시·멱등성, 인증/네트워크/심사 실패, 백업 병합·해시·작업 중 차단, 미디어 귀속·변조, 원격 묶음·HTTP 인증, Play 임시 편집 정리와 불명확한 커밋 구분, Apple 앱 소속과 모든 심사 상태, 광고 iTunes ID·SDK 비밀 제거를 포함한다.

환경: Linux x64, 호스트 Node 22.22.1(패키지 Electron 내장 Node 24.20.0), npm 9.2.0, Electron 44.3.0, TypeScript 7.0.2, React 19.3.0, Vite 8.3.0, electron-builder 26.15.3. 이전 v2 체크포인트는 188개 검사·패키지 기동·fflate 0.8.3 반영 후 npm audit 0건을 기록했다(2026-09-11). 현재 링크의 AppImage는 v3 산출물로 갱신했다.

## 실제 경계 검사

| 경계 | 확인 내용 |
|---|---|
| 인증 | AES-GCM/AAD 변조, 키 유실·잠김, OAuth PKCE/state 재사용·만료, 동시 갱신·회전 저장·재시작 |
| API·미리보기 | 실제 HTTP Bearer·Host·Origin·Electron IPC, 0600 인증 파일, Vite의 비공개 세션과 Origin 위조 차단 |
| 내구성 | SQLite 재시작·lease fencing·직렬화·취소 후 늦은 응답·멱등 충돌·외부 응답 유실 후 비재전송 |
| 자격 증명 저장 | DB 메타데이터/이력 저장 실패, 암호문 보상 삭제 실패, 미등록 키 버전 정리, OAuth 승인 1회로 DB 재시작 복구 |
| SSH | 생성한 암호화 개인 키, 실제 OpenSSH+Git+loopback SSH 서버 인증·clone·커밋·서버 키 변경 차단 |
| Android 키 | 실제 keytool/jarsigner·장기 P12·JAR 서명, 미래 시작·짧은 만료·잘못된 KeyUsage 거부, 지문·별칭·버전 확인 |
| 러너·스냅샷 | 실제 bwrap 파일/네트워크/프로세스 격리, 호스트 접근 차단·취소, 비밀·Git 제외, 실행 비트·해시·필수 산출물 확인 |
| 스토어 | 공식 명세 기반 모의 HTTP, Apple 업로드/상품/가격 복구, Steam 암호화 세션·VDF·전체 산출물 staging |
| 수익·예산 | BigInt 금액·환불·통화, Play UTF-16 ZIP/CSV·월 정정, AdMob Android 앱 귀속·MAX 중복 제외, 계정 간 예산 예약 |
| SNS | X/Threads 공식 OAuth·게시/답글 페이로드·토큰 갱신, 소유권·프로젝트 범위, 예약 재시작/부분 채널/취소, 공개 출시 공지·답글 규칙 |
| SNS 실패 | Threads 준비 확인 후 발행·취소·상한, 응답 유실 비재게시, 확정 실패 이력·한도 해제, 한도 축소 시 오래된 예약 우선 |
| Steam 뉴스 | 같은 계정을 공유하는 여러 프로젝트의 정확한 AppID 귀속, 다른 AppID의 잘못된 귀속 차단 |

외부 API 응답은 주입한 모의 fetch로 검사했다. SSH·Git·JDK·bwrap·SQLite·로컬 HTTP는 실제 도구를 실행했다. 사용자 키·실제 계정·외부 게시·광고 집행·스토어 배포는 검증에 사용하지 않았다.

## 실제 Godot 빌드

공식 Godot 4.3 Linux 편집기와 export templates로 격리 내보내기와 생성 게임의 headless 실행을 통과했다. 이어 실제 제어 서비스에서 프로젝트 등록 → 소스 스냅샷 → 격리 빌드 → 산출물 해시 → 이력 저장을 통과했다. 실행 `365f75c7-71c0-4a29-9550-0de33c8cd1bc`, 실행 파일 66,074,584 bytes + PCK 1,840 bytes. [결과 JSON](verification-assets/godot-controller-20260911.json), [도구·세부 기록](build-support.md).

재현 명령(준비한 공식 편집기/템플릿 경로):

```bash
APPOPS_GODOT_PATH=/tmp/appops-godot-verification-20260911/downloads/Godot_v4.3-stable_linux.x86_64 APPOPS_GODOT_DATA_DIR=/tmp/appops-godot-verification-20260911/godot-data npm run verify:godot
```

## 실제 화면 검사

Opus 워커가 격리된 실제 제어 서비스·메모리 KeyProvider·모의 공식 API와 실제 키 도구로 브라우저 흐름을 검사했다. SSH/Android 키 등록·교체·프로젝트 바인딩·사용 중 삭제 409·해제·삭제, X OAuth callback·정책 저장·화면에서 작성한 게시·답글·예약 취소·오류 표시를 확인했다. 라벨만 수정할 때 credentials가 누락되는 화면 결함도 수정했다. [검사 기록](verification-assets/desktop-smoke-20260911.md), [커뮤니티 화면](verification-assets/community-smoke-20260911.png), [빌드 키 화면](verification-assets/build-keys-smoke-20260911.png).

광고/수익화의 모든 쓰기 폼에 필수 프로젝트를 연결하고 자원 행의 프로젝트를 미리 선택하도록 수정했다. 중복 externalId 입력을 없애고 여러 국가·통화·금액 입력을 검증했다. [화면 수정 기록](verification-assets/marketing-ui-fix-20260911.md). 최종 개발 서버를 최신 코드로 재시작하고 비공개 브라우저 세션의 프로젝트·커뮤니티 화면을 다시 확인했다.

이 호스트는 Electron chrome-sandbox 권한 및 AppArmor 제한으로 네이티브 창 기동이 막힌다. --no-sandbox나 시스템 보안 설정 변경으로 우회하지 않았다. **패키지 생성·패키지의 제어 서비스 기동·브라우저 UI 성공과 네이티브 창 실행을 구분한다.**

## 독립 리뷰

Sol의 초기 구현 리뷰 9건 및 후속 기반 6건을 수정·검증했다. 광고 리뷰 8건은 백엔드·문서 7건의 Opus 확인과 화면 필수 프로젝트 수정으로 반영했다. [광고 수정 확인](verification-assets/marketing-fix-review-20260911.md)은 당시 남았던 화면 항목을 명시하며, 위 화면 수정 기록이 후속 증거다.

새 키·SNS에 대한 Sol 리뷰는 인증서 검사, 저장 장애 복구, Steam 귀속, 한도 축소 시 실행 순서 4건을 제시했다. 코디네이터가 수정한 뒤 별도 Sol 세션에서 네 항목과 Threads 종결 실패 흐름을 다시 확인했다. 범위 내 남은 수정 사항 없음, 집중 검사 48/48 통과. [최초 지적](verification-assets/key-social-review-20260911.md) → [수정 검증](verification-assets/final-fix-review-20260911.md).

실제 Opus·Grok Orca 워커를 사용했다. Fable 요청 세션은 런처 기록과 워커의 런타임 Opus 4.8 자기 식별이 불일치했으므로 Fable 수행 실적으로 확정하지 않는다. 고난도 키·인증·동시성 통합은 코디네이터가 직접 구현했다. 완료 워커는 해제·종료했다.

## 남은 범위

실서비스 계정·권한·업로드·심사·광고 집행·SNS 게시, macOS/Windows 실행·격리·서명, Unity/Unreal 라이선스·프로젝트, 설치 가능한 Android 앱·기기·APK build-tools 실행, OS 재부팅·장비 이전·30일 관찰은 미검증이다. Android 서명 검사의 입력은 JAR 형식 테스트 산출물이며 실제 설치 가능한 앱을 증명하지 않는다.

Steam 공지 쓰기·신규 앱의 필수 Console 단계, macOS/Windows 내장 격리, Apple 스크린샷/프리뷰·pkg, 게임 내부 광고/결제 SDK 설치, 고급 미디에이션·기여 분석, 자동 시작·업데이트와 전체 장비/비밀 백업은 [연동 기능표](integration-capabilities.md)와 [작업 목록](../dev/active/app-operations-platform/app-operations-platform-tasks.md)에 남겨 두었다. 전체 계획의 수용 검사를 완료한 출시 버전으로 표시하지 않는다.
