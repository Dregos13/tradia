import { describe, expect, it } from 'vitest';

import { createSimulatedBroker, type SimulatedBroker } from './simulated';
import type { BrokerOrderRequest } from './types';

const NOW = Date.parse('2026-10-08T15:00:00.000Z');

const make = (patch: Parameters<typeof createSimulatedBroker>[0] = {}): SimulatedBroker =>
  createSimulatedBroker({ seed: 'sim-test', now: () => NOW, prices: { AAPL: 200 }, ...patch });

let seq = 0;
const request = (patch: Partial<BrokerOrderRequest>): BrokerOrderRequest => ({
  clientOrderId: `tradia-${++seq}`,
  ticker: 'AAPL',
  type: 'market',
  side: 'buy',
  quantity: 10,
  ...patch,
});

describe('broker simulado · ejecución determinista', () => {
  it('una market compra con slippage fijo desfavorable y abre posición', async () => {
    const broker = make({ slippageBps: 10 });
    const order = await broker.submitOrder(request({}));
    expect(order.status).toBe('ejecutada');
    // 200 × (1 + 10 pb) = 200,2
    expect(order.filledAvgPrice).toBeCloseTo(200.2, 4);
    const positions = await broker.listPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      ticker: 'AAPL',
      side: 'long',
      quantity: 10,
      avgEntryPrice: 200.2,
    });
    const account = await broker.getAccount();
    expect(account.cash).toBeCloseTo(100_000 - 200.2 * 10, 2);
  });

  it('una market de venta ejecuta por debajo de la referencia', async () => {
    const broker = make({ slippageBps: 10 });
    const order = await broker.submitOrder(request({ side: 'sell' }));
    expect(order.filledAvgPrice).toBeCloseTo(199.8, 4);
    const positions = await broker.listPositions();
    expect(positions[0]!.side).toBe('short');
  });

  it('misma semilla y mismo ticker dan el mismo precio de referencia', async () => {
    const a = createSimulatedBroker({ seed: 'x', now: () => NOW });
    const b = createSimulatedBroker({ seed: 'x', now: () => NOW });
    const [orderA, orderB] = await Promise.all([
      a.submitOrder(request({})),
      b.submitOrder(request({ clientOrderId: 'otro-id' })),
    ]);
    expect(orderA.filledAvgPrice).toBe(orderB.filledAvgPrice);
  });

  it('una limit cruzable ejecuta al mejor precio y queda posición', async () => {
    const broker = make();
    const order = await broker.submitOrder(request({ type: 'limit', limitPrice: 210 }));
    expect(order.status).toBe('ejecutada');
    expect(order.filledAvgPrice).toBe(200); // mejora sobre el límite 210
  });

  it('una limit no cruzable espera y ejecuta al mover el precio (tick)', async () => {
    const broker = make();
    const order = await broker.submitOrder(request({ type: 'limit', limitPrice: 150 }));
    expect(order.status).toBe('enviada');
    broker.setPrice('AAPL', 145);
    broker.tick('AAPL');
    const found = await broker.getOrderByClientId(order.clientOrderId);
    expect(found?.status).toBe('ejecutada');
    expect(found?.filledAvgPrice).toBe(145);
  });

  it('una stop se dispara con el precio y ejecuta con el hueco en contra', async () => {
    const broker = make();
    const order = await broker.submitOrder(
      request({ type: 'stop', side: 'buy', stopPrice: 210 }),
    );
    expect(order.status).toBe('enviada');
    broker.setPrice('AAPL', 220);
    broker.tick('AAPL');
    const found = await broker.getOrderByClientId(order.clientOrderId);
    expect(found?.status).toBe('ejecutada');
    expect(found?.filledAvgPrice).toBe(220); // peor que el stop 210
  });

  it('un OCO ejecuta el stop cuando cae el precio y cancela el objetivo', async () => {
    const broker = make();
    const order = await broker.submitOrder(
      request({ type: 'oco', side: 'sell', limitPrice: 220, stopPrice: 190 }),
    );
    expect(order.status).toBe('enviada');
    expect(order.legs).toHaveLength(2);
    broker.setPrice('AAPL', 180);
    broker.tick('AAPL');
    const found = await broker.getOrderByClientId(order.clientOrderId);
    expect(found?.status).toBe('ejecutada');
    expect(found?.filledAvgPrice).toBe(180);
    const legs = found!.legs!;
    expect(legs.find((l) => l.type === 'stop')?.status).toBe('ejecutada');
    expect(legs.find((l) => l.type === 'limit')?.status).toBe('cancelada');
  });

  it('un OCO ejecuta el objetivo cuando sube el precio', async () => {
    const broker = make();
    const order = await broker.submitOrder(
      request({ type: 'oco', side: 'sell', limitPrice: 220, stopPrice: 190 }),
    );
    broker.setPrice('AAPL', 230);
    broker.tick('AAPL');
    const found = await broker.getOrderByClientId(order.clientOrderId);
    expect(found?.status).toBe('ejecutada');
    expect(found?.legs!.find((l) => l.type === 'limit')?.status).toBe('ejecutada');
  });

  it('si ambas patas del OCO tocan en el mismo tick gana el stop', async () => {
    const broker = make();
    const order = await broker.submitOrder(
      request({ type: 'oco', side: 'sell', limitPrice: 190, stopPrice: 210 }),
    );
    // Con side 'sell': stop se dispara si ref ≤ 210 y objetivo si ref ≥ 190;
    // a 200 tocan las dos: gana el stop.
    const found = await broker.getOrderByClientId(order.clientOrderId);
    expect(found?.status).toBe('ejecutada');
    expect(found?.legs!.find((l) => l.type === 'stop')?.status).toBe('ejecutada');
    expect(found?.legs!.find((l) => l.type === 'limit')?.status).toBe('cancelada');
  });

  it('un client_order_id duplicado se rechaza como en un broker real', async () => {
    const broker = make();
    await broker.submitOrder(request({ clientOrderId: 'mismo-id' }));
    await expect(broker.submitOrder(request({ clientOrderId: 'mismo-id' }))).rejects.toMatchObject(
      {
        name: 'BrokerError',
        kind: 'reject',
      },
    );
  });
});

describe('broker simulado · fallos inyectables', () => {
  it('timeout: la orden queda registrada pero la respuesta se pierde', async () => {
    const broker = make();
    broker.failNext('timeout');
    await expect(broker.submitOrder(request({}))).rejects.toMatchObject({ kind: 'timeout' });
    // Ambigüedad real: getOrderByClientId sí la encuentra (un reintento la ve).
    const found = await broker.getOrderByClientId(`tradia-${seq}`);
    expect(found).not.toBeNull();
    expect(found?.status).toBe('ejecutada');
  });

  it('rate-limit y server son reintentables y no registran la orden', async () => {
    const broker = make();
    broker.failNext('rate-limit');
    await expect(broker.submitOrder(request({}))).rejects.toMatchObject({
      kind: 'rate-limit',
      status: 429,
      retryAfterMs: 1000,
    });
    broker.failNext('server');
    await expect(broker.submitOrder(request({}))).rejects.toMatchObject({ kind: 'server' });
    expect(await broker.listOrders()).toHaveLength(0);
    // Agotados los fallos, el siguiente envío entra normal.
    const order = await broker.submitOrder(request({ clientOrderId: 'ok' }));
    expect(order.status).toBe('ejecutada');
  });

  it('reject no es reintentable y no registra la orden', async () => {
    const broker = make();
    broker.failNext('reject');
    const error = await broker.submitOrder(request({})).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'reject', retryable: false });
    expect(await broker.listOrders()).toHaveLength(0);
  });

  it('partial deja la orden parcialmente ejecutada', async () => {
    const broker = make();
    broker.failNext('partial');
    const order = await broker.submitOrder(request({ quantity: 10 }));
    expect(order.status).toBe('parcial');
    expect(order.filledQuantity).toBe(5);
    expect(order.filledAvgPrice).toBeGreaterThan(0);
  });

  it('setFailing afecta a cualquier método hasta retirarlo', async () => {
    const broker = make();
    broker.setFailing('server');
    await expect(broker.getAccount()).rejects.toMatchObject({ kind: 'server' });
    await expect(broker.listPositions()).rejects.toMatchObject({ kind: 'server' });
    broker.setFailing(null);
    await expect(broker.getAccount()).resolves.toMatchObject({ paper: true });
  });
});

describe('broker simulado · descuadres fabricados', () => {
  it('dropOrder borra una orden del lado del broker', async () => {
    const broker = make();
    const order = await broker.submitOrder(request({ type: 'limit', limitPrice: 100 }));
    expect(broker.dropOrder(order.clientOrderId)).toBe(true);
    expect(broker.dropOrder(order.clientOrderId)).toBe(false);
    expect(await broker.getOrderByClientId(order.clientOrderId)).toBeNull();
  });

  it('injectPhantomOrder crea una orden tradia-* sin registro de la app', async () => {
    const broker = make();
    const phantom = broker.injectPhantomOrder({ ticker: 'MSFT', quantity: 3 });
    expect(phantom.clientOrderId).toMatch(/^tradia-fantasma-/);
    expect(phantom.status).toBe('enviada');
    const all = await broker.listOrders({ openOnly: true });
    expect(all.map((o) => o.clientOrderId)).toContain(phantom.clientOrderId);
  });

  it('tamperPosition altera la cantidad que el broker reporta', async () => {
    const broker = make();
    await broker.submitOrder(request({ quantity: 10 }));
    broker.tamperPosition('AAPL', { quantity: 8 });
    const positions = await broker.listPositions();
    expect(positions[0]!.quantity).toBe(8);
    expect(positions[0]!.avgEntryPrice).toBeGreaterThan(0);
  });

  it('reset vuelve al estado inicial', async () => {
    const broker = make({ cash: 50_000 });
    await broker.submitOrder(request({}));
    broker.tamperPosition('AAPL', { quantity: 99 });
    broker.failNext('server');
    broker.reset();
    expect(await broker.listOrders()).toHaveLength(0);
    expect(await broker.listPositions()).toHaveLength(0);
    const account = await broker.getAccount();
    expect(account.cash).toBe(50_000);
    expect(account.equity).toBe(50_000);
  });
});
