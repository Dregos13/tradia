/**
 * Conector oficial del Bureau of Labor Statistics — Fase 1b.
 *
 * Feeds Atom por publicación (`bls.gov/feed/<publicación>.rss`): el
 * Employment Situation (`empsit`) trae las nóminas no agrícolas y `cpi`
 * el IPC — los dos datos de mayor impacto del calendario. El feed
 * agregado `bls_latest.rss` no se usa: es un único ítem fijo cuyo
 * resumen es una tabla HTML de todos los indicadores, no un titular.
 *
 * BLS rechaza clientes sin User-Agent declarado: lo fija la base común.
 */
import {
  createOfficialFeedConnector,
  OFFICIAL_FEED_RATE_LIMITS,
  type OfficialConnectorDeps,
} from './feed';
import type { NewsConnector } from '../types';

export const BLS_CONNECTOR_ID = 'bls';

export const BLS_FEEDS = [
  'https://www.bls.gov/feed/empsit.rss',
  'https://www.bls.gov/feed/cpi.rss',
] as const;

export function createBlsConnector(deps: OfficialConnectorDeps = {}): NewsConnector {
  return createOfficialFeedConnector(
    { id: BLS_CONNECTOR_ID, feeds: BLS_FEEDS, rateLimits: OFFICIAL_FEED_RATE_LIMITS },
    deps,
  );
}
