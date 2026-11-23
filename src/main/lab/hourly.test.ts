import { describe, expect, it } from 'vitest';

import { simulatedIntradayBars } from '../../shared/intraday';
import type { ForwardTest } from '../../shared/lab';
import type { Strategy } from '../../shared/strategy';
import { parseStrategyRules } from '../../shared/strategyRules';
import { createCustomStrategy } from '../backtest/strategies/custom';
import { computeForward, forwardHourlyStart } from './forward';
import { HOURLY_WARMUP_BARS, runHourlyBacktest, sessionOf } from './hourly';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 15, 0, 0);

const strategy = {
  id: 7,
  version: 1,
  name: 'Ruptura en Londres',
  rules: {
    entry: 'sesion_londres = 1 y cierre > maximo(6)',
    exit: 'sesion_nueva_york = 0 y sesion_londres = 0',
    stop: '2 * atr(14)',
    target: '3 * atr(14)',
  },
  parameters: {},
  markets: ['EURUSD'],
  timeframe: '1h',
  worksIn: [],
  failsIn: [],
  assumedCosts: { commissionPct: 0, commissionMin: 0, slippageBps: 1, spreadBps: 1 },
} as unknown as Strategy;

const parsed = parseStrategyRules(strategy.rules, {});
if (!parsed.ok) throw new Error(parsed.errors[0]!.message);
const create = () => createCustomStrategy(parsed.program, {});

describe('sessionOf', () => {
  it('asigna cada vela a su sesión con prioridad Nueva York > Londres > Tokio', () => {
    // Jueves 19-nov-2026: 01:00 UTC = 10:00 en Tokio.
    expect(sessionOf('2026-11-19T01:00:00.000Z')).toBe('tokio');
    expect(sessionOf('2026-11-19T09:00:00.000Z')).toBe('londres');
    // 15:00 UTC = 10:00 en Nueva York (Londres también abierta).
    expect(sessionOf('2026-11-19T15:00:00.000Z')).toBe('nueva-york');
    expect(sessionOf('2026-11-19T22:00:00.000Z')).toBe('fuera');
    // Sábado.
    expect(sessionOf('2026-11-21T09:00:00.000Z')).toBe('fuera');
  });
});

describe('runHourlyBacktest', () => {
  it('prueba un año de velas de 1 hora y desglosa por sesión', () => {
    const bars = simulatedIntradayBars('EURUSD', NOW - 365 * DAY, NOW);
    const result = runHourlyBacktest({
      strategy,
      create,
      bars,
      ticker: 'EURUSD',
      requestedDays: 365,
    });
    expect(result.timeframe).toBe('1h');
    expect(result.bars).toBe(bars.length - HOURLY_WARMUP_BARS);
    expect(result.tradeCount).toBeGreaterThan(30);
    // Solo entra con Londres abierta: todas sus entradas caen en Londres
    // (o en Nueva York, que la solapa por la tarde).
    const tokio = result.bySession.find((s) => s.session === 'tokio')!;
    expect(tokio.trades).toBe(0);
    const total = result.bySession.reduce((n, s) => n + s.trades, 0);
    expect(total).toBe(result.tradeCount);
    expect(result.curve.length).toBeLessThanOrEqual(240);
    expect(Number.isFinite(result.totalReturn)).toBe(true);
    expect(result.buyAndHold).not.toBeNull();
  });

  it('avisa si el proveedor dio menos histórico del pedido', () => {
    const bars = simulatedIntradayBars('EURUSD', NOW - 120 * DAY, NOW);
    const result = runHourlyBacktest({
      strategy,
      create,
      bars,
      ticker: 'EURUSD',
      requestedDays: 730,
    });
    expect(result.warnings.some((w) => /solo tenía/.test(w))).toBe(true);
  });

  it('rechaza un histórico demasiado corto', () => {
    const bars = simulatedIntradayBars('EURUSD', NOW - 5 * DAY, NOW);
    expect(() =>
      runHourlyBacktest({ strategy, create, bars, ticker: 'EURUSD', requestedDays: 365 }),
    ).toThrow(/Hacen falta más velas/);
  });
});

describe('prueba en vivo en 1 hora', () => {
  it('arranca en la siguiente hora en punto', () => {
    expect(forwardHourlyStart(Date.UTC(2026, 10, 20, 15, 12))).toBe('2026-11-20T16:00:00.000Z');
    expect(forwardHourlyStart(Date.UTC(2026, 10, 20, 15, 0))).toBe('2026-11-20T15:00:00.000Z');
  });

  it('repite el motor sobre las velas de 1 hora desde el inicio', async () => {
    const test: ForwardTest = {
      id: 1,
      strategyId: 7,
      strategyName: strategy.name,
      version: 1,
      startDate: new Date(NOW - 10 * DAY).toISOString(),
      initialCash: 10_000,
      benchmark: 'EURUSD',
      markets: ['EURUSD'],
      status: 'activa',
      stoppedAt: null,
      createdAt: new Date(NOW - 10 * DAY).toISOString(),
    };
    const detail = await computeForward({
      test,
      strategy,
      create,
      getBars: async () => [],
      today: '2026-11-20',
      dataKind: 'simulated',
      backtestAnnualPct: null,
      getHourlyBars: async (ticker, from, to) => simulatedIntradayBars(ticker, from, to),
      nowMs: NOW,
    });
    expect(detail.error).toBeNull();
    expect(detail.curve.length).toBeGreaterThan(100);
    expect(detail.curve[0]!.date >= test.startDate).toBe(true);
  });
});
