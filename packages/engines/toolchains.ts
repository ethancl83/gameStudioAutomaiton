import { readdir, stat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Toolchain, ToolPathSettings } from '../../packages/domain/index.js';
import {
  firstExistingFile,
  firstLineVersion,
  globDirs,
  home,
  isExecutable,
  pathLookup,
  readCommandOutput,
} from './which.js';

/**
 * One-time APPOPS_* tool configuration, validated into narrow directories.
 * These values are read host-side to build plans and sandbox mounts; the
 * APPOPS_* variables themselves are never forwarded into the sandbox.
 */
export interface ValidatedPath {
  path: string | null;
  reason?: string;
  version?:string;
}

function insideHome(target: string): boolean {
  const h = home();
  if (!h) return false;
  const prefix = h.endsWith(sep) ? h : h + sep;
  return target === h || target.startsWith(prefix);
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function hasEntries(target: string): Promise<boolean> {
  try {
    return (await readdir(target)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Dedicated offline Gradle tool cache. Required layout:
 *   <dir>/wrapper/dists/...      (pre-downloaded wrapper distribution + .ok marker)
 *   <dir>/dependency-cache/...   (Gradle read-only dependency cache; may start empty)
 * A live user Gradle home (~/.gradle, gradle.properties present) is refused so
 * user credentials are never mounted into build sandboxes.
 */
export async function gradleToolsDir(settings:ToolPathSettings = {}): Promise<ValidatedPath> {
  const configured = settings.gradleCache || process.env.APPOPS_GRADLE_TOOLS_DIR;
  if (!configured) {
    return {
      path: null,
      reason: '오프라인 샌드박스 Gradle 빌드에는 미리 준비한 도구 캐시가 필요합니다. APPOPS_GRADLE_TOOLS_DIR 를 wrapper/dists 와 dependency-cache 를 담은 전용 디렉터리로 설정하세요.',
    };
  }
  const dir = resolve(configured);
  if (insideHome(dir) && !await managedToolPath(dir, settings.managedRoot)) {
    return { path: null, reason: `APPOPS_GRADLE_TOOLS_DIR(${dir})가 사용자 홈 아래에 있습니다. 샌드박스는 홈 디렉터리를 마운트하지 않으므로 /opt/appops 같은 홈 밖 경로로 옮기세요.` };
  }
  if (!(await isDirectory(dir))) {
    return { path: null, reason: `APPOPS_GRADLE_TOOLS_DIR(${dir})가 없거나 디렉터리가 아닙니다.` };
  }
  try {
    await stat(join(dir, 'gradle.properties'));
    return { path: null, reason: `APPOPS_GRADLE_TOOLS_DIR(${dir})에 gradle.properties 가 있습니다. 자격 증명이 섞일 수 있는 실제 Gradle 홈이 아니라 정리된 캐시 사본을 지정하세요.` };
  } catch { /* good: no properties file */ }
  if (!(await isDirectory(join(dir, 'wrapper', 'dists'))) || !(await hasEntries(join(dir, 'wrapper', 'dists')))) {
    return { path: null, reason: `APPOPS_GRADLE_TOOLS_DIR(${dir})에 wrapper/dists 배포판이 없습니다. 신뢰망에서 한 번 준비해 두세요 (프로젝트 gradle-wrapper.properties 의 distributionUrl 버전).` };
  }
  if (!(await isDirectory(join(dir, 'dependency-cache')))) {
    return { path: null, reason: `APPOPS_GRADLE_TOOLS_DIR(${dir})에 dependency-cache 디렉터리가 없습니다. 비어 있어도 되지만 존재해야 합니다.` };
  }
  return { path: dir };
}

/** Dedicated read-only Godot data directory holding export_templates/<version>/. */
export async function godotDataDir(settings:ToolPathSettings = {}): Promise<ValidatedPath> {
  const configured = settings.godotData || process.env.APPOPS_GODOT_DATA_DIR;
  if (!configured) {
    return {
      path: null,
      reason: 'Godot 내보내기에는 내보내기 템플릿이 필요합니다. APPOPS_GODOT_DATA_DIR 를 export_templates/<버전>/ 을 담은 전용 디렉터리로 설정하세요.',
    };
  }
  const dir = resolve(configured);
  if (insideHome(dir) && !await managedToolPath(dir, settings.managedRoot)) {
    return { path: null, reason: `APPOPS_GODOT_DATA_DIR(${dir})가 사용자 홈 아래에 있습니다. 홈 밖 전용 경로(예: /opt/appops/godot-data)로 옮기세요.` };
  }
  const templates = join(dir, 'export_templates');
  if (!(await isDirectory(templates)) || !(await hasEntries(templates))) {
    return { path: null, reason: `APPOPS_GODOT_DATA_DIR(${dir}) 아래 export_templates/<버전>/ 이 없습니다. Godot 편집기 버전과 일치하는 템플릿을 준비하세요.` };
  }
  return { path: dir };
}

/** JDK root for Gradle/Android: APPOPS_JAVA_HOME preferred, then JAVA_HOME. */
export async function validatedJavaHome(settings:ToolPathSettings = {}): Promise<ValidatedPath> {
  const configured = settings.javaHome || process.env.APPOPS_JAVA_HOME || process.env.JAVA_HOME || await autoJavaHome();
  if (!configured) {
    return { path: null, reason: 'JDK를 찾지 못했습니다. APPOPS_JAVA_HOME 또는 JAVA_HOME 을 JDK 루트로 설정하세요.' };
  }
  const dir = resolve(configured);
  const java = join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const javac=join(dir,'bin',process.platform==='win32'?'javac.exe':'javac');
  if (!(await isExecutable(java))||!(await isExecutable(javac))) {
    return { path: null, reason: `JAVA_HOME(${dir}) 아래 bin/java 실행 파일이 없습니다.` };
  }
  if (insideHome(dir) && !await managedToolPath(dir, settings.managedRoot)) {
    return { path: null, reason: `JDK(${dir})가 사용자 홈 아래에 있어 샌드박스에 마운트할 수 없습니다. 홈 밖 JDK 설치를 APPOPS_JAVA_HOME 으로 지정하세요.` };
  }
  const [runtime,compiler]=await Promise.all([readCommandOutput(java,['-version']),readCommandOutput(javac,['-version'])]);
  const version=runtime?.match(/(?:openjdk|java)\s+(?:version\s+)?"?(\d+(?:\.\d+){0,3})/i)?.[1];
  const compiled=compiler?.match(/javac\s+(\d+(?:\.\d+){0,3})/i)?.[1];
  if(!version||!compiled||version.split('.')[0]!==compiled.split('.')[0])return {path:null,reason:'JDK의 java·javac 실행과 버전을 확인하지 못했습니다. 정상 설치한 JDK를 선택해 주세요.'};
  return { path: dir, version };
}

/** Android SDK root: APPOPS_ANDROID_SDK_ROOT preferred, then ANDROID_HOME/ANDROID_SDK_ROOT. */
export async function validatedAndroidSdk(settings:ToolPathSettings = {}): Promise<ValidatedPath> {
  const configured = settings.androidSdk || process.env.APPOPS_ANDROID_SDK_ROOT || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!configured) {
    return { path: null, reason: 'Android SDK를 찾지 못했습니다. APPOPS_ANDROID_SDK_ROOT (또는 ANDROID_HOME)을 SDK 루트로 설정하세요.' };
  }
  const dir = resolve(configured);
  if (insideHome(dir) && !await managedToolPath(dir, settings.managedRoot)) {
    return { path: null, reason: `Android SDK(${dir})가 사용자 홈 아래에 있어 샌드박스에 마운트할 수 없습니다. 홈 밖 위치(예: /opt/android-sdk)로 옮기고 APPOPS_ANDROID_SDK_ROOT 로 지정하세요.` };
  }
  const platforms:string[]=[],buildTools:string[]=[];
  for(const name of await readdir(join(dir,'platforms')).catch(()=>[]))if(/^android-\d+$/.test(name)&&await nonEmptyFile(join(dir,'platforms',name,'android.jar')))platforms.push(name);
  for(const name of await readdir(join(dir,'build-tools')).catch(()=>[]))if(/^\d+\.\d+\.\d+$/.test(name)&&await isExecutable(join(dir,'build-tools',name,process.platform==='win32'?'aapt2.exe':'aapt2'))&&await nonEmptyFile(join(dir,'build-tools',name,'lib','apksigner.jar')))buildTools.push(name);
  const adb=join(dir,'platform-tools',process.platform==='win32'?'adb.exe':'adb');
  if(!platforms.length||!buildTools.length||!await isExecutable(adb))return {path:null,reason:'Android SDK의 플랫폼 android.jar, 빌드 도구(aapt2·apksigner), platform-tools(adb)를 설치해 주세요.'};
  const [adbVersion,aaptVersion]=await Promise.all([readCommandOutput(adb,['version']),readCommandOutput(join(dir,'build-tools',buildTools[0]!,process.platform==='win32'?'aapt2.exe':'aapt2'),['version'])]);
  if(!adbVersion?.includes('Android Debug Bridge')||!aaptVersion?.includes('Android Asset Packaging Tool'))return {path:null,reason:'Android SDK의 adb·aapt2 실행을 확인하지 못했습니다. SDK 구성 요소를 다시 설치해 주세요.'};
  return { path: dir, version: platforms.sort().join(', ')+' / '+buildTools.sort().join(', ') };
}

async function nonEmptyFile(path:string):Promise<boolean>{try{const s=await stat(path);return s.isFile()&&s.size>0;}catch{return false;}}

/**
 * Derives and validates the Unreal engine root from a RunUAT path. UAT invokes
 * sibling trees (AutomationTool binaries under Engine/Binaries|Engine/Source),
 * so mounting only Build/BatchFiles is never runnable.
 */
export async function unrealEngineRoot(uatExecutable: string, settings:ToolPathSettings = {}): Promise<ValidatedPath> {
  const root = resolve(dirname(uatExecutable), '..', '..', '..');
  if (!(await isDirectory(join(root, 'Engine', 'Build', 'BatchFiles')))) {
    return { path: null, reason: `RunUAT 경로(${uatExecutable})에서 Engine/Build/BatchFiles 구조를 확인하지 못했습니다. 엔진 설치 안의 RunUAT 를 지정하세요.` };
  }
  if (!(await isDirectory(join(root, 'Engine', 'Binaries')))) {
    return { path: null, reason: `Unreal 엔진 루트(${root})에 Engine/Binaries 가 없습니다. UAT 는 엔진 바이너리 전체가 필요합니다.` };
  }
  const automationTool = (await isDirectory(join(root, 'Engine', 'Binaries', 'DotNET')))
    || (await isDirectory(join(root, 'Engine', 'Source', 'Programs', 'AutomationTool')));
  if (!automationTool) {
    return { path: null, reason: `Unreal 엔진 루트(${root})에서 AutomationTool(Engine/Binaries/DotNET 또는 Engine/Source/Programs/AutomationTool)을 찾지 못했습니다.` };
  }
  if (insideHome(root) && !await managedToolPath(root, settings.managedRoot)) {
    return { path: null, reason: `Unreal 엔진(${root})이 사용자 홈 아래에 있어 샌드박스에 마운트할 수 없습니다. 홈 밖 설치를 사용하세요.` };
  }
  return { path: root };
}

async function tool(
  name: string,
  executable: string | null,
  versionArgs: string[],
  missingReason: string,
): Promise<Toolchain> {
  if (!executable) {
    return { name, executable: null, version: null, available: false, reason: missingReason };
  }
  const raw = await readCommandOutput(executable, versionArgs);
  return {
    name,
    executable,
    version: name === 'unity' ? raw?.match(/\b\d+\.\d+\.\d+[abfp]\d+\b/)?.[0] ?? firstLineVersion(raw) : firstLineVersion(raw),
    available: raw !== null,
    reason: raw === null ? '실행 파일의 버전 확인에 실패했습니다. 도구 경로·라이선스와 실행 환경을 확인해 주세요.' : undefined,
  };
}

async function findGodot(settings:ToolPathSettings = {}): Promise<string | null> {
  if(settings.godot)return await firstExistingFile([settings.godot]);
  const fromPath = await pathLookup(['godot', 'godot4', 'Godot', 'godot-mono']);
  if (fromPath) return fromPath;
  const h = home();
  return firstExistingFile([
    '/usr/local/bin/godot',
    '/usr/bin/godot',
    join(h, '.local/bin/godot'),
    '/opt/godot/godot',
    '/Applications/Godot.app/Contents/MacOS/Godot',
  ]);
}

async function findUnity(settings:ToolPathSettings = {}): Promise<string | null> {
  if(settings.unity)return await firstExistingFile([settings.unity]);
  const fromPath = await pathLookup(['unity', 'Unity', 'unity-editor']);
  if (fromPath) return fromPath;
  const h = home();
  const hubLinux = await globDirs(join(h, 'Unity/Hub/Editor'), 'Editor/Unity');
  const hubOpt = await globDirs('/opt/Unity/Hub/Editor', 'Editor/Unity');
  const hubOpt2 = await globDirs('/opt/unity/Hub/Editor', 'Editor/Unity');
  const hubMac = await globDirs('/Applications/Unity/Hub/Editor', 'Unity.app/Contents/MacOS/Unity');
  const extras = [
    ...hubLinux,
    ...hubOpt,
    ...hubOpt2,
    ...hubMac,
    '/opt/unity/Editor/Unity',
    '/opt/Unity/Editor/Unity',
  ];
  extras.sort().reverse();
  return extras[0] ?? null;
}

async function findUnrealUat(settings:ToolPathSettings = {}): Promise<string | null> {
  if(settings.unreal)return await firstExistingFile([settings.unreal]);
  const script = process.platform === 'win32' ? 'RunUAT.bat' : 'RunUAT.sh';
  const envRoot = process.env.UE_ROOT || process.env.UE5_ROOT || process.env.UE4_ROOT;
  const h = home();
  const candidates: string[] = [];
  if (envRoot) candidates.push(join(envRoot, 'Engine/Build/BatchFiles', script));
  candidates.push(
    join(h, 'UnrealEngine/Engine/Build/BatchFiles', script),
    join(h, 'UE/Engine/Build/BatchFiles', script),
    `/opt/unreal/Engine/Build/BatchFiles/${script}`,
    `/opt/Epic Games/UnrealEngine/Engine/Build/BatchFiles/${script}`,
  );
  const fromPath = await pathLookup([script, 'RunUAT']);
  if (fromPath) return fromPath;
  return firstExistingFile(candidates);
}

async function findJava(settings:ToolPathSettings = {}): Promise<string | null> {
  const configured = settings.javaHome || process.env.APPOPS_JAVA_HOME || process.env.JAVA_HOME || await autoJavaHome();
  const homeJava = configured ? join(configured, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : null;
  if (homeJava) {
    const hit = await firstExistingFile([homeJava]);
    if (hit) return hit;
  }
  return pathLookup(['java']);
}

async function findAdb(settings:ToolPathSettings = {}): Promise<string | null> {
  const sdk = settings.androidSdk || process.env.APPOPS_ANDROID_SDK_ROOT || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const extra = sdk ? [join(sdk, 'platform-tools')] : [];
  extra.push(join(home(), 'Android/Sdk/platform-tools'), '/usr/lib/android-sdk/platform-tools');
  return pathLookup(['adb'], extra);
}

function androidSdkPath(settings:ToolPathSettings = {}): string | null {
  return settings.androidSdk || process.env.APPOPS_ANDROID_SDK_ROOT || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
}

export async function scanToolchains(settings:ToolPathSettings = {}): Promise<Toolchain[]> {
  const godot = await findGodot(settings);
  const unity = await findUnity(settings);
  const uat = await findUnrealUat(settings);
  const java = await findJava(settings);
  const adb = await findAdb(settings);
  const sdk = androidSdkPath(settings);
  const xcode = process.platform === 'darwin' ? (settings.xcode?await firstExistingFile([settings.xcode]):await pathLookup(['xcodebuild'])) : null;

  const tools: Toolchain[] = [
    await tool('godot', godot, ['--version'], 'PATH 및 일반적인 설치 경로에서 Godot 편집기 실행 파일을 찾지 못했습니다.'),
    await tool('unity', unity, ['-version'], 'Unity Hub Editor 경로에서 Unity 실행 파일을 찾지 못했습니다.'),
    await tool(
      'unreal-uat',
      uat,
      ['-help'],
      'UE_ROOT 또는 Engine/Build/BatchFiles/RunUAT.sh 를 찾지 못했습니다.',
    ),
    await tool('java', java, ['-version'], 'JAVA_HOME 또는 PATH에서 java를 찾지 못했습니다. Android 빌드에 필요합니다.'),
    {
      name: 'android-sdk',
      executable: sdk,
      version: null,
      available: Boolean(sdk && (await validatedAndroidSdk(settings)).path),
      reason: sdk ? undefined : 'ANDROID_HOME 또는 ANDROID_SDK_ROOT 가 설정되어 있지 않습니다.',
    },
    await tool('adb', adb, ['version'], 'Android SDK platform-tools의 adb를 찾지 못했습니다.'),
  ];
  const steamcmd = settings.steamcmd ? await firstExistingFile([settings.steamcmd]) : await pathLookup(process.platform === 'win32' ? ['steamcmd.exe'] : ['steamcmd']);
  // SteamCMD startup may update software or contact Steam. A scan only checks its
  // executable; the account's explicit connection check verifies authentication.
  tools.push({name:'steamcmd',executable:steamcmd,version:null,available:Boolean(steamcmd),reason:steamcmd?'SteamCMD 실행 경로가 연결되었습니다. 계정 화면에서 최초 인증을 확인해 주세요.':'SteamCMD 실행 파일의 경로를 연결해 주세요.'});

  if (process.platform === 'darwin') {
    tools.push(await tool('xcodebuild', xcode, ['-version'], 'xcodebuild를 찾지 못했습니다. Xcode Command Line Tools를 설치하세요.'));
  } else {
    tools.push({
      name: 'xcodebuild',
      executable: null,
      version: null,
      available: false,
      reason: 'xcodebuild는 macOS에서만 사용할 수 있습니다. iOS 빌드는 Mac 러너가 필요합니다.',
    });
  }

  // Sandbox prerequisites are probed up front so missing one-time APPOPS_*
  // configuration surfaces before any build attempt.
  const gradleTools = await gradleToolsDir(settings);
  tools.push({
    name: 'gradle-offline-cache',
    executable: gradleTools.path,
    version: null,
    available: Boolean(gradleTools.path),
    reason: gradleTools.reason,
  });
  const godotData = await godotDataDir(settings);
  tools.push({
    name: 'godot-export-templates',
    executable: godotData.path,
    version: null,
    available: Boolean(godotData.path),
    reason: godotData.reason,
  });
  const javaRoot = await validatedJavaHome(settings);
  tools.push({
    name: 'jdk-home',
    executable: javaRoot.path,
    version: javaRoot.version??null,
    available: Boolean(javaRoot.path),
    reason: javaRoot.reason,
  });
  const sdkRoot = await validatedAndroidSdk(settings);
  tools.push({
    name: 'android-sdk-validated',
    executable: sdkRoot.path,
    version: sdkRoot.version??null,
    available: Boolean(sdkRoot.path),
    reason: sdkRoot.reason,
  });
  if (uat) {
    const engineRoot = await unrealEngineRoot(uat,settings);
    tools.push({
      name: 'unreal-engine-root',
      executable: engineRoot.path,
      version: null,
      available: Boolean(engineRoot.path),
      reason: engineRoot.reason,
    });
  } else {
    tools.push({
      name: 'unreal-engine-root',
      executable: null,
      version: null,
      available: false,
      reason: 'RunUAT 를 찾지 못해 엔진 루트를 검증할 수 없습니다.',
    });
  }

  return tools;
}

export { findGodot, findUnity, findUnrealUat, findJava, androidSdkPath };

/** App-managed public tool trees are separate from credentials and must remain canonical. */
export async function managedToolPath(path:string, root?:string):Promise<boolean>{
 if(!root||!root.endsWith('.tools'))return false;
 try{const canonical=await realpath(root),target=await realpath(path);if(canonical!==resolve(root)||canonical===home())return false;return target.startsWith(canonical+sep);}catch{return false;}
}
export async function autoJavaHome():Promise<string|null>{
 const candidates:string[]=[];
 if(process.platform==='linux'){
  try{for(const name of (await readdir('/usr/lib/jvm')).sort((a,b)=>(b.includes('21')?1:0)-(a.includes('21')?1:0)))candidates.push(join('/usr/lib/jvm',name));}catch{}
 }
 const java=await pathLookup([process.platform==='win32'?'java.exe':'java']);if(java){try{candidates.push(dirname(dirname(await realpath(java))));}catch{}}
 for(const root of candidates)if(await isExecutable(join(root,'bin',process.platform==='win32'?'javac.exe':'javac')))return root;
 return null;
}
