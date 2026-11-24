import { describe, expect, it } from 'vitest';

import type { ForwardTest } from '../../shared/lab';
import type { Strategy } from '../../shared/strategy';
import { parseStrategyRules } from '../../shared/strategyRules';
import { createCustomStrategy } from '../backtest/strategies/custom';
import type { EngineBar } from '../backtest/types';
import { computeForward, forwardStartDate } from './forward';

/** Serie diaria laborable con un paseo determinista. */
function bars(seed: number, from: string, to: string): EngineBar[] {
  const out: EngineBar[] = [];
  let close = 100;
  let x = seed;
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d <= new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    x = (x * 9301 + 49297) % 233280;
    const open = close;
    close = Math.max(1, close * (1 + (x / 233280 - 0.48) * 0.03));
    out.push({
      date: d.toISOString().slice(0, 10),
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

const strategy = {
  id: 1,
  version: 1,
  name: 'Cruce',
  rules: {
    entry: 'cruza_arriba(sma(5), sma(20))',
    exit: 'cruza_abajo(sma(5), sma(20))',
    stop: '2 * atr(14)',
    target: 'ninguno',
  },
  parameters: {},
  markets: ['QQQ'],
  worksIn: [],
  failsIn: [],
  assumedCosts: { commissionPct: 0.05, commissionMin: 1, slippageBps: 5, spreadBps: 2 },
} as unknown as Strategy;

const test: ForwardTest = {
  id: 1,
  strategyId: 1,
  strategyName: 'Cruce',
  version: 1,
  startDate: '2026-06-01',
  initialCash: 10_000,
  benchmark: 'SPY',
  markets: ['QQQ'],
  status: 'activa',
  stoppedAt: null,
  createdAt: '2026-06-01T12:00:00Z',
};

const parsed = parseStrategyRules(strategy.rules, {});
if (!parsed.ok) throw new Error('reglas de prueba inválidas');
const create = () => createCustomStrategy(parsed.program, {});
const series: Record<string, EngineBar[]> = {
  QQQ: bars(7, '2024-01-01', '2026-11-20'),
  SPY: bars(3, '2024-01-01', '2026-11-20'),
};
const getBars = async (t: string, desde: string, hasta: string) =>
  (series[t] ?? []).filter((b) => b.date >= desde && b.date <= hasta);

describe('computeForward', () => {
  it('empieza en la fecha de inicio, compara con el benchmark y deja viva la cartera', async () => {
    const d = await computeForward({
      test,
      strategy,
      create,
      getBars,
      today: '2026-11-20',
      dataKind: 'simulated',
      backtestAnnualPct: 0.1,
    });
    expect(d.error).toBeNull();
    expect(d.curve[0]!.date >= '2026-06-01').toBe(true);
    expect(d.asOf).toBe('2026-11-20');
    expect(d.curve[0]!.benchmark).toBeCloseTo(10_000, 6);
    expect(d.benchmarkReturnPct).not.toBeNull();
    expect(d.returnPct).toBeCloseTo(d.equity / 10_000 - 1, 10);
    // Ninguna operación anterior al inicio: las reglas no ven el pasado operable.
    for (const t of d.trades) expect(t.entryDate >= '2026-06-01').toBe(true);
    // Lo abierto no se liquida: si hay posiciones, la curva no acaba en efectivo puro.
    expect(d.openPositions).toBe(d.positions.length);
  });

  it('no inventa resultados antes de la primera vela', async () => {
    const d = await computeForward({
      test: { ...test, startDate: '2026-12-01' },
      strategy,
      create,
      getBars,
      today: '2026-11-20',
      dataKind: 'simulated',
      backtestAnnualPct: null,
    });
    expect(d.sessions).toBe(0);
    expect(d.asOf).toBeNull();
    expect(d.returnPct).toBe(0);
  });

  it('una prueba detenida queda congelada en su fecha', async () => {
    const d = await computeForward({
      test: { ...test, status: 'detenida', stoppedAt: '2026-08-14T20:00:00Z' },
      strategy,
      create,
      getBars,
      today: '2026-11-20',
      dataKind: 'simulated',
      backtestAnnualPct: null,
    });
    expect(d.asOf).toBe('2026-08-14');
    expect(d.pendingOrders).toEqual([]);
  });
});

describe('forwardStartDate', () => {
  it('antes del cierre de Nueva York cuenta hoy; después, mañana', () => {
    expect(forwardStartDate(Date.parse('2026-11-23T15:00:00Z'))).toBe('2026-11-23');
    expect(forwardStartDate(Date.parse('2026-11-23T21:30:00Z'))).toBe('2026-11-24');
  });
});
