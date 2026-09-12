import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalToMicros, summarizeMetrics } from '../packages/metrics/index.js';
import type { MetricFact } from '../packages/domain/index.js';

test('micros preserve precision, negative refunds and separate currencies', () => {
  assert.equal(decimalToMicros('9007199254.123456'), '9007199254123456');
  assert.equal(decimalToMicros('-0.12'), '-120000');
  assert.throws(() => decimalToMicros('0.1234567'));
  const base: MetricFact = { id: '1', connectionId: 'a', projectId: null, provider: 'applovin-max', date: '2026-09-11', currency: 'USD', kind: 'revenue', amountMicros: '10000000', basis: 'estimated', sourceId: 'row-1', collectedAt: 'now' };
  const summaries = summarizeMetrics([base, { ...base }, { ...base, id: '2', sourceId: 'row-2', amountMicros: '-1000000' }, { ...base, id: '3', sourceId: 'row-3', currency: 'KRW' }, { ...base, id: '4', sourceId: 'row-4', kind: 'spend', amountMicros: '2000000' }]);
  assert.equal(summaries.find(s => s.currency === 'USD')?.contributionMicros, '7000000');
  assert.equal(summaries.find(s => s.currency === 'KRW')?.revenueMicros, '10000000');
});

test('overlapping MAX and AdMob totals are not double counted and uncertain coverage is visible', () => {
  const base: MetricFact = { id: '1', connectionId: 'max', projectId: null, appIdentifier: 'com.example.game', provider: 'applovin-max', date: '2026-09-10', currency: 'USD', kind: 'revenue', amountMicros: '10000000', basis: 'estimated', sourceId: 'max-day', collectedAt: 'now' };
  const summaries = summarizeMetrics([base, { ...base, id: '2', connectionId: 'admob', provider: 'admob', sourceId: 'admob-day', amountMicros: '4000000' },
    { ...base, id: '3', connectionId: 'admob', provider: 'admob', appIdentifier: 'com.example.other', sourceId: 'admob-other', amountMicros: '1000000' }]);
  assert.equal(summaries[0].revenueMicros, '11000000'); assert.equal(summaries[0].warnings?.length, 1);
});
