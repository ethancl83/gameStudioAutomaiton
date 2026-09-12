// 일별 수익·광고비 차트/표. AppState.metricFacts(원천 팩트)를 날짜·통화별로 집계한다.
// 접근성: 표(table)가 접근 가능한 원본이며, 위의 SVG 막대는 시각 보조(aria-hidden)다.
// 통화가 다른 값은 합산하지 않고 통화별로 분리해 선택한다.
import { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { formatMicros } from '../format';
import { Card } from './ui';
import type { MetricFact } from '../../../../packages/domain';

interface DayRow {
  date: string;
  revenue: bigint;
  spend: bigint;
}

function microsToNumber(v: bigint): number {
  // 막대 높이 스케일용 근사값. 표시는 formatMicros(정밀)로 한다.
  return Number(v) / 1_000_000;
}

function aggregate(facts: MetricFact[], currency: string): DayRow[] {
  const byDate = new Map<string, { revenue: bigint; spend: bigint }>();
  for (const f of facts) {
    if (f.currency !== currency) continue;
    const cur = byDate.get(f.date) ?? { revenue: 0n, spend: 0n };
    let amt: bigint;
    try {
      amt = BigInt(f.amountMicros);
    } catch {
      continue;
    }
    if (f.kind === 'revenue') cur.revenue += amt;
    else cur.spend += amt;
    byDate.set(f.date, cur);
  }
  return [...byDate.entries()]
    .map(([date, v]) => ({ date, revenue: v.revenue, spend: v.spend }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function DailyMetrics({ facts, maxDays = 21 }: { facts: MetricFact[]; maxDays?: number }) {
  const currencies = useMemo(() => [...new Set(facts.map((f) => f.currency))].sort(), [facts]);
  const [currency, setCurrency] = useState<string>(currencies[0] ?? '');
  const active = currency || currencies[0] || '';

  const rows = useMemo(() => aggregate(facts, active).slice(-maxDays), [facts, active, maxDays]);

  if (facts.length === 0) {
    return (
      <Card title="일별 수익·광고비" icon={BarChart3}>
        <p className="small muted" style={{ margin: 0 }}>
          아직 일별 원천 팩트가 없습니다. 값이 없는 항목은 0이 아니라 <strong>미수집</strong>입니다. 계정을 동기화하면
          날짜별 수익·광고비가 표시됩니다.
        </p>
      </Card>
    );
  }

  const maxVal = rows.reduce((m, r) => {
    const hi = microsToNumber(r.revenue > r.spend ? r.revenue : r.spend);
    return hi > m ? hi : m;
  }, 0);

  return (
    <Card
      title="일별 수익·광고비"
      icon={BarChart3}
      actions={
        currencies.length > 1 ? (
          <select
            className="select"
            style={{ width: 'auto' }}
            value={active}
            onChange={(e) => setCurrency(e.target.value)}
            aria-label="통화 선택"
          >
            {currencies.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        ) : (
          <span className="tag">{active}</span>
        )
      }
    >
      <div className="row" style={{ gap: 16, marginBottom: 10 }}>
        <span className="small row" style={{ gap: 5 }}>
          <span className="legend-swatch" style={{ background: 'var(--teal-600)' }} aria-hidden /> 수익
        </span>
        <span className="small row" style={{ gap: 5 }}>
          <span className="legend-swatch" style={{ background: 'var(--warn)' }} aria-hidden /> 광고비
        </span>
      </div>

      {/* 시각 보조 막대. 접근 가능한 데이터는 아래 표를 사용한다. */}
      <div className="daily-chart" aria-hidden="true">
        {rows.map((r) => {
          const rev = microsToNumber(r.revenue);
          const spd = microsToNumber(r.spend);
          const revH = maxVal > 0 ? Math.round((rev / maxVal) * 100) : 0;
          const spdH = maxVal > 0 ? Math.round((spd / maxVal) * 100) : 0;
          return (
            <div className="daily-chart__col" key={r.date} title={`${r.date} · 수익 ${rev.toLocaleString()} · 광고비 ${spd.toLocaleString()}`}>
              <div className="daily-chart__bars">
                <span className="daily-chart__bar" style={{ height: `${revH}%`, background: 'var(--teal-600)' }} />
                <span className="daily-chart__bar" style={{ height: `${spdH}%`, background: 'var(--warn)' }} />
              </div>
              <span className="daily-chart__label">{r.date.slice(5)}</span>
            </div>
          );
        })}
      </div>

      <details style={{ marginTop: 12 }}>
        <summary className="small muted" style={{ cursor: 'pointer' }}>표로 보기 ({rows.length}일)</summary>
        <div className="table__scroll" style={{ marginTop: 8 }}>
          <table className="table">
            <caption className="sr-caption">{active} 통화의 일별 수익·광고비·기여이익</caption>
            <thead>
              <tr>
                <th scope="col">날짜</th>
                <th scope="col" style={{ textAlign: 'right' }}>수익</th>
                <th scope="col" style={{ textAlign: 'right' }}>광고비</th>
                <th scope="col" style={{ textAlign: 'right' }}>기여이익</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.date}>
                  <th scope="row" style={{ fontWeight: 550 }}>{r.date}</th>
                  <td style={{ textAlign: 'right' }}>{formatMicros(r.revenue.toString(), active)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMicros(r.spend.toString(), active)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMicros((r.revenue - r.spend).toString(), active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}
