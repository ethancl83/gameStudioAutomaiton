# 작업 실행·복구 계약

Last Updated: 2026-10-01

[작업 목록](../dev/active/app-operations-platform/app-operations-platform-tasks.md) · [검증](verification.md)

SQLite WAL/FULL 저장소를 제어 서비스 한 대가 소유한다. 소유권 임대 60초·갱신 10초이며 모든 변경·작업 완료에서 소유권과 임대를 검사한다. 만료된 이전 프로세스의 늦은 응답은 반영하지 않는다. 저장 트랜잭션은 동기 mutation만 허용하며 중첩 작업은 savepoint로 결합한다. 큐 알림은 최상위 commit 뒤 실행한다. DB 버전 0/1은 호환하고 지원하지 않는 더 높은 버전은 변경하지 않고 열기를 거절한다.

작업은 queued→running→succeeded/failed/cancelled로 이동한다. 일시적인 읽기 오류는 retry_wait에서 최대 3회 시도한다. 외부 처리 중은 waiting_external, 인증·보관함·불명확한 외부 반영은 action_required다.

외부 변경은 connection+operation+idempotencyKey와 입력 해시로 식별한다. 성장 예약은 run·prepared effect·업무 출처와 답글/가격 변경 문서를 같은 트랜잭션에 저장한다. 기존 요청을 재사용할 때도 출처 충돌을 검사하고 성장 요청의 출처가 없으면 전송을 거절한다. prepared를 먼저 저장하고 요청 직전 dispatched를 기록한다. 확인된 성공만 confirmed로 전환한다. non-GET 요청은 읽기/쓰기 구분이 필수이고 읽기 POST는 공식 조회 경로만 허용한다.

공급자가 종결 실패를 확인한 경우 실행은 failed, 외부 효과는 resolved_failed로 기록한다. 예를 들어 Threads 컨테이너가 ERROR/EXPIRED이면 게시하지 않고 실패를 확정한다. 결과를 모르는 dispatched/action_required와 구분하므로 확정 실패가 SNS 한도를 영구히 점유하지 않는다. 이 경우에도 같은 변경 의도를 일반 retry로 다시 보내지 않는다.

첫 HTTP 변경 요청이 400/401/403/404/405/409/410/413/415/422/429로 명확히 거절되면 효과를 prepared로 복구한다. 앞선 HTTP 변경 또는 CLI 전송이 있는 요청, 408·5xx·응답 유실은 이 복구를 적용하지 않는다. 이력의 서비스 확인 결과 기록은 확인 체크·구체적 근거·작업 갱신 시각 검사를 거쳐 종결한다. 수동 실패 확인은 외부 영향이 없음을 확인한 경우이며 resolved_failed로 기록해 같은 작업을 재전송하지 않는다.

응답 유실 후에는 변경을 재전송하지 않는다. Play 버전 코드, Apple buildUpload ID, Steam build ID를 보존한 업로드는 조회로 확인한다. ID 자체를 받지 못했거나 조회 계약이 없는 변경은 확인 대기다. 미확정 연결·프로젝트는 삭제할 수 없다. 삭제·계정 변경·복구 가드는 표시 목록과 분리된 SQL로 전체 run/effect 이력을 검사하며 외부 await 뒤에도 재검사한다. effect의 미확정 상태는 run의 최근 순서나 완료 상태에 의해 제외되지 않는다. 전송 전 인증 대기만 연결 복구 후 재개한다.

기본 출시 경로는 [외부 결과물 가져오기](external-artifacts.md)이며 엔진·원본 소스·내부 빌드를 요구하지 않는다. 보관한 결과물의 프로젝트·플랫폼·앱 식별자와 해시를 업로드 직전에 확인한다. 기존 내부 빌드는 비밀 파일을 제외한 스냅샷에서 실행하고 매 시도 이전 산출물을 제거한다. 성공 파일/디렉터리는 크기·SHA-256·소스 해시·타깃·이력과 연결하고 업로드 직전 재검증한다. 임의 파일 경로나 다른 프로젝트의 빌드를 업로드할 수 없다.

최근 상태 창은 작업 100개·이벤트 200개다. 전체 DB 이력은 `POST /api/history/query` 커서 페이지(최대 200개)로 계속 조회한다. 입력·결과·로그와 자격 증명 보관함을 분리한다. 스냅샷/산출물 자동 보존 상한·정리는 후속 작업이다.

수집 결과·출시 관측·원본 작업의 reconcile·effect 확정·조회 작업 완료는 같은 DB 트랜잭션으로 저장한다. 저장 실패에는 부분 결과를 남기지 않으며 큐를 멈추고 queue.halted와 메모리 오류 상태로 보고한다. 저장소 자체가 오류 기록도 허용하지 않으면 stderr에 보고한다. RUN_FENCED와 CONTROLLER_FENCED는 정상 소유권 fencing으로 구분한다. 수정된 Play 월별 보고서는 해당 연결·월의 기존 원천을 교체하며 다운로드 실패·미발행은 기존 자료를 삭제하지 않는다.

계정 등록·OAuth 완료는 암호문 커밋 표식과 공개 메타데이터 변경 의도로 연결하며, 키 교체는 버전별 암호문과 원자적인 메타데이터/이력 저장을 사용한다. 중간 장애 복구는 [인증 수명주기](credential-lifecycle.md)와 [빌드 키](build-credentials.md)를 따른다.

캠페인 전체 목록 조회 성공은 해당 연결의 캠페인 캐시를 완전 교체한다. 실패·일부 결과에는 삭제를 적용하지 않는다. 스토어의 앱별 조회와 계정 보고서 수집은 각각 예약한다. 같은 주기에 새로 예약한 앱별 조회도 활성 작업 검사에 포함하며 계정 동기화는 앱별 조회 완료 뒤 다음 주기에 예약한다. 실제 공개 상태 관측을 영속 저장하며 초기 목록의 과거 버전은 공지하지 않는다.

성장 운영의 모든 외부 변경(실험 생성·종료·promote, 예산 증액, 캠페인 중지, 가격 변경·원복, 답글, 답글 회수)은 `service.action`의 같은 큐·정책·예산·소셜 검사를 통과한다. 요청 키는 실험·결정·가격 변경·외부 응답 identity에서 결정적으로 만든다. 답글 identity는 공급자·계정·상호작용·대상·동작의 해시이며 정책·지식 버전을 넣지 않는다. 그래서 정책이 바뀌어도 같은 상호작용에 두 번 답하지 않는다. Google Ads 실험 생성은 `[gso:요청키]` 이름 접미사로 응답 유실 뒤 목록 조회에서 찾아 재사용한다. 일정·promote 장기 작업은 `reconcile` 읽기로 확인한다.

웹 배포 CLI는 provider 계정 연결을 만들어 대신 표현하지 않는다. 프로젝트 범위 run/effects를 예약하고 dispatched와 배포 문서를 commit한 뒤 terminal을 연다. 준비·실행 중 동시 배포 및 수동 잠금 해제를 거절한다. 종료 확인·수동 결과 확인은 같은 원장을 확정하며 일반 run retry로 CLI를 다시 보내지 않는다. 외부 조회 뒤 최신 배포 문서를 재검사하여 조회 중 확정한 수동 결과를 이전 상태로 덮어쓰지 않는다. 기존 running/action_required/uncertain 배포 문서도 복구·삭제 가드에 포함한다.

빌드 종료 대상은 관찰한 detached 루트와 자손의 PID·시작 시각으로 제한한다. 최초 루트는 실제 ChildProcess가 종료하지 않았고 부모가 현재 제어 프로세스인 경우에만 인정한다. 자기 자신·조상·사라진 루트·다른 시작 시각의 PID를 제외하며 관찰한 setsid 자손은 유지한다. 최초 프로세스 표를 읽지 못하거나 루트/조상 identity를 확인하지 못하면 종료 권한을 추측하지 않는다. ps 시작 시각의 해상도와 snapshot 직후 kill 사이의 OS 경합은 남으며 관찰하지 못한 고아를 호스트 전체 검색으로 대체하지 않는다.

재사용 runner 구현은 packages/runner가 소유하고 apps/runner는 진입점과 호환 re-export를 제공한다. 기능 Controller는 실제 사용하는 hooks 계약을 받고 결과 저장과 정책 판단은 별도 모듈이 맡는다. packages→apps 역참조와 정적 runtime 순환은 npm run typecheck의 check:architecture 단계에서 검사한다. 동적 platform import는 이 정적 순환 검사의 대상 밖이다.

성장 화면은 GET /growth/projects/:id로 선택 프로젝트의 문서를 조회하고 기존 GET /growth는 전역 호환을 유지한다. 성과 계산은 귀속 cohort·정정 revision을 보존하도록 해당 프로젝트의 fact 전체를 사용한다. 24시간 digest는 스튜디오 전체 요약이며 시간·상태 조건으로 SQL 조회하고 표시 상한과 분리한다. 최근 결정 목록의 이전 이력은 POST /growth/decisions/query의 (at,id) 내림차순 커서로 이어 읽고 실험과 프로젝트 소속을 검사한다. Electron은 이 두 경로만 명시적으로 허용하며 임의 querystring이나 wildcard 요청을 허용하지 않는다.

성장 화면의 다음 정기 조회는 이전 조회가 끝난 뒤 예약한다. 프로젝트 전환·화면 종료 뒤 도착한 응답과 더 최신 응답보다 오래된 결과는 반영하지 않는다. 열린 커뮤니티 응답 상태는 서버 조회와 화면이 같은 일곱 상태(escalated/draft_ready/blocked/authorized/queued/prepared/dispatched)를 사용하며 최근 500건 밖의 열린 응답도 보존한다.
