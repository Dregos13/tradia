/**
 * Divisas en el backtest: coste propio por activo (deslizamiento fijo de
 * 2 pb, sin comisión), anualización con las sesiones 24/5 y calentamiento
 * sobre el calendario del universo.
 */
import { describe, expect, it } from 'vitest';

import { FX_BACKTEST_COSTS } from '../../shared/fxTrading';
import { fxAssetCalendar } from '../market/assetCalendar';
import { annualizationFor, annualizationForMarkets } from './annualization';
import { runBacktest } from './engine';
import { computeMetrics } from './metrics';
import { warmupStartDate } from './stress';
import {
  DEFAULT_COSTS,
  DEFAULT_FX_COSTS,
  type EngineBar,
  type Strategy,
  type StrategyContext,
} from './types';

const bar = (date: string, price: number, over: Partial<EngineBar> = {}): EngineBar => ({
  date,
  open: price,
  high: price,
  low: price,
  close: price,
  ...over,
});

const scripted = (steps: Record<number, (ctx: StrategyContext) => void>): Strategy => ({
  init: () => {},
  onBar: (ctx) => {
    steps[ctx.index]?.(ctx);
  },
});

/** Semana de divisas con el 4 de julio (festivo de NYSE) dentro. */
const FX_DAYS = ['2025-07-02', '2025-07-03', '2025-07-04', '2025-07-07', '2025-07-08'];

describe('backtest · coste de divisas', () => {
  it('el coste de divisas es el documentado: 2 pb fijos, sin comisión ni spread', () => {
    expect(FX_BACKTEST_COSTS).toEqual({
      commissionPct: 0,
      commissionMin: 0,
      slippageBps: 2,
      spreadBps: 0,
    });
    expect(DEFAULT_FX_COSTS).toEqual({
      commissionPct: 0,
      commissionMin: 0,
      slippageBp: 2,
      spreadBp: 0,
    });
  });

  it('un largo en EURUSD paga 2 pb por ejecución y ninguna comisión', () => {
    const result = runBacktest({
      strategy: scripted({ 0: (ctx) => ctx.buy('EURUSD', { stop: 1.04, target: 1.12 }) }),
      bars: {
        EURUSD: [
          bar(FX_DAYS[0]!, 1.08),
          bar(FX_DAYS[1]!, 1.08), // entrada a la apertura
          bar(FX_DAYS[2]!, 1.1, { high: 1.13, low: 1.09, close: 1.11 }), // objetivo, en el festivo
          bar(FX_DAYS[3]!, 1.1),
        ],
      },
      initialCash: 100_000,
      // Costes de acciones exagerados: no deben tocar al par.
      costs: { commissionPct: 0.01, commissionMin: 5, slippageBp: 50, spreadBp: 50 },
    });

    const trade = result.trades[0]!;
    expect(trade.ticker).toBe('EURUSD');
    expect(trade.entryPrice).toBeCloseTo(1.08 * 1.0002, 10);
    expect(trade.exitReason).toBe('target');
    expect(trade.exitDate).toBe('2025-07-04');
    expect(trade.exitPrice).toBeCloseTo(1.12 * 0.9998, 10);
    expect(trade.commission).toBe(0);
    expect(trade.pnl).toBeCloseTo((trade.exitPrice - trade.entryPrice) * trade.shares, 6);
    // Tamaño por riesgo (1 % de 100 000) en unidades enteras de euros.
    expect(trade.shares).toBe(Math.floor(1_000 / (1.08 * 1.0002 - 1.04)));
  });

  it('un corto en EURUSD también paga 2 pb en contra a la entrada y a la salida', () => {
    const result = runBacktest({
      strategy: scripted({ 0: (ctx) => ctx.short('EURUSD', { stop: 1.12, target: 1.04 }) }),
      bars: {
        EURUSD: [
          bar(FX_DAYS[0]!, 1.08),
          bar(FX_DAYS[1]!, 1.08),
          bar(FX_DAYS[2]!, 1.06, { high: 1.065, low: 1.03, close: 1.04 }),
          bar(FX_DAYS[3]!, 1.04),
        ],
      },
      initialCash: 100_000,
    });

    const trade = result.trades[0]!;
    expect(trade.side).toBe('corto');
    expect(trade.entryPrice).toBeCloseTo(1.08 * 0.9998, 10);
    expect(trade.exitPrice).toBeCloseTo(1.04 * 1.0002, 10);
    expect(trade.commission).toBe(0);
    expect(trade.pnl).toBeGreaterThan(0);
  });

  it('en un universo mixto cada activo paga su coste', () => {
    const result = runBacktest({
      strategy: scripted({
        0: (ctx) => {
          ctx.buy('EURUSD', { stop: 1.04, target: 1.12 });
          ctx.buy('AAA', { stop: 90, target: 120 });
        },
      }),
      bars: {
        EURUSD: [
          bar(FX_DAYS[0]!, 1.08),
          bar(FX_DAYS[1]!, 1.08),
          bar(FX_DAYS[2]!, 1.1, { high: 1.13 }),
        ],
        AAA: [bar(FX_DAYS[0]!, 100), bar(FX_DAYS[1]!, 100), bar('2025-07-07', 110, { high: 125 })],
      },
      initialCash: 100_000,
    });

    const fx = result.trades.find((t) => t.ticker === 'EURUSD')!;
    const equity = result.trades.find((t) => t.ticker === 'AAA')!;
    expect(fx.commission).toBe(0);
    expect(fx.entryPrice).toBeCloseTo(1.08 * 1.0002, 10);
    const equityCost = (DEFAULT_COSTS.slippageBp + DEFAULT_COSTS.spreadBp) / 10_000;
    expect(equity.entryPrice).toBeCloseTo(100 * (1 + equityCost), 10);
    expect(equity.commission).toBeGreaterThan(0);
  });

  it('los costes de divisas se pueden fijar por ejecución (`fxCosts`)', () => {
    const result = runBacktest({
      strategy: scripted({ 0: (ctx) => ctx.buy('EURUSD', { stop: 1.04, target: 1.12 }) }),
      bars: {
        EURUSD: [bar(FX_DAYS[0]!, 1.08), bar(FX_DAYS[1]!, 1.08), bar(FX_DAYS[2]!, 1.13)],
      },
      initialCash: 100_000,
      fxCosts: { slippageBp: 0 },
    });
    expect(result.trades[0]!.entryPrice).toBeCloseTo(1.08, 10);
    expect(() =>
      runBacktest({
        strategy: scripted({}),
        bars: { EURUSD: [bar(FX_DAYS[0]!, 1.08)] },
        fxCosts: { slippageBp: -1 },
      }),
    ).toThrow(/fxCosts\.slippageBp/);
  });
});

describe('backtest · anualización por calendario', () => {
  it('un universo con pares anualiza con 260 sesiones; uno de acciones con 252', () => {
    expect(annualizationForMarkets(['EURUSD'])).toEqual({ tradingDaysPerYear: 260 });
    expect(annualizationForMarkets(['SPY', 'EURUSD'])).toEqual({ tradingDaysPerYear: 260 });
    expect(annualizationForMarkets(['SPY'])).toEqual({ tradingDaysPerYear: 252 });
    expect(annualizationFor({ bars: { GBPUSD: [] } })).toEqual({ tradingDaysPerYear: 260 });
    // El universo operable manda sobre las velas de referencia (SPY del régimen).
    expect(
      annualizationFor({ bars: { SPY: [], EURUSD: [] }, universe: [{ ticker: 'SPY' }] }),
    ).toEqual({ tradingDaysPerYear: 252 });
  });

  it('el Sharpe y la rentabilidad anualizada cambian con las sesiones por año', () => {
    const curve = [100, 101, 100.5, 102, 101.5, 103].map((equity, i) => ({
      date: `2025-07-${String(i + 1).padStart(2, '0')}`,
      equity,
    }));
    const fx = computeMetrics(curve, [], annualizationForMarkets(['EURUSD']));
    const nyse = computeMetrics(curve, [], annualizationForMarkets(['SPY']));
    const explicit = computeMetrics(curve, [], { tradingDaysPerYear: 260 });
    expect(fx.sharpe).toBeCloseTo(explicit.sharpe!, 10);
    expect(fx.sharpe! / nyse.sharpe!).toBeCloseTo(Math.sqrt(260 / 252), 10);
    expect(fx.annualizedReturn!).toBeGreaterThan(nyse.annualizedReturn!);
  });
});

describe('backtest · calentamiento sobre el calendario del universo', () => {
  it('con el 24/5 el festivo de NYSE cuenta como sesión de calentamiento', () => {
    // Una sesión antes del lunes 7: el viernes 4 en divisas, el jueves 3 en NYSE.
    expect(warmupStartDate('2025-07-07', 1, fxAssetCalendar.isSessionDay)).toBe('2025-07-04');
    expect(warmupStartDate('2025-07-07', 1)).toBe('2025-07-03');
  });
});
