import { createContext, useContext, useEffect } from 'react';
import { Bot } from 'lucide-react';
import type { AgentRequestContext } from '../../../../packages/agent/types';

type Scope = Pick<AgentRequestContext, 'projectId' | 'connectionId'>;
export const AgentActions = createContext<{ setScope: (scope: Scope) => void; request: (context: AgentRequestContext) => void }>({ setScope: () => {}, request: () => {} });

/** Publish the same selection the visible screen uses; no request is sent on mount. */
export function useAgentScope(projectId?: string, connectionId?: string) {
  const { setScope } = useContext(AgentActions);
  useEffect(() => { setScope({ projectId, connectionId }); return () => setScope({}); }, [projectId, connectionId, setScope]);
}

export function AgentRequestButton({ context, label = 'AI 요청' }: { context: AgentRequestContext; label?: string }) {
  const { request } = useContext(AgentActions);
  return <button className="btn btn--sm" onClick={() => request(context)}><Bot size={14} />{label}</button>;
}
