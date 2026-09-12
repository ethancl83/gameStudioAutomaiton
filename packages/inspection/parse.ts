import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { BuildTarget, Finding } from '../../packages/domain/index.js';
import { existsIn, readIfExists, readRootNames } from './fs.js';
import type { Detection } from './detect.js';

export interface ParsedProject {
  name: string;
  engineVersion: string | null;
  appIdentifier: string | null;
  targets: BuildTarget[];
  findings: Finding[];
}

function info(code: string, message: string, path?: string, fixHint?: string): Finding {
  return { code, severity: 'info', message, path, fixHint };
}

function errorFinding(code: string, message: string, path?: string, fixHint?: string): Finding {
  return { code, severity: 'error', message, path, fixHint };
}

function warning(code: string, message: string, path?: string, fixHint?: string): Finding {
  return { code, severity: 'warning', message, path, fixHint };
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const m = text.match(pattern);
  return m?.[1]?.trim() || null;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}

export interface GodotPreset {
  name: string;
  platform: string;
  identifier: string | null;
  /** Android only: 'aab' when gradle_build/export_format selects an app bundle. */
  androidFormat: 'apk' | 'aab' | null;
}

export function parseGodotPresets(text: string): GodotPreset[] {
  const presets: GodotPreset[] = [];
  const blocks = text.split(/\[preset\.\d+\]/g).slice(1);
  const optionBlocks = text.split(/\[preset\.\d+\.options\]/g).slice(1);
  for (let i = 0; i < blocks.length; i++) {
    const head = blocks[i].split(/\[preset\.\d+\.options\]/)[0];
    const options = optionBlocks[i] ?? '';
    const name = firstMatch(head, /^name\s*=\s*"([^"]+)"/m) ?? `preset-${i}`;
    const platform = firstMatch(head, /^platform\s*=\s*"([^"]+)"/m) ?? '';
    const identifier =
      firstMatch(options, /^package\/unique_name\s*=\s*"([^"]+)"/m)
      ?? firstMatch(options, /^application\/bundle_identifier\s*=\s*"([^"]+)"/m)
      ?? firstMatch(options, /^application\/identifier\s*=\s*"([^"]+)"/m)
      ?? null;
    // Godot 4 Android presets: gradle_build/export_format 0 = APK, 1 = AAB.
    const exportFormat = firstMatch(options, /^gradle_build\/export_format\s*=\s*(\d+)/m);
    const androidFormat: 'apk' | 'aab' | null = /android/i.test(platform)
      ? (exportFormat === '1' ? 'aab' : 'apk')
      : null;
    presets.push({ name, platform, identifier, androidFormat });
  }
  return presets;
}

export function targetsFromGodotPlatform(platform: string): BuildTarget[] {
  const p = platform.toLowerCase();
  if (p.includes('android')) return ['android'];
  if (p.includes('ios') || p.includes('iphone')) return ['ios'];
  if (p.includes('win')) return ['windows'];
  if (p.includes('mac') || p.includes('osx') || p.includes('darwin')) return ['macos'];
  if (p.includes('linux') || p.includes('x11') || p.includes('bsd')) return ['linux'];
  return [];
}

async function parseGodot(root: string, fallbackName: string): Promise<ParsedProject> {
  const findings: Finding[] = [];
  const project = (await readIfExists(root, 'project.godot')) ?? '';
  const name =
    firstMatch(project, /^config\/name\s*=\s*"([^"]+)"/m)
    ?? fallbackName;
  const features = firstMatch(project, /config\/features\s*=\s*PackedStringArray\((.*)\)/m);
  let engineVersion: string | null = null;
  if (features) {
    const versions = [...features.matchAll(/"(\d+\.\d+(?:\.\d+)?)"/g)].map((m) => m[1]);
    engineVersion = versions[0] ?? null;
  }
  if (!engineVersion) {
    const configVersion = firstMatch(project, /^config_version\s*=\s*(\d+)/m);
    if (configVersion === '5') engineVersion = '4';
    else if (configVersion === '4') engineVersion = '3';
  }
  const presetsText = await readIfExists(root, 'export_presets.cfg');
  const targets = new Set<BuildTarget>();
  let appIdentifier: string | null = null;
  if (!presetsText) {
    findings.push(errorFinding(
      'godot.missing_export_presets',
      'export_presets.cfg 가 없어 내보낼 대상과 앱 식별자를 확인할 수 없습니다.',
      'export_presets.cfg',
      'Godot 편집기에서 내보내기 프리셋을 만들고 export_presets.cfg 를 프로젝트에 저장하세요.',
    ));
  } else {
    const presets = parseGodotPresets(presetsText);
    if (presets.length === 0) {
      findings.push(errorFinding(
        'godot.empty_export_presets',
        'export_presets.cfg 에 프리셋이 없습니다.',
        'export_presets.cfg',
      ));
    }
    for (const preset of presets) {
      for (const t of targetsFromGodotPlatform(preset.platform)) targets.add(t);
      if (!appIdentifier && preset.identifier && !preset.identifier.includes('$')) {
        appIdentifier = preset.identifier;
      }
    }
  }
  if (!appIdentifier) {
    findings.push(warning(
      'godot.missing_app_id',
      '앱 식별자(패키지 이름/번들 ID)를 찾지 못했습니다.',
      'export_presets.cfg',
      'Android package/unique_name 또는 iOS application/bundle_identifier 를 프리셋에 설정하세요.',
    ));
  }
  if (!engineVersion) {
    findings.push(info('godot.unknown_version', 'Godot 엔진 버전을 project.godot 에서 읽지 못했습니다.', 'project.godot'));
  }
  return { name, engineVersion, appIdentifier, targets: [...targets], findings };
}

function parseUnityAppId(settings: string): string | null {
  const block = settings.match(/applicationIdentifier:\s*\n((?:\s+\S.+\n)+)/);
  if (block) {
    const ids = [...block[1].matchAll(/:\s*(\S+)/g)].map((m) => unquote(m[1]));
    const usable = ids.find((id) => id.includes('.'));
    if (usable) return usable;
  }
  const single = firstMatch(settings, /^applicationIdentifier:\s*(\S+)/m);
  if (single && single !== '' && !single.startsWith('|') && single !== '{}') return unquote(single);
  return firstMatch(settings, /AndroidBundleIdentifier:\s*(\S+)/)
    ?? firstMatch(settings, /iPhoneBundleIdentifier:\s*(\S+)/);
}

async function parseUnity(root: string, fallbackName: string): Promise<ParsedProject> {
  const findings: Finding[] = [];
  const versionText = await readIfExists(root, 'ProjectSettings/ProjectVersion.txt');
  const engineVersion = versionText
    ? firstMatch(versionText, /m_EditorVersion:\s*(\S+)/)
    : null;
  if (!versionText) {
    findings.push(errorFinding(
      'unity.missing_project_version',
      'ProjectSettings/ProjectVersion.txt 가 없습니다. Unity 에디터 버전을 확인할 수 없습니다.',
      'ProjectSettings/ProjectVersion.txt',
    ));
  }
  const settings = (await readIfExists(root, 'ProjectSettings/ProjectSettings.asset')) ?? '';
  const name = firstMatch(settings, /^ {2}productName:\s*(.+)$/m)?.trim() || fallbackName;
  const appIdentifier = settings ? parseUnityAppId(settings) : null;
  if (!appIdentifier) {
    findings.push(warning(
      'unity.missing_app_id',
      'applicationIdentifier 를 ProjectSettings 에서 찾지 못했습니다.',
      'ProjectSettings/ProjectSettings.asset',
    ));
  }
  const targets: BuildTarget[] = [];
  if (await existsIn(root, 'ProjectSettings/EditorBuildSettings.asset')) {
    const buildSettings = await readIfExists(root, 'ProjectSettings/EditorBuildSettings.asset');
    if (buildSettings && /Android/.test(buildSettings)) targets.push('android');
  }
  // Unity 프로젝트는 설치된 모듈에 따라 타깃이 달라 폴더만으로 확정하지 않는다.
  if (targets.length === 0) {
    findings.push(info(
      'unity.targets_unspecified',
      '에디터 빌드 타깃이 프로젝트 파일에 고정되어 있지 않습니다. 빌드 시 대상 플랫폼을 지정하세요.',
      'ProjectSettings',
    ));
  }
  if (!(await existsIn(root, 'Packages/manifest.json')) && !(await existsIn(root, 'Assets'))) {
    findings.push(errorFinding(
      'unity.missing_assets',
      'Assets 또는 Packages/manifest.json 이 없습니다.',
      root,
    ));
  }
  return { name, engineVersion, appIdentifier, targets, findings };
}

async function parseUnreal(root: string, fallbackName: string): Promise<ParsedProject> {
  const findings: Finding[] = [];
  const names = await readRootNames(root);
  const uprojectName = names.find((n) => n.endsWith('.uproject'));
  if (!uprojectName) {
    return {
      name: fallbackName,
      engineVersion: null,
      appIdentifier: null,
      targets: [],
      findings: [errorFinding('unreal.missing_uproject', '.uproject 파일을 찾지 못했습니다.', root)],
    };
  }
  const raw = await readIfExists(root, uprojectName);
  let engineVersion: string | null = null;
  let name = fallbackName;
  if (raw) {
    try {
      const json = JSON.parse(raw) as { EngineAssociation?: string; Description?: string };
      engineVersion = json.EngineAssociation ? String(json.EngineAssociation).replace(/^"+|"+$/g, '') : null;
    } catch {
      findings.push(errorFinding('unreal.invalid_uproject', '.uproject 파일이 JSON이 아닙니다.', uprojectName));
    }
    name = basename(uprojectName, '.uproject');
  }
  const engineIni = (await readIfExists(root, 'Config/DefaultEngine.ini')) ?? '';
  const appIdentifier =
    firstMatch(engineIni, /^PackageName\s*=\s*(\S+)/m)
    ?? firstMatch(engineIni, /^BundleIdentifier\s*=\s*(\S+)/m)
    ?? null;
  if (!appIdentifier) {
    findings.push(warning(
      'unreal.missing_app_id',
      'Android PackageName 또는 iOS BundleIdentifier 를 Config/DefaultEngine.ini 에서 찾지 못했습니다.',
      'Config/DefaultEngine.ini',
    ));
  }
  if (!(await existsIn(root, 'Content')) && !(await existsIn(root, 'Source'))) {
    findings.push(errorFinding(
      'unreal.missing_content',
      'Content 또는 Source 디렉터리가 없습니다.',
      root,
    ));
  }
  return { name, engineVersion, appIdentifier, targets: [], findings };
}

function parseGradleAppId(text: string): string | null {
  return firstMatch(text, /applicationId\s*=\s*["']([^"']+)["']/)
    ?? firstMatch(text, /applicationId\s+["']([^"']+)["']/)
    ?? firstMatch(text, /namespace\s*=\s*["']([^"']+)["']/)
    ?? firstMatch(text, /namespace\s+["']([^"']+)["']/);
}

async function parseAndroid(root: string, fallbackName: string): Promise<ParsedProject> {
  const findings: Finding[] = [];
  if (!(await existsIn(root, 'gradlew')) && !(await existsIn(root, 'gradlew.bat'))) {
    findings.push(errorFinding(
      'android.missing_wrapper',
      'Gradle Wrapper(gradlew)가 없습니다. 공식 Android 명령줄 빌드는 Wrapper를 사용합니다.',
      'gradlew',
      'Android Studio에서 Gradle Wrapper를 생성하세요.',
    ));
  }
  const gradle =
    (await readIfExists(root, 'app/build.gradle.kts'))
    ?? (await readIfExists(root, 'app/build.gradle'))
    ?? (await readIfExists(root, 'build.gradle.kts'))
    ?? (await readIfExists(root, 'build.gradle'))
    ?? '';
  const manifest =
    (await readIfExists(root, 'app/src/main/AndroidManifest.xml'))
    ?? (await readIfExists(root, 'src/main/AndroidManifest.xml'))
    ?? (await readIfExists(root, 'AndroidManifest.xml'))
    ?? '';
  const appIdentifier =
    parseGradleAppId(gradle)
    ?? firstMatch(manifest, /package="([^"]+)"/)
    ?? null;
  if (!appIdentifier) {
    findings.push(errorFinding(
      'android.missing_app_id',
      'applicationId 또는 Manifest package 를 찾지 못했습니다.',
      'app/build.gradle',
    ));
  }
  if (!manifest) {
    findings.push(errorFinding(
      'android.missing_manifest',
      'AndroidManifest.xml 을 찾지 못했습니다.',
      'app/src/main/AndroidManifest.xml',
    ));
  }
  const name =
    firstMatch(manifest, /android:label="([^"]+)"/)
    ?? fallbackName;
  return { name, engineVersion: null, appIdentifier, targets: ['android'], findings };
}

async function parseIos(root: string, fallbackName: string): Promise<ParsedProject> {
  const findings: Finding[] = [];
  const names = await readRootNames(root);
  const xcodeproj = names.find((n) => n.endsWith('.xcodeproj'));
  const xcworkspace = names.find((n) => n.endsWith('.xcworkspace'));
  if (!xcodeproj && !xcworkspace) {
    findings.push(errorFinding('ios.missing_xcode', '.xcodeproj 또는 .xcworkspace 가 없습니다.', root));
  }
  let appIdentifier: string | null = null;
  if (xcodeproj) {
    const pbx = await readIfExists(root, join(xcodeproj, 'project.pbxproj'));
    if (pbx) {
      appIdentifier = firstMatch(pbx, /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/);
      if (appIdentifier) {
        appIdentifier = unquote(appIdentifier.replace(/BuildSettings.*$/, '').trim());
        if (appIdentifier.includes('$')) appIdentifier = null;
      }
    } else {
      findings.push(errorFinding('ios.missing_pbxproj', 'project.pbxproj 를 읽지 못했습니다.', join(xcodeproj, 'project.pbxproj')));
    }
  }
  let schemeCount = 0;
  if (xcodeproj) {
    const schemeDir = join(root, xcodeproj, 'xcshareddata/xcschemes');
    try {
      const schemes = (await readdir(schemeDir)).filter((n) => n.endsWith('.xcscheme'));
      schemeCount = schemes.length;
    } catch {
      schemeCount = 0;
    }
  }
  if (schemeCount === 0 && xcworkspace) {
    const schemeDir = join(root, xcworkspace, 'xcshareddata/xcschemes');
    try {
      const schemes = (await readdir(schemeDir)).filter((n) => n.endsWith('.xcscheme'));
      schemeCount = schemes.length;
    } catch {
      schemeCount = 0;
    }
  }
  if (schemeCount === 0) {
    findings.push(warning(
      'ios.missing_scheme',
      '공유 스킴(.xcscheme)을 찾지 못했습니다. 빌드 시 scheme 을 지정해야 합니다.',
      xcodeproj ?? xcworkspace,
      'Xcode에서 Product > Scheme > Manage Schemes 로 스킴을 공유하세요.',
    ));
  }
  if (!appIdentifier) {
    findings.push(warning('ios.missing_app_id', 'PRODUCT_BUNDLE_IDENTIFIER 를 찾지 못했습니다.', xcodeproj));
  }
  if (process.platform !== 'darwin') {
    findings.push(errorFinding(
      'ios.requires_macos',
      'iOS 아카이브와 서명은 macOS의 Xcode가 필요합니다. 현재 실행 환경에서는 수행할 수 없습니다.',
      undefined,
      'macOS 러너를 연결하세요.',
    ));
  }
  return {
    name: xcodeproj ? basename(xcodeproj, '.xcodeproj') : fallbackName,
    engineVersion: null,
    appIdentifier,
    targets: ['ios'],
    findings,
  };
}

export async function parseProject(root: string, detection: Detection, fallbackName: string): Promise<ParsedProject> {
  switch (detection.engine) {
    case 'godot':
      return parseGodot(root, fallbackName);
    case 'unity':
      return parseUnity(root, fallbackName);
    case 'unreal':
      return parseUnreal(root, fallbackName);
    case 'android':
      return parseAndroid(root, fallbackName);
    case 'ios':
      return parseIos(root, fallbackName);
    default:
      return {
        name: fallbackName,
        engineVersion: null,
        appIdentifier: null,
        targets: [],
        findings: [],
      };
  }
}
