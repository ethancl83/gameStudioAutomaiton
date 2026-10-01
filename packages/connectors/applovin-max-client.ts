import { AppError } from '../domain/errors.js';
import type { ConnectorContext } from './types.js';
import { headerAuth } from './marketing-utils.js';

export const HOST = 'https://o.applovin.com/mediation/v1';
function managementKey(ctx: ConnectorContext): string {
  const key = ctx.credentials.managementKey || ctx.credentials.apiKey;
  if (!key) throw new AppError('AUTH_REQUIRED', 'MAX Management Key가 필요합니다. 광고 Campaign Management 키와 다릅니다.');
  return key;
}

export function auth(ctx: ConnectorContext): Record<string, string> {
  return headerAuth('api-key', managementKey(ctx));
}
