/**
 * Proveedor simulado determinista, para pruebas y desarrollo (TRADIA_E2E).
 *
 * - La serie de precios es un paseo aleatorio con semilla anclado a una fecha
 *   génesis fija: el mismo (seed, ticker) produce siempre la misma serie, sin
 *   importar el rango consultado ni el orden de las llamadas.
 * - Las acciones solo generan sesiones del calendario NYSE y excluyen sus
 *   festivos; los pares admitidos (`isFxPair`, p. ej. 'EURUSD') generan
 *   velas del calendario de divisas 24/5: cada día UTC de lunes a viernes,
 *   festivos de NYSE incluidos (salvo los huecos tolerados 25-12 y 01-01),
 *   sin volumen ni acciones corporativas. El precio del par no es un paseo
 *   libre: revierte a un anclaje realista (`FX_PRICE_ANCHORS`) con
 *   variación diaria ≈0,5 %, así EUR/USD cotiza siempre en torno a 1,1.
 * - Una sesión solo existe si su cierre ya pasó según el reloj inyectado
 *   (`now`), con su horario real y sus cierres anticipados.
 * - `adjClose` se calcula hacia atrás como en un proveedor real: continuo a
 *   través de los splits y reducido antes de cada dividendo. Los precios
 *   crudos saltan con el split, como en la realidad.
 * - Permite inyectar por ticker acciones corporativas (split, dividendo) y
 *   defectos de datos (hueco, duplicado, valor anómalo), más fallos
 *   programados del proveedor, para probar limpieza, ingesta y salud del dato.
 */
import { inferAssetClass, isFxPair } from '../../../shared/fx';
import {
  fxLastExpectedSession,
  isFxSessionDay,
  isTradingDay,
  lastExpectedSession,
} from '../calendar';
import {
  MarketDataError,
  assertValidDateRange,
  assertValidTicker,
  type Bar,
  type CorporateAction,
  type MarketDataErrorKind,
  type MarketDataProvider,
  type RateLimits,
  type SessionDate,
} from './types';

export const SIMULATED_PROVIDER_ID = 'simulated';

/** Sin límite práctico: la cuota local nunca bloquea al simulado. */
export const SIMULATED_RATE_LIMITS: RateLimits = { perHour: 60_000, perDay: 1_000_000 };

const DEFAULT_GENESIS: SessionDate = '2000-01-03'; // lunes

/**
 * Nivel típico de cada par admitido: la cotización realista de mercado
 * (~1,10 USD por EUR, ~150 JPY por USD). Los pares no hacen un paseo
 * libre como las acciones —con la deriva acabarían en 12 u 80— sino que
 * oscilan en torno a su anclaje.
 */
const FX_PRICE_ANCHORS: Readonly<Record<string, number>> = {
  EURUSD: 1.1,
  GBPUSD: 1.27,
  USDCHF: 0.9,
  USDJPY: 150,
};

/** Variación diaria típica de un par de divisas (≈0,5 % por sesión). */
const FX_DAILY_VOL = 0.005;

/**
 * Reversión al anclaje por sesión. Con FX_DAILY_VOL=0,005 la cota del
 * paseo queda en ±vol/(1−φ) = ±12,5 %, así que EUR/USD simulado no sale
 * de 0,96–1,24 en ninguna fecha ni semilla.
 */
const FX_MEAN_REVERSION = 0.96;

/** Anclaje del par; un par futuro no listado parte de ~1,1. */
const fxAnchorFor = (ticker: string): number => FX_PRICE_ANCHORS[ticker] ?? 1.1;

export interface SimulatedInjections {
  /** { date, factor }: split de `factor`:1 con fecha ex `date`. */
  splits?: Array<{ date: SessionDate; factor: number }>;
  /** { date, amount }: dividendo de `amount` por acción con fecha ex `date`. */
  dividends?: Array<{ date: SessionDate; amount: number }>;
  /** Fechas de sesión que el proveedor omite (hueco de datos). */
  gaps?: SessionDate[];
  /** Fechas que el proveedor emite dos veces (duplicado). */
  duplicates?: SessionDate[];
  /** { date, patch }: sobrescribe campos de la vela de `date` (valor anómalo). */
  anomalies?: Array<{ date: SessionDate; patch: Partial<Omit<Bar, 'date'>> }>;
}

export interface SimulatedProviderOptions {
  /** Semilla del paseo aleatorio (número o texto). */
  seed?: number | string;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Primera fecha de la serie generada ('YYYY-MM-DD', un lunes). */
  genesis?: SessionDate;
  /** Volatilidad diaria máxima del paseo de las acciones (por defecto 0.02). */
  dailyVol?: number;
  /** Deriva diaria del paseo de las acciones (por defecto 0.0002). */
  drift?: number;
  /** Inyecciones iniciales por ticker (en mayúsculas). */
  injections?: Record<string, SimulatedInjections>;
  /** Tickers que responden 'not-found'. */
  unknownTickers?: string[];
}

/** MarketDataProvider con controles extra para pruebas. */
export interface SimulatedProvider extends MarketDataProvider {
  /** Añade inyecciones a un ticker (se combinan con las anteriores). */
  inject(ticker: string, injections: SimulatedInjections): void;
  injectSplit(ticker: string, date: SessionDate, factor: number): void;
  injectDividend(ticker: string, date: SessionDate, amount: number): void;
  injectGap(ticker: string, date: SessionDate): void;
  injectDuplicate(ticker: string, date: SessionDate): void;
  injectAnomaly(ticker: string, date: SessionDate, patch: Partial<Omit<Bar, 'date'>>): void;
  /** Marca un ticker como inexistente: las llamadas lanzan 'not-found'. */
  markUnknown(ticker: string): void;
  /** Hace fallar las próximas `count` llamadas (cualquier método). */
  queueFailures(count: number, kind?: MarketDataErrorKind): void;
  /** Fallo permanente hasta pasar null; simula al proveedor caído. */
  setFailing(kind: MarketDataErrorKind | null): void;
  /** Limpia inyecciones, tickers desconocidos y fallos pendientes. */
  reset(): void;
}

/** Hash FNV-1a de una semilla de texto a uint32. */
function hashSeed(seed: number | string): number {
  const text = String(seed);
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/** PRNG mulberry32: pequeño, determinista y suficiente para datos de prueba. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const normalizeTicker = (ticker: string): string => ticker.trim().toUpperCase();

const toSessionDate = (ms: number): SessionDate => new Date(ms).toISOString().slice(0, 10);

interface ContinuousDay {
  date: SessionDate;
  /** OHLCV de la serie económica continua (equivalente post-split). */
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MergedInjections {
  splits: Map<SessionDate, number>;
  dividends: Map<SessionDate, number>;
  gaps: Set<SessionDate>;
  duplicates: Set<SessionDate>;
  anomalies: Map<SessionDate, Array<Partial<Omit<Bar, 'date'>>>>;
}

function mergeInjections(target: MergedInjections, extra: SimulatedInjections): void {
  for (const s of extra.splits ?? []) target.splits.set(s.date, s.factor);
  for (const d of extra.dividends ?? []) target.dividends.set(d.date, d.amount);
  for (const g of extra.gaps ?? []) target.gaps.add(g);
  for (const d of extra.duplicates ?? []) target.duplicates.add(d);
  for (const a of extra.anomalies ?? []) {
    const list = target.anomalies.get(a.date) ?? [];
    list.push(a.patch);
    target.anomalies.set(a.date, list);
  }
}

function emptyInjections(): MergedInjections {
  return {
    splits: new Map(),
    dividends: new Map(),
    gaps: new Set(),
    duplicates: new Set(),
    anomalies: new Map(),
  };
}

export function createSimulatedProvider(options: SimulatedProviderOptions = {}): SimulatedProvider {
  const seed = options.seed ?? 'tradia';
  const now = options.now ?? (() => Date.now());
  const genesis = options.genesis ?? DEFAULT_GENESIS;
  const dailyVol = options.dailyVol ?? 0.02;
  const drift = options.drift ?? 0.0002;

  const injectionsByTicker = new Map<string, MergedInjections>();
  for (const [ticker, inj] of Object.entries(options.injections ?? {})) {
    const merged = emptyInjections();
    mergeInjections(merged, inj);
    injectionsByTicker.set(normalizeTicker(ticker), merged);
  }
  const unknownTickers = new Set((options.unknownTickers ?? []).map(normalizeTicker));

  let persistentFailure: MarketDataErrorKind | null = null;
  let queuedFailures = 0;
  let queuedFailureKind: MarketDataErrorKind = 'network';

  const injectionsFor = (ticker: string): MergedInjections => {
    const key = normalizeTicker(ticker);
    let merged = injectionsByTicker.get(key);
    if (!merged) {
      merged = emptyInjections();
      injectionsByTicker.set(key, merged);
    }
    return merged;
  };

  const checkFailure = (ticker?: string): void => {
    const kind = persistentFailure ?? (queuedFailures > 0 ? queuedFailureKind : null);
    if (kind === null) return;
    if (persistentFailure === null) queuedFailures--;
    throw new MarketDataError(kind, `fallo simulado del proveedor (${kind})`, {
      provider: SIMULATED_PROVIDER_ID,
      ticker,
    });
  };

  const assertKnown = (ticker: string): void => {
    if (unknownTickers.has(normalizeTicker(ticker))) {
      throw new MarketDataError('not-found', `ticker '${normalizeTicker(ticker)}' no existe`, {
        provider: SIMULATED_PROVIDER_ID,
        ticker,
      });
    }
  };

  /**
   * Paseo aleatorio continuo desde el génesis hasta `lastDay` inclusive
   * (sesiones NYSE, o días UTC de lunes a viernes para los pares de
   * divisas). Determinista por (seed, ticker); no depende del rango.
   */
  const buildContinuousSeries = (ticker: string, lastDay: SessionDate): ContinuousDay[] => {
    const rng = mulberry32(hashSeed(`${String(seed)}:${ticker}`));
    const fx = isFxPair(ticker);
    const isSessionDay = fx ? isFxSessionDay : isTradingDay;
    // Cinco decimales en divisas, dos en acciones. El nivel del par sale
    // de su anclaje de mercado (~1,1 en EUR/USD); el de la acción, del
    // arranque aleatorio de siempre.
    const decimals = fx ? 5 : 2;
    const anchor = fx ? fxAnchorFor(ticker) : 0;
    const days: ContinuousDay[] = [];
    let close = fx ? anchor : round(20 + rng() * 480, decimals);
    const baseVolume = Math.round(1_000_000 + rng() * 50_000_000);

    const cursor = new Date(`${genesis}T00:00:00.000Z`);
    const end = new Date(`${lastDay}T00:00:00.000Z`);
    while (cursor <= end) {
      const date = toSessionDate(cursor.getTime());
      if (isSessionDay(date)) {
        // Ruido triangular en [-1, 1): la acción lo escala con dailyVol y
        // la deriva suave; el par revierte al anclaje con vol ≈0,5 %.
        const unit = (rng() + rng() + rng()) / 1.5 - 1;
        const prev = close;
        close = fx
          ? round(
              anchor + (prev - anchor) * FX_MEAN_REVERSION + anchor * unit * FX_DAILY_VOL,
              decimals,
            )
          : round(prev * (1 + unit * dailyVol + drift), decimals);
        const open = round(prev * (1 + (rng() + rng() - 1) * 0.005), decimals);
        const high = round(Math.max(open, close) * (1 + rng() * 0.01), decimals);
        const low = round(Math.min(open, close) * (1 - rng() * 0.01), decimals);
        // El mercado de divisas no publica volumen negociado.
        const volume = fx ? 0 : Math.round(baseVolume * (0.5 + rng() * 1.5));
        days.push({ date, open, high, low, close, volume });
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  };

  const buildBars = (ticker: string, inj: MergedInjections, lastDay: SessionDate): Bar[] => {
    const days = buildContinuousSeries(ticker, lastDay);
    if (days.length === 0) return [];
    const fx = isFxPair(ticker);

    const splitDates = [...inj.splits.keys()].sort();
    const dividendDates = [...inj.dividends.keys()].sort();
    const closeByDate = new Map(days.map((d) => [d.date, d.close] as const));
    const indexByDate = new Map(days.map((d, i) => [d.date, i] as const));

    /** Factor de split acumulado para fechas anteriores a cada split. */
    const cumSplit = (date: SessionDate): number => {
      let factor = 1;
      for (const splitDate of splitDates) {
        if (splitDate > date) factor *= inj.splits.get(splitDate)!;
      }
      return factor;
    };

    /** Cierre crudo del día anterior a la fecha ex de un dividendo. */
    const rawCloseBefore = (exDate: SessionDate): number => {
      const idx = indexByDate.get(exDate);
      if (idx !== undefined && idx > 0) {
        const prev = days[idx - 1]!;
        return prev.close * cumSplit(prev.date);
      }
      // Si la fecha ex no es sesión generada, usa el cierre más cercano anterior.
      let best: ContinuousDay | undefined;
      for (const d of days) {
        if (d.date < exDate) best = d;
        else break;
      }
      return best ? best.close * cumSplit(best.date) : (closeByDate.get(exDate) ?? 1);
    };

    /** Factor de ajuste por dividendos con fecha ex posterior a `date`. */
    const cumDividend = (date: SessionDate): number => {
      let factor = 1;
      for (const exDate of dividendDates) {
        if (exDate > date) {
          const amount = inj.dividends.get(exDate)!;
          const prev = rawCloseBefore(exDate);
          if (prev > 0) factor *= Math.max(0, 1 - amount / prev);
        }
      }
      return factor;
    };

    const bars: Bar[] = [];
    for (const day of days) {
      const scale = fx ? 1 : cumSplit(day.date);
      const bar: Bar = {
        date: day.date,
        open: round(day.open * scale, fx ? 5 : 2),
        high: round(day.high * scale, fx ? 5 : 2),
        low: round(day.low * scale, fx ? 5 : 2),
        close: round(day.close * scale, fx ? 5 : 2),
        volume: Math.round(day.volume / scale),
        adjClose: round(day.close * (fx ? 1 : cumDividend(day.date)), fx ? 5 : 4),
        splitFactor: fx ? 1 : (inj.splits.get(day.date) ?? 1),
        dividend: fx ? 0 : (inj.dividends.get(day.date) ?? 0),
      };
      bars.push(bar);
      // El duplicado llega como una segunda fila idéntica inmediatamente después.
      if (inj.duplicates.has(day.date)) bars.push({ ...bar });
    }
    return bars;
  };

  /** Última sesión cuyo cierre ya pasó según el reloj (NYSE o 24/5, según el activo). */
  const lastAvailableSession = (ticker: string): SessionDate | null =>
    isFxPair(ticker)
      ? (fxLastExpectedSession(now())?.date ?? null)
      : (lastExpectedSession(now())?.date ?? null);

  const validateCall = (ticker: string): string => {
    assertValidTicker(ticker, SIMULATED_PROVIDER_ID);
    checkFailure(ticker);
    assertKnown(ticker);
    return normalizeTicker(ticker);
  };

  const provider: SimulatedProvider = {
    id: SIMULATED_PROVIDER_ID,
    rateLimits: SIMULATED_RATE_LIMITS,

    getBars: async (ticker, desde, hasta) => {
      const key = validateCall(ticker);
      assertValidDateRange(desde, hasta, SIMULATED_PROVIDER_ID);
      const lastSession = lastAvailableSession(key);
      if (lastSession === null) return [];
      const end = lastSession < hasta ? lastSession : hasta;
      if (desde > end || end < genesis) return [];

      const inj = injectionsFor(key);
      const bars = buildBars(key, inj, end).filter((b) => b.date >= desde && b.date <= hasta);

      // Huecos: el proveedor omite esas sesiones por completo.
      const visible = bars.filter((b) => !inj.gaps.has(b.date));
      // Valores anómalos: parches aplicados a todas las filas de esa fecha.
      for (const bar of visible) {
        for (const patch of inj.anomalies.get(bar.date) ?? []) Object.assign(bar, patch);
      }
      return visible;
    },

    getTickerInfo: async (ticker) => {
      const key = validateCall(ticker);
      return { ticker: key, assetClass: inferAssetClass(key) };
    },

    getQuote: async (ticker) => {
      const key = validateCall(ticker);
      const lastSession = lastAvailableSession(key);
      if (lastSession === null) {
        throw new MarketDataError('not-found', `sin cotización disponible para '${key}'`, {
          provider: SIMULATED_PROVIDER_ID,
          ticker: key,
        });
      }
      const bars = await provider.getBars(key, lastSession, lastSession);
      const bar = bars[bars.length - 1];
      if (!bar) {
        throw new MarketDataError('not-found', `sin cotización disponible para '${key}'`, {
          provider: SIMULATED_PROVIDER_ID,
          ticker: key,
        });
      }
      return {
        ticker: key,
        date: bar.date,
        last: bar.close,
        volume: isFxPair(key) ? null : bar.volume,
      };
    },

    getCorporateActions: async (ticker, desde, hasta) => {
      const key = validateCall(ticker);
      assertValidDateRange(desde, hasta, SIMULATED_PROVIDER_ID);
      // Un par de divisas no tiene acciones corporativas.
      if (isFxPair(key)) return [];
      const inj = injectionsFor(key);
      const actions: CorporateAction[] = [];
      for (const [date, factor] of inj.splits) {
        if (date >= desde && date <= hasta) {
          actions.push({ ticker: key, date, kind: 'split', value: factor });
        }
      }
      for (const [date, amount] of inj.dividends) {
        if (date >= desde && date <= hasta) {
          actions.push({ ticker: key, date, kind: 'dividend', value: amount });
        }
      }
      return actions.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
    },

    inject: (ticker, injections) => {
      mergeInjections(injectionsFor(ticker), injections);
    },
    injectSplit: (ticker, date, factor) => {
      injectionsFor(ticker).splits.set(date, factor);
    },
    injectDividend: (ticker, date, amount) => {
      injectionsFor(ticker).dividends.set(date, amount);
    },
    injectGap: (ticker, date) => {
      injectionsFor(ticker).gaps.add(date);
    },
    injectDuplicate: (ticker, date) => {
      injectionsFor(ticker).duplicates.add(date);
    },
    injectAnomaly: (ticker, date, patch) => {
      const inj = injectionsFor(ticker);
      const list = inj.anomalies.get(date) ?? [];
      list.push(patch);
      inj.anomalies.set(date, list);
    },
    markUnknown: (ticker) => {
      unknownTickers.add(normalizeTicker(ticker));
    },
    queueFailures: (count, kind = 'network') => {
      queuedFailures += Math.max(0, Math.floor(count));
      queuedFailureKind = kind;
    },
    setFailing: (kind) => {
      persistentFailure = kind;
    },
    reset: () => {
      injectionsByTicker.clear();
      unknownTickers.clear();
      persistentFailure = null;
      queuedFailures = 0;
    },
  };

  return provider;
}
