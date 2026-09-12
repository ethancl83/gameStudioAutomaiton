import type { EngineKind, Finding } from '../../packages/domain/index.js';
import { existsIn, isDirectory, joinRoot, readIfExists, readRootNames } from './fs.js';

export interface EngineMarker {
  engine: EngineKind;
  evidence: string;
  primary: boolean;
}

export interface Detection {
  engine: EngineKind;
  markers: EngineMarker[];
  findings: Finding[];
}

function finding(code: string, message: string, path?: string, fixHint?: string): Finding {
  return { code, severity: 'error', message, path, fixHint };
}

function warning(code: string, message: string, path?: string, fixHint?: string): Finding {
  return { code, severity: 'warning', message, path, fixHint };
}

async function rootHasSuffix(root: string, suffix: string): Promise<string | null> {
  const names = await readRootNames(root);
  const match = names.find((name) => name.endsWith(suffix));
  return match ?? null;
}

async function isUnityExportedGradle(root: string): Promise<{ hit: boolean; evidence: string | null }> {
  if (await isDirectory(joinRoot(root, 'unityLibrary'))) {
    return { hit: true, evidence: 'unityLibrary' };
  }
  const settings = (await readIfExists(root, 'settings.gradle'))
    ?? (await readIfExists(root, 'settings.gradle.kts'))
    ?? '';
  if (/\bunityLibrary\b/.test(settings) || /com\.unity3d/i.test(settings)) {
    return { hit: true, evidence: 'settings.gradle unityLibrary' };
  }
  const gradle = (await readIfExists(root, 'build.gradle'))
    ?? (await readIfExists(root, 'build.gradle.kts'))
    ?? (await readIfExists(root, 'app/build.gradle'))
    ?? (await readIfExists(root, 'app/build.gradle.kts'))
    ?? '';
  if (/com\.unity3d(?:\.player)?/i.test(gradle) || /UnityPlayerActivity/.test(gradle)) {
    return { hit: true, evidence: 'Unity Gradle plugin' };
  }
  if (await existsIn(root, 'assets/bin/Data')) {
    return { hit: true, evidence: 'assets/bin/Data' };
  }
  if (await existsIn(root, 'Unity-iPhone.xcodeproj')) {
    return { hit: true, evidence: 'Unity-iPhone.xcodeproj' };
  }
  if (await existsIn(root, 'Classes/UnityAppController.h')) {
    return { hit: true, evidence: 'Classes/UnityAppController.h' };
  }
  return { hit: false, evidence: null };
}

async function hasAndroidNativeMarkers(root: string): Promise<{ hit: boolean; evidence: string | null }> {
  const wrapper = (await existsIn(root, 'gradlew')) || (await existsIn(root, 'gradlew.bat'));
  const settings = (await existsIn(root, 'settings.gradle')) || (await existsIn(root, 'settings.gradle.kts'));
  const manifest =
    (await existsIn(root, 'app/src/main/AndroidManifest.xml'))
    || (await existsIn(root, 'src/main/AndroidManifest.xml'))
    || (await existsIn(root, 'AndroidManifest.xml'));
  const buildFile =
    (await existsIn(root, 'build.gradle'))
    || (await existsIn(root, 'build.gradle.kts'))
    || (await existsIn(root, 'app/build.gradle'))
    || (await existsIn(root, 'app/build.gradle.kts'));
  if (wrapper && (settings || buildFile) && manifest) {
    return { hit: true, evidence: wrapper ? 'gradlew' : 'Android Gradle' };
  }
  if (wrapper && (settings || buildFile)) {
    return { hit: true, evidence: 'Gradle wrapper' };
  }
  return { hit: false, evidence: null };
}

async function hasIosNativeMarkers(root: string): Promise<{ hit: boolean; evidence: string | null }> {
  const xcodeproj = await rootHasSuffix(root, '.xcodeproj');
  const xcworkspace = await rootHasSuffix(root, '.xcworkspace');
  if (xcodeproj === 'Unity-iPhone.xcodeproj' || xcworkspace === 'Unity-iPhone.xcworkspace') {
    return { hit: false, evidence: null };
  }
  if (xcodeproj) return { hit: true, evidence: xcodeproj };
  if (xcworkspace) return { hit: true, evidence: xcworkspace };
  return { hit: false, evidence: null };
}

async function listUproject(root: string): Promise<string[]> {
  const names = await readRootNames(root);
  return names.filter((name) => name.endsWith('.uproject'));
}

async function godotLooksLikeExportHost(root: string): Promise<boolean> {
  // Godot 커스텀 Android 빌드는 android/build 아래 Gradle을 둔다. 네이티브 Android로 보지 않는다.
  return (await existsIn(root, 'android/build/gradlew')) || (await existsIn(root, 'android/build/build.gradle'));
}

export async function detectEngine(root: string): Promise<Detection> {
  const markers: EngineMarker[] = [];
  const findings: Finding[] = [];

  if (await existsIn(root, 'project.godot')) {
    markers.push({ engine: 'godot', evidence: 'project.godot', primary: true });
  }

  if (await existsIn(root, 'ProjectSettings/ProjectVersion.txt')) {
    markers.push({ engine: 'unity', evidence: 'ProjectSettings/ProjectVersion.txt', primary: true });
  } else if (await existsIn(root, 'ProjectSettings/ProjectSettings.asset')) {
    markers.push({ engine: 'unity', evidence: 'ProjectSettings/ProjectSettings.asset', primary: true });
  }

  const uprojects = await listUproject(root);
  for (const file of uprojects) {
    markers.push({ engine: 'unreal', evidence: file, primary: true });
  }

  const unityExport = await isUnityExportedGradle(root);
  if (unityExport.hit && !markers.some((m) => m.engine === 'unity')) {
    markers.push({
      engine: 'unity',
      evidence: unityExport.evidence ?? 'Unity export',
      primary: false,
    });
    findings.push(warning(
      'unity.exported_project',
      'Unity 에디터 프로젝트가 아니라 내보낸 Gradle/Xcode 결과로 보입니다. 원본 Unity 프로젝트 폴더를 등록하세요.',
      unityExport.evidence ?? undefined,
      'ProjectSettings/ProjectVersion.txt 가 있는 Unity 프로젝트 루트를 선택하세요.',
    ));
  }

  const hostedByEngine = markers.some((m) => m.engine === 'godot' || m.engine === 'unity' || m.engine === 'unreal');
  // Unity/Godot/Unreal 루트에 있는 Gradle·Xcode는 엔진 내보내기이므로 네이티브로 분류하지 않는다.
  if (!hostedByEngine) {
    const android = await hasAndroidNativeMarkers(root);
    if (android.hit) {
      markers.push({ engine: 'android', evidence: android.evidence ?? 'Gradle', primary: true });
    }
    const ios = await hasIosNativeMarkers(root);
    if (ios.hit) {
      markers.push({ engine: 'ios', evidence: ios.evidence ?? 'Xcode', primary: true });
    }
  } else if (await godotLooksLikeExportHost(root)) {
    findings.push(warning(
      'godot.android_export_template',
      'Godot 프로젝트 안의 Android Gradle 템플릿은 네이티브 Android 프로젝트가 아닙니다.',
      'android/build',
    ));
  }

  // 엔진 프로젝트가 아닌데 Android+iOS 마커가 같이 있으면 충돌로 기록한다.
  const primaryKinds = [...new Set(markers.filter((m) => m.primary).map((m) => m.engine))];
  const allKinds = [...new Set(markers.map((m) => m.engine))];

  let engine: EngineKind = 'unknown';
  const priority: EngineKind[] = ['godot', 'unity', 'unreal', 'android', 'ios'];
  for (const kind of priority) {
    if (allKinds.includes(kind)) {
      engine = kind;
      break;
    }
  }

  if (primaryKinds.length > 1) {
    findings.push(finding(
      'detect.conflict',
      `같은 폴더에서 여러 프로젝트 유형이 탐지되었습니다: ${primaryKinds.join(', ')}. ${engine} 을(를) 우선합니다.`,
      root,
      '엔진 프로젝트 루트만 선택하세요. Unity가 내보낸 Gradle은 네이티브 Android로 등록하지 마세요.',
    ));
  } else if (engine === 'unknown') {
    findings.push(finding(
      'detect.unknown',
      'Godot, Unity, Unreal, 네이티브 Android, 네이티브 iOS 프로젝트 파일을 찾지 못했습니다.',
      root,
      'project.godot, ProjectSettings/ProjectVersion.txt, .uproject, Gradle wrapper, 또는 Xcode 프로젝트가 있는 폴더를 선택하세요.',
    ));
  }

  return { engine, markers, findings };
}
