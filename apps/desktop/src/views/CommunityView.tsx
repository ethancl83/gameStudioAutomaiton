// 커뮤니티(SNS): X · Threads · Steam 채널의 게시물·멘션·답글·뉴스 조회와 작성, 예약 게시,
// 프로젝트별 소셜 자동화 정책. 지원되는 작업만 노출한다(Steam 뉴스는 읽기 전용).
import { useMemo, useState } from 'react';
import {
  CalendarClock,
  ExternalLink,
  MessageSquare,
  Megaphone,
  Newspaper,
  PlugZap,
  Plus,
  RefreshCcw,
  Reply as ReplyIcon,
  Send,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { api } from '../api';
import { RESOURCE_KIND_LABELS, formatDateTime, formatRelative, operationLabel, providerLabel } from '../format';
import { newIdempotencyKey, useAction } from '../useAction';
import { Badge, Card, EmptyState, Field, Modal, Notice, Spinner } from '../components/ui';
import { ActionForm } from '../components/ActionForm';
import { ConnectionStatusBadge } from '../components/status';
import type { ViewKey } from '../App';
import type { AppState, Connection, ExternalResource, Project, Run, SocialSchedule } from '../../../../packages/domain';

// 커뮤니티 화면에 관련된 작업들. 채널(연결)은 capability가 이 중 하나라도 지원하면 노출한다.
const READ_OPS = ['list-posts', 'list-mentions', 'list-replies', 'list-news'];
const WRITE_OPS = ['create-post', 'reply'];
const COMMUNITY_OPS = [...READ_OPS, ...WRITE_OPS];

function textOf(r: ExternalResource): string {
  return typeof r.data.text === 'string' ? r.data.text : r.name;
}
function permalinkOf(r: ExternalResource): string | null {
  return typeof r.data.permalink === 'string' ? r.data.permalink : null;
}
function metricsOf(r: ExternalResource): [string, string][] {
  const m = r.data.metrics;
  if (!m || typeof m !== 'object') return [];
  const labels: Record<string, string> = { retweet_count: '재게시', reply_count: '답글', like_count: '좋아요', quote_count: '인용', impression_count: '노출', bookmark_count: '북마크', views: '조회', likes: '좋아요', replies: '답글', reposts: '재게시', quotes: '인용' };
  return Object.entries(m as Record<string, unknown>).map(([k, v]) => [labels[k] ?? k, String(v)]);
}

export function CommunityView({
  state,
  refresh,
  goTo,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
}) {
  const [projectId, setProjectId] = useState<string>(state.projects[0]?.id ?? '');
  const project = projectId ? state.projects.find((p) => p.id === projectId) ?? null : null;

  // 채널: capability가 커뮤니티 작업을 지원하는 연결(X/Threads + list-news 지원 Steam).
  const channels = useMemo(
    () =>
      state.connections.filter((c) => {
        const cap = state.capabilities.find((cp) => cp.provider === c.provider);
        return !!cap && cap.operations.some((op) => COMMUNITY_OPS.includes(op));
      }),
    [state.connections, state.capabilities],
  );

  if (channels.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Users}
          title="연결된 커뮤니티 채널이 없습니다"
          description="X · Threads 계정을 연결하거나, 뉴스가 있는 Steam 계정을 연결하면 게시물·멘션·답글·뉴스를 이곳에서 관리할 수 있습니다."
          action={
            <button className="btn btn--primary" onClick={() => goTo('connections')}>
              <PlugZap size={15} /> 계정 연결로 이동
            </button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="stack">
      <div className="row row--between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <p className="muted small" style={{ margin: 0, maxWidth: 620 }}>
          {api.isDemo() ? '데모 게시물·답글은 데모 공간에 저장됩니다. ' : '게시물·답글은 연결된 계정에 반영됩니다. '}
          예약 게시·출시 공지·자동 답글은 저장한 프로젝트 정책의 범위 안에서 실행합니다.
        </p>
        <Field label="프로젝트" htmlFor="community-project">
          <select id="community-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">프로젝트 선택 안 함</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
      </div>

      {channels.map((conn) => (
        <ChannelCard key={conn.id} conn={conn} state={state} refresh={refresh} projectId={projectId} />
      ))}

      <ScheduleSection state={state} refresh={refresh} project={project} channels={channels} />

      {project ? (
        <SocialPolicySection project={project} channels={channels} refresh={refresh} />
      ) : (
        <Notice tone="info">프로젝트를 선택하면 자동 공지·자동 답글 정책과 예약 게시를 설정할 수 있습니다.</Notice>
      )}
    </div>
  );
}

function ChannelCard({
  conn,
  state,
  refresh,
  projectId,
}: {
  conn: Connection;
  state: AppState;
  refresh: () => Promise<void>;
  projectId: string;
}) {
  const cap = state.capabilities.find((c) => c.provider === conn.provider);
  const ops = cap?.operations ?? [];
  const readOps = READ_OPS.filter((op) => ops.includes(op));
  const canPost = ops.includes('create-post');
  const canReply = ops.includes('reply');
  // 화면이 전용 UI로 다루지 않는, 그러나 공급자가 광고한 커뮤니티 작업. 모두 접근 가능하게 한다.
  const extraOps = ops.filter((op) => !COMMUNITY_OPS.includes(op));
  const extraReadOps = extraOps.filter((op) => op.startsWith('list-') || op === 'sync' || op === 'check');
  const extraWriteOps = extraOps.filter((op) => !extraReadOps.includes(op));
  const listAct = useAction<Run>(refresh);
  const [runningOp, setRunningOp] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const [replyTo, setReplyTo] = useState<ExternalResource | null>(null);
  const [extraForm, setExtraForm] = useState<string | null>(null);

  const resources = state.resources.filter(
    (r) => r.connectionId === conn.id && (!projectId || r.projectId === projectId) && r.status !== 'deleted' && ['post', 'reply', 'mention', 'news'].includes(r.kind),
  );
  const writable = conn.status === 'connected' || conn.status === 'unverified';

  async function runList(op: string) {
    if (cap?.operationFields?.[op]?.some(field => field.required && !field.remove)) {setExtraForm(op);return;}
    setRunningOp(op);
    await listAct.run(() => api.runAction(conn.id, { operation: op, projectId: projectId || undefined, input: {} }));
    setRunningOp(null);
  }

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h2 className="card__title">{conn.label}</h2>
          <div className="small muted">{providerLabel(conn.provider)} · {conn.accountId}</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <ConnectionStatusBadge status={conn.status} />
        </div>
      </div>
      <div className="card__body">
        <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {[...readOps, ...extraReadOps].map((op) => (
            <button key={op} className="btn btn--sm" onClick={() => void runList(op)} disabled={listAct.pending}>
              {runningOp === op ? <Spinner /> : <RefreshCcw size={13} />} {operationLabel(op)}
            </button>
          ))}
          {canPost && (
            <button
              className="btn btn--sm btn--primary"
              disabled={!writable}
              title={!writable ? '연결 상태가 정상일 때만 게시할 수 있습니다.' : undefined}
              onClick={() => setCompose(true)}
            >
              <Plus size={13} /> 게시물 작성
            </button>
          )}
          {extraWriteOps.map((op) => (
            <button
              key={op}
              className="btn btn--sm"
              disabled={!writable}
              title={!writable ? '연결 상태가 정상일 때만 사용할 수 있습니다.' : '이 채널이 광고한 작업입니다.'}
              onClick={() => setExtraForm(op)}
            >
              <Plus size={13} /> {operationLabel(op)}
            </button>
          ))}
          {readOps.length === 0 && !canPost && extraOps.length === 0 && (
            <span className="small muted">이 채널에서 지원되는 커뮤니티 작업이 없습니다.</span>
          )}
        </div>

        {listAct.error && <div style={{ marginBottom: 12 }}><Notice tone="error">{listAct.error.message}</Notice></div>}

        {resources.length === 0 ? (
          <p className="small muted">아직 가져온 항목이 없습니다. 위의 조회 작업으로 최신 게시물·멘션·뉴스를 가져오세요.</p>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {resources.map((r) => (
              <div key={r.id} className="card" style={{ boxShadow: 'none' }}>
                <div className="card__body">
                  <div className="row row--between" style={{ gap: 8 }}>
                    <span className="tag">{RESOURCE_KIND_LABELS[r.kind] ?? r.kind}</span>
                    <span className="small muted nowrap" title={formatDateTime(typeof r.data.createdAt === 'string' ? r.data.createdAt : r.updatedAt)}>
                      {formatRelative(typeof r.data.createdAt === 'string' ? r.data.createdAt : r.updatedAt)}
                    </span>
                  </div>
                  <p style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>{textOf(r)}</p>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {metricsOf(r).map(([k, v]) => (
                      <span key={k} className="tag mono" title={k}>{k}: {v}</span>
                    ))}
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 10 }}>
                    {permalinkOf(r) && (
                      <button className="btn btn--sm btn--ghost" onClick={() => void api.openExternal(permalinkOf(r) as string)}>
                        <ExternalLink size={13} /> 원문 열기
                      </button>
                    )}
                    {canReply && (r.kind === 'post' || r.kind === 'mention' || r.kind === 'reply') && (
                      <button className="btn btn--sm" disabled={!writable} onClick={() => setReplyTo(r)}>
                        <ReplyIcon size={13} /> 답글
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {compose && (
        <ActionForm connection={conn} operation="create-post" presetProjectId={projectId || undefined} capability={cap} state={state} refresh={refresh} onClose={() => setCompose(false)} />
      )}
      {replyTo && (
        <ReplyModal conn={conn} target={replyTo} projectId={projectId} refresh={refresh} onClose={() => setReplyTo(null)} />
      )}
      {extraForm && (
        <ActionForm
          connection={conn}
          operation={extraForm}
          presetProjectId={projectId || undefined}
          capability={cap}
          state={state}
          refresh={refresh}
          onClose={() => setExtraForm(null)}
        />
      )}
    </section>
  );
}

function ComposeModal({
  conn,
  projectId,
  refresh,
  onClose,
}: {
  conn: Connection;
  projectId: string;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const act = useAction<Run>(refresh);
  const key = useState(() => newIdempotencyKey())[0];
  const done = act.result;

  async function submit() {
    if (!text.trim()) return;
    await act.run(() =>
      api.runAction(conn.id, {
        operation: 'create-post',
        projectId: projectId || undefined,
        input: { text: text.trim() },
        idempotencyKey: key,
      }),
    );
  }

  return (
    <Modal
      title={`게시물 작성 · ${providerLabel(conn.provider)}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>{done ? '닫기' : '취소'}</button>
          {!done && (
            <button className="btn btn--primary" onClick={() => void submit()} disabled={act.pending || !text.trim()}>
              {act.pending ? <Spinner /> : <Send size={15} />} 게시
            </button>
          )}
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        {done ? (
          <Notice tone="info" title="게시 작업이 생성되었습니다">
            이력 화면에서 실제 반영 상태와 로그를 확인하세요. 응답이 유실되어도 같은 요청으로만 재시도되어 중복 게시를
            방지합니다.
          </Notice>
        ) : (
          <>
            <p className="small muted" style={{ margin: 0 }}>
              {api.isDemo()
                ? `데모 모드: ${conn.label} 데모 채널에 기록되며 실제 공급자에는 게시되지 않습니다.`
                : `${conn.label} 계정에 바로 게시됩니다. 게시 후에는 이 앱에서 되돌릴 수 없습니다.`}
            </p>
            <Field label="내용" required hint={`${text.length}자`}>
              <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="게시할 내용을 입력하세요" />
            </Field>
            {act.error && <Notice tone="error" title="게시 실패">{act.error.message}</Notice>}
          </>
        )}
      </div>
    </Modal>
  );
}

function ReplyModal({
  conn,
  target,
  projectId,
  refresh,
  onClose,
}: {
  conn: Connection;
  target: ExternalResource;
  projectId: string;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const act = useAction<Run>(refresh);
  const key = useState(() => newIdempotencyKey())[0];
  const done = act.result;

  async function submit() {
    if (!text.trim()) return;
    await act.run(() =>
      api.runAction(conn.id, {
        operation: 'reply',
        projectId: projectId || undefined,
        input: { text: text.trim(), replyToId: target.externalId },
        idempotencyKey: key,
      }),
    );
  }

  return (
    <Modal
      title="답글 작성"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>{done ? '닫기' : '취소'}</button>
          {!done && (
            <button className="btn btn--primary" onClick={() => void submit()} disabled={act.pending || !text.trim()}>
              {act.pending ? <Spinner /> : <ReplyIcon size={15} />} 답글 게시
            </button>
          )}
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="card" style={{ boxShadow: 'none' }}>
          <div className="card__body">
            <div className="small muted">원문</div>
            <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{textOf(target)}</p>
          </div>
        </div>
        {done ? (
          <Notice tone="info" title="답글 작업이 생성되었습니다">이력에서 실제 반영 상태를 확인하세요.</Notice>
        ) : (
          <>
            <Field label="답글 내용" required hint={`${text.length}자`}>
              <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} rows={4} />
            </Field>
            {act.error && <Notice tone="error" title="답글 실패">{act.error.message}</Notice>}
          </>
        )}
      </div>
    </Modal>
  );
}

function ScheduleSection({
  state,
  refresh,
  project,
  channels,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  project: Project | null;
  channels: Connection[];
}) {
  const [open, setOpen] = useState(false);
  const schedules = (state.socialSchedules ?? []).filter((s) => !project || s.projectId === project.id);
  const postableChannels = channels.filter((c) => {
    const cap = state.capabilities.find((cp) => cp.provider === c.provider);
    return !!cap && cap.operations.includes('create-post');
  });

  return (
    <Card
      title="예약 게시"
      icon={CalendarClock}
      actions={
        <button
          className="btn btn--sm btn--primary"
          disabled={!project || postableChannels.length === 0}
          title={!project ? '프로젝트를 먼저 선택하세요.' : postableChannels.length === 0 ? '게시 가능한 채널이 없습니다.' : undefined}
          onClick={() => setOpen(true)}
        >
          <Plus size={13} /> 예약 추가
        </button>
      }
    >
      {schedules.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          예약된 게시가 없습니다. 지정한 시각에 제어 서비스가 게시하며, 대기 중인 예약만 취소할 수 있습니다.
        </p>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} state={state} refresh={refresh} />
          ))}
        </div>
      )}
      {open && project && (
        <ScheduleModal project={project} channels={postableChannels} refresh={refresh} onClose={() => setOpen(false)} />
      )}
    </Card>
  );
}

function ScheduleRow({ schedule, state, refresh }: { schedule: SocialSchedule; state: AppState; refresh: () => Promise<void> }) {
  const cancel = useAction<{ cancelled: true }>(refresh);
  const tone = schedule.status === 'cancelled' ? 'neutral' : schedule.status === 'queued' ? 'progress' : 'info';
  const label = schedule.status === 'cancelled' ? '취소됨' : schedule.status === 'queued' ? '실행 대기' : '예약됨';
  const chans = schedule.connectionIds
    .map((id) => state.connections.find((c) => c.id === id)?.label ?? id)
    .join(', ');
  const canCancel = schedule.status === 'scheduled';
  return (
    <div className="card" style={{ boxShadow: 'none' }}>
      <div className="card__body">
        <div className="row row--between" style={{ gap: 8 }}>
          <Badge tone={tone}>{label}</Badge>
          <span className="small muted nowrap" title={formatDateTime(schedule.scheduledAt)}>{formatDateTime(schedule.scheduledAt)}</span>
        </div>
        <p style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>{schedule.text}</p>
        <div className="small muted">채널: {chans || '—'}</div>
        {canCancel && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn--sm btn--danger" disabled={cancel.pending} onClick={() => void cancel.run(() => api.cancelSocialSchedule(schedule.id))}>
              {cancel.pending ? <Spinner /> : <Trash2 size={13} />} 예약 취소
            </button>
          </div>
        )}
        {cancel.error && <div style={{ marginTop: 8 }}><Notice tone="error">{cancel.error.message}</Notice></div>}
      </div>
    </div>
  );
}

function ScheduleModal({
  project,
  channels,
  refresh,
  onClose,
}: {
  project: Project;
  channels: Connection[];
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [when, setWhen] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const act = useAction<SocialSchedule>(refresh);

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  const whenIso = (() => {
    if (!when) return null;
    const d = new Date(when);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  })();
  const future = whenIso ? new Date(whenIso).getTime() > Date.now() : false;
  const blocked = !text.trim() || !whenIso || !future || selected.length === 0;

  async function submit() {
    if (blocked || !whenIso) return;
    const res = await act.run(() =>
      api.createSocialSchedule({ projectId: project.id, connectionIds: selected, text: text.trim(), scheduledAt: whenIso }),
    );
    if (res?.ok) onClose();
  }

  return (
    <Modal
      title="예약 게시 추가"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={blocked || act.pending}>
            {act.pending ? <Spinner /> : <CalendarClock size={15} />} 예약
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <Field label="내용" required hint={`${text.length}자`}>
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} rows={4} />
        </Field>
        <Field label="게시 시각" required hint={when && !future ? '미래 시각을 선택하세요.' : '로컬 시간대 기준으로 예약됩니다.'}>
          <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label="채널" required hint="예약 시 함께 게시할 채널을 선택하세요.">
          <div className="stack" style={{ gap: 6 }}>
            {channels.map((c) => (
              <label className="checkbox-row" key={c.id}>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                <span><strong>{c.label}</strong> <span className="small muted">· {providerLabel(c.provider)}</span></span>
              </label>
            ))}
          </div>
        </Field>
        {act.error && <Notice tone="error" title="예약 실패">{act.error.message}</Notice>}
      </div>
    </Modal>
  );
}

function SocialPolicySection({
  project,
  channels,
  refresh,
}: {
  project: Project;
  channels: Connection[];
  refresh: () => Promise<void>;
}) {
  const initial = project.socialPolicy ?? {
    enabled: false,
    connectionIds: [],
    dailyPostLimit: 3,
    autoReleaseAnnouncements: false,
    releaseTemplate: '{projectName} {version} 업데이트가 {platform}에 출시되었습니다!',
    autoReply: false,
    replyRules: [],
  };
  const [policy, setPolicy] = useState(initial);
  const save = useAction<Project>(refresh);

  function set<K extends keyof typeof policy>(key: K, value: (typeof policy)[K]) {
    setPolicy((p) => ({ ...p, [key]: value }));
  }
  function toggleConn(id: string) {
    setPolicy((p) => ({
      ...p,
      connectionIds: p.connectionIds.includes(id) ? p.connectionIds.filter((x) => x !== id) : [...p.connectionIds, id],
    }));
  }
  function addRule() {
    setPolicy((p) => ({ ...p, replyRules: [...p.replyRules, { id: newIdempotencyKey(), matchText: '', replyText: '' }] }));
  }
  function updateRule(id: string, patch: Partial<{ matchText: string; replyText: string }>) {
    setPolicy((p) => ({ ...p, replyRules: p.replyRules.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));
  }
  function removeRule(id: string) {
    setPolicy((p) => ({ ...p, replyRules: p.replyRules.filter((r) => r.id !== id) }));
  }

  const limitValid = Number.isInteger(policy.dailyPostLimit) && policy.dailyPostLimit >= 0;
  const rulesValid = policy.replyRules.every((r) => r.matchText.trim() !== '' && r.replyText.trim() !== '');
  const blocked = !limitValid || (policy.autoReply && !rulesValid);

  async function submit() {
    if (blocked) return;
    await save.run(() =>
      api.setSocialPolicy(project.id, {
        ...policy,
        dailyPostLimit: policy.dailyPostLimit,
        replyRules: policy.replyRules.map((r) => ({ id: r.id, matchText: r.matchText.trim(), replyText: r.replyText.trim() })),
      }),
    );
  }

  return (
    <Card title={`${project.name} · 커뮤니티 자동화 정책`} icon={ShieldCheck}>
      <Notice tone="info">
        정책을 한 번 저장하면 저장한 범위(채널·일일 한도·규칙) 안에서 자동 실행되며 매번 확인을 요청하지 않습니다. 자동
        답글 규칙은 입력한 문구와 정확히 일치할 때 저장된 응답을 보낼 뿐, 외부 내용을 명령으로 실행하지 않습니다.
      </Notice>

      <label className="checkbox-row" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={policy.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        <span>
          <strong>커뮤니티 자동화 사용</strong>
          <div className="small muted">끄면 자동 공지·자동 답글이 실행되지 않습니다. 수동 게시·예약은 이 설정과 무관합니다.</div>
        </span>
      </label>

      <div style={{ marginTop: 16 }}>
        <div className="section-title">자동화 대상 채널</div>
        {channels.length === 0 ? (
          <p className="small muted">연결된 커뮤니티 채널이 없습니다.</p>
        ) : (
          channels.map((c) => (
            <label className="checkbox-row" key={c.id}>
              <input type="checkbox" checked={policy.connectionIds.includes(c.id)} onChange={() => toggleConn(c.id)} />
              <span><strong>{c.label}</strong> <span className="small muted">· {providerLabel(c.provider)}</span></span>
            </label>
          ))
        )}
      </div>

      <div className="row" style={{ marginTop: 16, gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <Field label="일일 게시 한도" htmlFor="sp-limit" hint="자동 게시가 하루에 초과하지 않도록 제한하는 상한.">
            <input
              id="sp-limit"
              className="input"
              type="number"
              min={0}
              value={String(policy.dailyPostLimit)}
              onChange={(e) => set('dailyPostLimit', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
          </Field>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="section-title">
          <span className="row" style={{ gap: 6 }}><Megaphone size={14} /> 출시 자동 공지</span>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={policy.autoReleaseAnnouncements} onChange={(e) => set('autoReleaseAnnouncements', e.target.checked)} />
          <span>
            <strong>출시 시 자동 공지</strong>
            <div className="small muted">배포가 공개되면 아래 템플릿으로 선택한 채널에 자동 공지합니다.</div>
          </span>
        </label>
        <Field label="공지 템플릿" htmlFor="sp-template" hint="사용 가능한 치환자: {projectName}, {version}, {platform}">
          <textarea id="sp-template" className="textarea" value={policy.releaseTemplate} onChange={(e) => set('releaseTemplate', e.target.value)} rows={3} />
        </Field>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="section-title">
          <span className="row" style={{ gap: 6 }}><MessageSquare size={14} /> 자동 답글</span>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={policy.autoReply} onChange={(e) => set('autoReply', e.target.checked)} />
          <span>
            <strong>규칙 기반 자동 답글</strong>
            <div className="small muted">멘션 내용이 규칙의 문구와 일치하면 저장된 응답을 보냅니다.</div>
          </span>
        </label>
        {policy.autoReply && (
          <div className="stack" style={{ gap: 10, marginTop: 8 }}>
            {policy.replyRules.length === 0 && <p className="small muted">규칙이 없습니다. 규칙을 추가하세요.</p>}
            {policy.replyRules.map((r) => (
              <div key={r.id} className="row" style={{ gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Field label="일치 문구">
                    <input className="input" value={r.matchText} onChange={(e) => updateRule(r.id, { matchText: e.target.value })} placeholder="예: 출시일" />
                  </Field>
                </div>
                <div style={{ flex: 2, minWidth: 200 }}>
                  <Field label="응답">
                    <input className="input" value={r.replyText} onChange={(e) => updateRule(r.id, { replyText: e.target.value })} placeholder="저장된 응답 문구" />
                  </Field>
                </div>
                <button className="btn btn--ghost btn--sm" style={{ marginTop: 26 }} onClick={() => removeRule(r.id)} aria-label="규칙 제거">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div>
              <button className="btn btn--sm" onClick={addRule}><Plus size={13} /> 규칙 추가</button>
            </div>
            {!rulesValid && <Notice tone="warn">모든 규칙의 일치 문구와 응답을 입력하세요.</Notice>}
          </div>
        )}
      </div>

      {save.error && <div style={{ marginTop: 12 }}><Notice tone="error" title="정책 저장 실패">{save.error.message}</Notice></div>}
      <div className="row" style={{ marginTop: 16, gap: 10 }}>
        <button className="btn btn--primary" onClick={() => void submit()} disabled={save.pending || blocked}>
          {save.pending ? <Spinner /> : <ShieldCheck size={15} />} 정책 저장
        </button>
        {save.result && <span className="small" style={{ color: 'var(--ok)' }}>저장되었습니다.</span>}
      </div>
    </Card>
  );
}
