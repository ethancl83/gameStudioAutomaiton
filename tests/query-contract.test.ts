// Phase7 조회 계약: 문서 범위·keyset 페이지, 성장 운영 프로젝트 범위 상태·결정 이력, 실제 HTTP 경로, 개발 응답 DTO 연결.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type DocumentCursor } from '../packages/storage/index.js';
import { GrowthOperations } from '../apps/controller/growth.js';
import { startController } from '../apps/controller/server.js';
import { CredentialVault, type KeyProvider } from '../packages/credentials/index.js';
import { DEFAULT_POLICY, type ApiResult, type Project } from '../packages/domain/index.js';
import { OPEN_RESPONSE_STATUSES, type AttributionFact, type DecisionSnapshot, type GrowthDecisionPage, type GrowthState, type ResponseIntent, type ResponseStatus } from '../packages/growth/types.js';
import { growthStateRequests } from '../apps/desktop/src/views/growth/stateRequests.js';
import type { DevelopmentResponses } from '../packages/development/types.js';
import type { listItems, repositories } from '../packages/development/github.js';
import type { gitState } from '../packages/development/git.js';
import type { DevelopmentTasks } from '../apps/controller/development-tasks.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function openStore(t: TestContext) {
  let clock = NOW;
  const directory = mkdtempSync(join(tmpdir(), 'appops-query-'));
  const store = new Store(directory, { heartbeat: false, clock: () => clock });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  // updated_at 순서를 결정적으로 만들되 lease는 유지한다.
  const tick = () => { clock += 1; store.db.prepare('UPDATE controller SET expires_at=?').run(clock + 60_000); };
  return { store, tick };
}
const project = (id: string): Project => ({ id, name: id, rootPath: '/tmp/none', engine: 'godot', engineVersion: null, appIdentifier: 'com.test.' + id, targets: ['android'], findings: [], inspectedAt: '',
  createdAt: '', updatedAt: '', policy: { ...DEFAULT_POLICY, currency: 'USD' } });
const decision = (id: string, projectId: string, at: string, experimentId = 'e-' + projectId, kind: DecisionSnapshot['kind'] = 'efficacy') =>
  ({ id, projectId, experimentId, experimentVersion: 1, at, look: 1, kind, outcome: 'continue', arms: [], comparisons: [], reasons: [], guardrailViolations: [], factIds: [], mandateId: 'm' }) as unknown as DecisionSnapshot;
const response = (id: string, projectId: string, status: ResponseIntent['status'], createdAt: string) =>
  ({ id, projectId, connectionId: 'x', provider: 'x', status, blockReasons: [], knowledgeRevisionIds: [], createdAt, updatedAt: createdAt }) as unknown as ResponseIntent;
function growthOn(store: Store) {
  return new GrowthOperations(store, { mode: 'live', supported: () => true, cancel() {}, action() { throw new Error('조회 테스트는 외부 작업을 만들지 않는다'); } }, () => NOW);
}
function allPages(read: (before?: DocumentCursor) => { ids: string[]; next: DocumentCursor | null }) {
  const ids: string[] = []; let before: DocumentCursor | undefined; let pages = 0;
  do { const page = read(before); ids.push(...page.ids); before = page.next ?? undefined; pages++; assert.ok(pages < 50, '페이지가 끝나야 한다'); } while (before);
  return { ids, pages };
}

test('문서 범위 조회는 프로젝트·상태·시간 조건과 표시 상한을 SQL에서 적용하고 필드 이름을 검증한다', t => {
  const { store, tick } = openStore(t);
  for (const [id, projectId, status, at] of [['i1', 'a', 'open', '2026-09-24T01:00:00.000Z'], ['i2', 'b', 'open', '2026-09-24T02:00:00.000Z'], ['i3', 'a', 'resolved', '2026-09-23T01:00:00.000Z'], ['i4', 'a', undefined, '2026-09-24T03:00:00.000Z']] as const) {
    store.put('growth-incident', id, { id, projectId, ...(status ? { status } : {}), createdAt: at }); tick();
  }
  const ids = (items: Array<{ id: string }>) => items.map(item => item.id);
  assert.deepEqual(ids(store.documents('growth-incident', { projectId: 'a' })), ['i4', 'i3', 'i1'], '다른 프로젝트 제외, 최근 갱신 순');
  assert.deepEqual(ids(store.documents('growth-incident', { projectId: 'a', notIn: { status: ['resolved'] } })), ['i4', 'i1'], '상태가 없는 문서는 제외 조건에 걸리지 않는다');
  assert.deepEqual(ids(store.documents('growth-incident', { in: { status: ['open'] } })), ['i2', 'i1']);
  assert.deepEqual(store.documents('growth-incident', { in: { status: [] } }), []);
  assert.deepEqual(ids(store.documents('growth-incident', { range: { field: 'createdAt', from: '2026-09-24T00:00:00.000Z', to: '2026-09-24T03:00:00.000Z' } })), ['i2', 'i1'], '[from, to) 범위');
  assert.deepEqual(ids(store.documents('growth-incident', { projectId: 'a', limit: 1 })), ['i4']);
  assert.throws(() => store.documents('growth-incident', { in: { "status') OR 1=1 --": ['x'] } }), { code: 'INVALID_QUERY' });
  assert.throws(() => store.documents('growth-incident', { limit: 0 }), { code: 'INVALID_QUERY' });
  // 기존 연결 범위 호출 형식 호환
  store.put('resource', 'r1', { id: 'r1', connectionId: 'c1' }); store.put('resource', 'r2', { id: 'r2', connectionId: 'c2' });
  assert.deepEqual(ids(store.documents('resource', { connectionId: 'c1' })), ['r1']);
});

test('keyset 페이지는 같은 시각 문서를 id로 이어 중복·누락 없이 끝까지 읽고 다른 프로젝트를 섞지 않는다', t => {
  const { store } = openStore(t);
  const same = '2026-09-24T00:00:00.000Z';
  for (const id of ['d3', 'd1', 'd5', 'd2', 'd4']) store.put('growth-decision', id, decision(id, 'a', same));
  store.put('growth-decision', 'late', decision('late', 'a', '2026-09-24T00:00:00.001Z'));
  store.put('growth-decision', 'early', decision('early', 'a', '2026-09-23T23:59:59.999Z'));
  store.put('growth-decision', 'other', decision('other', 'b', same));
  store.put('growth-decision', 'numeric', { ...decision('numeric', 'a', same), at: 1 });
  const expected = ['late', 'd5', 'd4', 'd3', 'd2', 'd1', 'early'];
  for (const limit of [1, 2, 3, 7]) {
    const { ids, pages } = allPages(before => { const page = store.documentPage<DecisionSnapshot>('growth-decision', { projectId: 'a', order: 'at', limit, ...(before ? { before } : {}) }); return { ids: page.items.map(item => item.id), next: page.next }; });
    assert.deepEqual(ids, expected, `limit ${limit}`);
    assert.equal(pages, Math.ceil(expected.length / limit), '마지막 페이지에서 next가 null');
  }
  // 커서 문서가 사라져도 경계 값으로 이어진다.
  const first = store.documentPage<DecisionSnapshot>('growth-decision', { projectId: 'a', order: 'at', limit: 3 });
  store.remove('growth-decision', first.next!.id);
  assert.deepEqual(store.documentPage<DecisionSnapshot>('growth-decision', { projectId: 'a', order: 'at', limit: 10, before: first.next! }).items.map(item => item.id), ['d3', 'd2', 'd1', 'early']);
  assert.throws(() => store.documentPage('growth-decision', { order: 'at', limit: 0 }), { code: 'INVALID_QUERY' });
  assert.throws(() => store.documentPage('growth-decision', { order: 'at', limit: 501 }), { code: 'INVALID_QUERY' });
  assert.throws(() => store.documentPage('growth-decision', { order: "at'", limit: 1 }), { code: 'INVALID_QUERY' });
});

test('프로젝트 범위 성장 상태는 다른 프로젝트를 격리하고, 표시 상한과 별도로 digest·처리 대기 응답을 유지한다', t => {
  const { store, tick } = openStore(t);
  for (const id of ['a', 'b']) store.put('project', id, project(id));
  const growth = growthOn(store);
  for (const id of ['a', 'b']) growth.savePolicy({ projectId: id, alpha: 0.05, multiplicity: 'holm', defaultStopping: 'fixed_horizon', freshnessHours: { 'google-ads': 48 }, fxMaxAgeHours: 48, variableCostRate: 0, allowPricingExperiments: false });
  store.put('growth-mandate', 'ma', { id: 'ma', projectId: 'a', status: 'proposed' });
  store.put('growth-mandate', 'mb', { id: 'mb', projectId: 'b', status: 'proposed' });
  // 오래된 갱신 시각의 사람 확인 응답은 최근 500건 상한 밖에 있어도 대기열과 digest에 남아야 한다.
  store.put('response-intent', 'esc-a', response('esc-a', 'a', 'escalated', iso(NOW - 2 * HOUR))); tick();
  store.put('response-intent', 'esc-b', response('esc-b', 'b', 'escalated', iso(NOW - 2 * HOUR))); tick();
  for (let i = 0; i < 501; i++) { store.put('response-intent', 'closed-' + i, response('closed-' + i, 'a', 'closed', iso(NOW - HOUR))); tick(); }
  // 24시간 안의 결정 305건: 상태 목록은 300건으로 자르지만 digest 집계는 전부 센다.
  for (let i = 0; i < 305; i++) store.put('growth-decision', 'da-' + String(i).padStart(3, '0'), decision('da-' + String(i).padStart(3, '0'), 'a', iso(NOW - HOUR - i * 1000)));
  store.put('growth-decision', 'db', decision('db', 'b', iso(NOW - HOUR)));
  store.put('growth-decision', 'old', decision('old', 'b', iso(NOW - 30 * HOUR)));
  store.put('growth-decision', 'qc', decision('qc', 'b', iso(NOW - HOUR), 'e-b', 'quality_check'));

  const scoped = growth.state('a');
  assert.equal(scoped.projectId, 'a');
  assert.deepEqual(scoped.mandates.map(item => item.id), ['ma']);
  assert.deepEqual(scoped.policies.map(item => item.projectId), ['a']);
  assert.equal(scoped.decisions.length, 300);
  assert.ok(scoped.decisions.every(item => item.projectId === 'a'));
  assert.equal(scoped.decisions[0]!.id, 'da-000', '최근 결정부터');
  assert.deepEqual(scoped.decisionsNext, { at: scoped.decisions.at(-1)!.at, id: scoped.decisions.at(-1)!.id });
  assert.ok(scoped.responses.every(item => item.projectId === 'a'));
  assert.equal(scoped.responses.length, 501, '최근 500건 + 상한 밖 처리 대기 1건');
  assert.ok(scoped.responses.some(item => item.id === 'esc-a'));
  // digest는 전역 집계이며 표시 상한과 무관하다.
  assert.equal(scoped.digest.decisions.continue, 306, '24시간 안 결정(a 305 + b 1), 품질 점검·24시간 밖 제외');
  assert.deepEqual(scoped.digest.actionRequired.filter(item => item.kind === 'escalation').map(item => item.id).sort(), ['esc-a', 'esc-b']);
  assert.deepEqual(scoped.digest.actionRequired.filter(item => item.kind === 'mandate').map(item => item.id).sort(), ['ma', 'mb']);
  assert.equal(scoped.digest.community.escalations.open, 2);
  assert.equal(scoped.digest.community.total, 503);

  const other = growth.state('b');
  assert.deepEqual(other.decisions.map(item => item.id), ['qc', 'db', 'old'], '같은 at은 id 내림차순');
  assert.equal(other.decisionsNext, null);
  assert.deepEqual(other.responses.map(item => item.id), ['esc-b']);
  assert.deepEqual(other.digest, scoped.digest, '같은 시각의 digest는 조회 범위와 무관');

  const global = growth.state();
  assert.equal(global.projectId, undefined, '기존 전역 호출 호환');
  assert.deepEqual(global.mandates.map(item => item.id).sort(), ['ma', 'mb']);
  assert.equal(global.decisions.length, 300);
  assert.equal(growth.state('missing').mandates.length, 0);

  const context = growth.context('a');
  assert.equal(context.decisions.length, 20);
  assert.equal(context.responses.length, 50);
  assert.ok(context.responses.every(item => item.projectId === 'a' && !('excerpt' in item)));
  assert.equal(context.policy?.projectId, 'a');
});

test('화면의 열린 응답 상태(차단 포함)는 최근 500건 상한 밖이어도 목록에 남고 나머지는 상한을 따른다', t => {
  const { store, tick } = openStore(t);
  store.put('project', 'p', project('p'));
  const growth = growthOn(store);
  const open: ResponseStatus[] = ['escalated', 'draft_ready', 'blocked', 'authorized', 'queued', 'prepared', 'dispatched'];
  assert.deepEqual([...OPEN_RESPONSE_STATUSES].sort(), [...open].sort(), '화면이 펼치는 열린 상태와 서버 보존 상태의 단일 정의');
  // 오래된 열린 응답과 종료 응답을 먼저 저장하고, 그 뒤 최근 closed 501건으로 상한을 채운다.
  for (const status of [...open, 'confirmed', 'unresolved', 'retracted'] as ResponseStatus[]) { store.put('response-intent', 'old-' + status, response('old-' + status, 'p', status, iso(NOW - 3 * HOUR))); tick(); }
  for (let i = 0; i < 501; i++) { store.put('response-intent', 'closed-' + i, response('closed-' + i, 'p', 'closed', iso(NOW - HOUR))); tick(); }
  const ids = new Set(growth.state('p').responses.map(item => item.id));
  for (const status of open) assert.ok(ids.has('old-' + status), status + ' 응답이 상한 밖에서 사라지면 안 된다');
  assert.ok(!ids.has('old-confirmed') && !ids.has('old-unresolved') && !ids.has('old-retracted'), '접힌 그룹 상태는 최근 상한을 따른다');
  assert.ok(!ids.has('closed-0') && ids.has('closed-500'), '최근 closed 500건만 표시');
  assert.equal(ids.size, 500 + open.length);
});

test('성장 상태 폴링: 5초보다 느린 응답도 겹침 없이 반영하고, 전환·해제·작업 뒤 새로고침 순서를 지킨다', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending: Array<{ projectId: string; resolve: (result: ApiResult<GrowthState>) => void; reject: (error: Error) => void }> = [];
  const applied: string[] = [];
  let inflight = 0; let maxInflight = 0;
  const requests = growthStateRequests(projectId => new Promise((resolve, reject) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    pending.push({ projectId, resolve: value => { inflight--; resolve(value); }, reject: error => { inflight--; reject(error); } });
  }), result => applied.push(result.ok ? result.data.projectId + ':' + result.data.mandates.length : 'error:' + result.error.message), 5000);
  const ok = (projectId: string, marker = 0): ApiResult<GrowthState> => ({ ok: true, data: { projectId, mandates: Array(marker) } as unknown as GrowthState });
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const elapse = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };

  // 매 요청이 6초 걸려도 앞 요청이 끝난 뒤 5초 후에만 다음 요청을 보내고, 결과를 모두 반영한다.
  requests.select('a');
  for (let round = 0; round < 3; round++) {
    assert.equal(pending.length, 1, `round ${round}: 진행 중 요청 1개`);
    await elapse(5000); assert.equal(pending.length, 1, '진행 중에는 다음 폴링을 시작하지 않는다');
    await elapse(1000); pending.shift()!.resolve(ok('a', round)); await settle();
    assert.equal(applied.at(-1), `a:${round}`, '느린 응답도 반영');
    await elapse(4999); assert.equal(pending.length, 0);
    await elapse(1);
  }
  assert.equal(maxInflight, 1);

  // 폴링 진행 중 작업 뒤 새로고침: 나중에 시작한 새로고침 결과를 앞선 폴링 결과가 덮어쓰지 못한다.
  const poll = pending.shift()!;
  const refresh = requests.reload();
  const action = pending.shift()!;
  action.resolve(ok('a', 7)); await refresh;
  poll.resolve(ok('a', 1)); await settle();
  assert.equal(applied.at(-1), 'a:7');
  // 앞선 폴링이 끝난 뒤에만 다음 폴링을 예약하고, 그 결과도 정상 반영한다.
  await elapse(5000);
  const nextPoll = pending.shift()!;
  nextPoll.resolve(ok('a', 2)); await settle();
  assert.equal(applied.at(-1), 'a:2');

  // 프로젝트 전환: 이전 프로젝트의 늦은 응답은 버리고 이전 폴링은 멈춘다.
  await elapse(5000);
  const stale = pending.shift()!;
  requests.select('b');
  const fresh = pending.shift()!;
  assert.equal(fresh.projectId, 'b');
  stale.resolve(ok('a', 9)); await settle();
  assert.notEqual(applied.at(-1), 'a:9');
  fresh.resolve(ok('b', 1)); await settle();
  assert.equal(applied.at(-1), 'b:1');
  await elapse(5000);
  assert.deepEqual(pending.map(item => item.projectId), ['b'], '이전 프로젝트 폴링은 다시 예약되지 않는다');

  // 실패도 반영하고 폴링은 계속되어 다음 성공으로 회복한다(요청 예외 포함).
  pending.shift()!.reject(new Error('down')); await settle();
  assert.equal(applied.at(-1), 'error:down');
  await elapse(5000);
  pending.shift()!.resolve(ok('b', 3)); await settle();
  assert.equal(applied.at(-1), 'b:3');

  // 화면 해제: 진행 중 결과를 버리고 더 이상 요청하지 않는다.
  await elapse(5000);
  const last = pending.shift()!;
  const before = applied.length;
  requests.select('');
  last.resolve(ok('b', 5)); await settle();
  await elapse(20000);
  assert.equal(applied.length, before);
  assert.equal(pending.length, 0);
  await requests.reload();
  assert.equal(pending.length, 0, '해제 뒤 새로고침은 요청하지 않는다');
});

test('프로젝트 범위 성과는 오래된 cohort와 revision 대체를 전역 계산과 똑같이 반영한다', t => {
  const { store } = openStore(t);
  for (const id of ['a', 'b']) store.put('project', id, project(id));
  const growth = growthOn(store);
  for (const id of ['a', 'b']) growth.savePolicy({ projectId: id, alpha: 0.05, multiplicity: 'holm', defaultStopping: 'fixed_horizon', freshnessHours: { 'google-ads': 48 }, fxMaxAgeHours: 48, variableCostRate: 0, allowPricingExperiments: false });
  const day = (offset: number) => iso(NOW - offset * 24 * HOUR).slice(0, 10);
  const fact = (id: string, projectId: string, extra: Partial<AttributionFact>): AttributionFact => ({ id, projectId, provider: 'google-ads', connectionId: 'ads', campaignId: 'c1', acquisitionDate: day(60),
    kind: 'spend', currency: 'USD', amountMicros: '1000000', eventDate: day(60), observedAt: iso(NOW - HOUR), collectedAt: iso(NOW - HOUR), sourceId: 'src-' + id, sourceWatermark: day(60), revision: 1, finality: 'settled', ...extra });
  const revenue = { kind: 'revenue' as const, revenueBasis: 'gross_conversion_value' as const, attributionWindowDays: 7, sourceId: 'rev-a' };
  const facts = [
    fact('spend-old', 'a', {}),
    fact('rev-1', 'a', { ...revenue, amountMicros: '500000', revision: 1 }),
    fact('rev-2', 'a', { ...revenue, amountMicros: '2000000', revision: 2, supersedes: 'rev-1' }),
    fact('spend-b', 'b', { amountMicros: '9000000', sourceId: 'src-b' }),
  ];
  for (const item of facts) store.put('attribution-fact', item.id, item);
  const scoped = growth.state('a').performance;
  assert.deepEqual(scoped, growth.state().performance.filter(item => item.projectId === 'a'));
  const report = scoped.find(item => item.currency === 'USD')!;
  assert.deepEqual(report.factIds, ['rev-2', 'spend-old'], '60일 전 cohort 포함, 대체된 revision 제외');
  assert.equal(report.attributedRevenueMicros, '2000000');
  assert.equal(report.spendMicros, '1000000', '다른 프로젝트 fact 제외');
});

test('결정 이력 페이지는 프로젝트·실험 소속을 확인하고 잘못된 커서를 거절한다', t => {
  const { store } = openStore(t);
  for (const id of ['a', 'b']) store.put('project', id, project(id));
  store.put('growth-experiment', 'e1', { id: 'e1', projectId: 'a' });
  store.put('growth-experiment', 'e2', { id: 'e2', projectId: 'a' });
  store.put('growth-experiment', 'eb', { id: 'eb', projectId: 'b' });
  const same = '2026-09-24T00:00:00.000Z';
  for (const id of ['x1', 'x2', 'x3', 'x4', 'x5']) store.put('growth-decision', id, decision(id, 'a', same, 'e1'));
  for (const id of ['y1', 'y2']) store.put('growth-decision', id, decision(id, 'a', same, 'e2'));
  store.put('growth-decision', 'z1', decision('z1', 'b', same, 'eb'));
  const growth = growthOn(store);
  const { ids } = allPages(before => { const page = growth.decisionPage({ projectId: 'a', experimentId: 'e1', limit: 2, ...(before ? { before: { at: before.value, id: before.id } } : {}) });
    return { ids: page.decisions.map(item => item.id), next: page.next && { value: page.next.at, id: page.next.id } }; });
  assert.deepEqual(ids, ['x5', 'x4', 'x3', 'x2', 'x1']);
  assert.deepEqual(growth.decisionPage({ projectId: 'a' }).decisions.map(item => item.id), ['y2', 'y1', 'x5', 'x4', 'x3', 'x2', 'x1']);
  assert.throws(() => growth.decisionPage({ projectId: 'a', experimentId: 'eb' }), { code: 'NOT_FOUND' }, '다른 프로젝트 실험');
  assert.throws(() => growth.decisionPage({ projectId: 'a', experimentId: 'missing' }), { code: 'NOT_FOUND' });
  assert.throws(() => growth.decisionPage({ projectId: 'missing' }), { code: 'NOT_FOUND' });
  for (const before of [{ at: '2026-09-24', id: 'x' }, { at: '2026-09-24T00:00:00Z', id: 'x' }, { at: 'not-a-date', id: 'x' }, { at: same }, { at: same, id: '' }, 'x5', [same, 'x5']])
    assert.throws(() => growth.decisionPage({ projectId: 'a', before }), { code: 'INVALID_INPUT' }, JSON.stringify(before));
  for (const limit of [0, 101, 1.5, '2']) assert.throws(() => growth.decisionPage({ projectId: 'a', limit }), { code: 'INVALID_INPUT' });
});

test('HTTP 계약: 프로젝트 범위 GET과 결정 이력 POST, 기존 전역 GET 호환', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'appops-query-controller-'));
  let key: Buffer | undefined;
  const keyProvider: KeyProvider = { name: 'test-memory', getKey: async () => key, setKey: async value => { key = value; } };
  const controller = await startController({ directory, port: 0, vault: new CredentialVault(join(directory, 'credentials'), { keyProvider }), connectors: [], scanToolchains: async () => [] });
  t.after(async () => { await controller.close(); await rm(directory, { recursive: true, force: true }); });
  const store = controller.service.store;
  for (const id of ['pa', 'pb']) store.put('project', id, project(id));
  store.put('growth-mandate', 'ma', { id: 'ma', projectId: 'pa', status: 'active' });
  store.put('growth-mandate', 'mb', { id: 'mb', projectId: 'pb', status: 'active' });
  store.put('growth-experiment', 'ea', { id: 'ea', projectId: 'pa' });
  for (const id of ['d1', 'd2', 'd3']) store.put('growth-decision', id, decision(id, 'pa', '2026-09-24T00:00:00.000Z', 'ea'));
  const call = async <T>(path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${controller.port}/api${path}`, { method, headers: { Authorization: 'Bearer ' + controller.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() as ApiResult<T> };
  };
  const data = <T>(result: { value: ApiResult<T> }) => { assert.equal(result.value.ok, true, JSON.stringify(result.value)); return (result.value as { ok: true; data: T }).data; };

  const scoped = data(await call<GrowthState>('/growth/projects/pa'));
  assert.equal(scoped.projectId, 'pa');
  assert.deepEqual(scoped.mandates.map(item => item.id), ['ma']);
  const global = data(await call<GrowthState>('/growth'));
  assert.deepEqual(global.mandates.map(item => item.id).sort(), ['ma', 'mb']);
  // query string은 범위 조건으로 쓰지 않는다(renderer는 경로 세그먼트만 사용).
  assert.equal(data(await call<GrowthState>('/growth?projectId=pa')).projectId, undefined);
  assert.equal((await call('/growth/projects/pa/extra')).status, 404);
  assert.equal((await call('/growth/projects/pa', 'POST', {})).value.ok, false);

  const first = data(await call<GrowthDecisionPage>('/growth/decisions/query', 'POST', { projectId: 'pa', experimentId: 'ea', limit: 2 }));
  assert.deepEqual(first.decisions.map(item => item.id), ['d3', 'd2']);
  const second = data(await call<GrowthDecisionPage>('/growth/decisions/query', 'POST', { projectId: 'pa', experimentId: 'ea', limit: 2, before: first.next }));
  assert.deepEqual(second.decisions.map(item => item.id), ['d1']);
  assert.equal(second.next, null);
  const wrong = await call('/growth/decisions/query', 'POST', { projectId: 'pb', experimentId: 'ea' });
  assert.equal(wrong.status, 404);
  const malformed = await call('/growth/decisions/query', 'POST', { projectId: 'pa', before: { at: 'yesterday', id: 'd1' } });
  assert.equal(malformed.status, 400);
  assert.equal((malformed.value as { ok: false; error: { code: string } }).error.code, 'INVALID_INPUT');
});

// 개발 스튜디오 공유 응답 DTO와 서버 구현 반환 타입의 연결(타입 검사에서 어긋나면 컴파일 오류).
type Returns<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
type Assignable<A, B> = [A] extends [B] ? true : false;
type Task = DevelopmentTasks;
export const developmentResponseContract = {
  repositories: true satisfies Assignable<Returns<typeof repositories>, DevelopmentResponses['repositories']>,
  items: true satisfies Assignable<Returns<typeof listItems>, DevelopmentResponses['items']>,
  gitState: true satisfies Assignable<Returns<typeof gitState>, DevelopmentResponses['git-state']>,
  policy: true satisfies Assignable<ReturnType<Task['policy']>, DevelopmentResponses['policy']>,
  policySave: true satisfies Assignable<ReturnType<Task['savePolicy']>, DevelopmentResponses['policy-save']>,
  import: true satisfies Assignable<Returns<Task['import']>, DevelopmentResponses['import']>,
  start: true satisfies Assignable<Returns<Task['start']>, DevelopmentResponses['analyze']>,
  commit: true satisfies Assignable<Returns<Task['commit']>, DevelopmentResponses['commit']>,
  push: true satisfies Assignable<Returns<Task['push']>, DevelopmentResponses['push']>,
  pr: true satisfies Assignable<Returns<Task['createPr']>, DevelopmentResponses['pr']>,
  cancel: true satisfies Assignable<Returns<Task['cancel']>, DevelopmentResponses['cancel']>,
  reconcilePush: true satisfies Assignable<Returns<Task['reconcilePush']>, DevelopmentResponses['reconcile-push']>,
  previewCheck: true satisfies Assignable<Returns<Task['inspectPreview']>, DevelopmentResponses['preview-check']>,
  cleanup: true satisfies Assignable<Returns<Task['cleanup']>, DevelopmentResponses['cleanup']>,
  document: true satisfies Assignable<Returns<Task['document']>, DevelopmentResponses['document']>,
  diff: true satisfies Assignable<Returns<Task['diff']>, DevelopmentResponses['git-diff']>,
} satisfies Record<string, true>;
