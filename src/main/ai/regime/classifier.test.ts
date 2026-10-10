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

/** Une dos tramos: antes de `cut` usa `first`, desde `cut` usa `second`. */
const phased =
  (first: (i: number) => number, second: (i: number) => number, cut: number) =>
  (i: number): number =>
    i < cut ? first(i) : second(i);

const N = 340;

/** Tendencia alcista limpia de volatilidad nula: +0,45 % diario constante. */
const TREND_LOW_VOL = seriesFromReturns(N, () => 0.0045);

/**
 * Tendencia de volatilidad alta: deriva constante las 300 primeras
 * sesiones y un tramo final con deriva más fuerte y sacudidas en seno
 * (ADX > 25 con volatilidad muy por encima de la mediana previa).
 */
const TREND_HIGH_VOL = seriesFromReturns(
  N,
  phased(
    () => 0.0045,
    (i) => 0.006 + 0.025 * Math.sin(i * 0.9),
    N - 40,
  ),
);

/** Lateral de volatilidad alta: seno calmado que se desboca al final. */
const LATERAL_HIGH_VOL = seriesFromReturns(
  N,
  phased(
    (i) => 0.002 * Math.sin(i * 0.7),
    (i) => 0.03 * Math.sin(i * 0.7),
    N - 40,
  ),
);

/** Lateral de volatilidad baja: seno amplio que se calma al final (la
 *  mediana de 252 conserva el tramo amplio → comparación de verdad). */
const LATERAL_LOW_VOL = seriesFromReturns(
  N,
  phased(
    (i) => 0.03 * Math.sin(i * 0.7),
    (i) => 0.002 * Math.sin(i * 0.7),
    N - 40,
  ),
);

describe('clasificador de régimen: los cuatro casos', () => {
  it.each([
    ['tendencia + volatilidad baja', TREND_LOW_VOL, 'tendencia', 'volatilidad-baja'],
    ['tendencia + volatilidad alta', TREND_HIGH_VOL, 'tendencia', 'volatilidad-alta'],
    ['lateral + volatilidad alta', LATERAL_HIGH_VOL, 'lateral', 'volatilidad-alta'],
    ['lateral + volatilidad baja', LATERAL_LOW_VOL, 'lateral', 'volatilidad-baja'],
  ])('%s', (_name, candles, direction, volatility) => {
    const classification = classifyRegime(candles);
    expect(classification.direction).toBe(direction);
    expect(classification.volatility).toBe(volatility);
  });

  it('las etiquetas vienen de las medidas: ADX, pendiente y volatilidad documentan el porqué', () => {
    const trend = classifyRegime(TREND_LOW_VOL);
    expect(trend.metrics.adx).toBeGreaterThan(25);
    expect(trend.metrics.smaSlope).toBeGreaterThan(0);
    const lateral = classifyRegime(LATERAL_LOW_VOL);
    expect(lateral.metrics.adx).toBeLessThan(25);
    const highVol = classifyRegime(LATERAL_HIGH_VOL);
    expect(highVol.metrics.realizedVolatility).toBeGreaterThan(highVol.metrics.volatilityMedian!);
    const lowVol = classifyRegime(LATERAL_LOW_VOL);
    expect(lowVol.metrics.volatilityMedian).not.toBeNull();
    expect(lowVol.metrics.realizedVolatility).toBeLessThanOrEqual(lowVol.metrics.volatilityMedian!);
  });
});

describe('fronteras de las funciones de decisión', () => {
  it('tendencia exige ADX estrictamente mayor que 25 con pendiente no nula', () => {
    expect(directionLabel(25, 0.01)).toBe('lateral');
    expect(directionLabel(25.0001, 0.01)).toBe('tendencia');
    expect(directionLabel(60, -0.5)).toBe('tendencia'); // el signo no importa
  });

  it('pendiente nula o sin datos frena la tendencia aunque el ADX sea alto', () => {
    expect(directionLabel(60, 0)).toBe('lateral');
    expect(directionLabel(60, null)).toBe('lateral');
    expect(directionLabel(null, 0.5)).toBe('lateral');
  });

  it('volatilidad alta exige superar estrictamente la mediana', () => {
    expect(volatilityLabel(0.02, 0.02)).toBe('volatilidad-baja');
    expect(volatilityLabel(0.0201, 0.02)).toBe('volatilidad-alta');
    expect(volatilityLabel(0.05, null)).toBe('volatilidad-baja');
    expect(volatilityLabel(null, 0.02)).toBe('volatilidad-baja');
  });
});

describe('indicadores del clasificador', () => {
  it('adx: primer valor en el índice 2·period−1, alto en tendencia y bajo en lateral', () => {
    const series = adx(TREND_LOW_VOL, 14);
    expect(series.slice(0, 27).every((value) => value === null)).toBe(true);
    expect(series[27]).not.toBeNull();
    expect(series[N - 1]!).toBeGreaterThan(50);
    const lateral = adx(LATERAL_LOW_VOL, 14);
    expect(lateral[N - 1]!).toBeLessThan(25);
  });

  it('pendiente de la SMA50: null hasta el índice 50, positiva en tendencia', () => {
    const slope = smaSlopeSeries(TREND_LOW_VOL, 50);
    expect(slope.slice(0, 50).every((value) => value === null)).toBe(true);
    expect(slope[50]).toBeGreaterThan(0);
    const flat = smaSlopeSeries(LATERAL_LOW_VOL, 50);
    expect(flat[N - 1]).not.toBeNull();
  });

  it('volatilidad realizada: primer valor en el índice 20 con la desviación de los retornos', () => {
    const vol = realizedVolatilitySeries(LATERAL_HIGH_VOL, 20);
    expect(vol.slice(0, 20).every((value) => value === null)).toBe(true);
    expect(vol[20]).not.toBeNull();
    expect(vol[N - 1]!).toBeGreaterThan(vol[100]!);
  });

  it('mediana: centro en impares, media de los centrales en pares, null sin datos', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('sin look-ahead', () => {
  it('añadir velas posteriores a la sesión t no cambia su clasificación', () => {
    for (const candles of [TREND_LOW_VOL, TREND_HIGH_VOL, LATERAL_HIGH_VOL, LATERAL_LOW_VOL]) {
      const full = createRegimeClassifier(candles);
      for (const t of [80, 150, 250, candles.length - 1]) {
        const truncated = createRegimeClassifier(candles.slice(0, t + 1));
        expect(truncated.classifyAt(t)).toEqual(full.classifyAt(t));
      }
    }
  });
});

describe('datos insuficientes', () => {
  it('las etiquetas caen al valor por defecto y las medidas quedan null', () => {
    const short = classifyRegime(TREND_LOW_VOL.slice(0, 20));
    expect(short.direction).toBe('lateral');
    expect(short.volatility).toBe('volatilidad-baja');
    expect(short.metrics.adx).toBeNull();
    expect(short.metrics.smaSlope).toBeNull();
    expect(short.metrics.realizedVolatility).toBeNull();
    expect(short.metrics.volatilityMedian).toBeNull();
  });

  it('lanza RangeError fuera de rango o con la serie vacía', () => {
    const classifier = createRegimeClassifier(TREND_LOW_VOL);
    expect(() => classifier.classifyAt(-1)).toThrow(RangeError);
    expect(() => classifier.classifyAt(N)).toThrow(RangeError);
    expect(() => classifyRegime([])).toThrow(RangeError);
  });
});
