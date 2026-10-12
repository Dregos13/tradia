/**
 * Filtro de régimen del motor de backtest — Fase 6.
 *
 * Con `regimeFilter` el motor clasifica la referencia de mercado (SPY)
 * sesión a sesión, solo con las velas disponibles hasta ese cierre, y
 * descarta las compras de las sesiones en que la ficha queda desactivada
 * (misma regla que la página «IA»: failsIn tiene prioridad, worksIn no
 * vacío exige coincidencia). Las ventas y los stops nunca se bloquean.
 * Sin la opción el resultado es idéntico al de la fase 2 (regresión).
 */
import { describe, expect, it } from 'vitest';

import { createRegimeClassifier } from '../ai/regime/classifier';
import { runBacktest } from './engine';
import type { BacktestInput, EngineBar, Strategy, StrategyContext, Trade } from './types';

const NO_COSTS = { commissionPct: 0, commissionMin: 0, slippageBp: 0, spreadBp: 0 };

/** 440 sesiones laborables a partir del 2020-01-01. */
const DATES: string[] = (() => {
  const dates: string[] = [];
  const day = new Date('2020-01-01T00:00:00Z');
  while (dates.length < 440) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
})();

/** Serie a partir del rendimiento diario: open = cierre previo, wick 0,1 %. */
function seriesFromReturns(ret: (i: number) => number, wick = 0.001): EngineBar[] {
  const bars: EngineBar[] = [];
  let close = 100;
  for (let i = 0; i < DATES.length; i++) {
    const next = close * (1 + ret(i));
    const open = close;
    const high = Math.max(open, next) * (1 + wick);
    const low = Math.min(open, next) * (1 - wick);
    bars.push({ date: DATES[i]!, open, high, low, close: next });
    close = next;
  }
  return bars;
}

const LATERAL_END = 300;
const TREND_END = 380;

/**
 * Fixture que alterna regímenes en la referencia SPY:
 * - 0–299: seno ±3 % diario → 'lateral' (ADX ~11, siempre < 25).
 * - 300–379: deriva +0,45 % diaria → 'tendencia' desde ~306 (ADX sube).
 * - 380–439: seno de nuevo → 'tendencia' hasta que el ADX decae (~424)
 *   y 'lateral' otra vez al final.
 */
const SPY_BARS = seriesFromReturns((i) => {
  if (i < LATERAL_END) return 0.03 * Math.sin(i * 0.7);
  if (i < TREND_END) return 0.0045;
  return 0.03 * Math.sin(i * 0.7);
});

/** El activo operado sube siempre: la estrategia querría comprar en cualquier sesión. */
const AAA_BARS = seriesFromReturns(() => 0.003);

const classifier = createRegimeClassifier(SPY_BARS);
const indexOfDate = new Map(SPY_BARS.map((bar, i) => [bar.date, i]));
const directionAt = (date: string) => classifier.classifyAt(indexOfDate.get(date)!).direction;

/**
 * Estrategia de script: compra AAA en los índices ≡ 2 (mod 12) con un
 * stop holgado y vende en los ≡ 9 (mod 12). En el tramo final las compras
 * caen en sesiones 'lateral' y las ventas también — así se comprueba que
 * el filtro descarta entradas pero nunca salidas.
 */
const rotating = (): Strategy => ({
  init: () => {},
  onBar: (ctx: StrategyContext) => {
    if (ctx.index % 12 === 2) {
      ctx.buy('AAA', { stop: ctx.bars('AAA').last().close * 0.95 });
    }
    if (ctx.index % 12 === 9) ctx.sell('AAA');
  },
});

const baseInput = (): Omit<BacktestInput, 'strategy'> => ({
  bars: { AAA: AAA_BARS, SPY: SPY_BARS },
  universe: [{ ticker: 'AAA' }],
  initialCash: 10_000,
  costs: NO_COSTS,
});

const entryEvents = (trades: Trade[]) =>
  trades.map(({ ticker, signalDate, entryDate, entryPrice, shares }) => ({
    ticker,
    signalDate,
    entryDate,
    entryPrice,
    shares,
  }));

const exitEvents = (trades: Trade[]) =>
  trades.map(({ ticker, exitDate, exitPrice, exitReason, pnl }) => ({
    ticker,
    exitDate,
    exitPrice,
    exitReason,
    pnl,
  }));

describe('filtro de régimen: fixture que alterna regímenes', () => {
  const unfiltered = runBacktest({ ...baseInput(), strategy: rotating() });
  const filtered = runBacktest({
    ...baseInput(),
    strategy: rotating(),
    regimeFilter: { worksIn: ['tendencia'], failsIn: [] },
  });

  it('el fixture produce los tres tramos esperados (sanidad)', () => {
    expect(directionAt(SPY_BARS[100]!.date)).toBe('lateral');
    expect(directionAt(SPY_BARS[299]!.date)).toBe('lateral');
    expect(directionAt(SPY_BARS[330]!.date)).toBe('tendencia');
    expect(directionAt(SPY_BARS[379]!.date)).toBe('tendencia');
    expect(directionAt(SPY_BARS[439]!.date)).toBe('lateral');
  });

  it('sin filtro la estrategia compra también en sesiones laterales', () => {
    expect(unfiltered.trades.some((trade) => directionAt(trade.signalDate) === 'lateral')).toBe(
      true,
    );
    expect(unfiltered.trades.length).toBeGreaterThan(filtered.trades.length);
  });

  it('con el filtro no se abre ninguna operación en sesiones desactivadas', () => {
    expect(filtered.trades.length).toBeGreaterThan(0);
    for (const trade of filtered.trades) {
      expect(directionAt(trade.signalDate), `señal del ${trade.signalDate}`).toBe('tendencia');
    }
    // Toda entrada del filtrado existe también sin filtro, misma ejecución.
    const signalsWithout = new Map(unfiltered.trades.map((t) => [t.signalDate, t]));
    for (const trade of filtered.trades) {
      const twin = signalsWithout.get(trade.signalDate);
      expect(twin, `señal ${trade.signalDate} ausente sin filtro`).toBeDefined();
      expect(trade.entryDate).toBe(twin!.entryDate);
      expect(trade.entryPrice).toBe(twin!.entryPrice);
    }
    // Las compras del primer tramo 'lateral' desaparecen por completo.
    expect(filtered.trades.some((trade) => trade.signalDate <= SPY_BARS[299]!.date)).toBe(false);
  });

  it('las ventas no se bloquean: una posición abierta en tendencia cierra en lateral', () => {
    const closedInLateral = filtered.trades.filter(
      (trade) => trade.exitReason === 'signal' && directionAt(trade.exitDate) === 'lateral',
    );
    expect(closedInLateral.length).toBeGreaterThan(0);
  });

  it('con worksIn/failsIn vacíos el resultado es idéntico al de la fase 2', () => {
    const withEmptyFilter = runBacktest({
      ...baseInput(),
      strategy: rotating(),
      regimeFilter: { worksIn: [], failsIn: [] },
    });
    expect(withEmptyFilter.trades).toEqual(unfiltered.trades);
    expect(withEmptyFilter.equityCurve).toEqual(unfiltered.equityCurve);
    expect(withEmptyFilter.finalEquity).toBe(unfiltered.finalEquity);
  });

  it('failsIn tiene prioridad: declarada la tendencia como fallo no hay compras en tendencia', () => {
    const failsTrend = runBacktest({
      ...baseInput(),
      strategy: rotating(),
      regimeFilter: { worksIn: ['tendencia', 'lateral'], failsIn: ['tendencia'] },
    });
    expect(failsTrend.trades.length).toBeGreaterThan(0);
    for (const trade of failsTrend.trades) {
      expect(directionAt(trade.signalDate)).toBe('lateral');
    }
  });
});

describe('filtro de régimen: causalidad y validación', () => {
  const corruptAfter = (cutIndex: number): EngineBar[] =>
    SPY_BARS.map((bar, index) => {
      if (index <= cutIndex) return bar;
      const close = bar.close * 3;
      return { ...bar, open: close * 0.99, high: close * 1.02, low: close * 0.98, close };
    });

  it('alterar el futuro de la referencia no cambia entradas ni salidas anteriores al corte', () => {
    const cutIndex = 200;
    const cutDate = SPY_BARS[cutIndex]!.date;
    const config = {
      ...baseInput(),
      regimeFilter: { worksIn: ['tendencia'], failsIn: [] },
    } satisfies Omit<BacktestInput, 'strategy'>;
    const original = runBacktest({ ...config, strategy: rotating() });
    const altered = runBacktest({
      ...config,
      bars: { AAA: AAA_BARS, SPY: corruptAfter(cutIndex) },
      strategy: rotating(),
    });

    expect(entryEvents(altered.trades).filter((e) => e.entryDate <= cutDate)).toEqual(
      entryEvents(original.trades).filter((e) => e.entryDate <= cutDate),
    );
    expect(exitEvents(altered.trades).filter((e) => e.exitDate <= cutDate)).toEqual(
      exitEvents(original.trades).filter((e) => e.exitDate <= cutDate),
    );
    expect(altered.equityCurve.filter((p) => p.date <= cutDate)).toEqual(
      original.equityCurve.filter((p) => p.date <= cutDate),
    );
  });

  it('exige la serie de la referencia aunque el universo no la incluya', () => {
    expect(() =>
      runBacktest({
        bars: { AAA: AAA_BARS },
        universe: [{ ticker: 'AAA' }],
        strategy: rotating(),
        regimeFilter: { worksIn: ['tendencia'], failsIn: [] },
      }),
    ).toThrowError(/referencia 'SPY'/);
  });

  it('valida las etiquetas de worksIn/failsIn', () => {
    expect(() =>
      runBacktest({
        ...baseInput(),
        strategy: rotating(),
        regimeFilter: { worksIn: ['alcista' as never], failsIn: [] },
      }),
    ).toThrowError(RangeError);
    expect(() =>
      runBacktest({
        ...baseInput(),
        strategy: rotating(),
        regimeFilter: { worksIn: 'tendencia' as never, failsIn: [] },
      }),
    ).toThrowError(TypeError);
  });
});
