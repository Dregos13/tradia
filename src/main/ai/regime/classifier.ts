/**
 * Clasificador de régimen de mercado — Fase 6 (núcleo puro).
 *
 * Dos ejes por sesión, siempre con etiqueta (src/shared/ai.ts fija los
 * umbrales y los literales):
 *
 * - Dirección: 'tendencia' si ADX(14) > 25 con pendiente de la SMA50
 *   distinta de cero; en otro caso 'lateral'.
 * - Volatilidad: 'volatilidad-alta' si la volatilidad realizada de 20
 *   sesiones supera su mediana de las 252 observaciones anteriores;
 *   en otro caso 'volatilidad-baja'.
 *
 * Causalidad (sin look-ahead): la clasificación de la sesión i usa
 * únicamente las velas 0..i. Los indicadores son recurrencias hacia
 * delante (Wilder) o ventanas que terminan en i, y la mediana de
 * volatilidad solo mira observaciones anteriores a i.
 *
 * Datos insuficientes: cada medida queda `null` en la métrica y el eje
 * cae en su etiqueta por defecto ('lateral' / 'volatilidad-baja'): lo
 * que no se puede demostrar no se clasifica como régimen extremo. El
 * servicio además exige `REGIME_MIN_BARS` velas antes de persistir.
 */
import { sma, trueRange, type Candle, type IndicatorSeries } from '../../../shared/indicators';
import {
  REGIME_ADX_PERIOD,
  REGIME_ADX_TREND_THRESHOLD,
  REGIME_SMA_PERIOD,
  REGIME_VOL_MEDIAN_WINDOW,
  REGIME_VOL_WINDOW,
  type RegimeDirectionLabel,
  type RegimeMetrics,
  type RegimeVolatilityLabel,
} from '../../../shared/ai';

/**
 * Velas mínimas para que la clasificación tenga todas las medidas:
 * la pendiente de la SMA50 necesita dos valores de SMA (índice 50).
 * Con 51 velas además hay ADX (desde el índice 27) y al menos 30
 * observaciones de volatilidad previas para la mediana.
 */
export const REGIME_MIN_BARS = REGIME_SMA_PERIOD + 1;

/**
 * Mínimo de observaciones previas de volatilidad realizada para que la
 * mediana de referencia exista (una ventana de volatilidad completa).
 */
export const REGIME_VOL_MIN_SAMPLES = REGIME_VOL_WINDOW;

function assertFinite(value: number, field: string, index: number, indicator: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      `${indicator}: '${field}' de la vela ${index} no es un número finito (${String(value)})`,
    );
  }
}

/**
 * ADX de Wilder: +DM/−DM frente al rango verdadero suavizados con la
 * media de Wilder (semilla = media simple de las `period` primeras
 * observaciones, igual que `atr`/`rsi` de shared/indicators), DX y ADX
 * como media de Wilder del DX. El primer valor cae en el índice
 * `2 * period - 1` (27 con el periodo 14 del contrato).
 */
export function adx(candles: readonly Candle[], period = REGIME_ADX_PERIOD): IndicatorSeries {
  const result: IndicatorSeries = new Array<number | null>(candles.length).fill(null);
  if (candles.length <= period * 2 - 1) {
    return result;
  }
  const tr = trueRange(candles); // valida high/low/close de toda la serie
  const plusDm: number[] = new Array<number>(candles.length).fill(0);
  const minusDm: number[] = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i]!.high - candles[i - 1]!.high;
    const downMove = candles[i - 1]!.low - candles[i]!.low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Medias de Wilder sembradas con la media de los índices 1..period.
  let trMean = 0;
  let plusMean = 0;
  let minusMean = 0;
  for (let i = 1; i <= period; i++) {
    trMean += tr[i]!;
    plusMean += plusDm[i]!;
    minusMean += minusDm[i]!;
  }
  trMean /= period;
  plusMean /= period;
  minusMean /= period;

  const dxValue = (): number => {
    if (trMean === 0) return 0;
    const plusDi = (100 * plusMean) / trMean;
    const minusDi = (100 * minusMean) / trMean;
    const sum = plusDi + minusDi;
    return sum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / sum;
  };

  const dx: number[] = new Array<number>(candles.length).fill(0);
  dx[period] = dxValue();
  for (let i = period + 1; i < candles.length; i++) {
    trMean = (trMean * (period - 1) + tr[i]!) / period;
    plusMean = (plusMean * (period - 1) + plusDm[i]!) / period;
    minusMean = (minusMean * (period - 1) + minusDm[i]!) / period;
    dx[i] = dxValue();
  }

  // ADX: media de Wilder del DX, sembrada con la media de dx[period..2p-1].
  let value = 0;
  for (let i = period; i <= period * 2 - 1; i++) {
    value += dx[i]!;
  }
  value /= period;
  result[period * 2 - 1] = value;
  for (let i = period * 2; i < candles.length; i++) {
    value = (value * (period - 1) + dx[i]!) / period;
    result[i] = value;
  }
  return result;
}

/**
 * Pendiente por sesión de la SMA del cierre: `sma[i] − sma[i−1]`; null
 * hasta que existen dos valores seguidos (índice `period` en adelante).
 */
export function smaSlopeSeries(
  candles: readonly Candle[],
  period = REGIME_SMA_PERIOD,
): IndicatorSeries {
  const series = sma(candles, period);
  const result: IndicatorSeries = new Array<number | null>(candles.length).fill(null);
  for (let i = 1; i < series.length; i++) {
    const current = series[i] ?? null;
    const previous = series[i - 1] ?? null;
    if (current !== null && previous !== null) {
      result[i] = current - previous;
    }
  }
  return result;
}

/**
 * Volatilidad realizada: desviación típica (poblacional) de los
 * `window` últimos rendimientos simples del cierre, en tanto por uno.
 * El primer valor cae en el índice `window` (21 cierres → 20 retornos).
 */
export function realizedVolatilitySeries(
  candles: readonly Candle[],
  window = REGIME_VOL_WINDOW,
): IndicatorSeries {
  const result: IndicatorSeries = new Array<number | null>(candles.length).fill(null);
  if (candles.length <= window) {
    return result;
  }
  const returns: number[] = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const close = candles[i]!.close;
    assertFinite(prev, 'close', i - 1, 'realizedVolatility');
    assertFinite(close, 'close', i, 'realizedVolatility');
    if (prev <= 0) {
      throw new TypeError(
        `realizedVolatility: el cierre de la vela ${i - 1} debe ser > 0 (${String(prev)})`,
      );
    }
    returns[i] = close / prev - 1;
  }
  let sum = 0;
  let sumSq = 0;
  for (let i = 1; i < candles.length; i++) {
    sum += returns[i]!;
    sumSq += returns[i]! * returns[i]!;
    if (i > window) {
      sum -= returns[i - window]!;
      sumSq -= returns[i - window]! * returns[i - window]!;
    }
    if (i >= window) {
      const mean = sum / window;
      // Mínimo 0: la varianza acumulada puede quedar −ε por redondeo.
      result[i] = Math.sqrt(Math.max(0, sumSq / window - mean * mean));
    }
  }
  return result;
}

/** Mediana de una muestra finita; null con la lista vacía. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Etiqueta del eje de dirección a partir de las medidas (frontera estricta). */
export function directionLabel(
  adxValue: number | null,
  smaSlope: number | null,
): RegimeDirectionLabel {
  return adxValue !== null &&
    adxValue > REGIME_ADX_TREND_THRESHOLD &&
    smaSlope !== null &&
    smaSlope !== 0
    ? 'tendencia'
    : 'lateral';
}

/** Etiqueta del eje de volatilidad: alta solo si supera estrictamente la mediana. */
export function volatilityLabel(
  realized: number | null,
  reference: number | null,
): RegimeVolatilityLabel {
  return realized !== null && reference !== null && realized > reference
    ? 'volatilidad-alta'
    : 'volatilidad-baja';
}

/** Clasificación de una sesión concreta (etiquetas + medidas usadas). */
export interface RegimeClassification {
  direction: RegimeDirectionLabel;
  volatility: RegimeVolatilityLabel;
  metrics: RegimeMetrics;
}

/**
 * Clasificador reutilizable sobre una serie: calcula las series de
 * indicadores una vez y clasifica cualquier índice. `classifyAt(i)` solo
 * lee valores calculados con velas ≤ i (la mediana de volatilidad toma
 * las últimas `REGIME_VOL_MEDIAN_WINDOW` observaciones anteriores a i).
 */
export interface RegimeClassifier {
  length: number;
  classifyAt(index: number): RegimeClassification;
}

export function createRegimeClassifier(candles: readonly Candle[]): RegimeClassifier {
  const adxSeries = adx(candles, REGIME_ADX_PERIOD);
  const slopeSeries = smaSlopeSeries(candles, REGIME_SMA_PERIOD);
  const volSeries = realizedVolatilitySeries(candles, REGIME_VOL_WINDOW);

  const volatilityMedianAt = (index: number): number | null => {
    // Solo observaciones anteriores a la sesión evaluada (sin look-ahead).
    const window: number[] = [];
    for (let j = index - 1; j >= 0 && window.length < REGIME_VOL_MEDIAN_WINDOW; j--) {
      const value = volSeries[j];
      if (value !== null && value !== undefined) window.push(value);
    }
    return window.length >= REGIME_VOL_MIN_SAMPLES ? median(window) : null;
  };

  return {
    length: candles.length,
    classifyAt: (index) => {
      if (!Number.isInteger(index) || index < 0 || index >= candles.length) {
        throw new RangeError(`regime: índice de sesión fuera de rango (${String(index)})`);
      }
      const adxValue = adxSeries[index] ?? null;
      const smaSlope = slopeSeries[index] ?? null;
      const realized = volSeries[index] ?? null;
      const reference = volatilityMedianAt(index);
      return {
        direction: directionLabel(adxValue, smaSlope),
        volatility: volatilityLabel(realized, reference),
        metrics: {
          adx: adxValue,
          smaSlope,
          realizedVolatility: realized,
          volatilityMedian: reference,
        },
      };
    },
  };
}

/** Clasifica la última sesión de la serie dada (atajo de una pasada). */
export function classifyRegime(candles: readonly Candle[]): RegimeClassification {
  if (candles.length === 0) {
    throw new RangeError('regime: la serie no tiene velas');
  }
  return createRegimeClassifier(candles).classifyAt(candles.length - 1);
}
