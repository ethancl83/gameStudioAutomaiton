// 계정 연결: 최초 1회 연결(Google OAuth 또는 수동/서비스 계정), 상태 검사, 재연결, 자격 증명 수정, 해제.
// - 비밀 값은 화면 상태에만 두고 제어 서비스로 전송하며, 화면/로그에 다시 노출하지 않는다.
// - bearer·보관함 비밀은 노출하지 않는다.
// - Google 브라우저 인증은 최초 1회만, main 허용목록의 accounts.google.com 으로 연다.
import { useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  KeyRound,
  Link2,
  Lock,
  RefreshCcw,
  RotateCw,
  Trash2,
  Wrench,
} from 'lucide-react';
import { api } from '../api';
import { CAPABILITY_CATEGORY_LABELS, formatRelative, providerLabel } from '../format';
import { useAction } from '../useAction';
import { Card, EmptyState, Field, Modal, Notice, Spinner } from '../components/ui';
import { ConnectionStatusBadge } from '../components/status';
import type {
  AppState,
  Capability,
  Connection,
  CredentialField,
  Provider,
} from '../../../../packages/domain';

// Google OAuth 온보딩을 지원하는 공급자.
const GOOGLE_OAUTH_PROVIDERS = new Set<Provider>(['google-play', 'google-ads', 'admob']);
function isGoogleOAuthProvider(p: Provider): boolean {
  return GOOGLE_OAUTH_PROVIDERS.has(p);
}
// 소셜(X/Threads) 브라우저 OAuth 온보딩을 지원하는 공급자.
const SOCIAL_OAUTH_PROVIDERS = new Set<Provider>(['x', 'threads']);
function isSocialOAuthProvider(p: Provider): boolean {
  return SOCIAL_OAUTH_PROVIDERS.has(p);
}
function isOAuthProvider(p: Provider): boolean {
  return isGoogleOAuthProvider(p) || isSocialOAuthProvider(p);
}
// OAuth 콜백이 대신 저장하므로 온보딩 폼에서 받지 않는 자격 증명(갱신 토큰·서비스 계정 키).
const OAUTH_REPLACED = /refresh|service.?account|private.?key|json.?key|\bp12\b/i;
function isClientIdKey(k: string): boolean {
  return /^client.?id$/i.test(k);
}
function isClientSecretKey(k: string): boolean {
  return /^client.?secret$/i.test(k);
}
// 재연결(재인증) 버튼은 라우틴 로그인이 아니라 오류 상태에서만 노출한다.
function needsReconnect(status: Connection['status']): boolean {
  return status === 'action_required' || status === 'permission_required';
}

export function ConnectionsView({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [addOpen, setAddOpen] = useState(false);

  const actionNeeded = state.connections.filter((c) => needsReconnect(c.status));

  return (
    <div className="stack">
      <VaultBanner state={state} />

      {actionNeeded.length > 0 && (
        <Notice tone="warn" title={`조치가 필요한 연결 ${actionNeeded.length}건`}>
          아래 연결에 사용자 조치가 필요합니다. 상태를 확인하고 재연결 또는 자격 증명 수정을 완료하면 관련 작업이
          이어서 재개됩니다.
        </Notice>
      )}

      <div className="row row--between">
        <p className="muted small" style={{ margin: 0 }}>
          계정은 최초 한 번 연결하면 여러 프로젝트에서 재사용합니다. 정상 갱신·재시작에는 다시 로그인하지 않습니다.
        </p>
        <button className="btn btn--primary" onClick={() => setAddOpen(true)} disabled={state.capabilities.length === 0}>
          <Link2 size={15} /> 계정 연결
        </button>
      </div>

      {state.connections.length === 0 ? (
        <Card>
          <EmptyState
            icon={KeyRound}
            title="연결된 계정이 없습니다"
            description="스토어·광고·수익화 계정을 연결하면 빌드 업로드, 캠페인, 수익 집계를 사용할 수 있습니다."
            action={
              <button className="btn btn--primary" onClick={() => setAddOpen(true)} disabled={state.capabilities.length === 0}>
                <Link2 size={15} /> 첫 계정 연결
              </button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid--cards">
          {state.connections.map((conn) => (
            <ConnectionCard key={conn.id} conn={conn} state={state} refresh={refresh} />
          ))}
        </div>
      )}

      {state.capabilities.length === 0 && (
        <Notice tone="info">
          연결 가능한 공급자 정보를 제어 서비스에서 아직 받지 못했습니다. 서비스가 준비되면 연결 마법사가 활성화됩니다.
        </Notice>
      )}

      {addOpen && <AddConnectionModal state={state} refresh={refresh} onClose={() => setAddOpen(false)} />}
    </div>
  );
}

function VaultBanner({ state }: { state: AppState }) {
  const { vault } = state;
  if (api.isDemo()) {
    return (
      <div className="notice notice--info" role="status">
        <Lock size={17} style={{ flex: 'none' }} />
        <div className="notice__body">
          <div className="notice__title">데모 모드 · 시드된 연결</div>
          아래 연결은 데모 시드 계정입니다. 자격 증명 입력 없이 상태 검사·복구·작업을 실행할 수 있으며 실제 공급자에
          전송되지 않습니다. 실제 계정은 머리말의 모드 전환으로 실제 모드에서 같은 화면으로 연결합니다.
        </div>
      </div>
    );
  }
  if (vault.available) {
    return (
      <div className="notice notice--info" role="status" style={{ borderColor: 'var(--border)' }}>
        <Lock size={17} style={{ flex: 'none' }} />
        <div className="notice__body">
          <div className="notice__title">보안 보관함 사용 중 · {vault.backend}</div>
          자격 증명은 OS 보관함의 마스터키로 암호화되어 저장되고, DB와 로그에는 비밀이 남지 않습니다.
        </div>
      </div>
    );
  }
  return (
    <Notice tone="error" title={`보안 보관함을 사용할 수 없습니다 · ${vault.backend}`}>
      {vault.reason ?? '보관함이 잠겨 있거나 지원되지 않습니다.'} 안전한 보관함 없이 자격 증명을 저장하지 않습니다.
      보관함을 준비한 뒤 계정을 연결하세요.
    </Notice>
  );
}

function ConnectionCard({ conn, state, refresh }: { conn: Connection; state: AppState; refresh: () => Promise<void> }) {
  const check = useAction<Connection>(refresh);
  const del = useAction<{ deleted: true }>(refresh);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [repairOpen, setRepairOpen] = useState(false);
  const cap = state.capabilities.find((c) => c.provider === conn.provider);

  // 데모: 자격 증명 재입력/OAuth 없이 상태 검사로 복구한다(루트 데모 어댑터가 전이).
  const demo = api.isDemo();
  const showReconnect = !demo && isOAuthProvider(conn.provider) && needsReconnect(conn.status);
  const showRepair = !demo && needsReconnect(conn.status) && !!cap && cap.fields.length > 0;
  const showDemoRecover = demo && needsReconnect(conn.status);

  return (
    <section className="card">
      <div className="card__head">
        <KeyRound size={16} aria-hidden />
        <div>
          <h2 className="card__title">{conn.label}</h2>
          <div className="small muted">{providerLabel(conn.provider)}</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <ConnectionStatusBadge status={conn.status} />
        </div>
      </div>
      <div className="card__body">
        <dl className="dl" style={{ gridTemplateColumns: '110px 1fr' }}>
          <dt>계정 ID</dt>
          <dd className="mono small">{conn.accountId}</dd>
          <dt>인증 방식</dt>
          <dd className="small">{conn.authKind}</dd>
          <dt>마지막 검사</dt>
          <dd className="small">{formatRelative(conn.lastCheckedAt)}</dd>
        </dl>

        {conn.lastError && (
          <div style={{ marginTop: 12 }}>
            <Notice tone={conn.status === 'action_required' ? 'error' : 'warn'}>
              <span className="small">{conn.lastError}</span>
            </Notice>
          </div>
        )}

        {needsReconnect(conn.status) && cap && (
          <div style={{ marginTop: 10 }}>
            <SetupLink cap={cap} />
          </div>
        )}

        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button className="btn btn--sm" onClick={() => void check.run(() => api.checkConnection(conn.id))} disabled={check.pending}>
            {check.pending ? <Spinner /> : <RefreshCcw size={13} />} 상태 검사
          </button>
          {showDemoRecover && (
            <button
              className="btn btn--sm btn--primary"
              onClick={() => void check.run(() => api.checkConnection(conn.id))}
              disabled={check.pending}
              title="데모 연결을 다시 검사해 복구합니다(자격 증명 불필요)."
            >
              {check.pending ? <Spinner /> : <RotateCw size={13} />} 복구 시도
            </button>
          )}
          {showReconnect && (
            <button className="btn btn--sm btn--primary" onClick={() => setReconnecting(true)}>
              <RotateCw size={13} /> 다시 연결
            </button>
          )}
          {showRepair && (
            <button className="btn btn--sm" onClick={() => setRepairOpen(true)}>
              <Wrench size={13} /> 자격 증명 수정
            </button>
          )}
          <button className="btn btn--sm btn--danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} /> 연결 해제
          </button>
        </div>
        {check.error && <div style={{ marginTop: 8 }}><Notice tone="error">{check.error.message}</Notice></div>}
      </div>

      {reconnecting && (
        <ReconnectModal conn={conn} connections={state.connections} refresh={refresh} onClose={() => setReconnecting(false)} />
      )}

      {repairOpen && cap && (
        <RepairCredentialsModal conn={conn} cap={cap} refresh={refresh} onClose={() => setRepairOpen(false)} />
      )}

      {confirmDelete && (
        <Modal
          title="연결 해제"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                취소
              </button>
              <button
                className="btn btn--danger"
                disabled={del.pending}
                onClick={async () => {
                  const res = await del.run(() => api.deleteConnection(conn.id));
                  if (res?.ok) setConfirmDelete(false);
                }}
              >
                {del.pending ? <Spinner /> : <Trash2 size={15} />} 연결 해제
              </button>
            </>
          }
        >
          <Notice tone="warn">
            <strong>{conn.label}</strong> 연결을 해제하면 관련 작업이 정지되고 보관된 자격 증명이 삭제됩니다. 이 연결을
            사용하는 프로젝트 정책의 허용 목록에서도 제거하세요.
          </Notice>
          {del.error && <div style={{ marginTop: 12 }}><Notice tone="error">{del.error.message}</Notice></div>}
        </Modal>
      )}
    </section>
  );
}

function SetupLink({ cap }: { cap: Capability }) {
  if (!cap.setupUrl) return null;
  return (
    <button className="btn btn--sm" onClick={() => void api.openExternal(cap.setupUrl)}>
      <ExternalLink size={13} /> 설정 안내 열기
    </button>
  );
}

// Google 인증 진행 상태를 표시하고, 상태 폴링에서 대상 연결 ID가 나타나면 완료한다.
function OAuthPending({
  connectionId,
  connections,
  refresh,
  onConnected,
  message,
}: {
  connectionId: string;
  connections: Connection[];
  refresh: () => Promise<void>;
  onConnected: (conn: Connection) => void;
  message: string;
}) {
  // 대기 중 폴링 가속: 콜백 완료를 빨리 감지한다.
  useEffect(() => {
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [refresh]);

  // 상태에 대상 연결 ID가 나타나면(콜백이 갱신 토큰 저장 후 연결 생성) 완료 처리.
  useEffect(() => {
    const found = connections.find((c) => c.id === connectionId);
    if (found) onConnected(found);
  }, [connections, connectionId, onConnected]);

  return (
    <Notice tone="info" title="브라우저에서 Google 로그인을 완료하세요">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Spinner />
        <span className="small">{message}</span>
      </div>
    </Notice>
  );
}

function ReconnectModal({
  conn,
  connections,
  refresh,
  onClose,
}: {
  conn: Connection;
  connections: Connection[];
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const start = useAction<{ connectionId: string; authorizationUrl: string }>();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const social = isSocialOAuthProvider(conn.provider);
  async function begin() {
    setOpenError(null);
    const res = await start.run(() =>
      social ? api.startConnectionSocialOAuth(conn.id) : api.startConnectionOAuth(conn.id),
    );
    if (res?.ok) {
      const opened = await api.openExternal(res.data.authorizationUrl);
      if (!opened.ok) {
        setOpenError(opened.error ?? '인증 URL을 열 수 없습니다.');
        return;
      }
      setPendingId(res.data.connectionId);
    }
  }

  return (
    <Modal
      title={social ? `${providerLabel(conn.provider)} 다시 연결` : 'Google 계정 다시 연결'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            닫기
          </button>
          {!pendingId && (
            <button className="btn btn--primary" onClick={() => void begin()} disabled={start.pending}>
              {start.pending ? <Spinner /> : <RotateCw size={15} />} {social ? '브라우저 로그인 열기' : 'Google 로그인 열기'}
            </button>
          )}
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>
          저장된 클라이언트 설정을 재사용해 다시 인증합니다. 클라이언트 ID·시크릿을 다시 입력하지 않습니다.
        </p>
        {pendingId ? (
          <OAuthPending
            connectionId={pendingId}
            connections={connections}
            refresh={refresh}
            onConnected={() => onClose()}
            message="로그인 완료 후 이 연결의 상태가 갱신되면 창이 닫힙니다."
          />
        ) : (
          <>
            {openError && <Notice tone="error">{openError}</Notice>}
            {start.error && <Notice tone="error" title="재연결 시작 실패">{start.error.message}</Notice>}
          </>
        )}
      </div>
    </Modal>
  );
}

function RepairCredentialsModal({
  conn,
  cap,
  refresh,
  onClose,
}: {
  conn: Connection;
  cap: Capability;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const repair = useAction<Connection>(refresh);

  // 입력한 필드만 서버에 병합 전송한다. 저장된 기존 값은 서버가 노출하지 않는다.
  const provided = Object.entries(values).filter(([, v]) => v.trim() !== '');

  async function submit() {
    if (provided.length === 0) return;
    const payload: Record<string, string> = {};
    for (const [k, v] of provided) payload[k] = v;
    const res = await repair.run(() => api.repairCredentials(conn.id, payload));
    if (res?.ok) onClose();
  }

  return (
    <Modal
      title="자격 증명 수정"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            취소
          </button>
          <button className="btn btn--primary" onClick={() => void submit()} disabled={repair.pending || provided.length === 0}>
            {repair.pending ? <Spinner /> : <Wrench size={15} />} 병합 저장
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <Notice tone="info">
          취소·만료된 키만 새로 입력하세요. 입력한 값만 병합 저장되며, 저장된 기존 값은 화면에 표시되지 않습니다. 비우면
          해당 항목은 변경하지 않습니다.
        </Notice>
        {cap.fields.map((f) => (
          <CredentialInput key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
        ))}
        {repair.error && <Notice tone="error" title="자격 증명 저장 실패">{repair.error.message}</Notice>}
      </div>
    </Modal>
  );
}

type Mode = 'oauth' | 'manual';

function AddConnectionModal({ state, refresh, onClose }: { state: AppState; refresh: () => Promise<void>; onClose: () => void }) {
  const [provider, setProvider] = useState<Provider | ''>('');
  const [mode, setMode] = useState<Mode>('oauth');
  const [label, setLabel] = useState('');
  const [accountId, setAccountId] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const add = useAction<Connection>(refresh);
  const oauth = useAction<{ connectionId: string; authorizationUrl: string }>();

  const providerOptions = useMemo(() => {
    const seen = new Set<Provider>();
    return state.capabilities.filter((c) => (seen.has(c.provider) ? false : (seen.add(c.provider), true)));
  }, [state.capabilities]);

  // 선택 공급자의 자격 증명 필드(같은 공급자의 여러 capability 합치고 중복 제거).
  const fields = useMemo(() => {
    if (!provider) return [];
    const all = state.capabilities.filter((c) => c.provider === provider).flatMap((c) => c.fields);
    const seen = new Set<string>();
    return all.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
  }, [state.capabilities, provider]);

  // 데모: 자격 증명 필드 없이 최소 입력(공급자·이름·식별자)만 받는다. 루트가 합성 계정을 만든다.
  const demo = api.isDemo();
  const cap = useMemo(() => state.capabilities.find((c) => c.provider === provider) ?? null, [state.capabilities, provider]);
  const social = provider ? isSocialOAuthProvider(provider) : false;
  const oauthCapable = provider ? isOAuthProvider(provider) : false;
  const effectiveMode: Mode = demo ? 'manual' : oauthCapable ? mode : 'manual';
  // 소셜(X/Threads)은 계정 ID를 자동 검색으로 채울 수 있어 비워둘 수 있다(서버가 정규화).
  const accountRequired = !social;

  // OAuth 온보딩에서 받는 공급자 필드(갱신 토큰·서비스 계정 키·client 값 제외).
  const onboardingFields = useMemo(
    () => fields.filter((f) => !OAUTH_REPLACED.test(f.key) && !isClientIdKey(f.key) && !isClientSecretKey(f.key)),
    [fields],
  );
  const capClientId = fields.find((f) => isClientIdKey(f.key));
  const capClientSecret = fields.find((f) => isClientSecretKey(f.key));
  const clientIdKey = capClientId?.key ?? 'clientId';
  const clientSecretKey = capClientSecret?.key ?? 'clientSecret';

  function resetForProvider(p: Provider | '') {
    setProvider(p);
    setCredentials({});
    setMode('oauth');
    setPendingId(null);
    setOpenError(null);
  }

  // OAuth 시작 가능 조건: label/clientId(+공급자가 필수로 표시한 clientSecret)/표시된 온보딩 필수 필드.
  // 소셜은 accountId를 비워둘 수 있다.
  const clientSecretRequired = !!capClientSecret?.required;
  const oauthMissing =
    !label.trim() ||
    (accountRequired && !accountId.trim()) ||
    !(credentials[clientIdKey] ?? '').trim() ||
    (clientSecretRequired && !(credentials[clientSecretKey] ?? '').trim()) ||
    onboardingFields.some((f) => f.required && !(credentials[f.key] ?? '').trim());

  const manualMissing =
    !label.trim() ||
    (accountRequired && !accountId.trim()) ||
    (!demo && fields.some((f) => f.required && !(credentials[f.key] ?? '').trim()));

  // 데모는 보관함/자격 증명 요건을 적용하지 않는다.
  const canSubmit = (demo || state.vault.available) && provider && (effectiveMode === 'oauth' ? !oauthMissing : !manualMissing);

  async function submitManual() {
    if (!provider || !canSubmit) return;
    const res = await add.run(() =>
      api.addConnection({ provider, label: label.trim(), accountId: accountId.trim(), credentials }),
    );
    if (res?.ok) onClose();
  }

  async function submitOAuth() {
    if (!provider || !oauthCapable || !canSubmit) return;
    setOpenError(null);
    // OAuth 온보딩 자격 증명: clientId(필수)·clientSecret(선택)·공급자 온보딩 필드만. refreshToken/serviceAccountJson 미포함.
    const creds: Record<string, string> = {};
    const cid = (credentials[clientIdKey] ?? '').trim();
    if (cid) creds.clientId = cid;
    const csecret = (credentials[clientSecretKey] ?? '').trim();
    if (csecret) creds.clientSecret = csecret;
    for (const f of onboardingFields) {
      const v = (credentials[f.key] ?? '').trim();
      if (v) creds[f.key] = v;
    }
    const res = await oauth.run(() =>
      social
        ? api.startSocialOAuth(provider as 'x' | 'threads', {
            label: label.trim(),
            accountId: accountId.trim() || 'auto',
            credentials: creds,
          })
        : api.startGoogleOAuth({
            provider: provider as 'google-play' | 'google-ads' | 'admob',
            label: label.trim(),
            accountId: accountId.trim(),
            credentials: creds,
          }),
    );
    if (res?.ok) {
      const opened = await api.openExternal(res.data.authorizationUrl);
      if (!opened.ok) {
        setOpenError(opened.error ?? '인증 URL을 열 수 없습니다.');
        return;
      }
      setPendingId(res.data.connectionId);
    }
  }

  return (
    <Modal
      title="계정 연결"
      onClose={onClose}
      wide
      footer={
        pendingId ? (
          <button className="btn" onClick={onClose}>
            닫기
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              취소
            </button>
            {effectiveMode === 'oauth' ? (
              <button className="btn btn--primary" onClick={() => void submitOAuth()} disabled={!canSubmit || oauth.pending}>
                {oauth.pending ? <Spinner /> : <RotateCw size={15} />} {social ? '브라우저로 연결' : 'Google 계정으로 연결'}
              </button>
            ) : (
              <button className="btn btn--primary" onClick={() => void submitManual()} disabled={!canSubmit || add.pending}>
                {add.pending ? <Spinner /> : <Link2 size={15} />} 연결
              </button>
            )}
          </>
        )
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        {!demo && !state.vault.available && (
          <Notice tone="error" title="보관함 준비 필요">
            안전한 OS 보관함을 사용할 수 없어 자격 증명을 저장할 수 없습니다. 환경 설정에서 보관함 상태를 확인하세요.
          </Notice>
        )}

        {demo && (
          <Notice tone="info" title="데모 연결">
            데모에서는 자격 증명을 입력하지 않습니다. 공급자·이름·식별자만 지정하면 루트가 합성 계정을 만들어 실제와
            동일한 연결 상태·작업 흐름을 보여줍니다. 실제 공급자에는 연결하지 않습니다.
          </Notice>
        )}

        {pendingId && cap ? (
          <OAuthPending
            connectionId={pendingId}
            connections={state.connections}
            refresh={refresh}
            onConnected={() => onClose()}
            message="로그인이 완료되면 연결이 생성되고 이 창이 자동으로 닫힙니다."
          />
        ) : (
          <>
            <Field label="공급자" required htmlFor="conn-provider">
              <select id="conn-provider" className="select" value={provider} onChange={(e) => resetForProvider(e.target.value as Provider)}>
                <option value="">공급자 선택</option>
                {providerOptions.map((c) => (
                  <option key={c.provider} value={c.provider}>
                    {providerLabel(c.provider)} — {CAPABILITY_CATEGORY_LABELS[c.category] ?? c.category}
                  </option>
                ))}
              </select>
            </Field>

            {cap && (
              <>
                {oauthCapable && !demo && (
                  <div className="pill-group" role="tablist" aria-label="연결 방식">
                    <button role="tab" aria-pressed={mode === 'oauth'} onClick={() => setMode('oauth')}>
                      {social ? '브라우저로 연결' : 'Google 계정으로 연결'}
                    </button>
                    <button role="tab" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>
                      {social ? '수동 · 토큰 입력' : '수동 · 서비스 계정 입력'}
                    </button>
                  </div>
                )}

                <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <Field label="연결 이름" required htmlFor="conn-label" hint="이 연결을 구분할 이름.">
                      <input id="conn-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`${providerLabel(cap.provider)} 계정`} />
                    </Field>
                  </div>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <Field
                      label="계정/조직 식별자"
                      required={accountRequired}
                      htmlFor="conn-account"
                      hint={social ? '비워두면 로그인 후 자동으로 채웁니다(선택).' : '개발자 계정 ID, 조직 ID 등.'}
                    >
                      <input id="conn-account" className="input mono" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder={social ? '자동 검색' : undefined} spellCheck={false} />
                    </Field>
                  </div>
                </div>

                {effectiveMode === 'oauth' ? (
                  <div>
                    <div className="section-title">{social ? `${providerLabel(cap.provider)} 앱 자격 증명` : 'Google OAuth 온보딩'}</div>
                    <p className="small muted" style={{ margin: '2px 0 10px' }}>
                      {social
                        ? '앱 클라이언트 ID(및 시크릿)만 입력합니다. 액세스·갱신 토큰은 브라우저 로그인 후 서버가 안전하게 저장하므로 입력하지 않습니다.'
                        : '클라이언트 ID(및 선택적 시크릿)와 공급자 필수 정보만 입력합니다. 갱신 토큰·서비스 계정 키는 브라우저 로그인 후 서버가 안전하게 저장하므로 입력하지 않습니다.'}
                    </p>
                    <Field label="클라이언트 ID" required htmlFor="oauth-clientid" hint={social ? '앱(개발자 포털) 클라이언트 ID' : 'Google Cloud OAuth 클라이언트 ID'}>
                      <input
                        id="oauth-clientid"
                        className="input mono"
                        autoComplete="off"
                        value={credentials[clientIdKey] ?? ''}
                        onChange={(e) => setCredentials((c) => ({ ...c, [clientIdKey]: e.target.value }))}
                        spellCheck={false}
                      />
                    </Field>
                    <Field label="클라이언트 시크릿" required={clientSecretRequired} htmlFor="oauth-clientsecret" hint={clientSecretRequired ? '이 공급자는 시크릿이 필요합니다.' : '데스크톱/공개 클라이언트는 없을 수 있습니다(선택).'}>
                      <input
                        id="oauth-clientsecret"
                        className="input mono"
                        type="password"
                        autoComplete="off"
                        value={credentials[clientSecretKey] ?? ''}
                        onChange={(e) => setCredentials((c) => ({ ...c, [clientSecretKey]: e.target.value }))}
                        spellCheck={false}
                      />
                    </Field>
                    {onboardingFields.map((f) => (
                      <CredentialInput key={f.key} field={f} value={credentials[f.key] ?? ''} onChange={(v) => setCredentials((c) => ({ ...c, [f.key]: v }))} />
                    ))}
                    <Notice tone="info">
                      <span className="small">
                        <ExternalLink size={12} /> 연결을 시작하면 시스템 브라우저에서 {social ? `${providerLabel(cap.provider)} 로그인` : 'Google 로그인(accounts.google.com)'}이
                        한 번 열립니다. 이후 정상 갱신에는 다시 로그인하지 않습니다.
                      </span>
                    </Notice>
                  </div>
                ) : demo ? (
                  <p className="small muted" style={{ margin: 0 }}>
                    데모 연결은 추가 자격 증명 입력이 필요 없습니다. 아래 “연결”을 누르면 합성 계정이 생성됩니다.
                  </p>
                ) : (
                  <div>
                    <div className="section-title">자격 증명</div>
                    <p className="small muted" style={{ margin: '2px 0 10px' }}>
                      {cap.authKind} · 입력한 비밀 값은 보관함에 암호화되어 저장되고 화면에 다시 표시되지 않습니다.
                    </p>
                    {fields.length === 0 ? (
                      <p className="small muted">이 공급자는 추가 자격 증명 입력이 없습니다.</p>
                    ) : (
                      fields.map((f) => (
                        <CredentialInput key={f.key} field={f} value={credentials[f.key] ?? ''} onChange={(v) => setCredentials((c) => ({ ...c, [f.key]: v }))} />
                      ))
                    )}
                  </div>
                )}

                {cap.limitations.length > 0 && (
                  <Notice tone="info" title="연동 제한 사항">
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {cap.limitations.map((l, i) => (
                        <li key={i} className="small">
                          {l}
                        </li>
                      ))}
                    </ul>
                  </Notice>
                )}

                {cap.setupUrl && (
                  <div>
                    <SetupLink cap={cap} />
                  </div>
                )}
              </>
            )}

            {openError && <Notice tone="error" title="브라우저 열기 실패">{openError}</Notice>}
            {oauth.error && <Notice tone="error" title="OAuth 시작 실패">{oauth.error.message}</Notice>}
            {add.error && <Notice tone="error" title="연결 실패">{add.error.message}</Notice>}
          </>
        )}
      </div>
    </Modal>
  );
}

function CredentialInput({
  field,
  value,
  onChange,
}: {
  field: CredentialField;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `cred-${field.key}`;
  return (
    <Field label={field.label} required={field.required} htmlFor={id} hint={field.secret ? '비밀 값 · 저장 후 표시되지 않음' : undefined}>
      {field.multiline ? (
        <textarea id={id} className="textarea" value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} spellCheck={false} />
      ) : (
        <input
          id={id}
          className="input mono"
          type={field.secret ? 'password' : 'text'}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
        />
      )}
    </Field>
  );
}
