import test from 'node:test';
import assert from 'node:assert/strict';
import { approveRevision, createRevision, projectKnowledgeCandidates, retireRevision, searchKnowledge, validateCitations } from '../packages/growth/knowledge.js';
import type { KnowledgeRevision, ResponseDraft } from '../packages/growth/types.js';

const now = '2026-09-24T00:00:00.000Z';
const FAQ = '저장 데이터는 클라우드에 자동으로 백업됩니다.\n설정 > 계정 메뉴에서 수동 동기화를 할 수 있습니다.\nSave data is backed up to the cloud automatically.';
const faq = (existing: KnowledgeRevision[] = [], body = FAQ) => createRevision(existing, { projectId: 'p1', documentKey: 'faq', sourceKind: 'faq', title: 'FAQ', body }, now);
const approved = (body = FAQ) => approveRevision(faq([], body), [], now).approved;
const draft = (sentences: ResponseDraft['sentences']): ResponseDraft => ({ text: sentences.map(item => item.text).join(' '), sentences, language: 'ko' });

test('revisions version per document, hash the body and reuse identical content', () => {
  const first = faq();
  assert.equal(first.version, 1); assert.equal(first.status, 'draft'); assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.equal(faq([first]), first, 'identical body returns the current revision unchanged');
  const second = faq([first], FAQ + '\n새 항목');
  assert.equal(second.version, 2); assert.notEqual(second.id, first.id);
  const other = createRevision([first, second], { projectId: 'p1', documentKey: 'changelog', sourceKind: 'changelog', title: 'CHANGELOG', body: '1.2.0 fixes' }, now);
  assert.equal(other.version, 1);
});

test('secret-like bodies and oversized bodies are rejected', () => {
  for (const body of ['-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', 'Authorization: Bearer abcdefghijklmnop', 'api_key=sk_live_1234567890', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789']) {
    assert.throws(() => faq([], body), { code: 'KNOWLEDGE_SECRET' }, body);
  }
  assert.throws(() => faq([], 'a'.repeat(20_001)), { code: 'INVALID_KNOWLEDGE' });
});

test('approval retires the previous approved revision and stale drafts cannot be approved', () => {
  const v1 = approveRevision(faq(), [], now).approved;
  const v2 = faq([v1], FAQ + '\n추가');
  const { approved: a2, retired } = approveRevision(v2, [v1, v2], now);
  assert.equal(a2.status, 'approved'); assert.deepEqual(retired.map(item => [item.id, item.status]), [[v1.id, 'retired']]);
  assert.throws(() => approveRevision(retired[0]!, [a2, retired[0]!], now), { code: 'KNOWLEDGE_RETIRED' });
  const staleDraft = { ...v1, id: 'old-draft', status: 'draft' as const };
  assert.throws(() => approveRevision(staleDraft, [a2, staleDraft], now), { code: 'KNOWLEDGE_STALE' });
});

test('search returns only current approved revisions of the project with verbatim passages', () => {
  const current = approved();
  const draftOnly = createRevision([], { projectId: 'p1', documentKey: 'known', sourceKind: 'known_issue', title: '알려진 문제', body: '저장 오류가 있습니다.' }, now);
  const retired = retireRevision({ ...approved('저장 데이터는 사라질 수 있습니다.'), id: 'retired', documentKey: 'old' }, now);
  const foreign = { ...approved(), id: 'foreign', projectId: 'p2' };
  const hits = searchKnowledge([current, draftOnly, retired, foreign], 'p1', '저장 데이터 백업 되나요?');
  assert.deepEqual(hits.map(hit => hit.revision.id), [current.id]);
  assert.ok(hits[0]!.score > 0);
  assert.ok(hits[0]!.passages.length > 0 && hits[0]!.passages.every(passage => FAQ.includes(passage) && passage.length <= 300));
  assert.equal(hits[0]!.passages[0], '저장 데이터는 클라우드에 자동으로 백업됩니다.');
  assert.deepEqual(searchKnowledge([current], 'p1', 'cloud backup')[0]!.revision.id, current.id);
  assert.deepEqual(searchKnowledge([current], 'p1', '결제 환불'), []);
});

test('citations must be verbatim quotes from current approved same-project knowledge on every sentence', () => {
  const current = approved();
  const ok = draft([{ text: '저장 데이터는 자동으로 백업됩니다.', citations: [{ revisionId: current.id, quote: '저장 데이터는   클라우드에 자동으로 백업됩니다.' }] }]);
  assert.deepEqual(validateCitations(ok, [current], 'p1'), []);
  const cases: Array<[ResponseDraft, KnowledgeRevision[], RegExp]> = [
    [draft([...ok.sentences, { text: '곧 보상을 드립니다.', citations: [] }]), [current], /근거가 없습니다/],
    [draft([{ text: 'x', citations: [{ revisionId: current.id, quote: '저장 데이터는 영구 보존됩니다.' }] }]), [current], /일치하지 않습니다/],
    [draft([{ text: 'x', citations: [{ revisionId: 'ghost', quote: '저장 데이터는' }] }]), [current], /찾을 수 없습니다/],
    [ok, [retireRevision(current, now)], /현재 지식이 아닙니다/],
    [ok, [{ ...current, projectId: 'p2' }], /다른 프로젝트/],
    [draft([{ text: 'x', citations: [{ revisionId: current.id, quote: '저장' }] }]), [current], /너무 짧습니다/],
    [draft([{ text: 'x', citations: [{ revisionId: current.id, quote: FAQ.repeat(3) }] }]), [current], /300자/],
  ];
  for (const [value, revisions, pattern] of cases) assert.match(validateCitations(value, revisions, 'p1').join('\n'), pattern);
});

test('project candidates include only public docs and the listing, never hidden, credential or oversized files', () => {
  const { candidates, skipped } = projectKnowledgeCandidates({
    projectId: 'p1',
    listing: { title: 'Space Game', shortDescription: 'Shoot stars', fullDescription: 'Long description' },
    files: [
      { path: 'README.md', content: '# Game' }, { path: 'docs/FAQ.md', content: 'Q/A' }, { path: 'CHANGELOG.md', content: '## 1.2.0' },
      { path: 'SUPPORT.md', content: 'support@example.com' }, { path: 'docs/KNOWN_ISSUES.md', content: 'crash on boot' },
      { path: '.env', content: 'API_KEY=1' }, { path: '.github/README.md', content: 'hidden' }, { path: 'config/credentials.json', content: '{}' },
      { path: '../outside/README.md', content: 'x' }, { path: 'node_modules/pkg/README.md', content: 'x' }, { path: 'src/main.ts', content: 'code' },
      { path: 'docs/faq.txt', content: 'x'.repeat(200 * 1024 + 1) }, { path: 'FAQ.md', content: 'password: hunter2secret' },
    ],
  });
  assert.deepEqual(candidates.map(item => [item.documentKey, item.sourceKind]), [
    ['store-listing', 'store_listing'], ['file:README.md', 'analysis'], ['file:docs/FAQ.md', 'faq'], ['file:CHANGELOG.md', 'changelog'],
    ['file:SUPPORT.md', 'support_policy'], ['file:docs/KNOWN_ISSUES.md', 'known_issue'],
  ]);
  assert.deepEqual(skipped.map(item => [item.path, item.reason]), [
    ['.env', '숨김 경로'], ['.github/README.md', '숨김 경로'], ['config/credentials.json', '자격 증명 파일'], ['../outside/README.md', '프로젝트 밖 경로'],
    ['node_modules/pkg/README.md', '외부 패키지·빌드 경로'], ['src/main.ts', '허용된 공개 문서가 아님'], ['docs/faq.txt', '200KB 초과'], ['FAQ.md', '인증 정보로 보이는 값 포함'],
  ]);
  for (const candidate of candidates) assert.doesNotThrow(() => createRevision([], candidate, now));
});
