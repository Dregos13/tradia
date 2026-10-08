/**
 * Adaptador del proveedor FRED (Reserva Federal de St. Louis) para las
 * series macro de la fase: DFF, CPIAUCSL, DGS2, DGS10, T10Y2Y y VIXCLS
 * (el VIX se toma de FRED, sin un segundo proveedor).
 *
 * - `fetch` es inyectable: las pruebas sirven respuestas grabadas de
 *   `__fixtures__` sin tocar la red.
 * - La clave se pide al servicio secrets vía `getApiKey` inyectado. FRED
 *   solo la admite como parámetro `api_key` en la URL: nunca se registra la
 *   URL ni se copia la clave a mensajes de error (el texto externo se sanea
 *   con `redact` antes).
 * - Los errores HTTP se traducen a `MarketDataError`: 401/403 y un 400 de
 *   clave → 'auth', 404 y un 400 de serie inexistente → 'not-found',
 *   429 → 'rate-limit' (con `retryAfterMs` si el servidor manda
 *   `Retry-After`), 5xx y fallos de transporte → 'network', JSON o filas
 *   malformadas → 'bad-data'.
 * - FRED marca los días sin dato con el valor '.': se tratan como ausentes
 *   y no se devuelven (no se guardan en `macro_observations`).
 * - Cada petición pasa por el `RateLimiter` (cuota declarada en
 *   `FRED_RATE_LIMITS`). Sin reintentos internos: quien llama decide con el
 *   error tipado.
 */
import { createRateLimiter, type RateLimiter } from '../providers/rateLimiter';
import {
  MarketDataError,
  type MarketDataErrorKind,
  type RateLimits,
  type SessionDate,
} from '../providers/types';
import {
  MACRO_SERIES_CATALOG,
  type MacroDataProvider,
  type MacroObservation,
  type MacroSeriesMeta,
} from './types';

export const FRED_PROVIDER_ID = 'fred';
/** Nombre de la clave en el servicio secrets. */
export const FRED_SECRETS_KEY = 'fred';
export const FRED_BASE_URL = 'https://api.stlouisfed.org/fred';
/**
 * Cuota local conservadora: FRED no publica un límite oficial, pero limita
 * por IP y clave; seis peticiones diarias quedan muy por debajo.
 */
export const FRED_RATE_LIMITS: RateLimits = { perHour: 60, perDay: 500 };
export const FRED_TIMEOUT_MS = 20_000;

/** Marcador de dato ausente en las respuestas de FRED. */
export const FRED_MISSING_VALUE = '.';

/** Ids de serie de FRED: letras, dígitos y guion bajo (p. ej. 'CPIAUCSL'). */
const SERIES_ID_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface FredProviderDeps {
  /** fetch inyectable (en producción, la global del proceso principal). */
  fetch: typeof globalThis.fetch;
  /** Lee la clave del servicio secrets: `secrets.getKey('fred')`. */
  getApiKey: () => Promise<string | null>;
  baseUrl?: string;
  /** Cuota local; por defecto `createRateLimiter(FRED_RATE_LIMITS)`. */
  rateLimiter?: RateLimiter;
  timeoutMs?: number;
  /** Recibe solo el id de serie y el status, nunca la URL (lleva la clave). */
  logger?: { warn(message: string): void };
  /** Catálogo servido; por defecto las 6 series de la fase. */
  series?: readonly MacroSeriesMeta[];
}

interface FredObservationRow {
  date?: unknown;
  value?: unknown;
}

/** Quita la clave de cualquier texto externo antes de meterla en un error. */
function redact(text: string, apiKey: string | null): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

const truncate = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

function toSessionDate(value: unknown, seriesId: string): SessionDate {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    throw new MarketDataError(
      'bad-data',
      `fila de FRED sin 'date' válido para '${seriesId}': ${JSON.stringify(value)}`,
      { provider: FRED_PROVIDER_ID },
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new MarketDataError(
      'bad-data',
      `fila de FRED con fecha imposible para '${seriesId}': ${JSON.stringify(value)}`,
      { provider: FRED_PROVIDER_ID },
    );
  }
  return value;
}

/**
 * Fila de FRED → observación, o null si el valor es ausente ('.', '', null).
 * Un valor presente pero no numérico rompe el lote con 'bad-data'.
 */
function parseObservationRow(raw: unknown, seriesId: string): MacroObservation | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MarketDataError('bad-data', `fila de FRED no es un objeto para '${seriesId}'`, {
      provider: FRED_PROVIDER_ID,
    });
  }
  const row = raw as FredObservationRow;
  const date = toSessionDate(row.date, seriesId);
  if (row.value === FRED_MISSING_VALUE || row.value === '' || row.value === null) return null;
  const value = typeof row.value === 'number' ? row.value : Number(row.value);
  if (!Number.isFinite(value)) {
    throw new MarketDataError(
      'bad-data',
      `fila de FRED con 'value' no numérico para '${seriesId}': ${JSON.stringify(row.value)}`,
      { provider: FRED_PROVIDER_ID },
    );
  }
  return { date, value };
}

/** Clasifica un 400 de FRED: clave, serie inexistente o petición inválida. */
function classifyBadRequest(detail: string): MarketDataErrorKind {
  const lower = detail.toLowerCase();
  if (lower.includes('api_key') || lower.includes('api key')) return 'auth';
  if (lower.includes('series') && /does not exist|not.*valid|bad request/.test(lower)) {
    return 'not-found';
  }
  return 'bad-data';
}

export function createFredProvider(deps: FredProviderDeps): MacroDataProvider {
  const baseUrl = (deps.baseUrl ?? FRED_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = deps.timeoutMs ?? FRED_TIMEOUT_MS;
  const series = deps.series ?? MACRO_SERIES_CATALOG;
  const limiter =
    deps.rateLimiter ??
    createRateLimiter({ limits: FRED_RATE_LIMITS, providerId: FRED_PROVIDER_ID });

  const fail = (
    kind: MarketDataErrorKind,
    message: string,
    status?: number,
    retryAfterMs?: number,
  ): MarketDataError =>
    new MarketDataError(kind, `[fred] ${message}`, {
      provider: FRED_PROVIDER_ID,
      status,
      retryAfterMs,
    });

  const request = async (seriesId: string, params: Record<string, string>): Promise<unknown> => {
    const apiKey = await deps.getApiKey();
    if (!apiKey) {
      throw fail('auth', `sin clave de API guardada (secrets['${FRED_SECRETS_KEY}'])`);
    }

    await limiter.acquire();

    const search = new URLSearchParams({
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      ...params,
    });
    let response: Response;
    try {
      response = await deps.fetch(`${baseUrl}/series/observations?${search.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw fail('network', `fallo de transporte: ${redact(String(error), apiKey)}`);
    }

    if (!response.ok) {
      let detail: string;
      try {
        const body = await response.text();
        // FRED responde {"error_code":…,"error_message":"…"} en los errores.
        try {
          const parsed: unknown = JSON.parse(body);
          if (typeof parsed === 'object' && parsed !== null && 'error_message' in parsed) {
            detail = String((parsed as { error_message: unknown }).error_message);
          } else {
            detail = body;
          }
        } catch {
          detail = body;
        }
      } catch {
        detail = '';
      }
      detail = truncate(redact(detail, apiKey));
      const status = response.status;
      // Nunca la URL: contiene la clave en el parámetro api_key.
      deps.logger?.warn(`[fred] HTTP ${status} en la serie '${seriesId}'`);
      if (status === 401 || status === 403) {
        throw fail('auth', `credencial rechazada (HTTP ${status})`, status);
      }
      if (status === 400) {
        throw fail(classifyBadRequest(detail), `petición rechazada (HTTP 400): ${detail}`, status);
      }
      if (status === 404) {
        throw fail('not-found', `recurso no encontrado (HTTP 404): ${detail}`, status);
      }
      if (status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const retryAfterMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
        throw fail('rate-limit', `cuota excedida (HTTP 429): ${detail}`, status, retryAfterMs);
      }
      if (status >= 500) {
        throw fail('network', `error del servidor (HTTP ${status}): ${detail}`, status);
      }
      throw fail('bad-data', `respuesta inesperada (HTTP ${status}): ${detail}`, status);
    }

    try {
      return await response.json();
    } catch {
      throw fail('bad-data', 'la respuesta no es JSON válido', response.status);
    }
  };

  const provider: MacroDataProvider = {
    id: FRED_PROVIDER_ID,
    rateLimits: FRED_RATE_LIMITS,

    listSeries: () => series,

    getObservations: async (seriesId, desde, hasta) => {
      if (!SERIES_ID_PATTERN.test(seriesId) || !series.some((s) => s.id === seriesId)) {
        throw fail(
          'not-found',
          `serie desconocida para '${FRED_PROVIDER_ID}': ${JSON.stringify(seriesId)}`,
        );
      }
      const params: Record<string, string> = {};
      if (desde !== undefined) params.observation_start = desde;
      if (hasta !== undefined) params.observation_end = hasta;
      const payload = await request(seriesId, params);

      if (
        typeof payload !== 'object' ||
        payload === null ||
        !Array.isArray((payload as { observations?: unknown }).observations)
      ) {
        throw fail('bad-data', 'respuesta de FRED sin lista de observaciones');
      }

      return (payload as { observations: unknown[] }).observations
        .map((row) => parseObservationRow(row, seriesId))
        .filter((obs): obs is MacroObservation => obs !== null)
        .filter(
          (obs) =>
            (desde === undefined || obs.date >= desde) &&
            (hasta === undefined || obs.date <= hasta),
        )
        .sort((a, b) => a.date.localeCompare(b.date));
    },
  };

  return provider;
}
