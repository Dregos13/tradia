/**
 * Conector oficial del Banco Central Europeo — Fase 1b.
 *
 * RSS de notas de prensa del BCE (`ecb.europa.eu/rss/press.html` sirve
 * `application/rss+xml`): decisiones de tipos, comunicados y discursos.
 */
import {
  createOfficialFeedConnector,
  OFFICIAL_FEED_RATE_LIMITS,
  type OfficialConnectorDeps,
} from './feed';
import type { NewsConnector } from '../types';

export const ECB_CONNECTOR_ID = 'ecb';

export const ECB_FEEDS = ['https://www.ecb.europa.eu/rss/press.html'] as const;

export function createEcbConnector(deps: OfficialConnectorDeps = {}): NewsConnector {
  return createOfficialFeedConnector(
    { id: ECB_CONNECTOR_ID, feeds: ECB_FEEDS, rateLimits: OFFICIAL_FEED_RATE_LIMITS },
    deps,
  );
}
