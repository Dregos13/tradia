/**
 * Ruptura de rangos Donchian sobre series sintéticas: una serie plana
 * seguida de una vela que supera el máximo de las `entryPeriod` sesiones
 * anteriores produce la entrada, y el descenso que perfora el mínimo de
 * `exitPeriod` produce la salida. Las fechas esperadas se calculan con un
 * oráculo de canal independiente en la propia prueba.
 */
import { describe, expect, it } from 'vitest';

import { runBacktest } from '../engine';
import type { EngineBar } from '../types';
import {
  createDonchianBreakoutStrategy,
  DONCHIAN_BREAKOUT_SEED,
} from './donchianBreakout';
import { assertNoLookAhead, NO_COSTS, seriesFromCloses, sessionDates } from './testKit';

const PARAMS = { entryPeriod: 5, exitPeriod: 3, atrPeriod: 4, stopAtr: 2 };

/** Máximo high de las `period` velas anteriores a i (canal superior). */
function channelMax(bars: EngineBar[], i: number, period: number): number | null {
  if (i < period) return null;
  let upper = -Infinity;
  for (let j = i - period; j < i; j++) upper = Math.max(upper, bars[j]!.high);
  return upper;
}

/** Mínimo low de las `period` velas anteriores a i (canal inferior). */
function channelMin(bars: EngineBar[], i: number, period: number): number | null {
  if (i < period) return null;
  let lower = Infinity;
  for (let j = i - period; j < i; j++) lower = Math.min(lower, bars[j]!.low);
  return lower;
}

function firstBreakout(bars: EngineBar[], period: number): number {
  for (let i = 0; i < bars.length; i++) {
    const upper = channelMax(bars, i, period);
    if (upper !== null && bars[i]!.close > upper) return i;
  }
  return -1;
}

function firstBreakdown(bars: EngineBar[], period: number, from: number): number {
  for (let i = Math.max(0, from); i < bars.length; i++) {
    const lower = channelMin(bars, i, period);
    if (lower !== null && bars[i]!.close < lower) return i;
  }
  return -1;
}

describe('ruptura de rangos (canal de Donchian)', () => {
  // 8 sesiones planas, ruptura al alza, continuación y descenso que perfora
  // el canal inferior de salida.
  const closes = [
    100, 100, 100, 100, 100, 100, 100, 100,
    103, 104, 105, 106,
    103, 99, 96, 93,
  ] as number[];
  const dates = sessionDates(closes.length, '2024-01-02');
  const bars = seriesFromCloses(dates, closes);
  const entry = firstBreakout(bars, PARAMS.entryPeriod);
  const exit = firstBreakdown(bars, PARAMS.exitPeriod, entry);

  it('compra al superar el canal superior y vende al perforar el inferior', () => {
    expect(entry).toBe(8);
    expect(exit).toBeGreaterThan(entry);

    const result = runBacktest({
      strategy: createDonchianBreakoutStrategy(),
      params: PARAMS,
      bars: { AAA: bars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.signalDate).toBe(dates[entry]);
    expect(trade.entryDate).toBe(dates[entry + 1]);
    expect(trade.entryPrice).toBeCloseTo(closes[entry + 1]!, 8);
    expect(trade.exitDate).toBe(dates[exit + 1]);
    expect(trade.exitPrice).toBeCloseTo(closes[exit + 1]!, 8);
    expect(trade.exitReason).toBe('signal');
  });

  it('la vela de la ruptura no entra en su propio canal', () => {
    // Si el canal incluyera la vela actual, close > max(high) sería
    // imposible: aquí el máximo previo es 100.5 y el cierre 103 sí rompe.
    const upper = channelMax(bars, entry, PARAMS.entryPeriod);
    expect(upper).toBeCloseTo(100.5, 8);
    expect(bars[entry]!.close).toBeGreaterThan(upper!);
  });

  it('sin ruptura no hay operaciones', () => {
    const flat = seriesFromCloses(sessionDates(30, '2024-03-01'), Array(30).fill(100));
    const result = runBacktest({
      strategy: createDonchianBreakoutStrategy(),
      params: PARAMS,
      bars: { AAA: flat },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades).toHaveLength(0);
  });

  it('pasa la prueba anti look-ahead del motor', () => {
    // Sierras que rompen el canal en cada ciclo, antes y después del corte.
    const zig: number[] = [];
    let price = 100;
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 6; i++) zig.push((price += 3));
      for (let i = 0; i < 4; i++) zig.push((price -= 6));
    }
    const zigDates = sessionDates(zig.length, '2024-01-02');
    const cut = zigDates[35]!;

    const { original } = assertNoLookAhead(
      createDonchianBreakoutStrategy,
      {
        bars: { AAA: seriesFromCloses(zigDates, zig) },
        params: PARAMS,
        initialCash: 10_000,
        costs: NO_COSTS,
      },
      cut,
    );
    expect(original.trades.filter((t) => t.exitDate <= cut).length).toBeGreaterThan(0);
  });

  it('los parámetros de la ficha semilla son los valores por defecto', () => {
    expect(DONCHIAN_BREAKOUT_SEED.parameters).toEqual({
      entryPeriod: 55,
      exitPeriod: 20,
      atrPeriod: 20,
      stopAtr: 2,
      targetR: 2.5,
    });
    expect(() =>
      runBacktest({
        strategy: createDonchianBreakoutStrategy(),
        params: DONCHIAN_BREAKOUT_SEED.parameters,
        bars: { AAA: seriesFromCloses(sessionDates(10), Array(10).fill(100)) },
      }),
    ).not.toThrow();
  });
});
