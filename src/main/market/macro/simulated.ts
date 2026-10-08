/**
 * Proveedor macro simulado determinista, para pruebas y desarrollo
 * (TRADIA_E2E). Sirve el mismo catálogo que FRED (`MACRO_SERIES_CATALOG`)
 * sin red ni clave.
 *
 * - Cada serie es un paseo aleatorio con semilla anclado a un génesis fijo:
 *   el mismo (seed, seriesId) produce siempre la misma serie, sin importar
 *   el rango consultado ni el orden de las llamadas.
 * - Las series diarias emiten en días laborables y las mensuales el día 1
 *   de cada mes; una observación solo existe si su fecha ya pasó según el
 *   reloj inyectado (`now`). Avanzar el reloj hace aparecer observaciones
 *   nuevas, igual que la publicación diaria de FRED.
 * - Permite inyectar huecos y valores concretos por fecha, marcar series
 *   como desconocidas y programar fallos del proveedor, para probar la
 *   ingesta macro, el refresco programado y la salud del dato.
 */
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

export const SIMULATED_MACRO_PROVIDER_ID = 'macro-simulated';

/** Sin límite práctico: la cuota local nunca bloquea al simulado. */
export const SIMULATED_MACRO_RATE_LIMITS: RateLimits = { perHour: 60_000, perDay: 1_000_000 };

const DEFAULT_GENESIS: SessionDate = '2000-01-03'; // lunes

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface SimulatedMacroInjections {
  /** Fechas de observación que el proveedor omite (hueco de datos). */
  gaps?: SessionDate[];
  /** { date, value }: sobrescribe el valor de la observación de `date`. */
  values?: Array<{ date: SessionDate; value: number }>;
}

/** Forma del paseo por serie: base inicial, rango y escala del paso. */
interface SeriesShape {
  base: number;
  min: number;
  max: number;
  /** Paso máximo por observación (en puntos, no fracción). */
  step: number;
  /** Sesgo del paseo por observación (puntos); el IPC tiende a subir. */
  drift: number;
}

const SERIES_SHAPES: Record<string, SeriesShape> = {
  DFF: { base: 4.4, min: 0.05, max: 5.6, step: 0.12, drift: 0 },
  CPIAUCSL: { base: 300, min: 150, max: 450, step: 0.8, drift: 0.45 },
  DGS2: { base: 4.4, min: 0.2, max: 5.6, step: 0.09, drift: 0 },
  DGS10: { base: 4.1, min: 0.4, max: 5.2, step: 0.07, drift: 0 },
  T10Y2Y: { base: -0.2, min: -1.6, max: 2.6, step: 0.06, drift: 0 },
  VIXCLS: { base: 18, min: 9, max: 60, step: 1.1, drift: 0 },
};

const DEFAULT_SHAPE: SeriesShape = { base: 100, min: 0, max: 1_000, step: 1, drift: 0 };

export interface SimulatedMacroProviderOptions {
  /** Semilla del paseo aleatorio (número o texto). */
  seed?: number | string;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Primera fecha de la serie generada ('YYYY-MM-DD', un lunes). */
  genesis?: SessionDate;
  /** Catálogo servido; por defecto `MACRO_SERIES_CATALOG`. */
  series?: readonly MacroSeriesMeta[];
  /** Inyecciones iniciales por serie. */
  injections?: Record<string, SimulatedMacroInjections>;
  /** Series que responden 'not-found'. */
  unknownSeries?: string[];
}

/** MacroDataProvider con controles extra para pruebas. */
export interface SimulatedMacroProvider extends MacroDataProvider {
  /** Añade inyecciones a una serie (se combinan con las anteriores). */
  inject(seriesId: string, injections: SimulatedMacroInjections): void;
  injectGap(seriesId: string, date: SessionDate): void;
  injectValue(seriesId: string, date: SessionDate, value: number): void;
  /** Marca una serie como inexistente: las llamadas lanzan 'not-found'. */
  markUnknown(seriesId: string): void;
  /** Hace fallar las próximas `count` llamadas. */
  queueFailures(count: number, kind?: MarketDataErrorKind): void;
  /** Fallo permanente hasta pasar null; simula al proveedor caído. */
  setFailing(kind: MarketDataErrorKind | null): void;
  /** Limpia inyecciones, series desconocidas y fallos pendientes. */
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

const toSessionDate = (ms: number): SessionDate => new Date(ms).toISOString().slice(0, 10);

const isWeekday = (date: Date): boolean => {
  const day = date.getUTCDay();
  return day >= 1 && day <= 5;
};

interface MergedInjections {
  gaps: Set<SessionDate>;
  values: Map<SessionDate, number>;
}

function mergeInjections(target: MergedInjections, extra: SimulatedMacroInjections): void {
  for (const g of extra.gaps ?? []) target.gaps.add(g);
  for (const v of extra.values ?? []) target.values.set(v.date, v.value);
}

const emptyInjections = (): MergedInjections => ({ gaps: new Set(), values: new Map() });

function assertIsoDate(value: SessionDate, label: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  const isRealDate = !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  if (!ISO_DATE_PATTERN.test(value) || !isRealDate) {
    throw new MarketDataError(
      'bad-data',
      `fecha '${label}' inválida: ${JSON.stringify(value)} (se espera 'YYYY-MM-DD')`,
      { provider: SIMULATED_MACRO_PROVIDER_ID },
    );
  }
}

/** Fechas de observación entre `genesis` y `lastDay` según la frecuencia. */
function observationDays(
  meta: MacroSeriesMeta,
  genesis: SessionDate,
  lastDay: SessionDate,
): SessionDate[] {
  const days: SessionDate[] = [];
  if (meta.frequency === 'monthly') {
    const cursor = new Date(`${genesis}T00:00:00.000Z`);
    cursor.setUTCDate(1);
    const end = new Date(`${lastDay}T00:00:00.000Z`);
    while (cursor <= end) {
      const date = toSessionDate(cursor.getTime());
      if (date >= genesis) days.push(date);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return days;
  }
  const cursor = new Date(`${genesis}T00:00:00.000Z`);
  const end = new Date(`${lastDay}T00:00:00.000Z`);
  while (cursor <= end) {
    if (isWeekday(cursor)) days.push(toSessionDate(cursor.getTime()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function createSimulatedMacroProvider(
  options: SimulatedMacroProviderOptions = {},
): SimulatedMacroProvider {
  const seed = options.seed ?? 'tradia';
  const now = options.now ?? (() => Date.now());
  const genesis = options.genesis ?? DEFAULT_GENESIS;
  const series = options.series ?? MACRO_SERIES_CATALOG;

  const injectionsBySeries = new Map<string, MergedInjections>();
  for (const [id, inj] of Object.entries(options.injections ?? {})) {
    const merged = emptyInjections();
    mergeInjections(merged, inj);
    injectionsBySeries.set(id, merged);
  }
  const unknownSeries = new Set(options.unknownSeries ?? []);

  let persistentFailure: MarketDataErrorKind | null = null;
  let queuedFailures = 0;
  let queuedFailureKind: MarketDataErrorKind = 'network';

  const injectionsFor = (seriesId: string): MergedInjections => {
    let merged = injectionsBySeries.get(seriesId);
    if (!merged) {
      merged = emptyInjections();
      injectionsBySeries.set(seriesId, merged);
    }
    return merged;
  };

  const checkFailure = (): void => {
    const kind = persistentFailure ?? (queuedFailures > 0 ? queuedFailureKind : null);
    if (kind === null) return;
    if (persistentFailure === null) queuedFailures--;
    throw new MarketDataError(kind, `fallo simulado del proveedor macro (${kind})`, {
      provider: SIMULATED_MACRO_PROVIDER_ID,
    });
  };

  const metaFor = (seriesId: string): MacroSeriesMeta => {
    const meta = series.find((s) => s.id === seriesId);
    if (!meta || unknownSeries.has(seriesId)) {
      throw new MarketDataError('not-found', `serie '${seriesId}' no existe`, {
        provider: SIMULATED_MACRO_PROVIDER_ID,
      });
    }
    return meta;
  };

  /**
   * Serie completa del génesis a `lastDay`: determinista por (seed, seriesId)
   * e independiente del rango consultado después.
   */
  const buildSeries = (meta: MacroSeriesMeta, lastDay: SessionDate): MacroObservation[] => {
    const rng = mulberry32(hashSeed(`${String(seed)}:${meta.id}`));
    const shape = SERIES_SHAPES[meta.id] ?? DEFAULT_SHAPE;
    const inj = injectionsBySeries.get(meta.id);
    const observations: MacroObservation[] = [];
    let value = shape.base + (rng() - 0.5) * shape.step * 4;
    for (const date of observationDays(meta, genesis, lastDay)) {
      // El paseo avanza en cada fecha aunque el día esté marcado como hueco.
      value = Math.min(
        shape.max,
        Math.max(shape.min, value + (rng() - 0.5) * 2 * shape.step + shape.drift),
      );
      if (inj?.gaps.has(date)) continue;
      observations.push({ date, value: round(inj?.values.get(date) ?? value, 4) });
    }
    return observations;
  };

  const provider: SimulatedMacroProvider = {
    id: SIMULATED_MACRO_PROVIDER_ID,
    rateLimits: SIMULATED_MACRO_RATE_LIMITS,

    listSeries: () => series,

    getObservations: async (seriesId, desde, hasta) => {
      if (desde !== undefined) assertIsoDate(desde, 'desde');
      if (hasta !== undefined) assertIsoDate(hasta, 'hasta');
      if (desde !== undefined && hasta !== undefined && desde > hasta) {
        throw new MarketDataError('bad-data', `rango de fechas invertido: ${desde} > ${hasta}`, {
          provider: SIMULATED_MACRO_PROVIDER_ID,
        });
      }
      const meta = metaFor(seriesId);
      checkFailure();
      // Una observación solo existe si su fecha ya llegó según el reloj.
      const lastDay =
        hasta !== undefined && hasta < toSessionDate(now()) ? hasta : toSessionDate(now());
      if (lastDay < genesis) return [];
      return buildSeries(meta, lastDay).filter((obs) => desde === undefined || obs.date >= desde);
    },

    inject: (seriesId, injections) => {
      mergeInjections(injectionsFor(seriesId), injections);
    },
    injectGap: (seriesId, date) => {
      injectionsFor(seriesId).gaps.add(date);
    },
    injectValue: (seriesId, date, value) => {
      injectionsFor(seriesId).values.set(date, value);
    },
    markUnknown: (seriesId) => {
      unknownSeries.add(seriesId);
    },
    queueFailures: (count, kind = 'network') => {
      queuedFailures = Math.max(0, queuedFailures) + Math.max(0, Math.floor(count));
      queuedFailureKind = kind;
    },
    setFailing: (kind) => {
      persistentFailure = kind;
    },
    reset: () => {
      injectionsBySeries.clear();
      unknownSeries.clear();
      persistentFailure = null;
      queuedFailures = 0;
    },
  };

  return provider;
}
