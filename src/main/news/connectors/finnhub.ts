/**
 * Conector Finnhub — `GET /api/v1/news` (mercado general) — Fase 1b.
 *
 * - Clave: servicio `secrets`, clave 'finnhub' (`FINNHUB_SECRETS_KEY`);
 *   viaja en la cabecera `X-Finnhub-Token`, nunca en la URL ni en errores.
 * - Cuota gratuita (~60 llamadas/minuto): se aplica con ventanas de una
 *   hora y un día en `FINNHUB_RATE_LIMITS`, con margen conservador, igual
 *   que el proveedor Tiingo.
 * - `params` admitidos: `category` ∈ general|forex|crypto|merger
 *   (por defecto 'general'). `url` en la fuente sustituye el endpoint
 *   tal cual (respuestas grabadas, proxies autenticados); la clave se
 *   sigue exigiendo pero no se envía al endpoint alternativo.
 * - Normalización: `headline`→título, `url`, `datetime` (unix s)→ISO UTC,
 *   `summary` a texto plano, `id`→externalId, `source`→sourceName y
 *   `related` (lista separada por comas)→assets en mayúsculas.
 * - Fiabilidad por ítem: 'prensa', o 'agencia' si `source` es Reuters, AP,
 *   Bloomberg o Dow Jones (`inferItemReliability`).
 */
import { TICKER_PATTERN } from '../../../shared/ipc';
import { createRateLimiter } from '../../market/providers/rateLimiter';
import { stripHtml } from './rss';
import {
  acquireQuota,
  apiError,
  dedupeItems,
  enumParam,
  fetchJson,
  inferItemReliability,
  normalizeItemUrl,
  redact,
  requireApiKey,
  resolveApiDeps,
  MAX_API_ASSETS,
  MAX_API_SUMMARY_LENGTH,
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

export const FINNHUB_CONNECTOR_ID = 'finnhub';
/** Nombre de la clave en el servicio secrets. */
export const FINNHUB_SECRETS_KEY = 'finnhub';
export const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
/**
 * Nivel gratuito: ~60 llamadas/minuto. Con ventanas de hora/día queda en
 * ~30/min sostenidos (margen conservador); el intervalo de la fuente ya
 * limita aún más cada lectura programada.
 */
export const FINNHUB_RATE_LIMITS: ConnectorRateLimits = { perHour: 1_800, perDay: 43_200 };

const FINNHUB_CATEGORIES = ['general', 'forex', 'crypto', 'merger'] as const;

interface FinnhubArticle {
  category?: unknown;
  datetime?: unknown;
  headline?: unknown;
  id?: unknown;
  related?: unknown;
  source?: unknown;
  summary?: unknown;
  url?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** 'AAPL,MSFT' → ['AAPL','MSFT'], solo tickers con forma válida. */
function parseRelated(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const tickers = new Set<string>();
  for (const raw of value.split(',')) {
    const ticker = raw.trim().toUpperCase();
    if (TICKER_PATTERN.test(ticker)) tickers.add(ticker);
    if (tickers.size >= MAX_API_ASSETS) break;
  }
  return [...tickers];
}

function mapArticle(raw: unknown, now: () => number): RawNewsItem | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const article = raw as FinnhubArticle;
  const title = asString(article.headline);
  if (!title) return null;

  const url = normalizeItemUrl(article.url);
  const datetime = typeof article.datetime === 'number' ? article.datetime : null;
  const publishedAt =
    datetime !== null && Number.isFinite(datetime)
      ? new Date(datetime * 1000).toISOString()
      : new Date(now()).toISOString();
  const summary = asString(article.summary);
  const sourceName = asString(article.source);

  return {
    title: truncateText(title, MAX_API_TITLE_LENGTH),
    url,
    publishedAt,
    summary: summary ? truncateText(stripHtml(summary), MAX_API_SUMMARY_LENGTH) : null,
    externalId: article.id !== undefined && article.id !== null ? String(article.id) : url,
    assets: parseRelated(article.related),
    sourceName,
    reliability: inferItemReliability(sourceName),
  };
}

export function createFinnhubConnector(deps: ApiConnectorDeps = {}): NewsConnector {
  const now = deps.now ?? (() => Date.now());
  const runtime = resolveApiDeps(
    deps,
    { baseUrl: FINNHUB_BASE_URL },
    createRateLimiter({ limits: FINNHUB_RATE_LIMITS, providerId: FINNHUB_CONNECTOR_ID, now }),
  );

  const fetchItems = async (source: ConnectorSourceConfig): Promise<RawNewsItem[]> => {
    // La clave se exige siempre: «Probar conexión» debe detectar que falta
    // aunque la fuente apunte a un endpoint alternativo.
    const apiKey = await requireApiKey(
      runtime.getApiKey,
      FINNHUB_SECRETS_KEY,
      FINNHUB_CONNECTOR_ID,
    );
    const category = enumParam(
      source.params,
      'category',
      FINNHUB_CATEGORIES,
      'general',
      FINNHUB_CONNECTOR_ID,
    );
    const override = source.url;
    const url = override ?? `${runtime.baseUrl}/news?category=${encodeURIComponent(category)}`;

    await acquireQuota(runtime.limiter, FINNHUB_CONNECTOR_ID);

    const payload = await fetchJson(runtime.fetchImpl, url, {
      connectorId: FINNHUB_CONNECTOR_ID,
      // La clave solo viaja al endpoint oficial; a uno alternativo no se envía.
      headers: override ? {} : { 'X-Finnhub-Token': apiKey },
      timeoutMs: runtime.timeoutMs,
      apiKey,
    });

    // Finnhub a veces responde 200 con {"error":"…"} en lugar de la lista.
    if (!Array.isArray(payload)) {
      const detail =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? truncateText(redact(String((payload as { error: unknown }).error), apiKey), 200)
          : '';
      const kind = /api.?key|invalid|unauthorized/i.test(detail) ? 'auth' : 'bad-data';
      throw apiError(
        FINNHUB_CONNECTOR_ID,
        kind,
        `respuesta sin lista de noticias${detail ? `: ${detail}` : ''}`,
      );
    }

    const items: RawNewsItem[] = [];
    for (const raw of payload) {
      const item = mapArticle(raw, now);
      if (item === null) {
        runtime.logger?.warn('[finnhub] artículo descartado por no tener titular');
        continue;
      }
      items.push(item);
    }
    return dedupeItems(items);
  };

  const test = (source: ConnectorSourceConfig): Promise<ConnectorTestResult> =>
    probeConnector(() => fetchItems(source), now);

  return {
    id: FINNHUB_CONNECTOR_ID,
    secretsKey: FINNHUB_SECRETS_KEY,
    rateLimits: FINNHUB_RATE_LIMITS,
    fetchItems,
    test,
  };
}
