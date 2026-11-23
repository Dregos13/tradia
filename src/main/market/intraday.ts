/**
 * Velas de 1 hora bajo demanda para el Mercado.
 *
 * Guarda en `intraday_bars` lo descargado y en cada consulta pide solo lo
 * que falta: desde la última vela guardada hasta ahora y, si el histórico
 * pedido es más largo que lo guardado, hacia atrás por tramos. El número
 * de peticiones por consulta está acotado para cuidar el cupo del
 * proveedor (Tiingo gratuito: unas 50 por hora).
 */
import type Database from 'better-sqlite3';

import {
  INTRADAY_DEFAULT_DAYS,
  type IntradayBar,
  type IntradayRequest,
  type IntradayResult,
} from '../../shared/intraday';
import { isMarketDataError, type MarketDataProvider } from './providers/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Tramo por petición hacia atrás: Tiingo puede recortar rangos largos. */
const CHUNK_DAYS = 30;
/** Peticiones máximas por consulta (primera descarga de 2 años incluida). */
const MAX_REQUESTS = 8;
/** No se vuelve a preguntar al proveedor antes de este intervalo. */
const FRESH_MS = 15 * 60_000;

export interface IntradayServiceDeps {
  db: Database.Database;
  resolveProvider: () => Promise<MarketDataProvider | null>;
  now?: () => number;
}

export interface IntradayService {
  get(request: IntradayRequest): Promise<IntradayResult>;
}

/** Mensaje en lenguaje llano para un fallo del proveedor. */
function plainError(error: unknown): string {
  if (isMarketDataError(error)) {
    switch (error.kind) {
      case 'rate-limit':
        return 'Has agotado el cupo de peticiones de tu proveedor de datos por ahora. Se mostrarán las velas guardadas; vuelve a intentarlo en un rato.';
      case 'auth':
        return 'La clave del proveedor de datos no es válida o no tiene acceso a velas de 1 hora.';
      case 'not-found':
        return 'El proveedor no tiene velas de 1 hora para este activo.';
      case 'network':
        return 'Sin conexión con el proveedor de datos.';
      default:
        return 'El proveedor de datos no devolvió velas de 1 hora válidas.';
    }
  }
  return 'No se pudieron descargar las velas de 1 hora.';
}

export function createIntradayService(deps: IntradayServiceDeps): IntradayService {
  const now = deps.now ?? (() => Date.now());
  const lastAsked = new Map<string, number>();
  const inflight = new Map<string, Promise<IntradayResult>>();

  const insert = deps.db.prepare(
    `INSERT OR REPLACE INTO intraday_bars (ticker, provider, ts, open, high, low, close)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const store = deps.db.transaction((ticker: string, provider: string, bars: IntradayBar[]) => {
    for (const b of bars) insert.run(ticker, provider, b.time, b.open, b.high, b.low, b.close);
  });
  const read = (ticker: string, provider: string, fromIso: string): IntradayBar[] =>
    deps.db
      .prepare(
        `SELECT ts AS time, open, high, low, close FROM intraday_bars
         WHERE ticker = ? AND provider = ? AND ts >= ? ORDER BY ts`,
      )
      .all(ticker, provider, fromIso) as IntradayBar[];
  const bounds = (ticker: string, provider: string) =>
    deps.db
      .prepare(
        `SELECT MIN(ts) AS first, MAX(ts) AS last FROM intraday_bars
         WHERE ticker = ? AND provider = ?`,
      )
      .get(ticker, provider) as { first: string | null; last: string | null };

  const refresh = async (request: IntradayRequest): Promise<IntradayResult> => {
    const ticker = request.ticker;
    const days = request.days ?? INTRADAY_DEFAULT_DAYS;
    const end = now();
    const from = end - days * DAY;
    const fromIso = new Date(from).toISOString();
    const provider = await deps.resolveProvider();
    if (!provider) {
      return {
        ticker,
        source: null,
        bars: [],
        error: 'Añade tu clave de Tiingo en Ajustes para ver velas de 1 hora.',
      };
    }
    if (!provider.getIntradayBars) {
      return {
        ticker,
        source: provider.id,
        bars: [],
        error: 'Tu proveedor no ofrece velas de 1 hora.',
      };
    }
    const key = `${provider.id}:${ticker}`;
    let error: string | null = null;
    const stale = now() - (lastAsked.get(key) ?? 0) > FRESH_MS;
    if (stale) {
      try {
        let requests = 0;
        const { first, last } = bounds(ticker, provider.id);
        // 1) Hacia delante: desde la última vela guardada (o el inicio pedido).
        const forwardFrom = last ? Date.parse(last) - HOUR : from;
        const fresh = await provider.getIntradayBars(ticker, forwardFrom, end);
        requests++;
        store(ticker, provider.id, fresh);
        // 2) Hacia atrás: si lo guardado empieza después de lo pedido.
        let earliest = Math.min(
          first ? Date.parse(first) : Infinity,
          fresh[0] ? Date.parse(fresh[0].time) : Infinity,
        );
        while (earliest - from > 3 * DAY && requests < MAX_REQUESTS) {
          const chunkFrom = Math.max(from, earliest - CHUNK_DAYS * DAY);
          const older = await provider.getIntradayBars(ticker, chunkFrom, earliest - HOUR);
          requests++;
          store(ticker, provider.id, older);
          if (older.length === 0) {
            // Sin datos más antiguos en ese tramo: se salta para no insistir.
            earliest = chunkFrom;
            continue;
          }
          earliest = Date.parse(older[0]!.time);
        }
        lastAsked.set(key, now());
      } catch (cause) {
        error = plainError(cause);
      }
    }
    return { ticker, source: provider.id, bars: read(ticker, provider.id, fromIso), error };
  };

  return {
    get: (request) => {
      const key = `${request.ticker}:${request.days ?? INTRADAY_DEFAULT_DAYS}`;
      const running = inflight.get(key);
      if (running) return running;
      const job = refresh(request).finally(() => inflight.delete(key));
      inflight.set(key, job);
      return job;
    },
  };
}
