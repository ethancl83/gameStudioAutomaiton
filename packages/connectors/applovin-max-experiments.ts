// AppLovin MAX 광고 단위 실험(/ad_unit_experiment/{ad-unit-ID}) 읽기·쓰기.
// 근거(2026-09-24 확인): https://support.applovin.com/en/max/advanced-features/ad-unit-management-api
// MAX 실험은 미디에이션 waterfall·빈도 제한·bid floor를 바꾸는 수익화 실험이며 사용자 획득 광고 A/B가 아니다.
// 광고 단위당 활성 실험은 하나이며, 실험 ID는 부모 광고 단위 ID와 같다.
import { AppError, text } from '../domain/errors.js';
import type { ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { HOST, auth } from './applovin-max-client.js';

type Row = Record<string, unknown>;
const ALLOCATIONS = [50, 25, 10, 5];
const SETTINGS = [
  { input: 'adNetworkSettings', field: 'ad_network_settings', label: '광고 네트워크 설정' },
  { input: 'frequencyCappingSettings', field: 'frequency_capping_settings', label: '빈도 제한 설정' },
  { input: 'bidFloors', field: 'bid_floors', label: 'bid floor 설정' },
] as const;
const WRITE_GATE = '실계정 쓰기 검증 필요: create/promote/deprecate는 문서 계약과 모의 응답으로만 검증했습니다.';

function adUnitId(value: unknown): string {
  const id = text(value, '광고 단위 ID', 64);
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new AppError('INVALID_INPUT', '광고 단위 ID 형식을 확인해 주세요.');
  return id;
}

function experimentName(value: unknown): string {
  const name = text(value, '실험 이름', 200);
  if (/[\n\r\0]/.test(name)) throw new AppError('INVALID_INPUT', '실험 이름에는 줄바꿈을 쓸 수 없습니다.');
  return name;
}

function rejectSegment(input: Record<string, unknown>): void {
  if (input.segmentId !== undefined && input.segmentId !== '') {
    throw new AppError('UNSUPPORTED_OPERATION', '세그먼트 waterfall 실험 쓰기 payload는 공식 문서에서 확인되지 않아 지원하지 않습니다. 광고 단위 전체 실험만 변경합니다.');
  }
}

function settingsArray(value: unknown, label: string): Row[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw new AppError('INVALID_INPUT', `${label}은(는) JSON 객체 배열이어야 합니다.`); }
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 200 || parsed.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new AppError('INVALID_INPUT', `${label}은(는) 1–200개의 JSON 객체 배열이어야 합니다.`);
  }
  return parsed as Row[];
}

/** 부모 광고 단위를 읽고 프로젝트 앱과 소유권이 일치하는지 확인한다. */
async function loadUnit(ctx: ConnectorContext, id: string): Promise<Row> {
  const unit = await ctx.request<unknown>(`${HOST}/ad_unit/${encodeURIComponent(id)}?fields=segments`, { headers: auth(ctx) });
  if (!unit || typeof unit !== 'object' || Array.isArray(unit)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'MAX 광고 단위 응답 형식을 확인할 수 없습니다.');
  const row = unit as Row;
  const expected = ctx.project?.appIdentifier;
  if (expected && row.package_name !== expected) {
    throw new AppError('RESOURCE_MISMATCH', `광고 단위 패키지(${String(row.package_name ?? '없음')})가 프로젝트 앱(${expected})과 다릅니다.`);
  }
  return row;
}

async function loadExperiment(ctx: ConnectorContext, id: string, segmentId?: string): Promise<Row> {
  const path = segmentId ? `${encodeURIComponent(id)}/${encodeURIComponent(segmentId)}` : encodeURIComponent(id);
  const data = await ctx.request<unknown>(`${HOST}/ad_unit_experiment/${path}?fields=ad_network_settings,frequency_capping_settings,bid_floors`, { headers: auth(ctx) });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'MAX 광고 단위 실험 응답 형식을 확인할 수 없습니다.');
  return data as Row;
}

function networks(value: unknown): Array<{ network: string; disabled: boolean; adUnitCount: number }> {
  // 네트워크 app/ad unit 식별자는 저장하지 않고 변경 범위만 요약한다.
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => (entry && typeof entry === 'object' ? Object.entries(entry as Row) : []).map(([network, setting]) => {
    const item = (setting ?? {}) as Row;
    return { network, disabled: item.disabled === true, adUnitCount: Array.isArray(item.ad_network_ad_units) ? item.ad_network_ad_units.length : 0 };
  }));
}

function experimentResource(unit: Row, experiment: Row, id: string, segmentId?: string): ResourceInput {
  const packageName = typeof unit.package_name === 'string' ? unit.package_name : typeof experiment.package_name === 'string' ? experiment.package_name : undefined;
  return {
    kind: 'experiment', externalId: segmentId ? `${id}:${segmentId}` : id,
    name: String(experiment.experiment_name ?? id),
    status: experiment.disabled === true ? 'DISABLED' : 'ACTIVE',
    data: {
      adUnitId: id, segmentId, experimentName: experiment.experiment_name, packageName, appIdentifier: packageName,
      platform: unit.platform ?? experiment.platform, adFormat: unit.ad_format ?? experiment.ad_format,
      hasActiveExperiment: true, promote: experiment.promote === true, deprecate: experiment.deprecate === true,
      kind: 'monetization',
      groups: {
        control: { source: 'ad_unit', note: '실험에 지정하지 않은 설정은 부모 광고 단위 설정을 따릅니다.' },
        test: {
          allocationPercent: typeof experiment.test_group_allocation === 'number' ? experiment.test_group_allocation : undefined,
          adNetworks: networks(experiment.ad_network_settings),
          frequencyCappingSettings: Array.isArray(experiment.frequency_capping_settings) ? experiment.frequency_capping_settings : undefined,
          bidFloors: Array.isArray(experiment.bid_floors) ? experiment.bid_floors : undefined,
        },
      },
    },
  };
}

export async function probeAdUnitExperiments(ctx: ConnectorContext): Promise<ConnectorResult> {
  const checkedAt = new Date().toISOString();
  const capability = (level: 'action_required' | 'read', reasons: string[]) =>
    ({ connectionId: ctx.connection.id, provider: ctx.connection.provider, kind: 'max_ad_unit_experiment', level, reasons, checkedAt, verification: 'fixture' });
  let rows: unknown;
  try { rows = await ctx.request<unknown>(`${HOST}/ad_units`, { headers: auth(ctx) }); }
  catch (error) {
    if (error instanceof AppError && (error.code === 'PERMISSION_REQUIRED' || error.code === 'AUTH_REQUIRED')) {
      return { summary: { capability: capability('action_required', [`MAX 광고 단위 조회가 거부되었습니다: ${error.message}`]) } };
    }
    throw error;
  }
  if (!Array.isArray(rows)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'MAX 광고 단위 목록이 배열이 아닙니다.');
  const expected = ctx.project?.appIdentifier;
  const units = rows.filter((item): item is Row => Boolean(item) && typeof item === 'object' && (!expected || (item as Row).package_name === expected));
  return {
    summary: {
      adUnitCount: units.length, activeExperimentCount: units.filter(item => item.has_active_experiment === true).length,
      capability: capability('read', ['광고 단위 실험 조회가 가능합니다.', WRITE_GATE, 'MAX 실험은 수익화(미디에이션) 실험이며 사용자 획득 A/B가 아닙니다.']),
    },
  };
}

export async function listAdUnitExperiments(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const id = adUnitId(input.adUnitId);
  const segmentId = input.segmentId === undefined || input.segmentId === '' ? undefined : text(input.segmentId, '세그먼트 ID', 64);
  const unit = await loadUnit(ctx, id);
  if (segmentId && !(Array.isArray(unit.segments) && unit.segments.some(item => String((item as Row)?.id ?? '') === segmentId))) {
    throw new AppError('RESOURCE_NOT_FOUND', '광고 단위에서 해당 세그먼트를 찾을 수 없습니다.', 404);
  }
  if (unit.has_active_experiment !== true) return { resources: [], summary: { adUnitId: id, segmentId, hasActiveExperiment: false } };
  const experiment = await loadExperiment(ctx, id, segmentId);
  const resource = experimentResource(unit, experiment, id, segmentId);
  return { resources: [resource], summary: { adUnitId: id, segmentId, hasActiveExperiment: true, experimentName: resource.name } };
}

export async function createAdUnitExperiment(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  rejectSegment(input);
  const id = adUnitId(input.adUnitId);
  const name = experimentName(input.experimentName);
  const body: Row = { experiment_name: name };
  if (input.testGroupAllocation !== undefined && input.testGroupAllocation !== '') {
    const allocation = Number(input.testGroupAllocation);
    if (!ALLOCATIONS.includes(allocation)) throw new AppError('INVALID_INPUT', '테스트 그룹 비율은 50, 25, 10, 5 중 하나여야 합니다.');
    body.test_group_allocation = allocation;
  }
  for (const setting of SETTINGS) {
    const value = settingsArray(input[setting.input], setting.label);
    if (value) body[setting.field] = value;
  }
  if (Object.keys(body).every(key => key === 'experiment_name' || key === 'test_group_allocation')) {
    throw new AppError('INVALID_INPUT', '실험에서 바꿀 설정(광고 네트워크·빈도 제한·bid floor) 중 하나 이상이 필요합니다.');
  }
  // 입력의 hasActiveExperiment 동기화 값은 오래됐을 수 있으므로 쓰기 직전에 다시 읽는다.
  const unit = await loadUnit(ctx, id);
  if (unit.disabled === true) throw new AppError('UNSUPPORTED_CHANGE', '비활성 광고 단위에는 실험을 만들 수 없습니다.', 409);
  if (unit.has_active_experiment === true) {
    const current = await loadExperiment(ctx, id);
    if (current.experiment_name === name) {
      return { resources: [experimentResource(unit, current, id)], summary: { adUnitId: id, experimentName: name, reused: true } };
    }
    throw new AppError('EXPERIMENT_CONFLICT', `광고 단위에 이미 다른 활성 실험(${String(current.experiment_name ?? '')})이 있습니다. 광고 단위당 활성 실험은 하나입니다.`, 409);
  }
  const saved = await ctx.request<unknown>(`${HOST}/ad_unit_experiment/${encodeURIComponent(id)}`, { method: 'POST', headers: auth(ctx), json: body, write: true });
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) || String((saved as Row).id ?? '') !== id) {
    throw new AppError('INVALID_PROVIDER_RESPONSE', '생성된 MAX 실험의 광고 단위 ID를 확인할 수 없습니다.');
  }
  ctx.checkpoint({ stage: 'max-experiment', adUnitId: id, experimentName: name });
  return { resources: [experimentResource(unit, saved as Row, id)], summary: { adUnitId: id, experimentName: name, created: true, testGroupAllocation: body.test_group_allocation } };
}

async function finish(input: Record<string, unknown>, ctx: ConnectorContext, action: 'promote' | 'deprecate'): Promise<ConnectorResult> {
  rejectSegment(input);
  const id = adUnitId(input.adUnitId);
  const name = experimentName(input.experimentName);
  const unit = await loadUnit(ctx, id);
  if (unit.has_active_experiment !== true) {
    throw new AppError('RESOURCE_NOT_FOUND', '광고 단위에 활성 실험이 없습니다. 이미 promote 또는 deprecate되었을 수 있으니 MAX 대시보드에서 확인해 주세요.', 404);
  }
  const current = await loadExperiment(ctx, id);
  if (current.experiment_name !== name) throw new AppError('RESOURCE_MISMATCH', `활성 실험(${String(current.experiment_name ?? '')})이 요청한 실험 이름과 다릅니다.`, 409);
  const body = { id, experiment_name: name, promote: action === 'promote', deprecate: action === 'deprecate' };
  const saved = await ctx.request<Row>(`${HOST}/ad_unit_experiment/${encodeURIComponent(id)}`, { method: 'POST', headers: auth(ctx), json: body, write: true });
  ctx.checkpoint({ stage: `max-experiment-${action}`, adUnitId: id, experimentName: name });
  const after = await loadUnit(ctx, id);
  const resource = experimentResource(unit, current, id);
  return {
    resources: [{ ...resource, status: action === 'promote' ? 'PROMOTED' : 'DEPRECATED', data: { ...resource.data, hasActiveExperiment: after.has_active_experiment === true, [action]: true } }],
    summary: { adUnitId: id, experimentName: name, [action === 'promote' ? 'promoted' : 'deprecated']: true, providerMessage: typeof saved.message === 'string' ? saved.message.slice(0, 200) : undefined, hasActiveExperiment: after.has_active_experiment === true },
  };
}

export const promoteAdUnitExperiment = (input: Record<string, unknown>, ctx: ConnectorContext) => finish(input, ctx, 'promote');
export const deprecateAdUnitExperiment = (input: Record<string, unknown>, ctx: ConnectorContext) => finish(input, ctx, 'deprecate');
