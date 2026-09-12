import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { Bot, ExternalLink, FolderPlus, Pause, Send, Eraser, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { Card, Field, Notice, Spinner } from './ui';
import type { AppState } from '../../../../packages/domain';
import type { AgentImage, AgentSettings, AgentState, AgentTask } from '../../../../packages/agent/types';
import { SCREEN_REQUESTS } from '../../../../packages/agent/requests';
import { AgentActions } from './AgentActions';
import './agent.css';

const labels: Record<AgentTask['status'], string> = { idle: '요청 대기', queued: '준비 중', running: 'AI 작업 중', needs_user: '답변 대기', failed: '중단됨', cancelled: '중지됨', completed: '등록 완료' };

export function AgentPanel({ state, projectId, onRegister }: { state: AppState; projectId?: string | null; onRegister?: () => void }) {
  const controlId = useId();
  const { setScope } = useContext(AgentActions);
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [selectedId, setSelectedId] = useState(projectId ?? state.projects[0]?.id ?? '');
  const activeId = projectId === undefined ? selectedId : projectId ?? '';
  const mainPanel = projectId === undefined;
  useEffect(() => { if (mainPanel) { setScope({ projectId: activeId || undefined }); return () => setScope({}); } }, [activeId, mainPanel, setScope]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const reloadVersion = useRef(0);
  const reload = useCallback(async () => {
    const version = ++reloadVersion.current;
    const result = await api.agentState();
    if (version !== reloadVersion.current) return;
    if (result.ok) setAgent(result.data); else setError(result.error.message);
  }, []);
  useEffect(() => { void reload(); const timer = setInterval(() => void reload(), 1500); return () => clearInterval(timer); }, [reload]);
  const task = agent?.tasks.find(item => item.projectId === (activeId || null));
  const running = task?.status === 'running' || task?.status === 'queued';
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [task?.conversation.length, activeId]);
  useEffect(() => { setDraft(''); setError(''); }, [activeId]);
  async function action(kind: 'send' | 'clear' | 'cancel') {
    setPending(true); setError('');
    try {
      const result = kind === 'send' ? task ? await api.resumeAgent(task.id, draft.trim()) : await api.requestAgent({ screen: 'agent', projectId: activeId || undefined, message: draft.trim() })
        : task ? kind === 'clear' ? await api.clearAgent(task.id) : await api.cancelAgent(task.id) : null;
      if (result && !result.ok) setError(result.error.message);
      else { if (kind !== 'cancel') setDraft(''); await reload(); }
    } finally { setPending(false); }
  }
  async function providerChanged(provider: AgentSettings['provider']) {
    setPending(true); setError('');
    try { const result = await api.saveAgentSettings({ provider }); if (!result.ok) setError(result.error.message); else await reload(); }
    finally { setPending(false); }
  }
  const project = state.projects.find(item => item.id === activeId);
  return <Card title={`${project?.name ?? '전체 운영'} · AI 대화`} icon={Bot}>
    <div className="agent-chat">
      <p className="muted agent-chat__intro">채팅이나 각 화면의 AI 요청 버튼으로 시작하세요. 클리어 전까지 같은 대화를 이어갑니다.</p>
      <div className="agent-chat__controls">
        {projectId === undefined && <Field label="대화 대상" htmlFor={`${controlId}-project`}>
          <select id={`${controlId}-project`} className="select" value={activeId} onChange={event => setSelectedId(event.target.value)} disabled={pending}>
            <option value="">전체 운영</option>{state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </Field>}
        <Field label="사용할 AI" htmlFor={`${controlId}-provider`} hint={task?.provider ? '클리어하면 AI를 다시 선택할 수 있습니다.' : 'CLI의 기존 로그인·모델 설정을 사용합니다.'}>
          <select id={`${controlId}-provider`} className="select" disabled={!agent || pending || !!task?.provider} value={task?.provider ?? agent?.settings.provider ?? 'auto'} onChange={event => void providerChanged(event.target.value as AgentSettings['provider'])}>
            <option value="auto">설치된 CLI 자동 선택</option><option value="codex">Codex</option><option value="opencode">OpenCode</option>
          </select>
        </Field>
        <button className="btn btn--sm" disabled={pending || !task} onClick={() => void action('clear')} title="진행 중인 AI를 중지하고 대화를 비웁니다. 결과물과 작업 이력은 보존됩니다."><Eraser size={14} />클리어</button>
        {onRegister && <button className="btn btn--sm" onClick={onRegister}><FolderPlus size={14} />프로젝트 등록</button>}
      </div>
      {api.isDemo() ? <Notice tone="info">데모에서는 실제 AI를 실행하지 않습니다.</Notice> : agent && !agent.runtimes.some(runtime => runtime.executable) && <Notice tone="warn">Codex 또는 OpenCode CLI 설치·로그인이 필요합니다.</Notice>}
      <div className="agent-chat__messages" role="log" aria-label="AI 대화" aria-live="polite">
        {!task?.conversation.length && <div className="agent-chat__empty"><Bot size={28} /><p>어떤 작업을 도와드릴까요?</p><span>화면의 AI 요청 버튼을 누르면 내용을 입력하지 않아도 됩니다.</span></div>}
        {task?.conversation.map((entry, index) => <div key={`${task.sessionGeneration}-${index}`} className={`agent-message agent-message--${entry.role}`}>
          <strong>{entry.role === 'user' ? '나' : task.provider === 'opencode' ? 'OpenCode' : 'AI'}{entry.context && ` · ${SCREEN_REQUESTS[entry.context.screen].label}`}{entry.context?.connectionId && ` · ${state.connections.find(conn => conn.id === entry.context?.connectionId)?.label ?? '선택한 계정'}`}</strong><div>{entry.text}</div>
        </div>)}
        <div ref={bottom} />
      </div>
      {task && <div className="agent-chat__status" role="status">{running && <Spinner />}<span>{labels[task.status]} · {task.message}</span>{running && <button className="btn btn--sm" disabled={pending} onClick={() => void action('cancel')}><Pause size={13} />중지</button>}</div>}
      {task?.question?.url && <button className="btn" onClick={async () => { const result = await api.openExternal(task.question!.url!); if (!result.ok) setError(result.error ?? '서비스를 열지 못했습니다.'); }}><ExternalLink size={14} />서비스에서 계속</button>}
      <form className="agent-chat__composer" onSubmit={event => { event.preventDefault(); if (draft.trim() && !running && !pending) void action('send'); }}>
        <label className="sr-only" htmlFor={`${controlId}-message`}>AI에게 요청</label>
        <textarea id={`${controlId}-message`} className="textarea" value={draft} maxLength={8000} rows={3} onChange={event => setDraft(event.target.value)} placeholder="요청이나 답변을 입력하세요. Enter로 전송, Shift+Enter로 줄바꿈" onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim() && !running && !pending) void action('send'); } }} />
        <button className="btn btn--primary" type="submit" disabled={!agent || !draft.trim() || running || pending}>{pending ? <Spinner /> : <Send size={15} />}전송</button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
      {task && (task.listing || task.images.length > 0) && <details>
        <summary>준비한 결과물 · 이미지 {task.images.length}개 · 스토어 작업 {task.runIds.length}건</summary>
        {task.listing && <><h3>{task.listing.title}</h3><p>{task.listing.shortDescription}</p><p style={{ whiteSpace: 'pre-wrap' }}>{task.listing.fullDescription}</p></>}
        <div className="agent-chat__images">{task.images.map(image => <AgentImagePreview key={image.mediaAssetId} taskId={task.id} image={image} />)}</div>
      </details>}
    </div>
  </Card>;
}
function AgentImagePreview({ taskId, image }: { taskId: string; image: AgentImage }) {
  const [url, setUrl] = useState(''); const [failed, setFailed] = useState(false);
  const load = useCallback(async () => { const result = await api.agentImage(taskId, image.mediaAssetId); if (result.ok) { setUrl(result.data.dataUrl); setFailed(false); } else setFailed(true); }, [taskId, image.mediaAssetId]);
  useEffect(() => { void load(); }, [load]);
  return <figure style={{ margin: 0, maxWidth: 260 }}>
    {url ? <img src={url} alt={image.name} style={{ maxWidth: '100%', maxHeight: 180, objectFit: 'contain', borderRadius: 12 }} /> : failed ? <button className="btn btn--sm" onClick={() => void load()}><RefreshCw size={13} /> 이미지 다시 불러오기</button> : <Spinner />}
    <figcaption className="small muted">{image.name} · {image.width}×{image.height}<br />{image.source === 'generated' ? 'AI가 생성한 홍보 이미지' : image.purpose === 'screenshot' ? '프로젝트의 실제 스크린샷' : '프로젝트 이미지'}</figcaption>
  </figure>;
}
