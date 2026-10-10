/**
 * Las 16 variables del modelo predictivo — espejo TypeScript de
 * `ml/features.py` (contrato en `ml/FEATURES.md`).
 *
 * Toda la matemática sale de `src/shared/indicators.ts` (SMA, EMA
 * sembrada con SMA, RSI y ATR de Wilder), que es lo que el pipeline de
 * Python replica una a una: las mismas entradas producen los mismos
 * valores dentro de la tolerancia de paridad (1e-6, comprobada con
 * `resources/models/<version>/parity-fixture.json`).
 *
 * Reglas del contrato:
 *
 * - La entrada es la serie ajustada completa del activo, ordenada de
 *   antigua a reciente. RSI, ATR y EMA se siembran al inicio y arrastran
 *   estado: recortar la historia cambia los valores.
 * - La sesión `t` solo usa velas con índice `<= t` (sin look-ahead).
 * - Todas las variables están definidas a partir de `t = 49` (la más
 *   exigente es `sma_ratio_50`); antes, la fila es `null`.
 */
import {
  atr,
  ema,
  rsi,
  sma,
  type Candle,
  type IndicatorSeries,
} from '../../../shared/indicators';

/** Vela diaria ajustada que necesitan las variables (OHLCV + sesión). */
export interface PredictionCandle extends Candle {
  /** Sesión 'YYYY-MM-DD'. */
  date: string;
  volume: number;
}

/**
 * Orden exacto de las columnas del tensor de entrada `input` [N, 16] de
 * `model.onnx` y `vol.onnx`. Debe coincidir con `pipeline.json` →
 * `featureNames` (el cargador lo verifica) y con `FEATURE_NAMES` de ml/.
 */
export const FEATURE_NAMES = [
  'ret_1',
  'ret_5',
  'ret_10',
  'ret_21',
  'sma_ratio_10',
  'sma_ratio_20',
  'sma_ratio_50',
  'ema_ratio_12_26',
  'rsi_14',
  'atr_14_pct',
  'vol_5',
  'vol_20',
  'range_pct',
  'close_pos',
  'gap_pct',
  'vol_rel_20',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export const FEATURE_COUNT = FEATURE_NAMES.length;

/** Primera sesión con las 16 variables definidas (`sma_ratio_50`). */
export const FIRST_FEATURE_INDEX = 49;

/** Series de indicadores sobre la historia completa del activo. */
export interface FeatureSeries {
  closes: number[];
  /** Retorno diario `r_i = c_i / c_{i-1} - 1`; null en el índice 0. */
  returns: (number | null)[];
  sma10: IndicatorSeries;
  sma20: IndicatorSeries;
  sma50: IndicatorSeries;
  ema12: IndicatorSeries;
  ema26: IndicatorSeries;
  rsi14: IndicatorSeries;
  atr14: IndicatorSeries;
  smaVol20: IndicatorSeries;
}

/**
 * Precalcula todos los indicadores sobre la historia completa. Nunca
 * recortar la serie: las semillas de EMA/RSI/ATR arrastran estado.
 */
export function precomputeFeatures(candles: readonly PredictionCandle[]): FeatureSeries {
  const closes = candles.map((candle) => candle.close);
  const returns: (number | null)[] = [null];
  for (let i = 1; i < closes.length; i++) {
    returns.push(closes[i]! / closes[i - 1]! - 1);
  }
  // `sma` lee el campo `close` de cada elemento: el volumen se presenta
  // con la misma forma para reutilizar el indicador compartido.
  const volumes = candles.map((candle) => ({ close: candle.volume }));
  return {
    closes,
    returns,
    sma10: sma(candles, 10),
    sma20: sma(candles, 20),
    sma50: sma(candles, 50),
    ema12: ema(candles, 12),
    ema26: ema(candles, 26),
    rsi14: rsi(candles, 14),
    atr14: atr(candles, 14),
    smaVol20: sma(volumes, 20),
  };
}

/** Desviación típica poblacional (ddof = 0), como `pstdev` de ml/. */
function pstdev(values: readonly number[]): number {
  const n = values.length;
  const mean = values.reduce((acc, value) => acc + value, 0) / n;
  const variance = values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

/** Retorno a `lag` sesiones; null si la ventana sale de la serie o divide por 0. */
function ret(closes: readonly number[], t: number, lag: number): number | null {
  const base = t - lag < 0 ? null : closes[t - lag];
  if (base === null || base === undefined || base === 0) return null;
  return closes[t]! / base - 1;
}

/**
 * Vector de las 16 variables de la sesión `t` (solo velas `0..t`), en el
 * orden exacto de `FEATURE_NAMES`. Null si alguna variable aún no está
 * definida o si un valor no es finito (una vela degenerada no llega al
 * modelo: la sesión se salta en lugar de servir NaN).
 */
export function featureRowAt(
  series: FeatureSeries,
  candles: readonly PredictionCandle[],
  t: number,
): number[] | null {
  const { closes } = series;
  const candle = candles[t];
  if (candle === undefined || t >= candles.length) return null;

  const ret1 = ret(closes, t, 1);
  const ret5 = ret(closes, t, 5);
  const ret10 = ret(closes, t, 10);
  const ret21 = ret(closes, t, 21);
  const sma10 = series.sma10[t];
  const sma20 = series.sma20[t];
  const sma50 = series.sma50[t];
  const ema12 = series.ema12[t];
  const ema26 = series.ema26[t];
  const rsi14 = series.rsi14[t];
  const atr14 = series.atr14[t];
  const smaVol20 = series.smaVol20[t];
  if (
    ret1 === null ||
    ret5 === null ||
    ret10 === null ||
    ret21 === null ||
    sma10 == null ||
    sma20 == null ||
    sma50 == null ||
    ema12 == null ||
    ema26 == null ||
    rsi14 == null ||
    atr14 == null ||
    smaVol20 == null
  ) {
    return null;
  }
  if (t < 20) return null; // vol_20 necesita 20 retornos

  const rets = series.returns.slice(t - 19, t + 1) as number[];
  const rets5 = rets.slice(-5);
  const span = candle.high - candle.low;

  const row: (number | null)[] = [
    ret1,
    ret5,
    ret10,
    ret21,
    candle.close / sma10 - 1,
    candle.close / sma20 - 1,
    candle.close / sma50 - 1,
    ema12 / ema26 - 1,
    rsi14,
    atr14 / candle.close,
    pstdev(rets5),
    pstdev(rets),
    span / candle.close,
    span > 0 ? (candle.close - candle.low) / span : 0.5,
    closes[t - 1] === 0 ? null : candle.open / closes[t - 1]! - 1,
    smaVol20 > 0 ? candle.volume / smaVol20 : 1.0,
  ];

  if (row.some((value) => value === null || !Number.isFinite(value))) return null;
  return row as number[];
}

/** La fila como objeto nombre → valor (depuración y pruebas de paridad). */
export function featureRowObjectAt(
  series: FeatureSeries,
  candles: readonly PredictionCandle[],
  t: number,
): Record<FeatureName, number> | null {
  const row = featureRowAt(series, candles, t);
  if (row === null) return null;
  const out = {} as Record<FeatureName, number>;
  FEATURE_NAMES.forEach((name, index) => {
    out[name] = row[index]!;
  });
  return out;
}
