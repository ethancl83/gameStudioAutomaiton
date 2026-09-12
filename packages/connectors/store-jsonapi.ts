import { AppError, text } from '../domain/errors.js';
import type { ConnectorContext } from './types.js';

export const APP_STORE_API = 'https://api.appstoreconnect.apple.com';

export interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: unknown }>;
}
export interface JsonApiDocument {
  data?: JsonApiResource | JsonApiResource[];
  links?: { next?: string };
  included?: JsonApiResource[];
}

export function one(document: JsonApiDocument, label: string): JsonApiResource {
  if (!document.data || Array.isArray(document.data)) {
    throw new AppError('INVALID_PROVIDER_RESPONSE', `${label} 응답 형식을 해석할 수 없습니다.`, 502);
  }
  return document.data;
}

export function many(document: JsonApiDocument): JsonApiResource[] {
  if (!document.data) return [];
  return Array.isArray(document.data) ? document.data : [document.data];
}

export function attribute(resource: JsonApiResource, name: string): unknown {
  return resource.attributes?.[name];
}

export function textAttribute(resource: JsonApiResource, name: string): string {
  const value = attribute(resource, name);
  return typeof value === 'string' ? value : '';
}

export function relationshipId(resource: JsonApiResource, name: string): string {
  const data = resource.relationships?.[name]?.data;
  if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { id?: unknown }).id === 'string') {
    return (data as { id: string }).id;
  }
  return '';
}

export function requireRelationshipId(resource: JsonApiResource, name: string, label: string): string {
  const id = relationshipId(resource, name);
  if (!id) {
    throw new AppError('INVALID_PROVIDER_RESPONSE', `${label} 응답에 관련 리소스 관계가 없어 소유권을 확인할 수 없습니다.`, 502);
  }
  return id;
}

export async function readToOneLinkage(
  context: ConnectorContext,
  url: string,
  headers: Record<string, string>,
  expectedType: string,
  label: string,
): Promise<string> {
  const related = one(await context.request<JsonApiDocument>(url, { headers }), label);
  if (related.type !== expectedType || !related.id) {
    throw new AppError('INVALID_PROVIDER_RESPONSE', `${label}을(를) 확인할 수 없어 작업을 중단했습니다.`, 502);
  }
  return related.id;
}

export async function appleAuthHeaders(context: ConnectorContext, extra?: Record<string, string>): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await context.accessToken()}`, ...extra };
}

export async function resolveAppleApp(context: ConnectorContext): Promise<{ id: string; bundleId: string; name: string }> {
  const headers = await appleAuthHeaders(context);
  const configuredId = context.credentials.appleAppId;
  if (configuredId) {
    const document = await context.request<JsonApiDocument>(`${APP_STORE_API}/v1/apps/${encodeURIComponent(configuredId)}`, { headers });
    const app = one(document, '앱 조회');
    const bundleId = textAttribute(app, 'bundleId');
    if (context.project?.appIdentifier && context.project.appIdentifier !== bundleId) {
      throw new AppError('INVALID_INPUT', `연결에 지정된 Apple 앱(${bundleId})과 프로젝트 bundle ID(${context.project.appIdentifier})가 다릅니다.`);
    }
    return { id: app.id, bundleId, name: textAttribute(app, 'name') };
  }
  const bundleId = context.project?.appIdentifier;
  if (!bundleId) {
    throw new AppError('MISSING_REQUIREMENT', 'App Store 작업에는 프로젝트의 bundle ID 또는 연결의 appleAppId 설정이 필요합니다. 프로젝트를 검수해 bundle ID를 확인하거나 연결 설정에 appleAppId를 입력해 주세요.');
  }
  const document = await context.request<JsonApiDocument>(
    `${APP_STORE_API}/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=2`,
    { headers },
  );
  const apps = many(document);
  if (apps.length === 0) {
    throw new AppError('RESOURCE_NOT_FOUND', `App Store Connect에서 bundle ID ${bundleId}에 해당하는 앱을 찾지 못했습니다. 앱을 먼저 등록하거나 API 키 권한을 확인해 주세요.`, 404);
  }
  if (apps.length > 1) {
    throw new AppError('INVALID_INPUT', `bundle ID ${bundleId}에 두 개 이상의 앱이 조회되었습니다. 연결 설정의 appleAppId로 대상을 지정해 주세요.`);
  }
  return { id: apps[0].id, bundleId, name: textAttribute(apps[0], 'name') };
}

export async function collectPages(context: ConnectorContext, start: string, headers: Record<string, string>, label: string): Promise<JsonApiResource[]> {
  const records: JsonApiResource[] = [];
  let next = start;
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next) || visited.size >= 100) throw new AppError('PAGINATION_LIMIT', `${label} 조회 한도를 넘었습니다.`);
    visited.add(next);
    const document = await context.request<JsonApiDocument>(next, { headers });
    records.push(...many(document));
    next = typeof document.links?.next === 'string' ? document.links.next : '';
  }
  return records;
}

export function resourceId(value: unknown, label: string): string {
  const id = text(value, label, 200);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new AppError('INVALID_INPUT', `${label} 형식이 올바르지 않습니다.`);
  return id;
}

export function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, label, maximum);
}

export function optionalUrl(value: unknown, label: string): string | undefined {
  const raw = optionalText(value, label, 500);
  if (raw === undefined) return undefined;
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    throw new AppError('INVALID_INPUT', `${label}는 https URL이어야 합니다.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new AppError('INVALID_INPUT', `${label}는 https URL이어야 합니다.`);
  }
  return parsed.toString();
}
