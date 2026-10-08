/**
 * Conector NewsAPI — `GET /v2/top-headlines` — Fase 1b.
 *
 * - Clave: servicio `secrets`, clave 'newsapi'; viaja en la cabecera
 *   `X-Api-Key`, nunca en la URL ni en los mensajes de error.
 * - Cuota del plan de desarrollo (100 peticiones/día):
 *   `NEWSAPI_RATE_LIMITS` con el limitador de ventanas deslizantes.
 * - `params` admitidos: `category` (business por defecto), `country` y
 *   `language` (ISO de 2 letras), `q` (búsqueda libre en titular/cuerpo) y
 *   `pageSize` (1-100, por defecto 50). `url` en la fuente sustituye el
 *   endpoint tal cual; la clave se sigue exigiendo pero no se envía al
 *   endpoint alternativo.
 * - Normalización: `title`/`url`/`publishedAt` (ya ISO), `description`→
 *   resumen en texto plano, `source.name`→sourceName, `url`→externalId.
 *   Los artículos retirados ('[Removed]') se descartan.
 * - Errores: NewsAPI informa con `{"status":"error","code":…}`; el código
 *   decide el tipo (apiKeyInvalid→'auth', rateLimited/apiKeyExhausted→
 *   'rate-limit', parameterInvalid→'bad-data'…) tanto si llega con un
 *   estado 4xx como en un 200.
 * - Fiabilidad por ítem: 'prensa', o 'agencia' si `source.name` es
 *   Reuters, AP, Bloomberg o Dow Jones (`inferItemReliability`).
 */
import { createRateLimiter } from '../../market/providers/rateLimiter';
import { stripHtml } from './rss';
import {
  acquireQuota,
  apiError,
  dedupeItems,
  enumParam,
  fetchJson,
  inferItemReliability,
  intParam,
  normalizeItemUrl,
  redact,
  requireApiKey,
  resolveApiDeps,
  stringParam,
  toUtcIso,
  MAX_API_SUMMARY_LENGTH,
  MAX_API_TITLE_LENGTH,
  type ApiConnectorDeps,
} from './api';
import {
  NewsConnectorError,
  probeConnector,
  truncateText,
  type ConnectorRateLimits,
  type ConnectorSourceConfig,
  type ConnectorTestResult,
  type NewsConnector,
  type NewsConnectorErrorKind,
  type RawNewsItem,
} from './types';

export const NEWSAPI_CONNECTOR_ID = 'newsapi';
/** Nombre de la clave en el servicio secrets. */
export const NEWSAPI_SECRETS_KEY = 'newsapi';
export const NEWSAPI_BASE_URL = 'https://newsapi.org/v2';
/** Plan de desarrollo gratuito: 100 peticiones al día. */
export const NEWSAPI_RATE_LIMITS: ConnectorRateLimits = { perHour: 100, perDay: 100 };

const NEWSAPI_CATEGORIES = [
  'business',
  'entertainment',
  'general',
  'health',
  'science',
  'sports',
  'technology',
] as const;
const ISO_ALPHA2_PATTERN = /^[a-z]{2}$/i;

/** Código de error de NewsAPI → tipo de error del conector. */
const NEWSAPI_ERROR_KINDS: Record<string, NewsConnectorErrorKind> = {
  apiKeyMissing: 'auth',
  apiKeyInvalid: 'auth',
  apiKeyDisabled: 'auth',
  corsNotAllowed: 'auth',
  // El plan no da acceso al recurso: se informa como problema de credencial.
  upgradeRequired: 'auth',
  apiKeyExhausted: 'rate-limit',
  rateLimited: 'rate-limit',
  maximumResultsReached: 'rate-limit',
  parameterInvalid: 'bad-data',
  parametersMissing: 'bad-data',
  sourcesTooMany: 'bad-data',
  sourceDoesNotExist: 'not-found',
  unexpectedError: 'network',
};

interface NewsApiArticle {
  source?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  publishedAt?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function mapArticle(raw: unknown, now: () => number): RawNewsItem | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const article = raw as NewsApiArticle;
  const title = asString(article.title);
  // NewsAPI devuelve '[Removed]' en los artículos retirados por el medio.
  if (!title || title === '[Removed]') return null;

  const url = normalizeItemUrl(article.url);
  const publishedAt = toUtcIso(article.publishedAt) ?? new Date(now()).toISOString();
  const summary = asString(article.description);
  const sourceName =
    typeof article.source === 'object' && article.source !== null
      ? asString((article.source as { name?: unknown }).name)
      : null;

  return {
    title: truncateText(title, MAX_API_TITLE_LENGTH),
    url,
    publishedAt,
    summary: summary ? truncateText(stripHtml(summary), MAX_API_SUMMARY_LENGTH) : null,
    externalId: url,
    assets: [],
    sourceName,
    reliability: inferItemReliability(sourceName),
  };
}

/**
 * Lee `{"status":"error","code":…,"message":…}` de un cuerpo —NewsAPI lo
 * manda tanto en respuestas 4xx como en 200— y lo traduce al tipo que toca.
 */
function apiErrorFromBody(
  body: string,
  apiKey: string,
  status?: number,
  retryAfterMs?: number,
): NewsConnectorError | null {
  try {
    const payload = JSON.parse(body) as { status?: unknown; code?: unknown; message?: unknown };
    if (payload?.status !== 'error') return null;
    const code = asString(payload.code) ?? '';
    const detail = truncateText(redact(asString(payload.message) ?? code, apiKey), 200);
    return apiError(
      NEWSAPI_CONNECTOR_ID,
      NEWSAPI_ERROR_KINDS[code] ?? 'bad-data',
      `error de la API (${code || 'desconocido'}): ${detail}`,
      status,
      retryAfterMs,
    );
  } catch {
    return null;
  }
}

export function createNewsApiConnector(deps: ApiConnectorDeps = {}): NewsConnector {
  const now = deps.now ?? (() => Date.now());
  const runtime = resolveApiDeps(
    deps,
    { baseUrl: NEWSAPI_BASE_URL },
    createRateLimiter({ limits: NEWSAPI_RATE_LIMITS, providerId: NEWSAPI_CONNECTOR_ID, now }),
  );

  const fetchItems = async (source: ConnectorSourceConfig): Promise<RawNewsItem[]> => {
    const apiKey = await requireApiKey(
      runtime.getApiKey,
      NEWSAPI_SECRETS_KEY,
      NEWSAPI_CONNECTOR_ID,
    );
    const category = enumParam(
      source.params,
      'category',
      NEWSAPI_CATEGORIES,
      'business',
      NEWSAPI_CONNECTOR_ID,
    );
    const country = stringParam(source.params, 'country', NEWSAPI_CONNECTOR_ID, ISO_ALPHA2_PATTERN);
    const language = stringParam(
      source.params,
      'language',
      NEWSAPI_CONNECTOR_ID,
      ISO_ALPHA2_PATTERN,
    );
    const q = stringParam(source.params, 'q', NEWSAPI_CONNECTOR_ID);
    const pageSize = intParam(
      source.params,
      'pageSize',
      { min: 1, max: 100, fallback: 50 },
      NEWSAPI_CONNECTOR_ID,
    );

    const override = source.url;
    let url: string;
    if (override) {
      url = override;
    } else {
      const query = new URLSearchParams({ category, pageSize: String(pageSize) });
      if (country) query.set('country', country.toLowerCase());
      if (language) query.set('language', language.toLowerCase());
      if (q) query.set('q', q);
      url = `${runtime.baseUrl}/top-headlines?${query.toString()}`;
    }

    await acquireQuota(runtime.limiter, NEWSAPI_CONNECTOR_ID);

    const payload = await fetchJson(runtime.fetchImpl, url, {
      connectorId: NEWSAPI_CONNECTOR_ID,
      headers: override ? {} : { 'X-Api-Key': apiKey },
      timeoutMs: runtime.timeoutMs,
      apiKey,
      errorBodyToError: (body, status, retryAfterMs) =>
        apiErrorFromBody(body, apiKey, status, retryAfterMs),
    });

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw apiError(NEWSAPI_CONNECTOR_ID, 'bad-data', 'la respuesta no es un objeto JSON');
    }
    const record = payload as Record<string, unknown>;
    if (record.status === 'error') {
      const known = apiErrorFromBody(JSON.stringify(record), apiKey);
      if (known !== null) throw known;
      throw apiError(NEWSAPI_CONNECTOR_ID, 'bad-data', 'la API devolvió un error sin código');
    }
    if (!Array.isArray(record.articles)) {
      throw apiError(
        NEWSAPI_CONNECTOR_ID,
        'bad-data',
        `respuesta sin lista 'articles': ${truncateText(redact(JSON.stringify(record), apiKey), 200)}`,
      );
    }

    const items: RawNewsItem[] = [];
    for (const raw of record.articles) {
      const item = mapArticle(raw, now);
      if (item === null) {
        runtime.logger?.warn('[newsapi] artículo descartado por no tener titular');
        continue;
      }
      items.push(item);
    }
    return dedupeItems(items);
  };

  const test = (source: ConnectorSourceConfig): Promise<ConnectorTestResult> =>
    probeConnector(() => fetchItems(source), now);

  return {
    id: NEWSAPI_CONNECTOR_ID,
    secretsKey: NEWSAPI_SECRETS_KEY,
    rateLimits: NEWSAPI_RATE_LIMITS,
    fetchItems,
    test,
  };
}
