// 표시용 포맷과 한국어 라벨. 값 자체는 원천 데이터를 보존하고 표시만 지역화한다.

import type {
  ConnectionStatus,
  Provider,
  RunStatus,
  Severity,
} from '../../../packages/domain';

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (Math.abs(sec) < 60) return '방금';
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return `${min}분 전`;
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return `${hr}시간 전`;
  const day = Math.round(hr / 24);
  if (Math.abs(day) < 30) return `${day}일 전`;
  return formatDateTime(iso);
}

// 최소 단위(micros = 1/1,000,000) 정수 문자열을 통화와 함께 표시한다.
// 다른 통화는 환산 없이 각각 표시한다(계약: 통화 혼합 합산 금지).
export function formatMicros(micros: string | null | undefined, currency: string): string {
  if (micros === null || micros === undefined || micros === '') return '—';
  let value: bigint;
  try {
    value = BigInt(micros);
  } catch {
    return `${micros} ${currency}`;
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  // 소수 둘째 자리까지 반올림하지 않고 절삭 표시(원천 정밀도 보존, 표시만).
  const cents = frac / 10_000n; // 0..99
  const num = Number(whole) + Number(cents) / 100;
  try {
    const formatted = new Intl.NumberFormat('ko-KR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(negative ? -num : num);
    return formatted;
  } catch {
    // 알 수 없는 통화 코드
    return `${negative ? '-' : ''}${num.toLocaleString('ko-KR')} ${currency}`;
  }
}

// micros(정수 문자열) <-> 주 단위(사람이 입력하는 금액) 변환. 예산 입력 폼에서 사용.
export function microsToMajor(micros: string | null | undefined): string {
  if (!micros) return '';
  try {
    const v = BigInt(micros);
    const whole = v / 1_000_000n;
    const frac = v % 1_000_000n;
    if (frac === 0n) return whole.toString();
    // 소수부를 6자리로 채운 뒤 뒤 0 제거
    const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  } catch {
    return '';
  }
}

export function majorToMicros(major: string): string | null {
  const trimmed = major.trim();
  if (trimmed === '') return '0';
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = frac.padEnd(6, '0');
  try {
    const micros = BigInt(whole) * 1_000_000n + BigInt(fracPadded || '0');
    return micros.toString();
  } catch {
    return null;
  }
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  'google-play': 'Google Play',
  'app-store': 'App Store',
  steam: 'Steam',
  'google-ads': 'Google Ads',
  'applovin-ads': 'AppLovin 광고',
  'applovin-max': 'AppLovin MAX',
  admob: 'AdMob',
  x: 'X',
  threads: 'Threads',
};

export function providerLabel(p: Provider): string {
  return PROVIDER_LABELS[p] ?? p;
}

interface StatusMeta {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'info' | 'neutral' | 'progress';
}

export const CONNECTION_STATUS_META: Record<ConnectionStatus, StatusMeta> = {
  connected: { label: '연결됨', tone: 'ok' },
  recovering: { label: '자동 복구 중', tone: 'progress' },
  permission_required: { label: '권한 부족', tone: 'warn' },
  action_required: { label: '사용자 조치 필요', tone: 'error' },
  disconnected: { label: '연결 해제됨', tone: 'neutral' },
  unverified: { label: '미검증', tone: 'info' },
};

export const RUN_STATUS_META: Record<RunStatus, StatusMeta> = {
  queued: { label: '대기 중', tone: 'neutral' },
  running: { label: '실행 중', tone: 'progress' },
  succeeded: { label: '성공', tone: 'ok' },
  retry_wait: { label: '재시도 대기', tone: 'warn' },
  waiting_external: { label: '외부 처리 대기', tone: 'info' },
  action_required: { label: '사용자 조치 필요', tone: 'error' },
  failed: { label: '실패', tone: 'error' },
  cancelled: { label: '취소됨', tone: 'neutral' },
};

export const SEVERITY_META: Record<Severity, StatusMeta> = {
  error: { label: '오류', tone: 'error' },
  warning: { label: '경고', tone: 'warn' },
  info: { label: '정보', tone: 'info' },
};

// 이 작업 종류를 취소할 수 있는가.
export function isRunActive(status: RunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'retry_wait' || status === 'waiting_external';
}

// 계약: 안전하게 재조회/재시도 가능한 작업만 재시도한다. 외부 쓰기 action_required는
// 일반 retry 대신 run 상태 재조회(reconcile)로 확인해야 하므로 여기서 제외한다.
export function isRunRetryable(status: RunStatus): boolean {
  return status === 'failed' || status === 'cancelled';
}

// 결과가 모호한 외부 쓰기(외부 처리 대기/사용자 조치 필요)는 재전송 대신
// 읽기 전용 재조정으로 실제 반영 상태를 확인한다.
export function isRunReconcilable(status: RunStatus): boolean {
  return status === 'waiting_external' || status === 'action_required';
}

export const ENGINE_LABELS: Record<string, string> = {
  godot: 'Godot',
  unity: 'Unity',
  unreal: 'Unreal',
  android: '네이티브 Android',
  ios: '네이티브 iOS',
  unknown: '미확인',
};

export const TARGET_LABELS: Record<string, string> = {
  android: 'Android',
  ios: 'iOS',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

export const RESOURCE_KIND_LABELS: Record<string, string> = {
  campaign: '캠페인',
  product: '상품',
  'ad-unit': '광고 단위',
  release: '출시',
  creative: '소재',
  post: '게시물',
  reply: '답글',
  mention: '멘션',
  news: '뉴스',
};

export const CAPABILITY_CATEGORY_LABELS: Record<string, string> = {
  store: '스토어',
  marketing: '마케팅',
  monetization: '수익화',
  community: '커뮤니티',
};

// 액션 operation의 한국어 라벨.
export const OPERATION_LABELS: Record<string, string> = {
  check: '연결 검사',
  sync: '동기화',
  'list-apps': '앱 목록 조회',
  'list-campaigns': '캠페인 조회',
  'create-campaign': '캠페인 생성',
  'update-campaign': '캠페인 수정',
  'pause-campaign': '캠페인 중지',
  'list-products': '상품 조회',
  'sync-app': '앱 동기화',
  'create-product': '상품 생성',
  'update-product': '상품 수정',
  'list-ad-units': '광고 단위 조회',
  'create-ad-unit': '광고 단위 생성',
  'update-ad-unit': '광고 단위 수정',
  'upload-build': '빌드 업로드',
  'list-releases': '출시 조회',
  'create-post': '게시물 작성',
  reply: '답글 작성',
  'list-posts': '게시물 조회',
  'list-mentions': '멘션 조회',
  'list-replies': '답글 조회',
  'list-news': '뉴스 조회',
  // 스토어 자료·심사, 미디에이션, 플랫폼 준비 등 공급자가 광고할 수 있는 작업의 읽기 쉬운 라벨.
  // capability.operations 에 있는 작업은 이 목록에 없어도 슬러그 그대로 노출되며 모두 접근 가능하다.
  'update-listing': '스토어 자료 수정',
  'update-store-listing': '스토어 자료 수정',
  'submit-for-review': '심사 제출',
  'list-reviews': '리뷰 조회',
  'reply-review': '리뷰 답글',
  'promote-release': '출시 승격(공개)',
  'list-mediation': '미디에이션 조회',
  'update-mediation': '미디에이션 설정',
  'set-price': '가격 설정',
  'list-orders': '주문·판매 조회',
  'list-creatives': '소재 조회',
  'create-creative': '소재 생성',
  'update-creative': '소재 수정',
  'activate-creative': '소재 활성화',
  'list-ad-groups': '광고 그룹 조회',
  'create-app': '최초 앱 등록 안내',
  'create-version': '스토어 버전 생성',
  'list-listings': '스토어 자료 조회',
  'upload-listing-image': '스토어 이미지 등록',
  'update-app-info': '앱 정보 수정',
  'list-beta-groups': 'TestFlight 그룹 조회',
  'create-beta-group': 'TestFlight 그룹 생성',
  'distribute-build': '테스터에게 빌드 배포',
  'link-build': '스토어 버전에 빌드 연결',
  'submit-review': '심사 제출',
  'list-review-submissions': '심사 현황 조회',
  'release-version': '승인 버전 출시',
  'set-live': 'Steam 브랜치 전환',
  'create-announcement': 'Steam 공지 게시 안내',
  'prepare-news': 'Steam 공지 준비',
  'delete-post': '게시물 삭제',
  'hide-reply': '답글 숨김 관리',
  'sdk-integration-config': '광고 SDK 연결 설정',
  reconcile: '외부 처리 상태 확인',
};

// 알려진 라벨이 없으면 슬러그를 사람이 읽기 쉬운 형태로 바꾼다(예: 'submit-for-review' → 'Submit For Review').
// 원본 슬러그를 그대로 노출하지 않으면서도, 공급자가 새로 광고한 미지의 작업을 접근 가능하게 한다.
export function humanizeOperation(op: string): string {
  const cleaned = op.replace(/[-_.]+/g, ' ').trim();
  if (cleaned === '') return op;
  return cleaned.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export function operationLabel(op: string): string {
  return OPERATION_LABELS[op] ?? humanizeOperation(op);
}
