import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DetectedSdk, IntegrationEngine, IntegrationFinding, SdkDetection } from './types.js';
import { isInside, readTextNoFollow, resolveProjectRoot, toPosix } from './paths.js';
import { lstat, realpath } from 'node:fs/promises';

async function existsFile(root: string, rel: string): Promise<boolean> {
  try {
    const st = await lstat(join(root, rel));
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
}

async function readIfFile(root: string, rel: string): Promise<string | null> {
  try {
    const abs = join(root, rel);
    const st = await lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return await readTextNoFollow(abs);
  } catch {
    return null;
  }
}

async function rootNames(root: string): Promise<string[]> {
  try {
    return await readdir(root);
  } catch {
    return [];
  }
}

export async function detectProjectSdks(projectRoot: string): Promise<SdkDetection> {
  const findings: IntegrationFinding[] = [];
  let root: string;
  try {
    root = await resolveProjectRoot(projectRoot);
  } catch (error) {
    const requested = projectRoot;
    return {
      root: requested,
      engine: 'unknown',
      engineEvidence: [],
      sdks: [],
      findings: [{ code: 'inspect.unreadable', severity: 'error', message: (error as Error).message, path: requested }],
    };
  }

  const evidence: { engine: IntegrationEngine; path: string }[] = [];
  if (await existsFile(root, 'project.godot')) evidence.push({ engine: 'godot', path: 'project.godot' });
  if (await existsFile(root, 'ProjectSettings/ProjectVersion.txt') || await existsFile(root, 'ProjectSettings/ProjectSettings.asset')) {
    evidence.push({ engine: 'unity', path: 'ProjectSettings' });
  }
  const names = await rootNames(root);
  for (const name of names) {
    if (name.endsWith('.uproject')) evidence.push({ engine: 'unreal', path: name });
    if (name.endsWith('.xcodeproj') && name !== 'Unity-iPhone.xcodeproj') evidence.push({ engine: 'ios', path: name });
  }
  const gradle = (await existsFile(root, 'gradlew')) && (
    (await existsFile(root, 'settings.gradle')) || (await existsFile(root, 'settings.gradle.kts'))
    || (await existsFile(root, 'app/build.gradle')) || (await existsFile(root, 'app/build.gradle.kts'))
  );
  const hosted = evidence.some((item) => item.engine === 'godot' || item.engine === 'unity' || item.engine === 'unreal');
  if (gradle && !hosted) evidence.push({ engine: 'android', path: 'gradlew' });

  const primary = pickEngine(evidence, findings);
  const sdks = await detectSdks(root, primary);
  sdks.push(...await detectGameHooks(root));
  return { root, engine: primary, engineEvidence: evidence.map((item) => `${item.engine}:${item.path}`), sdks, findings };
}

function pickEngine(evidence: { engine: IntegrationEngine; path: string }[], findings: IntegrationFinding[]): IntegrationEngine | 'unknown' {
  const order: IntegrationEngine[] = ['godot', 'unity', 'unreal', 'android', 'ios'];
  const unique = [...new Set(evidence.map((item) => item.engine))];
  if (unique.length === 0) return 'unknown';
  const primary = order.find((engine) => unique.includes(engine)) ?? unique[0];
  if (unique.length > 1) {
    findings.push({
      code: 'detect.conflict',
      severity: 'warning',
      message: `여러 엔진 마커가 있습니다 (${unique.join(', ')}). ${primary}를 우선합니다.`,
      fixHint: '한 엔진의 프로젝트 루트를 선택하세요.',
    });
  }
  return primary;
}

async function detectSdks(root: string, engine: IntegrationEngine | 'unknown'): Promise<DetectedSdk[]> {
  const sdks: DetectedSdk[] = [];
  const files = [
    'app/build.gradle', 'app/build.gradle.kts', 'build.gradle', 'build.gradle.kts',
    'Podfile', 'Package.swift', 'Packages/manifest.json',
    'project.godot', 'addons/admob/plugin.cfg', 'addons/GodotGooglePlayBilling/plugin.cfg',
    'Config/DefaultEngine.ini', 'Assets/GoogleMobileAds/Resources/GoogleMobileAdsSettings.asset',
    'app/src/main/assets/appops/max_sdk_key',
  ];
  const blobs: string[] = [];
  for (const rel of files) {
    const text = await readIfFile(root, rel);
    if (text) blobs.push(`${rel}\n${text}`);
  }
  const joined = blobs.join('\n');
  const push = (id: string, evidence: string, version?: string) => {
    if (!sdks.some((item) => item.id === id)) sdks.push({ id, evidence, version });
  };
  if (/play-services-ads/.test(joined)) push('admob-android', 'play-services-ads', versionOf(joined, /play-services-ads(?::|",\s*")([\d.]+)/));
  if (/Google-Mobile-Ads-SDK|GoogleMobileAds/.test(joined)) push('admob-ios', 'Google-Mobile-Ads-SDK');
  if (/com\.google\.ads\.mobile/.test(joined) || /GoogleMobileAdsSettings/.test(joined)) push('unity-admob', 'com.google.ads.mobile');
  if (/applovin-sdk|AppLovinSDK|MaxSdk/.test(joined)) push('applovin-max', 'AppLovin MAX');
  if (/billingclient:billing|BillingClient/.test(joined)) push('play-billing', 'Play Billing Library', versionOf(joined, /billingclient:billing(?::|",\s*")([\d.]+)/));
  if (/com\.unity\.purchasing/.test(joined)) push('unity-iap', 'com.unity.purchasing');
  if (/GodotGooglePlayBilling|addons\/GodotGooglePlayBilling/.test(joined)) push('godot-play-billing', 'GodotGooglePlayBilling');
  if (/addons\/admob/.test(joined) || /poing/.test(joined)) push('godot-admob', 'addons/admob');
  if (/AndroidAdvertising|AdMobAdUnitIDs/.test(joined)) push('unreal-admob', 'AndroidAdvertising');
  if (/StoreKit|\.purchase\(/.test(joined)) push('storekit2', 'StoreKit');
  if (engine === 'godot' && await existsFile(root, 'addons/admob')) push('godot-admob', 'addons/admob');
  if (engine === 'godot' && await existsFile(root, 'addons/GodotGooglePlayBilling')) push('godot-play-billing', 'addons/GodotGooglePlayBilling');
  if (await existsFile(root, 'app/src/main/assets/appops/max_sdk_key')) push('max-runtime-key-hook', 'assets/appops/max_sdk_key');
  return sdks;
}

const HOOK_EXTS = /\.(?:kt|java|cs|swift|gd|cpp|h|mm)$/;
const GENERATED_FILE = /(?:^|\/)(?:AppOps|appops|AppOpsMonetization|addons\/appops_monetization)\//;
const GAME_HOOK_RULES: { id: string; pattern: RegExp }[] = [
  { id: 'game-hook-ad.initialize', pattern: /\bAppOpsAds\s*\.\s*(?:initialize|Initialize)\s*\(/ },
  { id: 'game-hook-ad.show', pattern: /\bAppOpsAds\s*\.\s*(?:showRewarded|ShowRewarded|show_rewarded|ShowBanner)\s*\(/ },
  { id: 'game-hook-ad.reward', pattern: /\boverride\s+.*OnReward|\bon_user_rewarded\s*\(/ },
  { id: 'game-hook-purchase', pattern: /\bAppOps(?:Billing|Purchasing|Store)\s*\.\s*(?:purchase|Purchase)\s*\(/ },
  { id: 'game-hook-restore', pattern: /\bAppOps(?:Billing|Purchasing|Store)\s*\.\s*(?:restore|Restore)\s*\(/ },
];

async function detectGameHooks(root: string): Promise<DetectedSdk[]> {
  const files = await listProjectFiles(root, 800);
  const found: DetectedSdk[] = [];
  for (const rel of files) {
    if (!HOOK_EXTS.test(rel) || GENERATED_FILE.test(rel)) continue;
    const text = await readIfFile(root, rel);
    if (!text) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const rule of GAME_HOOK_RULES) {
      if (rule.pattern.test(code) && !found.some((item) => item.id === rule.id)) {
        found.push({ id: rule.id, evidence: rel });
      }
    }
  }
  return found;
}

function versionOf(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1];
}

export async function listProjectFiles(root: string, max = 4000): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    if (out.length >= max) return;
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (name === '.appops' || name === 'node_modules' || name === '.git' || name === 'Library' || name === '.godot' || name === 'Binaries' || name === 'DerivedData') continue;
      const abs = join(current, name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        let real: string;
        try {
          real = await realpath(abs);
        } catch {
          continue;
        }
        if (!isInside(root, real)) continue;
        await walk(abs);
        continue;
      }
      if (st.isFile()) out.push(toPosix(abs.slice(root.length + 1)));
    }
  }
  await walk(root);
  return out;
}
