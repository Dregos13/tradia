/**
 * Conectores de fuentes oficiales — Fase 1b.
 *
 * Fed (comunicados y FOMC), BCE (prensa), BLS (nóminas e IPC), BEA
 * (publicaciones), SEC EDGAR (8-K y Form 4 por CIK, máx. 10 req/s con
 * User-Agent declarado) y CNMV (información privilegiada y relevante).
 * Todos son feeds RSS/Atom sobre `createOfficialFeedConnector` con los
 * endpoints fijos del organismo; `source.url` los sustituye (feeds
 * locales `file://` en las pruebas E2E).
 *
 * `OFFICIAL_SOURCE_SEEDS` los siembra en `news_sources` como fuentes
 * 'oficial' predefinidas: el usuario puede desactivarlas, no
 * reclasificarlas.
 */
import type { NewsConnector } from '../types';
import { createBeaConnector } from './bea';
import { createBlsConnector } from './bls';
import { createCnmvConnector } from './cnmv';
import { createEcbConnector } from './ecb';
import { createFedConnector } from './fed';
import { createSecEdgarConnector } from './sec-edgar';
import type { OfficialConnectorDeps } from './feed';

/** Instancia los seis conectores oficiales con las dependencias dadas. */
export function createOfficialConnectors(deps: OfficialConnectorDeps = {}): NewsConnector[] {
  return [
    createFedConnector(deps),
    createEcbConnector(deps),
    createBlsConnector(deps),
    createBeaConnector(deps),
    createSecEdgarConnector(deps),
    createCnmvConnector(deps),
  ];
}

export {
  createOfficialFeedConnector,
  OFFICIAL_FEED_RATE_LIMITS,
  OFFICIAL_USER_AGENT,
  type OfficialConnectorDeps,
  type OfficialFeedSpec,
} from './feed';
export { createFedConnector, FED_CONNECTOR_ID, FED_FEEDS } from './fed';
export { createEcbConnector, ECB_CONNECTOR_ID, ECB_FEEDS } from './ecb';
export { createBlsConnector, BLS_CONNECTOR_ID, BLS_FEEDS } from './bls';
export { createBeaConnector, BEA_CONNECTOR_ID, BEA_FEEDS } from './bea';
export {
  createSecEdgarConnector,
  SEC_EDGAR_CONNECTOR_ID,
  SEC_EDGAR_COUNT_PER_FEED,
  SEC_EDGAR_DEFAULT_FORMS,
  SEC_EDGAR_MAX_REQUESTS_PER_SECOND,
  SEC_EDGAR_MIN_INTERVAL_MS,
  SEC_EDGAR_RATE_LIMITS,
} from './sec-edgar';
export { createCnmvConnector, CNMV_CONNECTOR_ID, CNMV_FEEDS } from './cnmv';
export { cikForTicker, CIK_PATTERN, normalizeCik, TICKER_TO_CIK, tickersForCik } from './cik-map';
export {
  INITIAL_UNIVERSE_CIKS,
  OFFICIAL_SOURCE_SEEDS,
  seedOfficialSources,
  type OfficialSourceSeed,
} from './seeds';
