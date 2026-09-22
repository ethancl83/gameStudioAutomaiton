import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../packages/domain/errors.js';
import { CATALOG } from '../packages/project-integration/catalog.js';
import { packageFor } from '../packages/setup/catalog.js';
import {
  BILLING_JAR_RELATIVE,
  BILLING_SHA256,
  BILLING_URL,
  BILLING_VERSION,
  MAX_SETTINGS_RELATIVE,
  MAX_UNITY_SHA256,
  MAX_UNITY_URL,
  MAX_UNITY_VERSION,
  UNITY_IAP_SHA1,
  UNITY_IAP_SHA256,
  UNITY_IAP_URL,
  UNITY_IAP_VERSION,
  UNITY_ORDER_RELATIVE,
  UNITY_STORE_RELATIVE,
  VERIFICATION_DIR,
  explicitEnv,
  godotBinaryFor,
  sdkReviewRootFor,
} from '../scripts/prepare-verification-tools.js';

test('verification pins match the official publisher checksums and catalog versions', () => {
  assert.equal(CATALOG.unityIap.version, UNITY_IAP_VERSION);
  assert.equal(UNITY_IAP_SHA1, '290a16a9a099dc14a7beed01beef0e3ac0f6fb0a');
  assert.equal(UNITY_IAP_SHA256, 'f7c516d0b6ee44aead758ac000cbec5fa451086da779c94b92005e52e26bb220');
  assert.equal(UNITY_IAP_URL, 'https://download.packages.unity.com/com.unity.purchasing/-/com.unity.purchasing-5.4.2.tgz');
  assert.equal(CATALOG.unityMax.version, MAX_UNITY_VERSION);
  assert.equal(MAX_UNITY_SHA256, '8070203b3e34cd38bb25e3f7eaf8009f4b612029a555cfc628a6f70b3c17220c');
  assert.equal(MAX_UNITY_URL, 'https://github.com/AppLovin/AppLovin-MAX-Unity-Plugin/releases/download/release_8_6_5/AppLovin-MAX-Unity-Plugin-8.6.5-Android-13.6.4-iOS-13.6.4.unitypackage');
  assert.equal(CATALOG.playBilling.version, BILLING_VERSION);
  assert.equal(BILLING_SHA256, 'd28286d4e4c18725510980de01211d9b72501e7146d96817fa0c9999af9b0d22');
  assert.equal(BILLING_URL, 'https://dl.google.com/dl/android/maven2/com/android/billingclient/billing/9.1.0/billing-9.1.0.aar');
});

test('prepared paths stay under the verification directory and follow the host Godot package', () => {
  const root = '/repo';
  assert.equal(sdkReviewRootFor(root), `/repo/${VERIFICATION_DIR}/sdk-review`);
  assert.equal(godotBinaryFor(root, 'darwin', 'arm64'), `/repo/${VERIFICATION_DIR}/godot/Godot.app/Contents/MacOS/Godot`);
  const arm = packageFor('godot', 'linux', 'arm64');
  const x64 = packageFor('godot', 'linux', 'x64');
  assert.equal(godotBinaryFor(root, 'linux', 'arm64'), `/repo/${VERIFICATION_DIR}/godot/${arm.entry}`);
  assert.notEqual(arm.name, x64.name);
  assert.notEqual(arm.sha512, x64.sha512);
  assert.equal(arm.sha512, 'bf559c7d24f2a7c8980d021c9e8c54baa66c5f3a1a0c1fb6fe73586eca63417fd365adf2e6c8be0b5944ab80da800fe4aa3a9024f58363f5dc3962e6127c0dc6');
  assert.equal(UNITY_STORE_RELATIVE, 'unity-iap/package/Runtime/Purchasing/Core/StoreController.cs');
  assert.equal(UNITY_ORDER_RELATIVE, 'unity-iap/package/Runtime/Purchasing/Core/Purchasing/Models/Interfaces/IOrderInfo.cs');
  assert.equal(MAX_SETTINGS_RELATIVE, 'max-unity/ebc0ba1b5ef6b4a6b9dd53d7eadfea16/asset');
  assert.equal(BILLING_JAR_RELATIVE, 'billing/classes.jar');
  assert.throws(() => packageFor('android-sdk', 'linux', 'arm64'), (error: unknown) => error instanceof AppError && error.code === 'INSTALL_PLATFORM');
});

test('empty APPOPS values fail and unset values stay unset', () => {
  const keys = ['APPOPS_BILLING_JAR', 'APPOPS_GODOT', 'APPOPS_SDK_REVIEW_ROOT'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    delete process.env.APPOPS_BILLING_JAR;
    assert.equal(explicitEnv('APPOPS_BILLING_JAR'), undefined);
    process.env.APPOPS_BILLING_JAR = '';
    assert.throws(() => explicitEnv('APPOPS_BILLING_JAR'), /APPOPS_BILLING_JAR가 비어 있습니다/);
    process.env.APPOPS_BILLING_JAR = '   ';
    assert.throws(() => explicitEnv('APPOPS_BILLING_JAR'), /APPOPS_BILLING_JAR가 비어 있습니다/);
    process.env.APPOPS_GODOT = '   ';
    assert.throws(() => explicitEnv('APPOPS_GODOT'), /APPOPS_GODOT가 비어 있습니다/);
    process.env.APPOPS_SDK_REVIEW_ROOT = '';
    assert.throws(() => explicitEnv('APPOPS_SDK_REVIEW_ROOT'), /APPOPS_SDK_REVIEW_ROOT가 비어 있습니다/);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('an explicitly configured SDK root with no Billing JAR fails instead of skipping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'appops-sdk-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, APPOPS_SDK_REVIEW_ROOT: root };
  delete env.APPOPS_BILLING_JAR;
  // This child must run as a separate test process, not inherit the parent test harness.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test',
    '--test-name-pattern=^Android billing calls compile', 'tests/project-integration-template-compile.test.ts'],
  { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /ENOENT/);
  assert.match(result.stdout, /fail 1/);
});
