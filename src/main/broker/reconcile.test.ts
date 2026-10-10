import { describe, expect, it } from 'vitest';

import type { BrokerOrder, BrokerPosition, OrderExecution } from '../../shared/broker';
import {
  positionsFromOrders,
  reconcileBrokerState,
  RECONCILE_PENDING_GRACE_MS,
  RECONCILE_PRICE_TOLERANCE,
} from './reconcile';
import type { RemoteOrder } from './types';

const NOW = Date.parse('2026-10-08T21:00:00.000Z');
const T0 = '2026-10-08T20:00:00.000Z';
const T1 = '2026-10-08T20:00:01.000Z';

let orderSeq = 0;

type OrderPatch = Partial<Omit<BrokerOrder, 'execution'>> & {
  execution?: Partial<OrderExecution>;
};

const makeOrder = (patch: OrderPatch = {}): BrokerOrder => {
  const { execution, ...rest } = patch;
  return {
    id: ++orderSeq,
    clientOrderId: `tradia-${orderSeq}-entrada`,
    brokerOrderId: `sim-${orderSeq}`,
    signalId: orderSeq,
    strategyId: 3,
    leg: 'entrada',
    ticker: 'AAPL',
    type: 'market',
    side: 'buy',
    quantity: 10,
    filledQuantity: 10,
    limitPrice: null,
    stopPrice: null,
    ocoGroupId: null,
    execution: {
      requestedAt: T0,
      requestedPrice: 100,
      executedAt: T1,
      executedPrice: 100,
      slippageBps: 0,
      ...(execution ?? {}),
    },
    status: 'ejecutada',
    attempts: 1,
    rejectReason: null,
    createdAt: T0,
    updatedAt: T1,
    ...rest,
  };
};

const makeRemote = (patch: Partial<RemoteOrder> = {}): RemoteOrder => ({
  brokerOrderId: 'sim-99',
  clientOrderId: 'tradia-99-entrada',
  ticker: 'AAPL',
  type: 'limit',
  side: 'buy',
  quantity: 5,
  filledQuantity: 0,
  limitPrice: 99,
  stopPrice: null,
  status: 'enviada',
  submittedAt: T0,
  filledAt: null,
  filledAvgPrice: null,
  ocoGroupId: null,
  legs: null,
  ...patch,
});

const position = (
  ticker: string,
  side: 'long' | 'short',
  quantity: number,
  avgEntryPrice: number,
): BrokerPosition => ({
  ticker,
  side,
  quantity,
  avgEntryPrice,
  marketValue: null,
  unrealizedPnl: null,
  currency: 'USD',
});

const compare = (input: Parameters<typeof reconcileBrokerState>[0]) =>
  reconcileBrokerState(input, { nowMs: NOW }).discrepancies;

describe('positionsFromOrders · posiciones según la app', () => {
  it('deriva una posición larga de la entrada ejecutada y la cierra con la salida', () => {
    const orders = [
      makeOrder({ filledQuantity: 10, execution: { executedPrice: 100 } }),
      makeOrder({
        clientOrderId: 'tradia-1-salida',
        leg: 'salida',
        type: 'oco',
        side: 'sell',
        filledQuantity: 10,
        execution: { executedPrice: 105, executedAt: '2026-10-08T20:30:00.000Z' },
      }),
    ];
    expect(positionsFromOrders(orders.slice(0, 1))).toEqual([
      { ticker: 'AAPL', side: 'long', quantity: 10, avgEntryPrice: 100 },
    ]);
    // Entrada y salida ejecutadas: la posición queda cerrada.
    expect(positionsFromOrders(orders)).toEqual([]);
  });

  it('pondera el precio medio en aumentos, lo conserva en reducciones y lo reinicia al cruzar', () => {
    const orders = [
      makeOrder({ filledQuantity: 10, execution: { executedPrice: 100 } }),
      makeOrder({
        clientOrderId: 'tradia-2-entrada',
        filledQuantity: 10,
        execution: { executedPrice: 110, executedAt: '2026-10-08T20:10:00.000Z' },
      }),
    ];
    expect(positionsFromOrders(orders)[0]).toMatchObject({ quantity: 20, avgEntryPrice: 105 });

    const reduced = [
      ...orders,
      makeOrder({
        clientOrderId: 'tradia-3-salida',
        leg: 'salida',
        side: 'sell',
        filledQuantity: 15,
        execution: { executedPrice: 120, executedAt: '2026-10-08T20:20:00.000Z' },
      }),
    ];
    // Quedan 5 uds: el medio se conserva en la reducción.
    expect(positionsFromOrders(reduced)[0]).toMatchObject({ quantity: 5, avgEntryPrice: 105 });

    const crossed = [
      makeOrder({ filledQuantity: 10, execution: { executedPrice: 100 } }),
      makeOrder({
        clientOrderId: 'tradia-4-salida',
        leg: 'salida',
        side: 'sell',
        quantity: 15,
        filledQuantity: 15,
        execution: { executedPrice: 110, executedAt: '2026-10-08T20:20:00.000Z' },
      }),
    ];
    // Cruce de signo: el corto abre al precio de la ejecución que cruza.
    expect(positionsFromOrders(crossed)[0]).toMatchObject({
      side: 'short',
      quantity: 5,
      avgEntryPrice: 110,
    });
  });

  it('cuenta las parciales por su ejecutado y excluye huérfanas y no ejecutadas', () => {
    const orders = [
      makeOrder({ status: 'parcial', filledQuantity: 4, quantity: 10 }),
      makeOrder({ clientOrderId: 'x-huerfana', status: 'huerfana', filledQuantity: 7 }),
      makeOrder({ clientOrderId: 'x-enviada', status: 'enviada', filledQuantity: 0 }),
    ];
    expect(positionsFromOrders(orders)).toEqual([
      { ticker: 'AAPL', side: 'long', quantity: 4, avgEntryPrice: 100 },
    ]);
  });
});

describe('reconcileBrokerState · posiciones', () => {
  const appLong10 = [makeOrder({ filledQuantity: 10, execution: { executedPrice: 100 } })];

  it('una posición y una orden abiertas iguales en ambos lados no avisan', () => {
    const found = compare({
      appOrders: [
        ...appLong10,
        makeOrder({ clientOrderId: 'o-1', status: 'enviada', quantity: 5, filledQuantity: 0 }),
      ],
      brokerPositions: [position('AAPL', 'long', 10, 100)],
      brokerOpenOrders: [makeRemote({ clientOrderId: 'o-1' })],
    });
    expect(found).toEqual([]);
  });

  it('cantidad distinta en el broker → posicion-cantidad con texto legible', () => {
    const found = compare({
      appOrders: appLong10,
      brokerPositions: [position('AAPL', 'long', 8, 100)],
      brokerOpenOrders: [],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: 'posicion-cantidad', ticker: 'AAPL' });
    expect(found[0]!.detail).toContain('AAPL');
    expect(found[0]!.detail).toContain('10');
    expect(found[0]!.detail).toContain('8');
    expect(found[0]!.appValue).toBe('10 uds');
    expect(found[0]!.brokerValue).toBe('8 uds');
  });

  it('precio medio con más de un céntimo → posicion-precio; dentro, nada', () => {
    const base = {
      appOrders: appLong10,
      brokerOpenOrders: [] as RemoteOrder[],
    };
    const over = compare({ ...base, brokerPositions: [position('AAPL', 'long', 10, 100.02)] });
    expect(over.map((d) => d.type)).toEqual(['posicion-precio']);
    expect(over[0]!.detail).toContain('100,00');
    expect(over[0]!.detail).toContain('100,02');
    // La tolerancia es de un céntimo (inclusive).
    const within = compare({
      ...base,
      brokerPositions: [position('AAPL', 'long', 10, 100 + RECONCILE_PRICE_TOLERANCE)],
    });
    expect(within).toEqual([]);
  });

  it('posición solo en un lado → faltante en el otro', () => {
    const onlyApp = compare({
      appOrders: appLong10,
      brokerPositions: [],
      brokerOpenOrders: [],
    });
    expect(onlyApp.map((d) => d.type)).toEqual(['posicion-faltante-broker']);
    expect(onlyApp[0]!.brokerValue).toBe('sin posición');

    const onlyBroker = compare({
      appOrders: [],
      brokerPositions: [position('MSFT', 'short', 7, 210)],
      brokerOpenOrders: [],
    });
    expect(onlyBroker.map((d) => d.type)).toEqual(['posicion-faltante-app']);
    expect(onlyBroker[0]!.ticker).toBe('MSFT');
    expect(onlyBroker[0]!.appValue).toBe('sin posición');
    expect(onlyBroker[0]!.brokerValue).toContain('corto');
  });

  it('lados opuestos en el mismo activo → posicion-cantidad mencionando el lado', () => {
    const found = compare({
      appOrders: appLong10,
      brokerPositions: [position('AAPL', 'short', 10, 100)],
      brokerOpenOrders: [],
    });
    expect(found.map((d) => d.type)).toEqual(['posicion-cantidad']);
    expect(found[0]!.detail).toContain('largo');
    expect(found[0]!.detail).toContain('corto');
  });
});

describe('reconcileBrokerState · órdenes abiertas', () => {
  it('abierta en la app y desconocida por el broker → orden-faltante-broker', () => {
    const found = compare({
      appOrders: [makeOrder({ clientOrderId: 'tradia-1-salida', status: 'enviada' })],
      brokerPositions: [],
      brokerOpenOrders: [],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: 'orden-faltante-broker', ticker: 'AAPL' });
    expect(found[0]!.detail).toContain('tradia-1-salida');
    expect(found[0]!.brokerValue).toBe('ausente');
  });

  it('abierta en el broker sin registro local → orden-faltante-app', () => {
    const found = compare({
      appOrders: [],
      brokerPositions: [],
      brokerOpenOrders: [makeRemote({ clientOrderId: 'tradia-fantasma-1' })],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: 'orden-faltante-app', ticker: 'AAPL' });
    expect(found[0]!.detail).toContain('tradia-fantasma-1');
    expect(found[0]!.appValue).toBe('sin registro');
  });

  it('cerrada en la app y abierta en el broker, o cantidad distinta → orden-estado', () => {
    const brokerSide = [position('AAPL', 'long', 10, 100)];
    const closed = compare({
      appOrders: [makeOrder({ clientOrderId: 'tradia-9-entrada', status: 'ejecutada' })],
      brokerPositions: brokerSide,
      brokerOpenOrders: [makeRemote({ clientOrderId: 'tradia-9-entrada', quantity: 10 })],
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.type).toBe('orden-estado');
    expect(closed[0]!.detail).toContain('ejecutada');
    expect(closed[0]!.detail).toContain('enviada');

    const qty = compare({
      appOrders: [
        makeOrder({
          clientOrderId: 'tradia-9-entrada',
          status: 'parcial',
          quantity: 10,
          filledQuantity: 4,
        }),
      ],
      brokerPositions: [position('AAPL', 'long', 4, 100)],
      brokerOpenOrders: [makeRemote({ clientOrderId: 'tradia-9-entrada', quantity: 8 })],
    });
    expect(qty).toHaveLength(1);
    expect(qty[0]!.detail).toContain('10 uds');
    expect(qty[0]!.detail).toContain('8 uds');
  });

  it('una pendiente reciente no cuenta; pasada la gracia sí', () => {
    const fresh = makeOrder({
      clientOrderId: 'tradia-5-entrada',
      status: 'pendiente',
      execution: { requestedAt: new Date(NOW - 30_000).toISOString() },
    });
    const stale = makeOrder({
      clientOrderId: 'tradia-6-entrada',
      status: 'pendiente',
      execution: { requestedAt: new Date(NOW - RECONCILE_PENDING_GRACE_MS - 1).toISOString() },
    });
    const found = compare({
      appOrders: [fresh, stale],
      brokerPositions: [],
      brokerOpenOrders: [],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('tradia-6-entrada');
  });
});
