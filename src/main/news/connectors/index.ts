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
import { createRssConnector } from './rss';
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
  connectorFetch,
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
