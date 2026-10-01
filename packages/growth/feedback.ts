// 피드백 정규화·설명 가능한 이슈 cluster·우선순위·제품 개선 링크. 네트워크·DB 없음.
import { AppError } from '../domain/errors.js';
import type { Provider } from '../domain/index.js';
import { guessLanguage, redactPii } from './community.js';
import { normalizeSpace, sha256, tokenize } from './knowledge.js';
import type { FeedbackItem, IssueCluster, IssuePriority, ProductExperimentLink, ResponseClassification } from './types.js';

const DAY = 86_400_000;
const invalid = (message: string, code = 'INVALID_FEEDBACK'): never => { throw new AppError(code, message); };

export interface FeedbackInput {
  projectId: string; provider: Provider; connectionId: string; interactionId: string;
  text: string; authorId: string; occurredAt: string; editedAt?: string; deleted?: boolean;
}

/** provider·계정·상호작용으로 정해지는 결정적 ID. 같은 상호작용 재수집은 같은 ID가 된다. */
export const feedbackId = (provider: Provider, connectionId: string, interactionId: string) => sha256(JSON.stringify([provider, connectionId, interactionId]));
export const dedupeKey = (item: FeedbackItem) => feedbackId(item.source.provider, item.source.connectionId, item.source.interactionId);

const SYMPTOMS: Array<[string, RegExp]> = [
  ['crash', /crash|튕김|튕겨|튕기|튕겼|강제\s?종료|꺼져|꺼짐|꺼지|落ちる|落ちた|落ちます|クラッシュ|強制終了/i],
  ['login', /로그인|log\s?in|sign\s?in|ログイン/i],
  ['purchase', /결제|구매|purchase|payment|billing|課金|購入|決済/i],
  ['save', /저장|세이브|\bsave|progress (?:lost|reset)|진행\S*\s?(?:사라|날아|초기화)|データが消え|セーブ/i],
  ['loading', /로딩|loading|load screen|ロード|読み込み/i],
  ['performance', /렉|랙|\blag|\bfps\b|프레임|stutter|버벅|重い|カクカク/i],
  ['ads', /광고|\bads?\b|advert|広告/i],
];
const PLATFORMS: Array<[string, RegExp]> = [
  ['android', /android|안드로이드|갤럭시|galaxy|pixel|アンドロイド/i], ['ios', /\bios\b|iphone|ipad|아이폰|아이패드|アイフォン/i],
  ['steam', /steam|스팀|steam deck/i], ['mac', /\bmac(?:os|book)?\b|맥북|맥os/i], ['windows', /windows|윈도우|\bwin1[01]\b/i], ['pc', /\bpc\b|컴퓨터|피씨/i],
];
const NEGATIVE = /안\s?돼|안\s?됨|싫|최악|짜증|문제|환불|hate|bad|terrible|worst|broken|annoying|ひどい|最悪|困る/i;
const POSITIVE = /좋아|좋네|최고|감사|재밌|재미있|love|great|awesome|thanks|fixed|nice|最高|ありがとう|楽しい/i;

function appVersion(text: string): string | undefined {
  const labelled = text.match(/(?:version|ver\.?|버전|バージョン)\s*v?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
  if (labelled) return labelled;
  const prefixed = text.match(/\bv(\d+\.\d+(?:\.\d+)?)\b/i)?.[1];
  if (prefixed) return prefixed;
  // 날짜·가격과 섞이지 않도록 major가 두 자리 이하인 bare 버전만 인정한다.
  return text.match(/(?<![\d.])(\d{1,2}\.\d{1,3}(?:\.\d{1,4})?)(?![\d.])/)?.[1];
}
function errorCode(text: string): string | undefined {
  const code = text.match(/\bE-?(\d{2,})\b/)?.[1];
  if (code) return 'E' + code;
  const hex = text.match(/\b0x[0-9a-f]{2,}\b/i)?.[0];
  if (hex) return hex.toLowerCase();
  const labelled = text.match(/(?:error\s?code|에러\s?코드|오류\s?코드|エラーコード)\s*[:#]?\s*([A-Za-z0-9-]{2,20})/i)?.[1];
  return labelled ? 'code:' + labelled.toUpperCase() : undefined;
}

/**
 * 공개 상호작용을 최소 데이터 FeedbackItem으로 바꾼다. 원문 대신 PII를 지운 200자 발췌와 해시만 남기고
 * 작성자는 호출자가 보관한 salt로 해시한다. 삭제된 상호작용은 발췌를 비운다.
 */
export function normalizeFeedback(input: FeedbackInput, classification: ResponseClassification, now: string, salt: string): FeedbackItem {
  if (!input.projectId || !input.connectionId || !input.interactionId || !input.authorId) invalid('피드백 출처 ID가 필요합니다.');
  if (!salt || salt.length < 8) invalid('작성자 해시 salt가 필요합니다.');
  if (!Number.isFinite(Date.parse(input.occurredAt))) invalid('피드백 발생 시각을 확인해 주세요.');
  const text = normalizeSpace(input.text ?? '');
  const folded = text.normalize('NFKC');
  const symptomKey = SYMPTOMS.find(([, pattern]) => pattern.test(folded))?.[0];
  const platform = PLATFORMS.find(([, pattern]) => pattern.test(folded))?.[0];
  const version = appVersion(folded); const code = errorCode(folded);
  const sentiment: FeedbackItem['sentiment'] = classification.intent === 'bug_report' || classification.intent === 'complaint' ? 'negative'
    : classification.intent === 'praise' ? 'positive'
    : NEGATIVE.test(folded) && !POSITIVE.test(folded) ? 'negative' : POSITIVE.test(folded) && !NEGATIVE.test(folded) ? 'positive' : 'neutral';
  return {
    id: feedbackId(input.provider, input.connectionId, input.interactionId), projectId: input.projectId,
    source: { provider: input.provider, connectionId: input.connectionId, interactionId: input.interactionId },
    excerpt: input.deleted ? '' : Array.from(normalizeSpace(redactPii(text))).slice(0, 200).join(''),
    textHash: sha256(text.normalize('NFKC').toLowerCase()), authorHash: sha256(salt + '\0' + input.authorId),
    language: guessLanguage(text),
    ...(version ? { appVersion: version } : {}), ...(platform ? { platform } : {}), ...(symptomKey ? { symptomKey } : {}), ...(code ? { errorCode: code } : {}),
    sentiment, intent: classification.intent, occurredAt: input.occurredAt,
    ...(input.editedAt ? { editedAt: input.editedAt } : {}), ...(input.deleted ? { deletedAt: now } : {}),
    createdAt: now, updatedAt: now,
  };
}

/** 같은 상호작용 재수집은 새 item을 만들지 않고 편집·삭제만 반영한다. 삭제는 되돌리지 않는다. */
export function upsertFeedback(existing: FeedbackItem[], incoming: FeedbackItem): { item: FeedbackItem; change: 'created' | 'updated' | 'unchanged' } {
  const key = dedupeKey(incoming);
  const previous = existing.find(item => dedupeKey(item) === key);
  if (!previous) return { item: incoming, change: 'created' };
  const deletedAt = previous.deletedAt ?? incoming.deletedAt;
  if (previous.textHash === incoming.textHash && Boolean(previous.deletedAt) === Boolean(deletedAt)) return { item: previous, change: 'unchanged' };
  // 삭제된 원문은 빈 본문으로 다시 들어오므로 파생 필드는 기존 값을 유지하고 발췌만 지운다.
  if (deletedAt) return { item: { ...previous, deletedAt, excerpt: '', updatedAt: incoming.updatedAt }, change: 'updated' };
  const item: FeedbackItem = {
    ...incoming, id: previous.id, createdAt: previous.createdAt, editedAt: incoming.editedAt ?? incoming.updatedAt,
    ...(previous.clusterId ? { clusterId: previous.clusterId } : {}),
  };
  return { item, change: 'updated' };
}

const ACTIVE: IssueCluster['status'][] = ['candidate', 'confirmed'];
const polarity = (item: FeedbackItem) => item.sentiment === 'positive' ? 'praise' : 'issue';
const clusterPolarity = (cluster: IssueCluster) => cluster.key.split('|')[0];
/** 자동 배정에 쓰는 설명 가능한 키. 오류 코드 또는 증상+플랫폼(+버전)이 없으면 자동 배정하지 않는다. */
export function explainableKey(item: FeedbackItem): { key: string; keyParts: IssueCluster['keyParts'] } | undefined {
  const side = polarity(item);
  if (item.errorCode) return { key: `${side}|error:${item.errorCode}`, keyParts: { errorCode: item.errorCode } };
  if (item.symptomKey && item.platform) {
    return { key: `${side}|symptom:${item.symptomKey}|platform:${item.platform}${item.appVersion ? '|version:' + item.appVersion : ''}`,
      keyParts: { symptomKey: item.symptomKey, platform: item.platform, ...(item.appVersion ? { appVersion: item.appVersion } : {}) } };
  }
  return undefined;
}
const titleFor = (parts: IssueCluster['keyParts'], item: FeedbackItem) => parts.errorCode ? `오류 ${parts.errorCode}`
  : parts.symptomKey ? [parts.symptomKey, parts.platform, parts.appVersion].filter(Boolean).join(' · ') : item.excerpt.slice(0, 60) || '분류 대기 피드백';
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let shared = 0; for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}
const emptyPriority = (): IssuePriority => ({ frequency: 0, affectedUsers: 0, revenueImpactMicros: null, severity: 'low', reproConfidence: 0, trend: 'new', strategicFit: 'unknown' });

/**
 * 아직 cluster에 없는 item을 설명 가능한 동일 키가 있을 때만 자동 배정한다. 키가 없으면 단독 candidate
 * cluster를 만들고 유사도(Jaccard ≥ 0.35) 후보만 기록한다. 칭찬과 문제 보고는 서로 병합하거나 제안하지 않는다.
 */
export function clusterFeedback(items: FeedbackItem[], clusters: IssueCluster[], now: string): { clusters: IssueCluster[]; items: FeedbackItem[] } {
  const next = clusters.map(cluster => ({ ...cluster, itemIds: [...cluster.itemIds], candidates: [...cluster.candidates], audit: [...cluster.audit] }));
  const byId = new Map(next.map(cluster => [cluster.id, cluster]));
  const itemsById = new Map(items.map(item => [item.id, item]));
  const touched = new Set<string>();
  const resolve = (cluster: IssueCluster | undefined) => {
    const seen = new Set<string>();
    while (cluster?.status === 'merged' && cluster.mergedInto && !seen.has(cluster.id)) { seen.add(cluster.id); cluster = byId.get(cluster.mergedInto); }
    return cluster && ACTIVE.includes(cluster.status) ? cluster : undefined;
  };
  const assigned = new Set(next.filter(cluster => ACTIVE.includes(cluster.status)).flatMap(cluster => cluster.itemIds));
  const updatedItems = new Map<string, FeedbackItem>();
  for (const item of [...items].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))) {
    if (item.deletedAt || assigned.has(item.id)) continue;
    const explained = explainableKey(item);
    const existing = explained && next.filter(cluster => cluster.projectId === item.projectId && cluster.key === explained.key).map(resolve).find(Boolean);
    let target: IssueCluster;
    if (existing) {
      target = existing; target.itemIds.push(item.id);
      target.audit.push({ at: now, action: 'added', reason: `동일 키 ${explained!.key}`, itemIds: [item.id] });
    } else {
      const key = explained?.key ?? `${polarity(item)}|item:${item.id}`;
      const keyParts = explained?.keyParts ?? {};
      target = { id: 'cl_' + sha256(JSON.stringify([item.projectId, key, item.id])).slice(0, 32), projectId: item.projectId, key, title: titleFor(keyParts, item),
        status: 'candidate', itemIds: [item.id], keyParts, candidates: [], priority: emptyPriority(),
        audit: [{ at: now, action: 'created', reason: explained ? `설명 가능한 키 ${key}` : '설명 가능한 키가 없어 단독 후보로 보류', itemIds: [item.id] }], createdAt: now, updatedAt: now };
      const tokens = new Set(tokenize(item.excerpt));
      for (const other of next) {
        if (other.projectId !== item.projectId || !ACTIVE.includes(other.status) || clusterPolarity(other) !== polarity(item)) continue;
        const similarity = Math.max(0, ...other.itemIds.map(id => itemsById.get(id)).filter(member => member && !member.deletedAt).map(member => jaccard(tokens, new Set(tokenize(member!.excerpt)))));
        if (similarity >= 0.35) target.candidates.push({ clusterId: other.id, similarity: Math.round(similarity * 100) / 100, reason: `발췌 토큰 Jaccard ${similarity.toFixed(2)} (자동 병합하지 않음)` });
      }
      next.push(target); byId.set(target.id, target);
    }
    target.updatedAt = now; touched.add(target.id); assigned.add(item.id);
    updatedItems.set(item.id, { ...item, clusterId: target.id, updatedAt: now });
  }
  const allItems = items.map(item => updatedItems.get(item.id) ?? item);
  for (const cluster of next) if (touched.has(cluster.id)) {
    cluster.priority = issuePriority(cluster, allItems, cluster.priority.revenueImpactMicros, now, cluster.priority.strategicFit);
  }
  return { clusters: next, items: allItems };
}

const requireActive = (cluster: IssueCluster) => { if (!ACTIVE.includes(cluster.status)) invalid('병합·분리·종료된 cluster는 바꿀 수 없습니다.', 'CLUSTER_INACTIVE'); };
const requireReason = (reason: string) => { if (!reason?.trim()) invalid('변경 사유를 입력해 주세요.'); return reason.trim(); };

/** 사람이 확인한 cluster로 표시한다. 제품 개선 링크는 확인된 cluster에만 만들 수 있다. */
export function confirmCluster(cluster: IssueCluster, reason: string, now: string): IssueCluster {
  requireActive(cluster);
  return { ...cluster, status: 'confirmed', audit: [...cluster.audit, { at: now, action: 'confirmed', reason: requireReason(reason) }], updatedAt: now };
}

/** source의 item을 target으로 옮긴다. source는 itemIds를 보존한 채 merged가 된다. 우선순위는 호출자가 다시 계산한다. */
export function mergeClusters(target: IssueCluster, source: IssueCluster, reason: string, now: string): { target: IssueCluster; source: IssueCluster } {
  const why = requireReason(reason); requireActive(target); requireActive(source);
  if (target.id === source.id || target.projectId !== source.projectId) invalid('같은 프로젝트의 서로 다른 cluster만 병합할 수 있습니다.');
  const moved = source.itemIds.filter(id => !target.itemIds.includes(id));
  return {
    target: { ...target, itemIds: [...target.itemIds, ...moved], candidates: target.candidates.filter(item => item.clusterId !== source.id),
      audit: [...target.audit, { at: now, action: 'merged', reason: `${source.id} 병합: ${why}`, itemIds: moved }], updatedAt: now },
    source: { ...source, status: 'merged', mergedInto: target.id, candidates: [],
      audit: [...source.audit, { at: now, action: 'merged', reason: `${target.id}로 병합: ${why}`, itemIds: [...source.itemIds] }], updatedAt: now },
  };
}

/** 일부 item을 새 수동 cluster로 분리한다. 새 cluster의 키는 자동 배정 대상이 아니다. */
export function splitCluster(cluster: IssueCluster, itemIds: string[], reason: string, now: string): { original: IssueCluster; created: IssueCluster } {
  const why = requireReason(reason); requireActive(cluster);
  const moving = [...new Set(itemIds)];
  if (!moving.length || moving.some(id => !cluster.itemIds.includes(id)) || moving.length >= cluster.itemIds.length) invalid('분리할 항목은 cluster 안의 일부여야 합니다.');
  const id = 'cl_' + sha256(JSON.stringify([cluster.id, [...moving].sort(), now])).slice(0, 32);
  return {
    original: { ...cluster, itemIds: cluster.itemIds.filter(item => !moving.includes(item)),
      audit: [...cluster.audit, { at: now, action: 'split', reason: `${id}로 분리: ${why}`, itemIds: moving }], updatedAt: now },
    created: { id, projectId: cluster.projectId, key: `${clusterPolarity(cluster)}|manual:${id}`, title: `${cluster.title} (분리)`, status: 'candidate',
      itemIds: moving, keyParts: {}, candidates: [], priority: emptyPriority(),
      audit: [{ at: now, action: 'created', reason: `${cluster.id}에서 분리: ${why}`, itemIds: moving }], createdAt: now, updatedAt: now },
  };
}

const HIGH_SYMPTOMS = ['crash', 'login']; const CRITICAL_SYMPTOMS = ['purchase', 'save']; const MEDIUM_SYMPTOMS = ['loading', 'performance'];
/** 우선순위 차원을 각각 계산한다. 하나의 합성 점수는 만들지 않는다. */
export function issuePriority(cluster: IssueCluster, items: FeedbackItem[], revenueImpactMicros: string | null, now: string, strategicFit: IssuePriority['strategicFit'] = 'unknown'): IssuePriority {
  if (revenueImpactMicros !== null && !/^-?\d+$/.test(revenueImpactMicros)) invalid('매출 영향은 정수 마이크로 문자열이어야 합니다.');
  const members = items.filter(item => cluster.itemIds.includes(item.id) && !item.deletedAt);
  const symptomCounts = new Map<string, number>();
  for (const item of members) if (item.symptomKey) symptomCounts.set(item.symptomKey, (symptomCounts.get(item.symptomKey) ?? 0) + 1);
  const symptom = cluster.keyParts.symptomKey ?? [...symptomCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const hasCode = Boolean(cluster.keyParts.errorCode) || members.some(item => item.errorCode);
  const severity: IssuePriority['severity'] = symptom && CRITICAL_SYMPTOMS.includes(symptom) ? 'critical'
    : symptom && HIGH_SYMPTOMS.includes(symptom) ? 'high' : (symptom && MEDIUM_SYMPTOMS.includes(symptom)) || hasCode ? 'medium' : 'low';
  const reproConfidence = members.length ? Math.round(members.reduce((sum, item) => sum + (item.errorCode ? 0.5 : 0) + (item.appVersion ? 0.5 : 0), 0) / members.length * 100) / 100 : 0;
  const at = Date.parse(now);
  const recent = members.filter(item => { const t = Date.parse(item.occurredAt); return t >= at - 7 * DAY && t < at; }).length;
  const previous = members.filter(item => { const t = Date.parse(item.occurredAt); return t >= at - 14 * DAY && t < at - 7 * DAY; }).length;
  const older = members.some(item => Date.parse(item.occurredAt) < at - 7 * DAY);
  const trend: IssuePriority['trend'] = !older && recent > 0 ? 'new' : previous === 0 ? (recent > 0 ? 'rising' : 'stable')
    : recent >= previous * 1.5 ? 'rising' : recent <= previous * 0.67 ? 'falling' : 'stable';
  return { frequency: members.length, affectedUsers: new Set(members.map(item => item.authorHash)).size, revenueImpactMicros, severity, reproConfidence, trend, strategicFit };
}

/** 확인된 cluster에 제품 변경 가설을 제안한다. previous는 원복·재출시 계보다. */
export function proposeLink(cluster: IssueCluster, hypothesis: string, now: string, previous?: ProductExperimentLink): ProductExperimentLink {
  if (cluster.status !== 'confirmed') invalid('사람이 확인한 cluster에만 제품 개선 가설을 연결할 수 있습니다.', 'CLUSTER_NOT_CONFIRMED');
  const text = hypothesis?.trim();
  if (!text || text.length > 1000) invalid('제품 개선 가설은 1~1000자여야 합니다.');
  if (previous && (previous.clusterId !== cluster.id || !['rolled_back', 'concluded'].includes(previous.status))) invalid('이전 링크는 같은 cluster의 종료·원복된 링크여야 합니다.');
  return { id: 'pl_' + sha256(JSON.stringify([cluster.id, text, now, previous?.id ?? null])).slice(0, 32), projectId: cluster.projectId, clusterId: cluster.id,
    hypothesis: text, status: 'proposed', ...(previous ? { previousLinkId: previous.id } : {}), createdAt: now, updatedAt: now };
}

/** 개발·출시 연결 전에 반드시 필요한 사람 승인. */
export function approveLink(link: ProductExperimentLink, note: string, now: string): ProductExperimentLink {
  if (link.status !== 'proposed') invalid('제안 상태의 링크만 승인할 수 있습니다.', 'PRODUCT_LINK_STATE');
  return { ...link, status: 'approved', approvedAt: now, approvalNote: requireReason(note), updatedAt: now };
}

export function attachRelease(link: ProductExperimentLink, observation: { id: string; version: string; publishedAt: string }, now: string): ProductExperimentLink {
  if (link.status !== 'approved' || !link.approvedAt) invalid('승인된 제품 개선 링크에만 출시를 연결할 수 있습니다.', 'PRODUCT_LINK_NOT_APPROVED');
  if (!observation.id || !observation.version || !Number.isFinite(Date.parse(observation.publishedAt))) invalid('출시 관측 정보를 확인해 주세요.');
  if (Date.parse(observation.publishedAt) < Date.parse(link.approvedAt!)) invalid('승인 전에 나간 출시는 이 개선의 결과로 연결할 수 없습니다.', 'PRODUCT_LINK_RELEASE_BEFORE_APPROVAL');
  return { ...link, status: 'released', releaseVersion: observation.version, releaseObservationId: observation.id, releasedAt: observation.publishedAt, updatedAt: now };
}

export function rollbackLink(link: ProductExperimentLink, note: string, now: string): ProductExperimentLink {
  if (!['released', 'observing', 'concluded'].includes(link.status)) invalid('출시된 링크만 원복으로 표시할 수 있습니다.', 'PRODUCT_LINK_STATE');
  const why = requireReason(note);
  return { ...link, status: 'rolled_back', result: link.result ? { ...link.result, note: `${link.result.note} / 원복: ${why}` } : undefined, updatedAt: now };
}

const compareVersion = (a: string, b: string) => {
  const left = a.split('.').map(Number); const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) { const diff = (left[index] ?? 0) - (right[index] ?? 0); if (diff) return diff; }
  return 0;
};
/**
 * 출시 전후 같은 길이 창의 부정 피드백 수를 비교한다. 버전으로 cohort를 가를 수 없거나 창 안에 다른 출시가 있으면
 * mixedCohort로 표시한다. 관찰 비교이며 인과 효과로 해석하지 않는다.
 */
export function observeLink(link: ProductExperimentLink, cluster: IssueCluster, items: FeedbackItem[], now: string, windowDays: number, otherReleases: Array<{ version: string; publishedAt: string }> = []): ProductExperimentLink {
  if (!['released', 'observing'].includes(link.status) || !link.releasedAt || !link.releaseVersion) invalid('출시가 연결된 링크만 관찰할 수 있습니다.', 'PRODUCT_LINK_STATE');
  if (link.clusterId !== cluster.id) invalid('링크와 cluster가 다릅니다.');
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) invalid('관찰 창은 1~90일이어야 합니다.');
  const release = Date.parse(link.releasedAt!); const span = windowDays * DAY;
  const members = new Set(cluster.itemIds); const parts = cluster.keyParts;
  const matches = (item: FeedbackItem) => item.projectId === cluster.projectId && !item.deletedAt && item.sentiment === 'negative' && (
    parts.errorCode ? item.errorCode === parts.errorCode
      : parts.symptomKey ? item.symptomKey === parts.symptomKey && (!parts.platform || item.platform === parts.platform)
      : members.has(item.id));
  const inWindow = (item: FeedbackItem, from: number, to: number) => { const t = Date.parse(item.occurredAt); return t >= from && t < to; };
  const before = items.filter(item => matches(item) && inWindow(item, release - span, release));
  const after = items.filter(item => matches(item) && inWindow(item, release, release + span));
  const reasons: string[] = [];
  if ([...before, ...after].some(item => !item.appVersion)) reasons.push('버전 정보가 없는 피드백이 있어 출시 전후 cohort를 분리할 수 없습니다');
  if (after.some(item => item.appVersion && compareVersion(item.appVersion, link.releaseVersion!) < 0)) reasons.push('출시 후 창에 이전 버전 사용자의 피드백이 섞여 있습니다');
  if (otherReleases.some(other => other.version !== link.releaseVersion && Math.abs(Date.parse(other.publishedAt) - release) < span)) reasons.push('관찰 창 안에 다른 출시가 있습니다');
  const complete = Date.parse(now) >= release + span;
  const iso = (t: number) => new Date(t).toISOString();
  return {
    ...link, status: complete ? 'concluded' : 'observing',
    baseline: { from: iso(release - span), to: link.releasedAt! }, observation: { from: link.releasedAt!, to: iso(release + span) },
    result: { negativeFeedbackBefore: before.length, negativeFeedbackAfter: after.length, mixedCohort: reasons.length > 0,
      note: [complete ? '관찰 창 완료' : '관찰 창 진행 중', ...reasons, '관찰 비교이며 인과 효과가 아닙니다'].join('. ') },
    updatedAt: now,
  };
}
