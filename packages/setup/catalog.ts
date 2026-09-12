import { createHash } from 'node:crypto';
import type { ToolCatalogItem, ToolId } from './types.js';
import { AppError } from '../domain/errors.js';

export const GODOT_VERSION = '4.3';
export const GODOT_TEMPLATE_RELEASE = '4.3.stable';
export const TEMURIN_VERSION = '21.0.12.1+1';
/** `java -version` / `release` JAVA_VERSION string for Temurin 21.0.12.1+1. */
export const TEMURIN_JAVA_VERSION = '21.0.12.1';
export const ANDROID_CMDLINE_VERSION = '15859902';

/**
 * Google Play target API rules as of 2026-09-11.
 * https://developer.android.com/google/play/requirements/target-sdk
 * New apps/updates from 2026-08-31: API 36 (phone/tablet/Auto). Existing-app
 * discoverability: API 35. Wear/Automotive: 35. TV/XR: 34. Extension to 2026-11-01.
 * Catalog default follows the current phone/tablet submission floor. Installer never
 * rewrites project source or claims an engine can target an API it does not support.
 */
export const PLAY_TARGET_API = {
  asOf: '2026-09-11',
  newAppsAndUpdates: 36,
  existingAppsDiscoverable: 35,
  wearAndAutomotive: 35,
  tvAndXr: 34,
  extensionUntil: '2026-11-01',
} as const;

/** Play-current default SDK set. API 34/35 remain explicit install options. NDK/CMake are not defaults. */
export const DEFAULT_ANDROID_PACKAGES = ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0'] as const;
export const LEGACY_ANDROID_PACKAGES = ['platform-tools', 'platforms;android-34', 'build-tools;34.0.0'] as const;
export const GITHUB_RELEASE_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
] as const;
export const GOOGLE_DL_HOSTS = ['dl.google.com', 'dl-ssl.google.com'] as const;

const godotBase = `https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}-stable/`;
const temurinBase = `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${TEMURIN_VERSION}/`;

/** Official SHA-512 from Godot 4.3-stable SHA512-SUMS.txt (fetched 2026-09-11). */
const GODOT_SHA512: Record<string, string> = {
  'Godot_v4.3-stable_linux.x86_64.zip': 'fd52bb4ba8acc30ca5accd1c566d470ad7282f891ccc0995dfafabcf92bcf76280ce182bf9d80ebd885f3ed2165d01e1fc3f2928436b15498dfbd98656c2a45a',
  'Godot_v4.3-stable_macos.universal.zip': '8a556637aa6b83a60473decdb43a448b214f31fd13318b6f7ba2ebc4cca4e40d1f7a933330ce40afa8d72273ef6a6f3a0e3b0f0abf8e1be3fe4f03119cae62c2',
  'Godot_v4.3-stable_win64.exe.zip': 'ad09b7e19949327700dfbe64e35880a2a08091c0751277f5cc21b915e5df9b4fe93fb43c50d6bdfb9d16b46168592491aa698e0d2dbe9f92132e163dd77b97e1',
  'Godot_v4.3-stable_export_templates.tpz': '476366caf0fd45a8f24136cf9cf1dc0bc2b96f7c82d53e5f82200b55aefd07b286d283fd6f1ce29e0de70648c5a51d3b12f96c6d4fafd4e8c4878ecda6406d6a',
};

/** Eclipse Temurin 21.0.12.1+1 SHA-256 from Adoptium API / GitHub checksum files (2026-09-11). */
const TEMURIN_PACKAGES: Record<string, {name:string; sha256:string; archive:'zip'|'tar.gz'; maxBytes:number}> = {
  'linux-x64': {name:'OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz', sha256:'ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94', archive:'tar.gz', maxBytes:400*1024**2},
  'linux-arm64': {name:'OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz', sha256:'23e37e026f12f3e706f18938ff611db3032d075b09d0879a25d06718c773e223', archive:'tar.gz', maxBytes:400*1024**2},
  'darwin-x64': {name:'OpenJDK21U-jdk_x64_mac_hotspot_21.0.12.1_1.tar.gz', sha256:'44db0f08196daf19a47f90d13388b0c943b67663cb537f998fe29e836fa842ce', archive:'tar.gz', maxBytes:400*1024**2},
  'darwin-arm64': {name:'OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz', sha256:'3623232f33a9c3baadf304480b2535f9a3cba8a58d42ecbb438ba267315d9998', archive:'tar.gz', maxBytes:400*1024**2},
  'win32-x64': {name:'OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip', sha256:'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e', archive:'zip', maxBytes:400*1024**2},
  'win32-arm64': {name:'OpenJDK21U-jdk_aarch64_windows_hotspot_21.0.12.1_1.zip', sha256:'ccf2e51f527d542a70ba5794a600d3aac04b4e967950e227834c7566cb1bec7b', archive:'zip', maxBytes:400*1024**2},
};

export type DownloadKind = 'godot'|'godot-templates'|'android-sdk'|'jdk';
export interface DownloadPackage {
  name:string; url:string; sha256?:string; sha512?:string; checksumUrl?:string; version:string;
  entry?:string; kind:DownloadKind; archive:'zip'|'tar.gz'; maxBytes:number; allowedHosts:readonly string[];
  expectedVersion?:string;
  expectedLayout?:readonly string[];
}

export interface AndroidPackageSpec {
  id:string;
  /** Exact `Pkg.Revision` from the package `source.properties` (official repository2-1.xml, 2026-09-11). */
  revision:string;
  directory:string;
  /** Paths relative to `directory`. `adb`/`aapt2` are resolved to `.exe` on Windows. */
  files:readonly string[];
  licenses:readonly string[];
}

/**
 * Pinned Android SDK components from repository2-1.xml (2026-09-11).
 * Platforms use the base (non-ext) package Pkg.Revision. Unknown ids are rejected.
 * NDK/CMake are explicit opt-in selectors only — never part of the default set.
 */
export const ANDROID_PACKAGE_SPECS: Record<string, AndroidPackageSpec> = {
  'platform-tools': {
    id: 'platform-tools', revision: '37.0.1', directory: 'platform-tools',
    files: ['adb'], licenses: ['android-sdk-license'],
  },
  'platforms;android-34': {
    id: 'platforms;android-34', revision: '3', directory: 'platforms/android-34',
    files: ['android.jar'], licenses: ['android-sdk-license'],
  },
  'platforms;android-35': {
    id: 'platforms;android-35', revision: '2', directory: 'platforms/android-35',
    files: ['android.jar'], licenses: ['android-sdk-license'],
  },
  'platforms;android-36': {
    id: 'platforms;android-36', revision: '2', directory: 'platforms/android-36',
    files: ['android.jar'], licenses: ['android-sdk-license'],
  },
  'build-tools;34.0.0': {
    id: 'build-tools;34.0.0', revision: '34.0.0', directory: 'build-tools/34.0.0',
    files: ['aapt2', 'lib/apksigner.jar'], licenses: ['android-sdk-license'],
  },
  'build-tools;35.0.0': {
    id: 'build-tools;35.0.0', revision: '35.0.0', directory: 'build-tools/35.0.0',
    files: ['aapt2', 'lib/apksigner.jar'], licenses: ['android-sdk-license'],
  },
  'build-tools;36.0.0': {
    id: 'build-tools;36.0.0', revision: '36.0.0', directory: 'build-tools/36.0.0',
    files: ['aapt2', 'lib/apksigner.jar'], licenses: ['android-sdk-license'],
  },
  'build-tools;36.1.0': {
    id: 'build-tools;36.1.0', revision: '36.1.0', directory: 'build-tools/36.1.0',
    files: ['aapt2', 'lib/apksigner.jar'], licenses: ['android-sdk-license'],
  },
  'ndk;27.3.13750724': {
    id: 'ndk;27.3.13750724', revision: '27.3.13750724', directory: 'ndk/27.3.13750724',
    files: ['ndk-build'], licenses: ['android-sdk-license'],
  },
  'ndk;28.2.13676358': {
    id: 'ndk;28.2.13676358', revision: '28.2.13676358', directory: 'ndk/28.2.13676358',
    files: ['ndk-build'], licenses: ['android-sdk-license'],
  },
  'cmake;3.22.1': {
    id: 'cmake;3.22.1', revision: '3.22.1', directory: 'cmake/3.22.1',
    files: ['bin/cmake'], licenses: ['android-sdk-license'],
  },
  'cmake;3.31.6': {
    id: 'cmake;3.31.6', revision: '3.31.6', directory: 'cmake/3.31.6',
    files: ['bin/cmake'], licenses: ['android-sdk-license'],
  },
  'cmake;4.1.2': {
    id: 'cmake;4.1.2', revision: '4.1.2', directory: 'cmake/4.1.2',
    files: ['bin/cmake'], licenses: ['android-sdk-license'],
  },
};

/**
 * Hashes for the `android-sdk-license` text in repository2-1.xml (2026-09-11).
 * Includes UTF-8 SHA-1 of the XML text (raw/stripped), Guava `hashUnencodedChars`
 * (UTF-16BE) of the same text, and the historically published sdkmanager hash.
 * Preview/other license ids are not listed and must not be auto-accepted.
 */
export const ANDROID_LICENSE_HASHES: Record<string, readonly string[]> = {
  'android-sdk-license': [
    '24333f8a63b6825ea9c5514f83c2829b004d1fee',
    'efa68a6b3c661d18699d5c026771d5911cdc2f83',
    '9002c006f4b8d9a16e715a9fa4df30ddb8abf9d9',
    'd95d86ff20f0c762f76a3a58865ccc8cc2460084',
    '4d3e3ff8b24b003a83b629cad98e8a9e9df0d0fc',
  ],
};

export const TOOL_CATALOG: ToolCatalogItem[] = [
  {id:'godot', name:'Godot', description:'공식 편집기를 검증해 전용 폴더에 설치합니다.', version:GODOT_VERSION, documentation:'https://godotengine.org/download/archive/4.3-stable/', installable:true, settingsKey:'godot'},
  {id:'godot-templates', name:'Godot 내보내기 템플릿', description:'편집기와 동일한 버전의 Android·iOS·데스크톱 템플릿입니다.', version:GODOT_VERSION, documentation:'https://docs.godotengine.org/en/stable/tutorials/export/exporting_projects.html', installable:true, settingsKey:'godotData'},
  {id:'android-sdk', name:'Android SDK', description:'명령 도구와 Play 제출용 API 36 플랫폼·빌드 도구를 설치합니다. API 34/35와 NDK·CMake는 명시적으로 요청합니다. JDK가 필요합니다.', version:ANDROID_CMDLINE_VERSION, documentation:'https://developer.android.com/tools/sdkmanager', licenseUrl:'https://developer.android.com/studio#command-tools', installable:true, settingsKey:'androidSdk'},
  {id:'jdk', name:'JDK', description:'Eclipse Temurin 21을 검증해 전용 폴더에 설치합니다. 많은 Gradle 프로젝트는 JDK 25를 아직 지원하지 않습니다.', version:TEMURIN_VERSION, documentation:'https://adoptium.net/temurin/releases/?version=21', licenseUrl:'https://adoptium.net/docs/faq/', installable:true, settingsKey:'javaHome'},
  {id:'gradle-cache', name:'Gradle 의존성 캐시', description:'배포판과 프로젝트 의존성의 전용 캐시를 연결합니다. 프로젝트 Gradle을 실행해 채우지 않습니다.', documentation:'https://docs.gradle.org/current/userguide/dependency_caching.html', installable:false, settingsKey:'gradleCache'},
  {id:'unity', name:'Unity Editor', description:'Unity Hub에서 라이선스와 플랫폼 모듈을 준비하고 편집기를 연결합니다.', documentation:'https://docs.unity3d.com/hub/manual/InstallEditors.html', installable:false, settingsKey:'unity'},
  {id:'unreal', name:'Unreal Engine', description:'라이선스가 있는 엔진의 RunUAT 실행 경로를 연결합니다.', documentation:'https://dev.epicgames.com/documentation/en-us/unreal-engine/installing-unreal-engine', installable:false, settingsKey:'unreal'},
  {id:'xcode', name:'Xcode', description:'Mac의 Xcode와 서명 환경을 연결합니다.', documentation:'https://developer.apple.com/xcode/', installable:false, settingsKey:'xcode'},
  {id:'steamcmd', name:'SteamCMD', description:'전용 빌드 계정으로 최초 로그인한 SteamCMD를 연결합니다.', documentation:'https://partner.steamgames.com/doc/sdk/uploading', installable:false, settingsKey:'steamcmd'},
];

function godotEditor(platform: NodeJS.Platform, arch: string): {file:string; entry:string} {
  if (platform === 'linux' && arch === 'x64') return {file:'Godot_v4.3-stable_linux.x86_64.zip', entry:'Godot_v4.3-stable_linux.x86_64'};
  if (platform === 'win32' && arch === 'x64') return {file:'Godot_v4.3-stable_win64.exe.zip', entry:'Godot_v4.3-stable_win64.exe'};
  if (platform === 'darwin') return {file:'Godot_v4.3-stable_macos.universal.zip', entry:'Godot.app/Contents/MacOS/Godot'};
  throw new AppError('INSTALL_PLATFORM', '이 장비용 자동 설치 파일이 없습니다. 기존 도구 경로를 연결해 주세요.');
}

/** Fixed official hosts, artifact versions and publisher hashes (verified 2026-09-11). */
export function packageFor(id: ToolId, platform: NodeJS.Platform = process.platform, arch: string = process.arch): DownloadPackage {
  if (id === 'godot-templates') {
    const name = `Godot_v${GODOT_VERSION}-stable_export_templates.tpz`;
    return {
      name, url: godotBase + name, sha512: GODOT_SHA512[name], checksumUrl: godotBase + 'SHA512-SUMS.txt',
      version: GODOT_VERSION, kind: id, archive: 'zip', maxBytes: 2*1024**3, allowedHosts: GITHUB_RELEASE_HOSTS,
      expectedVersion: GODOT_VERSION, expectedLayout: [`export_templates/${GODOT_TEMPLATE_RELEASE}`],
    };
  }
  if (id === 'godot') {
    const {file, entry} = godotEditor(platform, arch);
    return {
      name: file, url: godotBase + file, sha512: GODOT_SHA512[file], checksumUrl: godotBase + 'SHA512-SUMS.txt',
      version: GODOT_VERSION, entry, kind: id, archive: 'zip', maxBytes: 256*1024**2, allowedHosts: GITHUB_RELEASE_HOSTS,
      expectedVersion: GODOT_VERSION, expectedLayout: [entry],
    };
  }
  if (id === 'android-sdk') {
    const key = platform === 'win32' && arch === 'x64' ? 'win'
      : platform === 'linux' && arch === 'x64' ? 'linux'
      : platform === 'darwin' && arch === 'arm64' ? 'mac_arm64'
      : platform === 'darwin' && arch === 'x64' ? 'mac_x86_64'
      : null;
    const hashes: Record<string, string> = {
      win: '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a',
      linux: '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583',
      mac_arm64: '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e',
      mac_x86_64: 'c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3',
    };
    if (!key) throw new AppError('INSTALL_PLATFORM', '이 장비용 Android SDK 설치를 지원하지 않습니다.');
    const name = `commandlinetools-${key}-${ANDROID_CMDLINE_VERSION}_latest.zip`;
    return {
      name, url: 'https://dl.google.com/android/repository/' + name, sha256: hashes[key],
      version: ANDROID_CMDLINE_VERSION, kind: id, archive: 'zip', maxBytes: 256*1024**2, allowedHosts: GOOGLE_DL_HOSTS,
      expectedLayout: ['cmdline-tools/latest/lib'],
    };
  }
  if (id === 'jdk') {
    const key = `${platform}-${arch}`;
    const artifact = TEMURIN_PACKAGES[key];
    if (!artifact) throw new AppError('INSTALL_PLATFORM', '이 장비용 Temurin 21 설치 파일이 없습니다. 기존 JDK 경로를 연결해 주세요.');
    return {
      name: artifact.name, url: temurinBase + artifact.name, sha256: artifact.sha256, version: TEMURIN_VERSION,
      kind: id, archive: artifact.archive, maxBytes: artifact.maxBytes, allowedHosts: GITHUB_RELEASE_HOSTS,
      expectedVersion: TEMURIN_JAVA_VERSION, expectedLayout: ['bin/java', 'bin/javac'],
    };
  }
  throw new AppError('MANUAL_INSTALL', '해당 도구는 공식 설치 프로그램·라이선스 확인 후 기존 경로를 연결합니다.');
}

export function catalogItem(id: ToolId): ToolCatalogItem | undefined {
  return TOOL_CATALOG.find(item => item.id === id);
}

export const ANDROID_PACKAGE_PATTERN = /^(?:platform-tools|platforms;android-\d+|build-tools;\d+\.\d+\.\d+|ndk;\d+\.\d+\.\d+|cmake;\d+\.\d+\.\d+)$/;

export function androidPackageSpec(id: string): AndroidPackageSpec {
  const spec = ANDROID_PACKAGE_SPECS[id];
  if (!spec) throw new AppError('INVALID_INPUT', '카탈로그에 없는 Android 패키지입니다.');
  return spec;
}

export function normalizeAndroidPackages(packages: string[]): string[] {
  const unique = [...new Set(packages.map(name => name.trim()).filter(Boolean))].sort();
  for (const name of unique) {
    if (!ANDROID_PACKAGE_PATTERN.test(name) || name.length > 80) {
      throw new AppError('INVALID_INPUT', 'Android 패키지 이름을 확인해 주세요.');
    }
    androidPackageSpec(name);
  }
  if (!unique.length) throw new AppError('INVALID_INPUT', 'Android 패키지 이름을 확인해 주세요.');
  return unique;
}

export function androidLicensesFor(packages: string[]): string[] {
  const ids = new Set<string>();
  for (const name of normalizeAndroidPackages(packages)) {
    for (const license of androidPackageSpec(name).licenses) ids.add(license);
  }
  return [...ids].sort();
}

export function androidSdkVersionKey(cmdlineVersion: string, packages: string[]): string {
  const normalized = normalizeAndroidPackages(packages);
  const slug = normalized.map(name => name.replaceAll(';', '-')).join('--');
  const raw = `${cmdlineVersion}--${slug}`;
  if (raw.length <= 120 && !/[<>:"|?*\\]/.test(raw)) return raw;
  return `${cmdlineVersion}--${createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 16)}`;
}
