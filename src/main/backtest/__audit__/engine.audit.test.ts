import { describe, expect, it } from 'vitest';

import { runBacktest } from '../engine';
import { CLASSIC_STRATEGIES } from '../strategies';
import type {
  BacktestInput,
  BuyOptions,
  EngineBar,
  Strategy,
  StrategyContext,
  Trade,
} from '../types';

const NO_COSTS = { commissionPct: 0, commissionMin: 0, slippageBp: 0, spreadBp: 0 };

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeDates(count: number): string[] {
  const dates: string[] = [];
  const day = new Date('2023-01-01T00:00:00Z');
  for (let index = 0; index < count; index++) {
    dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

function makeAuditBars(): Record<string, EngineBar[]> {
  const random = seededRandom(0x7a1d_2026);
  const dates = makeDates(420);
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD'];
  return Object.fromEntries(
    tickers.map((ticker, assetIndex) => {
      let previousClose = 80 + assetIndex * 23;
      const bars = dates.map((date, index) => {
        const open = previousClose * (1 + (random() - 0.5) * 0.006);
        const drift =
          0.002 * Math.sin(index / (7 + assetIndex) + assetIndex) +
          (assetIndex - 1.5) * 0.0007 +
          (random() - 0.5) * 0.012;
        const close = previousClose * Math.exp(drift);
        const high = Math.max(open, close) * 1.008;
        const low = Math.min(open, close) * 0.992;
        previousClose = close;
        return { date, open, high, low, close };
      });
      return [ticker, bars];
    }),
  );
}

interface StrategySignal {
  date: string;
  action: 'buy' | 'sell' | 'stop' | 'target';
  ticker: string;
  value?: BuyOptions | number;
}

function observedStrategy(
  definition: (typeof CLASSIC_STRATEGIES)[number],
  signals: StrategySignal[],
): Strategy {
  const strategy = definition.create();
  return {
    init: (params) => strategy.init(params),
    onBar: (context) => {
      const observed = new Proxy(context, {
        get(target, property) {
          if (property === 'buy') {
            return (ticker: string, options?: BuyOptions) => {
              signals.push({ date: target.date, action: 'buy', ticker, value: options });
              target.buy(ticker, options);
            };
          }
          if (property === 'sell') {
            return (ticker: string) => {
              signals.push({ date: target.date, action: 'sell', ticker });
              target.sell(ticker);
            };
          }
          if (property === 'setStop') {
            return (ticker: string, value: number) => {
              signals.push({ date: target.date, action: 'stop', ticker, value });
              target.setStop(ticker, value);
            };
          }
          if (property === 'setTarget') {
            return (ticker: string, value: number) => {
              signals.push({ date: target.date, action: 'target', ticker, value });
              target.setTarget(ticker, value);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as StrategyContext;
      strategy.onBar(observed);
    },
  };
}

function corruptAfter(
  bars: Record<string, readonly EngineBar[]>,
  cut: string,
): Record<string, EngineBar[]> {
  return Object.fromEntries(
    Object.entries(bars).map(([ticker, series], assetIndex) => [
      ticker,
      series.map((bar, index) => {
        if (bar.date <= cut) return bar;
        const close = (index + assetIndex) % 2 === 0 ? 35 + assetIndex * 11 : 190 + assetIndex * 17;
        return {
          ...bar,
          open: close * 0.997,
          high: close * 1.02,
          low: close * 0.98,
          close,
        };
      }),
    ]),
  );
}

function entryEvents(trades: Trade[], through: string) {
  return trades
    .filter((trade) => trade.entryDate <= through)
    .map(({ ticker, signalDate, entryDate, entryPrice, shares }) => ({
      ticker,
      signalDate,
      entryDate,
      entryPrice,
      shares,
    }))
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.ticker.localeCompare(b.ticker));
}

function exitEvents(trades: Trade[], through: string) {
  return trades
    .filter((trade) => trade.exitDate <= through)
    .map(({ ticker, entryDate, exitDate, exitPrice, exitReason, pnl }) => ({
      ticker,
      entryDate,
      exitDate,
      exitPrice,
      exitReason,
      pnl,
    }))
    .sort((a, b) => a.exitDate.localeCompare(b.exitDate) || a.ticker.localeCompare(b.ticker));
}

const PARAMS: Record<string, Record<string, number>> = {
  'sma-cross': { fastPeriod: 3, slowPeriod: 10, atrPeriod: 4, stopAtr: 3 },
  'rsi-mean-reversion': {
    rsiPeriod: 2,
    oversold: 45,
    exitRsi: 55,
    trendPeriod: 10,
    atrPeriod: 4,
    stopAtr: 3,
  },
  'donchian-breakout': { entryPeriod: 8, exitPeriod: 4, atrPeriod: 4, stopAtr: 3 },
  'cross-asset-momentum': { lookbackSessions: 8, topN: 1 },
};

describe('auditoría adversaria del motor de backtest', () => {
  it('no cambia señales ni operaciones anteriores a cortes aleatorios al alterar el futuro', () => {
    const bars = makeAuditBars();
    const random = seededRandom(0x51a5_2026);
    const eligibleDates = bars.AAA!.slice(50, -2).map((bar) => bar.date);
    const cuts = new Set<string>();
    while (cuts.size < 12) {
      cuts.add(eligibleDates[Math.floor(random() * eligibleDates.length)]!);
    }

    for (const definition of CLASSIC_STRATEGIES) {
      let totalSignals = 0;
      let totalEntries = 0;
      for (const cut of cuts) {
        const originalSignals: StrategySignal[] = [];
        const alteredSignals: StrategySignal[] = [];
        const config = {
          bars,
          params: PARAMS[definition.key],
          initialCash: 50_000,
          maxPositions: definition.key === 'cross-asset-momentum' ? 1 : 4,
          costs: NO_COSTS,
        } satisfies Omit<BacktestInput, 'strategy'>;
        const original = runBacktest({
          ...config,
          strategy: observedStrategy(definition, originalSignals),
        });
        const altered = runBacktest({
          ...config,
          bars: corruptAfter(bars, cut),
          strategy: observedStrategy(definition, alteredSignals),
        });

        expect(
          alteredSignals.filter((signal) => signal.date <= cut),
          `${definition.key} señales hasta ${cut}`,
        ).toEqual(originalSignals.filter((signal) => signal.date <= cut));
        expect(entryEvents(altered.trades, cut), `${definition.key} entradas hasta ${cut}`).toEqual(
          entryEvents(original.trades, cut),
        );
        expect(exitEvents(altered.trades, cut), `${definition.key} salidas hasta ${cut}`).toEqual(
          exitEvents(original.trades, cut),
        );
        totalSignals += originalSignals.filter((signal) => signal.date <= cut).length;
        totalEntries += entryEvents(original.trades, cut).length;
      }
      expect(totalSignals, `${definition.key} debe emitir señales observables`).toBeGreaterThan(0);
      expect(totalEntries, `${definition.key} debe producir entradas`).toBeGreaterThan(0);
    }
  });

  it.each([
    ['comisión', { commissionPct: 0.001, commissionMin: 0 }, { commissionPct: 0.01 }],
    ['slippage', { slippageBp: 10 }, { slippageBp: 100 }],
    ['spread', { spreadBp: 10 }, { spreadBp: 100 }],
  ])('aumentar la %s no mejora el resultado', (_name, moderate, high) => {
    const dates = makeDates(5);
    const bars = {
      AAA: [
        { date: dates[0]!, open: 100, high: 100, low: 100, close: 100 },
        { date: dates[1]!, open: 100, high: 100, low: 100, close: 100 },
        { date: dates[2]!, open: 100, high: 100, low: 100, close: 100 },
        { date: dates[3]!, open: 120, high: 120, low: 120, close: 120 },
        { date: dates[4]!, open: 120, high: 120, low: 120, close: 120 },
      ],
    };
    const run = (costs: BacktestInput['costs']) =>
      runBacktest({
        strategy: {
          init: () => {},
          onBar: (context) => {
            if (context.index === 0) context.buy('AAA');
            if (context.index === 2) context.sell('AAA');
          },
        },
        bars,
        initialCash: 10_000,
        maxPositions: 1,
        costs: { ...NO_COSTS, ...costs },
      });

    const free = run(NO_COSTS);
    const mid = run(moderate);
    const expensive = run({ ...moderate, ...high });
    expect(mid.finalEquity).toBeLessThanOrEqual(free.finalEquity);
    expect(expensive.finalEquity).toBeLessThanOrEqual(mid.finalEquity);
    expect(mid.trades[0]!.pnl).toBeLessThanOrEqual(free.trades[0]!.pnl);
    expect(expensive.trades[0]!.pnl).toBeLessThanOrEqual(mid.trades[0]!.pnl);
  });

  it('el coste cero y el coste positivo coinciden con el resultado sintético calculado a mano', () => {
    const bars = {
      AAA: [
        { date: '2024-01-02', open: 100, high: 100, low: 100, close: 100 },
        { date: '2024-01-03', open: 100, high: 100, low: 100, close: 100 },
        { date: '2024-01-04', open: 100, high: 100, low: 100, close: 100 },
        { date: '2024-01-05', open: 110, high: 110, low: 110, close: 110 },
        { date: '2024-01-08', open: 110, high: 110, low: 110, close: 110 },
      ],
    };
    const run = (costs: BacktestInput['costs']) =>
      runBacktest({
        strategy: {
          init: () => {},
          onBar: (context) => {
            if (context.index === 0) context.buy('AAA', { stop: 95 });
            if (context.index === 2) context.sell('AAA');
          },
        },
        bars,
        initialCash: 10_000,
        riskPerTrade: 0.01,
        costs,
      });
    const free = run(NO_COSTS);
    const positive = run({
      commissionPct: 0.001,
      commissionMin: 0,
      slippageBp: 10,
      spreadBp: 0,
    });

    expect(free.trades[0]!.shares).toBe(20);
    expect(free.trades[0]!.pnl).toBeCloseTo(200, 8);
    expect(free.finalEquity).toBeCloseTo(10_200, 8);
    expect(positive.trades[0]!.shares).toBe(19);
    expect(positive.trades[0]!.pnl).toBeCloseTo(182.02019, 6);
    expect(positive.finalEquity).toBeCloseTo(10_182.02019, 6);
    expect(positive.finalEquity).toBeLessThan(free.finalEquity);
  });

  it('ejecuta entradas y salidas por señal en la sesión posterior, nunca el día de señal', () => {
    const bars = {
      AAA: makeDates(4).map((date) => ({
        date,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
      })),
    };
    const result = runBacktest({
      strategy: {
        init: () => {},
        onBar: (context) => {
          if (context.index === 0) context.buy('AAA');
          if (context.index === 1) context.sell('AAA');
        },
      },
      bars,
      costs: NO_COSTS,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      signalDate: bars.AAA[0]!.date,
      entryDate: bars.AAA[1]!.date,
      exitDate: bars.AAA[2]!.date,
      exitReason: 'signal',
    });
    expect(result.trades[0]!.entryDate).not.toBe(result.trades[0]!.signalDate);
    expect(result.trades[0]!.exitDate).not.toBe(bars.AAA[1]!.date);
  });

  it('cierra al final de cotización un activo dado de baja a mitad de la serie', () => {
    const dates = makeDates(6);
    const seenTickers: Record<string, string[]> = {};
    const bars = {
      AAA: dates.slice(0, 3).map((date) => ({
        date,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
      })),
      BBB: dates.map((date) => ({
        date,
        open: 50,
        high: 50,
        low: 50,
        close: 50,
      })),
    };
    const result = runBacktest({
      strategy: {
        init: () => {},
        onBar: (context) => {
          seenTickers[context.date] = context.tickers();
          if (context.index === 0) context.buy('AAA');
          if (context.date >= dates[3]!) context.buy('AAA');
        },
      },
      bars,
      universe: [{ ticker: 'AAA', listedUntil: dates[2] }, { ticker: 'BBB' }],
      costs: NO_COSTS,
    });

    expect(result.trades.filter((trade) => trade.ticker === 'AAA')).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      ticker: 'AAA',
      entryDate: dates[1],
      exitDate: dates[2],
      exitReason: 'delisted',
    });
    expect(seenTickers[dates[3]!]).toEqual(['BBB']);
    expect(seenTickers[dates[5]!]).toEqual(['BBB']);
  });
});
