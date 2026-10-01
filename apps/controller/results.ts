import { createHash } from 'node:crypto';
import type { Connection, ExternalResource, MetricFact, Project, Provider, Run } from '../../packages/domain/index.js';
import { prohibitSecrets } from '../../packages/domain/errors.js';
import { isWriteOperation, type ConnectorResult } from '../../packages/connectors/types.js';
import type { AttributionFact } from '../../packages/growth/types.js';
import type { Store } from '../../packages/storage/index.js';
import { observeReleases } from './release-observations.js';
import { isSocialWrite } from './social-automation.js';

const now = () => new Date().toISOString();

// Called by the queue's synchronous settlement transaction so result projections,
// release observations, effect resolution and run completion commit together.
export function persistResult(store: Store, run: Run, connection: Connection, result: ConnectorResult): void {
  prohibitSecrets(result);
  const projects = store.list<Project>('project');
  const updates: { kind: 'resource' | 'metric'; id: string; value: ExternalResource | MetricFact }[] = [];
  if (!result.unresolved && !result.failed && ['delete-post','hide-reply'].includes(run.kind)) {
    const target = run.input.postId ?? run.input.replyId ?? run.input.externalId;
    for (const resource of store.documents<ExternalResource>('resource', { connectionId: connection.id }).filter(item => item.connectionId === connection.id && item.externalId === target && item.projectId === run.projectId)) {
      const hidden = run.input.hide === true || run.input.hide === 'true';
      updates.push({ kind: 'resource', id: resource.id, value: { ...resource, status: run.kind === 'delete-post' ? 'deleted' : hidden ? 'hidden' : 'published', data: { ...resource.data, ...(run.kind === 'hide-reply' ? { hidden } : {}) }, updatedAt: now() } });
    }
  }
  for (const resource of result.resources ?? []) {
    const identity = resource.kind === 'news' ? `${connection.id}:news:${resource.data.appId ?? 'unassigned'}:${resource.externalId}` : connection.id + ':' + resource.kind + ':' + resource.externalId;
    const id = createHash('sha256').update(identity).digest('hex');
    const previous = store.get<ExternalResource>('resource', id);
    const identifier = resource.data.packageName ?? resource.data.bundleId ?? resource.data.appIdentifier ?? resource.data.appId;
    const matching = identifier ? projects.filter(project => matchesProjectIdentifier(store, project, identifier, connection.provider)) : [];
    let projectId = matching.length === 1 ? matching[0].id : identifier ? null : previous?.projectId ?? (isWriteOperation(run.kind, connection.provider) ? run.projectId : null);
    let resourceData = matching.length === 1 && resource.kind === 'campaign' ? {...resource.data, appIdentifier: matching[0]!.appIdentifier} : resource.data;
    if (['post', 'reply', 'mention', 'news'].includes(resource.kind)) {
      const channelProjects = projects.filter(project => project.socialPolicy?.connectionIds.includes(connection.id));
      const parentId = resource.data.conversationId ?? resource.data.replyToId;
      const parent = parentId ? store.documents<ExternalResource>('resource', { connectionId: connection.id }).find(item => item.connectionId === connection.id && item.externalId === parentId && item.projectId) : undefined;
      projectId = identifier ? (matching.length === 1 ? matching[0]!.id : null) : (isSocialWrite(run.kind) ? run.projectId : null) ?? previous?.projectId ?? parent?.projectId ?? (channelProjects.length === 1 ? channelProjects[0]!.id : null);
      resourceData = { ...resource.data, owned: isSocialWrite(run.kind) || previous?.data.owned === true || resource.data.owned === true || resource.data.authorId === connection.accountId || resource.data.is_owned_by_me === true };
    }
    updates.push({ kind: 'resource', id, value: { ...resource, data: resourceData, id, provider: connection.provider,
      connectionId: connection.id, projectId, updatedAt: now() } });
  }
  for (const metric of result.metrics ?? []) {
    const id = createHash('sha256').update([connection.id, metric.kind, metric.sourceId, metric.date, metric.currency].join(':')).digest('hex');
    const matching = metric.appIdentifier ? projects.filter(project => matchesProjectIdentifier(store, project, metric.appIdentifier, connection.provider)) : [];
    updates.push({ kind: 'metric', id, value: { ...metric, id, provider: connection.provider, connectionId: connection.id,
      projectId: matching.length === 1 ? matching[0].id : null, collectedAt: now() } });
  }
  const attribution: { kind: 'attribution-fact'; id: string; value: AttributionFact }[] = [];
  for (const fact of result.attribution ?? []) {
    const { appIdentifier, ...rest } = fact;
    const matching = appIdentifier ? projects.filter(project => matchesProjectIdentifier(store, project, appIdentifier, connection.provider)) : [];
    const projectId = matching.length === 1 ? matching[0]!.id : run.projectId;
    if (!projectId) continue;
    // 원천 정정은 덮어쓰지 않고 revision을 올린 새 fact로 보존한다. 공급자가 revision을 주지 않아도(항상 1)
    // 같은 원천의 값이 바뀌면 다음 revision으로 저장하고 이전 fact를 supersedes로 가리킨다. 같은 값 재수집은 그대로 둔다.
    const base = [connection.id, fact.sourceId, fact.kind, fact.eventDate, fact.armId ?? '', fact.campaignId ?? '', fact.currency ?? ''].join(':');
    const idFor = (revision: number) => createHash('sha256').update(base + ':' + revision).digest('hex');
    let revision = fact.revision; let previous: AttributionFact | undefined;
    for (let candidate = store.get<AttributionFact>('attribution-fact', idFor(revision)); candidate; candidate = store.get<AttributionFact>('attribution-fact', idFor(revision))) {
      previous = candidate; revision = Math.max(revision, candidate.revision) + 1;
    }
    if (previous && previous.amountMicros === fact.amountMicros && previous.count === fact.count && previous.finality === fact.finality) continue;
    const id = idFor(previous ? revision : fact.revision);
    attribution.push({ kind: 'attribution-fact', id, value: { ...rest, id, revision: previous ? revision : fact.revision, ...(previous ? { supersedes: previous.id } : {}), projectId, provider: connection.provider, connectionId: connection.id, collectedAt: now() } });
  }
  const removals: Array<{kind: 'metric' | 'resource'; id: string}> = (result.metricSourcePrefixes?.length ? store.documents<MetricFact>('metric', { connectionId: connection.id }) : [])
    .filter(metric => metric.connectionId === connection.id && result.metricSourcePrefixes!.some(prefix => metric.sourceId.startsWith(prefix)))
    .map(metric => ({ kind: 'metric' as const, id: metric.id }));
  if (!result.failed && !result.unresolved && result.resourceSnapshots?.length) {
    const kinds = new Set(result.resourceSnapshots.map(scope => scope.kind));
    const present = new Set(updates.filter(item => item.kind === 'resource').map(item => item.id));
    for (const resource of store.documents<ExternalResource>('resource', { connectionId: connection.id })) {
      if (resource.connectionId === connection.id && kinds.has(resource.kind) && !present.has(resource.id)) removals.push({kind:'resource',id:resource.id});
    }
  }
  const observations = !result.failed && !result.unresolved ? observeReleases(store,run,connection,updates.filter(item=>item.kind==='resource').map(item=>item.value as ExternalResource),result.summary,now()) : [];
  store.writeBatch([...updates,...observations,...attribution], removals);
}

function matchesProjectIdentifier(store: Store, project: Project, identifier: unknown, provider: Provider): boolean {
  if (project.appIdentifier === identifier) return true;
  if (project.storeApps?.[provider as 'google-play'|'app-store'|'steam']?.appId === identifier) return true;
  if (provider !== 'google-ads') return false;
  const apple = store.get<{bundleId:string;appleAppId:string}>('settings', 'apple-identity:' + project.id);
  return !!apple && apple.bundleId === project.appIdentifier && apple.appleAppId === identifier;
}
