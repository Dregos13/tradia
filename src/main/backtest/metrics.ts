/**
 * Métricas de un backtest a partir de la curva de capital y las operaciones — Fase 2.
 *
 * Módulo puro sin dependencias de Electron, de Node ni del motor de
 * backtest: los tipos de entrada se definen aquí y cualquier productor
 * (motor real, estrategias, pruebas) solo tiene que entregar
 * `[{ date, equity }]` y `[{ pnl, entryDate, exitDate }]`.
 *
 * Contrato:
 * - `curve` va ordenada de antigua a reciente; una fecha fuera de orden
 *   lanza RangeError. Un `equity` no finito o una fecha no parseable
 *   lanzan TypeError.
 * - `trades` puede llegar en cualquier orden: para las rachas se ordena
 *   una copia por `exitDate` (y `entryDate` como desempate). Los `pnl`
 *   deben ser finitos o lanza TypeError.
 * - Una operación con `pnl === 0` no cuenta ni como ganadora ni como
 *   perdedora, pero sí rompe una racha perdedora.
 * - Convenciones de anualización: 252 días de mercado por año
 *   (configurable con `tradingDaysPerYear`). La rentabilidad anualizada
 *   compone con `periodos = puntos de capital - 1`; el Sharpe usa
 *   rendimientos diarios simples, desviación típica muestral (n-1) y la
 *   tasa libre de riesgo anual se reparte linealmente (rf / 252 al día).
 * - Valores indefinidos se devuelven como `null`, no como NaN: sin
 *   operaciones no hay factor de beneficio, tasa de acierto ni
 *   expectativa; con menos de dos rendimientos diarios no hay Sharpe;
 *   con varianza cero el Sharpe es `Infinity`, `-Infinity` o `null`
 *   según el signo del exceso de rendimiento medio.
 * - `profitFactor` es `Infinity` cuando hay ganancias y ninguna pérdida;
 *   `formatProfitFactor` lo muestra como «∞».
 */

/** Días de mercado por año usados al anualizar (Sharpe y rentabilidad). */
export const TRADING_DAYS_PER_YEAR = 252;

const MS_PER_DAY = 86_400_000;

/**
 * Desviación típica por debajo de la cual la varianza se considera cero:
 * ruido de coma flotante (rendimientos «constantes» calculados como
 * cocientes quedan a ~1e-17), muy por debajo de cualquier dispersión real.
 */
const ZERO_STD_EPSILON = 1e-12;

/** Punto de la curva de capital diaria. `date` es ISO 8601 («YYYY-MM-DD»). */
export interface EquityCurvePoint {
  date: string;
  equity: number;
}

/** Operación cerrada que entra en las métricas. `pnl` es el resultado neto. */
export interface MetricTrade {
  pnl: number;
  entryDate: string;
  exitDate: string;
}

export interface MetricsOptions {
  /** Tasa libre de riesgo anual en tanto por uno (0,05 = 5 %). Por defecto 0. */
  riskFreeRate?: number;
  /** Días de mercado por año para anualizar. Por defecto 252. */
  tradingDaysPerYear?: number;
}

/** Episodio de drawdown máximo: caída desde el máximo anterior y su duración. */
export interface DrawdownEpisode {
  /** Caída en tanto por uno, positiva (0,010099 = 1,0099 %). */
  pct: number;
  /** Fecha del máximo desde el que cae la curva. */
  peakDate: string;
  /** Fecha del punto más bajo del episodio. */
  troughDate: string;
  /** Primera fecha en que el capital recupera el máximo; `null` si no recupera. */
  recoveryDate: string | null;
  /** Días de calendario desde `peakDate` hasta `recoveryDate` (o el final). */
  durationDays: number;
}

export interface BacktestMetrics {
  /** Rentabilidad total en tanto por uno (0,0298 = 2,98 %). `null` sin curva. */
  totalReturn: number | null;
  /** Rentabilidad anualizada componiendo a `tradingDaysPerYear`. */
  annualizedReturn: number | null;
  /** Episodio de drawdown máximo; `null` si la curva está vacía o nunca cae. */
  maxDrawdown: DrawdownEpisode | null;
  /** Sharpe anualizado; `null` si no está definido, ±Infinity con varianza 0. */
  sharpe: number | null;
  /** Beneficio bruto / pérdida bruta; `Infinity` sin pérdidas, `null` sin operaciones. */
  profitFactor: number | null;
  /** Operaciones ganadoras / total, en tanto por uno; `null` sin operaciones. */
  winRate: number | null;
  /** PnL medio por operación; `null` sin operaciones. */
  expectancy: number | null;
  /** Máximo de operaciones perdedoras consecutivas. */
  maxLosingStreak: number;
  tradeCount: number;
  winningTrades: number;
  losingTrades: number;
  grossProfit: number;
  /** Magnitud positiva de la pérdida bruta. */
  grossLoss: number;
}

function assertFinite(value: number, what: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`metrics: '${what}' no es un número finito (${String(value)})`);
  }
}

function assertDate(value: string, what: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`metrics: '${what}' no es una fecha parseable (${String(value)})`);
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

/** Desviación típica muestral (divisor n-1). */
function sampleStd(values: readonly number[], avg: number): number {
  const variance = values.reduce((acc, v) => acc + (v - avg) * (v - avg), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);
}

/**
 * Métricas completas de un backtest. La curva y las operaciones se tratan
 * de forma independiente: los rendimientos diarios salen solo de la curva
 * y las rachas/factor de beneficio solo de las operaciones.
 */
export function computeMetrics(
  curve: readonly EquityCurvePoint[],
  trades: readonly MetricTrade[],
  options: MetricsOptions = {},
): BacktestMetrics {
  const riskFreeRate = options.riskFreeRate ?? 0;
  const tradingDays = options.tradingDaysPerYear ?? TRADING_DAYS_PER_YEAR;
  assertFinite(riskFreeRate, 'riskFreeRate');
  if (!Number.isInteger(tradingDays) || tradingDays < 1) {
    throw new RangeError(
      `metrics: 'tradingDaysPerYear' debe ser un entero >= 1 (recibido ${tradingDays})`,
    );
  }

  let previousDate: string | null = null;
  for (const [index, point] of curve.entries()) {
    assertDate(point.date, `date del punto ${index}`);
    assertFinite(point.equity, `equity del punto ${index}`);
    if (previousDate !== null && Date.parse(point.date) < Date.parse(previousDate)) {
      throw new RangeError(
        `metrics: la curva de capital no está ordenada ('${previousDate}' antes que '${point.date}')`,
      );
    }
    previousDate = point.date;
  }
  for (const [index, trade] of trades.entries()) {
    assertFinite(trade.pnl, `pnl de la operación ${index}`);
    assertDate(trade.entryDate, `entryDate de la operación ${index}`);
    assertDate(trade.exitDate, `exitDate de la operación ${index}`);
  }

  return {
    ...equityMetrics(curve, riskFreeRate, tradingDays),
    ...tradeMetrics(trades),
  };
}

function equityMetrics(
  curve: readonly EquityCurvePoint[],
  riskFreeRate: number,
  tradingDays: number,
): Pick<BacktestMetrics, 'totalReturn' | 'annualizedReturn' | 'maxDrawdown' | 'sharpe'> {
  if (curve.length === 0) {
    return { totalReturn: null, annualizedReturn: null, maxDrawdown: null, sharpe: null };
  }

  const first = curve[0]!.equity;
  const last = curve.at(-1)!.equity;
  const totalReturn = first > 0 ? last / first - 1 : null;
  const periods = curve.length - 1;
  const annualizedReturn =
    first > 0 && last > 0 && periods > 0 ? Math.pow(last / first, tradingDays / periods) - 1 : null;

  // Rendimientos diarios simples. Si el capital anterior no es positivo el
  // rendimiento no está definido y se omite (p. ej. cuenta arruinada).
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1]!.equity;
    if (prev > 0) {
      returns.push(curve[i]!.equity / prev - 1);
    }
  }

  let sharpe: number | null = null;
  if (returns.length >= 2) {
    const riskFreeDaily = riskFreeRate / tradingDays;
    const excess = returns.map((r) => r - riskFreeDaily);
    const avg = mean(excess);
    const std = sampleStd(returns, mean(returns));
    // Varianza (efectivamente) cero: el cociente no existe. Se informa con
    // el signo del exceso medio (rendimiento constante ⇒ Sharpe infinito
    // del mismo signo).
    sharpe =
      std < ZERO_STD_EPSILON
        ? avg > 0
          ? Infinity
          : avg < 0
            ? -Infinity
            : null
        : (avg / std) * Math.sqrt(tradingDays);
  }

  return {
    totalReturn,
    annualizedReturn,
    maxDrawdown: maxDrawdown(curve),
    sharpe,
  };
}

function maxDrawdown(curve: readonly EquityCurvePoint[]): DrawdownEpisode | null {
  let peak = curve[0]!.equity;
  let peakIndex = 0;
  let best: { pct: number; peakIndex: number; troughIndex: number } | null = null;

  for (let i = 0; i < curve.length; i++) {
    const equity = curve[i]!.equity;
    if (equity >= peak) {
      peak = equity;
      peakIndex = i;
      continue;
    }
    // Con un máximo no positivo el ratio deja de tener sentido: cuenta ya
    // ruina total (100 %).
    const pct = peak > 0 ? (peak - equity) / peak : 1;
    if (best === null || pct > best.pct) {
      best = { pct, peakIndex, troughIndex: i };
    }
  }
  if (best === null) {
    return null; // curva plana o solo creciente: sin drawdown
  }

  const peakDate = curve[best.peakIndex]!.date;
  const troughDate = curve[best.troughIndex]!.date;
  const peakEquity = curve[best.peakIndex]!.equity;

  // Recuperación: primer punto posterior al mínimo que alcanza de nuevo el
  // máximo del episodio. Si no llega, la duración corre hasta el final.
  let recoveryDate: string | null = null;
  for (let i = best.troughIndex + 1; i < curve.length; i++) {
    if (curve[i]!.equity >= peakEquity) {
      recoveryDate = curve[i]!.date;
      break;
    }
  }
  const endDate = recoveryDate ?? curve.at(-1)!.date;

  return {
    pct: best.pct,
    peakDate,
    troughDate,
    recoveryDate,
    durationDays: daysBetween(peakDate, endDate),
  };
}

function tradeMetrics(
  trades: readonly MetricTrade[],
): Pick<
  BacktestMetrics,
  | 'profitFactor'
  | 'winRate'
  | 'expectancy'
  | 'maxLosingStreak'
  | 'tradeCount'
  | 'winningTrades'
  | 'losingTrades'
  | 'grossProfit'
  | 'grossLoss'
> {
  const ordered = [...trades].sort(
    (a, b) =>
      Date.parse(a.exitDate) - Date.parse(b.exitDate) ||
      Date.parse(a.entryDate) - Date.parse(b.entryDate),
  );

  let winningTrades = 0;
  let losingTrades = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let streak = 0;
  let maxLosingStreak = 0;

  for (const trade of ordered) {
    if (trade.pnl > 0) {
      winningTrades += 1;
      grossProfit += trade.pnl;
      streak = 0;
    } else if (trade.pnl < 0) {
      losingTrades += 1;
      grossLoss -= trade.pnl;
      streak += 1;
      if (streak > maxLosingStreak) {
        maxLosingStreak = streak;
      }
    } else {
      streak = 0;
    }
  }

  const tradeCount = trades.length;
  const profitFactor =
    tradeCount === 0 || (grossLoss === 0 && grossProfit === 0)
      ? null
      : grossLoss === 0
        ? Infinity
        : grossProfit / grossLoss;

  return {
    profitFactor,
    winRate: tradeCount === 0 ? null : winningTrades / tradeCount,
    expectancy: tradeCount === 0 ? null : (grossProfit - grossLoss) / tradeCount,
    maxLosingStreak,
    tradeCount,
    winningTrades,
    losingTrades,
    grossProfit,
    grossLoss,
  };
}

/** Factor de beneficio para mostrar: «∞» sin pérdidas, «—» si no existe. */
export function formatProfitFactor(profitFactor: number | null): string {
  if (profitFactor === null) {
    return '—';
  }
  if (!Number.isFinite(profitFactor)) {
    return '∞';
  }
  return profitFactor.toFixed(2);
}
