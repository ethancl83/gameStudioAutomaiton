// 공급자 액션(operation)의 사업 입력 스키마. 사용자에게 필요한 사업 입력만 노출한다.
// 자격 증명은 여기서 다루지 않는다(연결 시 1회 저장). inner input의 정확한 키는
// 어댑터 계약을 따르며, 서버가 다른 키를 요구하면 이 스키마를 갱신한다.

import type { OperationField, Provider } from '../../../packages/domain';
import { isWriteOperation } from '../../../packages/connectors/types';
import { majorToMicros, operationLabel } from './format';

export type OpFieldType = 'text' | 'money' | 'select' | 'textarea' | 'date';

export interface OpField {
  key: string;
  label: string;
  type: OpFieldType;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  // 다른 필드 값에 따라 조건부로 표시. 숨겨진 필드는 전송·필수검사에서 제외한다.
  showIf?: (values: Record<string, string>) => boolean;
}

export interface OpSpec {
  // 사용자에게 보여줄 설명.
  description: string;
  // 외부 상태를 바꾸는 쓰기 작업인가(=idempotencyKey 필요, 이중 실행 위험).
  externalWrite: boolean;
  // 기존 외부 리소스를 대상으로 하는가(externalId 선택 필요).
  targetKind?: 'campaign' | 'product' | 'ad-unit' | 'release';
  // 프로젝트 연결이 필요한가.
  needsProject?: 'required' | 'optional';
  // 정책 예산 한도로 검증할 money 필드 key.
  budgetField?: string;
  fields: OpField[];
}

const CAMPAIGN_STATUS = [
  { value: 'enabled', label: '활성' },
  { value: 'paused', label: '일시중지' },
];

export const OPERATION_SPECS: Record<string, OpSpec> = {
  check: { description: '연결 상태와 권한을 다시 확인합니다.', externalWrite: false, fields: [] },
  sync: { description: '외부 리소스와 최신 상태를 다시 가져옵니다.', externalWrite: false, fields: [] },
  'list-apps': { description: '연결된 계정의 앱 목록을 조회합니다.', externalWrite: false, fields: [] },
  'list-campaigns': { description: '캠페인 목록과 최신 상태를 가져옵니다.', externalWrite: false, fields: [] },
  'list-products': { description: '상품·구독 목록을 가져옵니다.', externalWrite: false, fields: [] },
  'list-ad-units': { description: '광고 단위 목록을 가져옵니다.', externalWrite: false, fields: [] },
  'list-releases': { description: '스토어 출시·트랙 상태를 가져옵니다.', externalWrite: false, fields: [] },

  'create-campaign': {
    description: '새 캠페인을 생성합니다. 예산은 프로젝트 정책 한도를 넘을 수 없습니다.',
    externalWrite: true,
    needsProject: 'required',
    budgetField: 'dailyBudgetMicros',
    fields: [
      { key: 'name', label: '캠페인 이름', type: 'text', required: true },
      { key: 'objective', label: '목표', type: 'text', hint: '예: app_installs, conversions' },
      { key: 'dailyBudgetMicros', label: '일일 예산', type: 'money', required: true },
      { key: 'country', label: '대상 국가', type: 'text', hint: 'ISO 국가코드(쉼표 구분). 예: KR,US' },
      { key: 'startDate', label: '시작일', type: 'date' },
    ],
  },
  'update-campaign': {
    description: '기존 캠페인의 예산·상태를 변경합니다.',
    externalWrite: true,
    targetKind: 'campaign',
    needsProject: 'required',
    budgetField: 'dailyBudgetMicros',
    fields: [
      { key: 'dailyBudgetMicros', label: '일일 예산', type: 'money', hint: '변경할 때만 입력' },
      { key: 'status', label: '상태', type: 'select', options: CAMPAIGN_STATUS },
    ],
  },
  'pause-campaign': {
    description: '캠페인을 일시중지합니다. 이미 집행된 비용은 되돌아가지 않습니다.',
    externalWrite: true,
    targetKind: 'campaign',
    needsProject: 'required',
    fields: [],
  },

  'create-product': {
    description: '인앱 상품/구독을 생성합니다. Google Play·App Store 공통 필드를 사용하며, 어댑터가 지원하지 않는 설정은 만들지 않습니다.',
    externalWrite: true,
    needsProject: 'required',
    fields: [
      { key: 'productId', label: '상품 ID', type: 'text', required: true, hint: '스토어에서 사용할 고유 식별자' },
      { key: 'name', label: '상품명', type: 'text', required: true },
      {
        key: 'type',
        label: '유형',
        type: 'select',
        required: true,
        options: [
          { value: 'consumable', label: '소비성' },
          { value: 'non_consumable', label: '비소비성' },
          { value: 'subscription', label: '구독' },
        ],
      },
      {
        key: 'billingPeriod',
        label: '구독 결제 주기',
        type: 'select',
        required: true,
        hint: '구독 상품은 결제 주기를 명시적으로 선택해야 합니다.',
        showIf: (v) => v.type === 'subscription',
        options: [
          { value: 'P1W', label: '주간 (P1W)' },
          { value: 'P1M', label: '월간 (P1M)' },
          { value: 'P3M', label: '분기 (P3M)' },
          { value: 'P6M', label: '반기 (P6M)' },
          { value: 'P1Y', label: '연간 (P1Y)' },
        ],
      },
      { key: 'priceMicros', label: '가격', type: 'money', required: true },
      { key: 'description', label: '설명', type: 'textarea', hint: '스토어 표시 설명(선택).' },
      { key: 'language', label: '언어', type: 'text', hint: '미입력 시 서버 기본값 en-US 로 등록됩니다.', placeholder: 'en-US' },
      { key: 'country', label: '기준 국가', type: 'text', hint: '미입력 시 서버 기본값 US 로 등록됩니다.', placeholder: 'US' },
    ],
  },
  'update-product': {
    description: '상품 가격·판매 상태를 변경합니다. 가격 변경 시 통화를 함께 전송합니다. 어댑터가 지원하지 않는 변경은 하지 않습니다.',
    externalWrite: true,
    targetKind: 'product',
    needsProject: 'required',
    fields: [
      { key: 'priceMicros', label: '가격', type: 'money', hint: '변경할 때만 입력. 통화와 함께 전송됩니다.' },
      {
        key: 'status',
        label: '판매 상태',
        type: 'select',
        options: [
          { value: 'active', label: '판매 중' },
          { value: 'inactive', label: '판매 중지' },
        ],
      },
      { key: 'description', label: '설명', type: 'textarea', hint: '변경할 때만 입력.' },
    ],
  },

  'create-ad-unit': {
    description: '광고 단위를 생성합니다.',
    externalWrite: true,
    needsProject: 'required',
    fields: [
      { key: 'name', label: '광고 단위 이름', type: 'text', required: true },
      {
        key: 'format',
        label: '형식',
        type: 'select',
        required: true,
        options: [
          { value: 'banner', label: '배너' },
          { value: 'interstitial', label: '전면' },
          { value: 'rewarded', label: '보상형' },
          { value: 'native', label: '네이티브' },
        ],
      },
      {
        key: 'platform',
        label: '플랫폼',
        type: 'select',
        options: [
          { value: 'android', label: 'Android' },
          { value: 'ios', label: 'iOS' },
        ],
      },
    ],
  },
  'update-ad-unit': {
    description: '광고 단위 설정을 변경합니다.',
    externalWrite: true,
    targetKind: 'ad-unit',
    needsProject: 'required',
    fields: [
      { key: 'name', label: '이름', type: 'text', hint: '변경할 때만 입력' },
      {
        key: 'status',
        label: '상태',
        type: 'select',
        options: [
          { value: 'active', label: '활성' },
          { value: 'inactive', label: '비활성' },
        ],
      },
    ],
  },

  'upload-build': {
    description: '빌드 결과물을 스토어 시험 트랙/브랜치에 업로드합니다. 실제 공개·심사는 별도입니다.',
    externalWrite: true,
    needsProject: 'required',
    fields: [
      { key: 'track', label: '트랙/브랜치', type: 'text', required: true, hint: '예: internal, beta, testing-branch' },
    ],
  },
};

export function specFor(op: string, provider?: Provider): OpSpec {
  if (op === 'sync-app' || (['list-products','list-releases'].includes(op) && ['google-play','app-store','steam'].includes(provider ?? ''))) return {description:'선택한 프로젝트의 스토어 정보를 가져옵니다.',externalWrite:false,needsProject:'required',fields:[]};
  if (['create-app','prepare-news','create-announcement'].includes(op)) return { description: '플랫폼에서 필요한 등록·게시 절차와 연결 상태를 확인합니다.', externalWrite: false, needsProject: 'required', fields: [] };
  if (op === 'create-creative') return { description: '선택한 캠페인에 광고 문구와 소재를 등록합니다.', externalWrite: true, needsProject: 'required', targetKind: 'campaign', fields: [] };
  if (['list-listings','list-beta-groups','list-review-submissions'].includes(op)) return { description: '선택한 프로젝트의 스토어 정보를 가져옵니다.', externalWrite: isWriteOperation(op, provider), needsProject: 'required', fields: [] };
  if (op === 'sdk-integration-config') return { description: '광고 SDK 연동에 필요한 공개 식별자와 설정을 조회합니다.', externalWrite: false, fields: [] };
  return (
    OPERATION_SPECS[op] ?? {
      description: `${operationLabel(op)} 작업을 실행합니다.`,
      externalWrite: isWriteOperation(op, provider),
      needsProject: isWriteOperation(op, provider) ? 'required' : 'optional',
      fields: [],
    }
  );
}

// 공급자·작업별 입력 필드 재정의. 컨트롤러가 capability.operationFields(도메인 OperationField[])로
// 보내면(예: Apple App Store / Google Ads 마케팅의 공급자 필수 필드) 공통 스키마 위에 덮어쓴다.
// 기존 필드는 required/라벨/옵션 등을 재정의하고, 새 키는 추가 필드로 노출하며,
// remove:true 인 항목은 공통 스키마에서 그 필드를 숨긴다(공급자가 지원하지 않는 입력 제거).
// 컨트롤러가 이 필드를 보내기 전에는 no-op이며 공통 스키마 그대로 사용한다.
export function mergeOperationFields(base: OpField[], overrides?: OperationField[]): OpField[] {
  if (!overrides || overrides.length === 0) return base;
  const result: OpField[] = base.map((f) => ({ ...f }));
  for (const ov of overrides) {
    if (!ov || typeof ov.key !== 'string' || ov.key === '') continue;
    if (ov.remove) {
      // 지원하지 않는 필드 숨김: 병합 결과에서 제거하고 추가하지 않는다.
      const idx = result.findIndex((f) => f.key === ov.key);
      if (idx >= 0) result.splice(idx, 1);
      continue;
    }
    const existing = result.find((f) => f.key === ov.key);
    if (existing) {
      if (ov.label !== undefined) existing.label = ov.label;
      if (ov.type !== undefined) existing.type = ov.type;
      if (ov.required !== undefined) existing.required = ov.required;
      if (ov.hint !== undefined) existing.hint = ov.hint;
      if (ov.placeholder !== undefined) existing.placeholder = ov.placeholder;
      if (ov.options !== undefined) existing.options = ov.options;
    } else {
      result.push({
        key: ov.key,
        label: ov.label ?? ov.key,
        type: ov.type ?? 'text',
        required: ov.required,
        hint: ov.hint,
        placeholder: ov.placeholder,
        options: ov.options,
      });
    }
  }
  return result;
}

// 액션 입력 payload를 스키마·값에서 구성한다(순수 함수, 테스트 대상).
// - money 필드는 major -> micros 정수 문자열로 변환하고, 통화를 함께 넣는다.
// - country 텍스트는 쉼표 구분 다국가 배열로 직렬화한다(공급자는 스칼라·배열 모두 허용).
// - externalId(대상 리소스)와 buildRunId는 폼 선택기에서 별도로 공급한다.
//   'externalId' 키를 가진 입력 필드는 대상 선택기와 중복되므로 필드 루프에서 제외한다
//   (root가 커넥터 operationFields에서 externalId 오버라이드를 제거함).
export function buildOperationInput(
  fields: OpField[],
  values: Record<string, string>,
  opts: { currency?: string; externalId?: string; buildRunId?: string } = {},
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const hasMoney = fields.some((f) => f.key !== 'externalId' && f.type === 'money');
  for (const f of fields) {
    if (f.key === 'externalId') continue; // 중복 externalId 입력 방지
    const raw = values[f.key];
    if (raw === undefined || raw.trim() === '') continue;
    if (f.type === 'money') {
      const micros = majorToMicros(raw);
      if (micros !== null) input[f.key] = micros;
    } else if (f.type === 'text' && f.key === 'country') {
      input[f.key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      input[f.key] = raw.trim();
    }
  }
  if (hasMoney && opts.currency) input.currency = opts.currency;
  if (opts.externalId) input.externalId = opts.externalId;
  if (opts.buildRunId) input.buildRunId = opts.buildRunId;
  return input;
}
