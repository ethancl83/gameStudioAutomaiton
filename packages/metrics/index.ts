import type { MetricFact, MetricsSummary } from '../domain/index.js';
import { AppError } from '../domain/errors.js';

export function parseMicros(value: unknown): bigint {
  if (typeof value !== 'string' || !/^-?\d{1,30}$/.test(value)) throw new AppError('INVALID_AMOUNT', '금액은 정확한 정수 마이크로 단위로 입력해 주세요.');
  return BigInt(value);
}
export function decimalToMicros(value: string | number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d{0,6}))?$/.exec(text);
  if (!match) throw new AppError('INVALID_AMOUNT', '원천 금액의 소수점 자릿수 또는 형식을 확인해 주세요.');
  const amount = BigInt(match[2]) * 1_000_000n + BigInt((match[3] ?? '').padEnd(6, '0'));
  return (match[1] ? -amount : amount).toString();
}
export function summarizeMetrics(facts: MetricFact[]): MetricsSummary[] {
  const groups = new Map<string, { revenue: bigint; spend: bigint; estimated: boolean; warnings: Set<string> }>();
  const seen = new Set<string>();
  const maxCoverage = new Map<string, Set<string>>();
  for (const fact of facts) if (fact.kind === 'revenue' && fact.provider === 'applovin-max') {
    const key = fact.date + ':' + fact.currency;
    const apps = maxCoverage.get(key) ?? new Set<string>(); apps.add(fact.appIdentifier ?? '*'); maxCoverage.set(key, apps);
  }
  // Apple 정산(settled)은 같은 계정·통화·기간의 일별 판매 proceeds를 대체한다. 둘 다 더하면 이중 계산이다.
  const settled = facts.flatMap(fact => {
    const match = fact.basis === 'settled' && fact.sourceId.startsWith('apple-finance:') ? /(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(fact.sourceId) : null;
    return match ? [{ connectionId: fact.connectionId, currency: fact.currency, from: match[1]!, to: match[2]! }] : [];
  });
  const replaced = (fact: MetricFact) => fact.sourceId.startsWith('apple:sales:') && settled.some(item => item.connectionId === fact.connectionId && item.currency === fact.currency && item.from <= fact.date && fact.date <= item.to);
  for (const fact of facts) {
    if (replaced(fact)) continue;
    const key = `${fact.connectionId}:${fact.sourceId}:${fact.kind}:${fact.date}:${fact.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const group = groups.get(fact.currency) ?? { revenue: 0n, spend: 0n, estimated: false, warnings: new Set<string>() };
    const coverage = maxCoverage.get(fact.date + ':' + fact.currency);
    const overlapsMax = fact.kind === 'revenue' && fact.provider === 'admob' && coverage &&
      (!fact.appIdentifier || coverage.has('*') || coverage.has(fact.appIdentifier));
    if (overlapsMax) {
      group.warnings.add('MAX 보고서와 겹칠 수 있는 AdMob 수익은 합계에서 제외했습니다. 이 합계는 전체 광고 수익을 확정한 값이 아닙니다.');
      groups.set(fact.currency, group); continue;
    }
    if (fact.kind === 'revenue') { group.revenue += parseMicros(fact.amountMicros); group.estimated ||= fact.basis === 'estimated'; }
    else group.spend += parseMicros(fact.amountMicros);
    groups.set(fact.currency, group);
  }
  return [...groups].map(([currency, group]) => ({ currency, revenueMicros: group.revenue.toString(), spendMicros: group.spend.toString(), contributionMicros: (group.revenue - group.spend).toString(), estimated: group.estimated,
    ...(group.warnings.size ? { warnings: [...group.warnings] } : {}) }));
}
