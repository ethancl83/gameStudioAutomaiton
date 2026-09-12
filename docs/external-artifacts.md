# 외부 빌드 결과물로 배포

Last Updated: 2026-09-12

[작업 목록](../dev/active/app-operations-platform/app-operations-platform-tasks.md) · [검증](verification-assets/operational-fixes-20260912.md) · [복구 계약](workflow-contract.md)

스토어 배포 화면에서 프로젝트를 선택하고 **출시 시작 → 타깃·스토어 선택 → 결과물 가져오기 → 출시 시작**으로 진행한다. 엔진·SDK 설치, 원본 프로젝트 검수, 내부 빌드를 실행하지 않는다. 프로젝트 정책에서 해당 계정과 배포를 허용해야 한다. 기존 내부 빌드 이력 업로드 API는 호환성을 위해 유지한다.

| 대상 | 가져올 항목 | 확인 내용 |
|---|---|---|
| Google Play | 배포용 AAB 또는 APK | manifest의 패키지·버전 코드·버전, 서명 정보 포함 여부 |
| App Store | 배포용 IPA | Info.plist의 bundle ID·버전, 서명 자료·프로비저닝 프로파일 포함 여부 |
| Steam | Windows·macOS·Linux 콘텐츠 폴더 | 파일 구성·크기·해시, 실행 권한 보존 |

원본을 수정하지 않고 앱 데이터의 `artifacts/import-<uuid>/`에 복사한다. 가져온 결과물은 프로젝트에 귀속되며 업로드 직전에 대상 스토어·앱 식별자·크기·SHA-256을 다시 확인한다. 파일의 서명 정보가 존재하는지 확인하는 검사이며 인증서 신뢰와 스토어 서명 적합성은 스토어가 최종 검증한다. 별도 서명 도구 설치를 요구하지 않는다.

Steam 폴더 내부의 정상 링크는 실제 파일로 복사한다. 폴더 밖으로 향하는 링크·순환 링크·특수 파일·인증 파일·운영 데이터 경로는 거부한다. 결과물 상한은 512 GiB, 파일/폴더 방문 수 20만 개다. 복사 도중 변경된 파일, 다른 프로젝트의 결과물, 가져온 뒤 변조된 파일은 업로드하지 않는다. 원본 파일을 삭제해도 보관한 복사본은 재시작·전체 백업 복원 뒤 사용할 수 있다.

API: `POST /api/projects/:id/artifacts`에 `{path,target}`를 보내 결과물 ID를 얻는다. `POST /api/projects/:id/publish`에는 `importedArtifactId`, `target`, `connectionId`, `track`, `idempotencyKey`를 전달한다. 직접 작업 API의 `upload-build`도 `input.importedArtifactId`를 받는다. `buildRunId`와 동시에 지정할 수 없다. 업로드 작업에 임의 파일 경로를 직접 전달하는 방식은 허용하지 않는다.

데모에서는 실제 경로를 읽지 않고 합성 결과물을 만든다. macOS App Store PKG 업로드는 기존과 같이 미지원이며, macOS 콘텐츠 폴더는 Steam 대상이다. 업로드 성공·심사 접수·실제 공개는 별개 상태다.

Android manifest 파서는 [AAPT2 Resources.proto](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/tools/aapt2/Resources.proto)와 [Android ResourceTypes.h](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/libs/androidfw/include/androidfw/ResourceTypes.h)를 기준으로 구현했다. APK 서명 블록의 구조는 [공식 서명 문서](https://source.android.com/docs/security/features/apksigning/v2)를 따른다.
