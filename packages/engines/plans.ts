import { basename, dirname, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type {
  BuildOptions,
  BuildPlan,
  BuildTarget,
  CommandSpec,
  Finding,
  ProjectInspection,
} from '../../packages/domain/index.js';
import { parseGodotPresets, targetsFromGodotPlatform } from '../inspection/index.js';
import { readIfExists, existsIn, pathExists } from '../inspection/fs.js';
import {
  findGodot,
  findUnity,
  findUnrealUat,
  godotDataDir,
  gradleToolsDir,
  unrealEngineRoot,
  validatedAndroidSdk,
  validatedJavaHome,
} from './toolchains.js';
import { isExecutable, pathLookup } from './which.js';

function errorFinding(code: string, message: string, path?: string, fixHint?: string): Finding {
  return { code, severity: 'error', message, path, fixHint };
}

function warning(code: string, message: string, path?: string, fixHint?: string): Finding {
  return { code, severity: 'warning', message, path, fixHint };
}

function isRelease(configuration?: string): boolean {
  if (!configuration) return true;
  const v = configuration.toLowerCase();
  return v === 'release' || v === 'shipping' || v === 'export-release';
}

/**
 * Whether a named Godot preset embeds the PCK into the executable. When false
 * (Godot 4 default) game data ships as a `<name>.pck` sidecar that is the real
 * fresh build output and must be attested separately from the template-derived
 * executable. Reads the preset's own `[preset.N.options]` block.
 */
function godotPresetEmbedsPck(presetsText: string | null, presetName: string | null): boolean {
  if (!presetsText || !presetName) return false;
  const headers = [...presetsText.matchAll(/\[preset\.(\d+)\]/g)];
  const optionBlocks = presetsText.split(/\[preset\.\d+\.options\]/g).slice(1);
  const escaped = presetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].index ?? 0;
    const end = i + 1 < headers.length ? (headers[i + 1].index ?? presetsText.length) : presetsText.length;
    const head = presetsText.slice(start, end);
    if (new RegExp(`^name\\s*=\\s*"${escaped}"`, 'm').test(head)) {
      const options = optionBlocks[i] ?? '';
      return /^binary_format\/embed_pck\s*=\s*true/m.test(options);
    }
  }
  return false;
}

function outputFile(outputPath: string, fileName: string): string {
  return join(outputPath, fileName);
}

async function missingTool(name: string, executable: string | null, installHint: string): Promise<Finding | null> {
  if (executable && await isExecutable(executable)) return null;
  if (executable && await pathExists(executable)) return null;
  return errorFinding(
    'toolchain.missing',
    `${name} 실행 파일을 찾지 못했습니다.`,
    executable ?? undefined,
    installHint,
  );
}

async function godotPlan(project: ProjectInspection, options: BuildOptions): Promise<BuildPlan> {
  const findings: Finding[] = [...project.findings];
  const executable = options.engineExecutable || await findGodot(options.toolPaths) || 'godot';
  const missing = await missingTool('Godot', options.engineExecutable ? executable : await findGodot(options.toolPaths), 'Godot 편집기 바이너리를 PATH에 두거나 engineExecutable 로 지정하세요.');
  if (missing) findings.push(missing);

  const presetsText = await readIfExists(project.rootPath, 'export_presets.cfg');
  const presets = presetsText ? parseGodotPresets(presetsText) : [];
  let presetName = options.exportPreset ?? null;
  if (presetName && presets.length > 0 && !presets.some((p) => p.name === presetName)) {
    findings.push(errorFinding(
      'godot.unknown_preset',
      `지정한 내보내기 프리셋 "${presetName}" 이 export_presets.cfg 에 없습니다.`,
      'export_presets.cfg',
      '프로젝트에 있는 프리셋 이름을 사용하세요.',
    ));
    presetName = null;
  }
  if (!presetName) {
    const match = presets.find((p) => targetsFromGodotPlatform(p.platform).includes(options.target));
    presetName = match?.name ?? null;
  }
  if (!presetName) {
    findings.push(errorFinding(
      'godot.missing_preset_for_target',
      `${options.target} 대상에 해당하는 Godot 내보내기 프리셋이 없습니다.`,
      'export_presets.cfg',
      `Godot 편집기에서 ${options.target} 프리셋을 추가하세요.`,
    ));
  }

  // Android extension follows the actual preset: gradle_build/export_format
  // selects .aab; anything else exports an .apk.
  const chosenPreset = presetName ? presets.find((p) => p.name === presetName) : undefined;
  const ext =
    options.target === 'android' ? (chosenPreset?.androidFormat === 'aab' ? '.aab' : '.apk')
    : options.target === 'ios' ? '.zip'
    : options.target === 'windows' ? '.exe'
    : options.target === 'macos' ? '.zip'
    : '';
  const artifact = outputFile(options.outputPath, `${project.name || 'game'}${ext}`);
  const exportFlag = isRelease(options.configuration) ? '--export-release' : '--export-debug';

  const templates = await godotDataDir(options.toolPaths);
  if (presetName && !templates.path) {
    findings.push(errorFinding(
      'godot.missing_export_templates',
      templates.reason ?? 'Godot 내보내기 템플릿이 준비되지 않았습니다.',
      undefined,
      'APPOPS_GODOT_DATA_DIR 아래 export_templates/<버전>/ 을 준비하세요.',
    ));
  }
  const commands: CommandSpec[] = [];
  if (presetName && templates.path) {
    commands.push({
      executable,
      args: ['--headless', '--path', project.rootPath, exportFlag, presetName, artifact],
      cwd: project.rootPath,
      env: {
        // The runner seeds this per-run XDG data dir with a read-only
        // export_templates link into the validated dedicated data path.
        XDG_DATA_HOME: join(options.outputPath, '.appops-task-cache', 'xdg-data'),
        GODOT_TEMPLATES_SOURCE: templates.path,
      },
      label: `Godot ${exportFlag} ${presetName}`,
    });
  }
  if (options.target === 'android' && isRelease(options.configuration)) {
    findings.push(warning(
      'android.signing_unverified',
      '릴리스 Android 내보내기 서명은 프리셋의 keystore 설정에 의존하며 이 환경에서 검증되지 않았습니다.',
      'export_presets.cfg',
      '프리셋 keystore/release 설정을 확인하고 결과물 서명을 별도로 검증하세요.',
    ));
  }
  if (options.target === 'ios' && process.platform !== 'darwin') {
    findings.push(warning(
      'ios.requires_macos',
      'Godot iOS 내보내기 이후 Xcode 서명·아카이브는 macOS가 필요합니다.',
      undefined,
      'Mac 러너에서 이어서 서명하세요.',
    ));
  }
  // For bare-executable targets (Linux/Windows) without embedded PCK, the
  // executable equals the export template; the FRESH build output is the
  // sidecar `<name>.pck`. Attest it too, or a run that copied the template
  // but failed to pack would be accepted as a successful build.
  const expectedArtifacts: string[] = [];
  if (commands.length > 0) {
    expectedArtifacts.push(artifact);
    const bareExecutable = options.target === 'linux' || options.target === 'windows';
    if (bareExecutable && !godotPresetEmbedsPck(presetsText, presetName)) {
      const base = ext ? artifact.slice(0, artifact.length - ext.length) : artifact;
      expectedArtifacts.push(`${base}.pck`);
    }
  }
  return {
    engine: 'godot',
    target: options.target,
    sourcePath: project.rootPath,
    outputPath: options.outputPath,
    commands,
    expectedArtifacts,
    findings,
  };
}

function unityBuildTargetName(target: BuildTarget): string {
  switch (target) {
    case 'android': return 'android';
    case 'ios': return 'ios';
    case 'windows': return 'win64';
    case 'macos': return 'osxuniversal';
    case 'linux': return 'linux64';
  }
}

async function findUnityBuildProfile(root: string, exportPreset?: string): Promise<string | null> {
  if (exportPreset) return exportPreset;
  const dir = join(root, 'Assets/Settings/Build Profiles');
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.asset'));
    if (names.length === 1) return `Assets/Settings/Build Profiles/${names[0]}`;
  } catch {
    return null;
  }
  return null;
}

async function unityPlan(project: ProjectInspection, options: BuildOptions): Promise<BuildPlan> {
  const findings: Finding[] = [...project.findings];
  const found = await findUnity(options.toolPaths);
  const executable = options.engineExecutable || found || 'Unity';
  const missing = await missingTool('Unity', options.engineExecutable ? executable : found, 'Unity Hub에서 에디터를 설치하고 engineExecutable 로 지정하세요.');
  if (missing) findings.push(missing);
  if (!missing && process.platform !== 'darwin' && !(await pathExists(join(dirname(executable), 'Data')))) {
    findings.push(warning(
      'unity.unverified_editor_layout',
      `Unity 실행 파일(${executable}) 옆에서 Data 디렉터리를 찾지 못했습니다. 에디터 설치 루트가 아니면 샌드박스에서 리소스를 찾지 못할 수 있습니다.`,
      executable,
      'Unity Hub가 설치한 <버전>/Editor/Unity 실행 파일을 지정하세요.',
    ));
  }

  const playerPath =
    options.target === 'windows' ? outputFile(options.outputPath, `${project.name || 'game'}.exe`)
    : options.target === 'macos' ? outputFile(options.outputPath, `${project.name || 'game'}.app`)
    : options.target === 'android' ? outputFile(options.outputPath, `${project.name || 'game'}.apk`)
    : options.target === 'ios' ? outputFile(options.outputPath, `${project.name || 'game'}`)
    : outputFile(options.outputPath, project.name || 'game');

  const baseArgs = [
    '-batchmode',
    '-nographics',
    '-quit',
    '-projectPath', project.rootPath,
    '-logFile', '-',
    '-buildTarget', unityBuildTargetName(options.target),
  ];

  let args: string[] | null = null;
  if (options.target === 'windows') {
    args = [...baseArgs, '-buildWindows64Player', playerPath];
  } else if (options.target === 'macos') {
    args = [...baseArgs, '-buildOSXUniversalPlayer', playerPath];
  } else if (options.target === 'linux') {
    args = [...baseArgs, '-buildLinux64Player', playerPath];
  } else {
    const profile = await findUnityBuildProfile(project.rootPath, options.exportPreset);
    if (profile) {
      args = [...baseArgs, '-activeBuildProfile', profile, '-build', playerPath];
    } else {
      findings.push(errorFinding(
        'unity.missing_build_profile',
        `${options.target} 빌드는 Unity 빌드 프로파일(-activeBuildProfile + -build)이 필요합니다.`,
        'Assets/Settings/Build Profiles',
        'Unity 6 빌드 프로파일을 만들거나 exportPreset 으로 프로파일 자산 경로를 전달하세요. Android/iOS는 전용 -build*Player 인수가 없습니다.',
      ));
    }
  }

  const commands: CommandSpec[] = args
    ? [{ executable, args, cwd: project.rootPath, label: `Unity batch ${options.target}` }]
    : [];

  return {
    engine: 'unity',
    target: options.target,
    sourcePath: project.rootPath,
    outputPath: options.outputPath,
    commands,
    expectedArtifacts: commands.length > 0 ? [playerPath] : [],
    findings,
  };
}

function unrealPlatform(target: BuildTarget): string {
  switch (target) {
    case 'android': return 'Android';
    case 'ios': return 'IOS';
    case 'windows': return 'Win64';
    case 'macos': return 'Mac';
    case 'linux': return 'Linux';
  }
}

async function unrealPlan(project: ProjectInspection, options: BuildOptions): Promise<BuildPlan> {
  const findings: Finding[] = [...project.findings];
  const found = await findUnrealUat(options.toolPaths);
  const executable = options.engineExecutable || found || (process.platform === 'win32' ? 'RunUAT.bat' : 'RunUAT.sh');
  const missing = await missingTool('Unreal RunUAT', options.engineExecutable ? executable : found, 'UE_ROOT 를 설정하거나 Engine/Build/BatchFiles/RunUAT.sh 경로를 engineExecutable 로 지정하세요.');
  if (missing) findings.push(missing);

  const names = await readdir(project.rootPath).catch(() => [] as string[]);
  const uproject = names.find((n) => n.endsWith('.uproject'));
  if (!uproject) {
    findings.push(errorFinding('unreal.missing_uproject', '.uproject 파일이 없어 BuildCookRun 을 구성할 수 없습니다.', project.rootPath));
  }
  // UAT needs the whole engine tree (AutomationTool, Engine/Binaries), not
  // just Build/BatchFiles: validate the root and mount it via UE_ENGINE_ROOT.
  let engineRootPath: string | null = null;
  if (!missing) {
    const engineRoot = await unrealEngineRoot(executable,options.toolPaths);
    engineRootPath = engineRoot.path;
    if (!engineRoot.path) {
      findings.push(errorFinding(
        'unreal.invalid_engine_root',
        engineRoot.reason ?? 'Unreal 엔진 루트를 검증하지 못했습니다.',
        executable,
        '엔진 설치 안의 Engine/Build/BatchFiles/RunUAT.sh 를 지정하세요.',
      ));
    }
  }
  const config = !options.configuration ? 'Development'
    : isRelease(options.configuration) ? 'Shipping'
    : options.configuration;
  const platform = unrealPlatform(options.target);
  const projectArg = uproject ? join(project.rootPath, uproject) : project.rootPath;
  const commands: CommandSpec[] = uproject && engineRootPath
    ? [{
      executable,
      args: [
        'BuildCookRun',
        `-project=${projectArg}`,
        `-platform=${platform}`,
        `-clientconfig=${config}`,
        '-build',
        '-cook',
        '-stage',
        '-package',
        '-archive',
        `-archivedirectory=${options.outputPath}`,
      ],
      cwd: project.rootPath,
      env: { UE_ENGINE_ROOT: engineRootPath },
      label: `Unreal BuildCookRun ${platform}`,
    }]
    : [];
  if (options.target === 'ios' && process.platform !== 'darwin') {
    findings.push(errorFinding('ios.requires_macos', 'Unreal iOS 패키징은 Mac 러너가 필요합니다.'));
  }
  return {
    engine: 'unreal',
    target: options.target,
    sourcePath: project.rootPath,
    outputPath: options.outputPath,
    commands,
    expectedArtifacts: commands.length > 0 ? [options.outputPath] : [],
    findings,
  };
}

async function androidModuleName(root: string): Promise<string> {
  const settings = (await readIfExists(root, 'settings.gradle'))
    ?? (await readIfExists(root, 'settings.gradle.kts'))
    ?? '';
  const included = [...settings.matchAll(/include\s*\(?\s*['":]+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  if (included.includes('app')) return 'app';
  if (included.length === 1) return included[0];
  if (await existsIn(root, 'app/build.gradle') || await existsIn(root, 'app/build.gradle.kts')) return 'app';
  return included[0] ?? 'app';
}

async function androidPlan(project: ProjectInspection, options: BuildOptions): Promise<BuildPlan> {
  const findings: Finding[] = [...project.findings];
  if (options.target !== 'android') {
    findings.push(errorFinding(
      'android.unsupported_target',
      `네이티브 Android 프로젝트는 android 대상만 빌드할 수 있습니다 (요청: ${options.target}).`,
    ));
  }
  const wrapperName = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapper = join(project.rootPath, wrapperName);
  const hasWrapper = await existsIn(project.rootPath, wrapperName) || await existsIn(project.rootPath, 'gradlew');
  const executable = hasWrapper
    ? (await existsIn(project.rootPath, wrapperName) ? wrapper : join(project.rootPath, 'gradlew'))
    : wrapper;
  if (!hasWrapper) {
    findings.push(errorFinding(
      'android.missing_wrapper',
      'Gradle Wrapper가 없습니다. 시스템 gradle로 대체하지 않습니다.',
      wrapperName,
      '프로젝트에 gradlew 를 생성하세요.',
    ));
  }
  const java = await validatedJavaHome(options.toolPaths);
  if (!java.path) {
    findings.push(errorFinding('android.missing_java', java.reason ?? 'Android Gradle 빌드에 JDK가 필요합니다.', undefined, 'APPOPS_JAVA_HOME 을 홈 밖 JDK 루트로 설정하세요.'));
  }
  const sdk = await validatedAndroidSdk(options.toolPaths);
  if (!sdk.path) {
    findings.push(errorFinding(
      'android.missing_sdk',
      sdk.reason ?? 'Android SDK를 찾지 못했습니다.',
      undefined,
      'APPOPS_ANDROID_SDK_ROOT 를 홈 밖 SDK 루트로 설정하세요.',
    ));
  }
  // The sandbox has no network and an empty HOME, so a standard wrapper run
  // (download distribution into GRADLE_USER_HOME) cannot work. Builds require
  // the one-time offline cache and run with a clean per-run Gradle home.
  const gradleTools = await gradleToolsDir(options.toolPaths);
  if (!gradleTools.path) {
    findings.push(errorFinding(
      'android.missing_gradle_cache',
      gradleTools.reason ?? '오프라인 Gradle 도구 캐시가 준비되지 않았습니다.',
      undefined,
      'APPOPS_GRADLE_TOOLS_DIR 아래 wrapper/dists 와 dependency-cache 를 준비하세요 (docs/build-support.md 참조).',
    ));
  }
  const module = await androidModuleName(project.rootPath);
  const release = isRelease(options.configuration);
  const task = release ? `${module}:bundleRelease` : `${module}:assembleDebug`;
  const env: Record<string, string> = {};
  if (sdk.path) {
    env.ANDROID_HOME = sdk.path;
    env.ANDROID_SDK_ROOT = sdk.path;
  }
  if (java.path) env.JAVA_HOME = java.path;
  if (gradleTools.path) {
    env.GRADLE_USER_HOME = join(options.outputPath, '.appops-task-cache', 'gradle-user-home');
    env.GRADLE_TOOLS_ROOT = gradleTools.path;
    env.GRADLE_RO_DEP_CACHE = join(gradleTools.path, 'dependency-cache');
  }
  const prerequisitesReady = Boolean(java.path && sdk.path && gradleTools.path);
  const commands: CommandSpec[] = hasWrapper && options.target === 'android' && prerequisitesReady
    ? [{
      executable,
      args: ['--offline', '--no-daemon', task],
      cwd: project.rootPath,
      env,
      label: `Gradle ${task}`,
    }]
    : [];
  if (release && commands.length > 0) {
    findings.push(warning(
      'android.signing_unverified',
      '릴리스 AAB 서명은 프로젝트의 서명 설정에 의존하며 이 환경에서 검증되지 않았습니다. 저장소의 keystore 파일은 스냅샷에서 제외됩니다.',
      undefined,
      '서명 자료는 저장소 복사가 아니라 별도 서명 단계에서 주입해야 합니다.',
    ));
  }
  const artifact = release
    ? join(project.rootPath, module, 'build/outputs/bundle/release', `${module}-release.aab`)
    : join(project.rootPath, module, 'build/outputs/apk/debug', `${module}-debug.apk`);
  return {
    engine: 'android',
    target: options.target,
    sourcePath: project.rootPath,
    outputPath: options.outputPath,
    commands,
    expectedArtifacts: commands.length > 0 ? [artifact] : [],
    findings,
  };
}

async function listSchemes(root: string): Promise<string[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const containers = names.filter((n) => n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'));
  const schemes: string[] = [];
  for (const container of containers) {
    const dir = join(root, container, 'xcshareddata/xcschemes');
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (file.endsWith('.xcscheme')) schemes.push(basename(file, '.xcscheme'));
    }
  }
  return [...new Set(schemes)];
}

async function iosPlan(project: ProjectInspection, options: BuildOptions): Promise<BuildPlan> {
  const findings: Finding[] = [...project.findings];
  if (options.target !== 'ios' && options.target !== 'macos') {
    findings.push(errorFinding(
      'ios.unsupported_target',
      `Xcode 프로젝트는 ios/macos 대상만 지원합니다 (요청: ${options.target}).`,
    ));
  }
  const xcodebuild = process.platform === 'darwin' ? (options.toolPaths?.xcode || await pathLookup(['xcodebuild'])) : null;
  if (process.platform !== 'darwin') {
    findings.push(errorFinding(
      'ios.requires_macos',
      'xcodebuild archive/export 는 macOS에서만 실행할 수 있습니다.',
      undefined,
      'Mac 러너에 작업을 배정하세요.',
    ));
  } else if (!xcodebuild) {
    findings.push(errorFinding('toolchain.missing', 'xcodebuild 를 찾지 못했습니다.', undefined, 'Xcode Command Line Tools를 설치하세요.'));
  }
  const names = await readdir(project.rootPath).catch(() => [] as string[]);
  const workspace = names.find((n) => n.endsWith('.xcworkspace'));
  const xcodeproj = names.find((n) => n.endsWith('.xcodeproj'));
  const schemes = await listSchemes(project.rootPath);
  const scheme = options.scheme ?? (schemes.length === 1 ? schemes[0] : null);
  if (!scheme) {
    findings.push(errorFinding(
      'ios.missing_scheme',
      schemes.length === 0
        ? '공유 스킴이 없어 archive 명령을 만들지 않았습니다.'
        : `스킴이 여러 개입니다 (${schemes.join(', ')}). scheme 옵션으로 지정하세요.`,
      workspace ?? xcodeproj,
    ));
  }
  const executable = options.engineExecutable || xcodebuild || 'xcodebuild';
  const archivePath = join(options.outputPath, `${project.name || 'app'}.xcarchive`);
  const exportPath = options.outputPath;
  const commands: CommandSpec[] = [];
  if (scheme && (workspace || xcodeproj) && (options.target === 'ios' || options.target === 'macos')) {
    const dest = options.target === 'macos' ? 'generic/platform=macOS' : 'generic/platform=iOS';
    const projectArgs = workspace
      ? ['-workspace', join(project.rootPath, workspace)]
      : ['-project', join(project.rootPath, xcodeproj!)];
    commands.push({
      executable,
      args: [
        'archive',
        ...projectArgs,
        '-scheme', scheme,
        '-destination', dest,
        '-archivePath', archivePath,
        '-configuration', isRelease(options.configuration) ? 'Release' : (options.configuration || 'Debug'),
      ],
      cwd: project.rootPath,
      label: `xcodebuild archive ${scheme}`,
    });
    const exportPlist = (await existsIn(project.rootPath, 'ExportOptions.plist'))
      ? join(project.rootPath, 'ExportOptions.plist')
      : null;
    if (!exportPlist) {
      findings.push(errorFinding(
        'ios.missing_export_options',
        'ExportOptions.plist 가 없어 -exportArchive 단계를 생략합니다.',
        'ExportOptions.plist',
        'Xcode에서 한 번 내보내기한 ExportOptions.plist 를 프로젝트에 두세요.',
      ));
    } else {
      commands.push({
        executable,
        args: [
          '-exportArchive',
          '-archivePath', archivePath,
          '-exportPath', exportPath,
          '-exportOptionsPlist', exportPlist,
        ],
        cwd: project.rootPath,
        label: 'xcodebuild -exportArchive',
      });
    }
  }
  const expected = commands.some((c) => c.args.includes('-exportArchive'))
    ? [join(exportPath, `${project.name || 'app'}.ipa`)]
    : commands.length > 0 ? [archivePath] : [];
  return {
    engine: 'ios',
    target: options.target,
    sourcePath: project.rootPath,
    outputPath: options.outputPath,
    commands,
    expectedArtifacts: expected,
    findings,
  };
}

export async function createBuildPlan(project: ProjectInspection, options: BuildOptions): Promise<BuildPlan> {
  const plan = await buildPlan(project, options);
  return { ...plan, managedToolRoot: options.toolPaths?.managedRoot };
}

async function buildPlan(project: ProjectInspection, options: BuildOptions): Promise<BuildPlan> {
  if (!options.outputPath) {
    const findings = [...project.findings, errorFinding('build.missing_output', 'outputPath 가 필요합니다.')];
    return {
      engine: project.engine,
      target: options.target,
      sourcePath: project.rootPath,
      outputPath: options.outputPath,
      commands: [],
      expectedArtifacts: [],
      findings,
    };
  }
  switch (project.engine) {
    case 'godot':
      return godotPlan(project, options);
    case 'unity':
      return unityPlan(project, options);
    case 'unreal':
      return unrealPlan(project, options);
    case 'android':
      return androidPlan(project, options);
    case 'ios':
      return iosPlan(project, options);
    default:
      return {
        engine: project.engine,
        target: options.target,
        sourcePath: project.rootPath,
        outputPath: options.outputPath,
        commands: [],
        expectedArtifacts: [],
        findings: [
          ...project.findings,
          errorFinding('build.unknown_engine', '알 수 없는 엔진이라 빌드 명령을 만들지 않았습니다.', project.rootPath),
        ],
      };
  }
}
