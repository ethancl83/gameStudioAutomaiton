import { openAsBlob } from 'node:fs';
import { extname } from 'node:path';
import { AppError, text } from '../domain/errors.js';
import type { ConnectorContext, ConnectorResult, ResourceInput } from './types.js';

const HOST = 'https://androidpublisher.googleapis.com';
const ROOT = HOST + '/androidpublisher/v3/applications/';
const PLAY_CONSOLE_CREATE = 'https://play.google.com/console';
const PLAY_API_DOCS = 'https://developers.google.com/android-publisher/api-ref/rest';

// Official discovery (androidpublisher:v3 revision 20260910) edits.images.imageType enum.
export const PLAY_IMAGE_TYPES = [
  'phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'tvScreenshots',
  'wearScreenshots', 'icon', 'featureGraphic', 'tvBanner',
] as const;
export type PlayImageType = typeof PLAY_IMAGE_TYPES[number];

const IMAGE_FETCH_TYPES: PlayImageType[] = ['icon', 'featureGraphic', 'phoneScreenshots'];
const RELEASE_STATUSES = ['draft', 'inProgress', 'halted', 'completed'] as const;
const IMAGE_TYPES = new Set<string>(PLAY_IMAGE_TYPES);
const IMAGE_CONTENT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

interface Listing {
  language?: string; title?: string; fullDescription?: string; shortDescription?: string; video?: string;
}
interface Image { id?: string; url?: string; sha1?: string; sha256?: string }
interface TrackRelease {
  name?: string; versionCodes?: string[]; status?: string; userFraction?: number;
  releaseNotes?: Array<{ language?: string; text?: string }>;
}
interface Track { track?: string; releases?: TrackRelease[] }

export function playLanguage(value: unknown, label = '언어'): string {
  const language = text(value, label, 20);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new AppError('INVALID_INPUT', `${label}는 BCP-47 언어 태그여야 합니다. 예: en-US, ko-KR, de-AT.`);
  }
  return language;
}

function listingFields(input: Record<string, unknown>, requiredTitle: boolean): Listing {
  const listing: Listing = {};
  if (input.title !== undefined || requiredTitle) listing.title = text(input.title, '스토어 제목', 50);
  if (input.shortDescription !== undefined) listing.shortDescription = text(input.shortDescription, '짧은 설명', 80);
  if (input.fullDescription !== undefined) listing.fullDescription = text(input.fullDescription, '자세한 설명', 4000);
  if (input.video !== undefined) {
    const video = text(input.video, '홍보 동영상 URL', 500);
    if (video && !/^https:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]+/.test(video) && !/^https:\/\/youtu\.be\/[\w-]+/.test(video)) {
      throw new AppError('INVALID_INPUT', '홍보 동영상은 YouTube https URL이어야 합니다.');
    }
    listing.video = video;
  }
  return listing;
}

async function insertEdit(ctx: ConnectorContext, pkg: string, headers: Record<string, string>): Promise<string> {
  try {
    const edit = await ctx.request<{ id?: string }>(ROOT + pkg + '/edits', { method: 'POST', headers, json: {}, write: true });
    const editId = text(edit.id, '편집 ID', 150);
    ctx.checkpoint({ packageName: pkg, editId, phase: 'edit-created' });
    return editId;
  } catch (error) {
    if (error instanceof AppError && (error.code === 'PROVIDER_REJECTED' || error.status === 409)) {
      throw new AppError(
        'ACTION_REQUIRED',
        '진행 중인 Google Play 편집이 있어 새 편집을 만들 수 없습니다. Play Console에서 기존 변경을 완료하거나 삭제한 뒤 다시 시도해 주세요.',
        409,
        { setupUrl: PLAY_CONSOLE_CREATE },
      );
    }
    throw error;
  }
}

async function withMutationEdit(
  ctx: ConnectorContext, pkg: string, headers: Record<string, string>,
  action: (editId: string, commit: () => Promise<void>) => Promise<ConnectorResult>,
): Promise<ConnectorResult> {
  const editId = await insertEdit(ctx, pkg, headers);
  let commitStarted = false;
  const commit = async () => {
    await ctx.request(ROOT + pkg + '/edits/' + encodeURIComponent(editId) + ':validate', { method: 'POST', headers, json: {}, write: true });
    ctx.checkpoint({ packageName: pkg, editId, phase: 'validated' });
    commitStarted = true;
    ctx.checkpoint({ packageName: pkg, editId, phase: 'commit-started' });
    await ctx.request(ROOT + pkg + '/edits/' + encodeURIComponent(editId) + ':commit', { method: 'POST', headers, json: {}, write: true });
    ctx.checkpoint({ packageName: pkg, editId, committed: true, phase: 'committed' });
  };
  try { return await action(editId, commit); }
  catch (error) {
    // A lost commit response might already be live. Never discard or resend it.
    if (commitStarted) throw error;
    await discardEdit(ctx, pkg, editId, headers);
    return { failed: true, summary: { packageName: pkg, editId, editDiscarded: true, failed: true,
      failureCode: error instanceof AppError ? error.code : 'PROVIDER_ERROR',
      nextAction: '스토어 변경이 완료되지 않아 임시 편집을 정리했습니다. 입력·권한을 확인한 뒤 새 작업으로 실행해 주세요.' } };
  }
}

async function discardEdit(ctx: ConnectorContext, pkg: string, editId: string, headers: Record<string, string>): Promise<void> {
  try {
    await ctx.request(ROOT + pkg + '/edits/' + encodeURIComponent(editId), { method: 'DELETE', headers, write: true });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'RESOURCE_NOT_FOUND') {
      ctx.checkpoint({ packageName: pkg, editId, phase: 'edit-cleanup-required', editDiscarded: false });
      throw new AppError('ACTION_REQUIRED', '스토어 자료 조회 후 임시 편집을 삭제하지 못했습니다. Play Console에서 편집을 정리한 뒤 반영 상태를 확인해 주세요.', 409);
    }
  }
  ctx.checkpoint({ packageName: pkg, editId, phase: 'edit-discarded', editDiscarded: true });
}

export async function reconcilePlayListingEdit(input: Record<string, unknown>, ctx: ConnectorContext, pkg: string, headers: Record<string, string>): Promise<ConnectorResult> {
  const editId = text(input.listingsEditId, '편집 ID', 150);
  try {
    await ctx.request(ROOT + pkg + '/edits/' + encodeURIComponent(editId), { headers });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'RESOURCE_NOT_FOUND') throw error;
    return { summary: { packageName: pkg, editId, editDiscarded: true, failed: true, nextAction: '임시 편집 정리를 확인했습니다. 스토어 자료 조회를 새로 실행해 주세요.' } };
  }
  return { unresolved: true, summary: { packageName: pkg, editId, editDiscarded: false, nextAction: 'Play Console에서 임시 편집을 삭제한 뒤 다시 확인해 주세요.' } };
}

function listingResource(pkg: string, listing: Listing, images: Record<string, Image[]>): ResourceInput {
  const language = listing.language || 'und';
  return {
    kind: 'creative',
    externalId: `${pkg}:listing:${language}`,
    name: listing.title || language,
    status: 'LIVE',
    data: {
      packageName: pkg,
      language,
      title: listing.title,
      shortDescription: listing.shortDescription,
      fullDescription: listing.fullDescription,
      video: listing.video,
      images,
    },
  };
}

export async function listPlayListings(input: Record<string, unknown>, ctx: ConnectorContext, pkg: string, headers: Record<string, string>): Promise<ConnectorResult> {
  const onlyLanguage = input.language === undefined || input.language === '' ? undefined : playLanguage(input.language);
  const editId = await insertEdit(ctx, pkg, headers);
  try {
    const listed = await ctx.request<{ listings?: Listing[] }>(
      ROOT + pkg + '/edits/' + encodeURIComponent(editId) + '/listings',
      { headers },
    );
    const listings = (Array.isArray(listed.listings) ? listed.listings : [])
      .filter(listing => !onlyLanguage || listing.language === onlyLanguage);
    const resources: ResourceInput[] = [];
    for (const listing of listings.slice(0, 20)) {
      const language = listing.language || '';
      const images: Record<string, Image[]> = {};
      if (language) {
        for (const imageType of IMAGE_FETCH_TYPES) {
          const response = await ctx.request<{ images?: Image[] }>(
            ROOT + pkg + '/edits/' + encodeURIComponent(editId) + '/listings/' + encodeURIComponent(language) + '/' + imageType,
            { headers },
          );
          images[imageType] = Array.isArray(response.images) ? response.images.map(image => ({
            id: image.id, url: image.url, sha256: image.sha256,
          })) : [];
        }
      }
      resources.push(listingResource(pkg, listing, images));
    }
    return {
      summary: { packageName: pkg, listingCount: resources.length, editDiscarded: true },
      resources,
    };
  } finally {
    await discardEdit(ctx, pkg, editId, headers);
  }
}

export async function updatePlayListing(
  input: Record<string, unknown>,
  ctx: ConnectorContext,
  pkg: string,
  headers: Record<string, string>,
): Promise<ConnectorResult> {
  const language = playLanguage(input.language ?? ctx.credentials.defaultLanguage ?? 'en-US');
  const listing = listingFields(input, true);
  listing.language = language;
  return withMutationEdit(ctx, pkg, headers, async (editId, commit) => {
  const saved = await ctx.request<Listing>(
    ROOT + pkg + '/edits/' + encodeURIComponent(editId) + '/listings/' + encodeURIComponent(language),
    { method: 'PUT', headers, json: listing, write: true },
  );
  ctx.checkpoint({ packageName: pkg, editId, language, phase: 'listing-updated' });
  await commit();
  const resource = listingResource(pkg, { ...saved, language }, {});
  return {
    resources: [resource],
    summary: { packageName: pkg, language, editId, committed: true, title: resource.name },
  };
  });
}

export async function uploadPlayListingImage(
  input: Record<string, unknown>,
  ctx: ConnectorContext,
  pkg: string,
  headers: Record<string, string>,
): Promise<ConnectorResult> {
  const language = playLanguage(input.language ?? ctx.credentials.defaultLanguage ?? 'en-US');
  const imageType = text(input.imageType, '이미지 유형', 40);
  if (!IMAGE_TYPES.has(imageType)) {
    throw new AppError('INVALID_INPUT', `지원하는 이미지 유형: ${PLAY_IMAGE_TYPES.join(', ')}`);
  }
  const artifact = ctx.artifact;
  if (!artifact || artifact.kind === 'directory') {
    throw new AppError(
      'MISSING_REQUIREMENT',
      '스토어 이미지 업로드에는 검증된 이미지 파일 결과물이 필요합니다. upload-build와 같이 검증된 artifact를 이 작업에 연결해 주세요.',
    );
  }
  const extension = extname(artifact.name).toLowerCase();
  const contentType = IMAGE_CONTENT[extension];
  if (!contentType) throw new AppError('INVALID_INPUT', '스토어 이미지는 PNG, JPEG, WebP 파일이어야 합니다.');
  if (artifact.size > 15 * 1024 * 1024) throw new AppError('INVALID_INPUT', '스토어 이미지는 15MB를 넘을 수 없습니다.');
  return withMutationEdit(ctx, pkg, headers, async (editId, commit) => {
  const blob = await openAsBlob(artifact.path, { type: contentType });
  const uploaded = await ctx.request<{ image?: Image }>(
    HOST + '/upload/androidpublisher/v3/applications/' + pkg + '/edits/' + encodeURIComponent(editId)
      + '/listings/' + encodeURIComponent(language) + '/' + encodeURIComponent(imageType) + '?uploadType=media',
    { method: 'POST', headers: { ...headers, 'Content-Type': contentType }, body: blob, write: true },
  );
  const image = uploaded.image ?? {};
  ctx.checkpoint({ packageName: pkg, editId, language, imageType, imageId: image.id, artifactSha256: artifact.sha256, phase: 'image-uploaded' });
  await commit();
  return {
    resources: [{
      kind: 'creative',
      externalId: `${pkg}:listing:${language}:${imageType}:${image.id || artifact.sha256}`,
      name: `${language} ${imageType}`,
      status: 'LIVE',
      data: { packageName: pkg, language, imageType, imageId: image.id, sha256: image.sha256 || artifact.sha256, url: image.url },
    }],
    summary: { packageName: pkg, language, imageType, imageId: image.id, editId, committed: true, artifactSha256: artifact.sha256 },
  };
  });
}

function versionCodes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(item => String(item)) : text(value, '버전 코드', 500).split(',');
  const codes = raw.map(item => item.trim()).filter(Boolean);
  if (codes.length === 0 || codes.some(code => !/^\d{1,18}$/.test(code))) {
    throw new AppError('INVALID_INPUT', '버전 코드는 쉼표로 구분한 양의 정수여야 합니다.');
  }
  return [...new Set(codes)];
}

function userFraction(value: unknown, status: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    if (status === 'inProgress') throw new AppError('INVALID_INPUT', '단계적 출시(inProgress)에는 userFraction(0과 1 사이)이 필요합니다.');
    return undefined;
  }
  const fraction = typeof value === 'number' ? value : Number(text(String(value), '출시 비율', 20));
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
    throw new AppError('INVALID_INPUT', 'userFraction은 0보다 크고 1보다 작은 소수여야 합니다. 예: 0.1은 10%입니다.');
  }
  if (status !== 'inProgress' && status !== 'halted') {
    throw new AppError('INVALID_INPUT', 'userFraction은 상태가 inProgress 또는 halted일 때만 설정할 수 있습니다.');
  }
  return fraction;
}

export async function promotePlayRelease(
  input: Record<string, unknown>,
  ctx: ConnectorContext,
  pkg: string,
  headers: Record<string, string>,
): Promise<ConnectorResult> {
  const track = text(input.track ?? 'production', '출시 트랙', 80);
  if (!/^[A-Za-z0-9_.:-]+$/.test(track)) throw new AppError('INVALID_INPUT', '출시 트랙 이름이 올바르지 않습니다.');
  const status = text(input.status ?? 'inProgress', '출시 상태', 20);
  if (!(RELEASE_STATUSES as readonly string[]).includes(status)) {
    throw new AppError('INVALID_INPUT', `출시 상태는 ${RELEASE_STATUSES.join(', ')} 중 하나여야 합니다.`);
  }
  let codes = input.versionCodes !== undefined ? versionCodes(input.versionCodes) : [];
  const fromTrack = input.fromTrack === undefined || input.fromTrack === '' ? undefined : text(input.fromTrack, '원본 트랙', 80);
  const fraction = userFraction(input.userFraction, status);
  const releaseName = input.releaseName === undefined ? undefined : text(input.releaseName, '출시 이름', 80);
  const notesLanguage = input.language === undefined ? undefined : playLanguage(input.language);
  const notesText = input.releaseNotes === undefined ? undefined : text(input.releaseNotes, '출시 노트', 500);

  return withMutationEdit(ctx, pkg, headers, async (editId, commit) => {
  if (fromTrack) {
    const source = await ctx.request<Track>(
      ROOT + pkg + '/edits/' + encodeURIComponent(editId) + '/tracks/' + encodeURIComponent(fromTrack),
      { headers },
    );
    const sourceCodes = (source.releases ?? []).flatMap(release => release.versionCodes ?? []);
    if (sourceCodes.length === 0) throw new AppError('RESOURCE_NOT_FOUND', `원본 트랙(${fromTrack})에서 승격할 버전 코드를 찾지 못했습니다.`, 404);
    codes = codes.length ? codes : sourceCodes;
  }
  if (codes.length === 0) throw new AppError('INVALID_INPUT', '승격할 버전 코드(versionCodes) 또는 원본 트랙(fromTrack)이 필요합니다.');

  const current = await ctx.request<Track>(
    ROOT + pkg + '/edits/' + encodeURIComponent(editId) + '/tracks/' + encodeURIComponent(track),
    { headers },
  ).catch((error: unknown) => {
    if (error instanceof AppError && error.code === 'RESOURCE_NOT_FOUND') return { track, releases: [] } as Track;
    throw error;
  });
  const retained = (current.releases ?? [])
    .filter(release => release.status === 'completed' || release.status === 'inProgress')
    .flatMap(release => release.versionCodes ?? []);
  const merged = [...new Set([...codes, ...retained])];
  const release: TrackRelease = {
    versionCodes: merged,
    status,
    ...(fraction === undefined ? {} : { userFraction: fraction }),
    ...(releaseName ? { name: releaseName } : {}),
    ...(notesText && notesLanguage ? { releaseNotes: [{ language: notesLanguage, text: notesText }] } : {}),
  };
  await ctx.request(
    ROOT + pkg + '/edits/' + encodeURIComponent(editId) + '/tracks/' + encodeURIComponent(track),
    { method: 'PUT', headers, write: true, json: { track, releases: [release] } },
  );
  ctx.checkpoint({ packageName: pkg, editId, track, versionCodes: merged, status, phase: 'track-updated' });
  await commit();
  const resource: ResourceInput = {
    kind: 'release',
    externalId: `${pkg}:${track}:${merged.join(',')}`,
    name: releaseName || `${track} · ${merged.join(', ')}`,
    status,
    data: { packageName: pkg, track, versionCodes: merged, requestedVersionCodes:codes, userFraction: fraction ?? null, fromTrack: fromTrack ?? null },
  };
  return {
    resources: [resource],
    summary: {
      packageName: pkg, editId, track, versionCodes: merged, status, userFraction: fraction ?? null, committed: true,
      note: status === 'inProgress'
        ? `단계적 출시가 ${Math.round((fraction ?? 0) * 100)}% 사용자에게 적용되도록 커밋했습니다.`
        : '트랙 출시 상태가 커밋되었습니다.',
    },
  };
  });
}

export async function preparePlayApp(ctx: ConnectorContext, pkg: string, headers: Record<string, string>): Promise<ConnectorResult> {
  try {
    await ctx.request(ROOT + pkg + '/oneTimeProducts?pageSize=1', { headers });
    return {
      summary: {
        packageName: pkg,
        exists: true,
        note: 'Play Console에 이 패키지의 앱이 이미 있습니다. 스토어 자료와 출시 작업을 사용할 수 있습니다.',
      },
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'RESOURCE_NOT_FOUND') throw error;
  }
  return {
    unresolved: true,
    summary: {
      packageName: pkg,
      exists: false,
      requiredAction: 'Google Play Developer API는 신규 앱을 생성하지 않습니다. Play Console에서 앱을 만들고 개발자 계약·콘텐츠 등급·개인정보처리방침을 완료한 뒤 이 프로젝트의 패키지 이름으로 연결해 주세요.',
      setupUrl: PLAY_CONSOLE_CREATE,
      apiReference: PLAY_API_DOCS,
    },
  };
}
