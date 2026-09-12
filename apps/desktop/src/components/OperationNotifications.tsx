import { useEffect, useRef, useState } from 'react';
import type { AppState, TimelineEvent } from '../../../../packages/domain';

const notable = new Set(['succeeded','failed','action_required','backup.created','backup.restored','runner.checked','operations.error']);
export function OperationNotifications({state}: {state: AppState | null}) {
  const seen = useRef<number | null>(null);
  const [messages, setMessages] = useState<(TimelineEvent & {expiresAt: number | null})[]>([]);
  useEffect(() => {
    if (!state) return;
    const latest = Math.max(0, ...state.events.map(event => event.id));
    const previous = seen.current; seen.current = latest;
    if (state.runtime.notificationsEnabled === false) {setMessages([]); return;}
    if (previous === null) return;
    const added = state.events.filter(event => event.id > previous && notable.has(event.kind)
      && !(event.kind === 'succeeded' && ['sync','check'].includes(state.runs.find(run => run.id === event.runId)?.kind ?? '')));
    if (added.length) setMessages(current => [...added.map(event => ({...event, expiresAt: event.level === 'info' ? Date.now() + 8000 : null})), ...current].slice(0, 3));
  }, [state]);
  useEffect(() => {
    const deadlines = messages.map(message => message.expiresAt).filter((deadline): deadline is number => deadline !== null);
    if (!deadlines.length) return;
    const timer = setTimeout(() => setMessages(current => current.filter(message => message.expiresAt === null || message.expiresAt > Date.now())), Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timer);
  }, [messages]);
  if (!messages.length) return null;
  return <aside aria-label="운영 알림" aria-live="polite" style={{position:'fixed',right:20,bottom:20,width:'min(380px, calc(100vw - 40px))',zIndex:40,display:'grid',gap:8}}>
    {messages.map(message => <div key={message.id} className="card" style={{padding:12}}>
      <div className="row row--between" style={{gap:12,alignItems:'flex-start'}}>
        <span className="small">{message.message}</span>
        <button className="btn btn--sm" aria-label="알림 닫기" onClick={() => setMessages(current => current.filter(item => item.id !== message.id))}>닫기</button>
      </div>
    </div>)}
  </aside>;
}
