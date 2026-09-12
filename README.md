# App Operations

프로젝트 폴더에서 검수·빌드·서명·배포를 시작하고 스토어·광고·수익·SNS/커뮤니티와 작업 이력을 관리하는 로컬 데스크톱 앱이다. 서비스 계정과 빌드 키는 최초 등록 후 재사용하고 지원하는 인증 갱신은 자동 처리한다.

기본 데모에서 9개 서비스와 5개 엔진의 프로젝트를 바로 관리할 수 있다. 데모에서 빌드·배포·광고·상품·게시·키·복구를 실행한 뒤 실제 모드로 전환해 계정을 연결한다. 두 모드의 데이터와 외부 실행은 분리된다. Electron·React 화면, SQLite 작업 큐, 암호화 보관함, Linux 로컬/원격 격리 빌드와 공급자 API 어댑터를 사용한다. 현재는 개발 버전이며 실계정·다른 OS·전체 수용 검사를 완료한 출시 버전은 아니다. 수행한 검증은 [검증 기록](docs/verification.md)에 구분한다.

검증한 개발 패키지: [Linux AppImage](<release/App Operations-0.1.0.AppImage>). 전체 검사 246개·타입·패키지 제어 서비스의 데모 출시·백업 검사를 통과했다. 실계정 게시/배포 검증과 네이티브 창 실행 제약은 아래와 검증 문서를 참고한다.

## 실행

Node.js 22.13 이상과 npm이 필요하다. 검증 환경은 Node 22.22.1/Linux x64다.

```bash
npm ci
npm run build
npm run desktop
```

데스크톱이 제어 서비스를 시작한다. 별도 실행에는 `npm start`를 사용한다. 연결 정보 저장에는 OS 보관함이 필요하고 Linux 빌드는 bubblewrap과 엔진·전용 도구 캐시를 요구한다. 자세한 조건은 [빌드 지원표](docs/build-support.md)와 [인증 안내](docs/credential-lifecycle.md)를 따른다.

브라우저 개발은 서로 다른 터미널에서 `npm run dev`와 `npm run preview`를 실행한다. dev는 제어 서비스와 Vite, preview는 같은 사용자의 비공개 미리보기 세션으로 브라우저를 연다. 기본 포트는 4317/5173이다. `APPOPS_DATA_DIR`, `APPOPS_PORT`, `APPOPS_DEV_PORT`로 분리하며 두 명령에 같은 값을 적용한다.

```bash
npm run typecheck
npm test
npm run pack
npm run dist
```

pack은 현재 OS 실행 폴더, dist는 설치/배포 파일을 release/에 생성한다. Linux 실행 폴더 생성을 확인했으며 macOS·Windows 실행, 서명·공증·자동 업데이트는 미검증이다. 현재 검증 호스트는 Electron sandbox 권한 제약으로 네이티브 창 기동이 막혀 있으며, 브라우저 미리보기로 실제 UI·API를 검증했다.

## 사용

1. 데모에서 준비된 프로젝트를 선택하고 **검수·빌드·출시**로 전체 흐름을 확인한다. 실제 사용은 상단에서 실제 운영으로 전환한 뒤 프로젝트 폴더를 등록한다.
2. 스토어·광고·수익·X/Threads 채널과 필요한 [빌드 키](docs/build-credentials.md)를 한 번 연결한다.
3. 프로젝트 정책에 연결·빌드·배포·광고 예산 범위를 저장한다.
4. 프로젝트의 검수·빌드·출시를 실행하거나 스토어 자료·심사·광고 소재·상품·게시 작업을 실행한다. 저장한 정책으로 소스 감시·자동 빌드·시험 업로드·정기 동기화를 수행한다. 커뮤니티 화면에서 예약 게시·출시 공지·답글 규칙을 관리한다.
5. 운영·복구에서 준비 상태, 원격 러너, 설정 백업·복구, 앱 내 알림을 관리하고 이력에서 로그·산출물·처리 상태를 확인한다. 외부 반영 결과가 불명확한 변경은 중복 전송하지 않는다.

계정과 키는 최초 연결 후 재사용하며 정상 토큰 갱신은 자동이다. 플랫폼의 최초 앱 등록·계약·필수 권한, 빌드 엔진·SDK·인증서는 준비 상태에서 확인한다. AdMob/MAX는 플랫폼별 SDK 설정 안내를 제공하며 프로젝트 내부의 광고·결제 SDK를 자동 설치하지는 않는다. Steam 공지 게시와 공개 브랜치의 모바일 확인 같은 플랫폼 필수 단계는 해당 서비스에서 완료해야 한다. 실제 범위는 [연동 기능표](docs/integration-capabilities.md)와 [사용 안내](docs/desktop-usage.md)에 기록한다.

## 개발 문서

2026-09-11 고정한 **[계획 v3](dev/active/app-operations-platform/app-operations-platform-plan-v3.md) → [작업 목록](dev/active/app-operations-platform/app-operations-platform-tasks.md) → [작업 맥락](dev/active/app-operations-platform/app-operations-platform-context.md)** 순서로 읽는다. [v1](dev/active/app-operations-platform/app-operations-platform-plan.md)·[v2](dev/active/app-operations-platform/app-operations-platform-plan-v2.md)를 승계하며 데모·실제 운영 통합을 추가했다. 원본 계획을 보존하고 진행 정보는 tasks/context에 기록한다.

| 문서 | 내용 |
|---|---|
| [데모·실제 계약](docs/demo-execution-contract.md) | 모드·출시·소재·복구 |
| [원격 러너](docs/runner-protocol.md) | 최초 연결·실행·지원 범위 |
| [구현 계약](docs/implementation-contract.md) | 모듈·API·담당 |
| [작업 실행 계약](docs/workflow-contract.md) | 중복 방지·복구·이력 |
| [자동화 정책](docs/automation-policies.md) | 반복 실행·예산·중단 조건 |
| [지표 정의](docs/metric-definitions.md) | 원천·정정·중복·금액 |
| [카탈로그](dev/dev-catalog.md) | 전체 계획 진행 상태 |
