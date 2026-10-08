/**
 * Conector oficial del Bureau of Economic Analysis — Fase 1b.
 *
 * RSS de publicaciones (`apps.bea.gov/rss/rss.xml`): PIB, PCE, renta
 * personal, balanza comercial… Los ítems llevan el atributo `name` de la
 * serie y su propio `pubDate`; el parser RSS compartido los resuelve.
 */
import {
  createOfficialFeedConnector,
  OFFICIAL_FEED_RATE_LIMITS,
  type OfficialConnectorDeps,
} from './feed';
import type { NewsConnector } from '../types';

export const BEA_CONNECTOR_ID = 'bea';

export const BEA_FEEDS = ['https://apps.bea.gov/rss/rss.xml'] as const;

export function createBeaConnector(deps: OfficialConnectorDeps = {}): NewsConnector {
  return createOfficialFeedConnector(
    { id: BEA_CONNECTOR_ID, feeds: BEA_FEEDS, rateLimits: OFFICIAL_FEED_RATE_LIMITS },
    deps,
  );
}
