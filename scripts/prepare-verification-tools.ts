// 핵심 SDK 4개를 호스트별 공식 아카이브로 tmp/cross-platform-sdk-20260922 에 준비한다.
// Unity IAP 5.4.2, MAX Unity 8.6.5, Play Billing 9.1.0 classes.jar, Godot 4.7.2.
// 전역 설치, 라이선스 자동 동의, 계정 인증은 하지 않는다. JDK와 Android cmdline은 받지 않는다.
// 실행: node --import tsx scripts/prepare-verification-tools.ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CATALOG } from '../packages/project-integration/catalog.js';
import { GODOT_VERSION, GITHUB_RELEASE_HOSTS, GOOGLE_DL_HOSTS, packageFor } from '../packages/setup/catalog.js';
import { downloadVerified, extractTarGz, fetchOfficial } from '../packages/setup/download.js';
import { extractZip } from '../packages/setup/archive.js';

export const VERIFICATION_DIR = 'tmp/cross-platform-sdk-20260922';

export const UNITY_IAP_VERSION = '5.4.2';
/** packages.unity.com dist.shasum for com.unity.purchasing 5.4.2. */
export const UNITY_IAP_SHA1 = '290a16a9a099dc14a7beed01beef0e3ac0f6fb0a';
export const UNITY_IAP_SHA256 = 'f7c516d0b6ee44aead758ac000cbec5fa451086da779c94b92005e52e26bb220';
export const UNITY_IAP_URL = 'https://download.packages.unity.com/com.unity.purchasing/-/com.unity.purchasing-5.4.2.tgz';
export const UNITY_HOSTS = ['download.packages.unity.com', 'packages.unity.com', 'cdn.packages.unity.com'] as const;
export const UNITY_STORE_RELATIVE = 'unity-iap/package/Runtime/Purchasing/Core/StoreController.cs';
export const UNITY_ORDER_RELATIVE = 'unity-iap/package/Runtime/Purchasing/Core/Purchasing/Models/Interfaces/IOrderInfo.cs';

export const MAX_UNITY_VERSION = '8.6.5';
/** GitHub release asset digest for AppLovin-MAX-Unity-Plugin 8.6.5. */
export const MAX_UNITY_SHA256 = '8070203b3e34cd38bb25e3f7eaf8009f4b612029a555cfc628a6f70b3c17220c';
export const MAX_UNITY_URL = 'https://github.com/AppLovin/AppLovin-MAX-Unity-Plugin/releases/download/release_8_6_5/AppLovin-MAX-Unity-Plugin-8.6.5-Android-13.6.4-iOS-13.6.4.unitypackage';
export const MAX_SETTINGS_RELATIVE = 'max-unity/ebc0ba1b5ef6b4a6b9dd53d7eadfea16/asset';

export const BILLING_VERSION = '9.1.0';
/** dl.google.com billing-9.1.0.aar.sha256. */
export const BILLING_SHA256 = 'd28286d4e4c18725510980de01211d9b72501e7146d96817fa0c9999af9b0d22';
export const BILLING_URL = 'https://dl.google.com/dl/android/maven2/com/android/billingclient/billing/9.1.0/billing-9.1.0.aar';
export const BILLING_JAR_RELATIVE = 'billing/classes.jar';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function explicitEnv(name: string): string | undefined {
  if (!Object.hasOwn(process.env, name)) return undefined;
  const value = process.env[name] ?? '';
  if (!value.trim()) throw new Error(`${name}가 비어 있습니다.`);
  return value;
}

export function verificationRoot(root = repoRoot): string {
  return join(root, VERIFICATION_DIR);
}

export function sdkReviewRootFor(root = repoRoot): string {
  return join(verificationRoot(root), 'sdk-review');
}

export function godotBinaryFor(root = repoRoot, platform: NodeJS.Platform = process.platform, arch = process.arch): string {
  const pkg = packageFor('godot', platform, arch);
  return join(verificationRoot(root), 'godot', pkg.entry ?? '');
}

export function downloadPath(root: string, fileName: string): string {
  return join(verificationRoot(root), 'downloads', fileName);
}

export interface VerificationManifest {
  platform: string;
  arch: string;
  verificationDir: string;
  sdkReviewRoot: string;
  billingJar: string;
  godot: string;
  relative: { sdkReviewRoot: string; billingJar: string; godot: string };
  tools: Array<{ id: string; version: string; url: string; bytes: number; sha256?: string; sha512?: string }>;
}

function assertPinnedVersions(): void {
  if (CATALOG.unityIap.version !== UNITY_IAP_VERSION) throw new Error('Unity IAP 카탈로그 버전이 준비 핀과 다릅니다.');
  if (CATALOG.unityMax.version !== MAX_UNITY_VERSION) throw new Error('Unity MAX 카탈로그 버전이 준비 핀과 다릅니다.');
  if (CATALOG.playBilling.version !== BILLING_VERSION) throw new Error('Play Billing 카탈로그 버전이 준비 핀과 다릅니다.');
  if (GODOT_VERSION !== '4.7.2') throw new Error('Godot 카탈로그 버전이 4.7.2이 아닙니다.');
}

async function digestFile(path: string, algorithm: 'sha1' | 'sha256' | 'sha512'): Promise<string | undefined> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readText(url: string, allowedHosts: readonly string[]): Promise<string> {
  const fetched = await fetchOfficial(fetch, url, allowedHosts);
  if (!fetched.response.ok) throw new Error(`공식 메타데이터를 받지 못했습니다 (${fetched.response.status}): ${url}`);
  return fetched.response.text();
}

async function assertUnityRegistry(): Promise<void> {
  const text = await readText('https://packages.unity.com/com.unity.purchasing', UNITY_HOSTS);
  const body = JSON.parse(text) as { versions?: Record<string, { dist?: { shasum?: string; tarball?: string } }> };
  const dist = body.versions?.[UNITY_IAP_VERSION]?.dist;
  if (dist?.shasum !== UNITY_IAP_SHA1) throw new Error('Unity 레지스트리 shasum이 고정값과 다릅니다.');
  if (dist?.tarball !== UNITY_IAP_URL) throw new Error('Unity 레지스트리 tarball 주소가 고정값과 다릅니다.');
}

async function assertPublishedBillingSha256(): Promise<void> {
  const text = (await readText(`${BILLING_URL}.sha256`, GOOGLE_DL_HOSTS)).trim().toLowerCase();
  const token = text.split(/\s+/)[0] ?? '';
  if (token !== BILLING_SHA256) throw new Error('Play Billing 발행 SHA-256이 고정값과 다릅니다.');
}

async function ensureArchive(options: {
  destination: string;
  url: string;
  sha256?: string;
  sha512?: string;
  maxBytes: number;
  allowedHosts: readonly string[];
  beforeDownload?: () => Promise<void>;
}): Promise<{ path: string; bytes: number; sha256: string; sha512: string; cached: boolean }> {
  const cached256 = options.sha256 ? await digestFile(options.destination, 'sha256') : undefined;
  const cached512 = options.sha512 ? await digestFile(options.destination, 'sha512') : undefined;
  if ((options.sha256 && cached256 === options.sha256) || (options.sha512 && cached512 === options.sha512)) {
    const info = await stat(options.destination);
    const sha256 = cached256 ?? await digestFile(options.destination, 'sha256');
    const sha512 = cached512 ?? await digestFile(options.destination, 'sha512');
    return { path: options.destination, bytes: info.size, sha256: sha256!, sha512: sha512!, cached: true };
  }
  await options.beforeDownload?.();
  await rm(options.destination, { force: true });
  const result = await downloadVerified({
    url: options.url,
    destination: options.destination,
    sha256: options.sha256,
    sha512: options.sha512,
    maxBytes: options.maxBytes,
    allowedHosts: options.allowedHosts,
  });
  return { path: options.destination, bytes: result.bytes, sha256: result.sha256, sha512: result.sha512, cached: false };
}

async function extractArchive(archive: string, destination: string, kind: 'zip' | 'tar.gz'): Promise<void> {
  const stage = `${destination}.stage`;
  await rm(stage, { recursive: true, force: true });
  await rm(destination, { recursive: true, force: true });
  if (kind === 'zip') await extractZip(archive, stage);
  else await extractTarGz(archive, stage);
  await rename(stage, destination);
}

export async function prepareVerificationTools(options: {
  repoRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): Promise<VerificationManifest> {
  assertPinnedVersions();
  const root = options.repoRoot ?? repoRoot;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const base = verificationRoot(root);
  const review = sdkReviewRootFor(root);
  const downloads = join(base, 'downloads');
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  await mkdir(review, { recursive: true, mode: 0o700 });
  const tools: VerificationManifest['tools'] = [];

  const unityArchive = join(downloads, 'com.unity.purchasing-5.4.2.tgz');
  const unity = await ensureArchive({
    destination: unityArchive,
    url: UNITY_IAP_URL,
    sha256: UNITY_IAP_SHA256,
    maxBytes: 16 * 1024 * 1024,
    allowedHosts: UNITY_HOSTS,
    beforeDownload: assertUnityRegistry,
  });
  const unitySha1 = await digestFile(unity.path, 'sha1');
  if (unitySha1 !== UNITY_IAP_SHA1) throw new Error('Unity IAP 아카이브 SHA-1이 레지스트리 shasum과 다릅니다.');
  await extractArchive(unity.path, join(review, 'unity-iap'), 'tar.gz');
  tools.push({ id: 'unity-iap', version: UNITY_IAP_VERSION, url: UNITY_IAP_URL, bytes: unity.bytes, sha256: unity.sha256 });

  const maxArchive = join(downloads, 'AppLovin-MAX-Unity-Plugin-8.6.5.unitypackage');
  const max = await ensureArchive({
    destination: maxArchive,
    url: MAX_UNITY_URL,
    sha256: MAX_UNITY_SHA256,
    maxBytes: 8 * 1024 * 1024,
    allowedHosts: GITHUB_RELEASE_HOSTS,
  });
  await extractArchive(max.path, join(review, 'max-unity'), 'tar.gz');
  tools.push({ id: 'max-unity', version: MAX_UNITY_VERSION, url: MAX_UNITY_URL, bytes: max.bytes, sha256: max.sha256 });

  const billingArchive = join(downloads, 'billing-9.1.0.aar');
  const billing = await ensureArchive({
    destination: billingArchive,
    url: BILLING_URL,
    sha256: BILLING_SHA256,
    maxBytes: 8 * 1024 * 1024,
    allowedHosts: GOOGLE_DL_HOSTS,
    beforeDownload: assertPublishedBillingSha256,
  });
  const billingJar = join(review, BILLING_JAR_RELATIVE);
  const billingStage = join(base, '.stage-billing');
  await extractArchive(billing.path, billingStage, 'zip');
  await mkdir(dirname(billingJar), { recursive: true, mode: 0o700 });
  await copyFile(join(billingStage, 'classes.jar'), billingJar);
  await rm(billingStage, { recursive: true, force: true });
  tools.push({ id: 'play-billing', version: BILLING_VERSION, url: BILLING_URL, bytes: billing.bytes, sha256: billing.sha256 });

  const godotPkg = packageFor('godot', platform, arch);
  const godotArchive = join(downloads, godotPkg.name);
  const godot = await ensureArchive({
    destination: godotArchive,
    url: godotPkg.url,
    sha512: godotPkg.sha512,
    maxBytes: godotPkg.maxBytes,
    allowedHosts: godotPkg.allowedHosts,
  });
  const godotDest = join(base, 'godot');
  const godotBinary = join(godotDest, godotPkg.entry ?? '');
  await extractArchive(godot.path, godotDest, 'zip');
  await chmod(godotBinary, 0o700);
  tools.push({ id: 'godot', version: godotPkg.version, url: godotPkg.url, bytes: godot.bytes, sha256: godot.sha256, sha512: godot.sha512 });

  const relativeGodot = join(VERIFICATION_DIR, 'godot', godotPkg.entry ?? '');
  const manifest: VerificationManifest = {
    platform, arch,
    verificationDir: base,
    sdkReviewRoot: review,
    billingJar,
    godot: godotBinary,
    relative: {
      sdkReviewRoot: join(VERIFICATION_DIR, 'sdk-review'),
      billingJar: join(VERIFICATION_DIR, 'sdk-review', BILLING_JAR_RELATIVE),
      godot: relativeGodot,
    },
    tools,
  };
  await writeFile(join(base, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  prepareVerificationTools().then(manifest => {
    process.stdout.write(`${manifest.relative.sdkReviewRoot}\n${manifest.relative.billingJar}\n${manifest.relative.godot}\n`);
  }, error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
