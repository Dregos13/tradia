/**
 * Utilidades compartidas de las pruebas de estrategias clásicas.
 *
 * No es una suite (no lleva `.test.ts`): la importan los `*.test.ts` de
 * esta carpeta para construir series sintéticas y ejecutar la prueba anti
 * look-ahead del motor con el mismo criterio que `engine.test.ts`.
 */
import { expect } from 'vitest';

import { runBacktest } from '../engine';
import type { BacktestInput, EngineBar, Strategy, Trade } from '../types';

/** Sin costes: el precio de ejecución es el de la vela. */
export const NO_COSTS = { commissionPct: 0, commissionMin: 0, slippageBp: 0, spreadBp: 0 };

/**
 * Vela sintética con rango simétrico `spread` alrededor del cierre (o de la
 * apertura si difiere) para que el ATR sea > 0 y los stops queden por debajo.
 */
export function bar(
  date: string,
  close: number,
  over: { open?: number; high?: number; low?: number; spread?: number } = {},
): EngineBar {
  const open = over.open ?? close;
  const spread = over.spread ?? 0.5;
  return {
    date,
    open,
    high: over.high ?? Math.max(open, close) + spread,
    low: over.low ?? Math.max(0.01, Math.min(open, close) - spread),
    close,
  };
}

/** Fechas consecutivas a partir de `start` (días naturales; el motor no exige laborables). */
export function sessionDates(count: number, start = '2024-01-01'): string[] {
  const dates: string[] = [];
  const day = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

/** Serie sintética a partir de una lista de cierres. */
export function seriesFromCloses(dates: string[], closes: number[]): EngineBar[] {
  if (dates.length !== closes.length) {
    throw new RangeError('seriesFromCloses: dates y closes deben tener la misma longitud');
  }
  return dates.map((date, i) => bar(date, closes[i]!));
}

/**
 * La prueba anti look-ahead del motor aplicada a cualquier estrategia:
 * corromper las velas posteriores a `cut` no puede cambiar la curva de
 * capital ni las operaciones (cerradas o abiertas) hasta `cut` inclusive.
 */
export function assertNoLookAhead(
  create: () => Strategy,
  input: Omit<BacktestInput, 'strategy'>,
  cut: string,
): { original: ReturnType<typeof runBacktest>; altered: ReturnType<typeof runBacktest> } {
  const original = runBacktest({ ...input, strategy: create() });

  const corrupted = Object.fromEntries(
    Object.entries(input.bars).map(([ticker, series]) => [
      ticker,
      series.map((b) =>
        b.date > cut ? { ...b, open: 99_999, high: 100_000, low: 99_998, close: 99_999 } : b,
      ),
    ]),
  );
  const altered = runBacktest({ ...input, bars: corrupted, strategy: create() });

  expect(altered.equityCurve.filter((p) => p.date <= cut)).toEqual(
    original.equityCurve.filter((p) => p.date <= cut),
  );
  expect(altered.trades.filter((t) => t.exitDate <= cut)).toEqual(
    original.trades.filter((t) => t.exitDate <= cut),
  );
  const openSide = (t: Trade) => ({
    ticker: t.ticker,
    signalDate: t.signalDate,
    entryDate: t.entryDate,
    entryPrice: t.entryPrice,
    shares: t.shares,
  });
  // El orden de `trades` refleja las salidas, que sí pueden cambiar tras el
  // corte: la comparación va por ticker.
  const byTicker = (a: { ticker: string }, b: { ticker: string }) =>
    a.ticker.localeCompare(b.ticker);
  expect(
    altered.trades
      .filter((t) => t.entryDate <= cut)
      .map(openSide)
      .sort(byTicker),
  ).toEqual(
    original.trades
      .filter((t) => t.entryDate <= cut)
      .map(openSide)
      .sort(byTicker),
  );
  return { original, altered };
}
