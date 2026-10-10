/**
 * Reversión a la media RSI(2) sobre series sintéticas: una tendencia alcista
 * clara seguida de un desplome de dos sesiones deja RSI(2) en sobreventa
 * manteniendo el cierre sobre la media de tendencia — la entrada es evidente
 * y la fecha esperada se calcula con el oráculo `rsi()` de shared/indicators.
 */
import { describe, expect, it } from 'vitest';

import { rsi, sma } from '../../../shared/indicators';
import { collectLastBarOrders } from '../../signals/probe';
import { runBacktest } from '../engine';
import {
  createMeanReversionRsiStrategy,
  MEAN_REVERSION_RSI_DEFAULTS,
  MEAN_REVERSION_RSI_SEED,
} from './meanReversionRsi';
import { assertNoLookAhead, NO_COSTS, seriesFromCloses, sessionDates } from './testKit';

const PARAMS = { rsiPeriod: 2, oversold: 10, exitRsi: 70, trendPeriod: 20, atrPeriod: 4, stopAtr: 2 };

/** Primer índice con rsi ≤ oversold y cierre sobre la media de tendencia. */
function entryIndex(closes: number[]): number {
  const candles = closes.map((close) => ({ close }));
  const rsiSeries = rsi(candles, PARAMS.rsiPeriod);
  const trend = sma(candles, PARAMS.trendPeriod);
  for (let i = 0; i < closes.length; i++) {
    const r = rsiSeries[i] ?? null;
    const t = trend[i] ?? null;
    if (r !== null && t !== null && r <= PARAMS.oversold && closes[i]! > t) return i;
  }
  return -1;
}

/** Primer índice con rsi ≥ exitRsi a partir de `from`. */
function exitIndex(closes: number[], from: number): number {
  const candles = closes.map((close) => ({ close }));
  const rsiSeries = rsi(candles, PARAMS.rsiPeriod);
  for (let i = Math.max(0, from); i < closes.length; i++) {
    const r = rsiSeries[i] ?? null;
    if (r !== null && r >= PARAMS.exitRsi) return i;
  }
  return -1;
}

describe('reversión a la media RSI(2) con filtro de tendencia', () => {
  // Tendencia +3/sesión durante 25 sesiones (cierre holgadamente sobre la
  // SMA20), desplome de dos sesiones que deja RSI(2) ≤ 10 sin perder la
  // media, y rebote que devuelve el RSI por encima de 70.
  const closes = [
    ...Array.from({ length: 25 }, (_, i) => 100 + 3 * i),
    163, 154, // desplome
    163, 172, 181, // rebote
  ] as number[];
  const dates = sessionDates(closes.length, '2024-01-02');
  const bars = seriesFromCloses(dates, closes);
  const entry = entryIndex(closes);
  const exit = exitIndex(closes, entry);

  it('compra en la sobreventa con tendencia y vende al rebotar el RSI', () => {
    expect(entry).toBeGreaterThan(PARAMS.trendPeriod - 1);
    expect(exit).toBeGreaterThan(entry);

    const result = runBacktest({
      strategy: createMeanReversionRsiStrategy(),
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
    expect(trade.exitReason).toBe('signal');
    expect(trade.grossPnl).toBeGreaterThan(0);
  });

  it('el filtro de tendencia bloquea la sobreventa en un mercado bajista', () => {
    // Caída persistente: RSI(2) toca sobreventa una y otra vez pero el
    // cierre nunca está sobre su media de tendencia → no hay operaciones.
    const falling = seriesFromCloses(
      sessionDates(40, '2024-02-01'),
      Array.from({ length: 40 }, (_, i) => 200 - 2 * i),
    );
    const result = runBacktest({
      strategy: createMeanReversionRsiStrategy(),
      params: PARAMS,
      bars: { AAA: falling },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades).toHaveLength(0);
  });

  it('pasa la prueba anti look-ahead del motor', () => {
    // Dientes de sierra alcistas: tramos de subida con desplomes moderados
    // que dejan RSI(2) en sobreventa sin perder la media de tendencia.
    const zig: number[] = [];
    let price = 100;
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 10; i++) zig.push((price += 4));
      for (let i = 0; i < 3; i++) zig.push((price -= 6));
    }
    const zigDates = sessionDates(zig.length, '2024-01-02');
    const cut = zigDates[40]!;

    assertNoLookAhead(
      createMeanReversionRsiStrategy,
      {
        bars: { AAA: seriesFromCloses(zigDates, zig) },
        params: PARAMS,
        initialCash: 10_000,
        costs: NO_COSTS,
      },
      cut,
    );
  });

  it('la propuesta para el motor de señales lleva stop y objetivo con ratio ≥ 2', () => {
    // La entrada se decide en la vela del desplome: la sonda solo informa
    // de lo emitido en la última sesión, así que la serie se corta ahí.
    const orders = collectLastBarOrders({
      strategy: createMeanReversionRsiStrategy(),
      params: PARAMS,
      bars: { AAA: bars.slice(0, entry + 1) },
    });
    const buy = orders.find((order) => order.kind === 'buy');
    expect(buy).toBeDefined();
    expect(buy!.stop).not.toBeNull();
    expect(buy!.target).not.toBeNull();
    const risk = buy!.referencePrice - buy!.stop!;
    const reward = buy!.target! - buy!.referencePrice;
    expect(risk).toBeGreaterThan(0);
    expect(reward / risk).toBeCloseTo(MEAN_REVERSION_RSI_DEFAULTS.targetR, 8);
    expect(reward / risk).toBeGreaterThanOrEqual(2);
  });

  it('sin ATR caliente no propone entrada (una compra sin stop nunca pasa la pasarela)', () => {
    const orders = collectLastBarOrders({
      strategy: createMeanReversionRsiStrategy(),
      params: { ...PARAMS, atrPeriod: 100 },
      bars: { AAA: bars.slice(0, entry + 1) },
    });
    expect(orders).toEqual([]);
  });

  it('los parámetros de la ficha semilla son los valores por defecto', () => {
    expect(MEAN_REVERSION_RSI_SEED.parameters).toEqual({
      rsiPeriod: 2,
      oversold: 5,
      exitRsi: 70,
      trendPeriod: 200,
      atrPeriod: 14,
      stopAtr: 2.5,
      targetR: 2.5,
    });
    expect(() =>
      runBacktest({
        strategy: createMeanReversionRsiStrategy(),
        params: MEAN_REVERSION_RSI_SEED.parameters,
        bars: { AAA: seriesFromCloses(sessionDates(10), Array(10).fill(100)) },
      }),
    ).not.toThrow();
  });
});
