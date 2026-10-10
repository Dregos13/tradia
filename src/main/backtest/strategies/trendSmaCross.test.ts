/**
 * Cruce de medias sobre series sintéticas donde la señal es evidente:
 * la serie plana seguida de una rampa produce un cruce al alza en una fecha
 * conocida (calculada con el oráculo `sma()` de shared/indicators), y la
 * bajada posterior produce el cruce de salida.
 */
import { describe, expect, it } from 'vitest';

import { atr, sma } from '../../../shared/indicators';
import { runBacktest } from '../engine';
import { createTrendSmaCrossStrategy, TREND_SMA_CROSS_SEED } from './trendSmaCross';
import { assertNoLookAhead, bar, NO_COSTS, seriesFromCloses, sessionDates } from './testKit';

// stopAtr holgado para que el stop dinámico no interfiera: estas pruebas
// verifican las salidas por señal (el stop se ejercita aparte).
const PARAMS = { fastPeriod: 3, slowPeriod: 8, atrPeriod: 4, stopAtr: 6 };
// targetR alto para que el objetivo no se ejercite en esta serie: lo que se
// prueba aquí es el stop dinámico.
const PARAMS_TIGHT_STOP = { ...PARAMS, stopAtr: 2, targetR: 20 };

/** Primer índice donde la media rápida cruza al alza (o a la baja) a la lenta. */
function crossIndex(closes: number[], direction: 'up' | 'down', from = 0): number {
  const candles = closes.map((close) => ({ close }));
  const fast = sma(candles, PARAMS.fastPeriod);
  const slow = sma(candles, PARAMS.slowPeriod);
  for (let i = Math.max(1, from); i < closes.length; i++) {
    const [pf, ps, f, s] = [
      fast[i - 1] ?? null,
      slow[i - 1] ?? null,
      fast[i] ?? null,
      slow[i] ?? null,
    ];
    if (pf === null || ps === null || f === null || s === null) continue;
    if (direction === 'up' && pf <= ps && f > s) return i;
    if (direction === 'down' && pf >= ps && f < s) return i;
  }
  return -1;
}

describe('cruce de medias (seguimiento de tendencia)', () => {
  // Plana 15 sesiones, sube con fuerza (cruce al alza), baja (cruce a la baja).
  const closes = [
    ...Array(15).fill(100),
    104, 108, 112, 116, 120, 124, 128,
    124, 120, 116, 112, 108, 104, 100, 96, 92,
  ] as number[];
  const dates = sessionDates(closes.length, '2024-01-02');
  const bars = seriesFromCloses(dates, closes);
  const crossUp = crossIndex(closes, 'up');
  const crossDown = crossIndex(closes, 'down', crossUp);

  it('compra tras el cruce al alza y vende tras el cruce a la baja', () => {
    expect(crossUp).toBeGreaterThan(PARAMS.slowPeriod - 1);
    expect(crossDown).toBeGreaterThan(crossUp);

    const result = runBacktest({
      strategy: createTrendSmaCrossStrategy(),
      params: PARAMS,
      bars: { AAA: bars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.signalDate).toBe(dates[crossUp]);
    expect(trade.entryDate).toBe(dates[crossUp + 1]);
    expect(trade.entryPrice).toBeCloseTo(closes[crossUp + 1]!, 8);
    expect(trade.exitDate).toBe(dates[crossDown + 1]);
    expect(trade.exitPrice).toBeCloseTo(closes[crossDown + 1]!, 8);
    expect(trade.exitReason).toBe('signal');
  });

  it('dimensiona por riesgo con el stop ATR de la señal', () => {
    const result = runBacktest({
      strategy: createTrendSmaCrossStrategy(),
      params: PARAMS,
      bars: { AAA: bars },
      initialCash: 10_000,
      riskPerTrade: 0.01,
      costs: NO_COSTS,
    });
    const trade = result.trades[0]!;

    // Stop de la señal: cierre del cruce − stopAtr × ATR(atrPeriod).
    const atrSeries = atr(bars, PARAMS.atrPeriod);
    const stop = closes[crossUp]! - PARAMS.stopAtr * atrSeries[crossUp]!;
    const expected = Math.floor((10_000 * 0.01) / (trade.entryPrice - stop));
    expect(trade.shares).toBe(expected);
  });

  it('el stop ATR dinámico saca la posición en un desplome intrabarra sin cruce', () => {
    // Sube hasta 140 con tendencia y luego una vela con un low muy profundo
    // pero cierre alto: sin cruce a la baja, tiene que salir el stop.
    const dipCloses = [
      ...Array(10).fill(100),
      104, 108, 112, 116, 120, 124, 128, 132, 136, 140,
    ] as number[];
    const dipDates = sessionDates(dipCloses.length + 2, '2024-02-01');
    const dipBars = [
      ...seriesFromCloses(dipDates.slice(0, dipCloses.length), dipCloses),
      bar(dipDates[dipCloses.length]!, 141, { open: 140, high: 142, low: 100 }),
      bar(dipDates[dipCloses.length + 1]!, 141),
    ];
    const dipIdx = dipCloses.length;

    const result = runBacktest({
      strategy: createTrendSmaCrossStrategy(),
      params: PARAMS_TIGHT_STOP,
      bars: { AAA: dipBars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitDate).toBe(dipDates[dipIdx]);
    // El stop dinámico del cierre anterior: max de (cierre − 2·ATR) hasta esa sesión.
    const atrSeries = atr(dipBars, PARAMS.atrPeriod);
    let expectedStop = -Infinity;
    const entrySignal = crossIndex(dipCloses, 'up');
    for (let i = entrySignal; i < dipIdx; i++) {
      expectedStop = Math.max(
        expectedStop,
        dipBars[i]!.close - PARAMS_TIGHT_STOP.stopAtr * atrSeries[i]!,
      );
    }
    expect(trade.exitPrice).toBeCloseTo(expectedStop, 8);
  });

  it('no opera si la serie arranca ya cruzada (sin cruce previo)', () => {
    // Tendencia alcista desde la primera vela: la media rápida ya está por
    // encima cuando la lenta tiene su primer valor — no hay cruce que comprar.
    const rising = sessionDates(30, '2024-03-01').map((date, i) => bar(date, 100 + i * 2));
    const result = runBacktest({
      strategy: createTrendSmaCrossStrategy(),
      params: PARAMS,
      bars: { AAA: rising },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades).toHaveLength(0);
  });

  it('pasa la prueba anti look-ahead del motor', () => {
    // Dientes de sierra con varios cruces antes y después del corte.
    const zigCloses: number[] = [];
    let price = 100;
    for (let cycle = 0; cycle < 8; cycle++) {
      for (let i = 0; i < 5; i++) zigCloses.push((price += 3));
      for (let i = 0; i < 5; i++) zigCloses.push((price -= 3));
    }
    const zigDates = sessionDates(zigCloses.length, '2024-01-02');
    const cut = zigDates[45]!;

    const { original } = assertNoLookAhead(
      createTrendSmaCrossStrategy,
      {
        bars: { AAA: seriesFromCloses(zigDates, zigCloses) },
        params: PARAMS,
        initialCash: 10_000,
        costs: NO_COSTS,
      },
      cut,
    );
    expect(original.trades.filter((t) => t.exitDate <= cut).length).toBeGreaterThan(0);
  });

  it('los parámetros de la ficha semilla son los valores por defecto de la estrategia', () => {
    expect(TREND_SMA_CROSS_SEED.parameters).toEqual({
      fastPeriod: 50,
      slowPeriod: 200,
      atrPeriod: 14,
      stopAtr: 3,
      targetR: 2.5,
    });
    // Y la estrategia acepta los parámetros de su ficha sin error.
    expect(() =>
      runBacktest({
        strategy: createTrendSmaCrossStrategy(),
        params: TREND_SMA_CROSS_SEED.parameters,
        bars: { AAA: seriesFromCloses(sessionDates(10), Array(10).fill(100)) },
      }),
    ).not.toThrow();
  });
});
