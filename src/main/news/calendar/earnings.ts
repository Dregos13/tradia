/**
 * Resultados empresariales de los activos seguidos — Fase 1b.
 *
 * Dos proveedores detrás de la misma interfaz:
 *
 * - `createFinnhubEarnings`: calendario de resultados de Finnhub
 *   (`/api/v1/calendar/earnings?from&to`), que devuelve todas las
 *   presentaciones del rango en una sola petición; el filtrado por los
 *   tickers de la lista de seguimiento se hace en local. La clave se pide
 *   al servicio secrets por `FINNHUB_SECRETS_KEY` en cada pasada, igual
 *   que hacen los conectores de noticias.
 * - `createSimulatedEarnings`: fechas deterministas por ticker y
 *   trimestre, solo para el modo de pruebas (TRADIA_E2E); el servicio
 *   decide cuándo usarlo.
 *
 * Errores: los de transporte y credencial llegan como `NewsConnectorError`
 * tipado (mismo contrato que los conectores); quien llama decide.
 */
import { NewsConnectorError, type ConnectorFetch } from '../connectors';
import type { EarningsEntry, EarningsSession } from './generate';

export const FINNHUB_SECRETS_KEY = 'finnhub';
const FINNHUB_ENDPOINT = 'https://finnhub.io/api/v1/calendar/earnings';
export const FINNHUB_TIMEOUT_MS = 10_000;

/** Proveedor de fechas de resultados para los activos seguidos. */
export interface EarningsProvider {
  /** 'finnhub' (real) o 'simulado' (modo de pruebas); va a `origen`. */
  readonly id: 'finnhub' | 'simulado';
  /**
   * Presentaciones de `tickers` entre `desde` y `hasta` ('YYYY-MM-DD').
   * Rechaza con `NewsConnectorError` (Finnhub); el simulado no rechaza.
   */
  fetch(tickers: readonly string[], desde: string, hasta: string): Promise<EarningsEntry[]>;
}

// ---------------------------------------------------------------------------
// Finnhub
// ---------------------------------------------------------------------------

export interface FinnhubEarningsDeps {
  fetch: ConnectorFetch;
  /** Lee la clave del servicio secrets (proveedor 'finnhub'). */
  getApiKey: () => Promise<string | null>;
  timeoutMs?: number;
}

/** Respuesta de /calendar/earnings tal como la documenta Finnhub. */
interface FinnhubEarningsResponse {
  earningsCalendar?: Array<{
    date?: string;
    epsEstimate?: number | null;
    hour?: string;
    symbol?: string;
  }>;
}

const isDateString = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

function normalizeSession(hour: string | undefined): EarningsSession {
  if (hour === 'bmo') return 'bmo';
  if (hour === 'amc') return 'amc';
  return 'other';
}

/**
 * Parseo tolerante: solo se descartan entradas sin fecha o sin símbolo;
 * un cuerpo que no es JSON u objeto se traduce a 'bad-data'.
 */
function parseFinnhubResponse(body: string, watched: ReadonlySet<string>): EarningsEntry[] {
  let parsed: FinnhubEarningsResponse;
  try {
    parsed = JSON.parse(body) as FinnhubEarningsResponse;
  } catch {
    throw new NewsConnectorError('bad-data', 'respuesta de Finnhub no es JSON', {
      connector: 'finnhub',
    });
  }
  const entries: EarningsEntry[] = [];
  for (const raw of parsed?.earningsCalendar ?? []) {
    if (!isDateString(raw?.date) || typeof raw?.symbol !== 'string') continue;
    const symbol = raw.symbol.trim().toUpperCase();
    if (!watched.has(symbol)) continue;
    entries.push({
      symbol,
      date: raw.date,
      session: normalizeSession(raw.hour),
      epsEstimate: typeof raw.epsEstimate === 'number' ? raw.epsEstimate : null,
    });
  }
  return entries;
}

export function createFinnhubEarnings(deps: FinnhubEarningsDeps): EarningsProvider {
  const timeoutMs = deps.timeoutMs ?? FINNHUB_TIMEOUT_MS;
  return {
    id: 'finnhub',
    fetch: async (tickers, desde, hasta) => {
      const watched = new Set(tickers.map((t) => t.trim().toUpperCase()));
      if (watched.size === 0) return [];
      const apiKey = await deps.getApiKey();
      if (!apiKey) {
        throw new NewsConnectorError('auth', 'sin clave de Finnhub guardada en secrets', {
          connector: 'finnhub',
        });
      }
      const url = `${FINNHUB_ENDPOINT}?from=${desde}&to=${hasta}&token=${encodeURIComponent(apiKey)}`;
      let response;
      try {
        response = await deps.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error: unknown) {
        throw new NewsConnectorError(
          'network',
          `no se pudo contactar con Finnhub: ${error instanceof Error ? error.message : String(error)}`,
          { connector: 'finnhub', cause: error },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new NewsConnectorError('auth', 'Finnhub rechazó la clave de API', {
          connector: 'finnhub',
          status: response.status,
        });
      }
      if (response.status === 429) {
        throw new NewsConnectorError('rate-limit', 'Finnhub devolvió 429 (cuota agotada)', {
          connector: 'finnhub',
          status: 429,
        });
      }
      if (!response.ok) {
        throw new NewsConnectorError(
          'network',
          `Finnhub respondió ${response.status} al calendario de resultados`,
          { connector: 'finnhub', status: response.status },
        );
      }
      return parseFinnhubResponse(await response.text(), watched);
    },
  };
}

// ---------------------------------------------------------------------------
// Simulado (solo TRADIA_E2E)
// ---------------------------------------------------------------------------

/** Meses de temporada de resultados: enero, abril, julio y octubre. */
const EARNINGS_MONTHS = [1, 4, 7, 10] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Hash estable del ticker para fechas deterministas por semilla. */
function tickerSeed(ticker: string): number {
  let hash = 0;
  for (const char of ticker) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/**
 * Resultados simulados deterministas: una presentación por ticker y
 * trimestre en los meses de temporada del rango. El día (laborable, entre
 * el 10 y el 24), la sesión y el BPA salen del ticker para que el E2E sea
 * estable entre ejecuciones.
 */
export function createSimulatedEarnings(): EarningsProvider {
  return {
    id: 'simulado',
    fetch: (tickers, desde, hasta) => {
      const entries: EarningsEntry[] = [];
      const startYear = Number(desde.slice(0, 4));
      const endYear = Number(hasta.slice(0, 4));
      for (const raw of tickers) {
        const symbol = raw.trim().toUpperCase();
        if (symbol.length === 0) continue;
        const seed = tickerSeed(symbol);
        for (let year = startYear; year <= endYear; year += 1) {
          for (const month of EARNINGS_MONTHS) {
            // Día laborable determinista entre el 10 y el 24 del mes.
            let day = 10 + (seed % 15);
            let date = `${year}-${pad2(month)}-${pad2(day)}`;
            while (new Date(`${date}T00:00:00.000Z`).getUTCDay() % 6 === 0) {
              day -= 1;
              date = `${year}-${pad2(month)}-${pad2(day)}`;
            }
            if (date < desde || date > hasta) continue;
            entries.push({
              symbol,
              date,
              session: seed % 2 === 0 ? 'amc' : 'bmo',
              epsEstimate: Math.round((0.5 + (seed % 40) / 10) * 100) / 100,
            });
          }
        }
      }
      return Promise.resolve(entries);
    },
  };
}
