// Google Ads API v25 실험(Experiment/ExperimentArm) 읽기·쓰기.
// 근거(2026-09-24 확인): v25 REST discovery(revision 20260923)의 ExperimentService·ExperimentArmService 경로와
// Experiment/ExperimentArm 필드, docs/experiments/overview·campaign-mix·reporting.
// App 캠페인은 표준 system-managed 실험 유형에 없고 allowlist 전용 Campaign Mix(COMPARE_CAMPAIGNS)로만 비교할 수 있다.
import { AppError, text } from '../domain/errors.js';
import type { AttributionInput, ConnectorContext, ConnectorResult, ResourceInput } from './types.js';
import { moneyToMicros } from './marketing-utils.js';
import { parseMicros } from '../metrics/index.js';
import { HOST, customerInfo, headers, search } from './google-ads-client.js';

type Row = Record<string, unknown>;
type Info = Awaited<ReturnType<typeof customerInfo>>;
interface Arm { resourceName: string; name: string; control: boolean; trafficSplit: number | null; campaigns: string[]; inDesignCampaigns: string[] }
interface ExperimentRecord {
  resourceName: string; experimentId: string; name: string; type: string; status: string;
  startDate?: string; endDate?: string; promoteStatus?: string; longRunningOperation?: string;
}

const EXPERIMENT_FIELDS = 'experiment.resource_name, experiment.experiment_id, experiment.name, experiment.type, experiment.status, experiment.start_date, experiment.end_date, experiment.promote_status, experiment.long_running_operation';
const ARM_FIELDS = 'experiment_arm.resource_name, experiment_arm.name, experiment_arm.experiment, experiment_arm.control, experiment_arm.traffic_split, experiment_arm.campaigns, experiment_arm.in_design_campaigns';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TERMINAL = new Set(['REMOVED', 'HALTED', 'PROMOTED', 'GRADUATED']);
const APP_SUBTYPES = new Set(['APP_CAMPAIGN', 'APP_CAMPAIGN_FOR_ENGAGEMENT', 'APP_CAMPAIGN_FOR_PRE_REGISTRATION']);
const MIX_REASON = 'App 캠페인은 표준 system-managed 실험 유형에 포함되지 않습니다. App 캠페인 A/B는 allowlist 계정 전용 Campaign Mix(COMPARE_CAMPAIGNS)로만 가능합니다.';
const WRITE_GATE = '실험 생성·일정·종료·promote 쓰기는 실계정(테스트 계정) 쓰기 검증 전까지 자동 실행 권한으로 올리지 않습니다.';

function experimentRecord(row: Row): ExperimentRecord {
  const item = (row.experiment ?? {}) as Row;
  const resourceName = String(item.resourceName ?? '');
  const experimentId = String(item.experimentId ?? resourceName.match(/experiments\/(\d+)$/)?.[1] ?? '');
  if (!/^\d+$/.test(experimentId)) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Google Ads 실험 ID를 확인할 수 없습니다.');
  const optional = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    resourceName, experimentId, name: String(item.name ?? experimentId), type: String(item.type ?? 'UNKNOWN'), status: String(item.status ?? 'UNKNOWN'),
    startDate: optional(item.startDate), endDate: optional(item.endDate), promoteStatus: optional(item.promoteStatus), longRunningOperation: optional(item.longRunningOperation),
  };
}

function armRecord(row: Row): Arm & { experiment: string } {
  const item = (row.experimentArm ?? {}) as Row;
  const split = item.trafficSplit == null || item.trafficSplit === '' ? NaN : Number(item.trafficSplit);
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  return {
    resourceName: String(item.resourceName ?? ''), name: String(item.name ?? ''), experiment: String(item.experiment ?? ''),
    control: item.control === true,
    trafficSplit: Number.isInteger(split) && split >= 1 && split <= 100 ? split : null,
    campaigns: list(item.campaigns), inDesignCampaigns: list(item.inDesignCampaigns),
  };
}

/** 무작위 배정 근거가 캠페인 단위 지표로 증명 가능한지 검사한다. 실패 사유는 비교를 관찰 비교로 낮추는 근거다. */
function assignmentReasons(arms: Arm[]): string[] {
  const reasons: string[] = [];
  if (arms.length < 2) reasons.push('실험 arm이 2개 미만입니다.');
  if (arms.filter(arm => arm.control).length !== 1) reasons.push('control arm이 정확히 1개가 아닙니다.');
  for (const arm of arms) {
    if (arm.trafficSplit === null) reasons.push(`${arm.name || arm.resourceName} arm의 트래픽 분할 값이 없습니다.`);
    if (!arm.campaigns.length) reasons.push(`${arm.name || arm.resourceName} arm에 게재 캠페인이 없습니다${arm.inDesignCampaigns.length ? '(일정 전 in-design 캠페인만 있음)' : ''}.`);
  }
  if (arms.length && arms.every(arm => arm.trafficSplit !== null) && arms.reduce((sum, arm) => sum + arm.trafficSplit!, 0) !== 100) reasons.push('arm 트래픽 분할 합계가 100이 아닙니다.');
  const seen = new Map<string, number>();
  for (const campaign of arms.flatMap(arm => arm.campaigns)) seen.set(campaign, (seen.get(campaign) ?? 0) + 1);
  if ([...seen.values()].some(count => count > 1)) reasons.push('같은 캠페인이 여러 arm에 있어 캠페인 단위 지표로 arm을 구분할 수 없습니다.');
  return reasons;
}

function experimentResource(experiment: ExperimentRecord, arms: Arm[], customerId: string): ResourceInput {
  const reasons = assignmentReasons(arms);
  return {
    kind: 'experiment', externalId: experiment.experimentId, name: experiment.name, status: experiment.status,
    data: {
      resourceName: experiment.resourceName, customerId, type: experiment.type, status: experiment.status,
      startDate: experiment.startDate, endDate: experiment.endDate, promoteStatus: experiment.promoteStatus,
      arms: arms.map(arm => ({ resourceName: arm.resourceName, name: arm.name, control: arm.control, trafficSplit: arm.trafficSplit, campaigns: arm.campaigns, inDesignCampaigns: arm.inDesignCampaigns })),
      assignmentValid: reasons.length === 0, assignmentReasons: reasons,
    },
  };
}

function experimentId(value: unknown): string {
  const id = text(value, '실험 ID', 24);
  if (!/^\d{1,20}$/.test(id)) throw new AppError('INVALID_INPUT', '실험 ID는 숫자여야 합니다.');
  return id;
}

function campaignId(value: unknown, label: string): string {
  const id = text(value, label, 24);
  if (!/^\d{1,20}$/.test(id)) throw new AppError('INVALID_INPUT', `${label}는 숫자 캠페인 ID여야 합니다.`);
  return id;
}

function date(value: unknown, label: string): string {
  const raw = text(value, label, 10);
  if (!DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) {
    throw new AppError('INVALID_INPUT', `${label}는 YYYY-MM-DD 형식이어야 합니다.`);
  }
  return raw;
}

async function loadArms(ctx: ConnectorContext, experimentResourceName?: string): Promise<Map<string, Arm[]>> {
  const where = experimentResourceName ? ` WHERE experiment_arm.experiment = '${experimentResourceName}'` : '';
  const grouped = new Map<string, Arm[]>();
  for (const row of await search<Row>(ctx, `SELECT ${ARM_FIELDS} FROM experiment_arm${where}`)) {
    const { experiment, ...arm } = armRecord(row);
    grouped.set(experiment, [...(grouped.get(experiment) ?? []), arm]);
  }
  return grouped;
}

async function loadExperiment(ctx: ConnectorContext, id: string): Promise<{ experiment: ExperimentRecord; arms: Arm[] }> {
  const rows = await search<Row>(ctx, `SELECT ${EXPERIMENT_FIELDS} FROM experiment WHERE experiment.experiment_id = ${id}`);
  if (!rows[0]) throw new AppError('RESOURCE_NOT_FOUND', 'Google Ads 실험을 찾을 수 없습니다.', 404);
  const experiment = experimentRecord(rows[0]);
  return { experiment, arms: (await loadArms(ctx, experiment.resourceName)).get(experiment.resourceName) ?? [] };
}

export async function probeExperiments(ctx: ConnectorContext): Promise<ConnectorResult> {
  const checkedAt = new Date().toISOString();
  const capability = (level: 'unsupported' | 'action_required' | 'read', reasons: string[], verification: 'fixture' | 'read_verified') =>
    ({ connectionId: ctx.connection.id, provider: ctx.connection.provider, kind: 'ads_native_experiment', level, reasons, checkedAt, verification });
  const info = await customerInfo(ctx);
  if (info.manager) {
    return { summary: { customerId: info.id, capability: capability('action_required', ['관리자(MCC) 연결에서는 실험을 만들 수 없습니다. 광고 계정을 직접 연결해 주세요.', MIX_REASON], 'fixture') } };
  }
  let experiments: ExperimentRecord[];
  try {
    experiments = (await search<Row>(ctx, `SELECT ${EXPERIMENT_FIELDS} FROM experiment`)).map(experimentRecord);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === 'PERMISSION_REQUIRED') {
      return { summary: { customerId: info.id, capability: capability('action_required', [`실험 조회 권한이 거부되었습니다: ${error.message}`, MIX_REASON], 'fixture') } };
    }
    if (error.code === 'PROVIDER_REJECTED' || error.code === 'RESOURCE_NOT_FOUND') {
      return { summary: { customerId: info.id, capability: capability('unsupported', ['이 계정 또는 API 버전에서 experiment 리소스 조회를 허용하지 않았습니다.', MIX_REASON], 'fixture') } };
    }
    throw error;
  }
  const campaigns = await search<Row>(ctx, `SELECT campaign.id, campaign.advertising_channel_type, campaign.advertising_channel_sub_type FROM campaign WHERE campaign.status != 'REMOVED'`);
  const appCampaignCount = campaigns.filter(row => {
    const campaign = (row.campaign ?? {}) as Row;
    return campaign.advertisingChannelType === 'MULTI_CHANNEL' && APP_SUBTYPES.has(String(campaign.advertisingChannelSubType ?? ''));
  }).length;
  const campaignMixCount = experiments.filter(item => item.type === 'COMPARE_CAMPAIGNS' && item.status !== 'REMOVED').length;
  const base = { customerId: info.id, experimentCount: experiments.length, campaignMixExperimentCount: campaignMixCount, appCampaignCount };
  if (!appCampaignCount) {
    return { summary: { ...base, capability: capability('action_required', ['실험할 App 캠페인이 없습니다. 먼저 App 캠페인을 만들거나 동기화해 주세요.', MIX_REASON], 'read_verified') } };
  }
  if (!campaignMixCount) {
    return { summary: { ...base, capability: capability('action_required', [MIX_REASON, '이 계정의 Campaign Mix allowlist 접근을 확인하지 못했습니다. Google 담당자에게 allowlist를 요청한 뒤 다시 검사해 주세요.'], 'read_verified') } };
  }
  return { summary: { ...base, capability: capability('read', ['Campaign Mix(COMPARE_CAMPAIGNS) 실험 조회가 확인되었습니다.', WRITE_GATE], 'read_verified') } };
}

export async function listExperiments(ctx: ConnectorContext): Promise<ConnectorResult> {
  const info = await customerInfo(ctx);
  const experiments = (await search<Row>(ctx, `SELECT ${EXPERIMENT_FIELDS} FROM experiment WHERE experiment.status != 'REMOVED'`)).map(experimentRecord);
  const arms = experiments.length ? await loadArms(ctx) : new Map<string, Arm[]>();
  const resources = experiments.map(item => experimentResource(item, arms.get(item.resourceName) ?? [], info.id));
  return {
    resources, resourceSnapshots: [{ kind: 'experiment' }],
    summary: { customerId: info.id, experimentCount: resources.length, invalidAssignmentCount: resources.filter(item => item.data.assignmentValid !== true).length },
  };
}

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) throw new AppError('INVALID_PROVIDER_RESPONSE', 'Google Ads 지표 값 형식을 확인할 수 없습니다.');
  return parsed;
}

export async function experimentMetrics(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const id = experimentId(input.experimentId);
  let start = date(input.startDate, '시작일');
  let end = date(input.endDate, '종료일');
  if (start > end) throw new AppError('INVALID_INPUT', '시작일은 종료일보다 늦을 수 없습니다.');
  if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > 180) throw new AppError('INVALID_INPUT', '조회 기간은 180일 이하여야 합니다.');
  const windowDays = input.attributionWindowDays == null || input.attributionWindowDays === '' ? 0 : Number(input.attributionWindowDays);
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 90) throw new AppError('INVALID_INPUT', '귀속 창(일)은 0–90 정수여야 합니다. 0은 공급자 전환 액션 기본 창을 뜻합니다.');
  const info = await customerInfo(ctx);
  const { experiment, arms } = await loadExperiment(ctx, id);
  // 실험 기간 밖의 캠페인 지표는 arm 배정 근거가 없으므로 제외한다.
  if (experiment.startDate && experiment.startDate > start) start = experiment.startDate;
  if (experiment.endDate && experiment.endDate < end) end = experiment.endDate;
  const reasons = assignmentReasons(arms);
  const armByCampaign = new Map<string, Arm>();
  const shared = new Set<string>();
  for (const arm of arms) for (const resource of arm.campaigns) {
    const campaign = resource.match(/campaigns\/(\d+)$/)?.[1];
    if (!campaign) continue;
    if (armByCampaign.has(campaign)) shared.add(campaign);
    armByCampaign.set(campaign, arm);
  }
  for (const campaign of shared) armByCampaign.delete(campaign);
  const base = { customerId: info.id, currency: info.currency, experimentId: id, experimentType: experiment.type, from: start, to: end, assignmentValid: reasons.length === 0, assignmentReasons: reasons, excludedSharedCampaigns: [...shared],
    attributionWindowDays: windowDays, attributionWindowNote: windowDays === 0 ? '0은 계정 전환 액션의 기본 귀속 창을 그대로 사용했다는 뜻입니다.' : undefined };
  if (start > end || !armByCampaign.size) return { attribution: [], summary: { ...base, factCount: 0 } };
  const rows = await search<Row>(ctx, `SELECT campaign.id, campaign.app_campaign_setting.app_id, segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions FROM campaign WHERE campaign.id IN (${[...armByCampaign.keys()].join(', ')}) AND segments.date BETWEEN '${start}' AND '${end}'`);
  const dates = rows.map(row => String((row.segments as Row | undefined)?.date ?? '')).filter(value => DATE.test(value)).sort();
  const watermark = dates.at(-1) ?? end;
  const observedAt = new Date().toISOString();
  const attribution: AttributionInput[] = [];
  for (const row of rows) {
    const campaign = (row.campaign ?? {}) as Row;
    const campaignKey = String(campaign.id ?? '');
    const day = String((row.segments as Row | undefined)?.date ?? '');
    const arm = armByCampaign.get(campaignKey);
    if (!arm || !DATE.test(day)) continue;
    const metrics = (row.metrics ?? {}) as Row;
    const appId = (campaign.appCampaignSetting as Row | undefined)?.appId;
    const common = {
      campaignId: campaignKey, experimentId: id, armId: arm.resourceName, acquisitionDate: day, eventDate: day,
      cohortKey: `gads:${campaignKey}:${day}`, attributionWindowDays: windowDays, observedAt, sourceWatermark: watermark,
      revision: 1, finality: 'estimated' as const, ...(typeof appId === 'string' && appId ? { appIdentifier: appId } : {}),
    };
    const sourceId = (kind: string) => `google-ads:experiment:${info.id}:${id}:${campaignKey}:${day}:${kind}`;
    attribution.push(
      { ...common, kind: 'spend', currency: info.currency, amountMicros: parseMicros(String(metrics.costMicros ?? '0')).toString(), sourceId: sourceId('spend') },
      { ...common, kind: 'revenue', currency: info.currency, amountMicros: moneyToMicros(count(metrics.conversionsValue), '전환 가치'), revenueBasis: 'gross_conversion_value', sourceId: sourceId('revenue') },
      { ...common, kind: 'conversions', count: count(metrics.conversions), sourceId: sourceId('conversions') },
      { ...common, kind: 'clicks', count: count(metrics.clicks), sourceId: sourceId('clicks') },
      { ...common, kind: 'impressions', count: count(metrics.impressions), sourceId: sourceId('impressions') },
    );
  }
  return { attribution, summary: { ...base, factCount: attribution.length, sourceWatermark: watermark, rowCount: rows.length } };
}

function requestName(input: Record<string, unknown>): { name: string; requestKey: string } {
  const requestKey = text(input.requestKey, '요청 키', 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(requestKey)) throw new AppError('INVALID_INPUT', '요청 키는 영문·숫자·_·- 8–64자여야 합니다.');
  const base = text(input.name, '실험 이름', 200);
  if (/['"\\\n\r]/.test(base)) throw new AppError('INVALID_INPUT', '실험 이름에는 따옴표·역슬래시·줄바꿈을 쓸 수 없습니다.');
  // 응답 유실 뒤 같은 요청을 이름으로 찾아 재사용하기 위한 결정적 접미사. 이름은 고객 계정 안에서 고유하다.
  return { name: `${base} [gso:${requestKey}]`, requestKey };
}

function assertWritable(experiment: ExperimentRecord): void {
  if (TERMINAL.has(experiment.status)) throw new AppError('UNSUPPORTED_CHANGE', `이미 종료된 실험(${experiment.status})은 변경할 수 없습니다.`, 409);
}

async function loadCampaigns(ctx: ConnectorContext, ids: string[]): Promise<Map<string, Row>> {
  const rows = await search<Row>(ctx, `SELECT campaign.id, campaign.resource_name, campaign.status, campaign.advertising_channel_type, campaign.app_campaign_setting.app_id FROM campaign WHERE campaign.id IN (${ids.join(', ')})`);
  return new Map(rows.map(row => [String((row.campaign as Row | undefined)?.id ?? ''), (row.campaign ?? {}) as Row]));
}

async function schedule(ctx: ConnectorContext, info: Info, experiment: ExperimentRecord): Promise<{ operationName: string; done: boolean; failed: boolean }> {
  const operation = await ctx.request<Row>(`${HOST}/customers/${info.id}/experiments/${experiment.experimentId}:scheduleExperiment`, {
    method: 'POST', headers: await headers(ctx), json: {}, write: true,
  });
  const operationName = typeof operation.name === 'string' ? operation.name : '';
  if (!operationName) throw new AppError('INVALID_PROVIDER_RESPONSE', '실험 일정 작업 이름을 확인할 수 없습니다.');
  ctx.checkpoint({ stage: 'schedule', experimentId: experiment.experimentId, experimentResourceName: experiment.resourceName, operationName });
  return { operationName, done: operation.done === true, failed: operation.done === true && operation.error != null };
}

export async function createExperiment(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const { name, requestKey } = requestName(input);
  const control = campaignId(input.controlCampaignId, 'control 캠페인 ID');
  const treatment = campaignId(input.treatmentCampaignId, 'treatment 캠페인 ID');
  if (control === treatment) throw new AppError('INVALID_INPUT', 'control과 treatment 캠페인은 달라야 합니다. 같은 캠페인을 나누면 캠페인 단위 지표로 arm을 구분할 수 없습니다.');
  const controlSplit = input.controlTrafficSplit == null || input.controlTrafficSplit === '' ? 50 : Number(input.controlTrafficSplit);
  if (!Number.isInteger(controlSplit) || controlSplit < 1 || controlSplit > 99) throw new AppError('INVALID_INPUT', 'control 트래픽 비율은 1–99 정수(%)여야 합니다.');
  const startDate = input.startDate ? date(input.startDate, '시작일') : undefined;
  const endDate = input.endDate ? date(input.endDate, '종료일') : undefined;
  if (startDate && endDate && startDate >= endDate) throw new AppError('INVALID_INPUT', '종료일은 시작일보다 늦어야 합니다.');
  const description = input.description ? text(input.description, '설명', 2048) : undefined;
  const scheduleNow = input.schedule === true || input.schedule === 'true';
  const info = await customerInfo(ctx);
  const campaigns = await loadCampaigns(ctx, [control, treatment]);
  for (const id of [control, treatment]) {
    const campaign = campaigns.get(id);
    if (!campaign || campaign.status === 'REMOVED') throw new AppError('RESOURCE_NOT_FOUND', `캠페인 ${id}을(를) 이 광고 계정에서 찾을 수 없습니다.`, 404);
    if (campaign.advertisingChannelType === 'HOTEL') throw new AppError('UNSUPPORTED_OPERATION', 'Campaign Mix 실험은 호텔 캠페인을 지원하지 않습니다.');
    const appId = (campaign.appCampaignSetting as Row | undefined)?.appId;
    if (ctx.project?.appIdentifier && typeof appId === 'string' && appId && appId !== ctx.project.appIdentifier) {
      throw new AppError('RESOURCE_MISMATCH', `캠페인 ${id}의 앱(${appId})이 프로젝트 앱과 다릅니다.`);
    }
  }
  const campaignResource = (id: string) => String(campaigns.get(id)!.resourceName ?? `customers/${info.id}/campaigns/${id}`);
  const found = await search<Row>(ctx, `SELECT ${EXPERIMENT_FIELDS} FROM experiment WHERE experiment.name = '${name}'`);
  let experiment = found[0] ? experimentRecord(found[0]) : undefined;
  const reused = Boolean(experiment);
  if (experiment?.status === 'REMOVED') throw new AppError('RECONCILIATION_REQUIRED', '같은 요청 키의 실험이 삭제된 상태입니다. 새 요청 키로 다시 요청해 주세요.', 409);
  if (!experiment) {
    const create: Row = { name, type: 'COMPARE_CAMPAIGNS', status: 'SETUP', ...(description ? { description } : {}), ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) };
    const saved = await ctx.request<{ results?: Array<{ resourceName?: string }> }>(`${HOST}/customers/${info.id}/experiments:mutate`, {
      method: 'POST', headers: await headers(ctx), json: { operations: [{ create }] }, write: true,
    });
    const resourceName = saved.results?.[0]?.resourceName ?? '';
    const createdId = resourceName.match(/^customers\/\d+\/experiments\/(\d+)$/)?.[1];
    if (!createdId) throw new AppError('INVALID_PROVIDER_RESPONSE', '생성된 실험 리소스 이름을 확인할 수 없습니다.');
    ctx.checkpoint({ stage: 'experiment', requestKey, name, experimentId: createdId, experimentResourceName: resourceName });
    experiment = { resourceName, experimentId: createdId, name, type: 'COMPARE_CAMPAIGNS', status: 'SETUP', startDate, endDate };
  }
  if (experiment.type !== 'COMPARE_CAMPAIGNS') throw new AppError('RECONCILIATION_REQUIRED', '같은 이름의 실험이 Campaign Mix 유형이 아닙니다. Google Ads에서 확인해 주세요.', 409);
  let arms = reused ? (await loadArms(ctx, experiment.resourceName)).get(experiment.resourceName) ?? [] : [];
  if (arms.length) {
    const matches = arms.length === 2
      && arms.some(arm => arm.control && arm.campaigns.includes(campaignResource(control)))
      && arms.some(arm => !arm.control && arm.campaigns.includes(campaignResource(treatment)));
    if (!matches) throw new AppError('RECONCILIATION_REQUIRED', '같은 요청 키의 실험 arm 구성이 요청과 다릅니다. 중복 변경을 보내지 않습니다.', 409);
  } else {
    if (experiment.status !== 'SETUP') throw new AppError('RECONCILIATION_REQUIRED', 'arm이 없는 실험이 이미 SETUP 상태가 아닙니다. Google Ads에서 확인해 주세요.', 409);
    const arm = (armName: string, isControl: boolean, split: number, id: string) => ({ create: { experiment: experiment!.resourceName, name: armName, control: isControl, trafficSplit: String(split), campaigns: [campaignResource(id)] } });
    const saved = await ctx.request<{ results?: Array<{ resourceName?: string }> }>(`${HOST}/customers/${info.id}/experimentArms:mutate`, {
      method: 'POST', headers: await headers(ctx), write: true,
      json: { operations: [arm('control', true, controlSplit, control), arm('treatment', false, 100 - controlSplit, treatment)] },
    });
    const names = (saved.results ?? []).map(item => item.resourceName ?? '');
    if (names.length !== 2 || names.some(value => !/^customers\/\d+\/experimentArms\/\d+~\d+$/.test(value))) throw new AppError('INVALID_PROVIDER_RESPONSE', '생성된 실험 arm 리소스 이름을 확인할 수 없습니다.');
    ctx.checkpoint({ stage: 'arms', experimentId: experiment.experimentId, armResourceNames: names });
    arms = [
      { resourceName: names[0]!, name: 'control', control: true, trafficSplit: controlSplit, campaigns: [campaignResource(control)], inDesignCampaigns: [] },
      { resourceName: names[1]!, name: 'treatment', control: false, trafficSplit: 100 - controlSplit, campaigns: [campaignResource(treatment)], inDesignCampaigns: [] },
    ];
  }
  let scheduled: Awaited<ReturnType<typeof schedule>> | undefined;
  let alreadyScheduled = false;
  if (scheduleNow) {
    // 일정 요청이 이미 전달된 실험(LRO 존재 또는 SETUP 이후)은 다시 일정 요청하지 않는다.
    alreadyScheduled = experiment.status !== 'SETUP' || Boolean(experiment.longRunningOperation);
    if (!alreadyScheduled) scheduled = await schedule(ctx, info, experiment);
  }
  const waiting = scheduleNow && (scheduled ? !scheduled.done : experiment.status === 'INITIATED');
  return {
    resources: [experimentResource(experiment, arms, info.id)],
    waitingExternal: waiting,
    unresolved: scheduled?.failed === true,
    summary: {
      experimentId: experiment.experimentId, experimentResourceName: experiment.resourceName, name, requestKey, reused, status: experiment.status,
      type: 'COMPARE_CAMPAIGNS', arms: arms.map(arm => arm.resourceName), scheduleRequested: scheduleNow, alreadyScheduled,
      operationName: scheduled?.operationName ?? experiment.longRunningOperation,
      ...(scheduled?.failed ? { scheduleFailed: true, nextAction: 'ListExperimentAsyncErrors 또는 Google Ads 화면에서 일정 실패 사유를 확인해 주세요.' } : {}),
    },
  };
}

export async function endExperiment(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const id = experimentId(input.experimentId);
  const info = await customerInfo(ctx);
  const { experiment, arms } = await loadExperiment(ctx, id);
  if (TERMINAL.has(experiment.status)) {
    return { resources: [experimentResource(experiment, arms, info.id)], summary: { experimentId: id, status: experiment.status, alreadyEnded: true } };
  }
  if (experiment.status === 'SETUP') throw new AppError('UNSUPPORTED_CHANGE', '일정이 잡히지 않은(SETUP) 실험은 종료할 수 없습니다.', 409);
  await ctx.request(`${HOST}/customers/${info.id}/experiments/${id}:endExperiment`, { method: 'POST', headers: await headers(ctx), json: {}, write: true });
  ctx.checkpoint({ stage: 'end', experimentId: id, experimentResourceName: experiment.resourceName });
  const after = await loadExperiment(ctx, id);
  return { resources: [experimentResource(after.experiment, after.arms, info.id)], summary: { experimentId: id, ended: true, status: after.experiment.status, endDate: after.experiment.endDate } };
}

export async function promoteExperiment(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const id = experimentId(input.experimentId);
  const info = await customerInfo(ctx);
  const { experiment, arms } = await loadExperiment(ctx, id);
  const resource = experimentResource(experiment, arms, info.id);
  if (experiment.type === 'COMPARE_CAMPAIGNS') {
    throw new AppError('UNSUPPORTED_OPERATION', 'Campaign Mix 실험은 공식 문서상 End 또는 Graduate만 지원합니다. promote는 system-managed(in-design 캠페인) 실험에만 사용할 수 있습니다.');
  }
  if (experiment.status === 'PROMOTED' || experiment.promoteStatus === 'COMPLETED' || experiment.promoteStatus === 'COMPLETED_WITH_WARNING') {
    return { resources: [resource], summary: { experimentId: id, alreadyPromoted: true, status: experiment.status, promoteStatus: experiment.promoteStatus } };
  }
  if (experiment.promoteStatus === 'IN_PROGRESS') {
    return { resources: [resource], waitingExternal: true, summary: { experimentId: id, promoteStatus: 'IN_PROGRESS', operationName: experiment.longRunningOperation, alreadyRequested: true } };
  }
  assertWritable(experiment);
  if (experiment.status !== 'ENABLED') throw new AppError('UNSUPPORTED_CHANGE', `진행 중(ENABLED)인 실험만 promote할 수 있습니다. 현재 상태: ${experiment.status}`, 409);
  const operation = await ctx.request<Row>(`${HOST}/customers/${info.id}/experiments/${id}:promoteExperiment`, { method: 'POST', headers: await headers(ctx), json: {}, write: true });
  const operationName = typeof operation.name === 'string' ? operation.name : '';
  if (!operationName) throw new AppError('INVALID_PROVIDER_RESPONSE', 'promote 작업 이름을 확인할 수 없습니다.');
  ctx.checkpoint({ stage: 'promote', experimentId: id, experimentResourceName: experiment.resourceName, operationName });
  const failed = operation.done === true && operation.error != null;
  return { resources: [resource], waitingExternal: operation.done !== true, unresolved: failed, summary: { experimentId: id, operationName, promoteRequested: true, ...(failed ? { promoteFailed: true } : {}) } };
}

/** schedule/promote 장기 작업 결과를 실험 상태로 확인한다. 읽기 전용이다. */
export async function reconcileExperiment(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const id = experimentId(input.experimentId);
  const action = text(input.action, '확인할 작업', 16);
  if (action !== 'schedule' && action !== 'promote') throw new AppError('INVALID_INPUT', '확인할 작업은 schedule 또는 promote여야 합니다.');
  const info = await customerInfo(ctx);
  const { experiment, arms } = await loadExperiment(ctx, id);
  const resources = [experimentResource(experiment, arms, info.id)];
  const base = { experimentId: id, action, status: experiment.status, promoteStatus: experiment.promoteStatus, operationName: experiment.longRunningOperation };
  if (action === 'schedule') {
    if (experiment.status === 'ENABLED') return { resources, summary: { ...base, confirmed: true } };
    if (experiment.status === 'INITIATED') return { resources, waitingExternal: true, summary: { ...base, confirmed: false } };
    return { resources, summary: { ...base, confirmed: false, nextAction: 'ListExperimentAsyncErrors 또는 Google Ads 화면에서 일정 결과를 확인해 주세요.' } };
  }
  if (experiment.status === 'PROMOTED' || experiment.promoteStatus === 'COMPLETED' || experiment.promoteStatus === 'COMPLETED_WITH_WARNING') return { resources, summary: { ...base, confirmed: true } };
  if (experiment.promoteStatus === 'FAILED') return { resources, summary: { ...base, confirmed: false, failed: true } };
  if (experiment.promoteStatus === 'IN_PROGRESS' || experiment.promoteStatus === 'NOT_STARTED') return { resources, waitingExternal: true, summary: { ...base, confirmed: false } };
  return { resources, summary: { ...base, confirmed: false } };
}
