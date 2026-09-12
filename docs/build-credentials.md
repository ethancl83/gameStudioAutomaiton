# 빌드 키 관리

확인일: 2026-09-11. [계획 v2 R-11](../dev/active/app-operations-platform/app-operations-platform-plan-v2.md) · [작업 T-10](../dev/active/app-operations-platform/app-operations-platform-tasks.md) · [인증 보관함](credential-lifecycle.md) · [빌드 지원표](build-support.md).

설정의 **빌드 키**에서 SSH 개인 키 또는 Android 키스토어를 등록하고, 프로젝트의 **빌드 보안**에서 연결한다. 파일은 1 MiB 이하이며 로컬 제어 서비스로 전달한다. 화면·DB·이력에는 이름, 종류, 버전, 지문, 공개 키와 공개 설정만 반환한다. 기존 개인 키·암호를 조회하는 API는 없다.

| 종류 | 최초 입력 | 사용 |
|---|---|---|
| SSH | 개인 키, 선택적 passphrase, host/port/user, 사전에 확인한 known_hosts | 지정한 ssh:// 저장소의 브랜치/태그를 가져와 프로젝트의 새 상대 폴더에 삽입 |
| Android | JKS/PKCS12 파일, storePassword, keyAlias, 선택적 keyPassword | 빌드 이후 AAB/JAR 또는 APK 서명과 인증서 지문 확인 |

Git/서버 접근용 SSH 키와 Android 앱 서명 키스토어는 별개의 자격 증명이다. Android 키를 SSH 키로 사용하지 않는다. SSH는 등록한 서버·포트·사용자와 같은 주소만 허용하고 서버 공개 키를 확인한다. 인증 에이전트·호스트 SSH 설정·프록시·비밀번호 인증·서브모듈 자동 가져오기를 사용하지 않는다. 기존 프로젝트 파일을 의존성 파일로 덮어쓰지 않는다. 브랜치/태그가 실제 가리킨 커밋과 의존성 스냅샷 해시를 이력에 기록한다.

비밀은 OS 보관함의 마스터키와 기존 AES-GCM vault에 저장한다. 교체할 때 새 암호문 버전을 먼저 기록하고 메타데이터를 갱신한다. 이미 예약한 빌드는 캡처한 버전·지문을 유지한다. 프로젝트 또는 진행 중인 빌드가 사용하는 키의 삭제는 차단한다. 삭제가 허용되면 이전 암호문 버전도 함께 제거한다. 삭제한 키가 필요한 옛 빌드를 재현하려면 해당 키가 다시 필요하다.

메타데이터와 등록/교체 이력은 하나의 DB 트랜잭션으로 저장한다. 저장 실패 때 새 암호문 버전을 되돌리고, 프로세스가 중간에 종료되거나 정리 자체가 실패하면 재시작 때 미등록 버전을 찾아 제거한다. 삭제도 메타데이터의 마지막 버전뿐 아니라 해당 키의 보관된 버전 ID 전체를 확인한다. 테스트에서 DB 이벤트 저장 실패와 보상 삭제 실패를 주입해 기존 버전 보존·재시작 정리를 확인했다.

현재 키 사용 러너는 Linux tmpfs(`/dev/shm`)와 bubblewrap이 필요하다. 비밀 임시 폴더는 0700, 파일은 0600이다. 정상 종료·실패·취소 후 제거하며 재시작 시 해당 제어 서비스 namespace의 남은 임시 폴더를 정리한다. 키가 필요한 Git/서명 도구와 프로젝트 코드를 실행하는 엔진은 서로 다른 격리 프로세스에서 동작한다. 엔진에는 키·암호·SSH 에이전트를 전달하지 않는다. 키 도구 오류는 원문 stderr 대신 비밀 없는 오류 코드를 표시한다.

Android 등록 때 keytool로 인증서를 읽고 작은 테스트 JAR을 서명해 개인 키와 암호를 검증한다. AAB는 jarsigner 후 인증서를 확인한다. APK는 zipalign을 먼저 실행하고 apksigner로 서명·검증한다. 암호는 명령행 문자열이나 환경 변수로 전달하지 않고 제한된 파일의 경로로 전달한다. [Android apksigner](https://developer.android.com/tools/apksigner), [Oracle jarsigner](https://docs.oracle.com/en/java/javase/24/docs/specs/man/jarsigner.html).

현재 Android 키는 Google Play 배포용으로 검증한다. 인증서가 현재 유효하고 2033년 10월 22일 이후까지 유효해야 한다. 등록 때와 실제 서명 직전에 모두 검사한다. AAB 검증은 선택한 키스토어·별칭을 지정한 `jarsigner -verify -strict`로 수행해 서명 용도 오류·미서명 항목·다른 별칭 등을 거부한다. 자체 서명 인증서는 선택한 키스토어에서 신뢰하므로 정상 Android 키를 불필요하게 거부하지 않는다. 생성한 미래 시작·30일 만료·잘못된 KeyUsage 인증서의 거부도 확인했다. [Android 앱 서명 조건](https://developer.android.com/studio/publish/app-signing).

JDK는 `APPOPS_JAVA_HOME`/`JAVA_HOME` 또는 `/usr/bin`에서 확인한다. APK는 `APPOPS_ANDROID_SDK_ROOT`/`ANDROID_SDK_ROOT`/`ANDROID_HOME` 아래 build-tools의 apksigner·zipalign이 필요하다. 엔진이 생성한 결과물은 후속 서명이 가능한 형태여야 한다. 기존 프로젝트 자체 서명 설정에 비밀을 자동 삽입하지 않는다. 다른 키로 이미 서명된 결과물은 선택한 서명과 일치하지 않으면 거부한다. macOS/iOS 프로비저닝·Windows 서명·원격 러너 키 전송은 후속 작업으로 남아 있다.

`tests/build-credentials.test.ts`는 실제 생성한 암호화 RSA SSH 키·P12와 실제 ssh-keygen/keytool/jarsigner/bwrap으로 등록·틀린 암호·회전·사용 중 삭제·서명·정리를 확인한다. AAB 검증 입력은 서명 경계를 검증하는 JAR이며 설치 가능한 Android 앱이나 실기기 실행을 증명하지 않는다. SSH 서버 키와 Git 옵션의 근거는 [OpenSSH 설정](https://man.openbsd.org/ssh_config), [Git clone](https://git-scm.com/docs/git-clone)이다.

`tests/ssh-dependency.test.ts`는 생성한 키와 loopback SSH 서버(개발 전용 ssh2)로 실제 OpenSSH 인증·Git clone·커밋 확인·스냅샷 변환을 검사한다. 바뀐 서버 키는 인증 전에 차단하고 `.env`·`.git`은 빌드 입력에서 제외한다. 외부 저장소나 사용자 키를 사용하지 않았다.
