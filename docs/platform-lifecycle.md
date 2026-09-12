# 플랫폼 수명주기 · 설치 준비 (T-13.5)

앱(화면)과 제어 서비스의 수명 분리, 단일 인스턴스/건강한 소유권, 깨끗한 기동 실패·복구,
OS 사용자별 로그인 자동 시작, Linux 네이티브 샌드박스 기동, 설치/업데이트 설계를 다룬다.
표면은 `packages/lifecycle/`의 순수·주입형 함수와 `apps/desktop/electron/main.ts`의 얇은 Electron 브리지로 나뉜다.

## 1. 앱 / 제어 서비스 수명 분리

- **제어 서비스는 앱과 독립 실행된다.** 화면이 있는 Electron 앱과 별개로 제어 서비스(자동화 실행 주체)가 산다.
- **앱(창)을 닫아도 인가된 자동화는 계속 실행된다.** `main.ts`는 제어 서비스를 `detached: true` + `child.unref()`로 기동해 앱 프로세스 종료와 분리한다. 창을 모두 닫으면(비 macOS) 앱은 종료되지만 제어 서비스는 살아 예약된 빌드/게시/SNS 작업을 이어간다.
- **명시적 중지만 제어 서비스를 종료한다.** 창 닫기(quit)와 자동화 중지(stop)를 구분한다. 제어 서비스는 오직 `appops:lifecycle:stopController`(렌더러의 “자동화 중지”) 또는 명시적 Quit&Stop에서만 종료된다.

## 2. 단일 인스턴스 · 건강한 소유권

- **GUI 단일 인스턴스**: `app.requestSingleInstanceLock()`. 두 번째 실행은 기존 창을 활성화하고 종료한다.
- **제어 서비스 단일 인스턴스**: 건강한 제어 서비스가 이미 있으면 새로 띄우지 않고 인수(adopt)한다. 판정은 `controller.json`(port·token·pid·startedAt)과 인증된 헬스 확인으로 한다. 서버는 `controller.json`을 배타 생성(`flag: 'wx'`, mode 0600)하므로 같은 데이터 디렉터리에 두 인스턴스가 소유권을 쓰지 못한다.
- **고아 방지**: 기동은 됐지만 제한 시간(기본 15초) 안에 정상화되지 않은 프로세스는 방금 띄운 PID로 SIGTERM해 정리한다(`ensureController`).

## 3. PID 재사용 안전 중지

`controller.json`이 있다는 이유만으로 PID를 종료하지 않는다. 중지 전 **인증된 신원 확인**을 통과해야 한다:

1. 공개 `GET /api/health`의 `startedAt`이 `controller.json.startedAt`과 일치 → 그 포트의 인스턴스가 우리가 기록한 그 인스턴스임을 확인.
2. 인증된 `GET /api/state`(Bearer 토큰)가 200 → 그 인스턴스가 우리 제어 서비스임을 증명.

둘 다 통과할 때만 소유자 PID에 SIGTERM을 보내고, 헬스가 내려갈 때까지 대기한 뒤 필요하면 SIGKILL로 승격한다. 확인에 실패하면(죽은 `controller.json`, 포트를 차지한 다른 프로세스, 재사용된 PID) **신호를 보내지 않는다**. 새 서버 엔드포인트는 필요 없다(기존 `/api/health` + `/api/state` 조합).

## 4. OS 사용자별 로그인 자동 시작

로그인 시 기동하는 대상은 **제어 서비스(헤드리스)**다. 화면 없이 인가된 자동화가 실행된다.

| OS | 방식 | 아티팩트 | 실행 시점 | 재시작 정책 |
| --- | --- | --- | --- | --- |
| Linux | `systemd-user` | `~/.config/systemd/user/local.appops.controller.service` | `WantedBy=default.target` + `systemctl --user enable` | `Restart=on-failure` (정상 종료는 재기동 안 함) |
| Linux(대안) | `xdg-autostart` | `~/.config/autostart/local.appops.controller.desktop` | `X-GNOME-Autostart-enabled=true` | 없음(로그인당 1회) |
| macOS | `launchagent` | `~/Library/LaunchAgents/local.appops.controller.plist` | `RunAtLoad=true` + `launchctl load -w` | `KeepAlive=false` |
| Windows | `schtasks` | 예약 작업 `local.appops.controller` | `/SC ONLOGON /RL LIMITED` | 없음(단발) |

- **식별자**: 역DNS `local.appops.controller`(앱 appId `local.appops.desktop`와 정렬).
- **경로/인자 인코딩**: 공식 규칙을 따른다 — Desktop Entry `Exec`(예약 문자 큰따옴표+`\` 이스케이프), Windows `CommandLineToArgvW`(백슬래시/따옴표), systemd `ExecStart` 인용, plist XML 이스케이프. 공백·특수문자가 든 경로도 안전하다.
- **환경변수**: systemd `Environment=`, plist `EnvironmentVariables`, desktop `env` 래퍼, schtasks `cmd /c set` 래퍼로 주입한다.
- **명시적 중지 존중**: 재시작 정책은 정상 종료(SIGTERM/exit 0)를 재기동하지 않도록 골랐다(systemd `on-failure`, LaunchAgent `KeepAlive=false`, schtasks 단발). 로그인 자동 시작이 사용자의 “자동화 중지”와 싸우지 않는다.

### 안정 설치 경로 요구

자동 시작 대상은 반드시 **안정된 설치 경로**여야 한다. AppImage 임시 마운트(`/.mount_*`), `/tmp`, `release/`, `linux-unpacked/`를 가리키면 로그인 시 실행이 깨진다. `appops:autostart:enable`은 이런 임시 경로에서 실행 중이면 `autostart_unstable_path`로 거부한다(앱 설치 후 다시 시도하도록 안내). 이는 QA 릴리스 디렉터리의 자동 시작을 실수로 켜는 것도 막는다.

- **AppImage**: `$APPIMAGE`(안정 경로)를 `APPOPS_CONTROLLER_ONLY=1`로 재실행한다. 이 헤드리스 프로세스는 자신의 마운트를 유지하므로 앱 종료와 무관하게 산다.
- **설치 앱(deb/rpm/dmg/nsis)**: `process.execPath`(안정)를 `APPOPS_CONTROLLER_ONLY=1`로 실행한다.
- **개발/미설치**: `ELECTRON_RUN_AS_NODE=1`로 제어 서비스 진입점을 직접 구동(영속성 불필요).

## 5. 헤드리스 제어 서비스 모드

`APPOPS_CONTROLLER_ONLY=1`이면 `main.ts`는 창·IPC 없이 제어 서비스 진입점(`dist/apps/controller/main.js`)을 현재 프로세스에서 `import`해 구동한다. 서버의 HTTP 리스너와 SIGINT/SIGTERM 처리가 프로세스를 유지한다. 나중에 GUI를 열면 건강한 제어 서비스를 인수한다(중복 기동 없음).

## 6. Linux 네이티브 샌드박스 기동

이 QA 호스트(및 Ubuntu 24.04+)에서 네이티브 창이 막히는 두 원인과 앱 범위 해결책:

1. **chrome-sandbox가 setuid root가 아님** (`-rwxr-xr-x ethancl:ethancl`, 기대값 `-rwsr-xr-x root:root` 모드 4755) → SUID 샌드박스 실패.
2. **`kernel.apparmor_restrict_unprivileged_userns=1`** (Ubuntu 24.04 기본) → 네임스페이스 샌드박스 차단.

두 해결책 중 하나면 충분하며, 각각 root 권한이 **1회** 필요하다. 전역 sysctl 비활성화나 `--no-sandbox`는 쓰지 않는다.

- **방법 A — setuid 샌드박스**: `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`. **deb/rpm 패키지의 postinst가 자동 처리**하므로 정식 설치에서는 별도 조치가 필요 없다.
- **방법 B — 앱 전용 AppArmor 프로필**: `/etc/apparmor.d/appops-desktop`에 앱 바이너리에만 `userns`를 허용하는 프로필을 설치하고 `apparmor_parser -r`로 로드한다(Chromium/Chrome/VS Code가 배포하는 표준 패턴).

진단·명령·프로필 출력은 `node --import tsx scripts/install-sandbox.mjs [--binary <경로>] [--out <파일>]`. 이 스크립트는 **sudo를 실행하지 않는다** — root가 검토·실행할 명령만 출력한다. `packages/lifecycle`의 `inspectLinuxSandbox`가 `appops:lifecycle:status`의 `sandbox` 필드로도 노출된다.

### 패키징 권장

- 앱 종료 후에도 지속되는 자동화가 목표라면 **deb/rpm 설치 + systemd user 서비스**(추출된 안정 바이너리)를 권장한다. AppImage는 프로세스 수명 동안만 자체 마운트를 유지하므로, 지속 실행은 헤드리스 `$APPIMAGE` 프로세스가 계속 살아 있어야 한다.
- `electron-builder.json`은 현재 Linux `AppImage`만 대상으로 한다. setuid 샌드박스 자동 구성과 안정 경로를 위해 `deb`(또는 `rpm`) 타깃 추가를 권장한다. (이 문서 범위 밖의 `package.json`/`electron-builder.json` 변경은 root가 결정한다.)

## 7. 설치/업데이트 설계 (정직한 현재 상태)

- **서명된 자동 업데이트는 구성되어 있지 않다.** `electron-builder.json`의 `publish: null`이며 게시자 설정·서명 키가 없다. 따라서 서명된 자동 업데이트가 동작한다고 주장하지 않는다.
- **설계 방향(미구현)**: 게시 채널(`publish` provider) 구성 → 코드 서명(macOS Developer ID/notarization, Windows Authenticode, Linux 서명) → `electron-updater`로 서명 검증 업데이트. 각 단계는 실제 게시자 계정·키가 있어야 검증 가능하다.
- 그때까지 업데이트는 새 설치본을 사용자가 내려받아 재설치하는 수동 경로다. 자동 시작·수명주기 로직은 재설치 후에도 안정 경로 기준으로 동작한다.

## 8. `packages/lifecycle` API

- **제어 서비스**: `ensureController` / `stopController` / `restartController` / `getControllerStatus` — 모두 주입형 `ControllerDeps`(`readInfo`, `checkHealth`, `spawnController`, `killPid`).
- **자동 시작**: `defaultAutostartMethod` / `installAutostart` / `getAutostartStatus` / `removeAutostart` + 콘텐츠 렌더러(`renderSystemdUnit`·`renderDesktopEntry`·`renderLaunchAgentPlist`·`buildSchtasks*Args`) + 인코더(`escapeDesktopExecArg`·`quoteWindowsArg`·`buildSystemdExec`·…). 부수효과는 주입형 `fs`/`runner`.
- **대상 빌더**: `buildControllerAutostartTarget`.
- **Linux 샌드박스**: `inspectLinuxSandbox` / `renderAppArmorProfile` / `sandboxChmodCommands`.

## 9. Electron IPC 계약 (렌더러/preload는 root가 연결)

`main.ts`가 등록하는 채널(모두 `isTrustedFrame`로 보호, `ApiResult` 반환):

| 채널 | 반환 |
| --- | --- |
| `appops:lifecycle:status` | `ApiResult<{controller:{running,adopted,port?,pid?,startedAt?}, autostart, autostartInstallable, sandbox?}>` |
| `appops:lifecycle:stopController` | `ApiResult<{stopped, wasRunning}>` (명시적 중지) |
| `appops:lifecycle:restartController` | `ApiResult<{running}>` |
| `appops:autostart:status` | `ApiResult<AutostartStatus>` |
| `appops:autostart:enable` | `ApiResult<AutostartStatus>` (임시 경로면 `autostart_unstable_path`) |
| `appops:autostart:disable` | `ApiResult<AutostartStatus>` |

권장 preload 모양: `window.appOps.lifecycle = { status, stopController, restartController }`, `window.appOps.autostart = { status, enable, disable }`.

## 10. 스크립트

- `scripts/launch.mjs` — 헤드리스 제어 서비스 런처(순수 Node). 건강한 서비스가 있으면 재기동하지 않는다. `--detach`(기동 후 종료), `--status`.
- `scripts/install-autostart.mjs` — 자동 시작 설치/상태/제거 CLI(`--enable|--disable|--status`, `--method`, `--program`, `--entry`, `--data-dir`, `--dry-run`). `--dry-run`은 임시 디렉터리에만 생성해 실제 호스트를 건드리지 않는다. tsx 필요.
- `scripts/install-sandbox.mjs` — Linux 샌드박스 진단·해결책 출력(sudo 미실행). tsx 필요.

## 11. 테스트 · 실제 vs 모의

- `tests/lifecycle.test.ts` (제어 서비스 수명 + 샌드박스 진단), `tests/lifecycle-autostart.test.ts` (인코딩·렌더러·install/status/remove). 총 27개 통과.
- 모든 부수효과는 주입(fs=임시 디렉터리, runner=목, 헬스=불리언). **실제 호스트의 자동 시작을 켜거나 시스템 보안을 바꾸지 않는다.**
- **실제 검증됨**: 인코딩 규칙, 콘텐츠 렌더러, install/status/remove 흐름(임시 fs+목 러너), PID 재사용 안전·고아 정리·중지 승격 로직, Linux 샌드박스 진단(이 호스트 실제 값으로도 확인).
- **모의/미검증**: 실제 로그인 재부팅 후 자동 기동, 실제 `systemctl --user enable`/`launchctl`/`schtasks` 부작용, root 권한이 필요한 setuid/AppArmor 적용 후의 네이티브 창 기동. 이들은 root의 1회 sudo와 실제 세션이 필요하다.
