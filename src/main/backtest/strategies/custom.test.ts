/**
 * Estrategia propia compilada (`createCustomStrategy`): equivalencia con
 * el cruce de medias clásico sobre las mismas velas, semántica de los
 * niveles y del canal previo, límites de seguridad y ausencia de
 * mirada al futuro.
 */
import { describe, expect, it } from 'vitest';

import { sma } from '../../../shared/indicators';
import { parseStrategyRules } from '../../../shared/strategyRules';
import type { StrategyRules } from '../../../shared/strategy';
import { runBacktest } from '../engine';
import type { Trade } from '../types';
import { createCustomStrategy } from './custom';
import { createTrendSmaCrossStrategy, TREND_SMA_CROSS_DEFAULTS } from './trendSmaCross';
import { assertNoLookAhead, bar, NO_COSTS, seriesFromCloses, sessionDates } from './testKit';

/** Reglas del cruce de medias escrito como estrategia propia. */
const SMA_CROSS_RULES: StrategyRules = {
  entry: 'cruza_arriba(sma(rapida), sma(lenta))',
  exit: 'cruza_abajo(sma(rapida), sma(lenta))',
  stop: 'stopAtr * atr(atrPeriod)',
  target: 'targetR * stopAtr * atr(atrPeriod)',
};

function compile(rules: StrategyRules, parameters: Record<string, number>) {
  const result = parseStrategyRules(rules, parameters);
  if (!result.ok) {
    throw new Error(`las reglas no compilan: ${JSON.stringify(result.errors)}`);
  }
  return result.program;
}

/** Las operaciones deben coincidir: fechas, motivo y acciones exactas; precios a ~1e-8. */
function expectSameTrades(actual: Trade[], expected: Trade[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const [i, trade] of actual.entries()) {
    const other = expected[i]!;
    for (const field of [
      'ticker',
      'signalDate',
      'entryDate',
      'exitDate',
      'exitReason',
      'shares',
    ] as const) {
      expect(trade[field], `operación ${i} · ${field}`).toBe(other[field]);
    }
    for (const field of [
      'entryPrice',
      'exitPrice',
      'commission',
      'slippage',
      'grossPnl',
      'pnl',
    ] as const) {
      expect(trade[field], `operación ${i} · ${field}`).toBeCloseTo(other[field], 8);
    }
  }
}

/** Serie sintética con varios ciclos de tendencia para que haya cruces 50/200. */
function trendingCloses(count: number): number[] {
  const closes: number[] = [];
  for (let i = 0; i < count; i++) {
    const wave = 0.35 * Math.sin(i / 90) + 0.08 * Math.sin(i / 23);
    closes.push(Math.round(100 * Math.exp(wave + 0.0004 * i) * 100) / 100);
  }
  return closes;
}

describe('estrategia propia: equivalencia con el cruce de medias clásico', () => {
  const seed = TREND_SMA_CROSS_DEFAULTS;
  const params = {
    rapida: seed.fastPeriod,
    lenta: seed.slowPeriod,
    atrPeriod: seed.atrPeriod,
    stopAtr: seed.stopAtr,
    targetR: seed.targetR,
  };
  const classicParams = {
    fastPeriod: seed.fastPeriod,
    slowPeriod: seed.slowPeriod,
    atrPeriod: seed.atrPeriod,
    stopAtr: seed.stopAtr,
    targetR: seed.targetR,
  };
  const program = compile(SMA_CROSS_RULES, params);

  it('da las mismas operaciones que la clásica con los parámetros de la semilla', () => {
    const bars = seriesFromCloses(sessionDates(640, '2022-01-03'), trendingCloses(640));
    const classic = runBacktest({
      strategy: createTrendSmaCrossStrategy(),
      params: classicParams,
      bars: { AAA: bars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    const custom = runBacktest({
      strategy: createCustomStrategy(program, params),
      params,
      bars: { AAA: bars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    // La prueba solo es significativa si la clásica realmente operó.
    expect(classic.trades.length).toBeGreaterThan(0);
    expectSameTrades(custom.trades, classic.trades);
    expect(custom.equityCurve).toEqual(classic.equityCurve);
    expect(custom.finalEquity).toBeCloseTo(classic.finalEquity, 8);
  });

  it('da las mismas operaciones que la clásica con parámetros pequeños', () => {
    // La serie del test de la clásica: plana, rampa con cruce al alza y
    // bajada con cruce a la baja.
    const closes = [
      ...Array(15).fill(100),
      104,
      108,
      112,
      116,
      120,
      124,
      128,
      124,
      120,
      116,
      112,
      108,
      104,
      100,
      96,
      92,
    ] as number[];
    const small = { rapida: 3, lenta: 8, atrPeriod: 4, stopAtr: 6, targetR: 2.5 };
    const smallProgram = compile(SMA_CROSS_RULES, small);
    const bars = seriesFromCloses(sessionDates(closes.length, '2024-01-02'), closes);
    const classic = runBacktest({
      strategy: createTrendSmaCrossStrategy(),
      params: { fastPeriod: 3, slowPeriod: 8, atrPeriod: 4, stopAtr: 6, targetR: 2.5 },
      bars: { AAA: bars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    const custom = runBacktest({
      strategy: createCustomStrategy(smallProgram, small),
      params: small,
      bars: { AAA: bars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(classic.trades.length).toBeGreaterThan(0);
    expectSameTrades(custom.trades, classic.trades);
    expect(custom.equityCurve).toEqual(classic.equityCurve);
  });

  it('también reproduce el stop dinámico en un desplome intrabarra', () => {
    const dipCloses = [
      ...Array(10).fill(100),
      104,
      108,
      112,
      116,
      120,
      124,
      128,
      132,
      136,
      140,
    ] as number[];
    const dipDates = sessionDates(dipCloses.length + 2, '2024-02-01');
    const dipBars = [
      ...seriesFromCloses(dipDates.slice(0, dipCloses.length), dipCloses),
      bar(dipDates[dipCloses.length]!, 141, { open: 140, high: 142, low: 100 }),
      bar(dipDates[dipCloses.length + 1]!, 141),
    ];
    const tight = { rapida: 3, lenta: 8, atrPeriod: 4, stopAtr: 2, targetR: 20 };
    const tightProgram = compile(SMA_CROSS_RULES, tight);
    const classic = runBacktest({
      strategy: createTrendSmaCrossStrategy(),
      params: { fastPeriod: 3, slowPeriod: 8, atrPeriod: 4, stopAtr: 2, targetR: 20 },
      bars: { AAA: dipBars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    const custom = runBacktest({
      strategy: createCustomStrategy(tightProgram, tight),
      params: tight,
      bars: { AAA: dipBars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(classic.trades[0]!.exitReason).toBe('stop');
    expectSameTrades(custom.trades, classic.trades);
  });
});

describe('estrategia propia: semántica de los niveles y el canal', () => {
  it('«N%» fija el stop un N % bajo el cierre de la señal', () => {
    const program = compile(
      { entry: 'cruza_arriba(sma(3), sma(8))', exit: 'cierre < 90', stop: '5%', target: 'ninguno' },
      {},
    );
    const closes = [...Array(10).fill(100), 110, 115, 120, 125, 130];
    // Índice del cruce según el oráculo: stop = cierre de la señal × 0,95.
    const candles = closes.map((close) => ({ close }));
    const fast = sma(candles, 3);
    const slow = sma(candles, 8);
    let cross = -1;
    for (let i = 1; i < closes.length; i++) {
      const [pf, ps, f, s] = [fast[i - 1], slow[i - 1], fast[i], slow[i]];
      if (pf == null || ps == null || f == null || s == null) continue;
      if (pf <= ps && f > s) {
        cross = i;
        break;
      }
    }
    expect(cross).toBeGreaterThan(0);
    const stopPrice = closes[cross]! * 0.95;
    const dates = sessionDates(closes.length + 1, '2024-03-01');
    // Última vela: apertura por encima del stop, mínimo por debajo.
    const bars = [
      ...seriesFromCloses(dates.slice(0, closes.length), closes),
      bar(dates[closes.length]!, closes[cross]! * 0.97, {
        open: closes[cross]! * 0.98,
        low: stopPrice - 2,
      }),
    ];
    const result = runBacktest({
      strategy: createCustomStrategy(program, {}),
      bars: { AAA: bars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades.length).toBe(1);
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitPrice).toBeCloseTo(stopPrice, 6);
  });

  it('«K * atr(n)» de objetivo lo fija sobre el cierre de la señal', () => {
    const program = compile(
      {
        entry: 'cruza_arriba(sma(3), sma(8))',
        exit: 'cierre < 1',
        stop: '20 * atr(4)',
        target: '1 * atr(4)',
      },
      {},
    );
    const closes = [...Array(10).fill(100), 104, 108, 112, 116, 120, 124, 128, 132];
    const dates = sessionDates(closes.length, '2024-03-01');
    const bars = seriesFromCloses(dates, closes);
    const result = runBacktest({
      strategy: createCustomStrategy(program, {}),
      bars: { AAA: bars },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0]!.exitReason).toBe('target');
  });

  it('«ninguno» deja la posición sin stop y sale por señal o fin de datos', () => {
    const program = compile(
      {
        entry: 'cierre > maximo(2)',
        exit: 'cierre < minimo(2)',
        stop: 'ninguno',
        target: 'ninguno',
      },
      {},
    );
    const closes = [100, 100, 100, 105, 108, 104, 100, 98];
    const dates = sessionDates(closes.length, '2024-03-01');
    const result = runBacktest({
      strategy: createCustomStrategy(program, {}),
      bars: { AAA: seriesFromCloses(dates, closes) },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades.length).toBe(1);
    expect(result.trades[0]!.exitReason).toBe('signal');
  });

  it('maximo(n) y minimo(n) cuentan las n velas anteriores, sin la actual', () => {
    // Con el canal incluyendo la vela actual «cierre > maximo(3)» no se
    // cumpliría jamás (el cierre no supera su propio máximo).
    const program = compile(
      {
        entry: 'cierre > maximo(3)',
        exit: 'cierre < minimo(3)',
        stop: 'ninguno',
        target: 'ninguno',
      },
      {},
    );
    const closes = [...Array(6).fill(100), 103, 104, 105];
    const dates = sessionDates(closes.length, '2024-03-01');
    const result = runBacktest({
      strategy: createCustomStrategy(program, {}),
      bars: { AAA: seriesFromCloses(dates, closes) },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades.length).toBe(1);
    // La señal es en el cierre de la primera vela que rompe el canal.
    expect(result.trades[0]!.signalDate).toBe(dates[6]);
    expect(result.trades[0]!.entryDate).toBe(dates[7]);
  });

  it('sin ATR disponible no hay entrada (un nivel declarado incalculable descarta la señal)', () => {
    const program = compile(
      {
        entry: 'cierre > 1',
        exit: 'cierre < 1',
        stop: '2 * atr(500)',
        target: 'ninguno',
      },
      {},
    );
    const result = runBacktest({
      strategy: createCustomStrategy(program, {}),
      bars: { AAA: seriesFromCloses(sessionDates(30), Array(30).fill(100)) },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades).toHaveLength(0);
  });

  it('volumen sin dato hace falsa la comparación', () => {
    const program = compile(
      { entry: 'volumen > 0', exit: 'cierre < 1', stop: 'ninguno', target: 'ninguno' },
      {},
    );
    const result = runBacktest({
      strategy: createCustomStrategy(program, {}),
      bars: { AAA: seriesFromCloses(sessionDates(10), Array(10).fill(100)) },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(result.trades).toHaveLength(0);
  });
});

describe('estrategia propia: garantías', () => {
  const params = { rapida: 3, lenta: 8, atrPeriod: 4, stopAtr: 6, targetR: 2.5 };
  const program = compile(SMA_CROSS_RULES, params);

  it('pasa la prueba anti look-ahead del motor', () => {
    const zigCloses: number[] = [];
    let price = 100;
    for (let cycle = 0; cycle < 8; cycle++) {
      for (let i = 0; i < 5; i++) zigCloses.push((price += 3));
      for (let i = 0; i < 5; i++) zigCloses.push((price -= 3));
    }
    const zigDates = sessionDates(zigCloses.length, '2024-01-02');
    const { original } = assertNoLookAhead(
      () => createCustomStrategy(program, params),
      {
        bars: { AAA: seriesFromCloses(zigDates, zigCloses) },
        params,
        initialCash: 10_000,
        costs: NO_COSTS,
      },
      zigDates[45]!,
    );
    expect(original.trades.filter((t) => t.exitDate <= zigDates[45]!).length).toBeGreaterThan(0);
  });

  it('init rechaza un periodo de parámetro fuera de rango', () => {
    expect(() => createCustomStrategy(program, params).init({ ...params, rapida: 0 })).toThrow(
      RangeError,
    );
    expect(() => createCustomStrategy(program, params).init({ ...params, rapida: 2.5 })).toThrow(
      RangeError,
    );
    expect(() => createCustomStrategy(program, params).init({ ...params, atrPeriod: 600 })).toThrow(
      RangeError,
    );
  });

  it('los parámetros desconocidos de la corrida se ignoran', () => {
    expect(() => createCustomStrategy(program, params).init({ ...params, otro: 1 })).not.toThrow();
  });
});
