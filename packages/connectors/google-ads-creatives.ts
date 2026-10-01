import { AppError, text } from '../domain/errors.js';
import { codePointLength, parseJsonArray } from './json-fields.js';
import type { CreativeImage } from './creative-media.js';

/**
 * App campaign AppAd assets.
 *
 * Official sources (2026-09-11):
 * - Create ad group & ad: https://developers.google.com/google-ads/api/docs/app-campaigns/create-ad-group
 *   Ad group type must NOT be set. APP_CAMPAIGN uses AppAdInfo.
 * - Add app campaign sample: 2 headlines + 2 descriptions; images optional
 *   (up to 20 existing image assets).
 * - Help: headlines ≤5 × 30 chars, descriptions ≤5 × 90 chars
 *   https://support.google.com/google-ads/answer/9948381
 * - ACE minimum: 2 headlines + 1 description
 *   https://support.google.com/google-ads/answer/9234183
 * - Image upload (2026-09-24): AssetService `customers/{id}/assets:mutate` create with
 *   `type=IMAGE`, `imageAsset.data`(base64 bytes, mutate only). Same content under another name
 *   is deduplicated by Google and "the new name will be dropped silently".
 *   https://developers.google.com/google-ads/api/docs/assets/working-with-assets
 * - App campaign image spec: .jpg/.png, max 5MB; 1:1 min 200x200, 1.91:1 min 600x314, 4:5 min 320x400
 *   https://support.google.com/google-ads/answer/9948381
 */

export interface AppAdAssets {
  headlines: string[];
  descriptions: string[];
  imageAssetResourceNames: string[];
  youtubeVideoIds: string[];
}

const ASSET_NAME = /^customers\/\d+\/assets\/\d+$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function boundedText(value: string, label: string, max: number): string {
  const trimmed = text(value, label, max * 4);
  if (codePointLength(trimmed) > max) throw new AppError('INVALID_INPUT', `${label}은(는) ${max}자 이하여야 합니다.`);
  return trimmed;
}

export function parseAppAdAssets(input: Record<string, unknown>, required: boolean): AppAdAssets | undefined {
  const headlines = parseJsonArray(input.headlines, '헤드라인', { max: 5 }).map((item, index) => boundedText(item, `헤드라인 ${index + 1}`, 30));
  const descriptions = parseJsonArray(input.descriptions, '설명', { max: 5 }).map((item, index) => boundedText(item, `설명 ${index + 1}`, 90));
  const imageAssetResourceNames = parseJsonArray(input.imageAssetResourceNames, '이미지 애셋 리소스', { max: 20 });
  for (const name of imageAssetResourceNames) {
    if (!ASSET_NAME.test(name)) throw new AppError('INVALID_INPUT', '이미지 애셋은 customers/{id}/assets/{id} 형식이어야 합니다. 새 이미지는 mediaAssetId로 업로드합니다.');
  }
  const youtubeVideoIds = parseJsonArray(input.youtubeVideoIds, 'YouTube 동영상 ID', { max: 20 });
  for (const id of youtubeVideoIds) {
    if (!YOUTUBE_ID.test(id)) throw new AppError('INVALID_INPUT', 'YouTube 동영상 ID는 11자여야 합니다.');
  }
  const present = headlines.length + descriptions.length + imageAssetResourceNames.length + youtubeVideoIds.length;
  if (!present) {
    if (required) throw new AppError('CREATIVE_REQUIRED', 'App 광고에는 헤드라인 2–5개와 설명 1–5개가 필요합니다.');
    return undefined;
  }
  if (headlines.length < 2 || descriptions.length < 1) {
    throw new AppError('CREATIVE_REQUIRED', 'App 광고는 헤드라인 2–5개(각 30자)와 설명 1–5개(각 90자)가 필요합니다.');
  }
  return { headlines, descriptions, imageAssetResourceNames, youtubeVideoIds };
}

/** Help 문서의 "5MB"를 5 MiB로 해석한다. 초과분은 Google이 거부하므로 전송 전에 막는다. */
export const APP_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const APP_IMAGE_RATIOS = [
  { label: '1:1', ratio: 1, minWidth: 200, minHeight: 200 },
  { label: '1.91:1', ratio: 1.91, minWidth: 600, minHeight: 314 },
  { label: '4:5', ratio: 0.8, minWidth: 320, minHeight: 400 },
] as const;
/** 비율 허용 오차. 공식 문서에 오차 규정이 없어 1200x628(1.9108) 같은 권장 크기를 받는 최소값으로 둔다. */
const RATIO_TOLERANCE = 0.01;

/** App 캠페인 이미지 형식·크기·비율 검사. 통과한 비율 이름을 돌려준다. */
export function validateAppImage(image: Pick<CreativeImage, 'mime' | 'width' | 'height' | 'bytes'>): string {
  if (image.mime !== 'image/png' && image.mime !== 'image/jpeg') throw new AppError('INVALID_IMAGE', 'Google Ads App 광고 이미지는 PNG 또는 JPEG만 허용합니다.');
  if (image.bytes.length > APP_IMAGE_MAX_BYTES) throw new AppError('INVALID_IMAGE', `Google Ads App 광고 이미지는 ${APP_IMAGE_MAX_BYTES.toLocaleString('en-US')}바이트(5MB) 이하여야 합니다.`);
  const ratio = image.width / image.height;
  const spec = APP_IMAGE_RATIOS.find(item => Math.abs(ratio - item.ratio) / item.ratio <= RATIO_TOLERANCE);
  if (!spec) throw new AppError('INVALID_IMAGE', `Google Ads App 광고 이미지 비율은 1:1, 1.91:1, 4:5 중 하나여야 합니다. 현재 ${image.width}x${image.height}입니다.`);
  if (image.width < spec.minWidth || image.height < spec.minHeight) {
    throw new AppError('INVALID_IMAGE', `${spec.label} 이미지는 최소 ${spec.minWidth}x${spec.minHeight}이어야 합니다. 현재 ${image.width}x${image.height}입니다.`);
  }
  return spec.label;
}

/** 응답 유실 뒤 같은 이미지를 이름으로 다시 찾기 위한 결정적 asset 이름. */
export function appImageAssetName(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AppError('INVALID_INPUT', '이미지 sha256을 확인할 수 없습니다.');
  return `gso-image-${sha256}`;
}

export function appAdMeetsMinimum(ad: Record<string, unknown>): boolean {
  const appAd = (ad.appAd ?? {}) as Record<string, unknown>;
  const headlines = Array.isArray(appAd.headlines) ? appAd.headlines : [];
  const descriptions = Array.isArray(appAd.descriptions) ? appAd.descriptions : [];
  const headlineTexts = headlines.filter(item => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string');
  const descriptionTexts = descriptions.filter(item => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string');
  return headlineTexts.length >= 2 && descriptionTexts.length >= 1;
}

export function buildAppAdOperations(options: {
  customerId: string;
  campaignResourceName: string;
  adGroupTemp: string;
  adGroupName: string;
  assets: AppAdAssets;
  youtubeTempStart: number;
}): Record<string, unknown>[] {
  const operations: Record<string, unknown>[] = [];
  const youtubeAssets: Array<{ asset: string }> = [];
  for (const [index, videoId] of options.assets.youtubeVideoIds.entries()) {
    const resourceName = `customers/${options.customerId}/assets/${options.youtubeTempStart - index}`;
    operations.push({
      assetOperation: {
        create: { resourceName, youtubeVideoAsset: { youtubeVideoId: videoId } },
      },
    });
    youtubeAssets.push({ asset: resourceName });
  }
  operations.push({
    adGroupOperation: {
      create: {
        resourceName: options.adGroupTemp,
        name: options.adGroupName,
        campaign: options.campaignResourceName,
        status: 'ENABLED',
      },
    },
  });
  const appAd: Record<string, unknown> = {
    headlines: options.assets.headlines.map(item => ({ text: item })),
    descriptions: options.assets.descriptions.map(item => ({ text: item })),
  };
  if (options.assets.imageAssetResourceNames.length) {
    appAd.images = options.assets.imageAssetResourceNames.map(asset => ({ asset }));
  }
  if (youtubeAssets.length) appAd.youtubeVideos = youtubeAssets;
  operations.push({
    adGroupAdOperation: {
      create: {
        adGroup: options.adGroupTemp,
        status: 'ENABLED',
        ad: { appAd },
      },
    },
  });
  return operations;
}
