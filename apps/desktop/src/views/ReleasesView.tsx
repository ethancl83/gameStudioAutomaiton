// 스토어 배포: 공통 출시 파이프라인(검수→빌드→업로드)과 출시·트랙·심사 상태.
// 출시를 시작하고 파이프라인을 드릴다운하며, 스토어 연결별 출시 리소스와 지원 작업을 관리한다.
// 업로드 성공·심사 접수·실제 공개를 구분한다.
import { useState } from 'react';
import { PlugZap, Rocket, UploadCloud } from 'lucide-react';
import { Card, EmptyState, Field, Notice } from '../components/ui';
import { ConnectionResourcePanel, type PanelConfig } from '../components/ResourcePanel';
import { PipelinesCard, PublishModal, eligibleStoreConnections } from '../components/PublishFlow';
import type { ViewKey } from '../App';
import type { AppState } from '../../../../packages/domain';

const CONFIG: PanelConfig = {
  listOps: ['list-releases', 'sync'],
  createOps: ['upload-build'],
  kinds: ['release', 'creative'],
  rowOps: [],
};

const RELEVANT = new Set([...CONFIG.listOps, ...CONFIG.createOps]);

export function ReleasesView({
  state,
  refresh,
  goTo,
}: {
  state: AppState;
  refresh: () => Promise<void>;
  goTo: (v: ViewKey) => void;
}) {
  const [publishProjectId, setPublishProjectId] = useState<string>(state.projects[0]?.id ?? '');
  const [publishOpen, setPublishOpen] = useState(false);

  const stores = eligibleStoreConnections(state);
  const connections = state.connections.filter((c) => {
    const cap = state.capabilities.find((cp) => cp.provider === c.provider);
    return cap?.category === 'store';
  });

  const publishProject = publishProjectId ? state.projects.find((p) => p.id === publishProjectId) ?? null : null;
  const canPublish = state.projects.length > 0 && stores.length > 0;

  if (connections.length === 0 && state.projects.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={UploadCloud}
          title="배포 대상 스토어가 연결되지 않았습니다"
          description="Google Play·App Store·Steam 계정을 연결하고 프로젝트를 등록하면 출시 파이프라인을 실행할 수 있습니다."
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
      <Card title="출시 시작" icon={Rocket}>
        <p className="small muted" style={{ margin: '0 0 12px' }}>
          프로젝트와 스토어 연결을 고르고 외부 빌드 결과물을 가져와 업로드합니다. 업로드 성공, 심사 접수, 실제
          공개는 서로 다른 상태로 표시합니다.
        </p>
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Field label="프로젝트" htmlFor="rel-project">
              <select id="rel-project" className="select" value={publishProjectId} onChange={(e) => setPublishProjectId(e.target.value)}>
                <option value="">프로젝트 선택</option>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
          </div>
          <button
            className="btn btn--primary"
            disabled={!canPublish || !publishProject}
            title={
              state.projects.length === 0
                ? '먼저 프로젝트를 등록하세요.'
                : stores.length === 0
                  ? '먼저 스토어 계정을 연결하세요.'
                  : undefined
            }
            onClick={() => setPublishOpen(true)}
          >
            <Rocket size={15} /> 출시 시작
          </button>
        </div>
        {state.projects.length > 0 && stores.length === 0 && (
          <div style={{ marginTop: 10 }}>
            <Notice tone="warn">
              연결된 스토어 계정이 없습니다. <button className="btn btn--sm" onClick={() => goTo('connections')}>계정 연결</button> 후 출시할 수 있습니다.
            </Notice>
          </div>
        )}
      </Card>

      <PipelinesCard state={state} refresh={refresh} />

      <Notice tone="info">
        업로드 성공, 심사 접수, 실제 공개는 서로 다른 상태입니다. 각 출시의 상태를 스토어 원문 그대로 표시합니다.
      </Notice>

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

      {publishOpen && publishProject && (
        <PublishModal
          project={publishProject}
          state={state}
          refresh={refresh}
          onClose={() => setPublishOpen(false)}
          onPublished={() => setPublishOpen(false)}
        />
      )}
    </div>
  );
}
