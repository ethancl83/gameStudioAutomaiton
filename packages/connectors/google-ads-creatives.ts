import { AppError, text } from '../domain/errors.js';
import { codePointLength, parseJsonArray } from './json-fields.js';

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
    if (!ASSET_NAME.test(name)) throw new AppError('INVALID_INPUT', '이미지 애셋은 customers/{id}/assets/{id} 형식이어야 합니다. 바이너리 업로드는 이 작업에서 하지 않습니다.');
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
