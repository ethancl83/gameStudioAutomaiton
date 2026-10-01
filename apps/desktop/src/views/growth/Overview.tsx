// 개요: 통계·신선도 정책, 위임, ROAS/순이익 ROI 성과, 공급자 실험 지원 수준.
import { useId, useState } from 'react';
import { BarChart3, Gauge, Save, ShieldAlert } from 'lucide-react';
import type { Provider } from '../../../../../packages/domain';
import type { CapabilityLevel, DataQuality, GrowthPolicy, ProviderExperimentCapability } from '../../../../../packages/growth/types';
import { formatDateTime, formatMicros, providerLabel } from '../../format';
import { Badge, Card, EmptyState, Field, Modal, Notice } from '../../components/ui';
import { ActionFeedback, BASIS_LABELS, Dl, ReasonList, connectionLabel, intInput, pct, percentInput, ratioToPercentText, useGrowthAction, type SectionProps, type Tone } from './shared';
import { MandatesCard } from './Mandates';

export function OverviewSection(props: SectionProps) {
  const policy = props.growth.policies.find(item => item.projectId === props.projectId);
  return <>
    <MandatesCard {...props} />
    <PerformanceCard {...props} />
    <PolicyCard key={`${props.projectId}:${policy?.version ?? 0}`} {...props} policy={policy} />
    <CapabilitiesCard {...props} />
  </>;
}

function projectProviders({ state, projectId }: SectionProps, policy?: GrowthPolicy): Provider[] {
  const project = state.projects.find(item => item.id === projectId);
  const ids = new Set([...(project?.policy.allowedConnectionIds ?? []), ...(project?.socialPolicy?.connectionIds ?? [])]);
  const providers = new Set<Provider>(state.connections.filter(conn => ids.has(conn.id)).map(conn => conn.provider));
  for (const key of Object.keys(policy?.freshnessHours ?? {})) providers.add(key as Provider);
  return [...providers];
}

function PolicyCard(props: SectionProps & { policy?: GrowthPolicy }) {
  const { policy, projectId, reload } = props;
  const uid = useId();
  const act = useGrowthAction(reload);
  const providers = projectProviders(props, policy);
  const [alpha, setAlpha] = useState(policy ? String(policy.alpha) : '');
  const [multiplicity, setMultiplicity] = useState<GrowthPolicy['multiplicity'] | ''>(policy?.multiplicity ?? '');
  const [stopping, setStopping] = useState<GrowthPolicy['defaultStopping'] | ''>(policy?.defaultStopping ?? '');
  const [freshness, setFreshness] = useState<Record<string, string>>(Object.fromEntries(Object.entries(policy?.freshnessHours ?? {}).map(([key, value]) => [key, String(value)])));
  const [currency, setCurrency] = useState(policy?.reportingCurrency ?? '');
  const [fxSource, setFxSource] = useState(policy?.fxSource ?? '');
  const [fxAge, setFxAge] = useState(policy ? String(policy.fxMaxAgeHours) : '');
  const [variable, setVariable] = useState(policy ? ratioToPercentText(policy.variableCostRate) : '');
  const [pricing, setPricing] = useState<'yes' | 'no' | ''>(policy ? policy.allowPricingExperiments ? 'yes' : 'no' : '');
  const ready = alpha && multiplicity && stopping && fxAge && variable && pricing;
  const f = (name: string) => `${uid}-${name}`;
  function save() {
    const freshnessHours = Object.fromEntries(Object.entries(freshness).filter(([, value]) => value.trim()).map(([key, value]) => [key, intInput(value)]));
    void act.run('save-policy', {
      projectId, alpha: Number(alpha), multiplicity, defaultStopping: stopping, freshnessHours,
      ...(currency.trim() ? { reportingCurrency: currency.trim().toUpperCase() } : {}), ...(fxSource.trim() ? { fxSource: fxSource.trim() } : {}),
      fxMaxAgeHours: intInput(fxAge), variableCostRate: percentInput(variable), allowPricingExperiments: pricing === 'yes',
    }, '정책을 저장했습니다. 대기 중인 결정은 새 정책 버전으로 다시 평가합니다.');
  }
  return <Card title="통계·신선도 정책" icon={Gauge} actions={policy && <span className="small muted">v{policy.version} · {formatDateTime(policy.updatedAt)}</span>}>
    <form className="stack" onSubmit={event => { event.preventDefault(); if (ready) save(); }}>
      <p className="small muted" style={{ margin: 0 }}>이 값들은 앱이 정한 기본값이 아니라 사용자가 확정하는 정책입니다. 저장할 때마다 버전이 올라가며, 확정 전 위임안은 정책이 바뀌면 다시 만들어야 합니다. 빈 칸을 임의 값으로 채우지 않습니다.</p>
      {!policy && <Notice tone="info">아직 정책이 없습니다. 모든 필수 값을 직접 정해 저장하세요.</Notice>}
      <div className="grid grid--split">
        <Field label="유의수준 α" required htmlFor={f('alpha')} hint="0.001~0.2. 작을수록 승자 판정이 엄격합니다."><input id={f('alpha')} className="input" type="number" step="0.001" min={0.001} max={0.2} value={alpha} onChange={event => setAlpha(event.target.value)} /></Field>
        <Field label="다중 비교 보정" required htmlFor={f('mult')} hint="Holm: 가족 전체 오류율(FWER) 통제·보수적 / BH: 거짓 발견율(FDR) 통제·완화적">
          <select id={f('mult')} className="select" value={multiplicity} onChange={event => setMultiplicity(event.target.value as GrowthPolicy['multiplicity'])}><option value="">선택</option><option value="holm">Holm</option><option value="bh">Benjamini–Hochberg</option></select>
        </Field>
        <Field label="기본 중지 규칙" required htmlFor={f('stop')} hint="고정 기간: 종료 시점에 한 번 판정 / 순차 검정: 사전 등록한 look 시각마다 alpha-spending 경계로 판정">
          <select id={f('stop')} className="select" value={stopping} onChange={event => setStopping(event.target.value as GrowthPolicy['defaultStopping'])}><option value="">선택</option><option value="fixed_horizon">고정 기간(fixed horizon)</option><option value="sequential">순차 검정(sequential)</option></select>
        </Field>
        <Field label="가격 실험 허용" required htmlFor={f('pricing')} hint="허용해도 위임의 가격 변경 범위가 없으면 가격을 바꾸지 않습니다.">
          <select id={f('pricing')} className="select" value={pricing} onChange={event => setPricing(event.target.value as 'yes' | 'no')}><option value="">선택</option><option value="no">허용하지 않음</option><option value="yes">허용</option></select>
        </Field>
        <Field label="보고 통화" htmlFor={f('cur')} hint="비우면 통화별로 따로 보고하고 합산하지 않습니다."><input id={f('cur')} className="input" maxLength={3} value={currency} onChange={event => setCurrency(event.target.value)} /></Field>
        <Field label="환율 출처" htmlFor={f('fx')} hint="비우면 다른 통화를 환산·합산하지 않습니다."><input id={f('fx')} className="input" maxLength={100} value={fxSource} onChange={event => setFxSource(event.target.value)} /></Field>
        <Field label="환율 허용 기간(시간)" required htmlFor={f('fxage')} hint="이보다 오래된 환율은 사용하지 않습니다."><input id={f('fxage')} className="input" type="number" min={1} max={744} value={fxAge} onChange={event => setFxAge(event.target.value)} /></Field>
        <Field label="가변비용 비율(%)" required htmlFor={f('var')} hint="0~90%. 원천이 이미 차감한 스토어·결제 수수료는 넣지 마세요(이중 차감)."><input id={f('var')} className="input" type="number" step="0.01" min={0} max={90} value={variable} onChange={event => setVariable(event.target.value)} /></Field>
      </div>
      <fieldset className="action-group"><legend className="action-group__title">원천별 허용 지연(시간) — 넘으면 stale로 보고 증액을 막습니다</legend>
        {providers.length === 0 ? <span className="small muted">프로젝트 정책이 허용한 연결이 없습니다.</span> : <div className="grid grid--stats">
          {providers.map(provider => <Field key={provider} label={providerLabel(provider)} htmlFor={f(`fr-${provider}`)}><input id={f(`fr-${provider}`)} className="input" type="number" min={1} max={1440} value={freshness[provider] ?? ''} onChange={event => setFreshness(current => ({ ...current, [provider]: event.target.value }))} /></Field>)}
        </div>}
      </fieldset>
      <div className="row"><button type="submit" className="btn btn--primary" disabled={!ready || !!act.pending}><Save size={14} />정책 저장</button>{!ready && <span className="small muted">필수 값을 모두 정해야 저장할 수 있습니다.</span>}</div>
      <ActionFeedback act={act} />
    </form>
  </Card>;
}

export function QualityFlags({ quality }: { quality: DataQuality }) {
  const flags: Array<[boolean, string, string]> = [
    [quality.fresh, '신선함', '오래된 데이터'], [quality.sampleSufficient, '표본 충분', '표본 부족'], [quality.windowComplete, '귀속 창 완료', '귀속 창 미완료'],
    [quality.assignmentProven, '배정 증명', '배정 미증명'], [quality.currencyConsistent, '통화 일치', '통화 불일치'],
  ];
  return <div className="stack" style={{ gap: 4 }}>
    <div className="row" style={{ gap: 4 }}>{flags.map(([ok, good, bad]) => <Badge key={good} tone={ok ? 'ok' : 'warn'}>{ok ? good : bad}</Badge>)}</div>
    <ReasonList reasons={quality.reasons} />
  </div>;
}

function PerformanceCard({ growth, projectId }: SectionProps) {
  const reports = growth.performance.filter(item => item.projectId === projectId);
  return <Card title="성과: ROAS와 순이익 ROI" icon={BarChart3}>
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>ROAS와 순이익 ROI는 서로 대체하지 않는 별도 지표입니다. 기존 수익화 화면의 &lsquo;기여(수익−광고비)&rsquo;와도 다릅니다. 계산할 수 없는 값은 0이 아니라 미계산 사유로 표시합니다.</p>
      {reports.length === 0 ? <EmptyState icon={BarChart3} title="성과 보고가 없습니다" description="정책을 저장하고 광고·수익 데이터가 수집되면 통화·기준별 보고가 표시됩니다." />
        : <div className="grid grid--cards">{reports.map((report, index) => <div key={index} className="action-group">
          <div className="row row--between"><strong>{report.currency} · 귀속 {report.windowDays === 0 ? '공급자 기본 창' : `${report.windowDays}일`}</strong><span className="small muted">사실 {report.factIds.length}건</span></div>
          <div className="grid grid--split" style={{ gap: 10 }}>
            <div><div className="small muted">ROAS · 분자: {BASIS_LABELS[report.basis]}</div><div style={{ fontSize: 22, fontWeight: 650 }}>{report.roas === null ? '미계산' : pct(report.roas, 0)}</div>{report.roas === null && report.roasReason && <div className="small">{report.roasReason}</div>}</div>
            <div><div className="small muted">순이익 ROI · 고정비 제외</div><div style={{ fontSize: 22, fontWeight: 650 }}>{report.netRoi === null ? '미계산' : pct(report.netRoi, 1)}</div>{report.netRoi === null && report.netRoiReason && <div className="small">{report.netRoiReason}</div>}</div>
          </div>
          <Dl items={[
            ['광고비', formatMicros(report.spendMicros, report.currency)],
            ['귀속 수익(ROAS 분자)', formatMicros(report.attributedRevenueMicros, report.currency)],
            ['귀속 순수익', formatMicros(report.netProceedsMicros, report.currency)],
            ['가변비용', formatMicros(report.variableCostMicros, report.currency)],
          ]} />
          <QualityFlags quality={report.quality} />
          <details className="small"><summary>지표 정의</summary><p style={{ margin: '6px 0' }}><strong>ROAS</strong>: {report.definitions.roas}</p><p style={{ margin: 0 }}><strong>순이익 ROI</strong>: {report.definitions.netRoi}</p></details>
        </div>)}</div>}
    </div>
  </Card>;
}

const LEVEL_LABELS: Record<CapabilityLevel, [string, Tone]> = { unsupported: ['지원 안 함', 'neutral'], action_required: ['조치 필요', 'error'], read: ['읽기', 'info'], test_write: ['테스트 쓰기', 'progress'], write: ['쓰기', 'ok'] };
const VERIFY_LABELS: Record<ProviderExperimentCapability['verification'], [string, Tone]> = { fixture: ['미검증(fixture)', 'warn'], read_verified: ['읽기 검증', 'info'], test_verified: ['테스트 검증', 'progress'], live_verified: ['실계정 검증', 'ok'] };
const KIND_LABELS: Record<ProviderExperimentCapability['kind'], string> = { ads_native_experiment: '광고 native 실험', max_ad_unit_experiment: 'MAX 광고 단위 실험' };

/** 서버 규칙: 운영자 검증 기록으로 test_write 또는 write가 된 경우에만 native 실험 쓰기를 실행한다. */
const writable = (capability: ProviderExperimentCapability) => capability.level === 'test_write' || capability.level === 'write';

function CapabilitiesCard({ state, growth, reload }: SectionProps) {
  const rows = growth.capabilities;
  const act = useGrowthAction(reload);
  const [verifying, setVerifying] = useState<ProviderExperimentCapability | null>(null);
  return <Card title="공급자 실험 지원 수준" icon={ShieldAlert} flush>
    {rows.length === 0 ? <div style={{ padding: 16 }}><EmptyState icon={ShieldAlert} title="확인한 공급자 기능이 없습니다" description="위임 주기가 실행되면 연결별 실험 기능을 읽기 전용으로 점검해 기록합니다." /></div>
      : <div className="table__scroll"><table className="table">
        <caption className="sr-caption">공급자별 실험 기능·검증 수준</caption>
        <thead><tr><th>계정</th><th>기능</th><th>수준</th><th>검증</th><th>사유</th><th>확인 시각</th><th><span className="sr-caption">동작</span></th></tr></thead>
        <tbody>{rows.map(capability => { const enabled = writable(capability); return <tr key={`${capability.connectionId}:${capability.kind}`} style={enabled ? undefined : { opacity: 0.6 }} aria-disabled={!enabled}>
          <td>{connectionLabel(state, capability.connectionId)}<div className="small muted">{providerLabel(capability.provider)}</div></td>
          <td>{KIND_LABELS[capability.kind]}</td>
          <td><Badge tone={LEVEL_LABELS[capability.level][1]}>{LEVEL_LABELS[capability.level][0]}</Badge></td>
          <td><Badge tone={VERIFY_LABELS[capability.verification][1]}>{VERIFY_LABELS[capability.verification][0]}</Badge>{!enabled && <div className="small muted">{capability.level === 'read' ? '쓰기 비활성 — 조회만 가능. 시험 계정 검증을 기록해야 실험 쓰기가 열립니다' : '쓰기 비활성'}</div>}</td>
          <td><ReasonList reasons={capability.reasons} /></td>
          <td className="nowrap">{formatDateTime(capability.checkedAt)}</td>
          <td>{['read', 'test_write'].includes(capability.level) && <button className="btn btn--sm" onClick={() => setVerifying(capability)}>쓰기 검증 기록</button>}</td>
        </tr>; })}</tbody>
      </table></div>}
    <div style={{ padding: '0 16px 16px' }}>
      <p className="small muted" style={{ margin: '12px 0 0' }}>자동 점검은 조회까지만 확인합니다. 시험 계정에서 실험 생성·종료를 직접 확인한 뒤 근거를 기록해야 native 실험 쓰기가 열립니다. Google Ads App 캠페인 실험에는 promote가 없어 승자는 예산 단계 증액으로만 확대합니다.</p>
      <ActionFeedback act={act} />
    </div>
    {verifying && <VerifyCapability capability={verifying} label={connectionLabel(state, verifying.connectionId)} act={act} onClose={() => setVerifying(null)} />}
  </Card>;
}


function VerifyCapability({ capability, label, act, onClose }: { capability: ProviderExperimentCapability; label: string; act: ReturnType<typeof useGrowthAction>; onClose: () => void }) {
  const uid = useId();
  const [level, setLevel] = useState<'test_write' | 'write'>(capability.level === 'test_write' ? 'write' : 'test_write');
  const [evidence, setEvidence] = useState('');
  async function submit() {
    const result = await act.run('verify-capability', { connectionId: capability.connectionId, kind: capability.kind, level, evidence: evidence.trim() }, '공급자 실험 쓰기 검증 근거를 기록했습니다.');
    if (result) onClose();
  }
  return <Modal title={`쓰기 검증 기록 · ${label}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>취소</button><button className="btn btn--primary" disabled={!!act.pending || evidence.trim().length < 10} onClick={() => void submit()}>기록</button></>}>
    <div className="stack">
      <Notice tone="warn">{KIND_LABELS[capability.kind]}을(를) 실제로 만들고 종료해 본 경우에만 기록하세요. 기록하면 이 계정에서 해당 수준의 실험 쓰기가 허용됩니다.</Notice>
      <Field label="확인한 수준" required htmlFor={`${uid}-level`}><select id={`${uid}-level`} className="select" value={level} onChange={event => setLevel(event.target.value as 'test_write' | 'write')}>
        <option value="test_write">테스트 쓰기 — 시험 계정·캠페인에서 생성·종료 확인</option><option value="write">쓰기 — 실계정에서 최소 한도로 생성·종료 확인</option></select></Field>
      <Field label="검증 근거" required htmlFor={`${uid}-ev`} hint="10자 이상. 확인 일시·계정·실험 ID·종료 결과 등. 비밀값은 넣지 마세요."><textarea id={`${uid}-ev`} className="textarea" rows={4} maxLength={2000} value={evidence} onChange={event => setEvidence(event.target.value)} /></Field>
      {act.error && <Notice tone="error">{act.error}</Notice>}
    </div>
  </Modal>;
}
