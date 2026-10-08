/**
 * Indicadores técnicos sobre series de velas — Fase 1.
 *
 * Solo funciones puras sin dependencias de Electron ni de Node: el mismo
 * módulo sirve en el proceso principal (p. ej. para comprobar reglas sobre
 * datos recién ingeridos) y en el renderer (medias superpuestas y paneles de
 * RSI y ATR del gráfico de velas).
 *
 * Contrato común de las cuatro funciones:
 * - La entrada es un array de velas ordenado de antigua a reciente.
 * - La salida tiene exactamente la misma longitud: `null` al principio hasta
 *   que hay datos suficientes para el primer valor.
 * - Ningún valor usa datos de velas posteriores (sin look-ahead): el valor en
 *   el índice i solo depende de las velas 0..i.
 * - `period` debe ser un entero >= 1; cualquier precio no finito (NaN,
 *   Infinity) o campo que no sea número lanza TypeError — conviene pasar las
 *   velas ya limpias por `src/main/market/cleaning`.
 *
 * Suavizado de Wilder: tanto `rsi` como `atr` siembran su media con la media
 * simple de los primeros `period` valores y luego aplican la recurrencia
 * `media = (media * (period - 1) + actual) / period`, equivalente a una EMA
 * con alfa = 1 / period.
 */

/** Vela diaria mínima que necesitan los indicadores. */
export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Serie de un indicador alineada vela a vela con la entrada. */
export type IndicatorSeries = (number | null)[];

/** Velas de las que solo se usa el cierre (SMA, EMA y RSI). */
type PricedCandle = Pick<Candle, 'close'>;

function assertPeriod(period: number, indicator: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${indicator}: el periodo debe ser un entero >= 1 (recibido ${period})`);
  }
}

function assertFiniteField(value: number, field: string, index: number, indicator: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      `${indicator}: '${field}' de la vela ${index} no es un número finito (${String(value)})`,
    );
  }
}

function closesOf(candles: readonly PricedCandle[], indicator: string): number[] {
  return candles.map((candle, index) => {
    assertFiniteField(candle.close, 'close', index, indicator);
    return candle.close;
  });
}

/**
 * Media móvil simple del cierre. El primer valor aparece en el índice
 * `period - 1` como media de las `period` primeras velas.
 */
export function sma(candles: readonly PricedCandle[], period: number): IndicatorSeries {
  assertPeriod(period, 'sma');
  const closes = closesOf(candles, 'sma');
  const result: IndicatorSeries = new Array<number | null>(closes.length).fill(null);

  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= period) {
      sum -= closes[i - period]!;
    }
    if (i >= period - 1) {
      result[i] = sum / period;
    }
  }
  return result;
}

/**
 * Media móvil exponencial del cierre, sembrada en el índice `period - 1`
 * con la media simple de las `period` primeras velas y k = 2 / (period + 1).
 */
export function ema(candles: readonly PricedCandle[], period: number): IndicatorSeries {
  assertPeriod(period, 'ema');
  const closes = closesOf(candles, 'ema');
  const result: IndicatorSeries = new Array<number | null>(closes.length).fill(null);
  if (closes.length < period) {
    return result;
  }

  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i]!;
  }
  let value = sum / period;
  result[period - 1] = value;
  for (let i = period; i < closes.length; i++) {
    value = closes[i]! * k + value * (1 - k);
    result[i] = value;
  }
  return result;
}

/**
 * RSI de Wilder del cierre (por defecto 14). Necesita `period` cambios de
 * precio, así que el primer valor cae en el índice `period`.
 *
 * Casos sin pérdidas: si la media de pérdidas es 0 el RSI es 100 (solo
 * subidas) o 50 (precios constantes: no hay fuerza en ninguna dirección).
 */
export function rsi(candles: readonly PricedCandle[], period = 14): IndicatorSeries {
  assertPeriod(period, 'rsi');
  const closes = closesOf(candles, 'rsi');
  const result: IndicatorSeries = new Array<number | null>(closes.length).fill(null);
  if (closes.length <= period) {
    return result;
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain += Math.max(change, 0);
    avgLoss += Math.max(-change, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return result;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Rango verdadero de cada vela: max(high - low, |high - cierre anterior|,
 * |low - cierre anterior|). En la primera vela, sin cierre anterior, se usa
 * high - low (convención de TradingView/pandas).
 */
export function trueRange(candles: readonly Candle[]): IndicatorSeries {
  const result: IndicatorSeries = new Array<number | null>(candles.length).fill(null);
  let prevClose: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]!;
    assertFiniteField(candle.high, 'high', i, 'trueRange');
    assertFiniteField(candle.low, 'low', i, 'trueRange');
    assertFiniteField(candle.close, 'close', i, 'trueRange');
    result[i] =
      prevClose === null
        ? candle.high - candle.low
        : Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - prevClose),
            Math.abs(candle.low - prevClose),
          );
    prevClose = candle.close;
  }
  return result;
}

/**
 * ATR de Wilder (por defecto 14): media simple de los `period` primeros
 * rangos verdaderos en el índice `period - 1` y suavizado de Wilder después.
 */
export function atr(candles: readonly Candle[], period = 14): IndicatorSeries {
  assertPeriod(period, 'atr');
  const tr = trueRange(candles);
  const result: IndicatorSeries = new Array<number | null>(candles.length).fill(null);
  if (candles.length < period) {
    return result;
  }

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += tr[i]!;
  }
  let value = sum / period;
  result[period - 1] = value;
  for (let i = period; i < candles.length; i++) {
    value = (value * (period - 1) + tr[i]!) / period;
    result[i] = value;
  }
  return result;
}
