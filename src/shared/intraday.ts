/**
 * Velas intradía (1 hora) — contrato compartido.
 *
 * Las velas diarias viven en `bars` con su limpieza y lotes; las de 1 hora
 * son una vista de estudio para el Mercado: se descargan bajo demanda, se
 * guardan en local (`intraday_bars`) y solo se pide lo que falta.
 */
import { isFxPair } from './fx';

/** Vela de 1 hora; `time` es el inicio de la hora en ISO 8601 UTC. */
export interface IntradayBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface IntradayRequest {
  ticker: string;
  /** Días de histórico hacia atrás desde ahora (def. 60, máx. 730). */
  days?: number;
}

export interface IntradayResult {
  ticker: string;
  /** Proveedor de las velas; null si no hay ninguno configurado. */
  source: string | null;
  bars: IntradayBar[];
  /** Motivo legible si no se pudo actualizar (las velas guardadas se devuelven igual). */
  error: string | null;
}

export const INTRADAY_DEFAULT_DAYS = 60;
export const INTRADAY_MAX_DAYS = 730;

export function isIntradayRequest(v: unknown): v is IntradayRequest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'ticker' && k !== 'days')) return false;
  if (typeof o.ticker !== 'string' || !/^[A-Z0-9.]{1,12}$/.test(o.ticker)) return false;
  if (o.days !== undefined) {
    if (typeof o.days !== 'number' || !Number.isInteger(o.days)) return false;
    if (o.days < 1 || o.days > INTRADAY_MAX_DAYS) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Serie simulada determinista (pruebas y vista previa sin clave)
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ANCHORS: Record<string, number> = {
  EURUSD: 1.08,
  GBPUSD: 1.27,
  USDJPY: 150,
  USDCHF: 0.88,
  GLD: 240,
  XAUUSD: 2600,
};

/** ¿Cotiza esa hora? Divisas 24/5 (dom 22:00 – vie 22:00 UTC); el resto, horario de NY aprox. */
function tradesAt(ms: number, fx: boolean): boolean {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (fx) {
    if (day === 6) return false;
    if (day === 0) return hour >= 22;
    if (day === 5) return hour < 22;
    return true;
  }
  return day >= 1 && day <= 5 && hour >= 14 && hour < 21;
}

/**
 * Velas de 1 hora deterministas entre `fromMs` y `toMs`: un paseo con
 * semilla por (seed, ticker) que arranca en un ancla realista. La misma
 * hora produce siempre la misma vela, pida lo que se pida.
 */
export function simulatedIntradayBars(
  ticker: string,
  fromMs: number,
  toMs: number,
  seed = 'tradia',
  fx = isFxPair(ticker) || ticker === 'XAUUSD',
): IntradayBar[] {
  // Origen fijo para que cada hora tenga siempre el mismo precio.
  const genesis = Date.UTC(2023, 0, 1);
  const rng = mulberry32(hashSeed(`${seed}:1h:${ticker}`));
  const anchor = ANCHORS[ticker] ?? 100;
  const decimals = anchor < 10 ? 5 : anchor < 1000 ? 3 : 2;
  const round = (v: number) => Number(v.toFixed(decimals));
  let close = anchor;
  const out: IntradayBar[] = [];
  const start = Math.floor(fromMs / HOUR) * HOUR;
  for (let t = genesis; t <= toMs; t += HOUR) {
    if (!tradesAt(t, fx)) continue;
    const prev = close;
    const drift = (anchor - prev) * 0.002;
    const shock = ((rng() + rng() + rng()) / 1.5 - 1) * anchor * (fx ? 0.0012 : 0.004);
    close = round(Math.max(anchor * 0.5, prev + drift + shock));
    if (t < start) continue;
    const high = round(Math.max(prev, close) + rng() * anchor * 0.0008);
    const low = round(Math.min(prev, close) - rng() * anchor * 0.0008);
    out.push({ time: new Date(t).toISOString(), open: round(prev), high, low, close });
  }
  return out;
}
