import { describe, expect, it } from 'vitest';

import type { Candle } from '../../../shared/indicators';
import {
  adx,
  classifyRegime,
  createRegimeClassifier,
  directionLabel,
  median,
  realizedVolatilitySeries,
  smaSlopeSeries,
  volatilityLabel,
} from './classifier';

// ---------------------------------------------------------------------------
// Series sintéticas deterministas
// ---------------------------------------------------------------------------

/**
 * Serie de velas a partir del rendimiento diario `ret(i)`: cada vela abre
 * en el cierre anterior y su high/low envuelven los dos cierres con un
 * margen `wick`. Determinista: mismo `ret` → misma serie.
 */
function seriesFromReturns(n: number, ret: (i: number) => number, wick = 0.001): Candle[] {
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const next = close * (1 + ret(i));
    const open = close;
    const high = Math.max(open, next) * (1 + wick);
    const low = Math.min(open, next) * (1 - wick);
    candles.push({ open, high, low, close: next });
    close = next;
  }
  return candles;
}

/** Une dos funciones de rendimiento: antes de `cut` usa `calm`, desde `cut` usa `hot`. */
const phased =
  (calm: (i: number) => number, hot: (i: number) => number, cut: number) =>
  (i: number): number =>
    i < cut ? calm(i) : hot(i);

/** Tendencia alcista limpia: +0,45 % diario constante (volatilidad nula). */
const trendUp = (): number => 0.0045;

/**
 * Diente de sierra simétrico ±amplitude: la bajada es la inversa
 * multiplicativa de la subida, así el precio vuelve al mismo nivel cada
 * par de sesiones (sin deriva) y +DM/−DM se alternan con igual magnitud.
 */
const zigzag = (amplitude: number) => (i: number): number =>
  i % 2 === 0 ? amplitude : -amplitude / (1 + amplitude);

/** Tendencia con sacudidas: días fuertes al alza y retrocesos moderados. */
const trendVolatile = (i: number): number =>
  i % 2 === 0 ? 0.028 : -0.011 / 1.028;

const N = 340;
const TREND_CALM = seriesFromReturns(N, trendUp);
const LATERAL_CALM = seriesFromReturns(N, zigzag(0.002));
const LATERAL_HOT = seriesFromReturns(N, phased(zigzag(0.002), zigzag(0.03), N - 40));
const TREND_HOT = seriesFromReturns(N, phased(trendUp, trendVolatile, N - 40));
/** Calm tras la tormenta: volatilidad baja con una mediana alta de verdad. */
const CALM_AFTER_HOT = seriesFromReturns(N, phased(zigzag(0.03), zigzag(0.002), N - 40));

describe('diagnóstico de métricas en las series sintéticas', () => {
  it('imprime ADX, pendiente y volatilidad de cada serie', () => {
    for (const [name, candles] of [
      ['trendCalm', TREND_CALM],
      ['lateralCalm', LATERAL_CALM],
      ['lateralHot', LATERAL_HOT],
      ['trendHot', TREND_HOT],
      ['calmAfterHot', CALM_AFTER_HOT],
    ] as const) {
      const c = classifyRegime(candles);
      console.log(
        name,
        'adx=', c.metrics.adx?.toFixed(2),
        'slope=', c.metrics.smaSlope?.toPrecision(3),
        'vol=', c.metrics.realizedVolatility?.toPrecision(3),
        'med=', c.metrics.volatilityMedian?.toPrecision(3),
        '→', c.direction, c.volatility,
      );
    }
  });
});
