# v3 데스크톱 UI 라이브 검증 보고서 (Opus, 독립 Orca 브라우저)

- 일시: 2026-09-11 KST
- 대상: `apps/desktop` v3 완성 흐름, 실 컨트롤러 데모 데이터
- 환경: Vite `127.0.0.1:5175`, 컨트롤러 `:4317`, `APPOPS_DATA_DIR=/tmp/appops-live-review-20260911`, 앱 v0.1.0
- 방법: **새 Orca 임베디드 브라우저 페이지**(`bb523eeb-…`)에서만 조작. 코디네이터 루트 페이지(`650b938f-…`)는 열지 않음. dev-session 부트스트랩 토큰으로 내부 인증(토큰·쿠키·bearer·URL 해시 미출력, 부트 후 `history.replaceState`로 프래그먼트/쿼리 제거). 모든 변경은 **UI 클릭·폼 입력**으로 수행(읽기 전용 eval은 근거 수집·정확한 값 확인용). API를 UI 대체로 사용하지 않음.
- 결과 요약: **요청된 주요 흐름 전부 성공, 코드 결함 0건.** 데모/한계 표기는 정직하게 유지됨. 데모(9 연결·5 프로젝트)와 성공 릴리스/크리에이티브/미디어 이력은 유지됨.

> 참고: 실제 모드 전환(기존 실제 데이터 보존↔데모 복귀), 운영 러너 등록/검사, 빌드 러너 선택, 진단, 백업 생성/복원, DemoControls 시나리오/리셋은 **루트가 소유**(코디네이터 분담). 아래는 루트 소유 흐름에서 실측으로 관찰된 부분만 인용한다.

---

## 1. 커뮤니티 — X (Twitter) 게시물 작성 · 성공
- 경로: 커뮤니티 → X (Twitter) · Orbit Games → 게시물 작성.
- 폼: 프로젝트 선택 + 게시 문구. 정직한 안내 — 데모 배너("데모 저장공간에 기록되며 실제 공급자에 전송되지 않습니다. 결과의 성공 표시는 실제 공급자의 성공이 아닙니다"), 어댑터 한계(평문 텍스트만, X 미디어는 URL 게시 안 함, 가중 길이 280, delete=`DELETE /2/tweets/:id`, hide=`PUT /2/tweets/:id/hidden`, 전송 후 결과 미확인 시 미해결 유지·자동 재게시 없음), 멱등 재시도 안내("응답이 유실되어도 같은 요청으로 재시도하며 중복 생성/증액을 방지합니다").
- 실행: "Starlight Valley 업데이트 소식! v3 검증 포스트입니다. #indiegame" → **성공(create-post)**. 완료 토스트 표시, X 카드 목록에 새 게시물 노출, 커뮤니티/이력 카운터 증가.
- 증거: `v3-community-x-compose.png`, `v3-community-x-result.png`

## 2. 커뮤니티 — Threads 미디어 폼 · 게시(발행) · 성공
- 폼 필드: 프로젝트, 게시 문구, **미디어 형식 select(TEXT/IMAGE/VIDEO/CAROUSEL)**, 이미지 https URL, 동영상 https URL, 캐러셀 URL JSON 배열.
- Threads 전용 한계가 X와 구분되어 정확히 표기됨: 텍스트+공개 https image_url/video_url·캐러셀(2–20)만, 로컬 파일 업로드·임의 스크립트 없음; 길이 500자(이모지 UTF-8 바이트); hide=`manage_reply`, delete=`threads_delete`(계정당 하루 100회); **발행 전 컨테이너 status가 FINISHED가 될 때까지 유한·중단 가능 폴링 후 정확히 한 번 발행**; 폴링 한도 초과/중단 시 발행하지 않고 컨테이너 ID로 reconcile(읽기 전용) 복구·자동 재발행 없음.
- 실행: 미디어 형식 IMAGE + 공개 https URL(`https://cdn.orbitgames.example/starlight/promo-01.jpg`) + 문구 → 컨테이너→발행 흐름 거쳐 **성공(create-post)**.
- 증거: `v3-community-threads-media-form.png`, `-media-filled.png`, `-media-ready.png`, `-media-result.png`

## 3. 커뮤니티 — 미래 예약 게시 → 취소 · 성공
- 예약 게시 추가 폼: 내용, **게시 시각(datetime-local, 미래)**, 채널 체크박스. 채널은 **Threads·X만 제공(Steam 제외=정상, Steam 뉴스는 수동)**.
- 실행: 2026-09-15 10:00, X 채널, 문구 지정 → 목록에 "예약됨 · 2026.09.15 오전 10:00 · 채널 X (Twitter) · Orbit Games · 예약 취소" 노출.
- 취소: 예약 취소 클릭 → 목록 비워짐("예약된 게시가 없습니다. … 대기 중인 예약만 취소할 수 있습니다"). 자동화 정책 안내도 정직(자동 답글은 정확 일치 시 저장 응답만, 외부 내용 명령 실행 없음).
- 증거: `v3-community-schedule-form.png`, `-schedule-filled.png`, `-schedule-created.png`

## 4. 프로젝트 필터 선택 · 성공
- 커뮤니티 상단 프로젝트 콤보박스(선택 안 함 + 5개 프로젝트). Neon Frontier 선택 → 자동화 정책 헤딩이 "Neon Frontier · 커뮤니티 자동화 정책"으로 재범위화. Starlight Valley로 복귀.
- 증거: `v3-project-filter.png`

## 5. 빌드 키 관리(데모 SSH 등록·회전, Android/SSH 프로젝트 바인딩) · 성공
- 위치: 환경·정책 → 빌드 서명·SSH 키(등록/회전) + 프로젝트 → 빌드 보안(바인딩).
- 초기 데모 키 2개: Orbit 저장소 SSH(v1, `git@git.demo.invalid`), Orbit Android 배포 서명(v1). 카드에는 지문·호스트·버전 등 **메타데이터만** 표시(비밀 미노출).
- 등록: 새 SSH 키 "v3 검증 사설 SDK SSH" — 데모는 **라벨+종류만** 입력(정직한 안내: 루트가 합성 자격 증명 생성) → 개수 2→3, 지문 생성.
- 회전: 새 키 수정·회전 → **v1→v2**, 수정 시각 갱신.
- 프로젝트 바인딩: Starlight Valley → 빌드 보안. Android 서명 키 select는 **Android 키스토어만 노출(SSH 필터링=정상)**; Orbit Android 키스토어 선택 + SSH 의존성 추가(키=신규 v3 키, 저장소 `ssh://git@git.demo.invalid/orbit/private-sdk.git`, 리비전 `v1.4.0`, 배치 경로 `addons/private_sdk`) → **빌드 보안 저장 = "저장되었습니다"**(오류 없음). 사용 중 키 삭제 거부 안내 문구 확인.
- 도구 체인: Godot 4.3·Unity 6·Unreal 5.5·Android SDK·Xcode 16 모두 사용 가능(데모).
- 증거: `v3-buildkeys-initial.png`, `-register-form.png`, `-rotate-form.png`, `v3-buildsecurity-tab.png`, `-bound.png`

## 6. ActionForm 모달 가독성 수정(루트 HMR) 검증 · 통과
- 루트가 내 초기 Threads 스크린샷 지적을 반영: 기술 한계 블록을 접기 처리, 데모 안내 축약, 성공 sync/check 토스트 억제·정보 8초 만료·토스트를 모달 오버레이 아래 배치.
- 실측(HMR 적용 후 재오픈): 데모 안내 1줄("선택한 작업은 데모 데이터에 반영됩니다"), 한계는 "▶ 서비스별 지원 범위와 참고 사항"으로 접힘, **푸터 취소/실행이 완전히 보이고 클릭 가능**(`elementFromPoint`가 실행 버튼과 일치, 토스트 미가림).
- 증거: `v3-actionform-modal-final.png`

## 7. 반응형 폭 · 통과
- iPhone 12 390px(DPR3): 사이드바 내비 → 상단 가로 스크롤 바, 콘텐츠 단일 열. **가로 오버플로 없음**(`documentElement.scrollWidth == innerWidth == 390`).
- iPad 820px(DPR2): 3열 그리드, 오버플로 없음. 데스크톱 991px: 전체 사이드바.
- 페이지 새로고침으로 디바이스 에뮬레이션 해제, 쿠키/인증 유지(api 200).
- 하네스 주의: `orca screenshot`가 디바이스 에뮬레이션에서 캡처를 타일/반복 렌더(하네스 quirk, 앱 결함 아님 — 오버플로 검사는 깨끗하고 좌상단 quadrant가 대표). 
- 증거: `v3-responsive-mobile.png`, `v3-responsive-tablet.png`

## 8. 스토어 자원 가시성(루트 ReleasesView 변경) · 확인
- 스토어 배포: 출시 파이프라인(Starlight Valley→Google Play, 완료 x2) + **크리에이티브/리스팅 행이 릴리스 옆에 노출**: `upload-listing-image`(active), "Pocket Garden 스토어 설명 · demo-listing-unity-1 · 소재 · LIVE".
- 정직한 안내: "업로드 성공, 심사 접수, 실제 공개는 서로 다른 상태입니다. 각 출시의 상태를 스토어 원문 그대로 표시합니다." Google Play 작업에 "최초 앱 등록 안내"(수동 최초 등록)·"스토어 이미지 등록" 포함.
- 증거: `v3-store-releases.png`

## 9. 재시작 후 지속성 · 최종 대시보드 · 확인
- 코디네이터의 1회 통제 재시작(20:28, Vite/컨트롤러 정상) 후 dev-session에서 재인증(고유 쿼리+프래그먼트 토큰, 부트 후 프래그먼트·쿼리 제거, path `/`, api 200).
- 데모 데이터 복귀 확인: 데모 모드, 프로젝트 5, 연결 9, 활성 캠페인 6, 수익 개요 USD 기여이익 US$2,985.50(수익 US$4,851.00 − 광고비 US$1,865.50) — 재시작 전후 일관.
- **활동 원장이 내 작업을 재시작 넘어 보존**: "v3 검증 사설 SDK SSH 데모 키 1버전/2버전을 저장", "프로젝트 빌드 키와 SSH 의존성 연결을 저장".
- **복원 의미 관찰(루트 실행)**: 원장 상단에 "프로젝트 설정을 복구했습니다. **기존 계정·키·작업 이력을 보존하고 자동 실행은 껐습니다**." — 백업/복원이 계정 키·거래 원장을 보존하고 자동화를 일시중지한다는 문서 계약(desktop-usage.md)과 일치. (백업/복원 스크린샷 `v3-backup-restored.png`·미디어 `v3-media-upload.png`는 루트 생성물.)
- 증거: `v3-dashboard-final.png`(최종 폴리시 대시보드), `v3-dashboard-initial.png`

---

## 정직하게 유지되는 제품 한계 (확인)
- **Steam 뉴스 쓰기는 수동**: 커뮤니티 Steam 카드는 "Steam 공지 게시 안내"·"Steam 공지 준비"만 제공(자동 게시 아님), 예약 채널에서 제외됨.
- **iOS/macOS 실 엔진은 라이브 미검증**: 도구 체인은 데모 표기, 네이티브 iOS/Mac 실 빌드·서명 종단은 데모에서만 흐름 확인.
- **데모 실행은 실제 공급자 미전송**: 모든 쓰기 폼이 데모 배너로 명시, 성공 표기가 실제 공급자 성공이 아님을 밝힘.
- (미검증) 실계정·Electron 네이티브 창 종단, 세 OS 실 러너.

## 결함 / 회귀
- **없음.** 요청된 흐름 전부 UI로 성공. 이전 독립 리뷰(`appops-desktop-v3-review-task`)의 후보 결함들은 이번 라이브 검증 범위(소셜/예약/키/반응형/스토어 가시성/모달 가독성)에서 재현되지 않았고, 관련 정직성 표기(멱등 재시도·상태 구분·수동 단계·비밀 미노출)가 실제로 동작함.

## 하네스 주의(앱 결함 아님)
- 백그라운드 자동 sync 토스트가 스냅샷 ref를 이동시켜 일부 클릭이 빗나감 → 카드 헤딩+버튼을 DOM eval로 정확히 클릭하고 제어 입력은 React 네이티브 setter로 설정해 복구(루트가 이후 토스트를 모달 아래로·성공 토스트 억제로 완화).
- 디바이스 에뮬레이션 캡처 타일링(위 7항).
