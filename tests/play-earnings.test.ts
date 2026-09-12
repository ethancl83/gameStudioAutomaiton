import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { parsePlayEarnings, collectPlayEarnings } from '../packages/connectors/play-earnings.js';
import type { ConnectorContext } from '../packages/connectors/types.js';
import { AppError } from '../packages/domain/errors.js';

const header = 'Description,Transaction Date,Package ID,Merchant Currency,Amount (Merchant Currency),Transaction Type\r\n';
function archive(csv: string) { return zipSync({ 'earnings.csv': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, 'utf16le')]) }); }
test('Play earnings aggregate signed postings in merchant currency without persisting orders', () => {
  const data = archive(header + 'private-order,"Aug 31, 2026",com.example.game,USD,10.00,Charge\r\n' +
    'private-order,"Aug 31, 2026",com.example.game,USD,-1.50,Google fee\r\n' +
    'refund,"Aug 31, 2026",com.example.game,USD,-2.00,Charge refund\r\n' +
    'fee-refund,"Aug 31, 2026",com.example.game,USD,0.30,Google fee refund\r\n' +
    'other,"Aug 31, 2026",com.example.other,KRW,"1,234.00",Charge\r\n');
  const metrics = parsePlayEarnings(data, '202608');
  assert.equal(metrics.length, 2); assert.equal(metrics[0].amountMicros, '6800000');
  assert.equal(metrics[0].basis, 'proceeds'); assert.equal(metrics[0].date, '2026-08-31');
  assert.equal(metrics[1].amountMicros, '1234000000');
  assert.ok(!JSON.stringify(metrics).includes('private-order'));
});
test('Play reports reject corrupt, absent-column and invalid-date data', () => {
  assert.throws(() => parsePlayEarnings(Buffer.from('not zip'), '202608'), { code: 'INVALID_REPORT' });
  assert.throws(() => parsePlayEarnings(archive('wrong,header\n'), '202608'), { code: 'INVALID_REPORT' });
  assert.throws(() => parsePlayEarnings(archive(header + 'a,2026-02-30,pkg,USD,1,Charge\n'), '202608'), { code: 'INVALID_REPORT' });
});
test('Play downloads use scoped private GCS object and missing months never erase previous metrics', async () => {
  let available = true; let calls = 0;
  const ctx = { credentials: { reportBucket: 'pubsite_prod_rev_123' },
    async accessToken(scopes: string[]) { assert.deepEqual(scopes, ['https://www.googleapis.com/auth/devstorage.read_only']); return 'private-token'; },
    async request(url: string, options: Record<string, unknown>) {
      calls++; assert.equal(url, 'https://storage.googleapis.com/storage/v1/b/pubsite_prod_rev_123/o/earnings%2Fearnings_202608.zip?alt=media');
      assert.equal(options.format, 'bytes');
      if (!available) throw new AppError('RESOURCE_NOT_FOUND', 'absent');
      return archive(header + 'a,2026-08-31,com.example.game,USD,5,Charge\n');
    },
  } as unknown as ConnectorContext;
  const result = await collectPlayEarnings({ reportMonth: '202608' }, ctx);
  assert.deepEqual(result.metricSourcePrefixes, ['play-earnings:202608:']);
  assert.equal(result.metrics?.[0].amountMicros, '5000000');
  available = false;
  const missing = await collectPlayEarnings({ reportMonth: '202608' }, ctx);
  assert.deepEqual(missing.metricSourcePrefixes, []); assert.equal(calls, 2);
});
