// 성장 운영 화면 공용 라벨·상태·동작 실행기. 값은 GrowthState 원천을 그대로 표시하고 화면이 만들어내지 않는다.
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { AppState } from '../../../../../packages/domain';
import type { AgentSelection } from '../../../../../packages/agent/types';
import type {
  ExperimentStatus, GrowthState, MandateAction, MandateStatus, MetricKey, ResponseStatus, RevenueBasis,
} from '../../../../../packages/growth/types';
import { api } from '../../api';
import { AgentRequestButton, agentSelection } from '../../components/AgentActions';
import { Badge, Notice } from '../../components/ui';

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral' | 'progress';

export interface SectionProps {
  state: AppState;
  growth: GrowthState;
  projectId: string;
  reload: () => Promise<void>;
}

export const ACTION_LABELS: Record<MandateAction, string> = {
  observe: '지표 수집·품질 진단·결정 기록',
  'ads-experiment': '광고 native 실험 생성·일정·종료',
  'ads-scale': '승자 확대(예산 단계 증액·MAX promote)',
  'ads-rebalance': '캠페인 예산 재배분(총액 유지)',
  'ads-stop': '실패 광고 중지(pause)',
  'max-experiment': 'AppLovin MAX 광고 단위 실험',
  'pricing-proposal': '가격·상품 변경 제안',
  'pricing-change': '위임 범위 안 가격 변경·원복',
  'community-draft': '고객 문의 분류·초안·사람 에스컬레이션',
  'community-reply': '승인 근거가 있는 일반 문의 자동 답글',
  'community-recall': '본인 답글 회수',
  'feedback-triage': '피드백 정규화·이슈 후보',
};

export const MANDATE_STATUS: Record<MandateStatus, [string, Tone]> = {
  proposed: ['확정 대기', 'warn'], active: ['실행 중', 'ok'], stopped: ['중지됨', 'neutral'], expired: ['기간 만료', 'neutral'],
};

export const EXPERIMENT_STATUS: Record<ExperimentStatus, [string, Tone]> = {
  draft: ['초안', 'neutral'], validating: ['검증 중', 'progress'], scheduled: ['등록·시작 대기', 'info'], exploring: ['탐색', 'progress'],
  observing: ['관찰', 'progress'], evaluating: ['평가', 'progress'], winner_scaling: ['승자 확대', 'ok'], completed: ['완료', 'ok'],
  inconclusive: ['결론 없음', 'neutral'], stopped: ['중지됨', 'neutral'], action_required: ['조치 필요', 'error'], failed: ['실패', 'error'],
};
export const RUNNING_EXPERIMENTS: ExperimentStatus[] = ['validating', 'scheduled', 'exploring', 'observing', 'evaluating', 'winner_scaling', 'action_required'];

export const RESPONSE_STATUS: Record<ResponseStatus, [string, Tone]> = {
  ingested: ['수집됨', 'neutral'], classified: ['분류됨', 'neutral'], draft_ready: ['초안 준비', 'info'], blocked: ['차단', 'warn'],
  escalated: ['사람 확인 필요', 'error'], authorized: ['승인됨', 'progress'], queued: ['발송 대기열', 'progress'], prepared: ['발송 준비', 'progress'],
  dispatched: ['발송 확인 중', 'progress'], confirmed: ['발송 확인', 'ok'], unresolved: ['결과 불명', 'warn'], closed: ['종료', 'neutral'], retracted: ['회수됨', 'neutral'],
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  roas: 'ROAS', net_roi: '순이익 ROI', conversion_rate: '전환율', cost_per_install: '설치당 비용',
  arpdau: 'ARPDAU', retention_d1: 'D1 리텐션', crash_free_rate: '크래시 없는 비율', refund_rate: '환불률',
};
export const METRICS = Object.keys(METRIC_LABELS) as MetricKey[];

export const BASIS_LABELS: Record<RevenueBasis, string> = {
  gross_conversion_value: '총 전환 가치(공급자 보고)', net_proceeds: '순수익(수수료·환불 반영)', estimated_ad_revenue: '추정 광고 수익',
};

export function StatusBadge<K extends string>({ map, value }: { map: Record<K, [string, Tone]>; value: K }) {
  const [label, tone] = map[value] ?? [value, 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}

/** 비율(0.12)을 퍼센트 문자열로 표시. null은 '—'. */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}
export function num(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number(value.toFixed(digits)).toString();
}
/** 퍼센트 입력을 비율로 변환. 부동소수 표시 오차를 줄이기 위해 소수 8자리로 자른다. */
export function percentInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Number((n / 100).toFixed(8)) : Number.NaN;
}
export function ratioToPercentText(value: number | undefined): string {
  return value === undefined ? '' : String(Number((value * 100).toFixed(6)));
}
export function intInput(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  return Number(value);
}
/** datetime-local 값을 ISO로. 빈 값은 undefined. */
export function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

export function connectionLabel(state: AppState, id: string): string {
  return state.connections.find(item => item.id === id)?.label ?? id.slice(0, 8);
}

/** 성장 운영 동작 실행기. 섹션마다 대기·오류·결과 메시지를 따로 보여 준다. */
export function useGrowthAction(reload: () => Promise<void>) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const running = useRef(false);
  const run = useCallback(async <T,>(action: string, input: Record<string, unknown>, done?: string): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true; setPending(action); setError(''); setMessage('');
    try {
      const result = await api.growth<T>(action, input);
      if (!result.ok) { setError(result.error.message); return undefined; }
      if (done) setMessage(done);
      await reload();
      return result.data;
    } finally { running.current = false; setPending(''); }
  }, [reload]);
  return { pending, error, message, run, clear: () => { setError(''); setMessage(''); } };
}
export type GrowthAction = ReturnType<typeof useGrowthAction>;

export function ActionFeedback({ act }: { act: GrowthAction }) {
  if (act.error) return <Notice tone="error">{act.error}</Notice>;
  if (act.message) return <Notice tone="info">{act.message}</Notice>;
  return null;
}

/** 기록별 AI 요청. 같은 채팅 창에 화면·선택 스냅샷을 담아 열 뿐, 요청은 사용자가 확인 후 전송한다. */
export function AskAi({ projectId, kind, id, label, record }: { projectId: string; kind: AgentSelection['kind']; id: string; label: string; record?: { version?: number; updatedAt?: string } }) {
  return <AgentRequestButton context={{ screen: 'growth', projectId, selection: agentSelection(kind, id, label, record) }} />;
}

export function Dl({ items }: { items: Array<[ReactNode, ReactNode] | false | '' | 0 | null | undefined> }) {
  return <dl className="dl">{items.filter(Boolean).map((item, index) => { const [k, v] = item as [ReactNode, ReactNode]; return <div key={index} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>; })}</dl>;
}

export function ReasonList({ reasons, tone = 'muted' }: { reasons: string[]; tone?: 'muted' | 'warn' }) {
  if (!reasons.length) return null;
  return <ul className={`small ${tone === 'muted' ? 'muted' : ''}`} style={{ margin: '4px 0 0', paddingLeft: 18 }}>{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>;
}

/** 사유 입력이 필요한 확인 동작(중지·보류·회수 등). 인라인 입력으로 키보드 접근을 보장하고, 실패(undefined)하면 입력을 유지한다. */
export function ReasonAction({ label, placeholder, required, danger, disabled, onSubmit }: { label: string; placeholder: string; required?: boolean; danger?: boolean; disabled?: boolean; onSubmit: (reason: string) => unknown }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <button type="button" className={`btn btn--sm${danger ? ' btn--danger' : ''}`} disabled={disabled} onClick={() => setOpen(true)}>{label}</button>;
  return <form className="row" style={{ gap: 6 }} onSubmit={event => { event.preventDefault(); if (required && !reason.trim()) return; void Promise.resolve(onSubmit(reason.trim())).then(result => { if (result !== undefined) { setOpen(false); setReason(''); } }); }}>
    <input className="input" style={{ minWidth: 220 }} autoFocus aria-label={`${label} 사유`} placeholder={placeholder} value={reason} maxLength={500} onChange={event => setReason(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }} />
    <button type="submit" className={`btn btn--sm${danger ? ' btn--danger' : ' btn--primary'}`} disabled={disabled || (required && !reason.trim())}>{label} 확인</button>
    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpen(false)}>취소</button>
  </form>;
}
