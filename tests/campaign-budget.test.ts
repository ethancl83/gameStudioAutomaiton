import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceCampaignBudget } from '../apps/controller/campaign-budget.js';
import { DEFAULT_POLICY, type Connection, type ExternalResource, type Project, type Run } from '../packages/domain/index.js';

const project = { id: 'project', appIdentifier: 'com.example.game', policy: { ...DEFAULT_POLICY, maxDailyBudgetMicros: '10000000' } } as Project;
const connection = { id: 'account-a' } as Connection;
const resource: ExternalResource = { id: 'resource-a', name: 'A', provider: 'google-ads', updatedAt: '2026-09-11', kind: 'campaign', externalId: 'campaign-a', connectionId: 'account-a', projectId: 'project', status: 'PAUSED',
  data: { dailyBudgetMicros: '6000000', currency: 'USD' } };
const pendingBase: Run = { id: 'pending', projectId: 'project', connectionId: 'account-b', kind: 'create-campaign', input: {}, label: '대기', status: 'queued', result: null, error: null, attempt: 0,
  createdAt: '2026-09-11', updatedAt: '2026-09-11', startedAt: null, finishedAt: null };
test('unknown or contradictory app ownership blocks campaign updates and pausing', () => {
  for (const operation of ['update-campaign', 'pause-campaign']) {
    assert.throws(() => enforceCampaignBudget(project, connection, operation, { externalId: resource.externalId, status: 'PAUSED' }, [{ ...resource, projectId: null }], []), { code: 'RESOURCE_SYNC_REQUIRED' });
    assert.throws(() => enforceCampaignBudget(project, connection, operation, { externalId: resource.externalId, status: 'PAUSED' }, [{ ...resource, data: { ...resource.data, appId: 'com.other.game' } }], []), { code: 'RESOURCE_MISMATCH' });
  }
});
test('project campaign cap includes paused budgets and concurrent reservations on other accounts', () => {
  const pending: Run = { ...pendingBase, input: { name: 'B', dailyBudgetMicros: '3000000', currency: 'USD' } };
  assert.throws(() => enforceCampaignBudget(project, connection, 'create-campaign', { dailyBudgetMicros: '2000000', currency: 'USD' }, [resource], [pending]), { code: 'BUDGET_LIMIT' });
  assert.doesNotThrow(() => enforceCampaignBudget(project, connection, 'create-campaign', { dailyBudgetMicros: '1000000', currency: 'USD' }, [resource], [pending]));
});
test('campaign changes replace their own budget, cannot cross projects, and pause remains available', () => {
  assert.doesNotThrow(() => enforceCampaignBudget(project, connection, 'update-campaign', { externalId: 'campaign-a', dailyBudgetMicros: '9000000', currency: 'USD' }, [resource], []));
  assert.throws(() => enforceCampaignBudget(project, connection, 'update-campaign', { externalId: 'campaign-a', status: 'ENABLED' }, [{ ...resource, projectId: 'other' }], []), { code: 'RESOURCE_MISMATCH' });
  assert.doesNotThrow(() => enforceCampaignBudget({ ...project, policy: { ...project.policy, maxDailyBudgetMicros: '0' } }, connection, 'update-campaign', { externalId: 'campaign-a', status: 'PAUSED' }, [resource], []));
});
test('duplicate queued request does not reserve twice, unknown resource budgets cannot bypass cap', () => {
  const input = { name: 'A', dailyBudgetMicros: '10000000', currency: 'USD' };
  const pending: Run = { ...pendingBase, connectionId: connection.id, input };
  assert.doesNotThrow(() => enforceCampaignBudget(project, connection, 'create-campaign', input, [], [pending]));
  assert.throws(() => enforceCampaignBudget(project, connection, 'create-campaign', input, [{ ...resource, data: { currency: 'USD' } }], []), { code: 'BUDGET_UNKNOWN' });
});
