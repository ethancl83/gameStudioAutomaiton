import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';
import { AppError, text } from '../domain/errors.js';
import { applePartBody, openVerifiedAppleArtifact, parseAppleUploadOperations } from './apple-upload.js';
import { findLocalization, parseMediaState, type MediaState } from './apple-media.js';
import {
  APP_STORE_API as API, appleAuthHeaders, attribute, collectPages, one, requireRelationshipId, resolveAppleApp, resourceId, textAttribute,
  type JsonApiDocument, type JsonApiResource,
} from './store-jsonapi.js';
import { locale, requireVersionForApp } from './store-apple-ops.js';
import type { ConnectorContext, ConnectorResult } from './types.js';

// App Store Connect OpenAPI 4.5 (checked 2026-09-24): AppPreviewSetCreateRequest{previewType},
// AppPreviewCreateRequest{fileName,fileSize,mimeType?,previewFrameTimeCode?}, AppPreviewUpdateRequest
// {uploaded,sourceFileChecksum,previewFrameTimeCode}; AppPreview has assetDeliveryState and
// videoDeliveryState. App Store Connect Help "App preview specifications": .mov/.m4v/.mp4,
// up to 500 MB, 15–30 seconds, up to 3 previews per device type.
export const APPLE_PREVIEW_TYPES = [
  'IPHONE_67', 'IPHONE_61', 'IPHONE_65', 'IPHONE_58', 'IPHONE_55', 'IPHONE_47', 'IPHONE_40', 'IPHONE_35',
  'IPAD_PRO_3GEN_129', 'IPAD_PRO_3GEN_11', 'IPAD_PRO_129', 'IPAD_105', 'IPAD_97', 'DESKTOP', 'APPLE_TV', 'APPLE_VISION_PRO',
] as const;
const MAX_PREVIEW_BYTES = 500 * 1024 * 1024;
const MAX_PREVIEWS_PER_SET = 3;
const EXTENSION_MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime' };
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

function previewType(value: unknown): string {
  const raw = text(value, '미리보기 유형', 40).toUpperCase().replace(/-/g, '_').replace(/^APP_/, '');
  if (!(APPLE_PREVIEW_TYPES as readonly string[]).includes(raw)) {
    throw new AppError('INVALID_INPUT', `App Store 미리보기 유형이 아닙니다. 사용 가능: ${APPLE_PREVIEW_TYPES.join(', ')}`);
  }
  return raw;
}

function frameTimeCode(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = text(value, '포스터 프레임 타임코드', 11);
  if (!/^\d{2}:[0-5]\d:[0-5]\d(?::\d{2})?$/.test(raw)) throw new AppError('INVALID_INPUT', '포스터 프레임 타임코드는 HH:MM:SS 또는 HH:MM:SS:FF 형식이어야 합니다. 예: 00:00:05:00');
  return raw;
}

/** Sniffs the ISO BMFF / QuickTime container so a renamed file is never sent with a wrong MIME type. */
export function previewMime(name: string, head: Uint8Array): string {
  const expected = EXTENSION_MIME[extname(name).toLowerCase()];
  if (!expected) throw new AppError('INVALID_INPUT', 'App Store 미리보기는 .mov, .m4v, .mp4 동영상이어야 합니다.');
  const bytes = Buffer.from(head);
  const box = bytes.length >= 12 ? bytes.toString('latin1', 4, 8) : '';
  const sniffed = box === 'ftyp' ? (bytes.toString('latin1', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4')
    : QUICKTIME_ATOMS.has(box) ? 'video/quicktime' : '';
  if (sniffed !== expected) throw new AppError('INVALID_INPUT', '동영상 확장자와 파일 형식(MP4/QuickTime)이 일치하지 않거나 동영상 파일이 아닙니다.');
  return expected;
}

/** Asset and video processing must both finish; either FAILED is terminal. */
function previewState(preview: JsonApiResource): { asset: MediaState; video: MediaState; confirmed: boolean; failed: boolean; errors: MediaState['errors'] } {
  const asset = parseMediaState(preview);
  const video = parseMediaState(preview, 'videoDeliveryState');
  const hasVideo = attribute(preview, 'videoDeliveryState') !== undefined;
  const failed = asset.failed || video.failed;
  return { asset, video, failed, confirmed: !failed && asset.confirmed && (!hasVideo || video.confirmed), errors: [...asset.errors, ...video.errors] };
}

async function readHead(file: FileHandle): Promise<Uint8Array> {
  const buffer = Buffer.alloc(12);
  const { bytesRead } = await file.read(buffer, 0, 12, 0);
  return buffer.subarray(0, bytesRead);
}

async function md5(file: FileHandle, signal: AbortSignal): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) { signal.throwIfAborted(); hash.update(chunk as Buffer); }
  return hash.digest('hex');
}

async function findOrCreatePreviewSet(context: ConnectorContext, localizationId: string, type: string, headers: Record<string, string>): Promise<string> {
  const existing = await collectPages(context,
    `${API}/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appPreviewSets?filter[previewType]=${encodeURIComponent(type)}&limit=50`,
    headers, '미리보기 세트');
  const match = existing.find(item => textAttribute(item, 'previewType') === type);
  if (match) return match.id;
  return one(await context.request<JsonApiDocument>(`${API}/v1/appPreviewSets`, {
    method: 'POST', headers, write: true,
    json: { data: { type: 'appPreviewSets', attributes: { previewType: type },
      relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } } } },
  }), '미리보기 세트 생성').id;
}

async function readPreview(context: ConnectorContext, id: string, headers: Record<string, string>): Promise<JsonApiResource> {
  return one(await context.request<JsonApiDocument>(`${API}/v1/appPreviews/${encodeURIComponent(id)}`, { headers }), '미리보기');
}

export async function uploadApplePreview(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const versionId = resourceId(input.appStoreVersionId, '앱 스토어 버전 ID');
  const selectedLocale = locale(input.locale);
  const type = previewType(input.previewType);
  const timeCode = frameTimeCode(input.previewFrameTimeCode);
  const localizationIdInput = input.localizationId === undefined || input.localizationId === '' ? undefined : resourceId(input.localizationId, '현지화 ID');
  const artifact = context.artifact;
  if (!artifact || artifact.kind === 'directory') {
    throw new AppError('MISSING_REQUIREMENT', 'App Preview 업로드에는 검증된 동영상 파일 결과물이 필요합니다. 프로젝트에 등록한 동영상을 연결해 주세요.');
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_PREVIEW_BYTES) {
    throw new AppError('INVALID_INPUT', 'App Store 미리보기 동영상은 500MB 이하여야 합니다.');
  }
  const file = await openVerifiedAppleArtifact(artifact, context.signal);
  try {
    const mimeType = previewMime(artifact.name, await readHead(file));
    const checksum = await md5(file, context.signal);
    const app = await resolveAppleApp(context);
    const headers = await appleAuthHeaders(context);
    await requireVersionForApp(context, versionId, app.id, headers);
    const localizationId = await findLocalization(context, versionId, selectedLocale, localizationIdInput, headers);
    const setId = await findOrCreatePreviewSet(context, localizationId, type, headers);
    const set = one(await context.request<JsonApiDocument>(`${API}/v1/appPreviewSets/${encodeURIComponent(setId)}?include=appStoreVersionLocalization`, { headers }), '미리보기 세트');
    if (requireRelationshipId(set, 'appStoreVersionLocalization', '미리보기 세트') !== localizationId) {
      throw new AppError('INVALID_INPUT', `미리보기 세트(${setId})가 선택한 현지화에 속하지 않습니다.`);
    }
    context.checkpoint({ appleAppId: app.id, appleAppStoreVersionId: versionId, appleLocalizationId: localizationId, appleAppPreviewSetId: setId, previewType: type, phase: 'set-ready' });
    const listed = await collectPages(context, `${API}/v1/appPreviewSets/${encodeURIComponent(setId)}/appPreviews?limit=50`, headers, '미리보기 목록');
    if (listed.length >= MAX_PREVIEWS_PER_SET) throw new AppError('INVALID_INPUT', `이 기기 유형의 미리보기는 최대 ${MAX_PREVIEWS_PER_SET}개입니다.`);

    let preview = one(await context.request<JsonApiDocument>(`${API}/v1/appPreviews`, {
      method: 'POST', headers, write: true,
      json: { data: { type: 'appPreviews', attributes: { fileName: artifact.name, fileSize: artifact.size, mimeType, ...(timeCode ? { previewFrameTimeCode: timeCode } : {}) },
        relationships: { appPreviewSet: { data: { type: 'appPreviewSets', id: setId } } } } },
    }), '미리보기 예약');
    context.checkpoint({ appleAppPreviewId: preview.id, appPreviewId: preview.id, appleAppPreviewSetId: setId, artifactSha256: artifact.sha256, phase: 'preview-reserved' });
    let state = previewState(preview);
    if (state.failed) throw new AppError('PROVIDER_REJECTED', 'App Store Connect가 이 미리보기 업로드를 실패로 보고했습니다.', 422, state.errors);
    if (!state.confirmed) {
      if (state.asset.state === 'AWAITING_UPLOAD' || attribute(preview, 'uploadOperations')) {
        let sent = 0;
        for (const part of parseAppleUploadOperations(preview, artifact.size)) {
          context.signal.throwIfAborted();
          await context.request<string>(part.url, { method: part.method, headers: part.requestHeaders, body: await applePartBody(file, part), write: true, format: 'text' });
          sent += part.length;
          context.progress(`미리보기 업로드 ${Math.min(100, Math.round((sent / artifact.size) * 100))}%`);
        }
        context.checkpoint({ appleAppPreviewId: preview.id, appPreviewId: preview.id, phase: 'parts-uploaded' });
      }
      await context.request<JsonApiDocument>(`${API}/v1/appPreviews/${encodeURIComponent(preview.id)}`, {
        method: 'PATCH', headers, write: true,
        json: { data: { type: 'appPreviews', id: preview.id, attributes: { uploaded: true, sourceFileChecksum: checksum, ...(timeCode ? { previewFrameTimeCode: timeCode } : {}) } } },
      });
      context.checkpoint({ appleAppPreviewId: preview.id, appPreviewId: preview.id, sourceFileChecksum: checksum, phase: 'committed' });
      preview = await readPreview(context, preview.id, headers);
      state = previewState(preview);
    }
    if (state.failed) throw new AppError('PROVIDER_REJECTED', 'App Store Connect가 미리보기 처리를 실패로 보고했습니다. 길이(15–30초)·해상도·코덱을 확인해 주세요.', 422, state.errors);
    return {
      waitingExternal: !state.confirmed,
      resources: [{
        kind: 'creative', externalId: preview.id, name: `${selectedLocale} ${type} preview`, status: state.video.state !== 'UNKNOWN' ? state.video.state : state.asset.state,
        data: { bundleId: app.bundleId, appStoreVersionId: versionId, localizationId, previewType: type, appPreviewSetId: setId, appPreviewId: preview.id,
          fileName: artifact.name, mimeType, sha256: artifact.sha256, sourceFileChecksum: checksum, previewFrameTimeCode: timeCode ?? null },
      }],
      summary: {
        appPreviewId: preview.id, appPreviewSetId: setId, appStoreVersionId: versionId, localizationId, locale: selectedLocale, previewType: type,
        assetDeliveryState: state.asset.state, videoDeliveryState: state.video.state, confirmed: state.confirmed, failed: false,
        artifactSha256: artifact.sha256, sourceFileChecksum: checksum,
      },
    };
  } finally { await file.close(); }
}

export async function reconcileApplePreview(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const previewId = resourceId(input.appPreviewId ?? input.externalId, '미리보기 ID');
  const headers = await appleAuthHeaders(context);
  const preview = await readPreview(context, previewId, headers);
  const setId = requireRelationshipId(preview, 'appPreviewSet', '미리보기');
  const set = one(await context.request<JsonApiDocument>(`${API}/v1/appPreviewSets/${encodeURIComponent(setId)}?include=appStoreVersionLocalization`, { headers }), '미리보기 세트');
  const localizationId = requireRelationshipId(set, 'appStoreVersionLocalization', '미리보기 세트');
  const localization = one(await context.request<JsonApiDocument>(
    `${API}/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}?include=appStoreVersion`, { headers }), '버전 현지화');
  const versionId = requireRelationshipId(localization, 'appStoreVersion', '버전 현지화');
  const app = await resolveAppleApp(context);
  await requireVersionForApp(context, versionId, app.id, headers);
  const state = previewState(preview);
  return {
    waitingExternal: !state.confirmed && !state.failed,
    failed: state.failed,
    summary: {
      appPreviewId: preview.id, appPreviewSetId: setId, appStoreVersionId: versionId,
      assetDeliveryState: state.asset.state, videoDeliveryState: state.video.state,
      confirmed: state.confirmed, failed: state.failed, errors: state.errors,
    },
  };
}
