// AppLovin Axon Campaign Management API 소재 세트(creative set)·asset 관리.
// 근거(2026-09-24 확인): https://support.applovin.com/en/growth/promoting-your-apps/api/axon-campaign-management-api
// /creative_set/list·list_by_campaign_id·create·update, /asset/list·upload(multipart files)·upload_result, asset_hash=SHA1.
import { createHash } from 'node:crypto';
import { AppError, text } from '../domain/errors.js';
import type { ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { countryCode } from './marketing-utils.js';
import { parseJsonArray } from './json-fields.js';
import { imageExtension, readCreativeImage, type CreativeImage } from './creative-media.js';
import { accountId, auth, manageUrl, readCampaign } from './applovin-ads-client.js';

type Row = Record<string, unknown>;

const LANGUAGES = new Set(['ALBANIAN', 'ARABIC', 'BASQUE', 'BENGALI', 'BOSNIAN', 'BULGARIAN', 'CATALAN', 'CHINESE_SIMPLIFIED', 'CHINESE_TRADITIONAL', 'CROATIAN', 'CZECH', 'DANISH', 'DUTCH', 'ENGLISH', 'ESTONIAN', 'FARSI', 'FINNISH', 'FRENCH', 'GEORGIAN', 'GERMAN', 'GREEK', 'HEBREW', 'HINDI', 'HUNGARIAN', 'ICELANDIC', 'INDONESIAN', 'ITALIAN', 'JAPANESE', 'JAVANESE', 'KOREAN', 'LATVIAN', 'LITHUANIAN', 'MACEDONIAN', 'MALAY', 'MARATHI', 'NORWEGIAN', 'POLISH', 'PORTUGESE', 'ROMANIAN', 'RUSSIAN', 'SERBIAN', 'SLOVAK', 'SLOVENIAN', 'SPANISH', 'SUNDANESE', 'SWEDISH', 'THAI', 'TURKISH', 'UIGHUR', 'UKRAINIAN', 'URDU', 'VIETNAMESE']);
const ASSET_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const NUMERIC_ID = /^\d{1,20}$/;

function numericId(value: unknown, label: string): string {
  const id = text(value, label, 20);
  if (!NUMERIC_ID.test(id)) throw new AppError('INVALID_INPUT', `${label}는 숫자여야 합니다.`);
  return id;
}

function listInput(value: unknown, label: string, max: number): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string' && !value.trim().startsWith('[')) return value.split(',').map(item => item.trim()).filter(Boolean);
  return parseJsonArray(value, label, { max });
}

function languagesInput(value: unknown): string[] {
  const languages = [...new Set(listInput(value, '언어', 60).map(item => item.toUpperCase()))];
  for (const language of languages) if (!LANGUAGES.has(language)) throw new AppError('INVALID_INPUT', `지원하지 않는 AppLovin 언어 값입니다: ${language}. 예: ENGLISH, KOREAN`);
  return languages;
}

function countriesInput(value: unknown): string[] {
  return [...new Set(listInput(value, '국가', 250).map(item => countryCode(item)))];
}

function creativeStatus(value: unknown): 'LIVE' | 'PAUSED' {
  const status = text(value, '소재 세트 상태', 16).toUpperCase();
  if (status !== 'LIVE' && status !== 'PAUSED') throw new AppError('INVALID_INPUT', '소재 세트 상태는 LIVE 또는 PAUSED만 허용합니다.');
  return status;
}

function assetSummary(item: Row): Row {
  return { id: String(item.id ?? ''), name: item.name, status: item.status, assetType: item.asset_type ?? item.type, resourceType: item.resource_type };
}

function creativeSetResource(item: Row, campaignId?: string): ResourceInput {
  const assets = Array.isArray(item.assets) ? item.assets.filter((asset): asset is Row => Boolean(asset) && typeof asset === 'object') : [];
  return {
    kind: 'creative', externalId: String(item.id ?? ''), name: String(item.name ?? item.id ?? ''), status: String(item.status ?? 'UNKNOWN'),
    data: {
      campaignId: item.campaign_id != null ? String(item.campaign_id) : campaignId, type: item.type, version: item.version,
      assets: assets.map(assetSummary), assetIds: assets.map(asset => String(asset.id ?? '')).filter(Boolean),
      languages: Array.isArray(item.languages) ? item.languages : [], countries: Array.isArray(item.countries) ? item.countries : [],
      productPage: item.product_page || undefined, createdAt: item.created_at,
    },
  };
}

async function listCreativeSets(ctx: ConnectorContext, campaignId?: string, ids?: string): Promise<ResourceInput[]> {
  const resources: ResourceInput[] = [];
  for (let page = 1; page <= 50; page++) {
    const extra: Record<string, string> = { page: String(page), size: '100' };
    let rows: unknown;
    if (campaignId) {
      const data = await ctx.request<Row>(manageUrl('/creative_set/list_by_campaign_id', ctx, { ...extra, ids: campaignId }), { headers: auth(ctx) });
      const campaigns = data && typeof data === 'object' ? (data.campaigns ?? {}) as Row : undefined;
      if (!campaigns || typeof campaigns !== 'object') throw new AppError('INVALID_PROVIDER_RESPONSE', '캠페인별 소재 세트 응답 형식을 확인할 수 없습니다.');
      rows = campaigns[campaignId] ?? [];
    } else {
      rows = await ctx.request<unknown>(manageUrl('/creative_set/list', ctx, ids ? { ...extra, ids } : extra), { headers: auth(ctx) });
    }
    if (!Array.isArray(rows)) throw new AppError('INVALID_PROVIDER_RESPONSE', '소재 세트 목록 응답이 배열이 아닙니다.');
    for (const row of rows) if (row && typeof row === 'object') resources.push(creativeSetResource(row as Row, campaignId));
    if (ids || rows.length < 100) return resources;
  }
  throw new AppError('PAGINATION_LIMIT', '소재 세트 전체 목록을 가져오지 못했습니다. 이전 목록을 보존합니다.');
}

export async function listCreatives(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const campaignId = input.externalId === undefined || input.externalId === '' ? undefined : numericId(input.externalId, '캠페인 ID');
  const resources = await listCreativeSets(ctx, campaignId);
  // 캠페인으로 거른 목록은 계정 전체가 아니므로 캐시 교체(snapshot)에 쓰지 않는다.
  return { resources, ...(campaignId ? {} : { resourceSnapshots: [{ kind: 'creative' as const }] }), summary: { accountId: accountId(ctx), campaignId, creativeSetCount: resources.length } };
}

async function listAssets(ctx: ConnectorContext, extra: Record<string, string>): Promise<Row[]> {
  const rows = await ctx.request<unknown>(manageUrl('/asset/list', ctx, extra), { headers: auth(ctx) });
  if (!Array.isArray(rows)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'AppLovin asset 목록 응답이 배열이 아닙니다.');
  return rows.filter((row): row is Row => Boolean(row) && typeof row === 'object');
}

/** 공식 asset_hash(SHA1)로 이미 올린 같은 이미지를 찾는다. 응답 유실 뒤 재시도에서 중복 업로드를 막는다. */
async function findImageByHash(ctx: ConnectorContext, sha1: string): Promise<Row | undefined> {
  for (let page = 1; page <= 50; page++) {
    const rows = await listAssets(ctx, { resource_type: 'image', page: String(page), size: '100' });
    const found = rows.find(row => String(row.asset_hash ?? '').toLowerCase() === sha1);
    if (found || rows.length < 100) return found;
  }
  throw new AppError('PAGINATION_LIMIT', 'AppLovin 이미지 asset이 너무 많아 중복 여부를 확인할 수 없습니다.');
}

function rejectedAsset(row: Row): never {
  const reasons = Array.isArray(row.violation_reasons) ? row.violation_reasons.filter(item => typeof item === 'string').slice(0, 5).join(', ') : '';
  throw new AppError('ASSET_REJECTED', `AppLovin이 asset ${String(row.id ?? '')}을(를) 거부했습니다${reasons ? `: ${reasons}` : ''}. 다른 이미지를 사용해 주세요.`, 409);
}

type UploadOutcome = { assetId: string; reused: boolean; uploadId?: string } | { pending: true; uploadId: string };

async function uploadResult(ctx: ConnectorContext, uploadId: string): Promise<{ status: string; detail?: Row }> {
  const data = await ctx.request<Row>(manageUrl('/asset/upload_result', ctx, { upload_id: uploadId }), { headers: auth(ctx) });
  const details = Array.isArray(data?.details) ? data.details.filter((row): row is Row => Boolean(row) && typeof row === 'object') : [];
  return { status: String(data?.upload_status ?? ''), detail: details[0] };
}

async function ensureImageAsset(ctx: ConnectorContext, image: CreativeImage): Promise<UploadOutcome> {
  const sha1 = createHash('sha1').update(image.bytes).digest('hex');
  const existing = await findImageByHash(ctx, sha1);
  if (existing) {
    if (existing.status === 'REJECTED') rejectedAsset(existing);
    return { assetId: String(existing.id ?? ''), reused: true };
  }
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), `gso-${image.sha256.slice(0, 32)}.${imageExtension(image.mime)}`);
  const uploaded = await ctx.request<Row>(manageUrl('/asset/upload', ctx), { method: 'POST', headers: auth(ctx), body: form, write: true });
  const uploadId = typeof uploaded?.upload_id === 'string' ? uploaded.upload_id : '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uploadId)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'AppLovin 업로드 ID를 확인할 수 없습니다.');
  ctx.checkpoint({ stage: 'asset-upload', uploadId, sha1, sha256: image.sha256 });
  const result = await uploadResult(ctx, uploadId);
  if (result.detail?.file_status === 'FAILURE') {
    throw new AppError('ASSET_REJECTED', `AppLovin이 이미지 업로드를 처리하지 못했습니다${typeof result.detail.error_message === 'string' ? `: ${result.detail.error_message.slice(0, 200)}` : ''}.`, 409);
  }
  const assetId = result.detail?.id != null ? String(result.detail.id) : '';
  if (result.status === 'FINISHED' && result.detail?.file_status === 'SUCCESS' && NUMERIC_ID.test(assetId)) return { assetId, reused: false, uploadId };
  return { pending: true, uploadId };
}

/** 공식 규칙: 소재 세트에는 HOSTED_HTML 또는 (IMG_INTER_P + 동영상)이 필요하다. 거부된 asset은 쓰지 않는다. */
async function assertComposition(ctx: ConnectorContext, assetIds: string[]): Promise<Row[]> {
  if (!assetIds.length) throw new AppError('CREATIVE_REQUIRED', '소재 세트에 넣을 asset이 필요합니다.');
  if (assetIds.length > 100) throw new AppError('INVALID_INPUT', 'asset은 100개 이하여야 합니다.');
  const rows = await listAssets(ctx, { ids: assetIds.join(','), page: '1', size: '100' });
  const byId = new Map(rows.map(row => [String(row.id ?? ''), row]));
  const missing = assetIds.filter(id => !byId.has(id));
  if (missing.length) throw new AppError('RESOURCE_NOT_FOUND', `이 계정에서 AppLovin asset을 찾을 수 없습니다: ${missing.join(', ')}`, 404);
  const assets = assetIds.map(id => byId.get(id)!);
  const rejected = assets.find(row => row.status === 'REJECTED');
  if (rejected) rejectedAsset(rejected);
  const types = new Set(assets.map(row => String(row.asset_type ?? '')));
  const video = assets.some(row => String(row.resource_type ?? '').toUpperCase() === 'VIDEO' || /^VID_/.test(String(row.asset_type ?? '')));
  if (!types.has('HOSTED_HTML') && !(types.has('IMG_INTER_P') && video)) {
    throw new AppError('CREATIVE_REQUIRED', 'AppLovin 소재 세트에는 HOSTED_HTML(플레이어블) 또는 세로 전면 이미지(IMG_INTER_P)와 동영상이 함께 필요합니다. 이미지 한 장만으로는 만들 수 없습니다.');
  }
  return assets;
}

function assertCampaignApp(ctx: ConnectorContext, campaign: ResourceInput): void {
  const expected = ctx.project?.appIdentifier;
  const pkg = campaign.data.packageName;
  if (expected && typeof pkg === 'string' && pkg && pkg !== expected) throw new AppError('RESOURCE_MISMATCH', `캠페인의 앱(${pkg})이 선택한 프로젝트 앱과 다릅니다.`, 409);
}

async function readCreativeSet(ctx: ConnectorContext, id: string): Promise<ResourceInput> {
  const found = (await listCreativeSets(ctx, undefined, id)).find(item => item.externalId === id);
  if (!found) throw new AppError('RESOURCE_NOT_FOUND', 'AppLovin 소재 세트를 찾을 수 없습니다.', 404);
  return found;
}

async function mediaImage(input: Record<string, unknown>, ctx: ConnectorContext): Promise<CreativeImage | undefined> {
  if (input.mediaAssetId === undefined || input.mediaAssetId === '') return undefined;
  text(input.mediaAssetId, '등록 이미지', 100);
  return readCreativeImage(ctx, { allowed: ['image/png', 'image/jpeg', 'image/gif'], maxBytes: ASSET_UPLOAD_MAX_BYTES, label: 'AppLovin asset' });
}

function pendingUpload(uploadId: string, extra: Row): ConnectorResult {
  return {
    waitingExternal: true,
    summary: { ...extra, uploadId, uploadStatus: 'PENDING', nextAction: 'AppLovin이 이미지를 처리하는 중입니다. 처리 뒤 같은 입력으로 다시 실행하면 SHA1 asset_hash로 찾은 asset을 재사용해 이어서 진행합니다.' },
  };
}

function assetIdsInput(value: unknown): string[] {
  const ids = [...new Set(listInput(value, 'AppLovin asset ID', 100))];
  for (const id of ids) if (!NUMERIC_ID.test(id)) throw new AppError('INVALID_INPUT', 'AppLovin asset ID는 숫자여야 합니다.');
  return ids;
}

export async function createCreative(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const campaignId = numericId(input.externalId, '캠페인 ID');
  const name = text(input.name, '소재 세트 이름', 255);
  const status = input.status === undefined || input.status === '' ? 'PAUSED' : creativeStatus(input.status);
  const assetIds = assetIdsInput(input.assetIds);
  const languages = languagesInput(input.languages);
  const countries = countriesInput(input.countries ?? input.country);
  const image = await mediaImage(input, ctx);
  if (!assetIds.length && !image) throw new AppError('CREATIVE_REQUIRED', '기존 AppLovin asset ID 또는 등록 이미지(mediaAssetId)가 필요합니다.');
  const campaign = await readCampaign(ctx, campaignId);
  assertCampaignApp(ctx, campaign);
  let uploaded: Extract<UploadOutcome, { assetId: string }> | undefined;
  if (image) {
    const outcome = await ensureImageAsset(ctx, image);
    if ('pending' in outcome) return pendingUpload(outcome.uploadId, { externalId: campaignId, creativeSetCreated: false });
    uploaded = outcome;
    if (!assetIds.includes(outcome.assetId)) assetIds.push(outcome.assetId);
  }
  await assertComposition(ctx, assetIds);
  // 응답 유실 뒤 재실행: 같은 캠페인의 같은 이름 소재 세트를 먼저 찾는다.
  const existing = (await listCreativeSets(ctx, campaignId)).find(item => item.name === name);
  if (existing) {
    const current = new Set(existing.data.assetIds as string[]);
    if (!assetIds.every(id => current.has(id))) throw new AppError('RECONCILIATION_REQUIRED', '같은 이름의 소재 세트가 다른 asset 구성으로 이미 있습니다. update-creative로 변경하거나 다른 이름을 사용해 주세요.', 409);
    return { resources: [existing], summary: { externalId: campaignId, creativeSetId: existing.externalId, reused: true, status: existing.status, assetIds, ...(uploaded ? { uploadedAssetId: uploaded.assetId, assetReused: uploaded.reused } : {}) } };
  }
  const body: Row = { campaign_id: campaignId, type: 'APP', name, assets: assetIds.map(id => ({ id })), status };
  if (languages.length) body.languages = languages;
  if (countries.length) body.countries = countries;
  const created = await ctx.request<Row>(manageUrl('/creative_set/create', ctx), { method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, json: body, write: true });
  const id = created?.id != null ? String(created.id) : '';
  if (!NUMERIC_ID.test(id)) throw new AppError('INVALID_PROVIDER_RESPONSE', '생성된 소재 세트 ID를 확인할 수 없습니다.');
  ctx.checkpoint({ stage: 'creative-set', externalId: campaignId, creativeSetId: id, name });
  const resource = await readCreativeSet(ctx, id);
  return {
    resources: [resource],
    summary: { externalId: campaignId, creativeSetId: id, created: true, status: resource.status, requestedStatus: status, version: created.version, assetIds, ...(uploaded ? { uploadedAssetId: uploaded.assetId, assetReused: uploaded.reused } : {}) },
  };
}

export async function updateCreative(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const campaignId = numericId(input.externalId, '캠페인 ID');
  const creativeSetId = numericId(input.creativeSetId, '소재 세트 ID');
  const body: Row = { id: creativeSetId, campaign_id: campaignId, type: 'APP' };
  if (input.name !== undefined && input.name !== '') body.name = text(input.name, '소재 세트 이름', 255);
  if (input.status !== undefined && input.status !== '') body.status = creativeStatus(input.status);
  if (input.languages !== undefined && input.languages !== '') body.languages = languagesInput(input.languages);
  const countryInput = input.countries ?? input.country;
  if (countryInput !== undefined && countryInput !== '') body.countries = countriesInput(countryInput);
  const replaceAssets = input.assetIds !== undefined && input.assetIds !== '';
  const requested = replaceAssets ? assetIdsInput(input.assetIds) : [];
  const image = await mediaImage(input, ctx);
  if (Object.keys(body).length === 3 && !replaceAssets && !image) throw new AppError('INVALID_INPUT', '변경할 소재 세트 필드가 없습니다.');
  const campaign = await readCampaign(ctx, campaignId);
  assertCampaignApp(ctx, campaign);
  const current = await readCreativeSet(ctx, creativeSetId);
  if (current.data.campaignId !== undefined && String(current.data.campaignId) !== campaignId) throw new AppError('RESOURCE_MISMATCH', '소재 세트가 선택한 캠페인에 속하지 않습니다.', 409);
  let uploaded: Extract<UploadOutcome, { assetId: string }> | undefined;
  if (image || replaceAssets) {
    const assetIds = replaceAssets ? requested : [...(current.data.assetIds as string[])];
    if (image) {
      const outcome = await ensureImageAsset(ctx, image);
      if ('pending' in outcome) return pendingUpload(outcome.uploadId, { externalId: campaignId, creativeSetId, updated: false });
      uploaded = outcome;
      if (!assetIds.includes(outcome.assetId)) assetIds.push(outcome.assetId);
    }
    await assertComposition(ctx, assetIds);
    body.assets = assetIds.map(id => ({ id }));
  }
  await ctx.request(manageUrl('/creative_set/update', ctx), { method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, json: body, write: true });
  ctx.checkpoint({ stage: 'creative-set-update', externalId: campaignId, creativeSetId });
  const resource = await readCreativeSet(ctx, creativeSetId);
  return {
    resources: [resource],
    summary: { externalId: campaignId, creativeSetId, updated: true, status: resource.status, changed: Object.keys(body).filter(key => !['id', 'campaign_id', 'type'].includes(key)), ...(uploaded ? { uploadedAssetId: uploaded.assetId, assetReused: uploaded.reused } : {}) },
  };
}

/** 업로드 처리 상태만 읽는다. 소재 세트 생성은 같은 입력의 재실행이 이어서 한다. */
export async function reconcileUpload(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const uploadId = text(input.uploadId, '업로드 ID', 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uploadId)) throw new AppError('INVALID_INPUT', '업로드 ID 형식을 확인해 주세요.');
  const result = await uploadResult(ctx, uploadId);
  const fileStatus = result.detail?.file_status;
  if (fileStatus === 'FAILURE') return { summary: { uploadId, uploadStatus: result.status, failed: true, confirmed: false } };
  if (result.status !== 'FINISHED') return { waitingExternal: true, summary: { uploadId, uploadStatus: result.status || 'PENDING', confirmed: false } };
  return { summary: { uploadId, uploadStatus: result.status, assetId: result.detail?.id != null ? String(result.detail.id) : undefined, confirmed: false,
    nextAction: '이미지 처리가 끝났습니다. 같은 입력으로 작업을 다시 실행하면 이 asset을 재사용해 소재 세트를 만들거나 수정합니다.' } };
}
