/**
 * Utilidades compartidas de los conectores de API de noticias (Finnhub,
 * Alpha Vantage, NewsAPI, GDELT) — Fase 1b.
 *
 * Un `ApiConnectorDeps` añade al contrato base la posibilidad de inyectar
 * el `RateLimiter` (cuota local), la URL base y el tiempo de espera, para
 * que las pruebas no toquen la red ni esperen de verdad.
 *
 * Reglas comunes:
 * - La clave se pide a `secrets` por `secretsKey` (`requireApiKey`) y viaja
 *   en la cabecera o el parámetro propio de cada API, nunca en mensajes de
 *   error: todo texto externo se recorta y se redacta (`redact`).
 * - Cada petición pasa por `acquireQuota` (ventanas deslizantes de
 *   `market/providers/rateLimiter.ts`); el rechazo local se traduce a
 *   `NewsConnectorError` 'rate-limit' con `retryAfterMs`.
 * - Si la fuente define `url`, se consulta tal cual —sin añadir clave ni
 *   params— pensado para pruebas con respuestas grabadas (`file://`) y
 *   proxies ya autenticados. La clave se sigue exigiendo en las APIs con
 *   `secretsKey`: «Probar conexión» debe detectar que falta.
 * - La fiabilidad por ítem la fija `inferItemReliability`: 'prensa' por
 *   defecto, 'agencia' si la fuente original es Reuters, AP, Bloomberg o
 *   Dow Jones (regla de calidad de la sección 5.4 y guía de diseño).
 */
import { isMarketDataError } from '../../market/providers/types';
import type { RateLimiter } from '../../market/providers/rateLimiter';
import type { Reliability } from '../../../shared/ipc';
import {
  connectorFetch,
  isNewsConnectorError,
  NewsConnectorError,
  truncateText,
  type ConnectorDeps,
  type ConnectorFetch,
  type ConnectorFetchInit,
  type ConnectorFetchResponse,
  type NewsConnectorErrorKind,
  type RawNewsItem,
} from './types';

export const API_TIMEOUT_MS = 15_000;
export const API_USER_AGENT = 'Tradia/0.1 (lector de noticias de APIs financieras)';
/** Tope de ítems devueltos por pasada, alineado con el de RSS. */
export const MAX_API_ITEMS = 200;
/** Tope de resumen en texto plano, como en el conector RSS. */
export const MAX_API_SUMMARY_LENGTH = 500;
export const MAX_API_TITLE_LENGTH = 300;
/** Tope de tickers por titular aceptados de la API. */
export const MAX_API_ASSETS = 32;

/** Dependencias de los conectores de API, todas inyectables en pruebas. */
export interface ApiConnectorDeps extends ConnectorDeps {
  /** Endpoint alternativo (mocks); por defecto el oficial de cada API. */
  baseUrl?: string;
  /** Limitador inyectable; por defecto la cuota declarada del conector. */
  rateLimiter?: RateLimiter;
  timeoutMs?: number;
}

/** Error tipado del conector con el prefijo `[id]` uniforme del resto. */
export function apiError(
  connectorId: string,
  kind: NewsConnectorErrorKind,
  message: string,
  status?: number,
  retryAfterMs?: number,
  cause?: unknown,
): NewsConnectorError {
  return new NewsConnectorError(kind, `[${connectorId}] ${message}`, {
    connector: connectorId,
    status,
    retryAfterMs,
    cause,
  });
}

/** Quita la clave de cualquier texto externo antes de meterlo en un error. */
export function redact(text: string, apiKey: string | null | undefined): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

/**
 * Clave del servicio secrets, obligatoria en los conectores con
 * `secretsKey`. Sin clave el error es 'auth' con motivo legible para
 * «Probar conexión»; una clave en blanco cuenta como ausente.
 */
export async function requireApiKey(
  getApiKey: ConnectorDeps['getApiKey'],
  secretsKey: string,
  connectorId: string,
): Promise<string> {
  const apiKey = getApiKey ? await getApiKey(secretsKey) : null;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw apiError(
      connectorId,
      'auth',
      `sin clave de API guardada (secrets['${secretsKey}']): añádela en Ajustes`,
    );
  }
  return apiKey.trim();
}

/**
 * Ocupa un hueco de la cuota local. El rechazo del limitador
 * (`MarketDataError` 'rate-limit') se traduce al error del conector
 * conservando `retryAfterMs`, para que «Probar conexión» diga cuándo
 * volver a intentarlo.
 */
export async function acquireQuota(limiter: RateLimiter, connectorId: string): Promise<void> {
  try {
    await limiter.acquire();
  } catch (error) {
    if (isMarketDataError(error)) {
      throw apiError(connectorId, 'rate-limit', error.message, error.status, error.retryAfterMs);
    }
    throw error;
  }
}

/** Traduce una respuesta HTTP con error al `NewsConnectorError` que toca. */
export function httpError(
  connectorId: string,
  response: ConnectorFetchResponse,
  body: string,
  apiKey?: string | null,
): NewsConnectorError {
  const status = response.status;
  const detail = truncateText(redact(body, apiKey), 200);
  if (status === 401 || status === 403) {
    return apiError(
      connectorId,
      'auth',
      `credencial rechazada (HTTP ${status}): ${detail}`,
      status,
    );
  }
  if (status === 404) {
    return apiError(connectorId, 'not-found', `recurso no encontrado (HTTP 404)`, status);
  }
  if (status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    return apiError(
      connectorId,
      'rate-limit',
      `cuota de la API excedida (HTTP 429): ${detail}`,
      status,
      retryAfterMs,
    );
  }
  if (status >= 500) {
    return apiError(
      connectorId,
      'network',
      `error del servidor (HTTP ${status}): ${detail}`,
      status,
    );
  }
  return apiError(
    connectorId,
    'bad-data',
    `respuesta inesperada (HTTP ${status}): ${detail}`,
    status,
  );
}

export interface FetchJsonOptions {
  connectorId: string;
  /** Cabeceras extra (p. ej. `X-Finnhub-Token`, `X-Api-Key`). */
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Clave en uso; solo sirve para redactarla en los mensajes de error. */
  apiKey?: string | null;
  /**
   * Interpreta el cuerpo de una respuesta con HTTP de error para sacar el
   * tipo exacto (p. ej. el `code` de NewsAPI); si devuelve null manda el
   * estado HTTP (`httpError`). Recibe el estado y el `Retry-After` ya
   * calculado para que el error resultante los conserve.
   */
  errorBodyToError?: (
    body: string,
    status: number,
    retryAfterMs?: number,
  ) => NewsConnectorError | null;
}

/**
 * GET con User-Agent propio y tiempo de espera, que devuelve el JSON ya
 * parseado. Errores: transporte/timeout → 'network' (ENOENT → 'not-found',
 * para las respuestas grabadas `file://`), HTTP según `httpError` y cuerpo
 * no-JSON → 'bad-data' con el detalle saneado.
 */
export async function fetchJson(
  fetchImpl: ConnectorFetch,
  url: string,
  options: FetchJsonOptions,
): Promise<unknown> {
  const init: ConnectorFetchInit = {
    method: 'GET',
    headers: { Accept: 'application/json', 'User-Agent': API_USER_AGENT, ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs),
  };
  let response: ConnectorFetchResponse;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (isNewsConnectorError(error)) throw error;
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw apiError(
        options.connectorId,
        'not-found',
        `el archivo con la respuesta grabada no existe`,
        undefined,
        undefined,
        error,
      );
    }
    throw apiError(
      options.connectorId,
      'network',
      `fallo de transporte: ${truncateText(String(error))}`,
      undefined,
      undefined,
      error,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    const mapped = options.errorBodyToError?.(body, response.status, retryAfterMs);
    throw mapped ?? httpError(options.connectorId, response, body, options.apiKey);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw apiError(
      options.connectorId,
      'bad-data',
      `la respuesta no es JSON válido: ${truncateText(redact(body, options.apiKey), 200)}`,
      undefined,
      undefined,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Normalización de ítems
// ---------------------------------------------------------------------------

/** URL canónica del titular: solo http(s); cualquier otra cosa es null. */
export function normalizeItemUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** ISO 8601 → ISO 8601 UTC, o null si la cadena no se entiende. */
export function toUtcIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Fechas compactas de API en UTC: '20261008T093000' (Alpha Vantage) o
 * '20261008120000' (GDELT `seendate`) → ISO 8601. null si no son 14 dígitos.
 */
export function compactUtcToIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 14) return null;
  const iso =
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T` +
    `${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Agencias con cable directo (sección 5.4 del plan y tokens de diseño):
 * Reuters, AP / Associated Press, Bloomberg y Dow Jones. La comparación se
 * hace sobre el nombre normalizado (minúsculas, solo alfanumérico), así
 * valen 'Reuters', 'reuters.com' o 'AP News'.
 */
const AGENCY_MARKERS = ['reuters', 'bloomberg', 'associatedpress', 'apnews', 'dowjones'];

export function isAgencySource(sourceName: string | null | undefined): boolean {
  if (!sourceName) return false;
  const normalized = sourceName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'ap' || normalized === 'theap') return true;
  return AGENCY_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Fiabilidad por defecto de un titular de API: 'prensa'; 'agencia' si la
 * fuente original es una agencia de cable directo. El ítem la lleva en
 * `reliability` para que el ingesta la use en lugar de la de la fuente.
 */
export function inferItemReliability(sourceName: string | null | undefined): Reliability {
  return isAgencySource(sourceName) ? 'agencia' : 'prensa';
}

/** Quita duplicados dentro de la respuesta por externalId → URL → título. */
export function dedupeItems(items: RawNewsItem[]): RawNewsItem[] {
  const seen = new Set<string>();
  const unique: RawNewsItem[] = [];
  for (const item of items) {
    const key = item.externalId ?? item.url ?? item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(0, MAX_API_ITEMS);
}

// ---------------------------------------------------------------------------
// Lectura validada de `params` (los nombres de secreto ya los rechaza el
// gestor de fuentes; aquí se valida la forma de cada parámetro conocido)
// ---------------------------------------------------------------------------

/** Cadena de `params[key]`, o `fallback`; valor de otro tipo → bad-data. */
export function stringParam(
  params: Record<string, unknown>,
  key: string,
  connectorId: string,
  pattern?: RegExp,
): string | null {
  const value = params[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || (pattern !== undefined && !pattern.test(value))) {
    throw apiError(
      connectorId,
      'bad-data',
      `el parámetro '${key}' no es válido para este conector`,
    );
  }
  return value.trim() || null;
}

/** `params[key]` dentro de una lista cerrada, o `fallback` si falta. */
export function enumParam(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  fallback: string,
  connectorId: string,
): string {
  const value = params[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw apiError(
      connectorId,
      'bad-data',
      `el parámetro '${key}' debe ser uno de: ${allowed.join(', ')}`,
    );
  }
  return value;
}

/** Entero de `params[key]` dentro de [min, max], o `fallback` si falta. */
export function intParam(
  params: Record<string, unknown>,
  key: string,
  limits: { min: number; max: number; fallback: number },
  connectorId: string,
): number {
  const value = params[key];
  if (value === undefined || value === null) return limits.fallback;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < limits.min ||
    value > limits.max
  ) {
    throw apiError(
      connectorId,
      'bad-data',
      `el parámetro '${key}' debe ser un entero entre ${limits.min} y ${limits.max}`,
    );
  }
  return value;
}

/** Lista de cadenas de `params[key]`, cada una validada por `pattern`. */
export function stringListParam(
  params: Record<string, unknown>,
  key: string,
  itemPattern: RegExp,
  connectorId: string,
  maxItems = 32,
): string[] {
  const value = params[key];
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    !value.every((v) => typeof v === 'string' && itemPattern.test(v))
  ) {
    throw apiError(
      connectorId,
      'bad-data',
      `el parámetro '${key}' debe ser una lista corta de valores válidos`,
    );
  }
  return value as string[];
}

// ---------------------------------------------------------------------------
// Fábrica común
// ---------------------------------------------------------------------------

export interface ApiConnectorRuntime {
  fetchImpl: ConnectorFetch;
  limiter: RateLimiter;
  now: () => number;
  timeoutMs: number;
  baseUrl: string;
  logger?: { warn(message: string): void };
  getApiKey: ConnectorDeps['getApiKey'];
}

/**
 * Resuelve las dependencias de un conector de API con sus valores por
 * defecto: transporte real, reloj de verdad y la cuota declarada.
 */
export function resolveApiDeps(
  deps: ApiConnectorDeps,
  defaults: { baseUrl: string; timeoutMs?: number },
  limiter: RateLimiter,
): ApiConnectorRuntime {
  return {
    fetchImpl: deps.fetch ?? connectorFetch,
    limiter: deps.rateLimiter ?? limiter,
    now: deps.now ?? (() => Date.now()),
    timeoutMs: deps.timeoutMs ?? defaults.timeoutMs ?? API_TIMEOUT_MS,
    baseUrl: (deps.baseUrl ?? defaults.baseUrl).replace(/\/+$/, ''),
    logger: deps.logger,
    getApiKey: deps.getApiKey,
  };
}
