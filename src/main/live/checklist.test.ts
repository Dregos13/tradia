import { describe, expect, it } from 'vitest';

import type { BrokerOrder } from '../../shared/ipc';
import {
  DELIVERY_TEST_EVIDENCE_KEY,
  LIVE_CANDIDATE_STATUSES,
  LIVE_DEVIATION_MAX_PCT,
  LIVE_KILL_SWITCH_TEST_MAX_DAYS,
  LIVE_PAPER_MIN_DAYS,
  LIVE_PAPER_MIN_TRADES,
  evaluateAlertChannel,
  evaluateFinalTest,
  evaluateKillSwitchTest,
  evaluatePaperProgress,
  formatLiveDate,
  paperStatsFromOrders,
  type AlertTestEvidence,
} from './checklist';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-09T15:00:00.000Z');
const isoDaysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString();

// ---------------------------------------------------------------------------
// Orden paper ejecutada de fixture (par entrada/salida por operación)
// ---------------------------------------------------------------------------

let orderSeq = 0;

const paperOrder = (patch: {
  signalId?: number | null;
  strategyId?: number | null;
  leg?: 'entrada' | 'salida' | null;
  side?: 'buy' | 'sell';
  executedAt?: string | null;
  executedPrice?: number | null;
  clientOrderId?: string;
}): BrokerOrder => {
  orderSeq += 1;
  return {
    id: orderSeq,
    clientOrderId: patch.clientOrderId ?? `tradia-seed-${orderSeq}-${patch.leg ?? 'suelta'}`,
    brokerOrderId: `b${orderSeq}`,
    signalId: patch.signalId ?? null,
    strategyId: patch.strategyId ?? 1,
    leg: patch.leg ?? null,
    ticker: 'SPY',
    type: 'market',
    side: patch.side ?? 'buy',
    mode: 'paper',
    quantity: 1,
    filledQuantity: 1,
    limitPrice: null,
    stopPrice: null,
    ocoGroupId: null,
    execution: {
      requestedAt: '2026-01-01T15:00:00.000Z',
      requestedPrice: 100,
      executedAt: patch.executedAt === undefined ? isoDaysAgo(10) : patch.executedAt,
      executedPrice: patch.executedPrice === undefined ? 100 : patch.executedPrice,
      slippageBps: 0,
    },
    status: 'ejecutada',
    attempts: 1,
    rejectReason: null,
    createdAt: '2026-01-01T15:00:00.000Z',
    updatedAt: '2026-01-01T15:00:00.000Z',
  };
};

/** Una operación cerrada: entrada + salida ejecutadas con su retorno. */
const closedTrade = (opts: {
  strategyId: number;
  signalId: number;
  entryAt: string;
  exitAt: string;
  entryPrice?: number;
  exitPrice?: number;
}): BrokerOrder[] => [
  paperOrder({
    strategyId: opts.strategyId,
    signalId: opts.signalId,
    leg: 'entrada',
    side: 'buy',
    executedAt: opts.entryAt,
    executedPrice: opts.entryPrice ?? 100,
  }),
  paperOrder({
    strategyId: opts.strategyId,
    signalId: opts.signalId,
    leg: 'salida',
    side: 'sell',
    executedAt: opts.exitAt,
    executedPrice: opts.exitPrice ?? 100,
  }),
];

// ---------------------------------------------------------------------------

describe('umbrales de la lista', () => {
  it('los mínimos fijos coinciden con §4.4 y la sección 18', () => {
    expect(LIVE_PAPER_MIN_DAYS).toBe(91);
    expect(LIVE_PAPER_MIN_TRADES).toBe(30);
    expect(LIVE_DEVIATION_MAX_PCT).toBe(30);
    expect(LIVE_KILL_SWITCH_TEST_MAX_DAYS).toBe(30);
    expect(LIVE_CANDIDATE_STATUSES).toEqual(['paper', 'activa']);
    expect(DELIVERY_TEST_EVIDENCE_KEY).toBe('delivery.lastTestSuccess');
  });
});

describe('formatLiveDate', () => {
  it('formatea en español sin depender del locale', () => {
    expect(formatLiveDate('2026-10-09T15:00:00.000Z')).toBe('9 oct 2026');
  });
});

describe('evaluateFinalTest', () => {
  it('sin candidatas queda pendiente con su motivo', () => {
    const verdict = evaluateFinalTest({ total: 0, done: 0, missing: [] }, false);
    expect(verdict.state).toBe('pendiente');
    expect(verdict.reasons[0]).toMatch(/estrategias candidatas/i);
  });

  it('con candidatas a medias queda pendiente y nombra las que faltan', () => {
    const verdict = evaluateFinalTest({ total: 4, done: 3, missing: ['Reversión RSI'] }, false);
    expect(verdict.state).toBe('pendiente');
    expect(verdict.evidence).toContain('3 de 4');
    expect(verdict.reasons[0]).toContain('Reversión RSI');
  });

  it('con todas cubiertas queda cumplido con la evidencia intacta', () => {
    const verdict = evaluateFinalTest({ total: 4, done: 4, missing: [] }, false);
    expect(verdict.state).toBe('cumplido');
    expect(verdict.evidence).toContain('4 de 4');
    expect(verdict.evidence).toContain('prueba final intacta');
  });

  it('la semilla la da por cumplida', () => {
    expect(evaluateFinalTest({ total: 0, done: 0, missing: [] }, true).state).toBe('cumplido');
  });
});

describe('evaluatePaperProgress', () => {
  it('debajo de los tres umbrales lista cada motivo', () => {
    const verdict = evaluatePaperProgress({
      daysActive: 79,
      closedTrades: 24,
      deviationPct: -12,
    });
    expect(verdict.state).toBe('pendiente');
    expect(verdict.evidence).toContain('79 de 91 días');
    expect(verdict.evidence).toContain('24 de 30 operaciones');
    expect(verdict.reasons).toHaveLength(2);
    expect(verdict.reasons[0]).toContain('12 días');
    expect(verdict.reasons[1]).toContain('24 de 30');
  });

  it('con todo en regla queda cumplido', () => {
    const verdict = evaluatePaperProgress({
      daysActive: 95,
      closedTrades: 34,
      deviationPct: -12.4,
    });
    expect(verdict.state).toBe('cumplido');
    expect(verdict.evidence).toContain('−12,4 %');
  });

  it('una desviación fuera del ±30 % la mantiene pendiente', () => {
    const verdict = evaluatePaperProgress({
      daysActive: 95,
      closedTrades: 34,
      deviationPct: 45,
    });
    expect(verdict.state).toBe('pendiente');
    expect(verdict.reasons.some((r) => r.includes('±30 %'))).toBe(true);
  });

  it('con operaciones pero sin backtest de referencia pide revisión', () => {
    const verdict = evaluatePaperProgress({
      daysActive: 95,
      closedTrades: 34,
      deviationPct: null,
    });
    expect(verdict.state).toBe('revisar');
  });
});

describe('paperStatsFromOrders', () => {
  it('cuenta días entre la primera y la última ejecución y pares cerrados', () => {
    const orders = [
      ...closedTrade({
        strategyId: 1,
        signalId: 1,
        entryAt: isoDaysAgo(100),
        exitAt: isoDaysAgo(95),
        exitPrice: 110,
      }),
      ...closedTrade({
        strategyId: 1,
        signalId: 2,
        entryAt: isoDaysAgo(10),
        exitAt: isoDaysAgo(5),
        exitPrice: 90,
      }),
    ];
    const stats = paperStatsFromOrders(orders, () => ({ perTradeReturnPct: 0 }));
    expect(stats.daysActive).toBe(95);
    expect(stats.closedTrades).toBe(2);
  });

  it('la desviación relativa pondera las operaciones de cada estrategia', () => {
    // Estrategia 1: real +10 % por operación, esperado +10 % → 0 %.
    // Estrategia 2: real +5 %, esperado +10 % → −50 %.
    // Blend ponderado: (10+5)/2 − 10 sobre |10| = −25 %.
    const orders = [
      ...closedTrade({
        strategyId: 1,
        signalId: 1,
        entryAt: isoDaysAgo(100),
        exitAt: isoDaysAgo(95),
        exitPrice: 110,
      }),
      ...closedTrade({
        strategyId: 2,
        signalId: 2,
        entryAt: isoDaysAgo(90),
        exitAt: isoDaysAgo(85),
        exitPrice: 105,
      }),
    ];
    const stats = paperStatsFromOrders(orders, () => ({ perTradeReturnPct: 10 }));
    expect(stats.deviationPct).toBeCloseTo(-25, 5);
  });

  it('sin backtest de referencia la desviación queda null', () => {
    const orders = closedTrade({
      strategyId: 1,
      signalId: 1,
      entryAt: isoDaysAgo(100),
      exitAt: isoDaysAgo(95),
    });
    const stats = paperStatsFromOrders(orders, () => ({ perTradeReturnPct: null }));
    expect(stats.deviationPct).toBeNull();
  });

  it('sin órdenes todo queda a cero', () => {
    const stats = paperStatsFromOrders([], () => ({ perTradeReturnPct: 10 }));
    expect(stats).toEqual({ daysActive: 0, closedTrades: 0, deviationPct: null });
  });
});

describe('evaluateKillSwitchTest', () => {
  it('sin prueba registrada queda pendiente', () => {
    const verdict = evaluateKillSwitchTest(null, NOW);
    expect(verdict.state).toBe('pendiente');
    expect(verdict.reasons[0]).toContain('no se ha probado');
  });

  it('una prueba de hoy cumple', () => {
    const verdict = evaluateKillSwitchTest(isoDaysAgo(0), NOW);
    expect(verdict.state).toBe('cumplido');
    expect(verdict.evidence).toContain('hoy');
  });

  it('una prueba de 30 días justo cumple y la de 31 no', () => {
    expect(evaluateKillSwitchTest(isoDaysAgo(30), NOW).state).toBe('cumplido');
    const old = evaluateKillSwitchTest(isoDaysAgo(41), NOW);
    expect(old.state).toBe('pendiente');
    expect(old.evidence).toContain('41');
    expect(old.reasons[0]).toContain('41 días');
  });
});

describe('evaluateAlertChannel', () => {
  const test: AlertTestEvidence = { channel: 'telegram', at: isoDaysAgo(0) };

  it('sin envío de prueba queda pendiente', () => {
    const verdict = evaluateAlertChannel(null, () => false);
    expect(verdict.state).toBe('pendiente');
    expect(verdict.reasons[0]).toContain('canal externo');
  });

  it('con prueba correcta y canal activo cumple', () => {
    const verdict = evaluateAlertChannel(test, (c) => c === 'telegram');
    expect(verdict.state).toBe('cumplido');
    expect(verdict.evidence).toContain('Telegram');
  });

  it('si el canal probado ya no está activo vuelve a pendiente', () => {
    const verdict = evaluateAlertChannel(test, () => false);
    expect(verdict.state).toBe('pendiente');
    expect(verdict.reasons[0]).toContain('ya no está activo');
  });
});
