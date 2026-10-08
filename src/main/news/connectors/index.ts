/**
 * Registro de conectores de noticias — Fase 1b.
 *
 * Punto único donde se instancian los conectores con sus dependencias
 * (`fetch`, `getApiKey`, reloj, logger). El gestor de fuentes y el
 * programador resuelven `news_sources.conector` por aquí; las tareas
 * siguientes añaden los conectores de API ('finnhub', 'newsapi',
 * 'alphavantage', 'gdelt') y los oficiales ('sec-edgar', 'cnmv'…) con
 * `registry.register(connector)` o ampliando `defaultConnectors`.
 */
import { createAlphaVantageConnector } from './alphavantage';
import { createFinnhubConnector } from './finnhub';
import { createGdeltConnector } from './gdelt';
import { createNewsApiConnector } from './newsapi';
import { createRssConnector } from './rss';
import { createOfficialConnectors } from './official';
import { connectorFetch, type ConnectorDeps, type NewsConnector } from './types';

export interface ConnectorRegistry {
  /** Conector por id ('rss', 'finnhub'…); undefined si no está registrado. */
  get(id: string): NewsConnector | undefined;
  /** Ids registrados, en orden de alta. */
  list(): NewsConnector[];
  /** Da de alta un conector; el último con el mismo id gana. */
  register(connector: NewsConnector): void;
}

export function createConnectorRegistry(deps: ConnectorDeps = {}): ConnectorRegistry {
  const connectors = new Map<string, NewsConnector>();
  const registry: ConnectorRegistry = {
    get: (id) => connectors.get(id),
    list: () => [...connectors.values()],
    register: (connector) => {
      connectors.set(connector.id, connector);
    },
  };
  // Conectores incluidos de serie; las claves se piden por deps.getApiKey.
  registry.register(createRssConnector(deps));
  registry.register(createFinnhubConnector(deps));
  registry.register(createAlphaVantageConnector(deps));
  registry.register(createNewsApiConnector(deps));
  registry.register(createGdeltConnector(deps));
  // Fuentes oficiales (Fed, BCE, BLS, BEA, SEC EDGAR, CNMV): endpoints
  // propios, sin clave; se siembran con `seedOfficialSources`.
  for (const connector of createOfficialConnectors(deps)) {
    registry.register(connector);
  }
  return registry;
}

/** Registro con el transporte por defecto del proceso principal. */
export function createDefaultConnectorRegistry(
  deps: Omit<ConnectorDeps, 'fetch'> = {},
): ConnectorRegistry {
  return createConnectorRegistry({ fetch: connectorFetch, ...deps });
}

export { createRssConnector, RSS_CONNECTOR_ID, RSS_RATE_LIMITS, RSS_TIMEOUT_MS } from './rss';
export {
  createFinnhubConnector,
  FINNHUB_BASE_URL,
  FINNHUB_CONNECTOR_ID,
  FINNHUB_RATE_LIMITS,
  FINNHUB_SECRETS_KEY,
} from './finnhub';
export {
  ALPHAVANTAGE_BASE_URL,
  ALPHAVANTAGE_CONNECTOR_ID,
  ALPHAVANTAGE_RATE_LIMITS,
  ALPHAVANTAGE_SECRETS_KEY,
  createAlphaVantageConnector,
} from './alphavantage';
export {
  createNewsApiConnector,
  NEWSAPI_BASE_URL,
  NEWSAPI_CONNECTOR_ID,
  NEWSAPI_RATE_LIMITS,
  NEWSAPI_SECRETS_KEY,
} from './newsapi';
export {
  createGdeltConnector,
  GDELT_BASE_URL,
  GDELT_CONNECTOR_ID,
  GDELT_DEFAULT_QUERY,
  GDELT_RATE_LIMITS,
} from './gdelt';
export { inferItemReliability, isAgencySource, type ApiConnectorDeps } from './api';
export {
  cikForTicker,
  createOfficialConnectors,
  INITIAL_UNIVERSE_CIKS,
  OFFICIAL_SOURCE_SEEDS,
  OFFICIAL_USER_AGENT,
  SEC_EDGAR_CONNECTOR_ID,
  SEC_EDGAR_MAX_REQUESTS_PER_SECOND,
  seedOfficialSources,
  TICKER_TO_CIK,
  tickersForCik,
  type OfficialConnectorDeps,
} from './official';
export {
  connectorFetch,
  errorMessage,
  isNewsConnectorError,
  NewsConnectorError,
  NEWS_CONNECTOR_ERROR_KINDS,
  probeConnector,
  truncateText,
  type ConnectorDeps,
  type ConnectorFetch,
  type ConnectorFetchInit,
  type ConnectorFetchResponse,
  type ConnectorRateLimits,
  type ConnectorSourceConfig,
  type ConnectorTestResult,
  type NewsConnector,
  type NewsConnectorErrorKind,
  type RawNewsItem,
} from './types';
