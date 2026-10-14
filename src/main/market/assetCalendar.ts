/**
 * Calendario de sesiones de cada activo: NYSE para acciones y ETF, 24/5
 * para las divisas (`fxCalendar`).
 *
 * Solo funciones puras. Lo usan las guardas de frescura de régimen,
 * predicción y señales (la «última sesión esperada» de cada activo) y la
 * anualización y el calentamiento del backtest. El tipo de activo sale
 * de `WatchlistItem.assetClass` o, si no viene, de `inferAssetClass`
 * (pares admitidos → 'fx'; el resto → 'equity').
 *
 * Sesiones por año, para anualizar rendimientos diarios:
 * - NYSE: 252 (convención de mercado; unos 251–253 según el año).
 * - Divisas 24/5: 260 (días de lunes a viernes, unos 261, menos el 25 de
 *   diciembre y el 1 de enero, que no se esperan).
 */
import { inferAssetClass } from '../../shared/fx';
import type { AssetClass } from '../../shared/ipc';
import {
  expectedSessionsBetween,
  fxExpectedSessionsBetween,
  fxLastExpectedSession,
  isFxSessionDay,
  isTradingDay,
  lastExpectedSession,
  type InstantInput,
  type MarketSession,
} from './calendar';

/** Sesiones por año de NYSE usadas al anualizar. */
export const NYSE_SESSIONS_PER_YEAR = 252;
/** Sesiones por año de las divisas 24/5 usadas al anualizar. */
export const FX_SESSIONS_PER_YEAR = 260;

/** Días naturales que se revisan hacia atrás para hallar la sesión anterior. */
const PREVIOUS_SESSION_LOOKBACK_DAYS = 40;
const DAY_MS = 86_400_000;

export interface AssetSessionCalendar {
  assetClass: AssetClass;
  /** Sesiones por año para anualizar rendimientos diarios. */
  sessionsPerYear: number;
  /** Última sesión cuyo cierre ya pasó a las `ahora`. */
  lastExpectedSession(ahora: InstantInput): MarketSession | null;
  /** Sesiones entre dos fechas, ambas inclusive. */
  expectedSessionsBetween(desde: InstantInput, hasta: InstantInput): MarketSession[];
  /** true si el día de la fecha 'YYYY-MM-DD' tiene sesión. */
  isSessionDay(date: string): boolean;
}

export const nyseAssetCalendar: AssetSessionCalendar = Object.freeze({
  assetClass: 'equity',
  sessionsPerYear: NYSE_SESSIONS_PER_YEAR,
  lastExpectedSession,
  expectedSessionsBetween,
  isSessionDay: (date: string) => isTradingDay(date),
});

export const fxAssetCalendar: AssetSessionCalendar = Object.freeze({
  assetClass: 'fx',
  sessionsPerYear: FX_SESSIONS_PER_YEAR,
  lastExpectedSession: fxLastExpectedSession,
  expectedSessionsBetween: fxExpectedSessionsBetween,
  isSessionDay: (date: string) => isFxSessionDay(date),
});

/** Calendario de un tipo de activo. */
export function calendarForAssetClass(assetClass: AssetClass): AssetSessionCalendar {
  return assetClass === 'fx' ? fxAssetCalendar : nyseAssetCalendar;
}

/** Calendario de un símbolo guardado ('EURUSD' → 24/5; 'SPY' → NYSE). */
export function calendarForSymbol(symbol: string): AssetSessionCalendar {
  return calendarForAssetClass(inferAssetClass(symbol));
}

/** Fecha de la última sesión esperada del símbolo a las `nowMs`, o null. */
export function expectedSessionDateFor(symbol: string, nowMs: number): string | null {
  return calendarForSymbol(symbol).lastExpectedSession(nowMs)?.date ?? null;
}

/**
 * Sesión inmediatamente anterior a `barDate` ('YYYY-MM-DD') en el
 * calendario del símbolo, o null si la fecha no es válida o no hay
 * ninguna en los 40 días anteriores.
 */
export function previousSessionDateFor(symbol: string, barDate: string): string | null {
  const dayMs = Date.parse(`${barDate}T00:00:00.000Z`);
  if (!Number.isFinite(dayMs)) return null;
  const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return (
    calendarForSymbol(symbol)
      .expectedSessionsBetween(
        isoDay(dayMs - PREVIOUS_SESSION_LOOKBACK_DAYS * DAY_MS),
        isoDay(dayMs - DAY_MS),
      )
      .at(-1)?.date ?? null
  );
}

/**
 * Sesiones por año de un universo: con algún par de divisas, la línea
 * temporal es la unión de fechas y tiene las sesiones 24/5 (las de NYSE
 * son un subconjunto de los días de lunes a viernes); si no, las de NYSE.
 */
export function sessionsPerYearFor(symbols: Iterable<string>): number {
  for (const symbol of symbols) {
    if (inferAssetClass(symbol) === 'fx') return FX_SESSIONS_PER_YEAR;
  }
  return NYSE_SESSIONS_PER_YEAR;
}

/**
 * Calendario para el calentamiento de un universo: el de NYSE si hay
 * alguna acción (sus sesiones son menos por año, así que N sesiones de
 * NYSE cubren también N sesiones de divisas); el 24/5 si todo son pares.
 */
export function warmupCalendarFor(symbols: Iterable<string>): AssetSessionCalendar {
  let any = false;
  for (const symbol of symbols) {
    any = true;
    if (inferAssetClass(symbol) !== 'fx') return nyseAssetCalendar;
  }
  return any ? fxAssetCalendar : nyseAssetCalendar;
}
