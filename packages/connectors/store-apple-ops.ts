import { AppError, text } from '../domain/errors.js';
import type { ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import {
  APP_STORE_API, appleAuthHeaders, collectPages, many, one, optionalText, optionalUrl, readToOneLinkage,
  relationshipId, requireRelationshipId, resolveAppleApp, resourceId, textAttribute,
  type JsonApiDocument, type JsonApiResource,
} from './store-jsonapi.js';

const CONSOLE_APPS = 'https://appstoreconnect.apple.com/apps';
const PLATFORMS = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'] as const;
const RELEASE_TYPES = ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'] as const;
const PHASED_STATES = ['INACTIVE', 'ACTIVE', 'PAUSED', 'COMPLETE'] as const;
const APPLE_LOCALES = new Set([
  'ar-SA', 'bn-BD', 'ca', 'zh-Hans', 'zh-Hant', 'hr', 'cs', 'da', 'nl-NL', 'en-AU', 'en-CA', 'en-GB', 'en-US',
  'fi', 'fr-FR', 'fr-CA', 'de-DE', 'el', 'gu-IN', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'kn-IN', 'ko', 'ms',
  'ml-IN', 'mr-IN', 'no', 'or-IN', 'pl', 'pt-BR', 'pt-PT', 'pa-IN', 'ro', 'ru', 'sk', 'sl-SI', 'es-MX', 'es-ES',
  'sv', 'ta-IN', 'te-IN', 'th', 'tr', 'uk', 'ur-PK', 'vi',
]);

function platform(value: unknown, fallback = 'IOS'): string {
  const raw = value === undefined || value === '' ? fallback : text(value, '플랫폼', 20).toUpperCase().replace('-', '_');
  if (!(PLATFORMS as readonly string[]).includes(raw)) {
    throw new AppError('INVALID_INPUT', `플랫폼은 ${PLATFORMS.join(', ')} 중 하나여야 합니다.`);
  }
  return raw;
}

export function locale(value: unknown): string {
  const raw = text(value, '로케일', 20);
  if (!APPLE_LOCALES.has(raw)) {
    throw new AppError('INVALID_INPUT', `App Store Connect가 지원하는 로케일이 아닙니다: ${raw}. 예: ko, ja, en-US.`);
  }
  return raw;
}

function versionString(value: unknown): string {
  const raw = text(value, '버전 문자열', 30);
  if (!/^\d+(?:\.\d+){0,3}$/.test(raw)) throw new AppError('INVALID_INPUT', '버전 문자열은 숫자와 마침표만 사용할 수 있습니다. 예: 1.2.0');
  return raw;
}

function assertOwned(actualId: string, expectedId: string, message: string): void {
  if (actualId !== expectedId) throw new AppError('INVALID_INPUT', message);
}

export async function requireVersionForApp(
  context: ConnectorContext,
  versionId: string,
  appId: string,
  headers: Record<string, string>,
): Promise<JsonApiResource> {
  const version = one(
    await context.request<JsonApiDocument>(
      `${APP_STORE_API}/v1/appStoreVersions/${encodeURIComponent(versionId)}?include=app`,
      { headers },
    ),
    '스토어 버전',
  );
  assertOwned(
    requireRelationshipId(version, 'app', '스토어 버전'),
    appId,
    `앱 스토어 버전(${versionId})이 이 프로젝트 앱에 속하지 않습니다.`,
  );
  return version;
}

async function requireRelatedApp(
  context: ConnectorContext,
  collection: 'builds' | 'betaGroups',
  id: string,
  appId: string,
  headers: Record<string, string>,
  label: string,
): Promise<void> {
  const relatedAppId = await readToOneLinkage(
    context,
    `${APP_STORE_API}/v1/${collection}/${encodeURIComponent(id)}/relationships/app`,
    headers,
    'apps',
    `${label} 앱 관계`,
  );
  assertOwned(relatedAppId, appId, `${label}(${id})이 이 프로젝트 앱에 속하지 않습니다.`);
}

export async function requireLocalizationForVersion(
  context: ConnectorContext,
  localizationId: string,
  versionId: string,
  selectedLocale: string,
  headers: Record<string, string>,
): Promise<void> {
  const localization = one(
    await context.request<JsonApiDocument>(
      `${APP_STORE_API}/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}?include=appStoreVersion`,
      { headers },
    ),
    '버전 현지화',
  );
  const relatedVersionId = requireRelationshipId(localization, 'appStoreVersion', '버전 현지화');
  const actualLocale = textAttribute(localization, 'locale');
  if (relatedVersionId !== versionId || actualLocale !== selectedLocale) {
    throw new AppError('INVALID_INPUT', `현지화(${localizationId})가 선택한 버전 또는 로케일과 일치하지 않습니다.`);
  }
}

async function requireAppInfoLocalization(
  context: ConnectorContext,
  localizationId: string,
  appInfoId: string,
  selectedLocale: string,
  headers: Record<string, string>,
): Promise<void> {
  const localization = one(
    await context.request<JsonApiDocument>(
      `${APP_STORE_API}/v1/appInfoLocalizations/${encodeURIComponent(localizationId)}?include=appInfo`,
      { headers },
    ),
    '앱 정보 현지화',
  );
  const relatedInfoId = requireRelationshipId(localization, 'appInfo', '앱 정보 현지화');
  const actualLocale = textAttribute(localization, 'locale');
  if (relatedInfoId !== appInfoId || actualLocale !== selectedLocale) {
    throw new AppError('INVALID_INPUT', `앱 정보 현지화(${localizationId})가 이 앱 정보 또는 요청 로케일과 일치하지 않습니다.`);
  }
}

async function requireReviewSubmissionForApp(
  context: ConnectorContext,
  submissionId: string,
  appId: string,
  headers: Record<string, string>,
): Promise<JsonApiResource> {
  const submission = one(
    await context.request<JsonApiDocument>(
      `${APP_STORE_API}/v1/reviewSubmissions/${encodeURIComponent(submissionId)}?include=app`,
      { headers },
    ),
    '심사 제출',
  );
  assertOwned(
    requireRelationshipId(submission, 'app', '심사 제출'),
    appId,
    `심사 제출(${submissionId})이 이 프로젝트 앱에 속하지 않습니다.`,
  );
  return submission;
}

async function requirePhasedReleaseForVersion(
  context: ConnectorContext,
  versionId: string,
  phasedReleaseId: string,
  headers: Record<string, string>,
): Promise<void> {
  const relatedId = await readToOneLinkage(
    context,
    `${APP_STORE_API}/v1/appStoreVersions/${encodeURIComponent(versionId)}/relationships/appStoreVersionPhasedRelease`,
    headers,
    'appStoreVersionPhasedReleases',
    '단계적 출시 관계',
  );
  assertOwned(relatedId, phasedReleaseId, `단계적 출시(${phasedReleaseId})가 선택한 버전에 속하지 않습니다.`);
}

function reviewSubmissionOutcome(state: string): {
  confirmed: boolean;
  failed: boolean;
  waitingExternal: boolean;
  unresolved: boolean;
} {
  if (state === 'COMPLETE') return { confirmed: true, failed: false, waitingExternal: false, unresolved: false };
  if (state === 'WAITING_FOR_REVIEW' || state === 'IN_REVIEW' || state === 'COMPLETING' || state === 'CANCELING') {
    return { confirmed: false, failed: false, waitingExternal: true, unresolved: false };
  }
  if (state === 'UNRESOLVED_ISSUES') return { confirmed: false, failed: true, waitingExternal: false, unresolved: false };
  return { confirmed: false, failed: false, waitingExternal: false, unresolved: true };
}

export async function prepareAppleApp(context: ConnectorContext): Promise<ConnectorResult> {
  const bundleId = context.project?.appIdentifier;
  if (!bundleId) {
    throw new AppError('MISSING_REQUIREMENT', '신규 앱 준비에는 프로젝트의 bundle ID가 필요합니다.');
  }
  try {
    const app = await resolveAppleApp(context);
    return {
      summary: {
        exists: true, appId: app.id, bundleId: app.bundleId, name: app.name,
        note: 'App Store Connect에 이 bundle ID의 앱이 이미 있습니다.',
      },
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'RESOURCE_NOT_FOUND') throw error;
  }
  // Official OpenAPI 4.4.1: GET /v1/apps only. There is no apps_createInstance.
  return {
    unresolved: true,
    summary: {
      exists: false,
      bundleId,
      requiredAction: 'App Store Connect API 4.4.1은 앱 레코드 생성을 제공하지 않습니다(GET /v1/apps만 명세). App Store Connect에서 앱을 만든 뒤 이 프로젝트의 bundle ID로 연결해 주세요.',
      setupUrl: CONSOLE_APPS,
      apiReference: 'https://developer.apple.com/documentation/appstoreconnectapi',
    },
  };
}

export async function createAppleVersion(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const version = versionString(input.versionString);
  const selectedPlatform = platform(input.platform);
  const copyright = optionalText(input.copyright, '저작권', 200);
  const releaseType = input.releaseType === undefined ? undefined : text(input.releaseType, '출시 유형', 30);
  if (releaseType && !(RELEASE_TYPES as readonly string[]).includes(releaseType)) {
    throw new AppError('INVALID_INPUT', `출시 유형은 ${RELEASE_TYPES.join(', ')} 중 하나여야 합니다.`);
  }
  const buildId = input.buildId === undefined ? undefined : resourceId(input.buildId, '빌드 ID');
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  if (buildId) await requireRelatedApp(context, 'builds', buildId, app.id, headers, '빌드');
  const created = one(
    await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/appStoreVersions`, {
      method: 'POST',
      headers,
      write: true,
      json: {
        data: {
          type: 'appStoreVersions',
          attributes: {
            platform: selectedPlatform,
            versionString: version,
            ...(copyright ? { copyright } : {}),
            ...(releaseType ? { releaseType } : {}),
          },
          relationships: {
            app: { data: { type: 'apps', id: app.id } },
            ...(buildId ? { build: { data: { type: 'builds', id: buildId } } } : {}),
          },
        },
      },
    }),
    '스토어 버전 생성',
  );
  context.checkpoint({ appleAppId: app.id, appleAppStoreVersionId: created.id, phase: 'version-created' });
  return {
    resources: [{
      kind: 'release',
      externalId: created.id,
      name: `${app.bundleId} ${version}`,
      status: textAttribute(created, 'appVersionState') || textAttribute(created, 'appStoreState') || 'PREPARE_FOR_SUBMISSION',
      data: { bundleId: app.bundleId, platform: selectedPlatform, versionString: version, buildId: buildId ?? null },
    }],
    summary: { appStoreVersionId: created.id, bundleId: app.bundleId, versionString: version, platform: selectedPlatform },
  };
}

export async function listAppleListings(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  const versionId = input.appStoreVersionId === undefined ? undefined : resourceId(input.appStoreVersionId, '앱 스토어 버전 ID');
  const versions = versionId
    ? [await requireVersionForApp(context, versionId, app.id, headers)]
    : await collectPages(
      context,
      `${APP_STORE_API}/v1/apps/${encodeURIComponent(app.id)}/appStoreVersions?limit=50`,
      headers,
      '스토어 버전 목록',
    );
  const resources: ResourceInput[] = [];
  for (const version of versions.slice(0, 10)) {
    const localizations = await collectPages(
      context,
      `${APP_STORE_API}/v1/appStoreVersions/${encodeURIComponent(version.id)}/appStoreVersionLocalizations?limit=50`,
      headers,
      '버전 현지화',
    );
    for (const localization of localizations) {
      resources.push({
        kind: 'creative',
        externalId: localization.id,
        name: `${textAttribute(version, 'versionString')} ${textAttribute(localization, 'locale')}`,
        status: textAttribute(version, 'appVersionState') || 'UNKNOWN',
        data: {
          bundleId: app.bundleId,
          appStoreVersionId: version.id,
          localizationId: localization.id,
          locale: textAttribute(localization, 'locale'),
          description: textAttribute(localization, 'description'),
          keywords: textAttribute(localization, 'keywords'),
          marketingUrl: textAttribute(localization, 'marketingUrl'),
          promotionalText: textAttribute(localization, 'promotionalText'),
          supportUrl: textAttribute(localization, 'supportUrl'),
          whatsNew: textAttribute(localization, 'whatsNew'),
        },
      });
    }
  }
  return {
    summary: { app: app.bundleId, versions: versions.length, localizations: resources.length },
    resources,
  };
}

export async function updateAppleListing(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const versionId = resourceId(input.appStoreVersionId, '앱 스토어 버전 ID');
  const selectedLocale = locale(input.locale);
  const localizationId = input.localizationId === undefined ? undefined : resourceId(input.localizationId, '현지화 ID');
  const attributes: Record<string, unknown> = {};
  const description = optionalText(input.description, '설명', 4000);
  const keywords = optionalText(input.keywords, '키워드', 100);
  const promotionalText = optionalText(input.promotionalText, '프로모션 문구', 170);
  const whatsNew = optionalText(input.whatsNew, '새로운 기능', 4000);
  const marketingUrl = optionalUrl(input.marketingUrl, '마케팅 URL');
  const supportUrl = optionalUrl(input.supportUrl, '지원 URL');
  if (description !== undefined) attributes.description = description;
  if (keywords !== undefined) attributes.keywords = keywords;
  if (promotionalText !== undefined) attributes.promotionalText = promotionalText;
  if (whatsNew !== undefined) attributes.whatsNew = whatsNew;
  if (marketingUrl !== undefined) attributes.marketingUrl = marketingUrl;
  if (supportUrl !== undefined) attributes.supportUrl = supportUrl;
  if (!localizationId && Object.keys(attributes).length === 0) {
    throw new AppError('INVALID_INPUT', '생성할 현지화에는 locale과 함께 설명 또는 새로운 기능 중 하나 이상이 필요합니다.');
  }
  const headers = await appleAuthHeaders(context);
  const app = await resolveAppleApp(context);
  await requireVersionForApp(context, versionId, app.id, headers);
  let saved: JsonApiResource;
  if (localizationId) {
    if (Object.keys(attributes).length === 0) throw new AppError('INVALID_INPUT', '변경할 현지화 항목이 없습니다.');
    await requireLocalizationForVersion(context, localizationId, versionId, selectedLocale, headers);
    saved = one(
      await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`, {
        method: 'PATCH',
        headers,
        write: true,
        json: { data: { type: 'appStoreVersionLocalizations', id: localizationId, attributes } },
      }),
      '버전 현지화 수정',
    );
    context.checkpoint({ appleAppStoreVersionId: versionId, appleLocalizationId: saved.id, phase: 'localization-updated' });
  } else {
    saved = one(
      await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/appStoreVersionLocalizations`, {
        method: 'POST',
        headers,
        write: true,
        json: {
          data: {
            type: 'appStoreVersionLocalizations',
            attributes: { locale: selectedLocale, ...attributes },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        },
      }),
      '버전 현지화 생성',
    );
    context.checkpoint({ appleAppStoreVersionId: versionId, appleLocalizationId: saved.id, phase: 'localization-created' });
  }
  return {
    resources: [{
      kind: 'creative',
      externalId: saved.id,
      name: `${versionId} ${textAttribute(saved, 'locale') || selectedLocale}`,
      status: 'SAVED',
      data: {
        appStoreVersionId: versionId,
        localizationId: saved.id,
        locale: textAttribute(saved, 'locale') || selectedLocale,
        description: textAttribute(saved, 'description'),
        keywords: textAttribute(saved, 'keywords'),
        whatsNew: textAttribute(saved, 'whatsNew'),
      },
    }],
    summary: { appStoreVersionId: versionId, localizationId: saved.id, locale: textAttribute(saved, 'locale') || selectedLocale },
  };
}

export async function updateAppleAppInfo(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const selectedLocale = locale(input.locale);
  const localizationId = input.localizationId === undefined ? undefined : resourceId(input.localizationId, '앱 정보 현지화 ID');
  const name = optionalText(input.name, '앱 이름', 30);
  const subtitle = optionalText(input.subtitle, '부제', 30);
  const privacyPolicyUrl = optionalUrl(input.privacyPolicyUrl, '개인정보 처리방침 URL');
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  const infos = many(await context.request<JsonApiDocument>(
    `${APP_STORE_API}/v1/apps/${encodeURIComponent(app.id)}/appInfos?limit=10`,
    { headers },
  ));
  const appInfo = infos[0];
  if (!appInfo) throw new AppError('RESOURCE_NOT_FOUND', '앱 정보(appInfos)를 찾지 못했습니다.', 404);
  let saved: JsonApiResource;
  if (localizationId) {
    const attributes: Record<string, unknown> = {};
    if (name !== undefined) attributes.name = name;
    if (subtitle !== undefined) attributes.subtitle = subtitle;
    if (privacyPolicyUrl !== undefined) attributes.privacyPolicyUrl = privacyPolicyUrl;
    if (Object.keys(attributes).length === 0) throw new AppError('INVALID_INPUT', '변경할 앱 정보 항목이 없습니다.');
    await requireAppInfoLocalization(context, localizationId, appInfo.id, selectedLocale, headers);
    saved = one(
      await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/appInfoLocalizations/${encodeURIComponent(localizationId)}`, {
        method: 'PATCH',
        headers,
        write: true,
        json: { data: { type: 'appInfoLocalizations', id: localizationId, attributes } },
      }),
      '앱 정보 현지화 수정',
    );
  } else {
    if (!name) throw new AppError('INVALID_INPUT', '새 앱 정보 현지화에는 앱 이름이 필요합니다.');
    saved = one(
      await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/appInfoLocalizations`, {
        method: 'POST',
        headers,
        write: true,
        json: {
          data: {
            type: 'appInfoLocalizations',
            attributes: { locale: selectedLocale, name, ...(subtitle ? { subtitle } : {}), ...(privacyPolicyUrl ? { privacyPolicyUrl } : {}) },
            relationships: { appInfo: { data: { type: 'appInfos', id: appInfo.id } } },
          },
        },
      }),
      '앱 정보 현지화 생성',
    );
  }
  context.checkpoint({ appleAppId: app.id, appleAppInfoId: appInfo.id, appleAppInfoLocalizationId: saved.id });
  return {
    resources: [{
      kind: 'creative',
      externalId: saved.id,
      name: textAttribute(saved, 'name') || name || selectedLocale,
      status: 'SAVED',
      data: { bundleId: app.bundleId, appInfoId: appInfo.id, locale: textAttribute(saved, 'locale') || selectedLocale },
    }],
    summary: { appInfoId: appInfo.id, localizationId: saved.id, locale: textAttribute(saved, 'locale') || selectedLocale },
  };
}

function betaGroupResource(group: JsonApiResource, bundleId: string): ResourceInput {
  return {
    kind: 'release',
    externalId: group.id,
    name: textAttribute(group, 'name') || group.id,
    status: textAttribute(group, 'isInternalGroup') === '' ? 'UNKNOWN' : (attributeBool(group, 'isInternalGroup') ? 'internal' : 'external'),
    data: {
      bundleId,
      isInternalGroup: attributeBool(group, 'isInternalGroup'),
      publicLink: textAttribute(group, 'publicLink') || null,
      publicLinkEnabled: attributeBool(group, 'publicLinkEnabled'),
      hasAccessToAllBuilds: attributeBool(group, 'hasAccessToAllBuilds'),
    },
  };
}

function attributeBool(resource: JsonApiResource, name: string): boolean {
  return resource.attributes?.[name] === true;
}

export async function listAppleBetaGroups(context: ConnectorContext): Promise<ConnectorResult> {
  const app = await resolveAppleApp(context);
  const groups = await collectPages(
    context,
    `${APP_STORE_API}/v1/apps/${encodeURIComponent(app.id)}/betaGroups?limit=50`,
    await appleAuthHeaders(context),
    'TestFlight 그룹',
  );
  const resources = groups.map(group => betaGroupResource(group, app.bundleId));
  return { summary: { app: app.bundleId, groups: resources.length }, resources };
}

export async function createAppleBetaGroup(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const name = text(input.name, '그룹 이름', 64);
  const isInternalGroup = input.isInternalGroup === true || input.isInternalGroup === 'true';
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  const existing = await collectPages(
    context,
    `${APP_STORE_API}/v1/apps/${encodeURIComponent(app.id)}/betaGroups?limit=50`,
    headers,
    'TestFlight 그룹',
  );
  const match = existing.find(group => textAttribute(group, 'name') === name);
  if (match) {
    return {
      summary: { betaGroupId: match.id, reused: true, name },
      resources: [betaGroupResource(match, app.bundleId)],
    };
  }
  const created = one(
    await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/betaGroups`, {
      method: 'POST',
      headers,
      write: true,
      json: {
        data: {
          type: 'betaGroups',
          attributes: { name, isInternalGroup },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      },
    }),
    'TestFlight 그룹 생성',
  );
  context.checkpoint({ appleAppId: app.id, appleBetaGroupId: created.id, phase: 'beta-group-created' });
  return {
    resources: [betaGroupResource(created, app.bundleId)],
    summary: { betaGroupId: created.id, reused: false, name },
  };
}

export async function distributeAppleBuild(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const betaGroupId = resourceId(input.betaGroupId, 'TestFlight 그룹 ID');
  const buildId = resourceId(input.buildId, '빌드 ID');
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  await requireRelatedApp(context, 'betaGroups', betaGroupId, app.id, headers, 'TestFlight 그룹');
  await requireRelatedApp(context, 'builds', buildId, app.id, headers, '빌드');
  const group = one(
    await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/betaGroups/${encodeURIComponent(betaGroupId)}`, { headers }),
    'TestFlight 그룹',
  );
  const linked = many(await context.request<JsonApiDocument>(
    `${APP_STORE_API}/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/builds?limit=200`,
    { headers },
  ));
  if (linked.some(item => item.id === buildId)) {
    return {
      summary: { betaGroupId, buildId, alreadyLinked: true },
      resources: [betaGroupResource(group, app.bundleId)],
    };
  }
  await context.request(`${APP_STORE_API}/v1/betaGroups/${encodeURIComponent(betaGroupId)}/relationships/builds`, {
    method: 'POST',
    headers,
    write: true,
    json: { data: [{ type: 'builds', id: buildId }] },
  });
  context.checkpoint({ appleBetaGroupId: betaGroupId, appleBuildId: buildId, phase: 'build-distributed' });
  return {
    resources: [betaGroupResource(group, app.bundleId)],
    summary: { betaGroupId, buildId, alreadyLinked: false },
  };
}

export async function linkAppleBuild(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const versionId = resourceId(input.appStoreVersionId, '앱 스토어 버전 ID');
  const buildId = resourceId(input.buildId, '빌드 ID');
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  await requireVersionForApp(context, versionId, app.id, headers);
  await requireRelatedApp(context, 'builds', buildId, app.id, headers, '빌드');
  await context.request(`${APP_STORE_API}/v1/appStoreVersions/${encodeURIComponent(versionId)}/relationships/build`, {
    method: 'PATCH',
    headers,
    write: true,
    json: { data: { type: 'builds', id: buildId } },
  });
  context.checkpoint({ appleAppStoreVersionId: versionId, appleBuildId: buildId, phase: 'build-linked' });
  return {
    resources: [{
      kind: 'release',
      externalId: versionId,
      name: versionId,
      status: 'BUILD_LINKED',
      data: { appStoreVersionId: versionId, buildId },
    }],
    summary: { appStoreVersionId: versionId, buildId },
  };
}

export async function submitAppleReview(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const versionId = resourceId(input.appStoreVersionId, '앱 스토어 버전 ID');
  const selectedPlatform = platform(input.platform);
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  const version = await requireVersionForApp(context, versionId, app.id, headers);
  const versionState = textAttribute(version, 'appVersionState') || textAttribute(version, 'appStoreState');
  const existing = many(await context.request<JsonApiDocument>(
    `${APP_STORE_API}/v1/reviewSubmissions?filter[app]=${encodeURIComponent(app.id)}&filter[platform]=${encodeURIComponent(selectedPlatform)}&limit=20`,
    { headers },
  ));
  const reusable = existing.find(item => {
    const state = textAttribute(item, 'state');
    return state === 'READY_FOR_REVIEW';
  });
  let submission = reusable;
  if (!submission) {
    submission = one(
      await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/reviewSubmissions`, {
        method: 'POST',
        headers,
        write: true,
        json: {
          data: {
            type: 'reviewSubmissions',
            attributes: { platform: selectedPlatform },
            relationships: { app: { data: { type: 'apps', id: app.id } } },
          },
        },
      }),
      '심사 제출 생성',
    );
    context.checkpoint({ appleAppId: app.id, appleReviewSubmissionId: submission.id, appleAppStoreVersionId: versionId, phase: 'submission-created' });
  } else {
    context.checkpoint({ appleAppId: app.id, appleReviewSubmissionId: submission.id, appleAppStoreVersionId: versionId, phase: 'submission-reused' });
  }
  await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/reviewSubmissionItems`, {
    method: 'POST',
    headers,
    write: true,
    json: {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    },
  });
  context.checkpoint({ appleReviewSubmissionId: submission.id, appleAppStoreVersionId: versionId, phase: 'item-added' });
  const submitted = one(
    await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/reviewSubmissions/${encodeURIComponent(submission.id)}`, {
      method: 'PATCH',
      headers,
      write: true,
      json: { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } },
    }),
    '심사 제출',
  );
  const state = textAttribute(submitted, 'state');
  const outcome = reviewSubmissionOutcome(state);
  context.checkpoint({ appleReviewSubmissionId: submitted.id, state: state || 'UNKNOWN', phase: 'submitted' });
  return {
    waitingExternal: outcome.waitingExternal,
    unresolved: outcome.unresolved,
    failed: outcome.failed,
    resources: [{
      kind: 'release',
      externalId: submitted.id,
      name: `${app.bundleId} review ${versionId}`,
      status: state || 'UNKNOWN',
      data: { bundleId: app.bundleId, appStoreVersionId: versionId, reviewSubmissionId: submitted.id, versionState },
    }],
    summary: {
      reviewSubmissionId: submitted.id,
      appStoreVersionId: versionId,
      state: state || 'UNKNOWN',
      versionState,
      confirmed: outcome.confirmed,
      failed: outcome.failed,
      unresolved: outcome.unresolved,
    },
  };
}

export async function listAppleReviewSubmissions(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const app = await resolveAppleApp(context);
  const selectedPlatform = input.platform === undefined ? undefined : platform(input.platform);
  const query = new URLSearchParams({ 'filter[app]': app.id, limit: '50' });
  if (selectedPlatform) query.set('filter[platform]', selectedPlatform);
  const submissions = many(await context.request<JsonApiDocument>(
    `${APP_STORE_API}/v1/reviewSubmissions?${query}`,
    { headers: await appleAuthHeaders(context) },
  ));
  const resources = submissions.map(item => ({
    kind: 'release' as const,
    externalId: item.id,
    name: `review ${item.id}`,
    status: textAttribute(item, 'state') || 'UNKNOWN',
    data: {
      bundleId: app.bundleId,
      platform: textAttribute(item, 'platform'),
      submittedDate: textAttribute(item, 'submittedDate'),
      appStoreVersionId: relationshipId(item, 'appStoreVersionForReview') || null,
    },
  }));
  return { summary: { app: app.bundleId, submissions: resources.length }, resources };
}

export async function releaseAppleVersion(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const versionId = resourceId(input.appStoreVersionId, '앱 스토어 버전 ID');
  const action = text(input.action ?? 'release', '출시 동작', 30);
  const headers = await appleAuthHeaders(context);
  const app = await resolveAppleApp(context);
  const version = await requireVersionForApp(context, versionId, app.id, headers);
  const state = textAttribute(version, 'appVersionState') || textAttribute(version, 'appStoreState');

  if (action === 'release') {
    if (state !== 'PENDING_DEVELOPER_RELEASE') {
      throw new AppError(
        'INVALID_INPUT',
        `수동 출시는 PENDING_DEVELOPER_RELEASE 상태에서만 가능합니다. 현재 상태: ${state || '알 수 없음'}.`,
      );
    }
    const created = one(
      await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/appStoreVersionReleaseRequests`, {
        method: 'POST',
        headers,
        write: true,
        json: {
          data: {
            type: 'appStoreVersionReleaseRequests',
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        },
      }),
      '버전 출시 요청',
    );
    context.checkpoint({ appleAppStoreVersionId: versionId, appleReleaseRequestId: created.id, phase: 'release-requested' });
    return {
      waitingExternal: true,
      resources: [{
        kind: 'release',
        externalId: versionId,
        name: textAttribute(version, 'versionString') || versionId,
        status: 'PROCESSING_FOR_DISTRIBUTION',
        data: { appStoreVersionId: versionId, releaseRequestId: created.id },
      }],
      summary: { appStoreVersionId: versionId, releaseRequestId: created.id, previousState: state },
    };
  }

  if (action === 'phased-start') {
    const created = one(
      await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/appStoreVersionPhasedReleases`, {
        method: 'POST',
        headers,
        write: true,
        json: {
          data: {
            type: 'appStoreVersionPhasedReleases',
            attributes: { phasedReleaseState: 'ACTIVE' },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        },
      }),
      '단계적 출시 시작',
    );
    context.checkpoint({ appleAppStoreVersionId: versionId, applePhasedReleaseId: created.id, phase: 'phased-started' });
    return {
      resources: [{
        kind: 'release',
        externalId: created.id,
        name: `${textAttribute(version, 'versionString') || versionId} phased`,
        status: textAttribute(created, 'phasedReleaseState') || 'ACTIVE',
        data: { appStoreVersionId: versionId, phasedReleaseId: created.id },
      }],
      summary: { appStoreVersionId: versionId, phasedReleaseId: created.id, phasedReleaseState: textAttribute(created, 'phasedReleaseState') || 'ACTIVE' },
    };
  }

  if (action === 'phased-pause' || action === 'phased-complete') {
    const phasedReleaseId = resourceId(input.phasedReleaseId, '단계적 출시 ID');
    const next = action === 'phased-pause' ? 'PAUSED' : 'COMPLETE';
    if (!(PHASED_STATES as readonly string[]).includes(next)) throw new AppError('INVALID_INPUT', '단계적 출시 상태가 올바르지 않습니다.');
    await requirePhasedReleaseForVersion(context, versionId, phasedReleaseId, headers);
    const updated = one(
      await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/appStoreVersionPhasedReleases/${encodeURIComponent(phasedReleaseId)}`, {
        method: 'PATCH',
        headers,
        write: true,
        json: { data: { type: 'appStoreVersionPhasedReleases', id: phasedReleaseId, attributes: { phasedReleaseState: next } } },
      }),
      '단계적 출시 상태 변경',
    );
    context.checkpoint({ appleAppStoreVersionId: versionId, applePhasedReleaseId: phasedReleaseId, phase: next });
    return {
      summary: {
        appStoreVersionId: versionId,
        phasedReleaseId,
        phasedReleaseState: textAttribute(updated, 'phasedReleaseState') || next,
      },
    };
  }

  throw new AppError('INVALID_INPUT', '출시 동작은 release, phased-start, phased-pause, phased-complete 중 하나여야 합니다.');
}

export async function reconcileAppleReview(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const submissionId = resourceId(input.reviewSubmissionId ?? input.externalId, '심사 제출 ID');
  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  const submission = await requireReviewSubmissionForApp(context, submissionId, app.id, headers);
  const state = textAttribute(submission, 'state') || 'UNKNOWN';
  const outcome = reviewSubmissionOutcome(state);
  return {
    waitingExternal: outcome.waitingExternal,
    unresolved: outcome.unresolved,
    failed: outcome.failed,
    summary: {
      reviewSubmissionId: submission.id,
      state,
      confirmed: outcome.confirmed,
      failed: outcome.failed,
      unresolved: outcome.unresolved,
    },
  };
}
