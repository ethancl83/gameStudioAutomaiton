// 연결 단위 리소스·작업 패널. 스토어/마케팅/수익화 화면이 공용으로 사용한다.
// 조회(list) 작업은 즉시 실행, 생성/수정/중지/심사 등 쓰기는 ActionForm 모달을 연다.
// capability.operations 에 광고된 작업은 화면 설정에 없어도 모두 접근 가능하게 노출한다
// (새로 추가된 미지의 작업 포함 — 공급자 operationFields 로 입력 폼이 구성된다).
import { Fragment, useMemo, useState } from 'react';
import { ChevronRight, Plus, RefreshCcw, Wand2 } from 'lucide-react';
import { api } from '../api';
import {
  RESOURCE_KIND_LABELS,
  formatDateTime,
  formatRelative,
  operationLabel,
  providerLabel,
} from '../format';
import { specFor } from '../operations';
import { useAction } from '../useAction';
import { ConnectionStatusBadge } from './status';
import { Badge, Notice, Spinner } from './ui';
import { ActionForm } from './ActionForm';
import type { AppState, Capability, Connection, ExternalResource, Run } from '../../../../packages/domain';

export interface PanelConfig {
  // 대상 없이 즉시 실행할 조회 작업.
  listOps: string[];
  // 폼을 여는 생성 작업.
  createOps: string[];
  // 표에 표시할 리소스 종류.
  kinds: ExternalResource['kind'][];
  // 각 리소스 행에서 가능한 작업.
  rowOps: string[];
}

function supported(cap: Capability | undefined, ops: string[]): string[] {
  if (!cap) return [];
  return ops.filter((op) => cap.operations.includes(op));
}

// 조회/재확인처럼 대상 없이 즉시 실행하는 읽기 작업인가.
function isReadOnlyOp(op: string, provider: Connection['provider']): boolean {
  return specFor(op, provider).externalWrite === false;
}

// 값이 ISO 날짜면 읽기 쉬운 형식으로 바꾼다(지표·갱신일 등).
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (typeof value === 'number') return value.toLocaleString('ko-KR');
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return formatDateTime(value);
    return value;
  }
  if (Array.isArray(value)) return `${value.length}개 항목`;
  return '세부 항목';
}

// 리소스 data 중 사람이 읽을 메타데이터만 골라 표시한다(중첩 객체는 접이식으로).
function metadataEntries(r: ExternalResource): [string, unknown][] {
  const hidden = new Set(['text', 'permalink']);
  return Object.entries(r.data).filter(([k]) => !hidden.has(k));
}

// 행 작업이 이 리소스 종류에 적용되는가. 작업 이름에 종류 키워드가 있으면 그 종류에만,
// 없으면(일반 작업) 모든 행에 적용한다. 캠페인 작업을 소재 행에 노출하지 않는다.
function opAppliesToKind(op: string, kind: ExternalResource['kind']): boolean {
  const keyed: [RegExp, ExternalResource['kind']][] = [
    [/campaign/i, 'campaign'],
    [/creative/i, 'creative'],
    [/product/i, 'product'],
    [/ad-?unit/i, 'ad-unit'],
    [/release|listing|review|promote/i, 'release'],
  ];
  for (const [re, k] of keyed) {
    if (re.test(op)) return kind === k;
  }
  return true;
}

export function ConnectionResourcePanel({
  connection,
  cap,
  config,
  state,
  refresh,
}: {
  connection: Connection;
  cap: Capability | undefined;
  config: PanelConfig;
  state: AppState;
  refresh: () => Promise<void>;
}) {
  const [form, setForm] = useState<{ operation: string; externalId?: string; projectId?: string } | null>(null);
  const listAct = useAction<Run>(refresh);
  const [runningOp, setRunningOp] = useState<string | null>(null);

  const listOps = supported(cap, config.listOps);
  const createOps = supported(cap, config.createOps);
  const rowOps = supported(cap, config.rowOps);

  // 화면 설정에 없는, 그러나 공급자가 광고한 작업들. 모두 접근 가능하게 한다.
  const configured = new Set([...config.listOps, ...config.createOps, ...config.rowOps]);
  const extraOps = (cap?.operations ?? []).filter((op) => !configured.has(op));
  const extraReadOps = extraOps.filter(op => isReadOnlyOp(op, connection.provider));
  const extraWriteOps = extraOps.filter((op) => !isReadOnlyOp(op, connection.provider));

  const resources = state.resources.filter(
    (r) => r.connectionId === connection.id && config.kinds.includes(r.kind),
  );

  const writable = connection.status === 'connected' || connection.status === 'unverified';

  async function runList(op: string) {
    if (specFor(op, connection.provider).needsProject || cap?.operationFields?.[op]?.some(field => !field.remove)) {
      setForm({ operation: op }); return;
    }
    setRunningOp(op);
    await listAct.run(() => api.runAction(connection.id, { operation: op, input: {} }));
    setRunningOp(null);
  }

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <h2 className="card__title">{connection.label}</h2>
          <div className="small muted">{providerLabel(connection.provider)} · {connection.accountId}</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <ConnectionStatusBadge status={connection.status} />
        </div>
      </div>
      <div className="card__body">
        <div className="row" style={{ gap: 8, marginBottom: 14 }}>
          {[...listOps, ...extraReadOps].map((op) => (
            <button key={op} className="btn btn--sm" onClick={() => void runList(op)} disabled={listAct.pending}>
              {runningOp === op ? <Spinner /> : <RefreshCcw size={13} />} {operationLabel(op)}
            </button>
          ))}
          {createOps.map((op) => (
            <button
              key={op}
              className="btn btn--sm btn--primary"
              disabled={!writable}
              title={!writable ? '연결 상태가 정상일 때만 사용할 수 있습니다.' : undefined}
              onClick={() => setForm({ operation: op })}
            >
              <Plus size={13} /> {operationLabel(op)}
            </button>
          ))}
          {extraWriteOps.map((op) => (
            <button
              key={op}
              className="btn btn--sm"
              disabled={!writable}
              title={!writable ? '연결 상태가 정상일 때만 사용할 수 있습니다.' : '이 공급자가 광고한 작업입니다.'}
              onClick={() => setForm({ operation: op })}
            >
              <Wand2 size={13} /> {operationLabel(op)}
            </button>
          ))}
          {listOps.length === 0 && createOps.length === 0 && extraOps.length === 0 && (
            <span className="small muted">이 공급자에서 지원되는 작업이 없습니다.</span>
          )}
        </div>

        {listAct.error && <div style={{ marginBottom: 12 }}><Notice tone="error">{listAct.error.message}</Notice></div>}

        <ResourceTable
          resources={resources}
          rowOps={rowOps}
          writable={writable}
          onRowAction={(operation, externalId, projectId) => setForm({ operation, externalId, projectId })}
        />
      </div>

      {form && (
        <ActionForm
          connection={connection}
          operation={form.operation}
          presetExternalId={form.externalId}
          presetProjectId={form.projectId}
          capability={cap}
          state={state}
          refresh={refresh}
          onClose={() => setForm(null)}
        />
      )}
    </section>
  );
}

function ResourceTable({
  resources,
  rowOps,
  writable,
  onRowAction,
}: {
  resources: ExternalResource[];
  rowOps: string[];
  writable: boolean;
  onRowAction: (operation: string, externalId: string, projectId?: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (resources.length === 0) {
    return <p className="small muted">아직 가져온 항목이 없습니다. 위의 조회 작업으로 최신 상태를 가져오세요.</p>;
  }
  return (
    <div className="table__scroll">
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 28 }} aria-label="상세" />
            <th>이름</th>
            <th>종류</th>
            <th>상태</th>
            <th>갱신</th>
            {rowOps.length > 0 && <th aria-label="동작" />}
          </tr>
        </thead>
        <tbody>
          {resources.map((r) => {
            // 이 리소스 종류에 맞는 행 작업만, 그리고 중지된 캠페인에는 pause를 다시 노출하지 않는다.
            const ops = rowOps
              .filter((op) => opAppliesToKind(op, r.kind))
              .filter((op) => !(op === 'pause-campaign' && /pause|stop/i.test(r.status)));
            const open = expanded === r.id;
            const meta = metadataEntries(r);
            return (
              <Fragment key={r.id}>
                <tr>
                  <td>
                    <button
                      className="btn btn--ghost btn--sm"
                      aria-expanded={open}
                      aria-label={open ? '메타데이터 접기' : '메타데이터 펼치기'}
                      onClick={() => setExpanded(open ? null : r.id)}
                    >
                      <ChevronRight size={15} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s' }} />
                    </button>
                  </td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{r.name}</div>
                    <div className="small muted mono truncate" title={r.externalId}>{r.externalId}</div>
                  </td>
                  <td>
                    <span className="tag">{RESOURCE_KIND_LABELS[r.kind] ?? r.kind}</span>
                  </td>
                  <td>
                    <Badge tone="neutral">{r.status}</Badge>
                  </td>
                  <td className="small nowrap">{formatRelative(r.updatedAt)}</td>
                  {rowOps.length > 0 && (
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {ops.map((op) => (
                          <button
                            key={op}
                            className="btn btn--sm"
                            disabled={!writable}
                            onClick={() => onRowAction(op, r.externalId, r.projectId ?? undefined)}
                          >
                            {operationLabel(op)}
                          </button>
                        ))}
                      </div>
                    </td>
                  )}
                </tr>
                {open && (
                  <tr>
                    <td colSpan={rowOps.length > 0 ? 6 : 5} style={{ background: 'var(--surface-sunken)' }}>
                      {meta.length === 0 ? (
                        <p className="small muted" style={{ margin: 0 }}>추가 메타데이터가 없습니다.</p>
                      ) : (
                        <dl className="dl" style={{ gridTemplateColumns: '160px 1fr', margin: 0 }}>
                          {meta.map(([k, v]) => (
                            <Fragment key={k}>
                              <dt>{k}</dt>
                              <dd className="small" style={{ wordBreak: 'break-word' }}>{renderValue(v)}</dd>
                            </Fragment>
                          ))}
                        </dl>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
