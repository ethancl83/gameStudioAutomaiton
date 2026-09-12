// 상태 배지 모음. 도메인 상태 → 한국어 라벨·톤.
import {
  CONNECTION_STATUS_META,
  RUN_STATUS_META,
  SEVERITY_META,
} from '../format';
import { Badge } from './ui';
import type { ConnectionStatus, RunStatus, Severity } from '../../../../packages/domain';

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const m = RUN_STATUS_META[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const m = CONNECTION_STATUS_META[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const m = SEVERITY_META[severity];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
