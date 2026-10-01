// 고객응대 답변의 근거가 되는 지식 revision 수명주기·검색·인용 검증. 네트워크·DB 없음.
import { createHash } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import type { Citation, KnowledgeRevision, KnowledgeSource, ResponseDraft } from './types.js';

export const MAX_KNOWLEDGE_CHARS = 20_000;
export const MAX_QUOTE_CHARS = 300;
/** 너무 짧은 인용은 어떤 본문에도 우연히 포함되므로 근거로 인정하지 않는다. */
export const MIN_QUOTE_CHARS = 4;
const MAX_SOURCE_BYTES = 200 * 1024;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const normalizeSpace = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();

// domain/errors.ts의 redact 패턴과 같은 비밀값 모양에 흔한 토큰 접두사를 더했다. 치환이 아닌 감지 용도다.
const SECRET_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret[-_]?key)\s*[=:]\s*[^\s,&"']{6,}/i,
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{35}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
];
export const containsSecret = (value: string) => SECRET_PATTERNS.some(pattern => pattern.test(value));

const CJK = String.raw`\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー`;
const TOKEN = new RegExp(`[${CJK}]+|[^\\s\\p{P}\\p{S}${CJK}]+`, 'gu');
const CJK_START = new RegExp(`^[${CJK}]`, 'u');
/** 한글·가나·한자 연속 구간은 문자 bigram, 그 외 문자는 소문자 단어로 나눈다. */
export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  for (const [run] of value.normalize('NFKC').toLowerCase().matchAll(TOKEN)) {
    if (!CJK_START.test(run)) { tokens.push(run); continue; }
    const chars = Array.from(run);
    if (chars.length === 1) tokens.push(run);
    for (let index = 0; index < chars.length - 1; index++) tokens.push(chars[index]! + chars[index + 1]!);
  }
  return tokens;
}

export interface KnowledgeInput { projectId: string; documentKey: string; sourceKind: KnowledgeSource; title: string; body: string; sourceRef?: string }
const SOURCE_KINDS: KnowledgeSource[] = ['store_listing', 'faq', 'support_policy', 'changelog', 'known_issue', 'analysis'];
const invalid = (message: string, code = 'INVALID_KNOWLEDGE'): never => { throw new AppError(code, message); };

/** 새 draft revision을 만든다. 같은 문서의 최신 유효 revision과 내용이 같으면 그 revision을 그대로 돌려준다. */
export function createRevision(existing: KnowledgeRevision[], input: KnowledgeInput, now: string): KnowledgeRevision {
  const projectId = input.projectId?.trim(); const documentKey = input.documentKey?.trim(); const title = input.title?.trim();
  if (!projectId || !documentKey || documentKey.length > 200) invalid('프로젝트와 문서 키를 확인해 주세요.');
  if (!SOURCE_KINDS.includes(input.sourceKind)) invalid('지식 출처 종류를 확인해 주세요.');
  if (!title || title.length > 200) invalid('지식 제목은 1~200자여야 합니다.');
  const body = input.body?.trim();
  if (!body) invalid('지식 본문이 비어 있습니다.');
  if (body.length > MAX_KNOWLEDGE_CHARS) invalid(`지식 본문은 ${MAX_KNOWLEDGE_CHARS.toLocaleString()}자 이하여야 합니다.`);
  if (containsSecret(body) || containsSecret(title)) invalid('인증 정보로 보이는 값이 있어 지식으로 저장하지 않습니다.', 'KNOWLEDGE_SECRET');
  const hash = sha256(body);
  const siblings = existing.filter(item => item.projectId === projectId && item.documentKey === documentKey);
  const current = siblings.filter(item => item.status !== 'retired').sort((a, b) => b.version - a.version)[0];
  if (current && current.sha256 === hash && current.title === title && current.sourceKind === input.sourceKind) return current;
  const version = Math.max(0, ...siblings.map(item => item.version)) + 1;
  return {
    id: 'kr_' + sha256(JSON.stringify([projectId, documentKey, version])).slice(0, 32), projectId, documentKey, version,
    sourceKind: input.sourceKind, title, body, sha256: hash, ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    status: 'draft', createdAt: now,
  };
}

/** revision을 승인하고 같은 문서의 기존 승인 revision을 폐기한다. 호출자는 반환된 모든 record를 한 batch로 저장한다. */
export function approveRevision(revision: KnowledgeRevision, all: KnowledgeRevision[], now: string): { approved: KnowledgeRevision; retired: KnowledgeRevision[] } {
  if (revision.status === 'retired') invalid('폐기된 지식은 다시 승인할 수 없습니다. 새 revision을 만들어 주세요.', 'KNOWLEDGE_RETIRED');
  const siblings = all.filter(item => item.id !== revision.id && item.projectId === revision.projectId && item.documentKey === revision.documentKey);
  if (siblings.some(item => item.status === 'approved' && item.version > revision.version)) invalid('더 최신 승인본이 있어 이전 revision을 승인할 수 없습니다.', 'KNOWLEDGE_STALE');
  const approved: KnowledgeRevision = revision.status === 'approved' ? revision : { ...revision, status: 'approved', approvedAt: now };
  const retired = siblings.filter(item => item.status === 'approved').map(item => retireRevision(item, now));
  return { approved, retired };
}

export function retireRevision(revision: KnowledgeRevision, now: string): KnowledgeRevision {
  return revision.status === 'retired' ? revision : { ...revision, status: 'retired', retiredAt: now };
}

/** 승인되어 있고 같은 문서에 더 최신 승인본이 없는 revision. */
function isCurrent(revision: KnowledgeRevision, all: KnowledgeRevision[]): boolean {
  return revision.status === 'approved' && !all.some(item => item.id !== revision.id && item.status === 'approved'
    && item.projectId === revision.projectId && item.documentKey === revision.documentKey && item.version > revision.version);
}

export interface KnowledgeHit { revision: KnowledgeRevision; passages: string[]; score: number }
const sentences = (body: string) => body.split(/(?<=[.!?。！？])\s+|\n+/).map(item => item.trim()).filter(Boolean);

/** 프로젝트의 현재 승인 revision만 BM25로 검색한다. passage는 본문의 원문 부분 문자열이라 그대로 인용할 수 있다. */
export function searchKnowledge(revisions: KnowledgeRevision[], projectId: string, query: string, limit = 5): KnowledgeHit[] {
  const docs = revisions.filter(item => item.projectId === projectId && isCurrent(item, revisions))
    .map(revision => ({ revision, tokens: tokenize(revision.title + '\n' + revision.body) }));
  const terms = [...new Set(tokenize(query))];
  if (!docs.length || !terms.length) return [];
  const averageLength = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / docs.length || 1;
  const k1 = 1.2; const b = 0.75;
  const idf = new Map(terms.map(term => {
    const df = docs.filter(doc => doc.tokens.includes(term)).length;
    return [term, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))];
  }));
  const termSet = new Set(terms);
  return docs.map(({ revision, tokens }) => {
    const counts = new Map<string, number>();
    for (const token of tokens) if (termSet.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const [term, frequency] of counts) score += idf.get(term)! * frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * tokens.length / averageLength));
    const passages = sentences(revision.body)
      .map((text, order) => ({ text: text.slice(0, MAX_QUOTE_CHARS), order, hits: new Set(tokenize(text).filter(token => termSet.has(token))).size }))
      .filter(item => item.hits > 0).sort((a, b) => b.hits - a.hits || a.order - b.order).slice(0, 3).map(item => item.text);
    return { revision, passages, score: Math.round(score * 1000) / 1000 };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(0, limit));
}

/** 모든 문장이 현재 승인된 같은 프로젝트 지식의 원문 인용을 하나 이상 갖는지 검사한다. 빈 배열이면 통과다. */
export function validateCitations(draft: ResponseDraft, revisions: KnowledgeRevision[], projectId: string): string[] {
  const errors: string[] = [];
  if (!draft.sentences.length) errors.push('답변 문장이 없습니다.');
  const byId = new Map(revisions.map(item => [item.id, item]));
  draft.sentences.forEach((sentence, index) => {
    const label = `${index + 1}번째 문장`;
    if (!normalizeSpace(sentence.text)) errors.push(`${label}이 비어 있습니다.`);
    if (!sentence.citations.length) { errors.push(`${label}에 근거가 없습니다.`); return; }
    sentence.citations.forEach((citation: Citation) => {
      const revision = byId.get(citation.revisionId);
      const quote = normalizeSpace(citation.quote ?? '');
      if (!revision) errors.push(`${label}의 근거 revision을 찾을 수 없습니다.`);
      else if (revision.projectId !== projectId) errors.push(`${label}의 근거가 다른 프로젝트 지식입니다.`);
      else if (!isCurrent(revision, revisions)) errors.push(`${label}의 근거가 승인된 현재 지식이 아닙니다.`);
      else if (citation.quote.length > MAX_QUOTE_CHARS) errors.push(`${label}의 인용이 ${MAX_QUOTE_CHARS}자를 넘습니다.`);
      else if (Array.from(quote).length < MIN_QUOTE_CHARS) errors.push(`${label}의 인용이 너무 짧습니다.`);
      else if (!normalizeSpace(revision.body).includes(quote)) errors.push(`${label}의 인용이 지식 원문과 일치하지 않습니다.`);
    });
  });
  return errors;
}

const FILE_KINDS: Array<[RegExp, KnowledgeSource]> = [
  [/^readme$/, 'analysis'], [/^changelog$/, 'changelog'], [/^faq$/, 'faq'], [/^support$/, 'support_policy'], [/^known[-_]?issues$/, 'known_issue'],
];
const EXCLUDED_SEGMENT = /^(?:node_modules|vendor|third_party|dist|build)$/i;
const CREDENTIAL_NAME = /credential|secret|token|password|keystore|\.pem$|\.p12$|\.key$|(?:^|[._-])env(?:$|[._-])/i;

export interface KnowledgeCandidates { candidates: KnowledgeInput[]; skipped: Array<{ path: string; reason: string }> }
/**
 * 스토어 설명과 공개 문서(README/CHANGELOG/FAQ/SUPPORT/KNOWN_ISSUES)만 지식 후보로 만든다.
 * 숨김·자격 증명·외부 패키지 경로와 200KB 초과 파일은 제외 사유와 함께 돌려준다.
 */
export function projectKnowledgeCandidates(input: {
  projectId: string; listing?: { title: string; shortDescription: string; fullDescription: string }; files: Array<{ path: string; content: string }>;
}): KnowledgeCandidates {
  const candidates: KnowledgeInput[] = []; const skipped: KnowledgeCandidates['skipped'] = [];
  if (input.listing) {
    const body = [input.listing.title, input.listing.shortDescription, input.listing.fullDescription].map(item => item?.trim()).filter(Boolean).join('\n\n');
    if (containsSecret(body)) skipped.push({ path: 'store-listing', reason: '인증 정보로 보이는 값 포함' });
    else if (body) candidates.push({ projectId: input.projectId, documentKey: 'store-listing', sourceKind: 'store_listing', title: input.listing.title.trim().slice(0, 200) || '스토어 설명', body: body.slice(0, MAX_KNOWLEDGE_CHARS), sourceRef: 'store-listing' });
  }
  for (const file of input.files) {
    const path = file.path.replace(/\\/g, '/');
    const segments = path.split('/');
    const name = segments.at(-1) ?? '';
    const kind = FILE_KINDS.find(([pattern]) => pattern.test(name.replace(/\.(?:md|markdown|txt)$/i, '').toLowerCase()))?.[1];
    const reason = path.startsWith('/') || /^[a-z]:/i.test(path) || segments.includes('..') ? '프로젝트 밖 경로'
      : segments.some(segment => segment.startsWith('.')) ? '숨김 경로'
      : CREDENTIAL_NAME.test(name) ? '자격 증명 파일'
      : segments.some(segment => EXCLUDED_SEGMENT.test(segment)) ? '외부 패키지·빌드 경로'
      : !kind ? '허용된 공개 문서가 아님'
      : Buffer.byteLength(file.content, 'utf8') > MAX_SOURCE_BYTES ? '200KB 초과'
      : containsSecret(file.content) ? '인증 정보로 보이는 값 포함'
      : !file.content.trim() ? '빈 파일' : '';
    if (reason) { skipped.push({ path, reason }); continue; }
    let body = file.content.trim();
    if (body.length > MAX_KNOWLEDGE_CHARS) {
      // 최신 항목이 위에 오는 changelog만 줄 경계에서 자르고, 나머지 문서는 일부만 근거로 쓰지 않는다.
      if (kind !== 'changelog') { skipped.push({ path, reason: `${MAX_KNOWLEDGE_CHARS.toLocaleString()}자 초과` }); continue; }
      const cut = body.lastIndexOf('\n', MAX_KNOWLEDGE_CHARS);
      body = body.slice(0, cut > 0 ? cut : MAX_KNOWLEDGE_CHARS).trim();
    }
    candidates.push({ projectId: input.projectId, documentKey: 'file:' + path, sourceKind: kind!, title: name, body, sourceRef: path });
  }
  return { candidates, skipped };
}
