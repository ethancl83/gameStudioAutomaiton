import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { AppError } from '../domain/errors.js';
import { catalogFor, MAX_SDK_PLACEHOLDER } from './catalog.js';
import { detectProjectSdks } from './detect.js';
import { combineHashes, sha256File, sha256Text } from './hashes.js';
import { assertNoSecrets, sanitizeAdUnits, sanitizeAppId, sanitizeProducts, validateShape } from './ids.js';
import { writePreview } from './journal.js';
import { assertSafeRelative, openFileNoFollow, PathGuardError, resolveProjectRoot, resolveSafeRelative } from './paths.js';
import { buildTemplate } from './templates/index.js';
import type { IntegrationFinding, IntegrationPreview, IntegrationRequest, PlannedFileChange } from './types.js';
import { wiringChecks } from './wiring.js';

export interface StoredPreview {
  preview: IntegrationPreview;
  request: IntegrationRequest;
  changes: PlannedFileChange[];
}

function redactRequest(request: IntegrationRequest): IntegrationRequest {
  return {
    projectRoot: request.projectRoot,
    engine: request.engine,
    platform: request.platform,
    provider: request.provider,
    appId: request.appId,
    adUnits: request.adUnits,
    products: request.products,
    options: {
      includePurchases: request.options?.includePurchases,
      maxSdkKeyBound: request.options?.maxSdkKeyBound,
      dryRun: request.options?.dryRun,
    },
  };
}

async function readExisting(root: string, paths: string[]): Promise<{ map: Map<string, string | null>; findings: IntegrationFinding[] }> {
  const map = new Map<string, string | null>();
  const findings: IntegrationFinding[] = [];
  for (const rel of paths) {
    try {
      const abs = await resolveSafeRelative(root, rel);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        map.set(rel, null);
        findings.push({ code: 'path.symlink', severity: 'error', message: `심볼릭 링크는 쓰지 않습니다: ${rel}`, path: rel });
        continue;
      }
      if (!st.isFile()) {
        map.set(rel, null);
        continue;
      }
      if (st.size > 8 * 1024 * 1024) throw new PathGuardError('SDK 설정 파일이 8 MiB 한도를 넘습니다.', 'path.size');
      const handle = await openFileNoFollow(abs, constants.O_RDONLY);
      try {
        map.set(rel, await handle.readFile('utf8'));
      } finally {
        await handle.close();
      }
    } catch (error) {
      map.set(rel, null);
      if (error instanceof PathGuardError) {
        findings.push({ code: error.code, severity: 'error', message: error.message, path: rel });
      }
    }
  }
  return { map, findings };
}

const CANDIDATE_PATHS = [
  'app/build.gradle', 'app/build.gradle.kts', 'build.gradle', 'build.gradle.kts',
  'app/src/main/AndroidManifest.xml', 'src/main/AndroidManifest.xml',
  'Podfile', 'Info.plist', 'Package.swift',
  'Packages/manifest.json', 'ProjectSettings/ProjectVersion.txt', 'ProjectSettings/ProjectSettings.asset',
  'project.godot', 'addons/admob/plugin.cfg', 'addons/GodotGooglePlayBilling/plugin.cfg',
  'Config/DefaultEngine.ini',
];

/** Only source configuration paths enter templates; never follow project symlinks into host data. */
async function sourceConfigurationPaths(root:string):Promise<string[]>{
  const result:string[]=[];let entries=0;
  const walk=async (rel:string,depth:number):Promise<void>=>{
    if(depth>7)return;
    const base=rel?await resolveSafeRelative(root,rel):root;
    let list;try{list=await readdir(base,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    for(const entry of list){
      if(++entries>20_000)throw new AppError('SDK_PROJECT_LIMIT','SDK 설정 탐색 범위를 넘었습니다. 엔진 프로젝트 폴더를 직접 선택해 주세요.');
      if(entry.isSymbolicLink())continue;
      const path=rel?rel+'/'+entry.name:entry.name;
      if(entry.isFile()&&(entry.name.endsWith('.Build.cs')||entry.name.endsWith('.Target.cs')))result.push(path);
      if(entry.isDirectory()&&entry.name.endsWith('.xcodeproj'))result.push(path+'/project.pbxproj');
      else if(entry.isDirectory()&&!['.git','.appops','node_modules','Library','Temp','.godot','Intermediate','Saved','Binaries'].includes(entry.name))await walk(path,depth+1);
    }
  };
  await walk('',0);return result;
}

export async function previewIntegration(input: IntegrationRequest): Promise<IntegrationPreview> {
  assertNoSecrets(input);
  const findings: IntegrationFinding[] = [...validateShape(input)];
  const adUnits = sanitizeAdUnits(input.adUnits, input.provider, findings);
  const products = sanitizeProducts(input.products, findings);
  const appId = sanitizeAppId(input.appId, input.provider, findings);
  const includePurchases = Boolean(input.options?.includePurchases) || products.length > 0 || input.provider === 'play-billing' || input.provider === 'app-store';
  const wantAds = input.provider === 'admob' || input.provider === 'applovin-max';

  let root: string;
  try {
    root = await resolveProjectRoot(input.projectRoot);
  } catch (error) {
    throw new AppError('INVALID_INPUT', (error as Error).message);
  }

  const detection = await detectProjectSdks(root);
  findings.push(...detection.findings);
  if (detection.engine !== 'unknown' && detection.engine !== input.engine) {
    findings.push({
      code: 'detect.engine_mismatch',
      severity: 'error',
      message: `요청 엔진은 ${input.engine} 이지만 프로젝트는 ${detection.engine} 입니다.`,
      fixHint: '탐지된 엔진과 일치하는 템플릿을 사용하세요. 잘못된 자동 성공은 반환하지 않습니다.',
    });
  }

  const extra = detection.engine === 'unreal'
    ? (await import('node:fs/promises').then((fs) => fs.readdir(root))).filter((name) => name.endsWith('.uproject') || name.endsWith('.Target.cs'))
    : [];
  const existingRead = await readExisting(root, [...CANDIDATE_PATHS, ...extra, ...await sourceConfigurationPaths(root)]);
  const existing = existingRead.map;
  findings.push(...existingRead.findings);
  if (detection.engine === 'unreal') {
    const { readdir: rd, lstat: ls } = await import('node:fs/promises');
    const { join } = await import('node:path');
    async function collect(dir: string, prefix: string): Promise<void> {
      let names: string[] = [];
      try { names = await rd(dir); } catch { return; }
      for (const name of names) {
        const rel = prefix ? `${prefix}/${name}` : name;
        const abs = join(dir, name);
        try {
          const st = await ls(abs);
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory() && (name === 'Source' || prefix.startsWith('Source'))) await collect(abs, rel);
          else if (name.endsWith('.uproject') || name.endsWith('.Target.cs') || rel === 'Config/DefaultEngine.ini') {
            const more = await readExisting(root, [rel]);
            findings.push(...more.findings);
            for (const [key, value] of more.map) existing.set(key, value);
          }
        } catch { /* ignore */ }
      }
    }
    await collect(root, '');
  }

  const ctx = {
    root,
    engine: input.engine,
    platform: input.platform,
    provider: input.provider,
    appId,
    adUnits,
    products,
    maxSdkKeyBound: Boolean(input.options?.maxSdkKeyBound),
    detection,
  };
  const blocked = findings.some((item) => item.severity === 'error');
  const plan = blocked
    ? { supported: false, catalog: catalogFor(input.engine, input.platform, input.provider, includePurchases), changes: [], findings: [] }
    : buildTemplate(ctx, existing);
  findings.push(...plan.findings);

  for (const change of plan.changes) {
    if (change.content?.includes('sk_live') || /AIza[0-9A-Za-z_-]{20,}/.test(change.content ?? '')) {
      throw new AppError('SECRET_IN_JOB', '생성 코드에 비밀로 보이는 값이 있어 중단합니다.');
    }
    if (change.content?.includes('sdkKey') && change.content.includes(MAX_SDK_PLACEHOLDER) === false && /sdkKey\s*[:=]\s*["'][^"']+["']/.test(change.content)) {
      throw new AppError('SECRET_IN_JOB', 'MAX SDK Key 원문을 파일에 쓰지 않습니다.');
    }
  }

  const hashEntries = [];
  for (const change of plan.changes) {
    try {
      const abs = await assertSafeRelative(root, change.path);
      const hash = await sha256File(abs);
      change.previousHash = hash;
      change.contentHash = change.content ? sha256Text(change.content) : undefined;
      hashEntries.push({ path: change.path, hash });
    } catch (error) {
      findings.push({
        code: (error as PathGuardError).code ?? 'path.rejected',
        severity: 'error',
        message: (error as Error).message,
        path: change.path,
      });
    }
  }
  const beforeHash = combineHashes(hashEntries);
  const wiring = wiringChecks(plan, detection, adUnits, products, wantAds, includePurchases);
  const previewId = randomUUID();
  const supported = plan.supported && findings.every((item) => item.severity !== 'error');
  const preview: IntegrationPreview = {
    previewId,
    supported,
    engine: detection.engine,
    platform: input.platform,
    provider: input.provider,
    catalog: plan.catalog.length ? plan.catalog : catalogFor(input.engine, input.platform, input.provider, includePurchases),
    plannedChanges: plan.changes.map(({ content: _content, ...rest }) => rest),
    wiring,
    beforeHash,
    journalPath: '',
    findings,
    appId,
    adUnits,
    products,
    maxSdkKeyBound: Boolean(input.options?.maxSdkKeyBound),
  };
  const stored: StoredPreview = { preview, request: redactRequest({ ...input, projectRoot: root, appId, adUnits, products }), changes: plan.changes };
  preview.journalPath = await writePreview(root, previewId, stored);

  return preview;
}
