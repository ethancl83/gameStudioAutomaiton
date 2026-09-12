import { AppError } from '../domain/errors.js';
import type { Provider } from '../domain/index.js';
import type { Connector } from './types.js';
import { googlePlayConnector } from './google-play.js';
import { appStoreConnector } from './app-store.js';
import { steamConnector } from './steam.js';
import { googleAdsConnector } from './google-ads.js';
import { applovinAdsConnector } from './applovin-ads.js';
import { applovinMaxConnector } from './applovin-max.js';
import { admobConnector } from './admob.js';
import { threadsConnector, withSteamCommunity, xConnector } from './social.js';

export const connectors: Connector[] = [googlePlayConnector, appStoreConnector, withSteamCommunity(steamConnector), googleAdsConnector, applovinAdsConnector, applovinMaxConnector, admobConnector, xConnector, threadsConnector];
export function connectorFor(provider: Provider): Connector {
  const connector = connectors.find(item => item.capability.provider === provider);
  if (!connector) throw new AppError('PROVIDER_UNAVAILABLE', '이 서비스의 연결 모듈을 준비하고 있습니다.');
  return connector;
}
