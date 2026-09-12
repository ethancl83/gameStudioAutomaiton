// 출시 파이프라인 상태 → 한국어 라벨·톤. 대시보드·배포 화면에서 공용으로 쓴다.
import type { ReleasePipeline } from '../../../../packages/domain';

type Tone = 'ok' | 'warn' | 'error' | 'info' | 'neutral' | 'progress';

export const PIPELINE_STATUS_META: Record<ReleasePipeline['status'], { label: string; tone: Tone }> = {
  building: { label: '빌드 중', tone: 'progress' },
  uploading: { label: '업로드 중', tone: 'progress' },
  succeeded: { label: '완료', tone: 'ok' },
  failed: { label: '실패', tone: 'error' },
  action_required: { label: '사용자 조치 필요', tone: 'error' },
  cancelled: { label: '취소됨', tone: 'neutral' },
};
