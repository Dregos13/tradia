/**
 * Pruebas del estado del escalado (live/scaling.ts): umbrales de 8
 * semanas dentro del margen y 30 operaciones reales, y la lectura
 * informativa sin acción sobre los techos.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db/database';
import { NO_EXPECTATION, type StrategyExpectation } from '../broker/deviation';
import { createBrokerRepository, type BrokerRepository } from '../broker/repository';
import { computeLiveScalingStatus, type LiveScalingDeps } from './scaling';
import { createLiveStore, type LiveStore } from './service';

const NOW = Date.parse('2026-10-09T15:00:00.000Z'); // viernes
const DAY_MS = 86_400_000;

let db: Database.Database;
let store: LiveStore;
let liveRepo: BrokerRepository;

const expectation = (perTradeReturnPct: number | null): StrategyExpectation => ({
  perTradeReturnPct,
  winRate: 0.5,
  backtestVersion: 1,
  backtestRunId: 7,
});

const makeDeps = (extra: Partial<LiveScalingDeps> = {}): LiveScalingDeps => ({
  repository: liveRepo,
  store,
  expectationFor: () => expectation(1),
  margins: () => ({ marginPp: 2, maxSlippageBps: 10 }),
  now: () => NOW,
  ...extra,
});

const activateAt = (iso: string | null): void => {
  store.setMode({
    estado: 'activo',
    motivo: null,
    detalle: null,
    activadoEn: iso,
    suspendidoEn: null,
    actualizadoEn: new Date(NOW).toISOString(),
  });
};

const confirmLimits = (capitalUsd = 500): void => {
  const at = new Date(NOW).toISOString();
  store.saveLimits(
    {
      capitalUsd,
      orderUsd: 100,
      dailyLossUsd: 10,
      openPositions: 1,
      shortOrderUsd: 0,
      shortExposureUsd: 0,
      shortPositions: 0,
    },
    at,
  );
  store.confirmLimits(at);
};

let seq = 0;
/** Operación real cerrada: entrada y salida ejecutadas de una señal. */
const seedTrade = (patch: {
  entry: number;
  exit: number;
  closedAt: string;
  strategyId?: number;
  ticker?: string;
  qty?: number;
}): void => {
  seq += 1;
  const key = `tradia-op-${seq}`;
  const opened = new Date(Date.parse(patch.closedAt) - DAY_MS).toISOString();
  const strategyId = patch.strategyId ?? 3;
  const qty = patch.qty ?? 1;
  liveRepo.insertOrder({
    clientOrderId: `${key}-entrada`,
    signalId: null,
    strategyId,
    leg: 'entrada',
    ticker: patch.ticker ?? 'SPY',
    type: 'market',
    side: 'buy',
    quantity: qty,
    filledQuantity: qty,
    requestedPrice: patch.entry,
    executedPrice: patch.entry,
    requestedAt: opened,
    executedAt: opened,
    status: 'ejecutada',
  });
  liveRepo.insertOrder({
    clientOrderId: `${key}-salida`,
    signalId: null,
    strategyId,
    leg: 'salida',
    ticker: patch.ticker ?? 'SPY',
    type: 'oco',
    side: 'sell',
    quantity: qty,
    filledQuantity: qty,
    limitPrice: patch.exit,
    requestedPrice: null,
    executedPrice: patch.exit,
    requestedAt: patch.closedAt,
    executedAt: patch.closedAt,
    status: 'ejecutada',
  });
};

/** `count` operaciones repartidas a razón de `perWeek` por semana cerrada. */
const seedWeeksOfTrades = (
  count: number,
  perWeek: number,
  patch: { entry: number; exit: number } = { entry: 100, exit: 101 },
): void => {
  const monday = Date.parse('2026-09-07T15:00:00.000Z'); // semana cerrada reciente
  for (let i = 0; i < count; i += 1) {
    const week = Math.floor(i / perWeek);
    const closedAt = new Date(monday - week * 7 * DAY_MS).toISOString();
    seedTrade({ ...patch, closedAt });
  }
};

beforeEach(() => {
  db = openDatabase(':memory:');
  store = createLiveStore(db);
  liveRepo = createBrokerRepository(db, { ordersTable: 'broker_orders_live' });
  seq = 0;
});

afterEach(() => {
  db.close();
});

describe('live:scaling — estado del escalado', () => {
  it('sin operaciones reales el escalado está bloqueado', () => {
    const status = computeLiveScalingStatus(makeDeps());
    expect(status.state).toBe('bloqueado');
    expect(status.liveTrades).toBe(0);
    expect(status.weeksInMargin).toBe(0);
    expect(status.deviationPct).toBeNull();
    expect(status.drawdownPct).toBeNull();
    expect(status.reason).toContain('bloqueado');
    expect(status.evaluatedAt).toBe(new Date(NOW).toISOString());
  });

  it('las órdenes sueltas (prueba de humo, sin pata) no cuentan como operaciones', () => {
    // Compra y venta sueltas sin pata ni estrategia: no son un trade.
    for (const side of ['buy', 'sell'] as const) {
      liveRepo.insertOrder({
        clientOrderId: `tradia-humo-1-${side}`,
        signalId: null,
        strategyId: null,
        leg: null,
        ticker: 'SPY',
        type: 'market',
        side,
        quantity: 0.002,
        filledQuantity: 0.002,
        requestedPrice: 500,
        executedPrice: 500,
        requestedAt: new Date(NOW - DAY_MS * 30).toISOString(),
        executedAt: new Date(NOW - DAY_MS * 30).toISOString(),
        status: 'ejecutada',
      });
    }
    const status = computeLiveScalingStatus(makeDeps());
    expect(status.liveTrades).toBe(0);
    expect(status.state).toBe('bloqueado');
  });

  it('liveWeeks cuenta las semanas desde la activación vigente', () => {
    activateAt(new Date(NOW - 30 * DAY_MS).toISOString());
    const status = computeLiveScalingStatus(makeDeps());
    expect(status.liveWeeks).toBe(4);
  });

  it('con pocas operaciones informa de la evidencia en curso y de lo que falta', () => {
    activateAt(new Date(NOW - 30 * DAY_MS).toISOString());
    confirmLimits();
    seedWeeksOfTrades(8, 4); // 8 operaciones en 2 semanas cerradas

    const status = computeLiveScalingStatus(makeDeps());

    expect(status.state).toBe('en-evidencia');
    expect(status.liveTrades).toBe(8);
    expect(status.weeksInMargin).toBe(2);
    expect(status.reason).toContain('8 de 30 operaciones reales');
    expect(status.reason).toContain('2 de 8 semanas');
    expect(status.reason).toContain('22 operaciones');
    expect(status.reason).toContain('6 semanas');
  });

  it('una semana fuera de margen no cuenta para las 8 y la desviación se informa', () => {
    activateAt(new Date(NOW - 60 * DAY_MS).toISOString());
    confirmLimits();
    // −50 % real frente a +1 % esperado: fuera del margen de ±2 pp.
    seedWeeksOfTrades(4, 4, { entry: 100, exit: 50 });

    const status = computeLiveScalingStatus(makeDeps());

    expect(status.state).toBe('en-evidencia');
    expect(status.weeksInMargin).toBe(0);
    // 4 operaciones × (−50 − 1) pp de desviación acumulada.
    expect(status.deviationPct).toBeCloseTo(-204, 0);
  });

  it('con 30 operaciones y 8 semanas dentro del margen es elegible (sin acción)', () => {
    activateAt(new Date(NOW - 80 * DAY_MS).toISOString());
    confirmLimits();
    seedWeeksOfTrades(36, 4); // 36 operaciones en 9 semanas cerradas

    const status = computeLiveScalingStatus(makeDeps());

    expect(status.state).toBe('elegible');
    expect(status.liveTrades).toBe(36);
    expect(status.weeksInMargin).toBe(9);
    expect(status.reason).toContain('fase 8');
  });

  it('30 operaciones sin 8 semanas en margen no basta', () => {
    activateAt(new Date(NOW - 30 * DAY_MS).toISOString());
    confirmLimits();
    seedWeeksOfTrades(30, 10); // 30 operaciones pero en 3 semanas

    const status = computeLiveScalingStatus(makeDeps());

    expect(status.state).toBe('en-evidencia');
    expect(status.liveTrades).toBe(30);
    expect(status.weeksInMargin).toBe(3);
    expect(status.reason).toContain('5 semanas');
  });

  it('sin backtest de referencia la desviación queda sin base', () => {
    confirmLimits();
    seedWeeksOfTrades(4, 4);
    const status = computeLiveScalingStatus(makeDeps({ expectationFor: () => NO_EXPECTATION }));
    expect(status.deviationPct).toBeNull();
    expect(status.weeksInMargin).toBe(0);
  });

  it('el drawdown real sale del pico a valle del PnL sobre el capital escrito', () => {
    activateAt(new Date(NOW - 30 * DAY_MS).toISOString());
    confirmLimits(500);
    const day = (delta: number) => new Date(NOW - delta * DAY_MS).toISOString();
    // +10 % y −20 % sobre nocional de 100 USD: pico +10, valle −10 → 20 USD.
    seedTrade({ entry: 100, exit: 110, closedAt: day(20), qty: 1 });
    seedTrade({ entry: 100, exit: 80, closedAt: day(10), qty: 1 });

    const status = computeLiveScalingStatus(makeDeps());

    expect(status.drawdownPct).toBeCloseTo(4, 1);
  });
});
