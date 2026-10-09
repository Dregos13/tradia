import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db/database';
import {
  createBrokerRepository,
  type BrokerRepository,
  type NewBrokerOrder,
} from './repository';

const newOrder = (patch: Partial<NewBrokerOrder> = {}): NewBrokerOrder => ({
  clientOrderId: 'tradia-1-entrada',
  signalId: null,
  strategyId: 3,
  leg: 'entrada',
  ticker: 'AAPL',
  type: 'market',
  side: 'buy',
  quantity: 10,
  requestedPrice: 200,
  requestedAt: '2026-10-08T20:00:00.000Z',
  ...patch,
});

let db: Database.Database;
let repo: BrokerRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createBrokerRepository(db);
});

afterEach(() => {
  db.close();
});

describe('repositorio de órdenes del broker', () => {
  it('inserta y relee la orden con toda su trazabilidad', () => {
    const { order, inserted } = repo.insertOrder(
      newOrder({
        brokerOrderId: 'sim-1',
        executedPrice: 200.1,
        executedAt: '2026-10-08T20:00:01.000Z',
        slippageBps: 5,
        status: 'ejecutada',
        attempts: 1,
      }),
    );
    expect(inserted).toBe(true);

    const read = repo.getOrder(order.id);
    expect(read).toMatchObject({
      clientOrderId: 'tradia-1-entrada',
      brokerOrderId: 'sim-1',
      strategyId: 3,
      leg: 'entrada',
      ticker: 'AAPL',
      type: 'market',
      side: 'buy',
      quantity: 10,
      filledQuantity: 0,
      status: 'ejecutada',
      attempts: 1,
      execution: {
        requestedAt: '2026-10-08T20:00:00.000Z',
        requestedPrice: 200,
        executedAt: '2026-10-08T20:00:01.000Z',
        executedPrice: 200.1,
        slippageBps: 5,
      },
    });
    expect(read!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('el client_order_id duplicado devuelve la existente (idempotencia)', () => {
    const first = repo.insertOrder(newOrder());
    const second = repo.insertOrder(newOrder({ ticker: 'MSFT' }));
    expect(second.inserted).toBe(false);
    expect(second.order.id).toBe(first.order.id);
    expect(second.order.ticker).toBe('AAPL');
    expect(repo.listOrders()).toHaveLength(1);
  });

  it('busca por client_order_id y por id; null cuando no existe', () => {
    repo.insertOrder(newOrder());
    expect(repo.getOrderByClientId('tradia-1-entrada')?.ticker).toBe('AAPL');
    expect(repo.getOrderByClientId('tradia-99-entrada')).toBeNull();
    expect(repo.getOrder(999)).toBeNull();
    expect(repo.getOrder(-1)).toBeNull();
  });

  it('actualiza estado, ejecución, intentos y rechazo', () => {
    const { order } = repo.insertOrder(newOrder({ status: 'pendiente' }));
    const updated = repo.updateOrder(
      order.id,
      {
        brokerOrderId: 'sim-7',
        status: 'parcial',
        filledQuantity: 5,
        attempts: 2,
      },
      '2026-10-08T20:05:00.000Z',
    );
    expect(updated).toMatchObject({
      brokerOrderId: 'sim-7',
      status: 'parcial',
      filledQuantity: 5,
      attempts: 2,
      updatedAt: '2026-10-08T20:05:00.000Z',
    });
    const rejected = repo.updateOrder(
      order.id,
      { status: 'rechazada', rejectReason: 'fondos insuficientes' },
      '2026-10-08T20:06:00.000Z',
    );
    expect(rejected.status).toBe('rechazada');
    expect(rejected.rejectReason).toBe('fondos insuficientes');
    expect(() => repo.updateOrder(999, { status: 'enviada' }, '2026-10-08T20:00:00.000Z')).toThrow();
  });

  it('lista con filtros por estado, estrategia y ticker, más recientes primero', () => {
    repo.insertOrder(newOrder({ clientOrderId: 'a-1', ticker: 'AAPL', status: 'ejecutada' }));
    repo.insertOrder(
      newOrder({ clientOrderId: 'a-2', ticker: 'MSFT', status: 'enviada', strategyId: 4 }),
    );
    repo.insertOrder(newOrder({ clientOrderId: 'a-3', ticker: 'aapl', status: 'rechazada' }));

    expect(repo.listOrders()).toHaveLength(3);
    expect(repo.listOrders({ status: 'enviada' })).toHaveLength(1);
    expect(repo.listOrders({ strategyId: 3 })).toHaveLength(2);
    expect(repo.listOrders({ ticker: 'AAPL' })).toHaveLength(2);
    expect(repo.listOrders({ limit: 1 })).toHaveLength(1);
    expect(repo.listOrders({ offset: 2 })).toHaveLength(1);
    const ids = repo.listOrders().map((o) => o.clientOrderId);
    expect(ids).toEqual(['a-3', 'a-2', 'a-1']);
  });
});

describe('repositorio de conciliación', () => {
  it('abre y cierra una ejecución con conteos y resultado', () => {
    const run = repo.startReconcileRun('manual', '2026-10-08T21:00:00.000Z');
    expect(run.result).toBeNull();
    expect(run.finishedAt).toBeNull();

    const done = repo.finishReconcileRun(run.id, {
      finishedAt: '2026-10-08T21:00:01.000Z',
      result: 'descuadre',
      positionsApp: 2,
      positionsBroker: 1,
      ordersApp: 1,
      ordersBroker: 0,
      discrepancies: 2,
    });
    expect(done).toMatchObject({
      result: 'descuadre',
      positionsApp: 2,
      positionsBroker: 1,
      ordersApp: 1,
      ordersBroker: 0,
      discrepancies: 2,
    });
    expect(repo.getLastReconcileRun()?.id).toBe(run.id);
    expect(repo.listReconcileRuns()).toHaveLength(1);
  });

  it('anota discrepancias abiertas y las resuelve en una ejecución limpia', () => {
    const run = repo.startReconcileRun('programada', '2026-10-08T21:00:00.000Z');
    repo.insertDiscrepancy({
      runId: run.id,
      type: 'posicion-cantidad',
      ticker: 'AAPL',
      detail: 'AAPL: la app registra 10 uds y el broker 8 uds',
      appValue: '10 uds',
      brokerValue: '8 uds',
    });
    repo.insertDiscrepancy({
      runId: run.id,
      type: 'orden-faltante-broker',
      detail: 'La orden tradia-1-salida no existe en el broker',
    });

    const open = repo.listOpenDiscrepancies();
    expect(open).toHaveLength(2);
    expect(open[0]).toMatchObject({
      type: 'posicion-cantidad',
      ticker: 'AAPL',
      status: 'abierta',
      appValue: '10 uds',
      brokerValue: '8 uds',
      resolvedAt: null,
    });
    expect(repo.listRunDiscrepancies(run.id)).toHaveLength(2);

    expect(repo.resolveOpenDiscrepancies('2026-10-08T21:15:00.000Z')).toBe(2);
    expect(repo.listOpenDiscrepancies()).toHaveLength(0);
    const resolved = repo.listRunDiscrepancies(run.id);
    expect(resolved[0]!.status).toBe('resuelta');
    expect(resolved[0]!.resolvedAt).toBe('2026-10-08T21:15:00.000Z');
  });

  it('resuelve una discrepancia suelta sin tocar las demás', () => {
    const run = repo.startReconcileRun('programada', '2026-10-08T21:00:00.000Z');
    const first = repo.insertDiscrepancy({
      runId: run.id,
      type: 'posicion-cantidad',
      ticker: 'AAPL',
      detail: 'AAPL: la app registra 10 uds y el broker 8 uds',
    });
    const second = repo.insertDiscrepancy({
      runId: run.id,
      type: 'orden-faltante-app',
      ticker: 'MSFT',
      detail: 'La orden tradia-fantasma-1 no tiene registro local',
    });

    const closed = repo.resolveDiscrepancy(first.id, '2026-10-08T21:05:00.000Z');
    expect(closed.status).toBe('resuelta');
    expect(closed.resolvedAt).toBe('2026-10-08T21:05:00.000Z');
    expect(repo.listOpenDiscrepancies().map((d) => d.id)).toEqual([second.id]);
    expect(() => repo.resolveDiscrepancy(999, '2026-10-08T21:06:00.000Z')).toThrow();
    // Resolver dos veces la misma no revienta ni la reabre.
    expect(repo.resolveDiscrepancy(first.id, '2026-10-08T21:07:00.000Z').status).toBe('resuelta');
  });
});

describe('repositorio de alertas de desviación', () => {
  const alertInput = {
    strategyId: 3,
    strategyName: 'Cruce de medias',
    period: 'semanal' as const,
    desde: '2026-10-05',
    hasta: '2026-10-11',
    expectedReturnPct: 1.5,
    realReturnPct: -2,
    deviationPp: -3.5,
    avgSlippageBps: 12,
    marginPp: 2,
    maxSlippageBps: 10,
  };

  it('inserta la alerta y no la duplica al recalcular el periodo', () => {
    const first = repo.insertDeviationAlert(alertInput);
    expect(first.inserted).toBe(true);
    const second = repo.insertDeviationAlert({ ...alertInput, deviationPp: -9 });
    expect(second.inserted).toBe(false);
    expect(second.alert.id).toBe(first.alert.id);
    // Los valores guardados son los de la primera vez: el aviso no se reescribe.
    expect(second.alert.deviationPp).toBe(-3.5);
    expect(repo.listDeviationAlerts()).toHaveLength(1);
  });

  it('lista por periodo y estrategia', () => {
    repo.insertDeviationAlert(alertInput);
    repo.insertDeviationAlert({ ...alertInput, period: 'mensual', desde: '2026-10-01' });
    repo.insertDeviationAlert({ ...alertInput, strategyId: 4, strategyName: 'RSI' });
    expect(repo.listDeviationAlerts({ period: 'semanal' })).toHaveLength(2);
    expect(repo.listDeviationAlerts({ strategyId: 3 })).toHaveLength(2);
    expect(repo.listDeviationAlerts({ period: 'mensual', strategyId: 4 })).toHaveLength(0);
  });
});
