# 검증된 도구 설치

Last Updated: 2026-09-23

앱은 사용자 홈이나 임의의 URL에서 도구를 받지 않습니다. 설치 관리자는 릴리스에 고정된 카탈로그만 사용하고, 받은 파일의 다이제스트가 일치할 때만 전용 폴더에 활성화합니다. 제어 서비스는 `dataDirectory + '.tools'`를 관리 루트로 넘기고, 빌드를 큐에 넣을 때 `ToolSettings` 경로를 스냅샷합니다. 전역 `process.env`는 바꾸지 않습니다.

## 설치 계약

`packages/setup/installer.ts`의 `ToolInstaller`:

- `constructor({root, getSettings, saveSettings, persist, initialJobs?, fetch?, platform?, arch?})`
- `start(toolId, options?: {acceptLicense?: boolean, androidPackages?: string[]}): ToolInstall` — 동기. 실제 작업은 백그라운드.
- `list()`, `cancel(id)`, `close()` — 종료 시 대기 중·진행 중 작업을 취소하고 끝날 때까지 기다립니다.

한 번에 하나만 설치합니다. 재시작 때 `queued`/`downloading`/`verifying`/`installing` 작업은 `failed`로 복구하고 `.stage`·`.downloads`·`.homes`를 지웁니다. 이미 활성화된 버전 폴더는 지우거나 덮어쓰지 않습니다. 설정 저장이 실패하면 작업은 실패하고 이전 `ToolSettings`가 유지됩니다.

성공 레이아웃 (`{root}/{toolId}/{version}/`, 불변):

| 도구 | 설정 키 | 경로 |
|---|---|---|
| Godot 4.7.2 편집기 | `godot` | OS별 실행 파일. Linux `Godot_v4.7.2-stable_linux.x86_64`, Windows `Godot_v4.7.2-stable_win64.exe`, macOS `Godot.app/Contents/MacOS/Godot` |
| Godot 템플릿 | `godotData` | `export_templates/4.7.2.stable/` 를 담은 데이터 루트. 엔진 검사는 이 형태를 요구합니다. |
| Eclipse Temurin 21.0.12.1+1 | `javaHome` | `bin/java`(또는 `java.exe`)가 있는 JDK 루트. Gradle·Android에 JDK 25는 너무 새 버전인 경우가 많습니다. |
| Android command-line tools 15859902 | `androidSdk` | `cmdline-tools/latest` 와 선택한 패키지. 라이선스 동의(`acceptLicense`)와 JDK가 필요합니다. 기본 패키지: `platform-tools`, `platforms;android-36`, `build-tools;36.0.0` |

Unity, Unreal, Xcode, SteamCMD는 라이선스·계정 설치가 필요합니다. 자동 설치 성공으로 표시하지 않으며 사용자가 공식 설치 후 경로를 연결합니다.

## 다운로드 규칙

`packages/setup/download.ts`는 카탈로그 URL만 받습니다. 사용자 입력 URL은 사용하지 않습니다.

- HTTPS, 포트 443, 정확한 공식 호스트만. GitHub 릴리스 자산과 `dl.google.com` 등 카탈로그에 적힌 호스트입니다.
- 리디렉션은 hop마다 다시 검사합니다. 로컬·IP·`file:`·HTTP·허용 목록 밖 호스트는 거절합니다.
- `.partial`에 스트리밍하고 바이트 한도를 적용합니다. SHA-256 또는 SHA-512가 카탈로그 핀과 다를 때 파일을 버리고 중단합니다.
- ZIP은 루트의 `extractZip`으로만 풉니다. tar.gz는 스트리밍 추출기로 풀며 심볼릭 링크·하드 링크·장치·경로 탈출을 거절합니다.
- 무결성을 검증한 Godot·JDK는 버전 명령을 실행해 확인합니다. Android `sdkmanager`는 검증된 command-line tools와 전용 `HOME`/`JAVA_HOME`/`ANDROID_*`/`TMP` 환경에서 Java 클래스패스로 호출합니다. 호스트 환경 변수·비밀은 상속하지 않습니다.

Godot 4.7.2 해시는 공식 `SHA512-SUMS.txt`에서 고정했습니다. Android command-line tools 15859902 SHA-256은 퍼블리셔 값입니다. Temurin 21.0.12.1+1 SHA-256은 Adoptium API/GitHub checksum 파일입니다. 설치 시 checksum 파일을 다시 받아 핀을 바꾸지 않습니다.

## Gradle 캐시

`gradle-cache`는 자동 설치하지 않습니다. 프로젝트 `gradlew`를 격리 없이 실행해 캐시를 채우지 않습니다.

제어 서비스가 맡아야 하는 통합:

1. 공식 Gradle 배포판(`-bin.zip`) URL과 SHA-256을 카탈로그에 핀합니다. 이 모듈은 그 해시를 만들지 않습니다.
2. `wrapper/dists/<배포판>/<해시>/` 와 `.ok` 표시, 빈 `dependency-cache/` 레이아웃을 전용 폴더에 기록합니다. 엔진은 `APPOPS_GRADLE_TOOLS_DIR`/`settings.gradleCache`에서 이 형태를 검사합니다.
3. 프로젝트 의존성 캐시는 신뢰된 네트워크에서 별도 준비합니다. 빌드 샌드박스 안에서 다운로드하지 않습니다.

## 라이선스

Android SDK 패키지는 `acceptLicense: true` 없이 시작되지 않습니다. Unity/Unreal/Xcode 동의·계정 로그인은 해당 공식 도구에서 사용자가 수행합니다. README나 탐지만으로 설치 성공을 표시하지 않습니다.

## 2026-09-23 설치·표시 수정

공식 Android macOS ARM64 command-line tools ZIP의 중첩 JAR/data descriptor를 스트리밍 ZIP 헤더 탐색기가 오인하던 문제를 수정했다. 중앙 디렉터리의 검증된 범위만 읽고, 로컬 헤더·범위 중첩·CRC·압축 및 해제 크기·deflate 소비량을 검사한다. 경로 탈출·링크·크기 제한은 유지한다.

화면은 `설치 제공`과 `감지 버전`을 구분하고, 경로를 저장하지 않아도 검사에 통과한 도구는 `자동 감지됨`으로 표시한다. 검사 실패 이유와 JDK 선행 조건을 표시하며 실행 파일 선택을 지원한다. macOS JDK 탐지는 `/usr/libexec/java_home`을 사용해 `/usr` 시스템 shim을 JDK 루트로 오인하지 않는다. Godot 설치는 `--version`까지 통과해야 성공하며 macOS 최초 실행 검사를 위해 30초를 허용한다.

Godot 4.7.2 공식 편집기·템플릿 핀과 Linux 러너 설치 스크립트를 함께 갱신했다. 기존 프로젝트·도구를 자동 업그레이드하지 않는다. 다른 엔진 버전이 필요한 프로젝트는 해당 편집기 및 같은 버전 템플릿 경로를 연결한다.

Windows JDK 레이아웃 검사는 `bin/java.exe`·`bin/javac.exe`를 사용한다. 해당 플랫폼의 실설치는 이번 macOS 검증에 포함하지 않았다.
