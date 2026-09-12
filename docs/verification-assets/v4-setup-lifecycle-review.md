# v4 설치·수명주기 독립 구현 리뷰 (Opus 5, read-only)

- 리뷰 일자: 2026-09-11
- 리뷰 유형: 독립 read-only 구현 리뷰. 소스 변경·서브에이전트·sudo·git 조작 없음
- 호스트 증거: Linux만 사용 가능. macOS·Windows 런타임 증거 없음 (아래 각 항목에서 *정적 구현*과 *런타임 증거*를 구분해 표기)
- 기준 문서: `docs/verification-assets/v4-design-review.md`
- 검토 범위: `packages/lifecycle/**`, `apps/desktop/electron/{main,preload,security}.ts`, `apps/desktop/src/components/LifecyclePanel.tsx`, `apps/desktop/src/views/SetupView.tsx`, `apps/desktop/src/api.ts`, `scripts/install-autostart.mjs`, `scripts/install-sandbox.mjs`, `packages/setup/{catalog,download,installer,archive,readiness}.ts`, `apps/controller/{preparation,operations,service,server,queue,main}.ts`, `packages/engines/toolchains.ts`
- 범위 제외(중복 방지): SDK 템플릿(Sol 리뷰 / Grok 수리), Windows AppContainer·macOS sandbox-exec 네이티브 헬퍼, 백업/복구 아카이브 트랜잭션, 외부 Chromium 헬퍼 기동(root 담당)

## 검토한 파일 버전 (SHA-256, 리뷰 시작·종료 시 동일함을 확인)

| 파일 | mtime | sha256(앞 16자리) |
|---|---|---|
| packages/setup/archive.ts | 21:06:57 | `5ac65282f0518a01` |
| packages/setup/catalog.ts | 21:28:32 | `fc3bc782f1865472` |
| packages/setup/download.ts | 21:45:55 | `d8441ebc20d6f197` |
| packages/setup/installer.ts | 21:44:35 | `c14686146c08e847` |
| packages/setup/readiness.ts | 21:38:53 | `c00440c5dc078f73` |
| packages/lifecycle/autostart.ts | 21:08:45 | `7f906eb5c2dc5d99` |
| packages/lifecycle/controller.ts | 21:13:04 | `5cd756988dbf2082` |
| apps/desktop/electron/main.ts | — | `694e64da4aa0df7b` |
| apps/controller/preparation.ts | — | `3c81bce936c9637a` |

`npx tsc -p tsconfig.json --noEmit` → exit 0. 이 스냅숏 기준으로 타입체크 미결 사항은 없다.

---

## 요약 판정

설치·수명주기 계약의 **설계 방향은 v4 설계 리뷰와 맞다**. 컨트롤러 detach/인수, PID 재사용 방어, 단일 인스턴스 임대, 아카이브 경로 방어, 프로젝트·대상별 준비 판정은 모두 실제로 구현돼 있고 이전 리뷰의 여러 P0/P1을 해소했다.

그러나 **"설치 → 준비 완료" 경로는 현재 상태로 릴리스할 수 없다.** 확인된 P0는 두 가지다.

1. JDK 설치는 **공식 아티팩트에서 100% 실패한다.** tar 파서가 GNU 형식 tar를 거부하는데, Temurin 공식 tarball이 정확히 GNU 형식이다. Android SDK 설치는 JDK를 선행 조건으로 요구하므로 함께 막힌다.
2. 그럼에도 Android 준비 점검은 **JDK·SDK가 실제로 없어도 "준비됨"으로 녹색 표시된다.** 준비 판정이 실행 가능성·버전이 아니라 파일/디렉터리 존재만 본다.

즉 현재 코드에서 "다운로드 설치"는 동작하지 않고, "준비 완료" 표시는 설치 여부와 무관하게 켜질 수 있다. 이 둘은 서로를 가린다.

| 우선순위 | 건수 | 내용 |
|---|---|---|
| P0 | 2 | GNU tar 거부로 JDK/Android 설치 전면 실패 · 실행 불가능한 JDK/빈 SDK를 준비 완료로 판정 |
| P1 | 7 | 설치 취소가 타임아웃까지 멈추고 손자 프로세스를 남김 · 명시적 중지가 systemd 자동 재기동으로 이어짐 · autostart 인코딩 주입/공백 파손 · Android 패키지 버전 비고정 및 라이선스 영수증 부재 · Android 패키지 추가 설치 불가 · UI 도구 매칭 오탐 · SDK 준비 항목이 영구 미충족 |
| P2 | 6 | (본문 참조) |

---

## P0

### P0-1. `extractTarGz`가 GNU 형식 tar를 거부한다 — 공식 JDK 설치가 항상 실패한다

- 위치: `packages/setup/download.ts:199-200` (`parseHeader`의 magic 검사), 연쇄로 `packages/setup/download.ts:271-285` (pax)
- 분류: 확정 논리 결함 (런타임 재현 완료)

```ts
// packages/setup/download.ts:199-200
const magic = readCString(block, 257, 6);
if (magic && magic !== 'ustar') throw new AppError('INVALID_ARCHIVE', '지원하지 않는 tar 형식입니다.');
```

`readCString(block, 257, 6)`은 6바이트 안에서 NUL을 찾고, 없으면 6바이트 전체를 반환한다. POSIX ustar는 magic이 `"ustar\0"`이라 `'ustar'`가 나오지만, **GNU tar 형식은 magic+version 8바이트가 `"ustar  \0"`**(ustar + 공백 2개)라서 앞 6바이트가 `"ustar "`(뒤에 공백)가 되어 검사에 걸린다.

공식 Temurin 아티팩트가 정확히 이 형식이다. 카탈로그가 지정한 실제 파일의 헤더를 range 요청으로 직접 확인했다:

```
$ curl -r 0-262143 "https://github.com/adoptium/temurin21-binaries/releases/download/\
jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz" -o jdk-head.gz
$ gunzip -c jdk-head.gz | xxd -s 256 -l 16
00000100: 0075 7374 6172 2020 0072 6f6f 7400 0000   .ustar  .root...
                ^^^^^^^^^^^^^^^^  magic="ustar " version="  "  → GNU 형식
```

같은 바이트를 그대로 `extractTarGz`에 넣으면 첫 헤더에서 실패한다(잘린 파일 때문이 아니라 magic 검사에서 먼저 걸린다):

```
$ gunzip -c jdk-head.gz | head -c 20480 > jdk-real.tar && gzip -c jdk-real.tar > jdk-real.tar.gz
$ node --import tsx -e "await extractTarGz('jdk-real.tar.gz','./out')"
FAIL: INVALID_ARCHIVE 지원하지 않는 tar 형식입니다.
```

GNU tar 1.35로 만든 4가지 형식을 전부 넣어 본 결과도 동일하다:

| `tar --format=` | 결과 |
|---|---|
| `gnu` (GNU tar 기본값) | FAIL `INVALID_ARCHIVE 지원하지 않는 tar 형식입니다.` |
| `oldgnu` | FAIL `INVALID_ARCHIVE 지원하지 않는 tar 형식입니다.` |
| `pax` | FAIL `UNSAFE_ARCHIVE 지원하지 않는 pax 항목입니다.` |
| `ustar` | OK |

pax 실패는 별개 원인이다. `parsePax`는 `path`·`size` 레코드가 하나도 없으면 `download.ts:278`에서 거부하는데, GNU tar가 붙이는 기본 pax 확장 헤더는 `mtime`/`atime`/`ctime`만 담는 경우가 대부분이다. 따라서 pax tarball도 정상 파일을 거부한다.

영향 연쇄:
- `jdk` 설치가 `ToolInstaller.#install`의 `extractTarGz` 단계(`installer.ts:316`)에서 항상 실패한다. 카탈로그의 JDK 6종이 모두 `archive:'tar.gz'`다(`catalog.ts:65-72`).
- `android-sdk` 설치는 `installer.ts:389-390`에서 `javaHome` 설정을 필수로 요구한다. 앱이 설치한 JDK가 없으면 사용자가 호스트 JDK를 따로 연결해야만 Android SDK 설치가 시작된다.
- 결과적으로 "검증된 공식 설치본을 내려받아 설치" 경로(SetupView 안내 문구)가 zip 기반 Godot·Godot 템플릿·Android 명령 도구에서만 동작한다.

수용 기준:
- `parseHeader`가 magic 필드를 `trim()`/`\0` 제거 후 비교하고, `"ustar"`/`"ustar "`(GNU)/빈 값(v7)을 모두 허용할 것.
- `parsePax`가 `path`·`size` 없는 확장 헤더(mtime 등만 있는 경우)를 오류가 아니라 무시로 처리할 것. 단 `linkpath` 거부는 유지.
- 회귀 테스트: `tar --format=gnu|oldgnu|pax|ustar` 4종으로 만든 동일 트리가 모두 같은 결과로 추출되는지, 그리고 실제 Temurin tarball의 첫 20KB 프리픽스가 magic 검사를 통과하는지 확인.
- pax `size` 오버라이드 시 패딩 계산도 함께 고치지 않으면 8GB 초과 엔트리에서 스트림이 어긋난다(P2-1 참조).

### P0-2. 준비 판정이 "실행 가능한 JDK·실제 SDK 패키지"를 확인하지 않는다 — 설치 없이도 녹색

- 위치: `packages/engines/toolchains.ts:103-134` (`validatedJavaHome`, `validatedAndroidSdk`), 소비처 `packages/setup/readiness.ts:11,34-37`
- 분류: 확정 논리 결함 (재현 완료). 설계 리뷰의 "Installation/download가 실제 패키지 없이 ready를 표시하면 안 된다" 요구와 직접 충돌

`readiness.ts:11`은 Android 대상의 필수 도구로 `jdk-home`, `android-sdk-validated`, `gradle-offline-cache`를 요구한다. 이 세 항목은 `scanToolchains`에서 **버전 프로브 없이** 만들어진다(`toolchains.ts:311-326`). 반면 실제 `java -version`을 실행하는 항목은 이름이 `java`이고, 준비 점검은 그 항목을 전혀 보지 않는다.

- `validatedJavaHome`은 `isExecutable(<dir>/bin/java)`만 본다(`toolchains.ts:110`). `javac` 존재, 실행 성공, Temurin 21 여부를 확인하지 않는다.
- `validatedAndroidSdk`는 `platforms` **또는** `build-tools` **또는** `platform-tools` 디렉터리 중 하나만 있으면 통과한다(`toolchains.ts:126`). 디렉터리 내용, `source.properties`, compileSdk·buildTools 리비전을 확인하지 않고, 프로젝트가 요구하는 버전과 대조하지도 않는다.

재현(임시 디렉터리, 호스트 무변경):

```
$ mkdir -p $T/fakejdk/bin $T/fakesdk/platform-tools
$ printf '#!/bin/sh\nexit 3\n' > $T/fakejdk/bin/java && chmod +x $T/fakejdk/bin/java
$ node --import tsx probe.mts $T
jdk-home  -> {"path":".../fakejdk"}
android   -> {"path":".../fakesdk"}
```

`bin/java`가 항상 3으로 죽는 셸 스크립트이고 SDK 루트에는 빈 `platform-tools` 디렉터리 하나뿐인데 둘 다 `available:true`다. `evaluatePreparation`의 `tool:jdk-home`·`tool:android-sdk-validated` 체크(`readiness.ts:34-37`)가 그대로 `ready`가 되고, 나머지 조건을 채우면 프로젝트 카드가 `준비됨`으로 표시된다.

설치기 쪽 검증도 같은 수준이다. `ToolInstaller.#validInstall`(`installer.ts:354-374`)은
- `jdk`: `findJavaHome`(= `bin/java` 파일 존재)만 확인,
- `android-sdk`: `platforms/<spec>`·`build-tools/<spec>` **디렉터리 존재**만 확인

하며 어느 경로에서도 `java -version`이나 `sdkmanager --list_installed`를 실행하지 않는다. 카탈로그가 `expected version output`을 정의하지 않으므로(`catalog.ts:75-78`의 `DownloadPackage`에 버전 확인 필드 없음) 설계 리뷰 §4의 "Validate expected binaries, versions, and internal layout" 요구가 미구현이다.

수용 기준:
- `validatedJavaHome`이 `bin/java -version`(또는 `release` 파일의 `JAVA_VERSION`)을 실행해 메이저 버전을 확인하고, 실패 시 `available:false` + 사유를 반환할 것.
- `validatedAndroidSdk`가 요구 compileSdk/buildTools 조합을 인자로 받아 `platforms/android-<n>/source.properties`, `build-tools/<rev>/source.properties`의 실제 리비전을 확인할 것. `requiredTools`가 대상별 정확 버전을 전달하도록 `readiness.ts:6-14`를 확장할 것.
- `ToolInstaller.#validInstall`이 카탈로그의 기대 버전 출력과 대조할 것.
- 회귀 테스트: 위 fake JDK/SDK 픽스처가 `available:false`가 되고, 프로젝트 준비가 `required`로 남는지 확인. 무관한 도구 하나가 다른 프로젝트를 ready로 만들지 않는지도 함께 확인.

---

## P1

### P1-1. `runIsolated` 취소가 타임아웃까지 멈추고 손자 프로세스를 남긴다 — 명시적 중지가 강제 종료로 번진다

- 위치: `packages/setup/installer.ts:113-155` (`runIsolated`), 소비처 `installer.ts:417-423`
- 분류: 확정 결함 (재현 완료)

`runIsolated`는 `spawn(..., {shell:false})`만 하고 `detached`를 쓰지 않으며, 중단 시 `child.kill('SIGKILL')`로 **직계 자식만** 죽인다(`installer.ts:137,140`). 그리고 Promise는 `child.on('close')`에서만 settle한다(`installer.ts:150`). `close`는 stdio 파이프가 모두 닫혀야 발생하는데, 손자 프로세스가 상속한 stdout/stderr를 쥐고 있으면 직계 자식을 SIGKILL해도 `close`가 오지 않는다.

재현:

```
$ node --import tsx kill.mts   # runIsolated('/bin/sh', ['-c', "sh -c '...loop...' & sleep 60"])
                               # 1.2초 뒤 AbortController.abort()
runIsolated rejected: AppError                      # abort가 아니라 INSTALL_TIMEOUT 경로
grandchild still writing after abort? true (126 -> 130 bytes)
```

abort 직후 손자는 계속 살아 파일에 쓰고 있었고, Promise는 abort로 settle되지 않은 채 타임아웃(`timeoutMs`)까지 매달렸다.

실제 영향 경로:
1. 사용자가 Android SDK 설치를 취소한다. `cancel()`(`installer.ts:212-219`)이 즉시 상태를 `cancelled`로 바꿔 UI는 취소된 것처럼 보인다.
2. `#run`은 `runIsolated` 때문에 최대 900초(`installer.ts:422`) 매달린다. 그래서 `finally`의 `#cleanupJob`(`installer.ts:286`)이 `.stage/<id>`를 지우지 못한다.
3. 그동안 고아가 된 sdkmanager(java)와 그 다운로드 헬퍼가 계속 `.stage/<id>`에 쓴다.
4. 컨트롤러 종료(`SIGTERM` → `controller.close()` → `service.stop()` → `preparation.close()` → `installer.close()`, `installer.ts:229`)가 같은 Promise를 await하므로 종료가 최대 900초 지연된다.
5. `stopController`의 기본 중지 제한은 10초이고(`packages/lifecycle/controller.ts:54`), 초과하면 `SIGKILL`로 승격한다(`controller.ts:140`).
6. 자동 시작이 systemd 유닛이면 `Restart=on-failure`(`packages/lifecycle/autostart.ts:66`)가 **SIGKILL 종료를 실패로 보고 5초 뒤 재기동한다.** `systemd.service(5)`는 on-failure의 "clean" 집합에서 SIGHUP/SIGINT/SIGTERM/SIGPIPE만 제외하며 SIGKILL은 포함하지 않는다(호스트 systemd 259 man 페이지로 확인).
7. 재기동 시 `Store.recover()`(`packages/storage/index.ts:99-113`)가 `running`이던 작업을 `queued`로 되돌리고 `service.start()`가 큐를 다시 돌린다.

즉 **"명시적 중지는 자동 재기동하지 않는다"는 계약이 이 경로에서 깨진다.** 헤더 주석(`autostart.ts:7-8`)은 SIGTERM 정상 종료만 전제하고 있다.

수용 기준:
- `runIsolated`가 `apps/runner/execute.ts:117-147`의 `killProcessTree`/`forceKill`과 같은 방식을 쓸 것: POSIX는 `detached:true` + `process.kill(-pid, ...)`, Windows는 `taskkill /T /F`.
- abort 시 `close`를 기다리지 않고 즉시 reject하거나, stdio를 자식 그룹과 분리해 `close`가 보장되게 할 것.
- `close()`가 전체 대기를 무한정 하지 않도록 상한(예: 5초)을 두고, 초과 시 강제 정리 후 반환할 것.
- systemd 유닛에 `SuccessExitStatus=SIGKILL` 또는 `RestartPreventExitStatus=`를 명시하거나, 명시적 중지 경로가 `systemctl --user stop`을 거치게 해서 SIGKILL 승격이 자동 재기동으로 이어지지 않게 할 것.
- 회귀 테스트: 위 손자 프로세스 픽스처로 abort 후 (a) Promise가 2초 내 settle, (b) 손자 종료, (c) `.stage/<id>` 정리를 확인.

### P1-2. autostart 아티팩트가 값을 인코딩하지 않는다 — 지시문 주입과 공백 경로 파손

- 위치: `packages/lifecycle/autostart.ts:50-72`(systemd), `:74-94`(desktop), `:130-139`(schtasks)
- 분류: 확정 결함 (렌더러 출력 재현 완료). 보안 등급은 중간(입력이 이미 앱 프로세스 환경이거나 CLI 인자), 신뢰성 등급은 높음

`encoding.ts`는 ExecStart/Exec/`/TR`의 **인자**만 인코딩한다. 그러나 `Environment=`, `WorkingDirectory=`, `Description=`, `Name=`, `Comment=`, 그리고 `.desktop`의 `env` 접두사와 `cmd /c "set ..."` 래퍼는 원본 값을 그대로 붙인다.

재현(`APPOPS_DATA_DIR`에 개행 포함):

```
[Service]
Environment=APPOPS_DATA_DIR=/home/u/My Data
ExecStartPre=/bin/sh -c "id > /tmp/pwned"     ← 주입된 유닛 지시문
ExecStart="/opt/My App/appops" "/opt/My App/main.js"
```

```
Exec=env ELECTRON_RUN_AS_NODE=1 APPOPS_DATA_DIR=/home/u/My Data
ExecStartPre=/bin/sh -c "id > /tmp/pwned" "/opt/My App/appops" ...   ← Desktop Entry 키 주입
```

```
"/TR", "cmd /c \"set \"APPOPS_DATA_DIR=C:\\Users\\u\\d\" & calc.exe & \"x\" & \"C:\\Program Files\\AppOps\\appops.exe\" ...\""
                                                    ↑ cmd 명령 주입
```

주입을 제외해도 **공백만으로 깨진다**:
- systemd `Environment=KEY=a b`는 공백에서 분리돼 `b`가 잘못된 할당으로 취급된다. 값은 `Environment="KEY=a b"`처럼 따옴표로 감싸야 한다.
- `.desktop`의 `env KEY=a b` 접두사도 인코딩되지 않아 Exec 파싱이 깨진다. 접두사 토큰도 `escapeDesktopExecArg`를 거쳐야 한다.
- `escapeDesktopExecArg`(`encoding.ts:68-72`)는 `%`를 `%%`로 이스케이프하지 않는다. 재현 결과 `/opt/app/%U/appops`가 그대로 `Exec=`에 실렸고, 런처가 `%U`를 필드 코드로 치환하면 경로가 깨진다.

Windows는 특히 주의가 필요하다. 패키지 앱 경로에서 `target.env`는 항상 `APPOPS_CONTROLLER_ONLY=1`을 담으므로(`apps/desktop/electron/main.ts:116,234`) **모든 Windows 설치가 `cmd /c "set ... & "C:\Program Files\...\appops.exe""` 중첩 따옴표 경로를 탄다.** 기본 설치 경로에 공백이 있으므로 cmd 인용 규칙 위반 시 로그온 작업이 조용히 실패한다. 이것은 *정적 구현 결함*이며, 실제 동작 여부는 Windows 런타임 증거가 있어야 확정할 수 있다(본 리뷰 범위 밖).

수용 기준:
- systemd: `Environment="KEY=value"` 형식 + 값의 `"`·`\`·개행 이스케이프, `WorkingDirectory=`/`Description=`은 개행·제어문자 거부.
- Desktop Entry: 모든 값에서 개행·제어문자 거부, `%` → `%%`, env 접두사 토큰도 `escapeDesktopExecArg` 적용.
- schtasks: `cmd /c` 래퍼 대신 값 검증 후 거부하거나, `set` 값에 `"`·`&`·`|`·`<`·`>`·`^`·개행이 있으면 설치를 실패시킬 것. `/TR` 261자 제한도 검사.
- 공통: `buildControllerAutostartTarget` 진입점에서 `program`·`args`·`env` 값의 개행·NUL을 한 번에 거부.
- 회귀 테스트: 공백 포함 경로(`/opt/My App`, `C:\Program Files\...`), `%U` 포함 경로, 개행 포함 `dataDir`을 3개 렌더러에 넣어 결과를 스냅숏 비교.

### P1-3. Android SDK 구성 요소가 버전 고정되지 않고 라이선스 영수증이 남지 않는다

- 위치: `packages/setup/installer.ts:388-428`, `packages/setup/catalog.ts:44,150`
- 분류: 계약 불일치 (설계 리뷰 §4 "fixed package identities", "record consent/license state")

`#installAndroidPackages`는 검증된 명령 도구 zip을 푼 뒤 `sdkmanager --install platform-tools platforms;android-34 build-tools;34.0.0`을 실행한다. 이 단계에서 내려받는 실제 패키지는 카탈로그가 다이제스트로 고정한 대상이 아니라 Google 저장소 XML이 그 시점에 제공하는 리비전이다. 따라서:
- 같은 앱 릴리스가 시점에 따라 다른 SDK 리비전을 설치한다(재현 불가).
- 카탈로그 다이제스트 모델("Setup installs only fixed catalog artifacts with exact digests")이 Android 경로에서만 무효가 된다.
- `ANDROID_PACKAGE_PATTERN`(`catalog.ts:150`)은 `platforms;android-<n>` 형태만 검사하고 리비전을 고정하지 않는다.

라이선스도 영수증이 없다. `--licenses`에 `stdin: 'y\n'.repeat(256)`을 흘려(`installer.ts:418`) **요청한 패키지와 무관한 라이선스까지 일괄 동의**하고, 동의한 라이선스 ID·해시를 어디에도 기록하지 않는다. 게다가 sdkmanager가 영수증을 쓰는 `$HOME`은 `.homes/<job id>`이고(`installer.ts:395`), `#cleanupJob`(`installer.ts:437-441`)이 작업 종료 직후 이 디렉터리를 통째로 지운다. 즉 동의 증거가 한 번도 보존되지 않고 설치마다 다시 무조건 동의한다.

사용자 동의 자체는 `start()`에서 `acceptLicense`로 게이트돼 있고(`installer.ts:195-197`) UI 체크박스와 연결돼 있다(`SetupView.tsx:281-293`). 문제는 "무엇에 동의했는지"가 남지 않는 점이다.

수용 기준:
- 카탈로그가 `platforms;android-34`가 아니라 정확 리비전(예: `platforms;android-34` + 기대 `source.properties` 리비전)을 명시하고, 설치 후 대조할 것.
- 동의한 라이선스 ID와 해시를 스토어에 영수증으로 남기고, `.homes/<id>/.android/licenses`를 지우기 전에 수집할 것.
- `'y\n'` 일괄 입력 대신 요청한 패키지에 필요한 라이선스만 대상으로 하거나, 최소한 수락된 라이선스 목록을 출력에서 파싱해 기록할 것.
- 회귀 테스트: 동일 카탈로그로 두 번 설치했을 때 동일 리비전이 나오는지, 영수증이 재시작 후에도 남는지 확인.

### P1-4. Android SDK 구성 요소를 나중에 추가 설치할 수 없다

- 위치: `packages/setup/installer.ts:294-298`
- 분류: 확정 논리 결함

```ts
if (await this.#validInstall(job.toolId, pkg, versionDir, packages)) { await this.#activateSettings(...); return; }
if (await isDir(versionDir)) throw new AppError('INSTALL_EXISTS', '기존 설치 폴더가 불완전합니다. ...');
```

`versionDir`는 `<root>/android-sdk/<ANDROID_CMDLINE_VERSION>`로 **명령 도구 버전 하나**에 고정된다(`installer.ts:293`). 사용자가 처음 기본 패키지로 설치한 뒤 `platforms;android-35`를 추가로 요청하면:
1. `#validInstall`이 `platforms/android-35` 부재로 `false`,
2. `versionDir`가 이미 존재하므로 `INSTALL_EXISTS`로 실패.

안내 문구는 "수동으로 확인한 뒤 다시 시도"인데, 실제로는 디렉터리를 직접 지우는 것 말고는 방법이 없다. 앱에서 SDK 구성 요소를 늘리는 정상 흐름이 막혀 있다.

수용 기준: 기존 `versionDir`가 유효한 명령 도구 설치이면 `#installAndroidPackages`를 그 디렉터리에 대해 증분 실행하고, 실패 시 기존 설치를 훼손하지 않을 것. 추가 설치 중 취소·실패해도 이전에 설치된 구성 요소가 계속 사용 가능해야 한다.

### P1-5. SetupView의 도구 매칭이 접두사 부분 일치라 오탐/미탐을 만든다

- 위치: `apps/desktop/src/views/SetupView.tsx:173`
- 분류: 확정 논리 결함

```tsx
available={setup.tools.find((t) => t.name.toLowerCase().includes(item.id.split('-')[0]))?.available ?? false}
```

`item.id.split('-')[0]`로 잘라 부분 문자열 매칭을 하므로:

| 카탈로그 항목 | 검색어 | 실제로 매칭되는 toolchain | 결과 |
|---|---|---|---|
| `godot-templates` | `godot` | `godot` (편집기) | **오탐**: 템플릿이 없어도 "연결됨" |
| `steamcmd` | `steamcmd` | 없음 | **미탐**: 항상 "경로 있음(미확인)" |
| `unreal` | `unreal` | `unreal-uat` | 엔진 루트 검증 결과 미반영 |

특히 Godot 내보내기 템플릿 오탐은 P0-2와 같은 성격의 거짓 녹색이다. 프로젝트 준비 카드는 `godot-export-templates`를 올바르게 보지만(`readiness.ts:8`), 도구 카드만 보는 사용자는 템플릿이 준비된 것으로 오인한다.

수용 기준: `ToolCatalogItem`에 검증 toolchain 이름을 명시 필드로 추가하고(`godot-templates` → `godot-export-templates` 등) 정확 일치로 조회할 것. `steamcmd`는 대응 toolchain이 없음을 별도 상태로 표시할 것.

### P1-6. 설치 카드가 가장 오래된 작업을 집어 진행 중인 설치를 가린다

- 위치: `apps/desktop/src/views/SetupView.tsx:172`, `packages/setup/installer.ts:203`
- 분류: 확정 논리 결함

`#jobs.push(job)`로 작업이 **오래된 순**으로 쌓이고 `list()`가 그 순서를 유지한다(`installer.ts:203,210`). UI는 `installations.find(j => j.toolId===item.id && (ACTIVE.has(j.status) || j.status==='failed'))`로 **첫 번째** 일치를 고른다. 한 번 실패한 뒤 재시도하면 옛 `failed` 작업이 먼저 매칭되어:
- 진행률 바와 취소 버튼이 나타나지 않고,
- "이전 설치 실패" 배지가 계속 보이며,
- 설치 버튼이 활성 상태로 남아 사용자가 같은 설치를 반복 큐잉한다.

데모 경로는 `demoJobs.unshift(job)`로 최신순이라(`apps/controller/preparation.ts:97`) 데모와 실제의 표시 동작이 서로 다르다.

수용 기준: 가장 최근 작업을 선택하도록 정렬 기준을 명시하고(`createdAt` 내림차순), 데모/실제 정렬을 통일할 것. 진행 중 작업이 있으면 설치 버튼을 비활성화할 것.

### P1-7. `sdkRequired` 준비 항목이 증거를 전달받지 못해 영구 미충족이다

- 위치: `packages/setup/readiness.ts:60`, `apps/controller/preparation.ts:111`
- 분류: 확정 논리 결함

```ts
// readiness.ts:60
if(p.sdkRequired) push('sdk','게임 광고·결제 연결', Boolean(evidence.sdk?.installed && evidence.sdk.verified), ...)
```

`PreparationEvidence.sdk`를 채우는 프로덕션 호출자가 없다. 유일한 호출부(`preparation.ts:111`)는 `preferences/state/runners/isolation/runnerTools/planFindings`만 넘긴다. 따라서 사용자가 "이 대상에 광고·결제 SDK 연동이 필요합니다"를 켜는 순간(`SetupView.tsx:510`) 해당 대상은 **영원히 `ready`가 될 수 없다.** `ProjectIntegrations`가 추적하는 실제 연동 상태가 준비 판정에 연결돼 있지 않다.

수용 기준: `Preparation.state()`가 `ProjectIntegrations`의 탐지·적용 결과에서 `{installed, verified, detail}`을 만들어 전달하고, 연동 완료·시험 실행 확인 시 체크가 `ready`가 되는 통합 테스트를 추가할 것.

---

## P2

### P2-1. pax `size` 오버라이드 시 tar 패딩이 어긋난다
`packages/setup/download.ts:270,289`. `pad`는 `header.size`로 계산하는데 실효 크기는 `pax.size ?? header.size`다. 8GB 초과 엔트리(ustar size 필드가 0이고 pax `size`가 실제 값)에서 패딩이 0으로 계산돼 스트림 정렬이 깨진다. 현재 카탈로그 아티팩트에는 해당 엔트리가 없어 실피해는 없지만 P0-1 수정 시 함께 고쳐야 한다.

### P2-2. ZIP CRC-32를 검증하지 않는다
`packages/setup/archive.ts:24-36,51-53`. 중앙 디렉터리의 비압축 크기만 대조하고 CRC는 읽지 않는다. 아카이브 전체가 SHA-512/SHA-256으로 고정 검증되므로 현재 위험은 낮지만, 설계 리뷰의 "hostile-archive defenses"를 완전히 만족하려면 엔트리 CRC 대조를 추가하는 편이 낫다. 링크·특수 파일 거부(`archive.ts:29`), 대소문자 충돌 거부(`archive.ts:28`), 파일/디렉터리 경로 충돌 거부(`archive.ts:35`), ZIP64 거부(`archive.ts:21`)는 모두 올바르게 구현돼 있다.

### P2-3. sdkmanager 실행 후에 `assertTreeSafe`를 다시 하지 않는다
`packages/setup/installer.ts:317,319,321`. `assertTreeSafe(stage)`는 압축 해제 직후에만 돌고, 그 다음 sdkmanager가 임의 패키지를 같은 `stage`에 풀어넣는다. 그 상태로 `rename(stage, versionDir)`되어 관리형 도구 루트가 된다. Android 패키지는 정당한 심볼릭 링크를 포함할 수 있으므로 단순 재검사는 설치를 깨뜨린다. 관리형 루트를 빌드 샌드박스에 read-only로 마운트하는 계약과 함께 "허용되는 링크 대상은 관리형 루트 내부로 한정" 같은 규칙을 정해야 한다.

### P2-4. 데모 모드가 실제 OS를 바꾸지 못하게 하는 방어가 renderer에만 있다
`apps/desktop/src/api.ts:492-519`가 `demoBlocked()`로 막고 `LifecyclePanel.tsx:164,172,268,277`이 버튼을 비활성화한다. 그러나 `apps/desktop/electron/main.ts:401-450`의 IPC 핸들러는 실행 모드를 전혀 모르며, `window.appOps.autostart.enable()`이 호출되면 모드와 무관하게 실제 OS 자동 시작을 설치한다. "데모는 실제 제어 서비스·OS 자동 시작을 절대 바꾸지 않는다"(`LifecyclePanel.tsx:4`)는 불변식이 UI 계층에만 존재한다. main 프로세스가 모드를 알고 거부하는 편이 낫다.

### P2-5. `schtasks` 상태 조회가 비활성 작업을 "켜짐"으로 보고한다
`packages/lifecycle/autostart.ts:282-287`. `schtasks /Query /TN <id>`는 작업이 **비활성(Disabled)**이어도 종료 코드 0을 반환하는데 코드는 `enabled: installed`로 단정한다. 사용자가 작업 스케줄러에서 끈 경우 UI가 "켜짐"으로 표시된다(거짓 녹색). `/FO LIST /V` 출력의 `Scheduled Task State`를 파싱해야 한다. macOS LaunchAgent도 `RunAtLoad` 값만 보고 `launchctl` 비활성화 여부를 확인하지 않는다(`autostart.ts:273-281`). 둘 다 Windows/macOS 런타임 증거가 필요한 항목이며, 여기서는 정적 검토 결과만 보고한다.

### P2-6. `isTransientProgramPath`가 Windows 임시·언팩 경로를 놓친다
`apps/desktop/electron/main.ts:212-220`. `/tmp/`·`/linux-unpacked/`는 POSIX 전용이고 Windows의 `%LOCALAPPDATA%\Temp\`, `win-unpacked`는 매칭되지 않는다(`release` 디렉터리는 정규식이 양쪽 구분자를 처리해 걸린다). 반대로 정상 설치 경로에 `release` 세그먼트가 있으면 잘못 거부한다. 경로 문자열 패턴 대신 `app.isPackaged` + `process.env.APPIMAGE` + 실행 파일의 상위 디렉터리 쓰기 권한 조합으로 판정하는 편이 정확하다.

---

## 설계 리뷰 대비 해소를 확인한 항목

아래는 v4 설계 리뷰가 P0/P1으로 지적했던 사항 중 **이번 스냅숏에서 실제로 고쳐진 것**이다. 후속 리뷰에서 중복 지적하지 않도록 기록해 둔다.

- **런처 환경 상속 (설계 P0)**: `apps/runner/execute.ts:204-206`이 `...process.env` 병합을 버리고 `PATH`/`LANG`/`SystemRoot`만 담은 최소 환경으로 교체됐다. 취소 시 POSIX는 `detached` 프로세스 그룹 + `process.kill(-pid)`, Windows는 `taskkill /T /F`를 쓴다(`execute.ts:117-147`). (같은 패턴을 `installer.ts`가 따르지 않는 점이 P1-1이다.)
- **단일 인스턴스 (작업 지시의 requestSingleInstance lock)**: 실제 방어는 Electron 잠금이 아니라 DB 임대다. `packages/storage/index.ts:69-81`이 `Store` 생성 시 `BEGIN IMMEDIATE`로 `controller` 테이블의 60초 임대를 잡고, 살아 있는 임대가 있으면 `CONTROLLER_RUNNING`으로 거부한다. `apps/controller/server.ts:48`에서 `new Store(...)`가 `service.start()`(`server.ts:216`)보다 **먼저** 실행되므로 두 번째 컨트롤러는 큐를 돌리기 전에 실패한다. 10초 하트비트 + `assertOwner()` 펜싱(`storage/index.ts:83-97`)으로 오래된 소유자의 쓰기도 차단된다. Electron 쪽 `app.requestSingleInstanceLock()`(`main.ts:509`)은 창 중복만 막고 `APPOPS_CONTROLLER_ONLY=1` 헤드리스 경로에는 적용되지 않지만(`main.ts:505-506`), DB 임대가 그 경로도 덮는다.
- **PID 재사용 (작업 지시)**: `stopController`(`packages/lifecycle/controller.ts:112-142`)는 `checkHealth`가 실패하면 신호를 보내지 않는다. `verifyOwnController`(`main.ts:126-140`)는 공개 `/health`의 `startedAt`이 `controller.json`과 일치하는지, 그리고 인증된 `/state`가 우리 bearer를 수락하는지 **둘 다** 확인한다. 죽은 `controller.json`이 가리키는 재사용 PID를 죽이지 않는다. 다만 `startedAt`은 양쪽 모두 존재할 때만 비교하므로(`main.ts:132`) 필드가 없는 구버전 파일에서는 토큰 확인만 남는다.
- **앱 종료와 제어 서비스 분리**: `spawn(..., {detached:true, stdio:'ignore'})` + `unref()`(`main.ts:149-154`), `window-all-closed`에서 컨트롤러를 건드리지 않음(`main.ts:529-533`). 기동 실패 시 방금 띄운 PID만 SIGTERM으로 정리한다(`controller.ts:90-97`).
- **renderer IPC 신뢰 프레임**: 모든 핸들러가 `isTrustedFrame`을 먼저 통과시킨다(`main.ts:364,371,381,389,393,402,409,417,428,444`). 최상위 프레임만 허용하고, 개발 모드는 loopback dev 서버 origin, 프로덕션은 `file:`만 허용한다(`main.ts:339-360`). `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webviewTag:false`(`main.ts:465-469`), `will-navigate` 차단 + `setWindowOpenHandler` deny(`main.ts:476-483`), `APPOPS_DEV_SERVER_URL`/`APPOPS_API_URL`의 loopback 강제(`main.ts:48,92-104`)도 함께 확인했다.
- **명시적 중지만 종료**: UI의 중지/재시작은 HTTP가 아닌 IPC로 동작해 컨트롤러가 내려가도 쓸 수 있다(`LifecyclePanel.tsx:3,190`). LaunchAgent는 `KeepAlive=false`, schtasks는 단발 `ONLOGON`이라 정상 종료 후 재기동하지 않는다. systemd `Restart=on-failure`도 **SIGTERM 종료에 대해서는** 재기동하지 않는다(호스트 `man 5 systemd.service`: on-failure의 clean 집합에서 SIGHUP/SIGINT/SIGTERM/SIGPIPE 제외). 문제는 SIGKILL 승격 경로뿐이다(P1-1).
- **불안정 경로에서 자동 시작 거부**: `autostart_unstable_path`로 AppImage 임시 마운트·`linux-unpacked`·`node_modules/electron/dist` 실행을 거부하고 UI가 안내한다(`main.ts:429-434`, `SetupView`가 아닌 `LifecyclePanel.tsx:258-262`). 커버리지 한계는 P2-6.
- **카탈로그 다이제스트 정확성**: Godot 4.3-stable 공식 `SHA512-SUMS.txt`를 직접 받아 `catalog.ts:57-62`의 4개 값(linux.x86_64.zip, macos.universal.zip, win64.exe.zip, export_templates.tpz)이 **모두 일치**함을 확인했다.
- **다운로드 경로 방어**: HTTPS 고정·인증정보 금지·443 외 포트 금지·IP/localhost 금지·호스트 허용목록(`download.ts:13-28`)이 **모든 리디렉션 홉마다** 재적용된다(`download.ts:36-47`, 최대 8홉). 다이제스트 핀이 없으면 `DIGEST_REQUIRED`로 거부한다(`download.ts:66-68,72`). `checksumUrl`은 카탈로그에 기록만 되고 검증에 쓰이지 않는다 — 원격 체크섬 파일로 핀을 대체하지 않으므로 올바르다. 크기 상한은 선언 `content-length`와 실제 수신 바이트 양쪽에서 적용되고(`download.ts:78,95`) 잘림도 검출한다(`download.ts:112-115`). `redirect:'manual'` 의미는 Node v22.22.1에서 실제 302와 `location` 헤더를 그대로 돌려주는 것을 실행으로 확인했다(opaque redirect가 아님).
- **프로젝트·대상별 준비 판정 (설계 P1)**: `evaluatePreparation`이 `(project, target, runner)` 단위로 평가한다. Android 서명 키는 `project.buildSecurity.androidKeystoreId`에 **바인딩된** 키만 인정하고(`readiness.ts:45-48`), 스토어 계정은 provider 일치 + 프로젝트 허용 연결 + `connected` 상태를 요구하며(`readiness.ts:49-54`), 앱 식별자·스토어 앱 확인·대상 빌드 성공 이력까지 본다(`readiness.ts:55-59`). 원격 러너는 `status==='ready'` + 24시간 이내 확인을 요구하고(`readiness.ts:30`), `checkRunner`는 프로토콜·플랫폼·`isolation.available`을 모두 대조한다(`operations.ts:checkRunner`). iOS는 러너 플랫폼이 `darwin`인지 확인한다(`readiness.ts:32`). 설계 리뷰가 지적한 "전역 계정 하나·키 하나로 무관한 프로젝트가 ready" 결함은 해소됐다. 남은 구멍은 P0-2(도구 버전·패키지 실체 미확인)와 P1-7이다.
- **홈 디렉터리 도구 처리 (설계 P1)**: `insideHome()` 아래 경로는 `managedToolPath()`로 관리형 루트(`<dataDir>.tools`) 내부임을 증명해야만 사용 가능하다(`toolchains.ts:92,113,130`). 평범한 홈 설치는 탐지되지만 사용 불가로 남는다. `saveTools`는 `realpath` 정규화 후 파일시스템 루트·홈 전체·스토어 디렉터리·등록된 프로젝트 트리와의 겹침을 거부한다(`preparation.ts:47-53`). `within()`은 `path.relative` 기반이라 `/a/b`와 `/a/b.tools`를 혼동하지 않는다(`validation.ts:26-29`).
- **전역 환경 미오염**: 설치 결과는 `ToolSettings`에만 저장되고 `process.env`를 바꾸지 않는다(`preparation.ts:21` 주석과 `installer.ts:325-339` 구현 일치). sdkmanager 실행 환경은 화이트리스트로 새로 구성된다(`installer.ts:44-48,398-413`).
- **원자적 활성화**: 스테이징(`.stage/<job>`) → 검증 → `rename`(`installer.ts:321`) → 설정 저장 순서이고, 스테이징 디렉터리가 이미 있으면 거부하며(`archive.ts:42`, `download.ts:214`), 재시작 시 고아 스테이징을 정리한다(`installer.ts:430-435`). 활성 버전을 제자리 덮어쓰지 않는다.

---

## 남은 증거 공백 (이 리뷰로 닫지 못함)

| 영역 | 이 리뷰에서 확보한 증거 | 여전히 필요한 것 |
|---|---|---|
| Linux 설치 파이프라인 | tar/zip 파서·다운로드 방어를 실제 실행으로 검증. 공식 아티팩트 헤더·체크섬 확인 | P0-1 수정 후 실제 Temurin/Godot/Android 전체 설치 1회 완주 |
| Windows 자동 시작 | `buildSchtasksCreateArgs` 출력 정적 확인 | 실제 Windows에서 `Program Files` 경로 로그온 작업 생성·기동·상태 조회 |
| macOS 자동 시작 | plist 렌더링 정적 확인 | `launchctl load/unload`, 비활성화 상태 보고, 로그인 기동 |
| sdkmanager 격리 | 손자 프로세스 잔존을 Linux에서 재현 | Windows에서 `taskkill /T` 경로, 취소 후 잔존 프로세스 부재 |
| Electron 창 기동 | 호스트의 `/opt/google/chrome/chrome-sandbox`가 root 소유 4755임을 확인(앱 자체 바이너리가 아님). `inspectLinuxSandbox` 진단 로직은 정적 검토만 수행 | 앱 자체 바이너리로 실제 창 기동 — root의 외부 Chromium 헬퍼 작업 결과 대기 |
| 데모/실제 격리 | renderer 2계층 차단 확인 | main 프로세스 차단 추가 후 재확인 |

Windows·macOS 항목은 **컴파일·정적 구현**만 확인한 상태이며 보안·동작 증거가 아니다. 해당 대상은 증거가 생길 때까지 `unavailable` 또는 `action_required`로 유지해야 한다.
