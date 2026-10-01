import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyByRules } from '../packages/growth/community.js';
import { approveLink, attachRelease, clusterFeedback, confirmCluster, dedupeKey, issuePriority, mergeClusters, normalizeFeedback, observeLink, proposeLink, rollbackLink, splitCluster, upsertFeedback, type FeedbackInput } from '../packages/growth/feedback.js';
import type { FeedbackItem, IssueCluster } from '../packages/growth/types.js';

const now = '2026-09-24T00:00:00.000Z';
const SALT = 'project-salt-123';
let sequence = 0;
const feedback = (text: string, patch: Partial<FeedbackInput> = {}): FeedbackItem => {
  const input: FeedbackInput = { projectId: 'p1', provider: 'x', connectionId: 'x-conn', interactionId: `t${++sequence}`, text, authorId: `user${sequence}`, occurredAt: '2026-09-20T00:00:00.000Z', ...patch };
  return normalizeFeedback(input, classifyByRules(text), now, SALT);
};

test('normalization keeps a PII-free excerpt, hashes and explainable fields', () => {
  const item = feedback('@dev 안드로이드 버전 1.2.3 에서 로그인하면 튕겨요 E-1234, 연락은 me@mail.com 010-1234-5678 카드 4111-1111-1111-1111', { authorId: 'secret-user' });
  assert.doesNotMatch(item.excerpt, /me@mail|010-1234|4111|@dev|secret-user/);
  assert.ok(Array.from(item.excerpt).length <= 200);
  assert.equal(item.appVersion, '1.2.3'); assert.equal(item.platform, 'android'); assert.equal(item.errorCode, 'E1234'); assert.equal(item.symptomKey, 'crash');
  assert.equal(item.language, 'ko'); assert.equal(item.sentiment, 'negative'); assert.equal(item.intent, 'bug_report');
  assert.match(item.authorHash, /^[0-9a-f]{64}$/); assert.doesNotMatch(JSON.stringify(item), /secret-user/);
  assert.notEqual(normalizeFeedback({ projectId: 'p1', provider: 'x', connectionId: 'c', interactionId: 'i', text: 'x', authorId: 'secret-user', occurredAt: now }, classifyByRules('x'), now, 'other-salt-999').authorHash, item.authorHash);
  const english = feedback('Game crashes on iPhone with error code 0x8badf00d since v2.0');
  assert.deepEqual([english.platform, english.errorCode, english.appVersion, english.symptomKey, english.language], ['ios', '0x8badf00d', '2.0', 'crash', 'en']);
  const japanese = feedback('Steamで起動するとクラッシュします');
  assert.deepEqual([japanese.platform, japanese.symptomKey, japanese.language], ['steam', 'crash', 'ja']);
  assert.equal(feedback('2026.09.24 이벤트 좋아요').appVersion, undefined, 'dates are not versions');
  assert.throws(() => normalizeFeedback({ projectId: 'p1', provider: 'x', connectionId: 'c', interactionId: 'i', text: 'x', authorId: 'a', occurredAt: now }, classifyByRules('x'), now, ''), { code: 'INVALID_FEEDBACK' });
});

test('re-ingesting the same interaction updates edits and deletions instead of duplicating', () => {
  const input: FeedbackInput = { projectId: 'p1', provider: 'threads', connectionId: 'th', interactionId: 'post-9', text: '로딩이 길어요', authorId: 'u', occurredAt: now };
  const first = normalizeFeedback(input, classifyByRules(input.text), now, SALT);
  const again = normalizeFeedback(input, classifyByRules(input.text), '2026-09-24T01:00:00.000Z', SALT);
  assert.equal(again.id, first.id); assert.equal(dedupeKey(again), dedupeKey(first));
  assert.equal(upsertFeedback([first], again).change, 'unchanged');
  const edited = normalizeFeedback({ ...input, text: 'Android에서 로딩이 너무 길어요', editedAt: '2026-09-24T02:00:00.000Z' }, classifyByRules('로딩'), '2026-09-24T02:00:00.000Z', SALT);
  const update = upsertFeedback([{ ...first, clusterId: 'cl' }], edited);
  assert.equal(update.change, 'updated'); assert.equal(update.item.id, first.id); assert.equal(update.item.createdAt, now);
  assert.equal(update.item.clusterId, 'cl'); assert.equal(update.item.editedAt, '2026-09-24T02:00:00.000Z'); assert.equal(update.item.platform, 'android');
  const deleted = normalizeFeedback({ ...input, text: '', deleted: true }, classifyByRules(''), '2026-09-24T03:00:00.000Z', SALT);
  const removal = upsertFeedback([update.item], deleted);
  assert.equal(removal.item.deletedAt, '2026-09-24T03:00:00.000Z'); assert.equal(removal.item.excerpt, ''); assert.equal(removal.item.symptomKey, 'loading');
  assert.equal(upsertFeedback([removal.item], again).item.deletedAt, removal.item.deletedAt, 'deletion is sticky');
});

test('clusters auto-assign only on exact explainable keys and keep ambiguous items as candidates', () => {
  const ko = feedback('안드로이드 1.2.0 에서 튕겨요 E-1234', { authorId: 'same' });
  const en = feedback('Android app crashes E1234', { authorId: 'same' });
  const v1 = feedback('Android 1.2.0 버전 로딩이 멈춰요');
  const v2 = feedback('Android 1.3.0 버전 로딩이 멈춰요');
  const vagueA = feedback('게임 진행이 이상하게 안 됩니다 계속 안 됩니다');
  const vagueB = feedback('게임 진행이 이상하게 안 됩니다 도와주세요');
  const praise = feedback('Android 1.2.0 버전 로딩 빨라져서 정말 최고예요 감사합니다');
  const gone = { ...feedback('Android crash E1234'), deletedAt: now };
  const { clusters, items } = clusterFeedback([ko, en, v1, v2, vagueA, vagueB, praise, gone], [], now);
  const byItem = (item: FeedbackItem) => clusters.find(cluster => cluster.itemIds.includes(item.id))!;
  assert.equal(byItem(ko).id, byItem(en).id, 'multilingual duplicates share the error code cluster');
  assert.equal(byItem(ko).priority.affectedUsers, 1); assert.equal(byItem(ko).priority.frequency, 2);
  assert.notEqual(byItem(v1).id, byItem(v2).id, 'different versions are not merged');
  assert.notEqual(byItem(vagueA).id, byItem(vagueB).id, 'ambiguous similar text is not auto-merged');
  assert.equal(byItem(vagueB).status, 'candidate');
  assert.ok(byItem(vagueB).candidates.some(candidate => candidate.clusterId === byItem(vagueA).id && candidate.similarity >= 0.35));
  assert.notEqual(byItem(praise).id, byItem(v1).id, 'praise never joins the bug cluster');
  assert.ok(clusters.every(cluster => cluster.candidates.every(candidate => candidate.clusterId !== byItem(praise).id) || cluster.id === byItem(praise).id));
  assert.equal(clusters.some(cluster => cluster.itemIds.includes(gone.id)), false, 'deleted items are not clustered');
  assert.equal(items.find(item => item.id === en.id)!.clusterId, byItem(ko).id);
  for (const cluster of clusters) assert.ok(cluster.audit.length >= 1 && cluster.audit.every(entry => entry.reason));
  // 재실행은 같은 item을 다시 배정하지 않는다.
  const rerun = clusterFeedback(items, clusters, now);
  assert.deepEqual(rerun.clusters.map(cluster => cluster.itemIds), clusters.map(cluster => cluster.itemIds));
});

test('merge and split keep source item ids and an audit trail; merged keys route new items to the target', () => {
  const a = feedback('iOS 저장이 안 돼요 2.0.0 버전'); const b = feedback('iOS 세이브 날아감 v2.0.1'); const c = feedback('iOS 2.0.1 버전 저장 문제');
  const first = clusterFeedback([a, b, c], [], now).clusters;
  const target = first.find(cluster => cluster.itemIds.includes(a.id))!; const source = first.find(cluster => cluster.itemIds.includes(b.id))!;
  assert.throws(() => mergeClusters(target, source, ' ', now), { code: 'INVALID_FEEDBACK' });
  const merged = mergeClusters(target, source, '같은 저장 손실 문제', now);
  assert.deepEqual(merged.target.itemIds, [a.id, b.id, c.id]); assert.equal(merged.source.status, 'merged'); assert.equal(merged.source.mergedInto, target.id);
  assert.deepEqual(merged.source.itemIds, source.itemIds); assert.equal(merged.target.audit.at(-1)!.action, 'merged');
  const later = feedback('iOS v2.0.1 저장 실패', { occurredAt: '2026-09-23T00:00:00.000Z' });
  const routed = clusterFeedback([a, b, c, later], [merged.target, merged.source], now).clusters;
  assert.ok(routed.find(cluster => cluster.id === target.id)!.itemIds.includes(later.id));
  const { original, created } = splitCluster(merged.target, [c.id], '다른 원인으로 확인', now);
  assert.deepEqual(original.itemIds, [a.id, b.id]); assert.deepEqual(created.itemIds, [c.id]);
  assert.equal(original.audit.at(-1)!.action, 'split'); assert.deepEqual(original.audit.at(-1)!.itemIds, [c.id]);
  assert.match(created.key, /\|manual:/); assert.throws(() => splitCluster(merged.target, merged.target.itemIds, 'all', now), { code: 'INVALID_FEEDBACK' });
  assert.throws(() => mergeClusters(merged.source, merged.target, 'again', now), { code: 'CLUSTER_INACTIVE' });
});

test('priority exposes each dimension separately', () => {
  const recent = [1, 2, 3].map(day => feedback('Android 1.0.0 결제 실패 purchase error E-500', { occurredAt: `2026-09-2${day}T00:00:00.000Z`, authorId: 'u' + (day % 2) }));
  const old = feedback('Android 1.0.0 결제 실패 E-500', { occurredAt: '2026-09-12T00:00:00.000Z' });
  const cluster = clusterFeedback([...recent, old], [], now).clusters[0]!;
  const priority = issuePriority(cluster, [...recent, old], '1250000', now, 'high');
  assert.deepEqual(priority, { frequency: 4, affectedUsers: 3, revenueImpactMicros: '1250000', severity: 'critical', reproConfidence: 1, trend: 'rising', strategicFit: 'high' });
  assert.equal(issuePriority(cluster, recent, null, now).trend, 'new');
  assert.equal(issuePriority(cluster, recent, null, now).strategicFit, 'unknown');
  assert.throws(() => issuePriority(cluster, recent, '1.5', now), { code: 'INVALID_FEEDBACK' });
});

test('product links require confirmation and approval before a release, and flag mixed cohorts', () => {
  const release = '2026-09-10T00:00:00.000Z';
  const before = [1, 2, 3].map(day => feedback('Android 1.1.0 에서 튕겨요', { occurredAt: `2026-09-0${day + 5}T00:00:00.000Z` }));
  const after = [feedback('Android 1.2.0 에서 튕겨요', { occurredAt: '2026-09-12T00:00:00.000Z' })];
  const cluster = clusterFeedback(before, [], now).clusters[0]!;
  assert.throws(() => proposeLink(cluster, '로딩 최적화', now), { code: 'CLUSTER_NOT_CONFIRMED' });
  const confirmed = confirmCluster(cluster, '운영자 확인', '2026-09-08T00:00:00.000Z');
  const proposed = proposeLink(confirmed, '초기화 순서를 바꾸면 크래시가 줄어든다', '2026-09-08T00:00:00.000Z');
  const observation = { id: 'obs-1', version: '1.2.0', publishedAt: release };
  assert.throws(() => attachRelease(proposed, observation, now), { code: 'PRODUCT_LINK_NOT_APPROVED' });
  const lateApproval = approveLink(proposed, '개발 승인', '2026-09-11T00:00:00.000Z');
  assert.throws(() => attachRelease(lateApproval, observation, now), { code: 'PRODUCT_LINK_RELEASE_BEFORE_APPROVAL' });
  const released = attachRelease(approveLink(proposed, '개발 승인', '2026-09-09T00:00:00.000Z'), observation, '2026-09-10T00:00:00.000Z');
  assert.equal(released.status, 'released');
  const all = [...before, ...after];
  const clean = observeLink(released, confirmed, all, '2026-09-15T00:00:00.000Z', 5);
  assert.equal(clean.status, 'concluded'); assert.deepEqual(clean.result && [clean.result.negativeFeedbackBefore, clean.result.negativeFeedbackAfter, clean.result.mixedCohort], [3, 1, false]);
  assert.deepEqual(clean.baseline, { from: '2026-09-05T00:00:00.000Z', to: release });
  assert.equal(observeLink(released, confirmed, all, '2026-09-12T00:00:00.000Z', 5).status, 'observing');
  const oldUser = feedback('Android 1.1.0 에서 튕겨요', { occurredAt: '2026-09-13T00:00:00.000Z' });
  assert.equal(observeLink(released, confirmed, [...all, oldUser], '2026-09-15T00:00:00.000Z', 5).result!.mixedCohort, true);
  const noVersion = feedback('Android 튕겨요', { occurredAt: '2026-09-13T00:00:00.000Z' });
  assert.equal(observeLink(released, confirmed, [...all, noVersion], '2026-09-15T00:00:00.000Z', 5).result!.mixedCohort, true);
  const hotfix = observeLink(released, confirmed, all, '2026-09-15T00:00:00.000Z', 5, [{ version: '1.2.1', publishedAt: '2026-09-12T00:00:00.000Z' }]);
  assert.equal(hotfix.result!.mixedCohort, true); assert.match(hotfix.result!.note, /다른 출시/);
  const rolledBack = rollbackLink(clean, '신규 크래시로 원복', now);
  const retry = proposeLink(confirmed, '초기화 순서 변경 재시도', now, rolledBack);
  assert.equal(retry.previousLinkId, rolledBack.id); assert.equal(retry.status, 'proposed');
  assert.throws(() => proposeLink(confirmed, 'x', now, released), { code: 'INVALID_FEEDBACK' });
});

test('clusters are project scoped', () => {
  const mine = feedback('Android crash E-777'); const theirs = feedback('Android crash E-777', { projectId: 'p2' });
  const { clusters } = clusterFeedback([mine, theirs], [], now);
  assert.equal(clusters.length, 2); assert.ok(clusters.every((cluster: IssueCluster) => cluster.itemIds.length === 1));
});
