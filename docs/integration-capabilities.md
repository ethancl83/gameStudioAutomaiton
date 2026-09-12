# 연동 기능·검증 범위

확인일: 2026-09-11. [계획 v3](../dev/active/app-operations-platform/app-operations-platform-plan-v3.md) · [검증 기록](verification.md) · [작업 목록](../dev/active/app-operations-platform/app-operations-platform-tasks.md).

데모는 9개 연결과 5개 엔진을 준비하고 같은 화면·큐·이력에서 작업한다. 실제 모드는 아래 공급자 API/CLI 구현을 사용한다. 공식 명세·모의 HTTP·로컬 실행 검증과 사용자 실계정의 권한·심사·게시·집행 검증을 구분한다.

| 서비스 | 구현된 범위 | 최초 준비·남은 제한 |
|---|---|---|
| Google Play | 기존 앱 AAB/APK 업데이트, 트랙 승격·단계적 출시, 스토어 현지화·이미지, 상품·구독, 판매 ZIP/CSV | 최초 앱·계약·첫 바이너리는 Console. 상품은 초안 생성이며 활성화·모든 구매 옵션은 후속 범위. 실계정 미검증 |
| App Store Connect | JWT, IPA buildUploads·상태 확인, 버전·현지화·앱 정보, TestFlight 그룹·배포·빌드 연결, 심사 제출·재확인·수동/단계적 출시, IAP 가격·판매 보고 | 최초 앱은 Console. Apple 스크린샷/프리뷰 바이너리·macOS pkg·IAP 상태 전환 미지원. iOS 서명·기기·실계정 미검증 |
| Steam | 빌드·브랜치 조회, SteamCMD 지속 세션·업로드, SetAppBuildLive·재확인, 판매·공개 뉴스, 공지 준비 안내 | 전용 계정 1회 Steam Guard. 공개 전환은 모바일 확인 필요 가능. 공지 쓰기·상품 가격은 파트너 사이트. 실계정 미검증 |
| Google Ads | 앱 캠페인 PAUSED 생성·예산·이름·중지·활성화, AppAd 소재 생성, 지출 | Cloud/API 접근 수준, 소재 최소 요건. 활성화 전 소재 확인. 고급 기여 분석·실계정 집행 미검증 |
| AppLovin Ads | 캠페인 생성·조회·변경·중지·지출 | API 접근 허용·MMP·입찰·타기팅 필요. 생성은 즉시 활성화하는 `LIVE`를 명시해야 함; 원자적 PAUSED 생성 미제공 |
| AppLovin MAX | 광고 단위 조회·생성·변경, 추정 광고 수익, Android/iOS SDK 설정 안내 | 게임 내부 SDK 자동 설치·전체 미디에이션 편집·실기기 검증 미구현 |
| AdMob | 앱·광고 단위 조회, 승인 상태·광고 수익, Android/iOS SDK 설정 안내 | 공개 API에 광고 단위 생성/변경 없음. SDK 실행·실기기 미검증 |
| X | OAuth/갱신, 글·답글·멘션·반응 조회, 텍스트 게시·답글, 본인 게시물 삭제·답글 숨김 | 계정 앱 권한·이용 한도. 미디어 업로드·DM·차단은 미지원. 실계정 게시 미검증 |
| Threads | OAuth/장기 토큰 갱신, 글·답글, 텍스트·HTTPS 이미지/동영상·캐러셀 발행·상태 확인, 본인 게시물 삭제·답글 숨김 | 공개 접근 가능한 미디어 URL·해당 권한 필요. 고급 분석·실계정 게시 미검증 |

X/Threads의 프로젝트별 채널·예약·공개 출시 공지·저장된 답글 규칙·일일 한도를 관리한다. 삭제/조정 대상은 동기화한 같은 프로젝트·연결의 자원이어야 하며 자기 글 소유권을 확인한다. Steam 뉴스는 프로젝트 AppID에 귀속하며 공개 쓰기 API가 없는 공지는 사이트 안내로 남긴다. 미지원 작업을 성공으로 기록하지 않는다.

Google/X refresh token, Threads 장기 토큰 갱신, Apple API 키 JWT, Steam 전용 CLI 세션을 재사용한다. 권한 철회·토큰 강제 만료·플랫폼 필수 본인 확인은 필요한 조치로 표시한다. 정상 갱신에는 재로그인을 요구하지 않는다. 키 원문은 SDK 안내·작업 결과에 노출하지 않는다.

Android 서명 키와 SSH 키는 암호화 버전·지문·만료·프로젝트 연결을 관리한다. 실제 Linux SSH 고정 서버 키·Git 의존성 가져오기와 JDK 서명 도구를 검증했다. 로컬/원격 Godot Linux는 실제 게임 실행까지 확인했고 다른 엔진·OS·iOS 서명은 장비 검증이 남았다.

운영·복구 화면에서 최초 연결·엔진·키 준비, 러너 페어링, 설정 백업/병합 복구, 진단, 앱 내 알림을 관리한다. 프로젝트 변경 감시와 예약은 제어 서비스 실행 중에 동작한다. OS 로그인 자동 시작·서명된 업데이트·앱 종료 중 상시 운영과 전체 장비/비밀 백업은 별도 범위다.

필드·공식 출처·예외: [스토어](store-integration.md), [광고](marketing-integration.md), [소셜](social-operations.md), [빌드 키](build-credentials.md), [빌드 지원](build-support.md), [원격 러너](runner-protocol.md), [데모·실행·복구 계약](demo-execution-contract.md).
