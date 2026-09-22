# 원격 빌드 러너

Last Updated: 2026-09-22. [빌드 지원](build-support.md) · [실행 계약](demo-execution-contract.md) · [검증](verification.md).

## 등록과 실행

Linux 네이티브 러너에는 이 프로젝트와 Node.js 22.16 이상, bubblewrap, 대상 엔진·SDK·라이선스·export template이 필요하다. 기존 Linux 실행은 그대로 사용할 수 있다. 다음 명령은 루프백 `127.0.0.1:4320`에서 서비스를 시작한다.

```bash
npm ci
npm run runner
```

`APPOPS_RUNNER_DATA_DIR`와 `APPOPS_RUNNER_PORT`로 데이터 경로·포트를 바꿀 수 있다. `APPOPS_RUNNER_HOST`는 `127.0.0.1`이 기본이며 `127.0.0.1`과 `0.0.0.0`만 허용한다. 아래 Docker 구성에서만 컨테이너 내부 리슨 주소를 `0.0.0.0`으로 명시한다.

출력에는 주소와 연결 코드 파일 경로가 표시되며 코드 값은 출력하지 않는다. 생성된 `pairing-code` 파일은 0600이며 다시 시작해도 같은 코드를 사용한다. 기존 파일의 잘못된 권한·심볼릭 링크·하드 링크는 시작 전에 거부한다. 최초 한 번 운영·복구 화면에 러너 이름, 플랫폼, 주소, 연결 코드를 등록하고 연결을 확인한다. 플랫폼은 **실제 빌드를 실행하는 OS**이며 아래 Docker 러너는 Mac에서 띄워도 Linux로 등록한다. 이후 프로젝트 빌드·출시 폼에서 러너를 선택한다. 주소별 중복 등록과 빌드 중 삭제는 거부한다.

같은 장비는 `http://127.0.0.1:4320`으로 등록한다. 다른 장비는 인증된 SSH 터널로 루프백 포트를 전달하거나 신뢰할 수 있는 HTTPS 프록시를 구성한다. 일반 원격 HTTP는 등록할 수 없다. 연결 코드 값이 바뀌면 해당 등록을 다시 만든다. SSH 소스 접근 키와 러너 연결 코드는 서로 다른 자격 증명이다.

## Docker Linux 러너 준비와 연결

Mac에서는 Linux 컨테이너를 실행할 Docker 환경(예: Docker Desktop), Linux에서는 Docker Engine과 Compose가 추가로 필요하다. 아래 명령은 저장소 루트에서 실행하며, 컨텍스트 준비 스크립트를 실행할 호스트 Node.js 22.16 이상과 `npm ci`로 설치한 의존성이 필요하다. 앱이 Docker를 자동 설치하거나 실행하지는 않는다.

### 처음 준비

`tmp/docker-runner-context`가 아직 없는 경우 다음 순서로 실행한다.

```bash
node --import tsx scripts/prepare-runner-context.ts
docker compose -f docker/runner/compose.yaml build
docker compose -f docker/runner/compose.yaml up -d --wait --wait-timeout 1800
docker compose -f docker/runner/compose.yaml ps
```

준비 스크립트는 필요한 소스·lockfile·설정의 허용 목록만 새 디렉터리에 복사한다. `.env`, `.git`, `node_modules`, `tmp`, vault와 링크 파일은 컨텍스트에 넣지 않는다. Docker 안에서 lockfile로 의존성을 설치하며 이미지 태그는 `appops-linux-runner:local`이다.

`up -d --wait`는 백그라운드 기동 뒤 healthcheck가 성공할 때까지 기다린다. 최초 기동에는 공식 Godot 4.3 export template 약 1 GiB를 named volume에 내려받는다. 이후 기동은 저장한 archive의 SHA-512를 다시 확인하고 실행 아키텍처의 Linux 템플릿만 준비한다. 편집기도 이미지 빌드에서 공식 고정 SHA-512를 확인한다. 다운로드 중에는 서비스가 아직 준비되지 않을 수 있다. 대기 시간이 초과되면 `ps`의 상태를 확인하고, 준비된 뒤 다음 단계로 진행한다. healthcheck는 파일의 0600 권한, 인증 응답, 프로토콜, 실제 bwrap probe의 `ready:true`를 확인하며 비밀이나 응답 본문을 출력하지 않는다.

### 연결 코드 전달과 등록

`ps`에 `healthy`가 표시되면 새 비공개 디렉터리로 연결 코드 파일을 복사한다. 파일 내용을 셸 인수·환경 변수·터미널 출력에 넣지 않는다.

```bash
umask 077
appops_pairing_dir=$(mktemp -d tmp/runner-pairing.XXXXXX)
docker compose -f docker/runner/compose.yaml cp runner:/data/runner/pairing-code "$appops_pairing_dir/pairing-code"
chmod 600 "$appops_pairing_dir/pairing-code"
```

복사한 파일을 로컬 편집기로 열어 **운영·복구 → 빌드 러너**의 연결 코드 입력란에 붙여 넣는다. 플랫폼은 **Linux**, 주소는 **`http://127.0.0.1:4320`**으로 등록하고 연결 검사를 통과한 뒤 빌드·출시 폼에서 선택한다. Mac으로 회수되는 결과물도 Linux용이며, Linux 환경에서 실행해야 한다.

### 소스 변경 후 재빌드

준비 스크립트는 기존 컨텍스트를 삭제하거나 덮어쓰지 않는다. 같은 경로를 다시 지정하면 `EEXIST`로 실패한다. 기존 컨텍스트로 다시 `compose build`만 하면 이전에 복사한 소스를 빌드하므로 최신 변경이 반영되지 않는다. 다음처럼 **아직 없는 새 경로**를 지정해 준비하고 그 경로로 이미지를 빌드한다. 예시 경로도 이미 있으면 다른 이름을 선택한다.

```bash
node --import tsx scripts/prepare-runner-context.ts tmp/docker-runner-context-next
docker build -f tmp/docker-runner-context-next/docker/runner/Dockerfile -t appops-linux-runner:local tmp/docker-runner-context-next
docker compose -f docker/runner/compose.yaml up -d --no-build --wait --wait-timeout 1800
```

이 경로에서는 새 컨텍스트로 만든 동일 태그 이미지를 Compose가 사용한다. `--no-build`는 Compose에 남아 있는 기본 컨텍스트를 다시 빌드하지 않게 한다. 기존 컨텍스트는 보존되며 named volume의 연결 코드와 템플릿도 재사용한다. 기본 경로를 계속 쓰려면 기존 컨텍스트를 별도 위치로 옮긴 뒤 처음 준비 절차를 실행한다. 컨텍스트는 이미지 빌드 입력이고 named volume은 러너 데이터이므로 서로 별개다.

### 실행 경계

- 호스트 공개 포트는 `127.0.0.1:4320`이고 컨테이너만 내부에서 `0.0.0.0:4320`을 리슨한다. 전용 Compose 네트워크를 사용한다.
- 런타임 데이터는 named volume 하나에 둔다. 프로젝트 소스는 인증 HTTP 묶음으로 전송하며 호스트 홈·vault·Docker 소켓을 마운트하지 않는다. 컨테이너 로그 저장은 `none`이다.
- `init`, 컨테이너 root, `cap_drop: ALL` 뒤 `SYS_ADMIN`·`SETUID`·`SETGID`·`SETFCAP`, Moby 기본 seccomp에 `pivot_root`를 허용한 프로필, `systempaths=unconfined`가 중첩 bwrap 실측 구성이다. 프로젝트 실행에는 기존 bwrap의 파일·네트워크·PID 격리를 적용한다. 해당 Docker 환경에서 probe가 실패하면 준비 완료로 처리하지 않는다.
- 이미지의 실제 엔진 범위는 Godot 4.3 Linux다. 포함된 JDK17·git·SSH 클라이언트가 Android SDK·Unity·Unreal·Xcode 빌드 지원을 의미하지 않는다.

## 프로토콜과 한도

- `GET /health`, `POST /build`만 제공하며 모든 요청은 Bearer 연결 코드가 필요하다. 브라우저 Origin 요청은 거부한다.
- 식별자 `appops-runner-v1`. 연결 확인은 프로토콜·OS·`ready:true`를 대조한다.
- 빌드 입력은 작업 ID, 대상, configuration/exportPreset/scheme, 검증된 소스 묶음이다. 클라이언트의 임의 셸 명령을 받지 않고 러너가 프로젝트를 검수해 실행 계획을 만든다.
- 소스 묶음은 파일별 SHA-256·실행 비트·상대 경로를 포함한다. 총 256 MiB, 파일 100,000개 한도. 절대/상위 경로, 심볼릭 링크, 대소문자 충돌·Windows 예약명·비정상 base64·해시 불일치를 거부한다. 요청 본문은 인코딩 오버헤드를 포함한 한도로 제한한다.
- 한 번에 한 빌드, 최대 한 시간. 클라이언트 취소·연결 종료·서비스 종료는 작업을 취소한다. 도구 실행은 프로세스 트리 종료를 사용한다.
- 결과물은 같은 형식의 묶음으로 반환하고 제어 서비스가 다시 검증한다. 실행 파일과 Godot PCK 같은 동반 파일을 같은 디렉터리에 둔다. 로그는 비밀 마스킹·64,000자 수집 한도를 적용한다.
- SSH 의존성은 제어 서비스가 먼저 고정된 서버 키로 준비한다. 원격 빌드 결과를 받은 뒤 기존 Android 서명·산출물 이력 단계로 이어진다. 러너 작업 디렉터리는 끝나면 정리한다.

## 검증과 지원 한계

Linux bubblewrap 격리와 실제 Godot 4.3 프로젝트의 원격 전송→격리 export→결과물 회수→생성 게임 실행을 검증했다. 2026-09-22에는 **macOS arm64 제어 서비스 → 인증 HTTP 루프백 → Docker Linux arm64 → bwrap Godot 4.3 export → Mac 회수**도 성공했다. 인증 없는 health는 401, 인증된 health는 200과 bwrap 준비 완료였으며, 호스트 루프백 공개·연결 코드 0600·로그 미출력을 확인했다.

Mac으로 회수한 Linux 실행 파일은 59,761,504 bytes, PCK는 1,840 bytes다. 같은 결과물의 검증용 복사본을 Linux 컨테이너 bwrap에서 실행해 exit 0과 `AppOps controller build OK`를 확인했다. 복사본 소유권만 root로 맞췄고 바이트와 실행 비트는 보존했다. [빌드 지원표의 실측 기록](build-support.md#mac-docker-linux-godot-실측-2026-09-22)에 해시와 근거를 기록했다.

재현 스크립트는 `scripts/verify-remote-godot.ts`다. 기존 Linux 루프백 모드 외에 `APPOPS_REMOTE_RUNNER_URL`과 `APPOPS_REMOTE_RUNNER_TOKEN_FILE`로 외부 러너 주소 및 **코드가 저장된 파일 경로**를 지정할 수 있다. `APPOPS_VERIFY_ARCH`는 대상 Linux 아키텍처(`arm64` 또는 `x86_64`)이며 기본값은 제어 서비스 장비의 아키텍처다.

현재 CLI의 내장 격리 구현은 Linux다. macOS·Windows **네이티브** 러너는 검증된 격리 launcher가 없으면 준비 완료를 반환하지 않는다. Mac에서 검증한 Docker 경로의 대상 OS도 Linux이며, macOS/iOS·Xcode·Unity·Unreal·Android SDK 빌드의 검증 근거로 확대하지 않는다. 코드의 `RemoteRunnerOptions.isolation.launcher` 확장점은 장비 운영자가 구현·검증해야 하는 경계이며 일반 사용자 화면에서 안전한 격리를 자동 설치하는 기능은 아니다. iOS 인증서·프로비저닝과 SDK 내부 광고/결제 통합 역시 계정 연결과 별도 준비가 필요하다.

데모 러너의 연결 성공과 다섯 엔진 빌드는 합성 실행이며 실제 엔진·장비 지원 검증을 대신하지 않는다.
