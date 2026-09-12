# 빌드 지원표

Last Updated: 2026-09-11

이 표는 엔진 검수·빌드 plan·러너 구현을 기준으로 한다. **실측**은 이 저장소에서 실제 파일·프로세스로 확인한 동작이다. **미검증**은 공식 CLI 문서에 맞춰 명령을 구성했으나 해당 엔진/SDK/호스트가 이 환경에 없어 실제 결과물·서명을 확인하지 못한 항목이다. 미검증을 지원 완료로 읽지 않는다.

공식 근거:

- Godot CLI 내보내기: <https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html>
- Unity Editor CLI: <https://docs.unity3d.com/6000.0/Documentation/Manual/EditorCommandLineArguments.html>
- Unreal BuildCookRun: <https://dev.epicgames.com/documentation/en-us/unreal-engine/build-operations-cooking-packaging-deploying-and-running-projects-in-unreal-engine>
- Android Gradle Wrapper: <https://developer.android.com/build/building-cmdline>
- Xcode archive/export: `xcodebuild archive` 및 `-exportArchive` (Apple 문서, macOS 전용)

## 탐지 우선순위

같은 폴더에 여러 마커가 있으면 Godot(`project.godot`) > Unity(`ProjectSettings/ProjectVersion.txt` 또는 내보내기 마커) > Unreal(`.uproject`) > 네이티브 Android > 네이티브 iOS 순이다. Unity가 내보낸 Gradle(`unityLibrary`, `com.unity3d.player`, `Unity-iPhone.xcodeproj`)과 Godot `android/build` Gradle은 네이티브 Android로 분류하지 않는다. 서로 다른 엔진의 일차 마커가 함께 있으면 `detect.conflict` finding을 남기고 위 순위로 하나를 고른다.

## 실측 (이 환경에서 확인)

초기 호스트: Linux, Node.js 22. 초기 도구 탐지 검사는 최소 프로젝트 파일·모의 실행 파일을 사용했다. 이후 공식 Godot 4.3 편집기와 템플릿을 전용 폴더에 준비해 아래 실제 내보내기 및 controller E2E를 검증했다. Unity/Unreal/Xcode/Android SDK 실제 실행은 미검증이다.

| 항목 | 결과 | 근거 |
|---|---|---|
| Godot `project.godot` + `export_presets.cfg` 탐지 | 통과 | 이름·4.3 버전·패키지 ID·android/linux 타깃 |
| Unity `ProjectSettings/ProjectVersion.txt` 탐지 | 통과 | 에디터 버전·applicationIdentifier |
| Unreal `.uproject` + `DefaultEngine.ini` 탐지 | 통과 | EngineAssociation 5.4, PackageName |
| 네이티브 Android Wrapper+Manifest | 통과 | applicationId, 대상 android. `gradlew`는 실행하지 않음 |
| 네이티브 iOS pbxproj/scheme | 통과 | 번들 ID. Linux에서 `ios.requires_macos` 오류 finding |
| Unity 내보낸 Gradle 오탐 방지 | 통과 | `unityLibrary` Gradle이 `android`가 아니라 `unity` |
| Unity 원본+Gradle, Godot+`android/build` | 통과 | 각각 unity / godot 유지 |
| 혼합 폴더 충돌 | 통과 | godot+unity 마커 → `detect.conflict`, Godot 우선 |
| 검수 중 빌드 스크립트 미실행 | 통과 | 실행 시 표시를 남기는 `gradlew`가 호출되지 않음 |
| Git 없는 폴더 검수·스냅샷 | 통과 | `.git` 없이 동작 |
| 스냅샷 원본 보존 | 통과 | 원본 내용·mtime 유지 |
| 비밀·캐시·외부 심볼릭 링크 제외 | 통과 | `.env`, `.pem`, `id_rsa`, `.godot/`, `Library/`, 외부 링크 미복사 |
| 출력 디렉터리 자기포함 방지 | 통과 | 원본 안의 대상 폴더는 매니페스트에 재포함되지 않음 |
| 매니페스트 해시 결정성 | 통과 | 동일 입력 두 스냅샷의 SHA-256 일치 |
| `spawn(shell: false)` + 인수 배열 | 통과 | `a; rm -rf /` 가 셸로 해석되지 않음 |
| 모의 실행 파일 성공·결과물 실존 | 통과 | 파일이 있을 때만 `exitCode=0` |
| 도구 부재 | 통과 | 없는 실행 파일 → 종료 코드 127, 결과물 없음 |
| 프로세스 실패 | 통과 | 종료 코드 2를 성공으로 바꾸지 않음 |
| 결과물 없는 성공 코드 | 통과 | 프로세스 0이어도 기대 파일 없으면 실패 |
| AbortSignal 취소 | 통과 | 샌드박스 프로세스 종료, `cancelled=true` |
| Linux bwrap 격리 | 통과 | 호스트 비밀 파일 읽기 차단, 격리 실패 시 폴백 없음 |
| 표준 출력 제한 | 통과 | 2MB 출력이 1MB에서 잘림 |
| 빈 명령 plan | 통과 | 명령 0개면 실패 |
| Godot/Unity/Unreal/Gradle plan 형식 | 통과 | 공식 인수 배열 생성. 없는 프리셋/빌드 프로파일은 명령을 만들지 않음 |
| `scanToolchains` | 통과 | 미설치 도구는 `available: false` + 이유. Linux에서 xcodebuild 불가 |

## 미검증 (실제 엔진·장비 필요)

| 조합 | 구성한 명령 | 미검증 이유 |
|---|---|---|
| Godot 4.3 **Linux** 실제 내보내기 | `godot --headless --path <snapshot> --export-release Linux <output>` | **검증 완료** — 아래 "실제 Godot Linux 전체 내보내기 실측" 참조 |
| Godot 4.x Android/iOS/Windows/macOS 실제 내보내기 | `godot --headless --path <project> --export-release <preset> <output>` | Linux 외 타깃 템플릿·서명·호스트 미검증 |
| Unity 데스크톱 실제 플레이어 | `-batchmode -nographics -quit -projectPath -buildLinux64Player` 등 | Unity Editor 없음. 라이선스·모듈 미확인 |
| Unity Android/iOS | `-activeBuildProfile` + `-build` (전용 `-build*Player` 없음) | 빌드 프로파일 샘플과 Editor 없음 |
| Unreal BuildCookRun | `RunUAT.sh BuildCookRun -build -cook -stage -package -archive` | Unreal Engine / UAT / 플랫폼 SDK 없음 |
| 네이티브 Android AAB/APK | `gradlew app:bundleRelease` 또는 debug `assembleDebug` | JDK·Android SDK·실제 앱 모듈 빌드 없음 |
| iOS archive/IPA | `xcodebuild archive` 후 `-exportArchive` | Linux 호스트. Mac·Xcode·서명·ExportOptions.plist 실사용 없음 |
| 서명된 스토어 결과물 | Play AAB, App Store IPA, Steam 데스크톱 바이너리 | 서명 비밀·스토어 업로드는 이 범위 밖 |
| Windows/macOS 호스트 경로 | Unity Hub·Xcode 기본 설치 경로 탐색 코드만 존재 | 해당 OS에서 실행하지 않음 |

## 샌드박스 도구 준비 (1회 APPOPS_* 설정)

샌드박스는 네트워크가 없고 HOME이 비어 있어 표준 Gradle Wrapper 다운로드나 Godot 템플릿 자동 설치가 불가능하다. 아래 도구/캐시를 **홈 밖 전용 디렉터리**에 1회 준비하고 환경 변수로 지정한다. 이 `APPOPS_*` 변수 자체는 샌드박스에 전달되지 않고, 검증된 경로만 read-only로 mount된다. 준비되지 않으면 plan이 명령을 만들지 않고 actionable finding을 남긴다(fail closed).

| 환경 변수 | 가리킬 대상 | 검증 조건 |
|---|---|---|
| `APPOPS_GRADLE_TOOLS_DIR` | 오프라인 Gradle 도구 캐시 | `wrapper/dists/<배포판>/`(프로젝트 `gradle-wrapper.properties`의 distributionUrl 버전)과 `dependency-cache/`가 있어야 하며, `gradle.properties`가 없어야 한다(자격 증명 혼입 방지). 홈 밖. |
| `APPOPS_GODOT_DATA_DIR` | Godot 데이터 디렉터리 | `export_templates/<버전>/`(예: `4.3.stable/linux_release.x86_64`)가 있어야 한다. 홈 밖. 런타임에 per-run `XDG_DATA_HOME/godot/export_templates`로 read-only 링크된다. |
| `APPOPS_JAVA_HOME` (또는 `JAVA_HOME`) | JDK 루트 | `bin/java` 실행 파일 존재, 홈 밖. Gradle에 `JAVA_HOME`으로 전달·mount. |
| `APPOPS_ANDROID_SDK_ROOT` (또는 `ANDROID_HOME`) | Android SDK 루트 | `platforms/` 또는 `build-tools/` 존재, 홈 밖. `ANDROID_HOME`/`ANDROID_SDK_ROOT`로 전달·mount. |
| (Unreal) `engineExecutable`/`UE_ROOT` | RunUAT 경로 | `Engine/Build/BatchFiles`, `Engine/Binaries`, AutomationTool(`Engine/Binaries/DotNET` 또는 `Engine/Source/Programs/AutomationTool`)이 있는 검증된 엔진 루트. 루트 전체를 `UE_ENGINE_ROOT`로 mount. |

- 쓰기 가능한 per-run 캐시(`GRADLE_USER_HOME`, `XDG_DATA_HOME`)는 실행별 출력 디렉터리 안에만 생성되고 매 시도마다 초기화된다. 도구 이미지는 read-only, 캐시는 프로젝트 코드 실행 없이 디렉터리 생성·심볼릭 링크로만 준비한다.
- Gradle은 `--offline --no-daemon`으로 실행하고 `GRADLE_RO_DEP_CACHE`로 준비된 의존성 캐시를 read-only로 사용한다.
- `scanToolchains`는 위 준비 상태를 `gradle-offline-cache`/`godot-export-templates`/`jdk-home`/`android-sdk-validated`/`unreal-engine-root` 항목으로 미리 보고해 실행 전에 누락을 드러낸다.

## 러너 계약

- 빌드 입력은 이미 만든 스냅샷 경로를 사용한다. 원본 폴더를 빌드 cwd로 쓰지 않는다.
- 실행은 `shell: false`와 인수 배열만 사용한다.
- Linux에서는 bubblewrap(`/usr/bin/bwrap`)으로 실행한다. 스냅샷·출력·검증된 도구 경로만 bind하고, `--clearenv` 후 최소 환경, `--unshare-net`으로 네트워크 차단, `--unshare-pid`+`--proc`으로 pid 격리, 사용자 홈(특히 `~/.gradle`·`~/.ssh` 같은 dotfile 트리)·controller 데이터·DBus는 mount하지 않는다. `APPOPS_*` 변수는 샌드박스에 넣지 않는다.
- 격리 백엔드를 초기화할 수 없으면 일반 실행으로 폴백하지 않고 실패한다 (fail closed).
- Windows/macOS는 이 환경에서 검증된 격리 러너가 없어 빌드 실행을 지원하지 않는다고 표시한다.
- 취소 시 프로세스 그룹에 SIGTERM 후 유예 시간 뒤 SIGKILL.
- 표준 출력/에러는 스트림당 1,048,576바이트에서 자른다.
- **결과물 출처 보증**: 매 빌드 시도 시작에 출력 디렉터리와 기대 결과물 경로(스냅샷 안 포함)를 제거해 이전 시도의 산출물이 재인증되지 않게 한다. 제거는 스냅샷/출력 루트 안의 검증된 경로만 대상으로 하며 호스트 경로는 건드리지 않는다.
- 기대 결과물 경로는 실행 전에 검증한다: 스냅샷/출력 루트 밖, 스냅샷 루트 전체, 대상과 맞지 않는 확장자(android→`.apk`/`.aab`, ios→`.ipa`/`.zip`/`.xcarchive`)는 거부한다.
- 기대 결과물은 심볼릭 링크·0바이트 파일·빈 디렉터리를 성공으로 인정하지 않는다.
- 스냅샷은 심볼릭 링크를 따라가지 않고(leaf는 `O_NOFOLLOW`로 열어 lstat→open 사이 교체를 차단), 엔진 캐시와 키·환경 파일, 그리고 임의 깊이의 `.git`(디렉터리·gitlink 파일 모두)을 제외한다. 두 번째 경계로 `excludedRoots`(controller 데이터 디렉터리 등, real path 기준)를 받아 원본 아래 심볼릭 alias까지 제외한다. 읽을 수 없는 디렉터리·파일은 조용히 건너뛰지 않고 오류로 실패시켜 부분 스냅샷을 성공으로 표시하지 않는다.

## 격리 실측 (2026-09-11, Linux)

| 항목 | 결과 |
|---|---|
| `/usr/bin/bwrap` 존재 | 있음 (80424 bytes, 2026-04-29) |
| 네임스페이스 초기화 `--unshare-user-try --unshare-pid --unshare-net` + `/bin/true` | 성공 |
| 스냅샷 bind + 호스트 홈/`/etc/passwd` 숨김 | 성공. 샌드박스에서 홈 파일 읽기 차단 |
| 격리 불가 시 폴백 금지 | 성공. `forceUnavailable` 이면 명령 미실행·exit 1 |
| Windows/macOS 격리 러너 | 미검증·미지원 (이 호스트는 Linux) |

## 실제 Godot Linux 전체 내보내기 실측 (2026-09-11, Linux) — 통과

공식 Godot 4.3-stable Linux 편집기와 **공식 내보내기 템플릿 전체**를 전용 `/tmp/appops-godot-verification-20260911/`에 내려받아(전역 설치·사용자 프로필·비밀 없음) 실제 파이프라인 `inspect → createSnapshot(excludedRoots) → createBuildPlan → isolated executeBuild`를 끝까지 실행했다.

도구/버전/해시:

| 항목 | 값 |
|---|---|
| 편집기 | `Godot_v4.3-stable_linux.x86_64`, `4.3.stable.official.77dcf97d8` |
| 편집기 sha256 | `6e100966e49c69a2d4c163673f606eec1bafe54b4c6170eec5a6a2ee50756ddd` |
| 템플릿 | 공식 `Godot_v4.3-stable_export_templates.tpz` (1,073,228,327 bytes), `version.txt=4.3.stable` |
| `linux_release.x86_64` 템플릿 sha256 | `815e684e29581339daefab779b8c2b36d081fba58e4db8a2b66cdaeefcb80bbc` |
| `APPOPS_GODOT_DATA_DIR` 레이아웃 | `<dir>/export_templates/4.3.stable/linux_release.x86_64` |

실행 명령(러너가 bwrap로 감싼 실제 argv):

```
--headless --path <snapshot> --export-release Linux <output>/AppOps Verify
env: XDG_DATA_HOME=<output>/.appops-task-cache/xdg-data  GODOT_TEMPLATES_SOURCE=<APPOPS_GODOT_DATA_DIR>
```

결과:

- **snapshot excludedRoots**: 원본 아래 둔 `.appdata/controller.json`(가짜 bearer)이 스냅샷에 복사되지 않음(`controller.json in snapshot: false`). 스냅샷 3파일·1002바이트.
- **내보내기**: bwrap 샌드박스(HOME=`/tmp/appops-home`, `--unshare-net`) 안에서 Godot 4.3이 프로젝트를 임포트·팩하고 `exitCode 0`으로 성공. 산출물:
  - 실행 파일 `AppOps Verify` 66,074,584 bytes (embed_pck=false이므로 실행 파일은 템플릿과 동일, sha256 `815e684e…`).
  - **신선한 `AppOps Verify.pck`** 1,648 bytes (프로젝트 콘텐츠; 매 실행 새로 생성). 이 sidecar가 실제 빌드 산출물이다.
- **per-run 캐시 격리**: `XDG_DATA_HOME/godot/export_templates`가 검증된 데이터 디렉터리로 read-only 심볼릭 링크되고, 캐시는 출력 하위 `.appops-task-cache`에만 생성됨(결과물로 집계되지 않음).
- **내보낸 결과물 실행**: 같은 bwrap 샌드박스에서 `AppOps Verify --headless --quit` 실행 → `exitCode 0`, 게임의 `_ready()`가 `AppOps headless export OK` 출력 후 정상 종료. 즉 산출물이 실제로 구동됨을 확인.

이 실측으로 드러난 러너/엔진 수정(회귀 테스트 추가):

- **PCK 출처 보증**: Linux/Windows 비임베드 내보내기에서 실행 파일은 템플릿과 바이트 동일하므로, 신선한 콘텐츠인 `<name>.pck`를 `expectedArtifacts`에 함께 넣도록 `createBuildPlan`을 고쳤다. 프리셋 `binary_format/embed_pck=true`이면 sidecar가 없으므로 넣지 않는다. 이전에는 팩이 실패해도 템플릿 복사본 실행 파일만으로 성공 처리될 수 있었다. (`parseGodotPresets`의 `embedPck` 파싱 + `tests/engines.test.ts` 회귀 테스트)

보존: 검증용 도구/프로젝트/출력은 root 컨트롤러 스모크를 위해 `/tmp/appops-godot-verification-20260911/`에 **삭제하지 않고 보존**했다(편집기 `downloads/`, 템플릿 `godot-data/`, 최소 프로젝트 `project/`, 스냅샷 `snapshot/`, 산출물 `output/`, 드라이버 `verify.mjs`/`launch.mjs`).

## 후속 실측이 필요한 환경

Godot 나머지 타깃(Android/iOS/Windows/macOS)과 Unity·Unreal·네이티브 Android(JDK+SDK)·Xcode의 실제 결과물 산출은 여전히 미검증이다. Android 키스토어 등록·별도 서명·JAR 형식 AAB의 실제 서명 검사는 [빌드 키 관리](build-credentials.md)처럼 구현·검증했다. 설치 가능한 Android 앱·APK SDK 도구, iOS 서명·프로파일(macOS 전용), Unity/Unreal 라이선스 환경은 아직 미검증이다. Godot Linux 경로는 위 실측으로 완료로 이동한다.

최신 제어 서비스 E2E는 소스 등록부터 스냅샷·격리 빌드·산출물 증명·이력까지 통과했다. 실행 ID `365f75c7-71c0-4a29-9550-0de33c8cd1bc`, 실행 파일 66,074,584 bytes와 PCK 1,840 bytes. [실제 결과 기록](verification-assets/godot-controller-20260911.json)과 [검증 명령](verification.md)을 참고한다.

## v3 원격 러너와 데모 검증

[원격 러너 프로토콜](runner-protocol.md)의 Bearer 페어링, 검증된 소스 전송, 서버에서 빌드 계획 생성, 결과물 해시 확인을 구현했다. 실제 Linux Godot 원격 빌드(`scripts/verify-remote-godot.ts`)와 생성 게임의 headless 실행을 확인했다. 실행 파일 66,074,584 bytes와 PCK 1,840 bytes를 같은 폴더로 회수했다. 로컬 호스트와 연결된 원격 실행 경계를 통과한 검사이며 다른 OS의 격리 지원 증거는 아니다.

출시 폼은 프로젝트에서 탐지한 대상만 제공한다. iOS에서 준비 완료된 Mac 러너를 선택하면 로컬 Mac 필요 오류만 제외하고 소스 검수 오류는 그대로 검사한다. 현재 CLI의 macOS/Windows 내장 격리는 미지원이므로 별도의 검증된 launcher 없이는 ready가 되지 않는다.

데모는 Godot·Unity·Unreal·Android·iOS 빌드와 업로드를 모두 큐·이력에서 재현한다. 이 결과물은 명시적인 합성 자료이며 게임 실행 파일이나 스토어 제출용 패키지가 아니다.
