# 설치 관리자 계약

Last Updated: 2026-09-11

`packages/setup/installer.ts`는 카탈로그에 고정된 공식 아티팩트만 설치합니다. 프로젝트 소스·엔진 설정을 바꾸지 않습니다. 다운로드·tar/zip 파서는 `download.ts`/`archive.ts`(root)가 담당합니다.

## 다운로드

`downloadVerified`는 카탈로그 HTTPS URL만 받습니다. 호스트 허용 목록은 리디렉션마다 다시 적용됩니다. 주소의 인증 정보·비-443 포트·IP/localhost는 거절합니다.

Node `fetch`는 기본 `Accept-Encoding: gzip`을 보내고 본문을 자동 해제합니다. Google `dl.google.com`은 이 경우 `Content-Length`에 **압축 크기**를, `x-identity-content-length`에 원본 ZIP 크기를 넣습니다. 예전 코드는 수신 바이트를 `Content-Length`와 비교해 완전한 ZIP을 “중간에 잘렸습니다”로 오인했습니다. 지금은 `Accept-Encoding: identity`를 요청하고, gzip 응답이면 디코드된 길이를 `x-identity-content-length`와 대조합니다.

일시적 끊김은 최대 4회로 제한합니다. 이어서 받으려면 강한 ETag/`Last-Modified`의 `If-Range`와 `206` `Content-Range`가 오프셋과 일치해야 합니다. `200`은 이어받지 않고 처음부터 다시 받습니다. 다이제스트가 카탈로그와 다를 때만 목적지로 이름을 바꿉니다. 실패·취소는 `.partial`을 지우거나 `.partial.invalid`로 격리하며 설치 완료로 표시하지 않습니다.

## Google Play 대상 API (2026-09-11)

공식 규칙: [Meet Google Play's target API level requirement](https://developer.android.com/google/play/requirements/target-sdk).

| 구분 | API | 적용 |
|---|---|---|
| 새 앱·업데이트 (전화/태블릿/Android Auto) | **36** | 2026-08-31부터 제출 |
| 기존 앱, 신규 사용자 검색 | **35** | 미충족 시 더 높은 OS의 신규 사용자에게 숨김 |
| Wear OS·Android Automotive | 35 | 제출 하한 |
| Android TV·Android XR | 34 | 제출 하한 |
| 연장 | 2026-11-01 | Play Console에서 요청 |

기본 설치 집합은 전화/태블릿 제출 하한인 API 36입니다. API 34·35는 카탈로그에 남아 있으며 **명시적으로 요청해야** 설치됩니다. 설치기는 프로젝트 `compileSdk`/`targetSdk`를 올리지 않고, Godot 4.3 등이 API 36을 지원한다고 단정하지 않습니다.

## 카탈로그 버전과 레이아웃

| 도구 | 기대 버전 | 레이아웃 |
|---|---|---|
| Godot | `4.3` | 플랫폼별 편집기 실행 파일 |
| Godot 템플릿 | `4.3` | `export_templates/4.3.stable/` |
| Temurin JDK | `21.0.12.1` (`java`·`javac -version`, `release` JAVA_VERSION) | `bin/java`, `bin/javac` |
| Android command-line tools | `15859902` | `cmdline-tools/latest/lib` |

Android 구성 요소 리비전은 `repository2-1.xml`(2026-09-11). 없는 이름은 거절합니다.

| 패키지 | `Pkg.Revision` | 기본 설치 |
|---|---|---|
| `platform-tools` | `37.0.1` | 예 |
| `platforms;android-36` | `2` | 예 |
| `build-tools;36.0.0` | `36.0.0` | 예 |
| `build-tools;36.1.0` | `36.1.0` | 아니오 (명시) |
| `platforms;android-35` | `2` | 아니오 (명시) |
| `platforms;android-34` | `3` | 아니오 (명시) |
| `build-tools;35.0.0` / `34.0.0` | 동일 문자열 | 아니오 (명시) |
| `ndk;27.3.13750724` / `ndk;28.2.13676358` | 패키지 id와 동일 | 아니오 (명시) |
| `cmake;3.22.1` / `3.31.6` / `4.1.2` | 패키지 id와 동일 | 아니오 (명시) |

NDK·CMake는 `latest`가 없습니다. 핀된 id만 설치합니다. 기본 집합에 넣지 않습니다.

JDK tar.gz는 `extractTarGz(..., signal, {materializeInternalLinks: true})`로 풉니다. 설치 후 `validatedJavaHome` / `validatedAndroidSdk`(root toolchain)로 실행을 한 번 더 확인합니다.

## 라이선스 영수증과 원자적 확장

`acceptLicense: true` 없이 Android 설치를 시작하지 않습니다. `--licenses`에 `y`를 반복 입력하지 않습니다. 요청한 패키지의 `android-sdk-license` 해시만 기록합니다.

성공 시 SDK 루트 `.appops-receipt.json`에 라이선스 ID·해시·패키지 리비전만 남깁니다. 비밀은 넣지 않습니다.

추가 설치는 이전 폴더를 덮어쓰지 않고 패키지 집합 경로로 복사한 뒤 스테이징에서만 sdkmanager를 실행합니다. 실패·취소 시 이전 `ToolSettings.androidSdk`가 유지됩니다.

## 프로세스 취소

`runIsolated`는 `shell: false`, POSIX 프로세스 그룹 종료, Windows `taskkill /T /F`. 중단 시 `close`를 기다리지 않습니다. `close()`는 5초 상한입니다.

## 실제 설치 vs 픽스처

단위 테스트(`tests/setup-install.test.ts`)는 zip/스크립트 픽스처입니다. 실제 설치 증거(2026-09-11):

| 항목 | 결과 |
|---|---|
| Temurin 21.0.12.1+1 | **실제.** 캐시 tarball SHA-256이 카탈로그와 일치. `ToolInstaller`가 `/tmp/appops-real-jdk/tools`에 설치. `java`/`javac`가 `21.0.12.1` 출력 |
| command-line tools zip | Node `fetch`+gzip `Content-Length` 오인은 `download.ts`에서 수정. 실제 `downloadVerified` 증거: `/tmp/appops-download-verified-cmdline.json` |
| sdkmanager 패키지 | **실제 네트워크.** `platforms;android-36` r2 (`android.jar` 27,768,026바이트), `build-tools;36.0.0`, `platform-tools` 37.0.1. `adb version` / `aapt2 version` 실행 성공 |
| 영수증 | `.appops-receipt.json`에 `android-sdk-license` 해시와 패키지 리비전 |
| 취소 | 추가 설치 취소 후 이전 SDK 경로 유지 |
| 전역 환경 | `JAVA_HOME`/`ANDROID_HOME`/`ANDROID_SDK_ROOT` 미설정 |

요약 파일: `/tmp/appops-setup-real-result.json`. sudo·계정 로그인·스토어 게시 없음.

이전 잔여(gzip `Content-Length` 오인)는 `download.ts`에서 수정했습니다. 실제 `downloadVerified` 결과는 `/tmp/appops-download-verified-cmdline.json`을 봅니다.
