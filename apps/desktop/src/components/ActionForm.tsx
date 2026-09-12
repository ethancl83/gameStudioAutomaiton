// 공급자 액션 실행 폼. 사용자에게 필요한 사업 입력만 노출한다.
// - 외부 쓰기는 사용자 작업 단위 idempotencyKey를 보존해 응답 유실 재시도 시 이중 반영을 막는다.
// - 예산 변경은 프로젝트 정책 한도로 사전 검증한다.
// - 결과 Run 상태를 서버가 보고한 그대로 보여준다(성공을 임의로 표시하지 않음).
import { useMemo, useRef, useState } from 'react';
import { PlayCircle, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import { majorToMicros, microsToMajor, operationLabel } from '../format';
import { newIdempotencyKey, useAction } from '../useAction';
import { buildOperationInput, mergeOperationFields, specFor, type OpField } from '../operations';
import { Field, Modal, Notice, Spinner } from './ui';
import { RunStatusBadge } from './status';
import { ArtifactPicker } from './ArtifactPicker';
import { MediaPicker } from './MediaPicker';
import type { AppState, Capability, Connection, Run } from '../../../../packages/domain';

export function ActionForm({
  connection,
  operation,
  state,
  refresh,
  onClose,
  presetExternalId,
  presetProjectId,
  capability,
}: {
  connection: Connection;
  operation: string;
  state: AppState;
  refresh: () => Promise<void>;
  onClose: () => void;
  presetExternalId?: string;
  presetProjectId?: string;
  capability?: Capability;
}) {
  const spec = specFor(operation, connection.provider);
  const act = useAction<Run>(refresh);
  // 이 사용자 작업(모달 인스턴스) 동안 같은 멱등 키를 유지한다.
  const idempotencyKey = useRef(newIdempotencyKey());

  // upload-build 의 track 기본값은 internal.
  const [values, setValues] = useState<Record<string, string>>(
    operation === 'upload-build' ? { track: 'internal' } : {},
  );
  const [projectId, setProjectId] = useState<string>(presetProjectId ?? '');
  const [externalId, setExternalId] = useState<string>(presetExternalId ?? '');
  const [buildRunId, setBuildRunId] = useState<string>('');
  const [importedArtifactId,setImportedArtifactId]=useState('');
  const [artifactTarget,setArtifactTarget]=useState(connection.provider==='google-play'?'android':connection.provider==='app-store'?'ios':'windows');
  const [mediaAssetId, setMediaAssetId] = useState('');

  const project = projectId ? state.projects.find((p) => p.id === projectId) ?? null : null;
  // 공급자·작업별 필드 재정의(컨트롤러가 capability.operationFields로 전달)를 공통 스키마 위에 병합한다.
  // 컨트롤러가 보내지 않으면 undefined → 공통 스키마 그대로 사용한다.
  const overrideFields = capability?.operationFields?.[operation];
  const fields = useMemo(() => mergeOperationFields(spec.fields, overrideFields), [spec.fields, overrideFields]);
  // 조건부 필드(showIf)는 현재 값에 따라 표시/전송한다. 숨겨진 필드는 필수검사·전송에서 제외.
  // externalId는 대상 선택기가 공급하므로 입력 필드로 렌더링하지 않는다(중복 방지).
  const hasMoneyFields = fields.some(field => field.type === 'money');
  const visibleFields = fields.filter((f) => f.key !== 'externalId' && !(hasMoneyFields && f.key === 'currency') && (!f.showIf || f.showIf(values)));
  const hasMoney = visibleFields.some((f) => f.type === 'money');
  const defaultCurrency = project?.policy.currency ?? 'USD';
  const [currency, setCurrency] = useState(defaultCurrency);

  // 대상 리소스(update/pause 등) 후보.
  const resourceOptions = useMemo(() => {
    if (!spec.targetKind) return [];
    return state.resources.filter((r) => r.connectionId === connection.id && r.kind === spec.targetKind && (!projectId || r.projectId === projectId));
  }, [spec.targetKind, state.resources, connection.id, projectId]);

  // upload-build: 선택한 프로젝트의 성공한 빌드 작업 후보.
  const buildRunOptions = useMemo(() => {
    if (operation !== 'upload-build' || !projectId) return [];
    return state.runs.filter((r) => r.projectId === projectId && r.kind.includes('build') && r.status === 'succeeded');
  }, [operation, projectId, state.runs]);

  // 정책 게이트: 프로젝트가 선택되면 쓰기 허용 여부를 검사한다.
  const policyBlock = useMemo(() => {
    if (!spec.externalWrite || !project) return null;
    const isCampaign = ['google-ads','applovin-ads'].includes(connection.provider);
    const isMonetization = operation.includes('product') || operation.includes('ad-unit');
    if (isCampaign && !project.policy.allowCampaignWrites) {
      return '선택한 프로젝트의 정책에서 캠페인 변경이 허용되지 않았습니다. 프로젝트 실행 정책에서 허용하세요.';
    }
    if (isMonetization && !project.policy.allowMonetizationWrites) {
      return '선택한 프로젝트의 정책에서 수익화 변경이 허용되지 않았습니다. 프로젝트 실행 정책에서 허용하세요.';
    }
    return null;
  }, [spec.externalWrite, project, operation, connection.provider]);

  // 예산 한도 검증.
  const budgetError = useMemo(() => {
    if (!spec.budgetField) return null;
    const raw = values[spec.budgetField];
    if (!raw || raw.trim() === '') return null;
    const micros = majorToMicros(raw);
    if (micros === null) return '예산 금액 형식이 올바르지 않습니다.';
    if (project) {
      const limit = project.policy.maxDailyBudgetMicros;
      if (limit && limit !== '0') {
        try {
          if (BigInt(micros) > BigInt(limit)) {
            return `프로젝트 정책 일일 한도(${microsToMajor(limit)} ${project.policy.currency})를 초과합니다.`;
          }
        } catch {
          /* ignore */
        }
      } else {
        return '프로젝트 정책에 일일 예산 한도가 설정되지 않았습니다. 먼저 정책에서 한도를 저장하세요.';
      }
    }
    return null;
  }, [spec.budgetField, values, project]);

  function setField(key: string, v: string) {
    setValues((s) => ({ ...s, [key]: v }));
  }

  const missingRequired =
    (hasMoney && !/^[A-Z]{3}$/.test(currency)) ||
            visibleFields.some((f) => f.required && !(values[f.key] ?? '').trim()) ||
    (spec.needsProject === 'required' && !projectId) ||
    (!!spec.targetKind && !externalId) ||
    // upload-build: 검증된 빌드 산출물(buildRunId)을 반드시 선택한다(임의 경로 불가).
    (operation === 'upload-build' && !buildRunId && !importedArtifactId) ||
    (operation === 'upload-listing-image' && !mediaAssetId);

  const blocked = !!policyBlock || !!budgetError || missingRequired;

  function buildInput(): Record<string, unknown> {
    return { ...buildOperationInput(visibleFields, values, {
      currency: hasMoney ? currency : undefined,
      externalId: externalId || undefined,
      buildRunId: buildRunId || undefined,
    }), ...(mediaAssetId ? {mediaAssetId} : {}), ...(importedArtifactId?{importedArtifactId}:{}) };
  }

  async function submit() {
    if (blocked) return;
    await act.run(() =>
      api.runAction(connection.id, {
        operation,
        projectId: projectId || undefined,
        input: buildInput(),
        // 조회 전용 작업에는 멱등 키를 붙이지 않는다.
        idempotencyKey: spec.externalWrite ? idempotencyKey.current : undefined,
      }),
    );
  }

  const done = act.result ? state.runs.find(run => run.id === act.result!.id) ?? act.result : null;

  return (
    <Modal
      title={operationLabel(operation)}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {done ? '닫기' : '취소'}
          </button>
          {!done && (
            <button className="btn btn--primary" onClick={() => void submit()} disabled={act.pending || blocked}>
              {act.pending ? <Spinner /> : <PlayCircle size={15} />} 실행
            </button>
          )}
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <p className="small muted" style={{ margin: 0 }}>
          {spec.description}
        </p>

        {api.isDemo() && (
          <Notice tone="info" title="데모 실행">
            <span className="small">
              선택한 작업은 데모 데이터에 반영됩니다.
            </span>
          </Notice>
        )}

        {capability && capability.limitations.length > 0 && !done && (
          <details className="small muted">
            <summary style={{ cursor: 'pointer' }}>서비스별 지원 범위와 참고 사항</summary>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {capability.limitations.map((l, i) => (
                <li key={i} className="small">
                  {l}
                </li>
              ))}
            </ul>
          </details>
        )}

        {done ? (
          <ActionResult run={done} />
        ) : (
          <>
            {spec.needsProject && (
              <Field label="프로젝트" required={spec.needsProject === 'required'} htmlFor="act-project">
                <select
                  id="act-project"
                  className="select"
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value); setBuildRunId(''); setImportedArtifactId('');
                    setExternalId(''); setBuildRunId(''); setMediaAssetId('');
                    const p = state.projects.find((x) => x.id === e.target.value);
                    if (p) setCurrency(p.policy.currency);
                  }}
                >
                  <option value="">{spec.needsProject === 'required' ? '프로젝트 선택' : '연결 안 함'}</option>
                  {state.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {spec.targetKind && (
              <Field label="대상" required htmlFor="act-target">
                {resourceOptions.length === 0 ? (
                  <Notice tone="info">이 연결에 대상 리소스가 없습니다. 먼저 목록 조회로 가져오세요.</Notice>
                ) : (
                  <select id="act-target" className="select" value={externalId} onChange={(e) => setExternalId(e.target.value)}>
                    <option value="">대상 선택</option>
                    {resourceOptions.map((r) => (
                      <option key={r.id} value={r.externalId}>
                        {r.name} ({r.status})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            {operation === 'upload-build' && projectId && (
              <>
                {connection.provider==='steam'&&<Field label="결과물 플랫폼" htmlFor="artifact-target"><select id="artifact-target" className="select" value={artifactTarget} onChange={e=>{setArtifactTarget(e.target.value);setImportedArtifactId('');}}>{['windows','macos','linux'].map(target=><option key={target}>{target}</option>)}</select></Field>}
                <ArtifactPicker key={projectId+':'+artifactTarget} projectId={projectId} target={artifactTarget} assets={state.importedArtifacts??[]} value={importedArtifactId} onChange={id=>{setImportedArtifactId(id);setBuildRunId('');}} refresh={refresh} demo={state.runtime.mode==='demo'} />
                {buildRunOptions.length>0&&<details><summary className="small faint">기존 내부 빌드 이력에서 선택</summary>
                <Field label="업로드할 빌드" htmlFor="act-build" hint="이 프로젝트에서 성공한 빌드만 선택할 수 있습니다.">
                  {buildRunOptions.length === 0 ? (
                    <Notice tone="warn">이 프로젝트에 성공한 빌드가 없습니다. 외부 결과물을 가져와 주세요.</Notice>
                  ) : (
                    <select id="act-build" className="select" value={buildRunId} onChange={(e) => {setBuildRunId(e.target.value);setImportedArtifactId('');}}>
                      <option value="">빌드 선택</option>
                      {buildRunOptions.map((r) => {
                        const t = r.input.target;
                        const suffix = typeof t === 'string' ? ` · ${t}` : '';
                        return (
                          <option key={r.id} value={r.id}>
                            {(r.label || r.id) + suffix}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </Field>
                </details>}
                {buildRunId && project?.appIdentifier && (
                  <Notice tone="warn" title="앱 식별자 일치 확인">
                    선택한 빌드의 소스 프로젝트 앱 식별자(<span className="mono">{project.appIdentifier}</span>)가 이 스토어
                    연결의 앱과 같아야 합니다. 서버가 업로드 시 앱 번들 식별자를 대조하며, 다른 프로젝트의 빌드는 거부됩니다.
                  </Notice>
                )}
              </>
            )}

            {operation === 'upload-listing-image' && projectId && <MediaPicker key={projectId} projectId={projectId} assets={state.mediaAssets ?? []} value={mediaAssetId} onChange={setMediaAssetId} refresh={refresh} />}

            {visibleFields.map((f) => (
              <ActionFieldInput key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => setField(f.key, v)} currency={currency} />
            ))}

            {hasMoney && (
              <Field label="통화" htmlFor="act-currency">
                <input id="act-currency" className="input" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
              </Field>
            )}

            {policyBlock && (
              <Notice tone="error" title="정책에서 허용되지 않음">
                <span className="row" style={{ gap: 6 }}>
                  <ShieldAlert size={14} /> {policyBlock}
                </span>
              </Notice>
            )}
            {budgetError && <Notice tone="error" title="예산 검증">{budgetError}</Notice>}

            {spec.externalWrite && (
              <p className="small faint" style={{ margin: 0 }}>
                외부 쓰기 작업입니다. 응답이 유실되어도 같은 요청으로 재시도하며 중복 생성/증액을 방지합니다.
              </p>
            )}

            {act.error && <Notice tone="error" title="실행 실패">{act.error.message}</Notice>}
          </>
        )}
      </div>
    </Modal>
  );
}

function ActionFieldInput({
  field,
  value,
  onChange,
  currency,
}: {
  field: OpField;
  value: string;
  onChange: (v: string) => void;
  currency: string;
}) {
  const id = `act-f-${field.key}`;
  if (field.type === 'select') {
    return (
      <Field label={field.label} required={field.required} htmlFor={id} hint={field.hint}>
        <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">선택</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (field.type === 'textarea') {
    return (
      <Field label={field.label} required={field.required} htmlFor={id} hint={field.hint}>
        <textarea id={id} className="textarea" value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} />
      </Field>
    );
  }
  if (field.type === 'date') {
    return (
      <Field label={field.label} required={field.required} htmlFor={id} hint={field.hint}>
        <input id={id} className="input" type="date" value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }
  if (field.type === 'money') {
    return (
      <Field label={`${field.label} (${currency})`} required={field.required} htmlFor={id} hint={field.hint}>
        <input id={id} className="input" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} placeholder="0" />
      </Field>
    );
  }
  return (
    <Field label={field.label} required={field.required} htmlFor={id} hint={field.hint}>
      <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} />
    </Field>
  );
}

function ActionResult({ run }: { run: Run }) {
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <RunStatusBadge status={run.status} />
        <span className="small muted">{run.label || run.kind}</span>
      </div>
      {run.status === 'waiting_external' && (
        <Notice tone="info">외부 처리 결과를 기다립니다. 이력에서 진행 상황을 확인하세요.</Notice>
      )}
      {run.status === 'action_required' && (
        <Notice tone="warn" title="사용자 조치 필요">
          결과가 확정되지 않았습니다. 임의 재시도 대신 이력에서 상태를 확인하고 필요한 조치를 완료하세요.
        </Notice>
      )}
      {run.error && <Notice tone="error" title="실패 원인">{run.error}</Notice>}
      <p className="small muted" style={{ margin: 0 }}>
        작업이 생성되었습니다. 이력 화면에서 로그와 최종 상태를 확인할 수 있습니다.
      </p>
    </div>
  );
}
