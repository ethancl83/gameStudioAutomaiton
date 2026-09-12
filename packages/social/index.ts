// Social / community provider module.
//
// Self-contained adapters for X, Threads and Steam news with an injected
// transport, an OAuth broker per provider, and a refresh/rotation token
// manager. The controller (root) bridges these onto the shared Provider enum,
// durable queue, credential vault and policies. Steam news is grafted onto the
// controller's existing `steam` connector, so it is NOT in NEW_SOCIAL_PROVIDERS.

import { AppError } from '../domain/errors.js';
import type { SocialAdapter, SocialProvider } from './types.js';
import { xAdapter } from './x.js';
import { threadsAdapter } from './threads.js';
import { steamNewsAdapter } from './steam.js';

export type {
  SocialProvider,
  SocialRequest,
  SocialConnectionRef,
  SocialProjectRef,
  SocialContext,
  SocialResource,
  SocialResult,
  SocialCapability,
  SocialCapabilityField,
  SocialOperationField,
  SocialAdapter,
  SecretStore,
} from './types.js';

export { xAdapter } from './x.js';
export { threadsAdapter } from './threads.js';
export { steamNewsAdapter } from './steam.js';

export { createSocialTransport, SOCIAL_ORIGINS } from './transport.js';
export { SocialTokenManager, type TokenConnectionRef } from './tokens.js';
export {
  XOAuthBroker,
  ThreadsOAuthBroker,
  type SocialCredentials,
  X_AUTHORIZE_ENDPOINT,
  X_TOKEN_ENDPOINT,
  X_USERS_ME_ENDPOINT,
  X_DEFAULT_SCOPES,
  THREADS_AUTHORIZE_ENDPOINT,
  THREADS_SHORT_TOKEN_ENDPOINT,
  THREADS_LONG_TOKEN_ENDPOINT,
  THREADS_REFRESH_ENDPOINT,
  THREADS_DEFAULT_SCOPES,
} from './oauth.js';
export {
  weightedTweetLength,
  assertXText,
  threadsTextLength,
  assertThreadsText,
} from './validate.js';
export { assertPublicHttpsUrl, parseCarouselItems, parseCarouselUrls, threadsMediaKind } from './media.js';

/** Provider ids the controller must add to the shared `Provider` enum. */
export const NEW_SOCIAL_PROVIDERS: SocialProvider[] = ['x', 'threads'];

/** All adapters exposed by this module (Steam grafts onto the existing connector). */
export const socialAdapters: SocialAdapter[] = [xAdapter, threadsAdapter, steamNewsAdapter];

export function socialAdapterFor(provider: SocialProvider): SocialAdapter {
  const adapter = socialAdapters.find(item => item.capability.provider === provider);
  if (!adapter) throw new AppError('PROVIDER_UNAVAILABLE', '이 소셜 제공자의 어댑터를 찾을 수 없습니다.');
  return adapter;
}
