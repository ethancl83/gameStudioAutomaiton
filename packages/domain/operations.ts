import type { Provider } from './index.js';

export function isWriteOperation(operation: string, provider?: Provider): boolean {
  if (operation === 'sync-app') return false;
  // Play listing reads create a temporary edit; Apple's JSON API only performs GETs.
  if (operation === 'list-listings' && provider === 'app-store') return false;
  if (['create-app', 'prepare-news', 'create-announcement'].includes(operation)) return false;
  return !['campaign-attribution', 'list-creatives', 'check', 'sync', 'list-apps', 'list-campaigns', 'list-products', 'list-ad-units', 'list-releases', 'reconcile', 'list-posts', 'list-mentions', 'list-replies', 'list-news', 'list-beta-groups', 'list-review-submissions', 'sdk-integration-config',
    'probe-experiments', 'list-experiments', 'experiment-metrics', 'probe-ad-unit-experiments', 'list-ad-unit-experiments'].includes(operation);
}
