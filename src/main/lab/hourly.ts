/**
 * Prueba histórica de una estrategia sobre velas de 1 hora.
 *
 * Una pasada del motor (sin look-ahead, órdenes en la apertura de la vela
 * siguiente) sobre 1 o 2 años de velas horarias del primer activo de la
 * ficha, con 200 velas de calentamiento. Devuelve lo que necesita alguien
 * que empieza: cuánto habría ganado o perdido, frente a comprar y esperar,
 * la peor caída y qué sesión le funciona mejor.
 */
import type { IntradayBar } from '../../shared/intraday';
import type { LabBacktestResult, LabSessionId, LabSessionStats } from '../../shared/lab';
import { EXCHANGE_SESSIONS, zonedParts } from '../../shared/sessions';
import { DEFAULT_STRATEGY_COSTS, type Strategy } from '../../shared/strategy';
import { runBacktest } from '../backtest/engine';
import { computeMetrics } from '../backtest/metrics';
import { costConfigFromAssumed } from '../backtest/stress';
import type { EngineBar, Strategy as EngineStrategy } from '../backtest/types';

const DAY = 86_400_000;
/** Velas de calentamiento para medias e indicadores. */
export const HOURLY_WARMUP_BARS = 200;
/** Velas de 1 hora en un año de divisas (24 h × 5 días × 52 semanas). */
export const HOURLY_BARS_PER_YEAR = 24 * 5 * 52;
const CURVE_POINTS = 240;

export function toEngineBars(bars: readonly IntradayBar[]): EngineBar[] {
  return bars.map((b) => ({
    date: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: 0,
  }));
}

/** Sesión en la que empieza una vela (prioridad Nueva York > Londres > Tokio). */
export function sessionOf(iso: string): LabSessionId {
  const ms = Date.parse(iso);
  for (const id of ['nueva-york', 'londres', 'tokio'] as const) {
    const s = EXCHANGE_SESSIONS.find((x) => x.id === id)!;
    const { weekday, minutes } = zonedParts(ms, s.timeZone);
    if (weekday !== 0 && weekday !== 6 && minutes >= s.openMin && minutes < s.closeMin) return id;
  }
  return 'fuera';
}

function sample<T>(values: readonly T[], n: number): T[] {
  if (values.length <= n) return [...values];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(values[Math.round((i * (values.length - 1)) / (n - 1))]!);
  return out;
}

export interface HourlyBacktestInput {
  strategy: Strategy;
  create: () => EngineStrategy;
  /** Velas de 1 hora del activo, ascendentes. */
  bars: readonly IntradayBar[];
  ticker: string;
  initialCash?: number;
  /** Días pedidos, para avisar si el proveedor dio menos. */
  requestedDays: number;
}

export function runHourlyBacktest(input: HourlyBacktestInput): LabBacktestResult {
  const initialCash = input.initialCash ?? 10_000;
  const bars = toEngineBars(input.bars);
  if (bars.length <= HOURLY_WARMUP_BARS + 24) {
    throw new Error(
      `Hacen falta más velas de 1 hora de ${input.ticker} para probar la estrategia (hay ${bars.length}).`,
    );
  }
  const startDate = bars[HOURLY_WARMUP_BARS]!.date;
  const costs = { ...DEFAULT_STRATEGY_COSTS, ...input.strategy.assumedCosts };
  const result = runBacktest({
    strategy: input.create(),
    params: input.strategy.parameters,
    bars: { [input.ticker]: bars },
    initialCash,
    costs: costConfigFromAssumed(costs),
    startDate,
  });
  const metrics = computeMetrics(result.equityCurve, result.trades, {
    tradingDaysPerYear: HOURLY_BARS_PER_YEAR,
  });

  // Comprar y esperar el mismo activo desde la primera vela operable.
  const first = bars[HOURLY_WARMUP_BARS]!.close;
  const closeAt = new Map(bars.map((b) => [b.date, b.close]));
  const curve = result.equityCurve.map((p) => ({
    date: p.date,
    equity: p.equity,
    benchmark: first > 0 ? (initialCash * (closeAt.get(p.date) ?? first)) / first : null,
  }));
  const last = bars[bars.length - 1]!;

  const bySession: LabSessionStats[] = (['tokio', 'londres', 'nueva-york', 'fuera'] as const).map(
    (session) => {
      const trades = result.trades.filter((t) => sessionOf(t.entryDate) === session);
      const wins = trades.filter((t) => t.pnl > 0).length;
      return {
        session,
        trades: trades.length,
        pnl: trades.reduce((sum, t) => sum + t.pnl, 0),
        winRate: trades.length > 0 ? wins / trades.length : null,
      };
    },
  );

  const warnings: string[] = [];
  const spanDays = (Date.parse(last.date) - Date.parse(startDate)) / DAY;
  if (spanDays < input.requestedDays * 0.8) {
    warnings.push(
      `El proveedor solo tenía ${Math.round(spanDays)} días de velas de 1 hora (pediste ${input.requestedDays}).`,
    );
  }
  if (result.trades.length < 30) {
    warnings.push(
      'Con menos de 30 operaciones el resultado puede ser suerte: déjala en prueba en vivo para confirmarlo.',
    );
  }

  const totalReturn = metrics.totalReturn ?? result.finalEquity / initialCash - 1;
  const annualizedReturn = Number.isFinite(metrics.annualizedReturn ?? NaN)
    ? metrics.annualizedReturn
    : null;
  const buyAndHold = first > 0 ? last.close / first - 1 : null;
  return {
    timeframe: '1h',
    ticker: input.ticker,
    desde: startDate,
    hasta: last.date,
    bars: bars.length - HOURLY_WARMUP_BARS,
    initialCash,
    totalReturn,
    annualizedReturn,
    maxDrawdown: metrics.maxDrawdown?.pct ?? 0,
    tradeCount: result.trades.length,
    winRate: metrics.winRate,
    buyAndHold,
    bySession,
    curve: sample(curve, CURVE_POINTS),
    warnings,
    summary: {
      totalReturnPct: totalReturn * 100,
      maxDrawdownPct: (metrics.maxDrawdown?.pct ?? 0) * 100,
      sharpe: metrics.sharpe,
      profitFactor: metrics.profitFactor,
      winRatePct: metrics.winRate === null ? null : metrics.winRate * 100,
      expectancy: metrics.expectancy,
      maxLosingStreak: metrics.maxLosingStreak,
      trades: result.trades.length,
      annualReturnPct: annualizedReturn === null ? null : annualizedReturn * 100,
      benchmarkReturnPct: buyAndHold === null ? null : buyAndHold * 100,
      timeframe: '1h',
      desde: startDate,
      hasta: last.date,
    },
  };
}
