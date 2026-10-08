/**
 * Conector GDELT — `GET /api/v2/doc/doc` modo ArtList — Fase 1b.
 *
 * - Sin clave (`secretsKey: null`): GDELT DOC 2 API es abierta. Aun así se
 *   respeta una cuota de cortesía en `GDELT_RATE_LIMITS` para no
 *   martillear el servicio.
 * - `params` admitidos: `query` (sintaxis GDELT, por defecto una consulta
 *   de mercados), `timespan` ('15min', '24h', '7d'…; por defecto '1d'),
 *   `maxrecords` (1-250, por defecto 50), `sort`
 *   (datedesc|dateasc|hybridrel, por defecto 'datedesc'), `sourcelang`
 *   ('english', 'spanish'…) y `sourcecountry' (código FIPS, 'us', 'sp'…).
 *   `url` en la fuente sustituye el endpoint tal cual (respuestas grabadas
 *   `file://`).
 * - Normalización: `title`/`url`, `seendate` ('YYYYMMDDHHMMSS', UTC)→ISO,
 *   `domain`→sourceName (la publicación original), `url`→externalId.
 *   GDELT no trae resumen ni tickers: summary null y assets [].
 * - Errores: GDELT responde avisos en texto plano con 200 o 4xx; un cuerpo
 *   no-JSON es 'bad-data' con el detalle saneado, y el mapa HTTP cubre
 *   429 (rate-limit) y 5xx (network).
 * - Fiabilidad por ítem: 'prensa', o 'agencia' si el dominio es de
 *   Reuters, AP, Bloomberg o Dow Jones (`inferItemReliability`).
 */
import { createRateLimiter } from '../../market/providers/rateLimiter';
import {
  acquireQuota,
  apiError,
  compactUtcToIso,
  dedupeItems,
  fetchJson,
  inferItemReliability,
  intParam,
  normalizeItemUrl,
  resolveApiDeps,
  stringParam,
  MAX_API_TITLE_LENGTH,
  type ApiConnectorDeps,
} from './api';
import {
  probeConnector,
  truncateText,
  type ConnectorRateLimits,
  type ConnectorSourceConfig,
  type ConnectorTestResult,
  type NewsConnector,
  type RawNewsItem,
} from './types';

export const GDELT_CONNECTOR_ID = 'gdelt';
export const GDELT_BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
/**
 * GDELT no publica cuota ni pide clave; cortesía conservadora equivalente
 * a ~1 petición cada 10 s sostenidas.
 */
export const GDELT_RATE_LIMITS: ConnectorRateLimits = { perHour: 360, perDay: 7_200 };

/** Consulta por defecto: actualidad de mercados en cualquier idioma. */
export const GDELT_DEFAULT_QUERY = '(markets OR stocks OR economy OR finance)';
const TIMESPAN_PATTERN = /^[0-9]{1,3}(min|h|d|w|m)$/i;
const SOURCELANG_PATTERN = /^[a-z]{2,20}$/i;
const SOURCECOUNTRY_PATTERN = /^[a-z0-9]{1,6}$/i;
const GDELT_SORTS = ['datedesc', 'dateasc', 'hybridrel'] as const;

interface GdeltArticle {
  url?: unknown;
  title?: unknown;
  seendate?: unknown;
  domain?: unknown;
  language?: unknown;
  sourcecountry?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function mapArticle(raw: unknown, now: () => number): RawNewsItem | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const article = raw as GdeltArticle;
  const title = asString(article.title);
  if (!title) return null;

  const url = normalizeItemUrl(article.url);
  const publishedAt = compactUtcToIso(article.seendate) ?? new Date(now()).toISOString();
  const sourceName = asString(article.domain);

  return {
    title: truncateText(title, MAX_API_TITLE_LENGTH),
    url,
    publishedAt,
    summary: null,
    externalId: url,
    assets: [],
    sourceName,
    reliability: inferItemReliability(sourceName),
  };
}

export function createGdeltConnector(deps: ApiConnectorDeps = {}): NewsConnector {
  const now = deps.now ?? (() => Date.now());
  const runtime = resolveApiDeps(
    deps,
    { baseUrl: GDELT_BASE_URL },
    createRateLimiter({ limits: GDELT_RATE_LIMITS, providerId: GDELT_CONNECTOR_ID, now }),
  );

  const fetchItems = async (source: ConnectorSourceConfig): Promise<RawNewsItem[]> => {
    const query = stringParam(source.params, 'query', GDELT_CONNECTOR_ID) ?? GDELT_DEFAULT_QUERY;
    const timespan = (
      stringParam(source.params, 'timespan', GDELT_CONNECTOR_ID, TIMESPAN_PATTERN) ?? '1d'
    ).toLowerCase();
    // La documentación de GDELT escribe 'DateDesc'; se admite cualquier caso.
    const sortInput = stringParam(source.params, 'sort', GDELT_CONNECTOR_ID);
    const sort = (sortInput ?? 'datedesc').toLowerCase();
    if (!(GDELT_SORTS as readonly string[]).includes(sort)) {
      throw apiError(
        GDELT_CONNECTOR_ID,
        'bad-data',
        `el parámetro 'sort' debe ser uno de: ${GDELT_SORTS.join(', ')}`,
      );
    }
    const sourcelang = stringParam(
      source.params,
      'sourcelang',
      GDELT_CONNECTOR_ID,
      SOURCELANG_PATTERN,
    );
    const sourcecountry = stringParam(
      source.params,
      'sourcecountry',
      GDELT_CONNECTOR_ID,
      SOURCECOUNTRY_PATTERN,
    );
    const maxrecords = intParam(
      source.params,
      'maxrecords',
      { min: 1, max: 250, fallback: 50 },
      GDELT_CONNECTOR_ID,
    );

    let url = source.url;
    if (!url) {
      const params = new URLSearchParams({
        query,
        mode: 'ArtList',
        format: 'json',
        maxrecords: String(maxrecords),
        timespan,
        sort,
      });
      if (sourcelang) params.set('sourcelang', sourcelang.toLowerCase());
      if (sourcecountry) params.set('sourcecountry', sourcecountry.toUpperCase());
      url = `${runtime.baseUrl}?${params.toString()}`;
    }

    await acquireQuota(runtime.limiter, GDELT_CONNECTOR_ID);

    const payload = await fetchJson(runtime.fetchImpl, url, {
      connectorId: GDELT_CONNECTOR_ID,
      timeoutMs: runtime.timeoutMs,
    });

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw apiError(GDELT_CONNECTOR_ID, 'bad-data', 'la respuesta no es un objeto JSON');
    }
    const record = payload as Record<string, unknown>;
    if (!Array.isArray(record.articles)) {
      throw apiError(
        GDELT_CONNECTOR_ID,
        'bad-data',
        `respuesta sin lista 'articles': ${truncateText(JSON.stringify(record), 200)}`,
      );
    }

    const items: RawNewsItem[] = [];
    for (const raw of record.articles) {
      const item = mapArticle(raw, now);
      if (item === null) {
        runtime.logger?.warn('[gdelt] artículo descartado por no tener titular');
        continue;
      }
      items.push(item);
    }
    return dedupeItems(items);
  };

  const test = (source: ConnectorSourceConfig): Promise<ConnectorTestResult> =>
    probeConnector(() => fetchItems(source), now);

  return {
    id: GDELT_CONNECTOR_ID,
    secretsKey: null,
    rateLimits: GDELT_RATE_LIMITS,
    fetchItems,
    test,
  };
}
