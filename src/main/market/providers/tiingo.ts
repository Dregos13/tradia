/**
 * Adaptador del proveedor Tiingo (EOD diario de acciones y ETF de EE. UU.).
 *
 * - `fetch` es inyectable: las pruebas sirven respuestas grabadas de
 *   `__fixtures__` sin tocar la red.
 * - La clave se pide al servicio `secrets` vía `getApiKey` inyectado y viaja en
 *   la cabecera `Authorization: Token …`, nunca en la URL ni en los mensajes
 *   de error — cualquier texto externo se sanea antes de llegar al error.
 * - Los errores HTTP se traducen a `MarketDataError`: 401/403 → 'auth',
 *   404 → 'not-found', 429 → 'rate-limit' (con `retryAfterMs` si el servidor
 *   manda `Retry-After`), 5xx y fallos de transporte → 'network', JSON o
 *   filas malformadas → 'bad-data'.
 * - Splits y dividendos viajan en cada fila (`splitFactor`, `divCash`);
 *   `getCorporateActions` los deriva de `getBars`.
 * - Cada petición pasa por el `RateLimiter` (cuota declarada en
 *   `TIINGO_RATE_LIMITS`, sobre el nivel gratuito). Sin reintentos internos:
 *   quien llama decide con el error tipado.
 */
import { createRateLimiter, type RateLimiter } from './rateLimiter';
import {
  ISO_DATE_PATTERN,
  MarketDataError,
  assertValidDateRange,
  assertValidTicker,
  type Bar,
  type CorporateAction,
  type MarketDataProvider,
  type RateLimits,
  type SessionDate,
} from './types';

export const TIINGO_PROVIDER_ID = 'tiingo';
/** Nombre de la clave en el servicio secrets. */
export const TIINGO_SECRETS_KEY = 'tiingo';
export const TIINGO_BASE_URL = 'https://api.tiingo.com';
/** Nivel gratuito: ~50 símbolos/hora y 1000 peticiones/día (margen conservador). */
export const TIINGO_RATE_LIMITS: RateLimits = { perHour: 50, perDay: 1000 };
export const TIINGO_TIMEOUT_MS = 20_000;
/** Ventana que mira `getQuote` hacia atrás para encontrar la última vela. */
const QUOTE_LOOKBACK_DAYS = 31;

export interface TiingoProviderDeps {
  /** fetch inyectable (en producción, la global del proceso principal). */
  fetch: typeof globalThis.fetch;
  /** Lee la clave del servicio secrets: `secrets.getKey('tiingo')`. */
  getApiKey: () => Promise<string | null>;
  baseUrl?: string;
  /** Cuota local; por defecto `createRateLimiter(TIINGO_RATE_LIMITS)`. */
  rateLimiter?: RateLimiter;
  timeoutMs?: number;
  logger?: { warn(message: string): void };
  /** Reloj inyectable para la ventana de `getQuote`; por defecto Date.now. */
  now?: () => number;
}

interface TiingoPriceRow {
  date?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
  adjClose?: unknown;
  divCash?: unknown;
  splitFactor?: unknown;
}

/** Quita la clave de cualquier texto externo antes de meterla en un error. */
function redact(text: string, apiKey: string | null): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

const truncate = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

function toSessionDate(value: unknown, provider: string, ticker: string): SessionDate {
  if (typeof value !== 'string') {
    throw new MarketDataError('bad-data', `fila de Tiingo sin 'date' válido para '${ticker}'`, {
      provider,
      ticker,
    });
  }
  const date = value.slice(0, 10);
  if (!ISO_DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new MarketDataError(
      'bad-data',
      `fila de Tiingo con fecha malformada para '${ticker}': ${JSON.stringify(value)}`,
      { provider, ticker },
    );
  }
  return date;
}

function toFiniteNumber(
  value: unknown,
  field: string,
  provider: string,
  ticker: string,
  fallback?: number,
): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new MarketDataError(
      'bad-data',
      `fila de Tiingo sin '${field}' para '${ticker}': ${JSON.stringify(value)}`,
      { provider, ticker },
    );
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new MarketDataError(
      'bad-data',
      `fila de Tiingo con '${field}' no numérico para '${ticker}': ${JSON.stringify(value)}`,
      { provider, ticker },
    );
  }
  return n;
}

function parsePriceRow(raw: unknown, ticker: string): Bar {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new MarketDataError('bad-data', `fila de Tiingo no es un objeto para '${ticker}'`, {
      provider: TIINGO_PROVIDER_ID,
      ticker,
    });
  }
  const row = raw as TiingoPriceRow;
  return {
    date: toSessionDate(row.date, TIINGO_PROVIDER_ID, ticker),
    open: toFiniteNumber(row.open, 'open', TIINGO_PROVIDER_ID, ticker),
    high: toFiniteNumber(row.high, 'high', TIINGO_PROVIDER_ID, ticker),
    low: toFiniteNumber(row.low, 'low', TIINGO_PROVIDER_ID, ticker),
    close: toFiniteNumber(row.close, 'close', TIINGO_PROVIDER_ID, ticker),
    // Algunos activos devuelven volume null (índices): se normaliza a 0.
    volume: toFiniteNumber(row.volume, 'volume', TIINGO_PROVIDER_ID, ticker, 0),
    adjClose: toFiniteNumber(row.adjClose, 'adjClose', TIINGO_PROVIDER_ID, ticker),
    dividend: toFiniteNumber(row.divCash, 'divCash', TIINGO_PROVIDER_ID, ticker, 0),
    splitFactor: toFiniteNumber(row.splitFactor, 'splitFactor', TIINGO_PROVIDER_ID, ticker, 1),
  };
}

export function createTiingoProvider(deps: TiingoProviderDeps): MarketDataProvider {
  const baseUrl = (deps.baseUrl ?? TIINGO_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = deps.timeoutMs ?? TIINGO_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const limiter =
    deps.rateLimiter ??
    createRateLimiter({ limits: TIINGO_RATE_LIMITS, providerId: TIINGO_PROVIDER_ID });

  const fail = (
    kind: ConstructorParameters<typeof MarketDataError>[0],
    message: string,
    ticker: string | undefined,
    status?: number,
    retryAfterMs?: number,
  ): MarketDataError =>
    new MarketDataError(kind, `[tiingo] ${message}`, {
      provider: TIINGO_PROVIDER_ID,
      ticker,
      status,
      retryAfterMs,
    });

  const request = async (path: string, ticker?: string): Promise<unknown> => {
    const apiKey = await deps.getApiKey();
    if (!apiKey) {
      throw fail('auth', `sin clave de API guardada (secrets['${TIINGO_SECRETS_KEY}'])`, ticker);
    }

    await limiter.acquire();

    const url = `${baseUrl}${path}`;
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw fail('network', `fallo de transporte: ${String(error)}`, ticker, undefined, undefined);
    }

    if (!response.ok) {
      let body: string;
      try {
        body = truncate(await response.text());
      } catch {
        body = '';
      }
      const detail = redact(body, apiKey);
      const status = response.status;
      deps.logger?.warn(`[tiingo] HTTP ${status} en ${path}`);
      if (status === 401 || status === 403) {
        throw fail('auth', `credencial rechazada (HTTP ${status})`, ticker, status);
      }
      if (status === 404) {
        throw fail('not-found', `recurso no encontrado (HTTP 404): ${detail}`, ticker, status);
      }
      if (status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const retryAfterMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
        throw fail(
          'rate-limit',
          `cuota excedida (HTTP 429): ${detail}`,
          ticker,
          status,
          retryAfterMs,
        );
      }
      if (status >= 500) {
        throw fail('network', `error del servidor (HTTP ${status}): ${detail}`, ticker, status);
      }
      throw fail('bad-data', `respuesta inesperada (HTTP ${status}): ${detail}`, ticker, status);
    }

    try {
      return await response.json();
    } catch {
      throw fail('bad-data', 'la respuesta no es JSON válido', ticker, response.status);
    }
  };

  const getBars: MarketDataProvider['getBars'] = async (ticker, desde, hasta) => {
    assertValidTicker(ticker, TIINGO_PROVIDER_ID);
    assertValidDateRange(desde, hasta, TIINGO_PROVIDER_ID);
    const path = `/tiingo/daily/${encodeURIComponent(ticker)}/prices?startDate=${desde}&endDate=${hasta}&resampleFreq=daily`;
    const payload = await request(path, ticker);

    if (!Array.isArray(payload)) {
      // Tiingo a veces responde 200 con {"detail":"…"} en vez de lista.
      const detail =
        typeof payload === 'object' && payload !== null && 'detail' in payload
          ? redact(String((payload as { detail: unknown }).detail), null)
          : '';
      throw fail('bad-data', `respuesta sin lista de precios: ${truncate(detail)}`, ticker);
    }

    return payload
      .map((row) => parsePriceRow(row, ticker))
      .filter((bar) => bar.date >= desde && bar.date <= hasta)
      .sort((a, b) => a.date.localeCompare(b.date));
  };

  const provider: MarketDataProvider = {
    id: TIINGO_PROVIDER_ID,
    rateLimits: TIINGO_RATE_LIMITS,

    getBars,

    getQuote: async (ticker) => {
      assertValidTicker(ticker, TIINGO_PROVIDER_ID);
      const hasta = new Date(now()).toISOString().slice(0, 10);
      const desde = new Date(now() - QUOTE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
      const bars = await getBars(ticker, desde, hasta);
      const bar = bars[bars.length - 1];
      if (!bar) {
        throw fail('not-found', `sin cotización reciente para '${ticker}'`, ticker);
      }
      return { ticker, date: bar.date, last: bar.close, volume: bar.volume };
    },

    getCorporateActions: async (ticker, desde, hasta) => {
      const bars = await getBars(ticker, desde, hasta);
      const actions: CorporateAction[] = [];
      for (const bar of bars) {
        if (bar.splitFactor !== 1) {
          actions.push({ ticker, date: bar.date, kind: 'split', value: bar.splitFactor });
        }
        if (bar.dividend > 0) {
          actions.push({ ticker, date: bar.date, kind: 'dividend', value: bar.dividend });
        }
      }
      return actions;
    },
  };

  return provider;
}
