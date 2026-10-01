import { createContext, useContext, useEffect } from 'react';
import { Bot } from 'lucide-react';
import type { AgentRequestContext, AgentSelection } from '../../../../packages/agent/types';

type Scope = Pick<AgentRequestContext, 'projectId' | 'connectionId' | 'selection'>;
export const AgentActions = createContext<{ setScope: (scope: Scope) => void; request: (context: AgentRequestContext) => void }>({ setScope: () => {}, request: () => {} });

/**
 * 화면에 보이는 선택 항목의 표시용 스냅샷. 버전이 있는 기록은 version, 없으면 updatedAt을 revision으로 남겨
 * 서버가 요청 시점에 바뀐 선택을 오래된 선택으로 표시할 수 있게 한다. 권한이 아니라 요청 맥락이다.
 */
export function agentSelection(kind: AgentSelection['kind'], id: string, label: string, record?: { version?: number; updatedAt?: string }): AgentSelection {
  const revision = record?.version !== undefined ? String(record.version) : record?.updatedAt;
  return { kind, id, label: label.slice(0, 200), ...(revision ? { revision } : {}) };
}

/** Publish the same selection the visible screen uses; no request is sent on mount. */
export function useAgentScope(projectId?: string, connectionId?: string, selection?: AgentSelection) {
  const { setScope } = useContext(AgentActions);
  const kind = selection?.kind; const id = selection?.id; const label = selection?.label; const revision = selection?.revision;
  useEffect(() => {
    setScope({ projectId, connectionId, ...(kind && id ? { selection: { kind, id, label: label ?? id, ...(revision ? { revision } : {}) } } : {}) });
    return () => setScope({});
  }, [projectId, connectionId, kind, id, label, revision, setScope]);
}

/** 버튼은 숨은 명령을 실행하지 않고, 현재 화면·선택을 담은 같은 채팅 창을 연다. 전송은 사용자가 한다. */
export function AgentRequestButton({ context, label = 'AI 요청' }: { context: AgentRequestContext; label?: string }) {
  const { request } = useContext(AgentActions);
  const target = context.selection ? `${context.selection.label}에 대한 요청을 AI 대화에서 작성합니다` : undefined;
  return <button type="button" className="btn btn--sm" title={target} aria-label={target ? `${label}: ${context.selection!.label}` : undefined} onClick={() => request(context)}><Bot size={14} aria-hidden />{label}</button>;
}
