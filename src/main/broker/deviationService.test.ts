import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JournalRecordInput } from '../../shared/ipc';
import type { NotificationPayload } from '../../shared/ipc';
import { openDatabase } from '../db/database';
import { createJournalRepository, type JournalRepository } from '../journal/repository';
import { buildSeedWeeksOrders } from './__fixtures__/weeks';
import { NO_EXPECTATION, type StrategyExpectation } from './deviation';
import { createDeviationService, type DeviationService } from './deviationService';
import { createBrokerRepository, type BrokerRepository } from './repository';

// Miércoles 14 oct 2026, 12:00 en Nueva York: las 8 semanas sembradas
// cierran entre el lunes 17 ago y el domingo 11 oct; los meses cerrados
// con operaciones son agosto y septiembre (octubre sigue abierto).
const NOW = Date.parse('2026-10-14T16:00:00.000Z');

const EXPECTATIONS: Record<number, StrategyExpectation> = {
  1: { perTradeReturnPct: 1, winRate: 0.6, backtestVersion: 3, backtestRunId: 11 },
  2: { perTradeReturnPct: 1, winRate: 0.5, backtestVersion: 1, backtestRunId: 12 },
};

const NAMES: Record<number, string> = {
  1: 'Cruce de medias',
  2: 'RSI sobreventa',
};

let db: Database.Database;
let repo: BrokerRepository;
let journalRepo: JournalRepository;
let journal: JournalRecordInput[];
let notifications: NotificationPayload[];
let service: DeviationService;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createBrokerRepository(db);
  journalRepo = createJournalRepository(db);
  journal = [];
  notifications = [];
  service = createDeviationService({
    repo,
    expectationFor: (id) => EXPECTATIONS[id] ?? NO_EXPECTATION,
    strategyInfo: (id) => (NAMES[id] ? { name: NAMES[id], version: 1 } : null),
    margins: () => ({ marginPp: 2, maxSlippageBps: 10 }),
    recordJournal: (input) => {
      journal.push(input);
      return journalRepo.insert(
        {
          type: input.type,
          ticker: input.ticker ?? null,
          strategies: input.strategies ?? [],
          reason: input.reason,
          dataUsed: input.dataUsed ?? null,
          result: input.result ?? null,
          errors: input.errors ?? [],
          ruleChecks: input.ruleChecks ?? [],
          signalId: input.signalId ?? null,
        },
        new Date(NOW).toISOString(),
      );
    },
    notify: (payload) => {
      notifications.push(payload);
    },
    now: () => NOW,
  });
});

afterEach(() => {
  db.close();
});

describe('informe real vs backtest con las 8 semanas sembradas', () => {
  it('el gancho de siembra inserta las 64 órdenes del fixture', () => {
    const result = service.seedWeeks({ weeks: 8 });
    expect(result.orders).toBe(64);
    expect(repo.listOrders({ status: 'ejecutada' })).toHaveLength(64);
  });

  it('produce 8 filas semanales por estrategia con las cifras del caso', () => {
    service.seedWeeks();
    const report = service.report({ period: 'semanal' });

    expect(report.period).toBe('semanal');
    expect(report.marginPp).toBe(2);
    expect(report.maxSlippageBps).toBe(10);
    expect(report.rows).toHaveLength(16);

    const s1 = report.rows.filter((r) => r.strategyId === 1);
    const s2 = report.rows.filter((r) => r.strategyId === 2);
    expect(s1).toHaveLength(8);
    expect(s2).toHaveLength(8);

    // Más reciente primero: la última semana cerrada es 5–11 oct.
    expect(s1[0]).toMatchObject({
      strategyName: 'Cruce de medias',
      desde: '2026-10-05',
      hasta: '2026-10-11',
      trades: 2,
      expectedReturnPct: 2,
      realReturnPct: 2,
      deviationPp: 0,
      expectedWinRate: 0.6,
      realWinRate: 1,
      avgSlippageBps: 4,
      outOfMargin: false,
    });
    expect(s1.every((r) => !r.outOfMargin)).toBe(true);

    // La estrategia sembrada para desviarse queda marcada en todas.
    expect(s2[0]).toMatchObject({
      strategyName: 'RSI sobreventa',
      trades: 2,
      expectedReturnPct: 2,
      realReturnPct: -8,
      deviationPp: -10,
      expectedWinRate: 0.5,
      realWinRate: 0,
      avgSlippageBps: 16.03,
      outOfMargin: true,
    });
    expect(s2.every((r) => r.outOfMargin)).toBe(true);
  });

  it('produce 2 filas mensuales por estrategia (ago y sep; oct sigue abierto)', () => {
    service.seedWeeks();
    const report = service.report({ period: 'mensual' });

    expect(report.rows).toHaveLength(4);
    const s1 = report.rows.filter((r) => r.strategyId === 1);
    const s2 = report.rows.filter((r) => r.strategyId === 2);
    expect(s1).toHaveLength(2);
    expect(s2).toHaveLength(2);

    // Agosto: cierran las operaciones del 20 y 27 ago (2 semanas × 2).
    expect(s1.find((r) => r.desde === '2026-08-01')).toMatchObject({
      hasta: '2026-08-31',
      trades: 4,
      realReturnPct: 4,
      expectedReturnPct: 4,
      deviationPp: 0,
      outOfMargin: false,
    });
    // Septiembre: cierran las del 3, 10, 17 y 24 sep (4 semanas × 2).
    expect(s2.find((r) => r.desde === '2026-09-01')).toMatchObject({
      hasta: '2026-09-30',
      trades: 8,
      realReturnPct: -32,
      expectedReturnPct: 8,
      deviationPp: -40,
      outOfMargin: true,
    });
    expect(s2.every((r) => r.outOfMargin)).toBe(true);
  });
});

describe('alertas de desviación', () => {
  it('cada periodo cerrado fuera de margen genera alerta, Diario y notificación una vez', () => {
    service.seedWeeks();
    service.report({ period: 'semanal' });

    // 8 alertas semanales + 2 mensuales (la pasada evalúa los dos tipos).
    const weekly = repo.listDeviationAlerts({ period: 'semanal' });
    const monthly = repo.listDeviationAlerts({ period: 'mensual' });
    expect(weekly).toHaveLength(8);
    expect(monthly).toHaveLength(2);
    expect(weekly.every((a) => a.strategyId === 2 && a.strategyName === 'RSI sobreventa')).toBe(true);
    expect(weekly[0]).toMatchObject({
      period: 'semanal',
      expectedReturnPct: 2,
      realReturnPct: -8,
      deviationPp: -10,
      avgSlippageBps: 16.03,
      marginPp: 2,
      maxSlippageBps: 10,
    });
    expect(weekly[0]!.journalId).toBeGreaterThan(0);

    // Una entrada de Diario y una notificación por alerta, enlazadas.
    expect(journal).toHaveLength(10);
    expect(notifications).toHaveLength(10);
    expect(journal[0]).toMatchObject({ type: 'limite', result: 'alcanzado' });
    expect(journal[0]!.reason).toContain('RSI sobreventa');
    expect(journal[0]!.ruleChecks!.map((r) => r.cumplida)).toEqual([false, false]);
    expect(notifications[0]).toMatchObject({
      level: 'alerta',
      navigateTo: 'real-vs-backtest',
    });
    expect(notifications[0]!.title).toContain('RSI sobreventa');

    // Recalcular no duplica nada.
    service.report({ period: 'semanal' });
    service.report({ period: 'mensual' });
    expect(repo.listDeviationAlerts()).toHaveLength(10);
    expect(journal).toHaveLength(10);
    expect(notifications).toHaveLength(10);
  });

  it('un periodo dentro de margen no genera alerta', () => {
    service.seedWeeks();
    service.report({ period: 'semanal' });
    expect(repo.listDeviationAlerts({ strategyId: 1 })).toHaveLength(0);
    expect(journal.every((j) => j.strategies?.[0]?.strategyId === 2)).toBe(true);
  });

  it('sin backtest no puede persistir alerta (esperado_pct NOT NULL) pero la fila se marca', () => {
    // Solo la estrategia 2 sembrada para desviarse, sin expectativa.
    const svc = createDeviationService({
      repo,
      expectationFor: () => NO_EXPECTATION,
      margins: () => ({ marginPp: 2, maxSlippageBps: 10 }),
      now: () => NOW,
    });
    svc.seedWeeks();
    const report = svc.report({ period: 'semanal' });
    const s2 = report.rows.filter((r) => r.strategyId === 2);
    expect(s2.every((r) => r.outOfMargin && r.deviationPp === null)).toBe(true);
    expect(repo.listDeviationAlerts()).toHaveLength(0);
  });
});

describe('fixture determinista', () => {
  it('el mismo `now` produce las mismas órdenes y la siembra es idempotente', () => {
    const first = buildSeedWeeksOrders({ now: NOW });
    const second = buildSeedWeeksOrders({ now: NOW });
    expect(second).toEqual(first);
    expect(first).toHaveLength(64);

    service.seedWeeks();
    service.seedWeeks();
    expect(repo.listOrders()).toHaveLength(64);
  });

  it('las órdenes sembradas son todas ejecutadas y emparejadas', () => {
    service.seedWeeks();
    const orders = repo.listOrders();
    expect(orders.every((o) => o.status === 'ejecutada')).toBe(true);
    const entradas = orders.filter((o) => o.leg === 'entrada');
    const salidas = orders.filter((o) => o.leg === 'salida');
    expect(entradas).toHaveLength(32);
    expect(salidas).toHaveLength(32);
    for (const entrada of entradas) {
      const salida = salidas.find(
        (s) => s.clientOrderId === entrada.clientOrderId.replace('-entrada', '-salida'),
      );
      expect(salida).toBeDefined();
      expect(salida!.type).toBe('oco');
    }
  });
});
