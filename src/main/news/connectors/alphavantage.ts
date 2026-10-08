/**
 * Conector Alpha Vantage — `NEWS_SENTIMENT` — Fase 1b.
 *
 * - Clave: servicio `secrets`, clave 'alphavantage'; viaja en el parámetro
 *   `apikey` de la query (la API no admite cabecera) y se redacta de todo
 *   mensaje de error (`redact`).
 * - Cuota gratuita (25 peticiones/día): `ALPHAVANTAGE_RATE_LIMITS` sobre el
 *   limitador de ventanas deslizantes de market/providers.
 * - `params` admitidos: `tickers` (lista de tickers válidos), `topics`
 *   (economy_macro, financial_markets…) y `limit` (1-200, por defecto 50).
 *   `url` en la fuente sustituye el endpoint tal cual (respuestas grabadas
 *   `file://`, proxies autenticados); la clave se sigue exigiendo pero no
 *   se envía al endpoint alternativo.
 * - Normalización: `title`/`url`, `time_published` ('YYYYMMDDTHHMMSS')→ISO
 *   UTC, `summary` a texto plano, `source`/`source_domain`→sourceName,
 *   `ticker_sentiment[].ticker`→assets y `url`→externalId.
 * - Errores de cuenta: Alpha Vantage informa con HTTP 200 y un campo
 *   `Information`/`Note` (cuota) o `Error Message` (parámetro o clave);
 *   se traducen a 'rate-limit', 'auth' o 'bad-data' con el texto saneado.
 * - Fiabilidad por ítem: 'prensa', o 'agencia' si la fuente original es
 *   Reuters, AP, Bloomberg o Dow Jones (`inferItemReliability`).
 */
import { TICKER_PATTERN } from '../../../shared/ipc';
import { createRateLimiter } from '../../market/providers/rateLimiter';
import { stripHtml } from './rss';
import {
  acquireQuota,
  apiError,
  compactUtcToIso,
  dedupeItems,
  fetchJson,
  inferItemReliability,
  intParam,
  normalizeItemUrl,
  redact,
  requireApiKey,
  resolveApiDeps,
  stringListParam,
  MAX_API_ASSETS,
  MAX_API_SUMMARY_LENGTH,
  MAX_API_TITLE_LENGTH,
  type ApiConnectorDeps,
} from './api';
import {
  probeConnector,
  truncateText,
  NewsConnectorError,
  type ConnectorRateLimits,
  type ConnectorSourceConfig,
  type ConnectorTestResult,
  type NewsConnector,
  type RawNewsItem,
} from './types';

export const ALPHAVANTAGE_CONNECTOR_ID = 'alphavantage';
/** Nombre de la clave en el servicio secrets. */
export const ALPHAVANTAGE_SECRETS_KEY = 'alphavantage';
export const ALPHAVANTAGE_BASE_URL = 'https://www.alphavantage.co/query';
/** Nivel gratuito actual: 25 peticiones al día (sin reparto por hora). */
export const ALPHAVANTAGE_RATE_LIMITS: ConnectorRateLimits = { perHour: 25, perDay: 25 };

const TOPIC_PATTERN = /^[a-z_]{2,50}$/i;

interface AlphaVantageArticle {
  title?: unknown;
  url?: unknown;
  time_published?: unknown;
  summary?: unknown;
  source?: unknown;
  source_domain?: unknown;
  ticker_sentiment?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** ticker_sentiment → tickers en mayúsculas con forma válida. */
function parseTickerSentiment(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tickers = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = (entry as { ticker?: unknown }).ticker;
    if (typeof raw !== 'string') continue;
    const ticker = raw.trim().toUpperCase();
    if (TICKER_PATTERN.test(ticker)) tickers.add(ticker);
    if (tickers.size >= MAX_API_ASSETS) break;
  }
  return [...tickers];
}

function mapArticle(raw: unknown, now: () => number): RawNewsItem | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const article = raw as AlphaVantageArticle;
  const title = asString(article.title);
  if (!title) return null;

  const url = normalizeItemUrl(article.url);
  const publishedAt = compactUtcToIso(article.time_published) ?? new Date(now()).toISOString();
  const summary = asString(article.summary);
  const sourceName = asString(article.source) ?? asString(article.source_domain);

  return {
    title: truncateText(title, MAX_API_TITLE_LENGTH),
    url,
    publishedAt,
    summary: summary ? truncateText(stripHtml(summary), MAX_API_SUMMARY_LENGTH) : null,
    externalId: url,
    assets: parseTickerSentiment(article.ticker_sentiment),
    sourceName,
    reliability: inferItemReliability(sourceName),
  };
}

/**
 * Avisos de cuenta de Alpha Vantage dentro de un 200: `Information` y
 * `Note` cubren la cuota diaria; `Error Message`, parámetros o clave.
 */
function payloadError(payload: Record<string, unknown>, apiKey: string): NewsConnectorError | null {
  const information = asString(payload.Information) ?? asString(payload.Note);
  if (information !== null) {
    const detail = truncateText(redact(information, apiKey), 200);
    // La cuota manda antes: el aviso de límite menciona los «premium plans».
    if (/rate limit|requests? per|call frequency|exceeded/i.test(information)) {
      return apiError(ALPHAVANTAGE_CONNECTOR_ID, 'rate-limit', `cuota de la API: ${detail}`);
    }
    if (/api.?key|invalid|denied|premium/i.test(information)) {
      return apiError(ALPHAVANTAGE_CONNECTOR_ID, 'auth', `la API rechazó la clave: ${detail}`);
    }
    return apiError(ALPHAVANTAGE_CONNECTOR_ID, 'rate-limit', `aviso de la API: ${detail}`);
  }
  const errorMessage = asString(payload['Error Message']);
  if (errorMessage !== null) {
    const detail = truncateText(redact(errorMessage, apiKey), 200);
    const kind = /api.?key|invalid|denied/i.test(errorMessage) ? 'auth' : 'bad-data';
    return apiError(ALPHAVANTAGE_CONNECTOR_ID, kind, `la API rechazó la petición: ${detail}`);
  }
  return null;
}

export function createAlphaVantageConnector(deps: ApiConnectorDeps = {}): NewsConnector {
  const now = deps.now ?? (() => Date.now());
  const runtime = resolveApiDeps(
    deps,
    { baseUrl: ALPHAVANTAGE_BASE_URL },
    createRateLimiter({
      limits: ALPHAVANTAGE_RATE_LIMITS,
      providerId: ALPHAVANTAGE_CONNECTOR_ID,
      now,
    }),
  );

  const fetchItems = async (source: ConnectorSourceConfig): Promise<RawNewsItem[]> => {
    const apiKey = await requireApiKey(
      runtime.getApiKey,
      ALPHAVANTAGE_SECRETS_KEY,
      ALPHAVANTAGE_CONNECTOR_ID,
    );
    const tickers = stringListParam(
      source.params,
      'tickers',
      TICKER_PATTERN,
      ALPHAVANTAGE_CONNECTOR_ID,
    );
    const topics = stringListParam(
      source.params,
      'topics',
      TOPIC_PATTERN,
      ALPHAVANTAGE_CONNECTOR_ID,
    );
    const limit = intParam(
      source.params,
      'limit',
      { min: 1, max: 200, fallback: 50 },
      ALPHAVANTAGE_CONNECTOR_ID,
    );

    const override = source.url;
    let url: string;
    if (override) {
      url = override;
    } else {
      const query = new URLSearchParams({
        function: 'NEWS_SENTIMENT',
        apikey: apiKey,
        limit: String(limit),
      });
      if (tickers.length > 0) query.set('tickers', tickers.join(',').toUpperCase());
      if (topics.length > 0) query.set('topics', topics.join(',').toLowerCase());
      url = `${runtime.baseUrl}?${query.toString()}`;
    }

    await acquireQuota(runtime.limiter, ALPHAVANTAGE_CONNECTOR_ID);

    const payload = await fetchJson(runtime.fetchImpl, url, {
      connectorId: ALPHAVANTAGE_CONNECTOR_ID,
      timeoutMs: runtime.timeoutMs,
      apiKey,
    });

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw apiError(ALPHAVANTAGE_CONNECTOR_ID, 'bad-data', 'la respuesta no es un objeto JSON');
    }
    const record = payload as Record<string, unknown>;
    const known = payloadError(record, apiKey);
    if (known !== null) throw known;
    if (!Array.isArray(record.feed)) {
      throw apiError(
        ALPHAVANTAGE_CONNECTOR_ID,
        'bad-data',
        `respuesta sin lista 'feed': ${truncateText(redact(JSON.stringify(record), apiKey), 200)}`,
      );
    }

    const items: RawNewsItem[] = [];
    for (const raw of record.feed) {
      const item = mapArticle(raw, now);
      if (item === null) {
        runtime.logger?.warn('[alphavantage] artículo descartado por no tener titular');
        continue;
      }
      items.push(item);
    }
    return dedupeItems(items);
  };

  const test = (source: ConnectorSourceConfig): Promise<ConnectorTestResult> =>
    probeConnector(() => fetchItems(source), now);

  return {
    id: ALPHAVANTAGE_CONNECTOR_ID,
    secretsKey: ALPHAVANTAGE_SECRETS_KEY,
    rateLimits: ALPHAVANTAGE_RATE_LIMITS,
    fetchItems,
    test,
  };
}
