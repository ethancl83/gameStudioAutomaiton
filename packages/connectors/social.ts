import type { Connector, ConnectorContext, ConnectorResult } from './types.js';
import type { SocialAdapter, SocialContext, SocialResult } from '../social/types.js';
import { xAdapter, threadsAdapter, steamNewsAdapter } from '../social/index.js';

function context(adapter: SocialAdapter, ctx: ConnectorContext): SocialContext {
  return { ...ctx, credentials: {}, connection: { ...ctx.connection, provider: adapter.capability.provider },
    request: (url, options = {}) => {
      const { form, ...rest } = options;
      return ctx.request(url, form ? { ...rest, body: new URLSearchParams(form), headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...rest.headers } } : rest);
    } };
}
function normalized(result: SocialResult): ConnectorResult {
  return { summary: result.summary, waitingExternal: result.waitingExternal, unresolved: result.unresolved, failed: result.summary.outcome === 'failed',
    resources: result.resources?.filter(resource => resource.kind !== 'account').map(resource => ({ kind: resource.kind as 'post' | 'reply' | 'mention' | 'news', externalId: resource.externalId,
      name: resource.text?.slice(0, 100) || String(resource.data.title ?? resource.externalId), status: 'published',
      data: { ...resource.data, ...(resource.text === undefined ? {} : { text: resource.text }), ...(resource.permalink ? { permalink: resource.permalink } : {}),
        ...(resource.createdAt ? { createdAt: resource.createdAt } : {}), ...(resource.metrics ? { metrics: resource.metrics } : {}) } })) };
}
function bridge(adapter: SocialAdapter): Connector {
  return {
    capability: { ...adapter.capability, provider: adapter.capability.provider, category: 'community',
      operations: [...new Set([...adapter.capability.readOperations, ...adapter.capability.writeOperations, 'sync'])],
      operationFields: adapter.capability.operationFields ?? {
        'create-post': [{ key: 'text', label: '게시 문구', type: 'textarea', required: true }],
        reply: [{ key: 'replyToId', label: '답글 대상 ID', required: true }, { key: 'text', label: '답글 문구', type: 'textarea', required: true }],
        'list-replies': [{ key: 'postId', label: '게시글 ID', required: true }],
      } },
    async execute(operation, input, ctx) {
      const socialContext = context(adapter, ctx);
      if (operation === 'sync') {
        await adapter.execute('check', {}, socialContext);
        const posts = await adapter.execute('list-posts', input, socialContext);
        const extra = adapter.capability.readOperations.includes('list-mentions') ? await adapter.execute('list-mentions', input, socialContext) : undefined;
        const replies: SocialResult[] = [];
        if (adapter.capability.readOperations.includes('list-replies')) {
          for (const post of (posts.resources ?? []).filter(item => item.kind === 'post').slice(0, 20)) {
            replies.push(await adapter.execute('list-replies', { postId: post.externalId }, socialContext));
          }
        }
        const resources = [...(posts.resources ?? []), ...(extra?.resources ?? []), ...replies.flatMap(result => result.resources ?? [])];
        return normalized({ summary: { count: resources.length }, resources });
      }
      return normalized(await adapter.execute(operation, input, socialContext));
    },
  };
}
export const xConnector = bridge(xAdapter);
export const threadsConnector = bridge(threadsAdapter);
export function withSteamCommunity(connector: Connector): Connector {
  const steamOps = ['list-news', 'prepare-news'];
  return { ...connector, capability: { ...connector.capability, operations: [...connector.capability.operations, ...steamOps],
    operationFields: { ...connector.capability.operationFields, ...steamNewsAdapter.capability.operationFields },
    limitations: [...connector.capability.limitations, ...steamNewsAdapter.capability.limitations] },
    execute: (operation, input, ctx) => steamOps.includes(operation) ? steamNewsAdapter.execute(operation, {
      ...input, appId: input.appId ?? (/^[0-9]+$/.test(ctx.project?.appIdentifier ?? '') ? ctx.project!.appIdentifier : undefined) ?? ctx.credentials.appId ?? ctx.connection.accountId,
    }, context(steamNewsAdapter, ctx)).then(normalized) : connector.execute(operation, input, ctx) };
}
