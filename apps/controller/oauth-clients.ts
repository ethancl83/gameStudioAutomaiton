import type { Connection, Provider } from '../../packages/domain/index.js';
import type { CredentialVault } from '../../packages/credentials/index.js';
import { AppError } from '../../packages/domain/errors.js';

export const OAUTH_PROVIDERS = ['google-play', 'google-ads', 'admob', 'x', 'threads'] as const;
export const GOOGLE_OAUTH_APP_ID = 'oauth-app-google';
const google = (provider: Provider) => ['google-play', 'google-ads', 'admob'].includes(provider);

/** Reuse app credentials only. User tokens and account-specific configuration never cross connections. */
export async function resolveOAuthClient(provider: Provider, connections: Connection[], vault: CredentialVault): Promise<{ credentials: Record<string, string>; source: string } | null> {
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (google(provider) && await vault.has(GOOGLE_OAUTH_APP_ID)) {
    const stored = await vault.get(GOOGLE_OAUTH_APP_ID);
    if (stored.clientId) return { credentials: { clientId: stored.clientId, ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}) }, source: 'Google OAuth 공통 등록' };
  }
  const prefix = google(provider) ? 'APPOPS_GOOGLE' : provider === 'x' ? 'APPOPS_X' : 'APPOPS_THREADS';
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (clientId && (provider !== 'threads' || clientSecret)) return { credentials: { clientId, ...(clientSecret ? { clientSecret } : {}) }, source: '앱 기본 설정' };
  const eligible = connections.filter(c => c.status !== 'disconnected' && (c.provider === provider || google(provider) && google(c.provider)) && c.credentialFields.includes('clientId'));
  eligible.sort((a, b) => Number(b.provider === provider) - Number(a.provider === provider) || b.updatedAt.localeCompare(a.updatedAt));
  for (const connection of eligible) {
    if (!await vault.has(connection.id)) continue;
    const stored = await vault.get(connection.id);
    if (stored.clientId && (provider !== 'threads' || stored.clientSecret)) return {
      credentials: { clientId: stored.clientId, ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}) },
      source: connection.label,
    };
  }
  return null;
}

export async function oauthCredentials(provider: Provider, supplied: Record<string, string>, connections: Connection[], vault: CredentialVault): Promise<Record<string, string>> {
  if (supplied.clientId) return supplied;
  const client = await resolveOAuthClient(provider, connections, vault);
  if (!client) throw new AppError('OAUTH_APP_REQUIRED', '최초 한 번 OAuth 앱 설정이 필요합니다. 앱 제공자의 클라이언트를 설정하거나 직접 등록한 앱 정보를 가져오세요.');
  return { ...client.credentials, ...supplied };
}
