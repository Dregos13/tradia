/**
 * Conector oficial de la Reserva Federal — Fase 1b.
 *
 * Dos canales RSS de federalreserve.gov: todos los comunicados de prensa
 * (`press_all.xml`) y los de política monetaria (`press_monetary.xml`),
 * que incluye los comunicados y minutas del FOMC. El segundo se solapa con
 * el primero a propósito: la fusión del conector los deduplica por guid.
 */
import {
  createOfficialFeedConnector,
  OFFICIAL_FEED_RATE_LIMITS,
  type OfficialConnectorDeps,
} from './feed';
import type { NewsConnector } from '../types';

export const FED_CONNECTOR_ID = 'fed';

export const FED_FEEDS = [
  'https://www.federalreserve.gov/feeds/press_all.xml',
  'https://www.federalreserve.gov/feeds/press_monetary.xml',
] as const;

export function createFedConnector(deps: OfficialConnectorDeps = {}): NewsConnector {
  return createOfficialFeedConnector(
    { id: FED_CONNECTOR_ID, feeds: FED_FEEDS, rateLimits: OFFICIAL_FEED_RATE_LIMITS },
    deps,
  );
}
