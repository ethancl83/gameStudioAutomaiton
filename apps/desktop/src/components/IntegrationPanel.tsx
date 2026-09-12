// 게임 내 광고/결제 SDK 연동 패널(루트가 백엔드 구현, 여기서는 소비자).
// - 원본 보존·변경 미리보기(파일/이유/해시)·충돌·되돌리기를 그대로 보여 준다.
// - 선택하는 광고 단위/상품은 저장된 ExternalResource.id다(임의 경로·비밀 아님).
// - '설치됨'과 '게임 런타임 연결됨(wired)'을 구분한다. 런타임 검증 체크박스는 두지 않는다.
// - 백엔드 라우트가 아직 없으면(준비 중) 정직하게 안내하고 조작을 막는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, PlugZap, RotateCcw, Puzzle } from 'lucide-react';
import { api, type ProjectIntegrationState } from '../api';
import type { Connection, ExternalResource, Provider } from '../../../../packages/domain';
import type {
  IntegrationApplyResult,
  IntegrationFinding,
  IntegrationPlatform,
  IntegrationPreview,
  IntegrationProvider,
  WiringStatus,
} from '../../../../packages/project-integration/types';
import { Badge, Card, Field, Notice, Spinner } from './ui';

const PROVIDERS: { id: IntegrationProvider; label: string; kind: 'ad-unit' | 'product'; conn: Provider }[] = [
  { id: 'admob', label: 'AdMob 광고', kind: 'ad-unit', conn: 'admob' },
  { id: 'applovin-max', label: 'AppLovin MAX 광고', kind: 'ad-unit', conn: 'applovin-max' },
  { id: 'play-billing', label: 'Google Play 결제', kind: 'product', conn: 'google-play' },
  { id: 'app-store', label: 'App Store 결제', kind: 'product', conn: 'app-store' },
];

const WIRING_TONE: Record<WiringStatus, 'ok' | 'warn' | 'error' | 'neutral'> = {
  wired: 'ok',
  installed_unwired: 'warn',
  missing: 'neutral',
  conflict: 'error',
  unsupported: 'neutral',
};
const WIRING_LABEL: Record<WiringStatus, string> = {
  wired: '연결됨',
  installed_unwired: '설치됨·미연결',
  missing: '없음',
  conflict: '충돌',
  unsupported: '미지원',
};

export function IntegrationPanel({
  projectId,
  connections,
  resources,
}: {
  projectId: string;
  connections: Connection[];
  resources: ExternalResource[];
}) {
  const demo = api.isDemo();
  const [data, setData] = useState<ProjectIntegrationState | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'pending' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<IntegrationProvider>('admob');
  const [platform, setPlatform] = useState<IntegrationPlatform>('android');
  const [connectionId, setConnectionId] = useState('');
  const [appId, setAppId] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | 'preview' | 'apply' | 'rollback'>(null);
  const [actionMsg, setActionMsg] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const mounted = useRef(true);

  const spec = PROVIDERS.find((p) => p.id === providerId)!;
  const eligibleConnections = useMemo(
    () => connections.filter((c) => c.provider === spec.conn),
    [connections, spec.conn],
  );
  // 백엔드는 이 프로젝트에 속하고(선택한 계정의) 확인된 자원만 허용한다.
  // 따라서 종류·공급자뿐 아니라 projectId와 선택 계정으로도 걸러 잘못된 조합을 원천 차단한다.
  const eligibleResources = useMemo(
    () =>
      resources.filter(
        (r) =>
          r.kind === spec.kind &&
          r.provider === spec.conn &&
          r.projectId === projectId &&
          r.status !== 'deleted' &&
          (connectionId ? r.connectionId === connectionId : true),
      ),
    [resources, spec.kind, spec.conn, projectId, connectionId],
  );

  const load = useCallback(async () => {
    const res = await api.getIntegration(projectId);
    if (!mounted.current) return;
    if (res.ok) {
      setData(res.data);
      setPhase('ready');
    } else if (['path_not_allowed', 'not_found', 'NOT_FOUND'].includes(res.error.code)) {
      setPhase('pending');
    } else {
      setErrorMsg(res.error.message);
      setPhase('error');
    }
  }, [projectId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // 공급자 변경 시 계정을 재선택한다(자원 종류·계정이 달라진다).
  useEffect(() => {
    setConnectionId(eligibleConnections[0]?.id ?? '');
  }, [providerId, eligibleConnections]);
  // 공급자·계정이 바뀌면 선택한 자원을 초기화한다(다른 조합의 자원은 서버가 거부한다).
  useEffect(() => {
    setSelectedIds([]);
  }, [providerId, connectionId]);

  const toggleId = (id: string) =>
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const runPreview = useCallback(async () => {
    setBusy('preview');
    setActionMsg(null);
    const res = await api.previewIntegration(projectId, {
      provider: providerId,
      platform,
      connectionId,
      appId: appId.trim() || undefined,
      adUnitIds: spec.kind === 'ad-unit' ? selectedIds : undefined,
      productIds: spec.kind === 'product' ? selectedIds : undefined,
    });
    if (!mounted.current) return;
    if (res.ok) await load();
    else setActionMsg({ tone: 'error', text: res.error.message });
    setBusy(null);
  }, [projectId, providerId, platform, connectionId, appId, selectedIds, spec.kind, load]);

  const runApply = useCallback(
    async (previewId: string) => {
      setBusy('apply');
      setActionMsg(null);
      const res = await api.applyIntegration(projectId, { previewId });
      if (!mounted.current) return;
      if (res.ok)
        setActionMsg({
          tone: res.data.status === 'applied' ? 'ok' : res.data.status === 'conflict' ? 'warn' : 'error',
          text:
            res.data.status === 'applied'
              ? '연동 변경을 적용했습니다. 게임 코드에서 초기화·표시 연결을 확인하세요.'
              : `적용 상태: ${res.data.status}`,
        });
      else setActionMsg({ tone: 'error', text: res.error.message });
      await load();
      setBusy(null);
    },
    [projectId, load],
  );

  const runRollback = useCallback(
    async (applyId: string) => {
      setBusy('rollback');
      setActionMsg(null);
      const res = await api.rollbackIntegration(projectId, { applyId });
      if (!mounted.current) return;
      if (res.ok) setActionMsg({ tone: 'ok', text: `되돌리기: ${res.data.status}` });
      else setActionMsg({ tone: 'error', text: res.error.message });
      await load();
      setBusy(null);
    },
    [projectId, load],
  );

  if (phase === 'loading') {
    return (
      <Card title="게임 내 광고·결제 연동" icon={Puzzle}>
        <div className="row" style={{ gap: 8 }}>
          <Spinner /> 연동 상태를 확인하는 중…
        </div>
      </Card>
    );
  }
  if (phase === 'pending') {
    return (
      <Card title="게임 내 광고·결제 연동" icon={Puzzle}>
        <Notice tone="info" title="연동 기능 준비 중">
          광고·결제 SDK 연동 백엔드가 아직 연결되지 않았습니다. 준비되면 이 화면에서 탐지·미리보기·적용·되돌리기를 사용할
          수 있습니다.
        </Notice>
      </Card>
    );
  }
  if (phase === 'error' || !data) {
    return (
      <Card title="게임 내 광고·결제 연동" icon={Puzzle}>
        <Notice tone="error">{errorMsg ?? '연동 상태를 불러오지 못했습니다.'}</Notice>
      </Card>
    );
  }

  const latestPreview = data.previews[0] ?? null;

  return (
    <Card title="게임 내 광고·결제 연동" icon={Puzzle}>
      <div className="stack">
        {data.recoveryRequired && <Notice tone="error" title="SDK 변경 복구 필요">
          {data.recoveryRequired.reason}
          {data.recoveryRequired.applyId && <button className="btn btn--sm" disabled={Boolean(busy)} onClick={() => void runRollback(data.recoveryRequired!.applyId!)}>보존한 원본으로 복구</button>}
        </Notice>}
        <DetectionSummary data={data} />

        <div className="stack" style={{ gap: 10, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>연동 미리보기 만들기</h3>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Field label="공급자" htmlFor="int-provider">
              <select id="int-provider" value={providerId} onChange={(e) => setProviderId(e.target.value as IntegrationProvider)}>
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="플랫폼" htmlFor="int-platform">
              <select id="int-platform" value={platform} onChange={(e) => setPlatform(e.target.value as IntegrationPlatform)}>
                <option value="android">Android</option>
                <option value="ios">iOS</option>
              </select>
            </Field>
            <Field label="계정" htmlFor="int-conn" hint={eligibleConnections.length === 0 ? '해당 공급자 계정을 먼저 연결하세요.' : undefined}>
              <select id="int-conn" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                <option value="">계정 선택</option>
                {eligibleConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field
            label={spec.kind === 'ad-unit' ? '광고 앱 ID(공개 ID, 선택)' : '앱/번들 ID(선택)'}
            htmlFor="int-appid"
            hint="비밀 키가 아닙니다. MAX SDK 키는 런타임에 바인딩되며 여기서 입력하지 않습니다."
          >
            <input id="int-appid" type="text" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="예: ca-app-pub-…" />
          </Field>

          <ResourceSelector
            kind={spec.kind}
            resources={eligibleResources}
            selectedIds={selectedIds}
            onToggle={toggleId}
          />

          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn btn--sm btn--primary"
              onClick={() => void runPreview()}
              disabled={busy !== null || !connectionId}
            >
              {busy === 'preview' ? <Spinner /> : <FileCode2 size={14} />} 미리보기 생성
            </button>
            {demo && <span className="muted">데모: 합성 프로젝트에 대한 미리보기입니다.</span>}
          </div>
        </div>

        {actionMsg && <Notice tone={actionMsg.tone === 'ok' ? 'info' : actionMsg.tone}>{actionMsg.text}</Notice>}

        {latestPreview && (
          <PreviewDetail
            preview={latestPreview}
            busy={busy}
            onApply={() => void runApply(latestPreview.previewId)}
          />
        )}

        {data.applications.length > 0 && (
          <AppliedList applications={data.applications} busy={busy} onRollback={(id) => void runRollback(id)} />
        )}
      </div>
    </Card>
  );
}

function DetectionSummary({ data }: { data: ProjectIntegrationState }) {
  const { detection } = data;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge tone="neutral">엔진: {detection.engine}</Badge>
        <span className="muted">
          탐지된 SDK {detection.sdks.length}개{detection.sdks.length ? `: ${detection.sdks.map((s) => s.id).join(', ')}` : ''}
        </span>
      </div>
      <FindingList findings={detection.findings} />
    </div>
  );
}

function ResourceSelector({
  kind,
  resources,
  selectedIds,
  onToggle,
}: {
  kind: 'ad-unit' | 'product';
  resources: ExternalResource[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  const title = kind === 'ad-unit' ? '광고 단위' : '상품';
  if (resources.length === 0) {
    return (
      <Notice tone="info">
        연결·동기화된 {title}이(가) 없습니다. 수익화 화면에서 {title} 목록을 먼저 동기화하세요. 임의 값은 입력할 수 없습니다.
      </Notice>
    );
  }
  return (
    <fieldset className="stack" style={{ gap: 6, border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
      <legend className="muted" style={{ padding: '0 6px' }}>
        연결할 {title} 선택(동기화된 항목만)
      </legend>
      {resources.map((r) => (
        <label key={r.id} className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={selectedIds.includes(r.id)} onChange={() => onToggle(r.id)} />
          <span>{r.name}</span>
          <code className="muted">{r.externalId}</code>
        </label>
      ))}
    </fieldset>
  );
}

function PreviewDetail({
  preview,
  busy,
  onApply,
}: {
  preview: IntegrationPreview;
  busy: string | null;
  onApply: () => void;
}) {
  return (
    <div className="stack" style={{ gap: 10, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>미리보기</h3>
        <Badge tone={preview.supported ? 'ok' : 'warn'}>{preview.supported ? '지원됨' : '미지원'}</Badge>
        <span className="muted">엔진 {preview.engine} · {preview.platform} · {preview.provider}</span>
      </div>

      {preview.catalog.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="muted">의존성 카탈로그</span>
          {preview.catalog.map((c) => (
            <div key={c.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <code>{c.artifact}</code>
              <Badge tone="neutral">{c.version}</Badge>
              <span className="muted">{c.kind}</span>
              <a href={c.source} target="_blank" rel="noreferrer" className="muted">
                출처
              </a>
            </div>
          ))}
        </div>
      )}

      {preview.plannedChanges.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="muted">계획된 파일 변경(원본 보존, 적용 전)</span>
          {preview.plannedChanges.map((c, i) => (
            <div key={`${c.path}-${i}`} className="stack" style={{ gap: 2, padding: '6px 8px', background: 'var(--surface-2, rgba(0,0,0,0.04))', borderRadius: 6 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Badge tone={c.action === 'create' ? 'ok' : c.action === 'patch' ? 'warn' : 'neutral'}>{c.action}</Badge>
                <code>{c.path}</code>
              </div>
              <span className="muted">{c.reason}</span>
              {c.contentHash && <code className="muted" style={{ fontSize: 11 }}>hash {c.contentHash.slice(0, 16)}…</code>}
            </div>
          ))}
        </div>
      )}

      <WiringList wiring={preview.wiring} />
      <FindingList findings={preview.findings} />

      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        적용은 코드·의존성을 설치·연결합니다. 이는 <strong>설치·연결(wired)</strong> 상태이며, 게임 실행 중 실제 광고·구매
        이벤트가 동작하는 <strong>런타임 검증</strong>과는 다릅니다.
      </p>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn--sm btn--primary" onClick={onApply} disabled={!preview.supported || busy !== null}>
          {busy === 'apply' ? <Spinner /> : <PlugZap size={14} />} 이 미리보기 적용
        </button>
      </div>
    </div>
  );
}

function AppliedList({
  applications,
  busy,
  onRollback,
}: {
  applications: IntegrationApplyResult[];
  busy: string | null;
  onRollback: (applyId: string) => void;
}) {
  return (
    <div className="stack" style={{ gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>적용 이력</h3>
      {applications.map((a) => (
        <div key={a.applyId} className="stack" style={{ gap: 4, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={a.status === 'applied' ? 'ok' : a.status === 'conflict' ? 'warn' : 'error'}>{a.status}</Badge>
            <span className="muted">파일 {a.filesWritten.length}개</span>
            {a.status === 'applied' && (
              <button
                className="btn btn--xs"
                style={{ marginLeft: 'auto' }}
                onClick={() => onRollback(a.applyId)}
                disabled={busy !== null}
              >
                {busy === 'rollback' ? <Spinner /> : <RotateCcw size={13} />} 되돌리기
              </button>
            )}
          </div>
          <WiringList wiring={a.wiring} />
          <FindingList findings={a.findings} />
        </div>
      ))}
    </div>
  );
}

function WiringList({ wiring }: { wiring: IntegrationPreview['wiring'] }) {
  if (!wiring || wiring.length === 0) return null;
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {wiring.map((w) => (
        <Badge key={w.event} tone={WIRING_TONE[w.status]}>
          {w.event}: {WIRING_LABEL[w.status]}
        </Badge>
      ))}
    </div>
  );
}

function FindingList({ findings }: { findings: IntegrationFinding[] }) {
  if (!findings || findings.length === 0) return null;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {findings.map((f, i) => (
        <div key={`${f.code}-${i}`} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
          <Badge tone={f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warn' : 'neutral'}>{f.severity}</Badge>
          <span>
            {f.message}
            {f.fixHint && <span className="muted"> — {f.fixHint}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
