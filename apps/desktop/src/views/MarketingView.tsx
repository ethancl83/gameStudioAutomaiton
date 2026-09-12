// 마케팅: Google Ads·AppLovin 캠페인 조회·생성·수정·중지. 지원 작업은 capability 기준.
import { Megaphone, PlugZap } from 'lucide-react';
import { Card, EmptyState } from '../components/ui';
import { ConnectionResourcePanel, type PanelConfig } from '../components/ResourcePanel';
import type { ViewKey } from '../App';
import type { AppState } from '../../../../packages/domain';

const CONFIG: PanelConfig = {
  listOps: ['list-campaigns', 'list-creatives', 'sync'],
  createOps: ['create-campaign', 'create-creative'],
  kinds: ['campaign', 'creative'],
  rowOps: ['update-campaign', 'pause-campaign', 'update-creative', 'activate-creative'],
};

const RELEVANT = new Set([...CONFIG.listOps, ...CONFIG.createOps, ...CONFIG.rowOps].filter(op => op !== 'sync'));

export function MarketingView({
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

  if (connections.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Megaphone}
          title="마케팅 계정이 연결되지 않았습니다"
          description="Google Ads 또는 AppLovin 광고 계정을 연결하면 캠페인·소재·예산·성과를 관리할 수 있습니다."
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
      <p className="muted small" style={{ margin: 0 }}>
        예산 변경은 프로젝트 정책 한도 안에서만 허용됩니다. 성과 데이터가 지연될 때 증액을 자동 판단하지 않습니다.
      </p>
      {connections.map((conn) => (
        <ConnectionResourcePanel
          key={conn.id}
          connection={conn}
          cap={state.capabilities.find((cp) => cp.provider === conn.provider)}
          config={CONFIG}
          state={state}
          refresh={refresh}
        />
      ))}
    </div>
  );
}
