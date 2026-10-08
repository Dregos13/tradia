/**
 * Base de los conectores oficiales — Fase 1b.
 *
 * Los organismos oficiales (Fed, BCE, BLS, BEA, CNMV, SEC EDGAR) publican
 * sus comunicados como feeds RSS/Atom en endpoints fijos. Cada conector de
 * `official/` es una especialización de `createOfficialFeedConnector`:
 * declara sus feeds por defecto, un User-Agent identificado (SEC y BLS
 * rechazan herramientas sin declarar — ver «SEC.gov: Your Request
 * Originates from an Undeclared Automated Tool») y, cuando hace falta,
 * una espera mínima entre peticiones (EDGAR: máx. 10 req/s).
 *
 * - `source.url` (si la fuente la trae) sustituye a todos los feeds por
 *   defecto: así las pruebas E2E apuntan cada fuente oficial a un feed
 *   local `file://` sin tocar el conector.
 * - Varios feeds por fuente se leen en serie respetando `minIntervalMs`;
 *   los ítems se fusionan deduplicados (guid/URL/título, como el parser
 *   RSS interno) y `mapItems` puede etiquetarlos (p. ej. el ticker del CIK
 *   de EDGAR).
 * - Fallo tolerante por feed: una fuente con varios feeds devuelve lo que
 *   haya llegado y anota el error en el log; solo si ningún feed responde
 *   se propaga el primer `NewsConnectorError`.
 */
import { createRssConnector } from '../rss';
import {
  connectorFetch,
  isNewsConnectorError,
  NewsConnectorError,
  probeConnector,
  type ConnectorDeps,
  type ConnectorFetch,
  type ConnectorRateLimits,
  type ConnectorSourceConfig,
  type ConnectorTestResult,
  type NewsConnector,
  type RawNewsItem,
} from '../types';

/**
 * User-Agent declarado que exigen SEC EDGAR y BLS (nombre + contacto con
 * dominio). Los demás organismos lo aceptan igualmente.
 */
export const OFFICIAL_USER_AGENT = 'Tradia/0.1 (admin@tradia.app)';

/** Cuota prudente para feeds públicos sin límite publicado. */
export const OFFICIAL_FEED_RATE_LIMITS: ConnectorRateLimits = { perHour: 60, perDay: 1440 };

/** Dependencias de los conectores oficiales; todo inyectable en pruebas. */
export interface OfficialConnectorDeps extends ConnectorDeps {
  /** Espera real del limitador entre peticiones; en pruebas no duerme. */
  sleep?: (ms: number) => Promise<void>;
}

export interface OfficialFeedSpec {
  /** Id del conector ('fed', 'sec-edgar'…): lo guarda `news_sources.conector`. */
  id: string;
  /**
   * URLs de feed por defecto cuando la fuente no trae `url` propia, o una
   * función que las calcula desde `source.params` (SEC EDGAR por CIK).
   */
  feeds: readonly string[] | ((source: ConnectorSourceConfig) => string[]);
  rateLimits: ConnectorRateLimits;
  /** User-Agent propio; por defecto `OFFICIAL_USER_AGENT`. */
  userAgent?: string;
  /** Espera mínima entre peticiones (SEC: 100 ms → máx. 10 req/s). */
  minIntervalMs?: number;
  /** Ajusta los ítems de cada feed (p. ej. añade el ticker del CIK). */
  mapItems?: (
    items: RawNewsItem[],
    feedUrl: string,
    source: ConnectorSourceConfig,
  ) => RawNewsItem[];
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Re-etiqueta el error del parser RSS interno con el id del conector oficial. */
function retagError(error: unknown, connectorId: string): NewsConnectorError {
  if (isNewsConnectorError(error)) {
    return new NewsConnectorError(error.kind, error.message.replace('[rss]', `[${connectorId}]`), {
      connector: connectorId,
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      cause: error,
    });
  }
  return new NewsConnectorError('network', `[${connectorId}] ${String(error)}`, {
    connector: connectorId,
    cause: error,
  });
}

export function createOfficialFeedConnector(
  spec: OfficialFeedSpec,
  deps: OfficialConnectorDeps = {},
): NewsConnector {
  const fetchImpl: ConnectorFetch = deps.fetch ?? connectorFetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const minIntervalMs = spec.minIntervalMs ?? 0;
  const userAgent = spec.userAgent ?? OFFICIAL_USER_AGENT;

  // El parseo es el del conector RSS/Atom; solo cambia el User-Agent.
  const inner = createRssConnector({
    fetch: (url, init = {}) =>
      fetchImpl(url, {
        ...init,
        headers: { ...init.headers, 'User-Agent': userAgent },
      }),
    now,
    logger: deps.logger,
  });

  // Ventana deslizante entre peticiones: persiste entre pasadas del lector.
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  const throttle = async (): Promise<void> => {
    if (minIntervalMs <= 0) return;
    const wait = minIntervalMs - (now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
  };

  const resolveFeeds = (source: ConnectorSourceConfig): string[] => {
    if (source.url) return [source.url];
    return typeof spec.feeds === 'function' ? spec.feeds(source) : [...spec.feeds];
  };

  const fetchItems = async (source: ConnectorSourceConfig): Promise<RawNewsItem[]> => {
    const urls = resolveFeeds(source);
    if (urls.length === 0) {
      throw new NewsConnectorError(
        'bad-data',
        `[${spec.id}] la fuente '${source.name}' no define ningún feed`,
        { connector: spec.id },
      );
    }

    const items: RawNewsItem[] = [];
    const seen = new Set<string>();
    const errors: unknown[] = [];
    for (const url of urls) {
      await throttle();
      try {
        const raw = await inner.fetchItems({ ...source, url });
        for (const item of spec.mapItems?.(raw, url, source) ?? raw) {
          const key = item.externalId ?? item.url ?? item.title;
          if (!seen.has(key)) {
            seen.add(key);
            // La fiabilidad del organismo también viaja en el ítem por si la
            // ingesta la prefiere a la de la fuente.
            items.push({ reliability: 'oficial', ...item });
          }
        }
      } catch (error) {
        errors.push(error);
        deps.logger?.warn(`[${spec.id}] feed '${url}' falló: ${String(error)}`);
      }
    }

    // Solo se propaga el fallo si ningún feed respondió con ítems.
    if (items.length === 0 && errors.length > 0) {
      throw retagError(errors[0], spec.id);
    }
    return items;
  };

  const test = (source: ConnectorSourceConfig): Promise<ConnectorTestResult> =>
    probeConnector(() => fetchItems(source), now);

  return {
    id: spec.id,
    secretsKey: null,
    // Los organismos fijan su endpoint: el alta no exige URL (aunque la
    // admite como sustituto para feeds locales en pruebas E2E).
    requiresUrl: false,
    rateLimits: spec.rateLimits,
    fetchItems,
    test,
  };
}
