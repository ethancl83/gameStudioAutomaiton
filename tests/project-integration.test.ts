import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyIntegration as rawApply,
  CATALOG,
  detectProjectSdks,
  previewIntegration as rawPreview,
  rollbackIntegration as rawRollback,
  withIntegrationStorage,
} from '../packages/project-integration/index.js';
import type { IntegrationRequest } from '../packages/project-integration/index.js';

const previewIntegration=(input:IntegrationRequest)=>withIntegrationStorage(input.projectRoot,input.projectRoot+'.state',()=>rawPreview(input));
const applyIntegration=(input:Parameters<typeof rawApply>[0])=>withIntegrationStorage(input.projectRoot!,input.projectRoot!+'.state',()=>rawApply(input));
const rollbackIntegration=(id:string,root:string)=>withIntegrationStorage(root,root+'.state',()=>rawRollback(id,root));

async function tempDir(t: { after: (fn: () => void | Promise<void>) => void }, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(dir+'.state', { recursive: true, force: true }); });
  return dir;
}

async function write(root: string, rel: string, contents: string): Promise<void> {
  const target = join(root, rel);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

function androidProject(): { gradle: string; manifest: string } {
  return {
    gradle: `plugins { id 'com.android.application' }
android {
  namespace 'com.harbor.game'
  defaultConfig { applicationId "com.harbor.game" }
}
dependencies {
  implementation 'androidx.appcompat:appcompat:1.7.0'
}
`,
    manifest: `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Harbor">
    </application>
</manifest>
`,
  };
}

const AD_APP = 'ca-app-pub-3940256099942544~3347511713';
const AD_UNIT = 'ca-app-pub-3940256099942544/5224354917';

function admobAndroid(root: string): IntegrationRequest {
  return {
    projectRoot: root,
    engine: 'android',
    platform: 'android',
    provider: 'admob',
    appId: AD_APP,
    adUnits: [{ adUnitId: AD_UNIT, adFormat: 'REWARD' }],
    products: [{ productId: 'coins_100', productType: 'inapp' }],
    options: { includePurchases: true },
  };
}

test('detects Android project and existing play-services-ads without executing gradle', async (t) => {
  const root = await tempDir(t, 'appops-int-detect-');
  const files = androidProject();
  await write(root, 'gradlew', '#!/bin/sh\necho SHOULD_NOT_RUN\nexit 99\n');
  await chmod(join(root, 'gradlew'), 0o755);
  await write(root, 'settings.gradle', "include ':app'\n");
  await write(root, 'app/build.gradle', files.gradle.replace(
    "implementation 'androidx.appcompat:appcompat:1.7.0'",
    "implementation 'com.google.android.gms:play-services-ads:24.0.0'",
  ));
  await write(root, 'app/src/main/AndroidManifest.xml', files.manifest);
  const detection = await detectProjectSdks(root);
  assert.equal(detection.engine, 'android');
  assert.ok(detection.sdks.some((sdk) => sdk.id === 'admob-android'));
});

test('preview and apply write official AdMob/Play Billing versions, then rollback restores originals', async (t) => {
  const root = await tempDir(t, 'appops-int-android-');
  const files = androidProject();
  await write(root, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(root, 'settings.gradle', "include ':app'\n");
  await write(root, 'app/build.gradle', files.gradle);
  await write(root, 'app/src/main/AndroidManifest.xml', files.manifest);
  const originalGradle = files.gradle;

  const preview = await previewIntegration(admobAndroid(root));
  assert.equal(preview.supported, true);
  assert.ok(preview.catalog.some((item) => item.artifact === CATALOG.admobAndroid.artifact && item.version === '25.4.0'));
  assert.ok(preview.catalog.some((item) => item.artifact === CATALOG.playBilling.artifact && item.version === '9.1.0'));
  assert.ok(preview.wiring.some((item) => item.event === 'ad.initialize' && item.status === 'installed_unwired'));
  assert.ok(preview.wiring.some((item) => item.event === 'ad.reward' && item.status === 'installed_unwired'));
  assert.ok(preview.wiring.some((item) => item.event === 'purchase' && item.status === 'installed_unwired'));
  assert.ok(preview.wiring.some((item) => item.event === 'restore' && item.status === 'installed_unwired'));
  assert.match(JSON.stringify(preview), /25\.4\.0/);
  assert.doesNotMatch(JSON.stringify(preview), /sdkKey":\s*"[^«]/);

  const applied = await applyIntegration({ previewId: preview.previewId, projectRoot: root });
  assert.equal(applied.status, 'applied');
  const gradle = await readFile(join(root, 'app/build.gradle'), 'utf8');
  assert.match(gradle, /play-services-ads:25\.4\.0/);
  assert.match(gradle, /billing:9\.1\.0/);
  assert.match(gradle, /androidx.appcompat:appcompat:1.7.0/);
  const manifest = await readFile(join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /com\.google\.android\.gms\.ads\.APPLICATION_ID/);
  assert.match(manifest, /ca-app-pub-3940256099942544~3347511713/);
  assert.match(manifest, /com\.android\.vending\.BILLING/);
  const ads = await readFile(join(root, 'app/src/main/java/appops/monetization/AppOpsAds.kt'), 'utf8');
  assert.match(ads, /MobileAds\.initialize/);
  assert.match(ads, /RewardedAd\.load/);
  assert.match(ads, /OnUserEarnedRewardListener/);
  assert.match(ads, /ca-app-pub-3940256099942544\/5224354917/);
  const billing = await readFile(join(root, 'app/src/main/java/appops/monetization/AppOpsBilling.kt'), 'utf8');
  assert.match(billing, /queryProductDetailsAsync/);
  assert.match(billing, /launchBillingFlow/);
  assert.match(billing, /queryPurchasesAsync/);
  assert.match(billing, /completeVerifiedPurchase/);
  assert.match(billing, /VerificationRequired/);
  assert.match(billing, /coins_100/);
  assert.doesNotMatch(billing.split('fun handlePurchases')[1] ?? billing.split('private fun handlePurchases')[1] ?? '', /acknowledgePurchase/);
  assert.notEqual(applied.afterHash, preview.beforeHash);

  const rolled = await rollbackIntegration(applied.applyId, root);
  assert.equal(rolled.status, 'rolled_back');
  assert.equal(await readFile(join(root, 'app/build.gradle'), 'utf8'), originalGradle);
});

test('rejects MAX SDK key in the request and writes only the official placeholder', async (t) => {
  const root = await tempDir(t, 'appops-int-max-');
  const files = androidProject();
  await write(root, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(root, 'settings.gradle', "include ':app'\n");
  await write(root, 'app/build.gradle', files.gradle);
  await write(root, 'app/src/main/AndroidManifest.xml', files.manifest);
  await assert.rejects(
    () => previewIntegration({
      projectRoot: root,
      engine: 'android',
      platform: 'android',
      provider: 'applovin-max',
      adUnits: [{ adUnitId: 'abc123xyz', adFormat: 'REWARD' }],
      options: { maxSdkKeyBound: true, sdkKey: 'SUPER-SECRET-KEY' } as never,
    }),
    /SDK 키|SECRET/,
  );
  const preview = await previewIntegration({
    projectRoot: root,
    engine: 'android',
    platform: 'android',
    provider: 'applovin-max',
    adUnits: [{ adUnitId: 'abc123xyz', adFormat: 'REWARD' }],
    options: { maxSdkKeyBound: true },
  });
  const applied = await applyIntegration({ previewId: preview.previewId, projectRoot: root });
  assert.equal(applied.status, 'applied');
  const gradle = await readFile(join(root, 'app/build.gradle'), 'utf8');
  assert.match(gradle, /com\.applovin:applovin-sdk:13\.6\.4/);
  const runtime = await readFile(join(root, 'appops/max-runtime.properties'), 'utf8');
  assert.match(runtime, /«SDK-key»/);
  assert.match(runtime, /sdk_key_bound=true/);
  assert.doesNotMatch(runtime, /SUPER-SECRET/);
  const ads = await readFile(join(root, 'app/src/main/java/appops/monetization/AppOpsAds.kt'), 'utf8');
  assert.match(ads, /AppLovinSdkInitializationConfiguration/);
  assert.match(ads, /MaxRewardedAd\.getInstance/);
  assert.match(ads, /onUserRewarded/);
  assert.match(ads, /runtimeSdkKey/);
});

test('concurrent edit after preview is a conflict, not a silent overwrite', async (t) => {
  const root = await tempDir(t, 'appops-int-conflict-');
  const files = androidProject();
  await write(root, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(root, 'settings.gradle', "include ':app'\n");
  await write(root, 'app/build.gradle', files.gradle);
  await write(root, 'app/src/main/AndroidManifest.xml', files.manifest);
  const preview = await previewIntegration(admobAndroid(root));
  await write(root, 'app/build.gradle', `${files.gradle}\n// edited by user\n`);
  const applied = await applyIntegration({ previewId: preview.previewId, projectRoot: root });
  assert.equal(applied.status, 'conflict');
  assert.ok(applied.findings.some((item) => item.code === 'apply.concurrent_edit'));
  assert.match(await readFile(join(root, 'app/build.gradle'), 'utf8'), /edited by user/);
  assert.doesNotMatch(await readFile(join(root, 'app/build.gradle'), 'utf8'), /play-services-ads:25\.4\.0/);
});

test('symlink targets are rejected and unknown gradle format is not overwritten', async (t) => {
  const root = await tempDir(t, 'appops-int-symlink-');
  const outside = join(root, '..', `outside-${Date.now()}.gradle`);
  t.after(() => rm(outside, { force: true }));
  await writeFile(outside, 'SECRET-OUTSIDE\n', 'utf8');
  await write(root, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(root, 'settings.gradle', "include ':app'\n");
  await mkdir(join(root, 'app'), { recursive: true });
  await symlink(outside, join(root, 'app/build.gradle'));
  await write(root, 'app/src/main/AndroidManifest.xml', androidProject().manifest);
  const preview = await previewIntegration(admobAndroid(root));
  assert.equal(preview.supported, false);
  assert.ok(preview.findings.some((item) => item.code === 'path.symlink' || item.code === 'format.unknown_block'));

  const plain = await tempDir(t, 'appops-int-weird-');
  await write(plain, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(plain, 'settings.gradle', "include ':app'\n");
  await write(plain, 'app/build.gradle', 'THIS IS NOT GRADLE\n');
  await write(plain, 'app/src/main/AndroidManifest.xml', androidProject().manifest);
  const weird = await previewIntegration(admobAndroid(plain));
  assert.equal(weird.supported, false);
  assert.ok(weird.findings.some((item) => item.code === 'format.unknown_block'));
  assert.equal(await readFile(join(plain, 'app/build.gradle'), 'utf8'), 'THIS IS NOT GRADLE\n');
});

test('existing different AdMob version is an actionable conflict', async (t) => {
  const root = await tempDir(t, 'appops-int-ver-');
  const files = androidProject();
  await write(root, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(root, 'settings.gradle', "include ':app'\n");
  await write(root, 'app/build.gradle', files.gradle.replace(
    "implementation 'androidx.appcompat:appcompat:1.7.0'",
    "implementation 'com.google.android.gms:play-services-ads:24.0.0'",
  ));
  await write(root, 'app/src/main/AndroidManifest.xml', files.manifest);
  const preview = await previewIntegration(admobAndroid(root));
  assert.equal(preview.supported, false);
  assert.ok(preview.findings.some((item) => item.code === 'conflict.existing_admob_version'));
});

test('Unity, Godot and Unreal templates write official package/module wiring', async (t) => {
  const root = await tempDir(t, 'appops-int-engines-');

  const unity = join(root, 'unity');
  await write(unity, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.21f1\n');
  await write(unity, 'ProjectSettings/ProjectSettings.asset', 'productName: Harbor\n');
  await write(unity, 'Packages/manifest.json', '{ "dependencies": { "com.unity.modules.jsonserialize": "1.0.0" } }\n');
  const unityPreview = await previewIntegration({
    projectRoot: unity,
    engine: 'unity',
    platform: 'android',
    provider: 'admob',
    appId: AD_APP,
    adUnits: [{ adUnitId: AD_UNIT, adFormat: 'REWARD' }],
    products: [{ productId: 'gems_50' }],
    options: { includePurchases: true },
  });
  assert.equal(unityPreview.supported, true);
  assert.ok(unityPreview.catalog.some((item) => item.version === '11.5.0' && item.artifact === 'com.google.ads.mobile'));
  assert.ok(unityPreview.catalog.some((item) => item.version === '5.4.2'));
  const unityApply = await applyIntegration({ previewId: unityPreview.previewId, projectRoot: unity });
  assert.equal(unityApply.status, 'applied');
  const unityManifest = JSON.parse(await readFile(join(unity, 'Packages/manifest.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.equal(unityManifest.dependencies['com.google.ads.mobile'], '11.5.0');
  assert.equal(unityManifest.dependencies['com.unity.purchasing'], '5.4.2');
  assert.equal(unityManifest.dependencies['com.unity.modules.jsonserialize'], '1.0.0');
  const unityAds = await readFile(join(unity, 'Assets/AppOps/AppOpsAds.cs'), 'utf8');
  assert.match(unityAds, /MobileAds\.Initialize/);
  assert.match(unityAds, /RewardedAd\.Load/);
  const unityIap = await readFile(join(unity, 'Assets/AppOps/AppOpsPurchasing.cs'), 'utf8');
  assert.match(unityIap, /FetchProducts\(Catalog\)/);
  assert.match(unityIap, /List<ProductDefinition>/);
  assert.match(unityIap, /RestoreTransactions\(\(ok, error\)/);
  assert.match(unityIap, /ConfirmPurchase/);
  assert.doesNotMatch(unityIap, /Acknowledge\s*\(/);
  assert.match(unityIap, /CompleteVerifiedPurchase/);
  assert.ok(unityPreview.wiring.every((item) => item.status !== 'wired'));

  const godot = join(root, 'godot');
  await write(godot, 'project.godot', '[application]\nconfig/name="Harbor"\n');
  const godotPreview = await previewIntegration({
    projectRoot: godot,
    engine: 'godot',
    platform: 'android',
    provider: 'admob',
    appId: AD_APP,
    adUnits: [{ adUnitId: AD_UNIT, adFormat: 'REWARD' }],
    products: [{ productId: 'coins_100' }],
  });
  assert.ok(godotPreview.findings.some((item) => item.code === 'plugin.godot_admob_missing'));
  assert.ok(godotPreview.wiring.some((item) => item.status === 'installed_unwired' || item.path?.includes('app_ops_ads')));
  const godotApply = await applyIntegration({ previewId: godotPreview.previewId, projectRoot: godot });
  assert.equal(godotApply.status, 'applied');
  const gd = await readFile(join(godot, 'addons/appops_monetization/app_ops_ads.gd'), 'utf8');
  assert.match(gd, /MobileAds\.initialize/);
  assert.match(gd, /poingstudios/);
  const bill = await readFile(join(godot, 'addons/appops_monetization/app_ops_billing.gd'), 'utf8');
  assert.match(bill, /BillingClient/);
  assert.match(bill, /does not download plugin zips/);

  const unreal = join(root, 'unreal');
  await write(unreal, 'Harbor.uproject', '{"FileVersion":3,"EngineAssociation":"5.4"}\n');
  await write(unreal, 'Config/DefaultEngine.ini', '[/Script/Engine.Engine]\n');
  await write(unreal, 'Source/Harbor.Target.cs', `using UnrealBuildTool;
public class HarborTarget : TargetRules
{
    public HarborTarget(TargetInfo Target) : base(Target)
    {
        ExtraModuleNames.Add("Harbor");
    }
}
`);
  const unrealPreview = await previewIntegration({
    projectRoot: unreal,
    engine: 'unreal',
    platform: 'android',
    provider: 'admob',
    appId: AD_APP,
    adUnits: [{ adUnitId: AD_UNIT, adFormat: 'REWARD' }],
    products: [{ productId: 'coins_100' }],
  });
  const unrealApply = await applyIntegration({ previewId: unrealPreview.previewId, projectRoot: unreal });
  assert.equal(unrealApply.status, 'applied');
  const ini = await readFile(join(unreal, 'Config/DefaultEngine.ini'), 'utf8');
  assert.match(ini, /AdMobAdUnitIDs=/);
  assert.match(ini, /ca-app-pub-3940256099942544\/5224354917/);
  const target = await readFile(join(unreal, 'Source/Harbor.Target.cs'), 'utf8');
  assert.match(target, /AndroidAdvertising/);
  assert.match(target, /OnlineSubsystemGooglePlay/);
  const adsCpp = await readFile(join(unreal, 'Source/Harbor/AppOpsAds.cpp'), 'utf8');
  assert.match(adsCpp, /IAdvertisingProvider/);
  assert.match(adsCpp, /ShowAdBanner/);
  assert.match(adsCpp, /ShowInterstitialAd/);
  assert.doesNotMatch(adsCpp, /ShowRewardedAd/);
  const storeCpp = await readFile(join(unreal, 'Source/Harbor/AppOpsStore.cpp'), 'utf8');
  assert.match(storeCpp, /Checkout/);
  assert.match(storeCpp, /QueryReceipts/);
  assert.match(storeCpp, /FinalizePurchase/);
  assert.match(storeCpp, /AppOpsCompleteVerifiedPurchase/);
});

test('unsupported engine and iOS StoreKit template, invalid IDs, secrets', async (t) => {
  const root = await tempDir(t, 'appops-int-scope-');
  await write(root, 'project.godot', '[application]\nconfig/name="X"\n');
  const unknown = await previewIntegration({
    projectRoot: root,
    engine: 'godot',
    platform: 'android',
    provider: 'applovin-max',
    adUnits: [{ adUnitId: 'abc123xyz' }],
  });
  assert.equal(unknown.supported, false);
  assert.ok(unknown.findings.some((item) => item.code === 'scope.godot_max_unsupported'));

  const ios = join(root, 'ios');
  await write(ios, 'App.xcodeproj/project.pbxproj', '// fake\n');
  await write(ios, 'Podfile', "platform :ios, '13.0'\ntarget 'App' do\n  use_frameworks!\nend\n");
  await write(ios, 'Info.plist', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict></dict></plist>
`);
  const iosPreview = await previewIntegration({
    projectRoot: ios,
    engine: 'ios',
    platform: 'ios',
    provider: 'admob',
    appId: 'ca-app-pub-3940256099942544~1458002511',
    adUnits: [{ adUnitId: 'ca-app-pub-3940256099942544/1712485313', adFormat: 'REWARD' }],
    products: [{ productId: 'premium_unlock' }],
    options: { includePurchases: true },
  });
  assert.equal(iosPreview.supported, false);
  assert.ok(iosPreview.findings.some((item) => item.code === 'format.pbxproj'));
  assert.ok(iosPreview.plannedChanges.some((item) => item.path.endsWith('AppOpsStore.swift')));

  const badId = await previewIntegration({
    projectRoot: ios,
    engine: 'ios',
    platform: 'ios',
    provider: 'admob',
    appId: 'not-an-id',
    adUnits: [{ adUnitId: 'nope' }],
  });
  assert.ok(badId.findings.some((item) => item.code === 'id.app_invalid' || item.code === 'id.ad_unit_invalid'));

  await assert.rejects(
    () => previewIntegration({
      projectRoot: ios,
      engine: 'ios',
      platform: 'ios',
      provider: 'admob',
      appId: AD_APP,
      options: { apiKey: 'AAAA' } as never,
    }),
    /SECRET|키/,
  );
});

test('self-closing application and module gradle.kts receive official patches', async (t) => {
  const root = await tempDir(t, 'appops-int-kts-');
  await write(root, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(root, 'settings.gradle.kts', 'include(":app")\n');
  await write(root, 'app/build.gradle.kts', `plugins { id("com.android.application") }
android { namespace = "com.harbor.game" }
dependencies {
}
`);
  await write(root, 'app/src/main/AndroidManifest.xml', `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Harbor"/></manifest>\n`);
  const preview = await previewIntegration(admobAndroid(root));
  assert.equal(preview.supported, true);
  const applied = await applyIntegration({ previewId: preview.previewId, projectRoot: root });
  assert.equal(applied.status, 'applied');
  const gradle = await readFile(join(root, 'app/build.gradle.kts'), 'utf8');
  assert.match(gradle, /play-services-ads:25\.4\.0/);
  const manifest = await readFile(join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /<application[^>]*>/);
  assert.match(manifest, /<\/application>/);
  assert.match(manifest, /APPLICATION_ID/);
});

test('game-owned hook files mark wiring wired; comments do not', async (t) => {
  const root = await tempDir(t, 'appops-int-hook-');
  const files = androidProject();
  await write(root, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(root, 'settings.gradle', "include ':app'\n");
  await write(root, 'app/build.gradle', files.gradle);
  await write(root, 'app/src/main/AndroidManifest.xml', files.manifest);
  await write(root, 'app/src/main/java/com/harbor/Game.kt', `package com.harbor
class Game {
    fun start(activity: android.app.Activity) {
        appops.monetization.AppOpsAds.initialize(activity)
        appops.monetization.AppOpsAds.showRewarded(activity)
        appops.monetization.AppOpsBilling.purchase(activity, "coins_100")
        appops.monetization.AppOpsBilling.restore()
    }
}
`);
  const preview = await previewIntegration(admobAndroid(root));
  assert.ok(preview.wiring.some((item) => item.event === 'ad.initialize' && item.status === 'wired'));
  assert.ok(preview.wiring.some((item) => item.event === 'ad.show' && item.status === 'wired'));
  assert.ok(preview.wiring.some((item) => item.event === 'purchase' && item.status === 'wired'));
});

test('tampered protected preview is rejected before any source write', async (t) => {
  const root = await tempDir(t, 'appops-int-fail-');
  const files = androidProject();
  await write(root, 'gradlew', '#!/bin/sh\nexit 0\n');
  await write(root, 'settings.gradle', "include ':app'\n");
  await write(root, 'app/build.gradle', files.gradle);
  await write(root, 'app/src/main/AndroidManifest.xml', files.manifest);
  const preview = await previewIntegration(admobAndroid(root));
  const storedPath = join(root+'.state', 'previews', `${preview.previewId}.json`);
  const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { changes: { path: string; content?: string }[] };
  stored.changes.push({ path: '../escape.txt', content: 'nope' });
  await writeFile(storedPath, JSON.stringify(stored), 'utf8');
  await assert.rejects(() => applyIntegration({ previewId: preview.previewId, projectRoot: root }), /SDK|기록/);
  assert.equal(await readFile(join(root, 'app/build.gradle'), 'utf8'), files.gradle);
});
