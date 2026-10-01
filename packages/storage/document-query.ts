import { AppError } from '../domain/errors.js';

/**
 * 문서 payload 최상위 필드 조건. 값은 모두 바인딩 인자로 넘기고, SQL에 직접 들어가는 필드 이름은
 * 식별자 형식만 허용한다. 시각 범위·정렬 필드는 toISOString 형식 문자열이라 문자열 비교가 시각 순서와 같다.
 */
export interface DocumentFilter {
  projectId?: string; connectionId?: string;
  /** 필드 값이 목록 중 하나와 같다. 빈 목록은 아무 문서도 고르지 않는다. */
  in?: Record<string, readonly string[]>;
  /** 필드가 없거나 목록의 어느 값과도 다르다. */
  notIn?: Record<string, readonly string[]>;
  /** 필드 값이 [from, to) 범위다. */
  range?: { field: string; from?: string; to?: string };
}
/** 정렬 필드 값과 문서 id. 같은 시각의 문서는 id로 순서를 고정한다. */
export interface DocumentCursor { value: string; id: string }
export interface DocumentPage<T> { items: T[]; next: DocumentCursor | null }
export interface DocumentPageQuery extends DocumentFilter { order: string; before?: DocumentCursor; limit: number }

export const DOCUMENT_PAGE_MAX = 500;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** documents_project 인덱스와 같은 식이어야 SQLite가 인덱스를 쓴다. */
export function field(name: string): string {
  if (!FIELD.test(name)) throw new AppError('INVALID_QUERY', '문서 조회 필드 이름이 올바르지 않습니다.');
  return `json_extract(payload,'$.${name}')`;
}

export function documentWhere(kind: string, filter: DocumentFilter): { sql: string; values: string[] } {
  const clauses = ['kind=?']; const values = [kind];
  for (const [name, value] of [['projectId', filter.projectId], ['connectionId', filter.connectionId]] as const) {
    if (value !== undefined) { clauses.push(`${field(name)}=?`); values.push(value); }
  }
  for (const [name, list] of Object.entries(filter.in ?? {})) {
    if (!list.length) { clauses.push('0'); continue; }
    clauses.push(`${field(name)} IN (${list.map(() => '?').join(',')})`); values.push(...list);
  }
  for (const [name, list] of Object.entries(filter.notIn ?? {})) {
    if (!list.length) continue;
    clauses.push(`(${field(name)} IS NULL OR ${field(name)} NOT IN (${list.map(() => '?').join(',')}))`); values.push(...list);
  }
  if (filter.range) {
    const target = field(filter.range.field);
    if (filter.range.from !== undefined) { clauses.push(`${target}>=?`); values.push(filter.range.from); }
    if (filter.range.to !== undefined) { clauses.push(`${target}<?`); values.push(filter.range.to); }
  }
  return { sql: clauses.join(' AND '), values };
}

/**
 * (정렬 필드, id) 내림차순 keyset 페이지 SQL. 정렬 필드가 문자열이 아닌 문서는 커서로 비교할 수 없어 제외한다.
 * 한 건을 더 읽어 다음 페이지 존재 여부를 판정하고, 마지막 항목의 (값, id)를 다음 커서로 쓴다.
 */
export function documentPageSql(kind: string, query: DocumentPageQuery): { sql: string; values: (string | number)[]; limit: number } {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > DOCUMENT_PAGE_MAX) throw new AppError('INVALID_QUERY', '문서 페이지 크기가 올바르지 않습니다.');
  const order = field(query.order);
  const where = documentWhere(kind, query);
  const clauses = [where.sql, `json_type(payload,'$.${query.order}')='text'`];
  const values: (string | number)[] = [...where.values];
  if (query.before) {
    clauses.push(`(${order}<? OR (${order}=? AND id<?))`);
    values.push(query.before.value, query.before.value, query.before.id);
  }
  values.push(query.limit + 1);
  return { sql: `SELECT id,payload,${order} AS cursor_value FROM documents WHERE ${clauses.join(' AND ')} ORDER BY ${order} DESC,id DESC LIMIT ?`, values, limit: query.limit };
}
