import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import sharp from 'sharp';
import { extname } from 'node:path';
import { AppError, text } from '../domain/errors.js';
import { parseAppleUploadOperations, type AppleUploadOperation } from './apple-upload.js';
import {
  APP_STORE_API,
  appleAuthHeaders,
  attribute,
  collectPages,
  many,
  one,
  requireRelationshipId,
  resolveAppleApp,
  resourceId,
  textAttribute,
  type JsonApiDocument,
  type JsonApiResource,
} from './store-jsonapi.js';
import { locale, requireLocalizationForVersion, requireVersionForApp } from './store-apple-ops.js';
import type { ConnectorContext, ConnectorResult } from './types.js';

const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;
const MAX_SCREENSHOTS_PER_SET = 10;
const API = APP_STORE_API;

/** Official Screenshot Display Type sizes from App Store Connect Help screenshot specifications (2026-09-10). */
const DISPLAY_SIZES: Record<string, ReadonlyArray<readonly [number, number]>> = {
  APP_IPHONE_67: [[1260, 2736], [1290, 2796], [1320, 2868], [2736, 1260], [2796, 1290], [2868, 1320]],
  APP_IPHONE_65: [[1284, 2778], [1242, 2688], [2778, 1284], [2688, 1242]],
  APP_IPHONE_61: [[1179, 2556], [1206, 2622], [2556, 1179], [2622, 1206], [1170, 2532], [1125, 2436], [1080, 2340], [2532, 1170], [2436, 1125], [2340, 1080]],
  APP_IPHONE_58: [[1170, 2532], [1125, 2436], [1080, 2340], [2532, 1170], [2436, 1125], [2340, 1080]],
  APP_IPHONE_55: [[1242, 2208], [2208, 1242]],
  APP_IPHONE_47: [[750, 1334], [1334, 750]],
  APP_IPHONE_40: [[640, 1096], [640, 1136], [1136, 600], [1136, 640]],
  APP_IPHONE_35: [[640, 920], [640, 960], [960, 600], [960, 640]],
  APP_IPAD_PRO_3GEN_129: [[2048, 2732], [2732, 2048], [2064, 2752], [2752, 2064]],
  APP_IPAD_PRO_3GEN_11: [[1488, 2266], [2266, 1488], [1668, 2420], [2420, 1668], [1668, 2388], [2388, 1668], [1640, 2360], [2360, 1640]],
  APP_IPAD_PRO_129: [[2048, 2732], [2732, 2048]],
  APP_IPAD_105: [[1668, 2224], [2224, 1668]],
  APP_IPAD_97: [[1536, 2008], [1536, 2048], [2048, 1496], [2048, 1536], [768, 1004], [768, 1024], [1024, 748], [1024, 768]],
  APP_DESKTOP: [[1280, 800], [1440, 900], [2560, 1600], [2880, 1800]],
  APP_WATCH_ULTRA: [[410, 502], [422, 514]],
  APP_WATCH_SERIES_10: [[416, 496]],
  APP_WATCH_SERIES_7: [[396, 484]],
  APP_WATCH_SERIES_4: [[368, 448]],
  APP_WATCH_SERIES_3: [[312, 390]],
  APP_APPLE_TV: [[1920, 1080], [3840, 2160]],
  APP_APPLE_VISION_PRO: [[3840, 2160]],
};

export const APPLE_SCREENSHOT_DISPLAY_TYPES = Object.keys(DISPLAY_SIZES);

type UploadOperation = AppleUploadOperation;

interface MediaState { state: string; confirmed: boolean; failed: boolean; errors: Array<{ code: string; description: string }> }

function displayType(input: Record<string, unknown>): string {
  const raw = text(input.screenshotDisplayType ?? input.imageType, '스크린샷 표시 유형', 60).toUpperCase().replace(/-/g, '_');
  if (!DISPLAY_SIZES[raw]) {
    throw new AppError('INVALID_INPUT', `App Store 스크린샷 표시 유형이 아닙니다. 사용 가능: ${APPLE_SCREENSHOT_DISPLAY_TYPES.join(', ')}`);
  }
  return raw;
}

export async function inspectScreenshotBytes(name: string, bytes: Buffer): Promise<{ mime: string; width: number; height: number }> {
  const extension = extname(name).toLowerCase();
  const expected = extension === '.png' ? 'png' : ['.jpg','.jpeg'].includes(extension) ? 'jpeg' : null;
  if (!expected || !bytes.length || bytes.length > MAX_SCREENSHOT_BYTES) throw new AppError('INVALID_INPUT','App Store 스크린샷은 15MB 이하의 PNG/JPEG 파일이어야 합니다.');
  const decoder = sharp(bytes,{limitInputPixels:16_777_216,limitInputChannels:4,failOn:'warning',pages:1}).timeout({seconds:5});
  try {
    const meta = await decoder.metadata();
    if (meta.format !== expected || !meta.width || !meta.height || (meta.pages??1)!==1 || meta.hasAlpha) throw new AppError('INVALID_INPUT','알파 채널·투명도·애니메이션이 없는 PNG/JPEG 스크린샷을 선택해 주세요.');
    const {data,info}=await decoder.raw().toBuffer({resolveWithObject:true});
    if (info.width!==meta.width || info.height!==meta.height || data.length!==info.width*info.height*info.channels) throw new AppError('INVALID_INPUT','스크린샷 픽셀을 끝까지 읽을 수 없습니다.');
    return {mime:'image/'+expected,width:info.width,height:info.height};
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_INPUT','스크린샷 파일이 손상되었거나 이미지 크기·처리 한도를 넘습니다. 다시 내보낸 PNG/JPEG를 등록해 주세요.');
  } finally { decoder.destroy(); }
}

function assertDisplaySize(type: string, width: number, height: number): void {
  const allowed = DISPLAY_SIZES[type]!;
  if (!allowed.some(([w, h]) => w === width && h === height)) {
    throw new AppError(
      'INVALID_INPUT',
      `${type} 스크린샷 크기는 ${allowed.map(([w, h]) => `${w}×${h}`).join(', ')} 픽셀이어야 합니다. 현재: ${width}×${height}.`,
    );
  }
}


function parseMediaState(resource: JsonApiResource): MediaState {
  const raw = attribute(resource, 'assetDeliveryState');
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const state = typeof object.state === 'string' && object.state !== '' ? object.state : 'UNKNOWN';
  const errors: Array<{ code: string; description: string }> = [];
  if (Array.isArray(object.errors)) {
    for (const item of object.errors as Array<Record<string, unknown>>) {
      errors.push({
        code: typeof item.code === 'string' ? item.code : 'error',
        description: typeof item.description === 'string' ? item.description : '',
      });
    }
  }
  return { state, confirmed: state === 'COMPLETE', failed: state === 'FAILED', errors };
}

async function readScreenshot(context: ConnectorContext, id: string, headers: Record<string, string>): Promise<JsonApiResource> {
  return one(
    await context.request<JsonApiDocument>(`${API}/v1/appScreenshots/${encodeURIComponent(id)}`, { headers }),
    '스크린샷',
  );
}

async function findLocalization(
  context: ConnectorContext,
  versionId: string,
  selectedLocale: string,
  localizationId: string | undefined,
  headers: Record<string, string>,
): Promise<string> {
  if (localizationId) {
    await requireLocalizationForVersion(context, localizationId, versionId, selectedLocale, headers);
    return localizationId;
  }
  const localizations = await collectPages(
    context,
    `${API}/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=50`,
    headers,
    '버전 현지화',
  );
  const match = localizations.find(item => textAttribute(item, 'locale') === selectedLocale);
  if (!match) {
    throw new AppError('RESOURCE_NOT_FOUND', `로케일 ${selectedLocale}의 스토어 현지화가 없습니다. 먼저 update-listing으로 현지화를 만들어 주세요.`, 404);
  }
  return match.id;
}

async function findOrCreateSet(
  context: ConnectorContext,
  localizationId: string,
  type: string,
  headers: Record<string, string>,
): Promise<string> {
  const existing = await collectPages(
    context,
    `${API}/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets?limit=50`,
    headers,
    '스크린샷 세트',
  );
  const match = existing.find(item => textAttribute(item, 'screenshotDisplayType') === type);
  if (match) return match.id;
  const created = one(
    await context.request<JsonApiDocument>(`${API}/v1/appScreenshotSets`, {
      method: 'POST',
      headers,
      write: true,
      json: {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: type },
          relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } } },
        },
      },
    }),
    '스크린샷 세트 생성',
  );
  return created.id;
}

async function listSetScreenshots(context: ConnectorContext, setId: string, headers: Record<string, string>): Promise<JsonApiResource[]> {
  return collectPages(
    context,
    `${API}/v1/appScreenshotSets/${encodeURIComponent(setId)}/appScreenshots?limit=50`,
    headers,
    '스크린샷 목록',
  );
}

async function reserveScreenshot(
  context: ConnectorContext,
  setId: string,
  fileName: string,
  fileSize: number,
  headers: Record<string, string>,
): Promise<JsonApiResource> {
  const listed = await listSetScreenshots(context, setId, headers);
  if (listed.length >= MAX_SCREENSHOTS_PER_SET) {
    throw new AppError('INVALID_INPUT', `이 표시 유형의 스크린샷은 최대 ${MAX_SCREENSHOTS_PER_SET}장입니다.`);
  }
  return one(
    await context.request<JsonApiDocument>(`${API}/v1/appScreenshots`, {
      method: 'POST',
      headers,
      write: true,
      json: {
        data: {
          type: 'appScreenshots',
          attributes: { fileName, fileSize },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
        },
      },
    }),
    '스크린샷 예약',
  );
}

async function putParts(
  context: ConnectorContext,
  bytes: Buffer,
  fileSize: number,
  operations: UploadOperation[],
): Promise<void> {
  let sent = 0;
  for (const operation of operations) {
    context.signal.throwIfAborted();
    if (operation.offset + operation.length > fileSize) {
      throw new AppError('INVALID_PROVIDER_RESPONSE', '업로드 범위가 파일 크기를 넘습니다.', 502);
    }
    const part = bytes.subarray(operation.offset, operation.offset + operation.length);
    if (part.length !== operation.length) {
      throw new AppError('INVALID_INPUT', '스크린샷 파일을 읽는 중 크기가 달라졌습니다. 다시 등록해 주세요.');
    }
    await context.request<string>(operation.url, {
      method: operation.method,
      headers: operation.requestHeaders,
      body: new Uint8Array(part),
      write: true,
      format: 'text',
    });
    sent += operation.length;
    context.progress(`스크린샷 업로드 ${Math.min(100, Math.round((sent / fileSize) * 100))}%`);
  }
}

export async function uploadAppleScreenshot(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  if (input.previewType !== undefined || input.appPreviewSetId !== undefined) {
    throw new AppError('UNSUPPORTED_OPERATION', 'App Store 미리보기 동영상(appPreviews)은 이 범위에서 지원하지 않습니다. 스크린샷만 업로드할 수 있습니다.');
  }
  const versionId = resourceId(input.appStoreVersionId, '앱 스토어 버전 ID');
  const selectedLocale = locale(input.locale);
  const type = displayType(input);
  const localizationIdInput = input.localizationId === undefined ? undefined : resourceId(input.localizationId, '현지화 ID');
  const artifact = context.artifact;
  if (!artifact || artifact.kind === 'directory') {
    throw new AppError('MISSING_REQUIREMENT', '스토어 스크린샷 업로드에는 검증된 이미지 파일 결과물이 필요합니다. 프로젝트에 등록한 미디어를 연결해 주세요.');
  }
  if (artifact.size <= 0 || artifact.size > MAX_SCREENSHOT_BYTES) {
    throw new AppError('INVALID_INPUT', 'App Store 스크린샷은 15MB 이하여야 합니다.');
  }
  const file=await open(artifact.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let bytes:Buffer;
  try {const info=await file.stat();if(!info.isFile()||info.size!==artifact.size||info.size>MAX_SCREENSHOT_BYTES)throw new AppError('MEDIA_CHANGED','등록한 이미지 파일 크기가 변경되었습니다.',409);bytes=await file.readFile();}finally{await file.close();}
  if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new AppError('MEDIA_CHANGED', '등록 이후 이미지가 변경되었습니다. 다시 등록해 주세요.', 409);
  }
  const image = await inspectScreenshotBytes(artifact.name, bytes);
  assertDisplaySize(type, image.width, image.height);
  const md5 = createHash('md5').update(bytes).digest('hex');

  const app = await resolveAppleApp(context);
  const headers = await appleAuthHeaders(context);
  await requireVersionForApp(context, versionId, app.id, headers);
  const localizationId = await findLocalization(context, versionId, selectedLocale, localizationIdInput, headers);
  context.checkpoint({ appleAppId: app.id, appleAppStoreVersionId: versionId, appleLocalizationId: localizationId, screenshotDisplayType: type, phase: 'localization-ready' });

  const setId = await findOrCreateSet(context, localizationId, type, headers);
  const set = one(
    await context.request<JsonApiDocument>(`${API}/v1/appScreenshotSets/${encodeURIComponent(setId)}?include=appStoreVersionLocalization`, { headers }),
    '스크린샷 세트',
  );
  const relatedLocalization = requireRelationshipId(set, 'appStoreVersionLocalization', '스크린샷 세트');
  if (relatedLocalization !== localizationId) {
    throw new AppError('INVALID_INPUT', `스크린샷 세트(${setId})가 선택한 현지화에 속하지 않습니다.`);
  }
  context.checkpoint({ appleAppScreenshotSetId: setId, appleLocalizationId: localizationId, phase: 'set-ready' });

  let screenshot = await reserveScreenshot(context, setId, artifact.name, artifact.size, headers);
  context.checkpoint({ appleAppScreenshotId: screenshot.id, appScreenshotId: screenshot.id, appleAppScreenshotSetId: setId, artifactSha256: artifact.sha256, phase: 'screenshot-reserved' });

  let state = parseMediaState(screenshot);
  if (state.failed) {
    throw new AppError('PROVIDER_REJECTED', 'App Store Connect가 이 스크린샷 업로드를 실패로 보고했습니다.', 422, state.errors);
  }
  if (!state.confirmed) {
    if (state.state === 'AWAITING_UPLOAD' || attribute(screenshot, 'uploadOperations')) {
      const operations = parseAppleUploadOperations(screenshot, artifact.size);
      await putParts(context, bytes, artifact.size, operations);
      context.checkpoint({ appleAppScreenshotId: screenshot.id, appScreenshotId: screenshot.id, phase: 'parts-uploaded' });
    }
    await context.request<JsonApiDocument>(`${API}/v1/appScreenshots/${encodeURIComponent(screenshot.id)}`, {
      method: 'PATCH',
      headers,
      write: true,
      json: {
        data: {
          type: 'appScreenshots',
          id: screenshot.id,
          attributes: { uploaded: true, sourceFileChecksum: md5 },
        },
      },
    });
    context.checkpoint({ appleAppScreenshotId: screenshot.id, appScreenshotId: screenshot.id, sourceFileChecksum: md5, phase: 'committed' });
    screenshot = await readScreenshot(context, screenshot.id, headers);
    state = parseMediaState(screenshot);
  }
  if (state.failed) {
    throw new AppError('PROVIDER_REJECTED', 'App Store Connect가 스크린샷 처리를 실패로 보고했습니다.', 422, state.errors);
  }
  return {
    waitingExternal: !state.confirmed,
    resources: [{
      kind: 'creative',
      externalId: screenshot.id,
      name: `${selectedLocale} ${type}`,
      status: state.state,
      data: {
        bundleId: app.bundleId,
        appStoreVersionId: versionId,
        localizationId,
        screenshotDisplayType: type,
        appScreenshotSetId: setId,
        appScreenshotId: screenshot.id,
        fileName: artifact.name,
        width: image.width,
        height: image.height,
        sha256: artifact.sha256,
        sourceFileChecksum: md5,
      },
    }],
    summary: {
      appScreenshotId: screenshot.id,
      appScreenshotSetId: setId,
      appStoreVersionId: versionId,
      localizationId,
      locale: selectedLocale,
      screenshotDisplayType: type,
      assetDeliveryState: state.state,
      confirmed: state.confirmed,
      failed: false,
      artifactSha256: artifact.sha256,
      sourceFileChecksum: md5,
    },
  };
}

export async function reconcileAppleScreenshot(input: Record<string, unknown>, context: ConnectorContext): Promise<ConnectorResult> {
  const screenshotId = resourceId(input.appScreenshotId ?? input.externalId, '스크린샷 ID');
  const headers = await appleAuthHeaders(context);
  const screenshot = await readScreenshot(context, screenshotId, headers);
  const setId = requireRelationshipId(screenshot, 'appScreenshotSet', '스크린샷');
  const set = one(
    await context.request<JsonApiDocument>(`${API}/v1/appScreenshotSets/${encodeURIComponent(setId)}?include=appStoreVersionLocalization`, { headers }),
    '스크린샷 세트',
  );
  const localizationId = requireRelationshipId(set, 'appStoreVersionLocalization', '스크린샷 세트');
  const localization = one(
    await context.request<JsonApiDocument>(`${API}/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}?include=appStoreVersion`, { headers }),
    '버전 현지화',
  );
  const versionId = requireRelationshipId(localization, 'appStoreVersion', '버전 현지화');
  const app = await resolveAppleApp(context);
  await requireVersionForApp(context, versionId, app.id, headers);
  const state = parseMediaState(screenshot);
  return {
    waitingExternal: !state.confirmed && !state.failed,
    failed: state.failed,
    summary: {
      appScreenshotId: screenshot.id,
      appScreenshotSetId: setId,
      appStoreVersionId: versionId,
      assetDeliveryState: state.state,
      confirmed: state.confirmed,
      failed: state.failed,
      errors: state.errors,
    },
  };
}
