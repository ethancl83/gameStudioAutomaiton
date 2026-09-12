// 수익화: 광고 단위·미디에이션, 상품·구독, 수익 집계. 지원 작업은 capability 기준.
// 수익은 통화별로 분리 표시하고 추정/확정을 구분한다. 통화를 환산 없이 합산하지 않는다.
import { BadgeDollarSign, PlugZap, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import { formatMicros } from '../format';
import { Card, EmptyState, Notice, Stat } from '../components/ui';
import { ConnectionResourcePanel, type PanelConfig } from '../components/ResourcePanel';
import { DailyMetrics } from '../components/DailyMetrics';
import type { ViewKey } from '../App';
import type { AppState, MetricsSummary } from '../../../../packages/domain';

const CONFIG: PanelConfig = {
  listOps: ['list-ad-units', 'list-products', 'sync'],
  createOps: ['create-ad-unit', 'create-product'],
  kinds: ['ad-unit', 'product'],
  rowOps: ['update-ad-unit', 'update-product'],
};

const RELEVANT = new Set([...CONFIG.listOps, ...CONFIG.createOps, ...CONFIG.rowOps].filter(op => op !== 'sync'));

export function MonetizationView({
  state,
  refresh,
  goTo,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
}) {
  const connections = state.connections.filter((c) => {
    const cap = state.capabilities.find((cp) => cp.provider === c.provider);
    return cap && cap.operations.some((op) => RELEVANT.has(op));
  });

  return (
    <div className="stack">
      <MetricsSection metrics={state.metrics} />

      <DailyMetrics facts={state.metricFacts ?? []} />

      {connections.length === 0 ? (
        <Card>
          <EmptyState
            icon={BadgeDollarSign}
            title="수익화 계정이 연결되지 않았습니다"
            description="AdMob·AppLovin MAX(광고 단위) 또는 스토어(상품·구독) 계정을 연결하면 수익화 설정을 관리할 수 있습니다."
            action={
              <button className="btn btn--primary" onClick={() => goTo('connections')}>
                <PlugZap size={15} /> 계정 연결로 이동
              </button>
            }
          />
        </Card>
      ) : (
        connections.map((conn) => (
          <ConnectionResourcePanel
            key={conn.id}
            connection={conn}
            cap={state.capabilities.find((cp) => cp.provider === conn.provider)}
            config={CONFIG}
            state={state}
            refresh={refresh}
          />
        ))
      )}
    </div>
  );
}

function MetricsSection({ metrics }: { metrics: MetricsSummary[] }) {
  if (metrics.length === 0) {
    return (
      <Card title="수익 집계" icon={Wallet}>
        <Notice tone="info">
          아직 수집된 집계 데이터가 없습니다. 값이 없는 항목은 0이 아니라 <strong>미수집</strong> 상태입니다. 계정을
          연결하고 동기화하면 통화별 수익·광고비가 표시됩니다.
        </Notice>
      </Card>
    );
  }
  return (
    <Card title="수익 집계 (통화별)" icon={Wallet}>
      <p className="small muted" style={{ margin: '0 0 12px' }}>
        기여이익 = 개발자 수익 − 광고비(같은 기준). 회계 순이익과 다르며, 통화가 다른 값은 합산하지 않습니다.
      </p>
      <div className="stack" style={{ gap: 18 }}>
        {metrics.map((m) => (
          <div key={m.currency}>
            <div className="section-title">
              {m.currency}
              {m.estimated && <span className="tag" style={{ marginLeft: 8 }}>추정 포함</span>}
            </div>
            <div className="grid grid--stats" style={{ marginTop: 8 }}>
              <Stat label="수익" value={formatMicros(m.revenueMicros, m.currency)} icon={TrendingUp} sub={m.estimated ? '추정치 포함' : '추정치 없음'} />
              <Stat label="광고비" value={formatMicros(m.spendMicros, m.currency)} icon={TrendingDown} />
              <Stat label="기여이익" value={formatMicros(m.contributionMicros, m.currency)} icon={Wallet} />
            </div>
            {m.warnings && m.warnings.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <Notice tone="warn" title="집계 주의">
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {m.warnings.map((w, i) => (
                      <li key={i} className="small">{w}</li>
                    ))}
                  </ul>
                </Notice>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
