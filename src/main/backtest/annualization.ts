/**
 * Anualización del backtest según el calendario de sus activos.
 *
 * La curva de capital tiene un punto por sesión de la línea temporal (la
 * unión de fechas de vela). Con algún par de divisas esa línea sigue el
 * 24/5 (unas 260 sesiones al año); si todo son acciones, NYSE (252).
 * `computeMetrics` recibe ese número para el Sharpe y la rentabilidad
 * anualizada (ver `market/assetCalendar`).
 */
import { sessionsPerYearFor } from '../market/assetCalendar';
import type { MetricsOptions } from './metrics';
import type { BacktestInput } from './types';

/** Opciones de métricas con las sesiones por año del universo operable. */
export function annualizationFor(
  input: Pick<BacktestInput, 'bars' | 'universe'>,
): Pick<MetricsOptions, 'tradingDaysPerYear'> {
  const tickers =
    input.universe !== undefined
      ? input.universe.map((member) => member.ticker)
      : Object.keys(input.bars);
  return { tradingDaysPerYear: sessionsPerYearFor(tickers) };
}

/** Lo mismo a partir de la lista de mercados de la ficha. */
export function annualizationForMarkets(
  markets: readonly string[],
): Pick<MetricsOptions, 'tradingDaysPerYear'> {
  return { tradingDaysPerYear: sessionsPerYearFor(markets) };
}
