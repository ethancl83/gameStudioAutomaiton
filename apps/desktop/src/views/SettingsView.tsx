// 환경·정책: 런타임, 보안 보관함, 도구 체인, 연동 기능(capabilities)을 표시한다.
// 실행 정책(자동화 범위)은 프로젝트별로 프로젝트 상세의 정책 탭에서 저장한다.
import {
  CheckCircle2,
  Cpu,
  ExternalLink,
  Info,
  Lock,
  ShieldAlert,
  Wrench,
  XCircle,
} from 'lucide-react';
import { api } from '../api';
import { CAPABILITY_CATEGORY_LABELS, formatDateTime, providerLabel } from '../format';
import { Badge, Card, Notice } from '../components/ui';
import { BuildKeysSection } from './BuildKeysSection';
import type { AppState, Capability } from '../../../../packages/domain';

export function SettingsView({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const { runtime, vault, toolchains, capabilities } = state;

  const byCategory = {
    store: capabilities.filter((c) => c.category === 'store'),
    marketing: capabilities.filter((c) => c.category === 'marketing'),
    monetization: capabilities.filter((c) => c.category === 'monetization'),
  };

  return (
    <div className="stack">
      <div className="grid grid--cards">
        <Card title="런타임" icon={Info}>
          <dl className="dl" style={{ gridTemplateColumns: '120px 1fr' }}>
            <dt>버전</dt>
            <dd className="mono">{runtime.version}</dd>
            <dt>플랫폼</dt>
            <dd className="mono">{runtime.platform}</dd>
            <dt>시작 시각</dt>
            <dd>{formatDateTime(runtime.startedAt)}</dd>
            <dt>데이터 폴더</dt>
            <dd className="mono small" style={{ wordBreak: 'break-all' }}>{runtime.dataDirectory}</dd>
            <dt>실행 환경</dt>
            <dd>{api.isElectron ? 'Electron 데스크톱' : '브라우저 개발 모드'}</dd>
          </dl>
        </Card>

        <Card title="보안 보관함" icon={Lock}>
          <div className="row" style={{ gap: 10, marginBottom: 10 }}>
            {vault.available ? <Badge tone="ok">사용 가능</Badge> : <Badge tone="error">사용 불가</Badge>}
            <span className="mono small">{vault.backend}</span>
          </div>
          {vault.available ? (
            <p className="small muted" style={{ margin: 0 }}>
              자격 증명은 OS 보관함 마스터키로 암호화되어 저장됩니다. 잠김/부재 시 정상 연결로 취급하지 않습니다.
            </p>
          ) : (
            <Notice tone="warn">
              <span className="row" style={{ gap: 6 }}>
                <ShieldAlert size={14} /> {vault.reason ?? '보관함을 사용할 수 없습니다. 새 계정 연결이 제한됩니다.'}
              </span>
            </Notice>
          )}
        </Card>
      </div>

      <BuildKeysSection state={state} refresh={refresh} />

      <Card title="도구 체인" icon={Wrench}>
        {toolchains.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>탐지된 빌드 도구가 없습니다. 도구를 설치하면 여기에 표시됩니다.</p>
        ) : (
          <div className="table__scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>도구</th>
                  <th>상태</th>
                  <th>버전</th>
                  <th>실행 파일</th>
                  <th>비고</th>
                </tr>
              </thead>
              <tbody>
                {toolchains.map((t) => (
                  <tr key={t.name}>
                    <td style={{ fontWeight: 550 }}>
                      <span className="row" style={{ gap: 6 }}>
                        <Cpu size={14} /> {t.name}
                      </span>
                    </td>
                    <td>
                      {t.available ? (
                        <span className="badge badge--ok"><CheckCircle2 size={12} /> 사용 가능</span>
                      ) : (
                        <span className="badge badge--neutral"><XCircle size={12} /> 미설치</span>
                      )}
                    </td>
                    <td className="mono small">{t.version ?? '—'}</td>
                    <td className="mono small truncate" title={t.executable ?? undefined}>{t.executable ?? '—'}</td>
                    <td className="small muted">{t.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="연동 기능">
        {capabilities.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>제어 서비스에서 연동 기능 정보를 아직 받지 못했습니다.</p>
        ) : (
          <div className="stack" style={{ gap: 20 }}>
            {(['store', 'marketing', 'monetization'] as const).map((cat) =>
              byCategory[cat].length === 0 ? null : (
                <div key={cat}>
                  <div className="section-title">{CAPABILITY_CATEGORY_LABELS[cat]}</div>
                  <div className="grid grid--cards" style={{ marginTop: 8 }}>
                    {byCategory[cat].map((c) => (
                      <CapabilityCard key={`${c.provider}-${c.name}`} cap={c} />
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function CapabilityCard({ cap }: { cap: Capability }) {
  return (
    <div className="card" style={{ boxShadow: 'none' }}>
      <div className="card__body">
        <div className="row row--between">
          <strong>{providerLabel(cap.provider)}</strong>
          <span className="tag">{cap.name}</span>
        </div>
        <p className="small muted" style={{ margin: '6px 0 10px' }}>{cap.description}</p>
        <div className="small" style={{ marginBottom: 8 }}>
          <span className="muted">인증: </span>
          {cap.authKind}
        </div>
        <div style={{ marginBottom: 8 }}>
          {cap.operations.map((op) => (
            <span className="tag" key={op}>{op}</span>
          ))}
        </div>
        {cap.limitations.length > 0 && (
          <ul className="small muted" style={{ margin: '8px 0 0', paddingLeft: 16 }}>
            {cap.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
        {cap.setupUrl && (
          <div style={{ marginTop: 10 }}>
            <button className="btn btn--sm" onClick={() => void api.openExternal(cap.setupUrl)}>
              <ExternalLink size={13} /> 설정 안내
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
