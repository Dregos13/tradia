/**
 * Pruebas del contrato BrokerAdapter, ejecutadas igual sobre todos los
 * adaptadores (el simulado ahora; Alpaca paper se añade a la lista con sus
 * fixtures HTTP): si un adaptador nuevo se suma, hereda las mismas
 * garantías.
 */
import { describe, expect, it } from 'vitest';

import { BROKER_ORDER_OPEN_STATUSES } from '../../shared/broker';
import { createAlpacaFakeFetch } from './__fixtures__/fake-server';
import { createAlpacaBroker } from './alpaca';
import { createSimulatedBroker } from './simulated';
import {
  BROKER_ERROR_KINDS,
  BrokerError,
  isBrokerError,
  type BrokerAdapter,
  type BrokerOrderRequest,
} from './types';

const SIMULATED_NOW = Date.parse('2026-10-08T15:00:00.000Z');

const adapters: Array<{ name: string; make: () => BrokerAdapter }> = [
  {
    name: 'simulated',
    make: () => createSimulatedBroker({ seed: 'contract', now: () => SIMULATED_NOW }),
  },
  {
    name: 'alpaca',
    make: () =>
      createAlpacaBroker({
        fetch: createAlpacaFakeFetch(),
        getCredentials: async () => ({ apiKeyId: 'PK-TEST', apiSecret: 'SK-TEST' }),
      }),
  },
];

let orderSeq = 0;
const request = (patch: Partial<BrokerOrderRequest>): BrokerOrderRequest => ({
  clientOrderId: `tradia-contract-${++orderSeq}`,
  ticker: 'AAPL',
  type: 'market',
  side: 'buy',
  quantity: 5,
  ...patch,
});

const OPEN = BROKER_ORDER_OPEN_STATUSES as readonly string[];

describe.each(adapters)('contrato BrokerAdapter — $name', ({ make }) => {
  it('declara id estable y modo solo paper', () => {
    const adapter = make();
    expect(adapter.id).toEqual(expect.any(String));
    expect(adapter.id.length).toBeGreaterThan(0);
    expect(adapter.paperOnly).toBe(true);
  });

  it('getAccount devuelve una cuenta paper con saldo', async () => {
    const adapter = make();
    const account = await adapter.getAccount();
    expect(account.paper).toBe(true);
    expect(account.accountId).toEqual(expect.any(String));
    expect(account.currency).toBe('USD');
    expect(account.cash).toBeGreaterThan(0);
    expect(account.equity).toBeGreaterThanOrEqual(account.cash - 0.01);
  });

  it('una orden de mercado queda ejecutada con precio y hora', async () => {
    const adapter = make();
    const order = await adapter.submitOrder(request({ type: 'market' }));
    expect(order.clientOrderId).toBeTruthy();
    expect(order.brokerOrderId).toEqual(expect.any(String));
    expect(order.type).toBe('market');
    expect(order.side).toBe('buy');
    expect(order.quantity).toBe(5);
    expect(order.status).toBe('ejecutada');
    expect(order.filledQuantity).toBe(5);
    expect(order.filledAvgPrice).toBeGreaterThan(0);
    expect(order.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(order.filledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('una limitada lejos de mercado queda abierta y se cancela', async () => {
    const adapter = make();
    const order = await adapter.submitOrder(request({ type: 'limit', limitPrice: 0.01 }));
    expect(order.status).toBe('enviada');
    expect(order.filledQuantity).toBe(0);
    expect(order.filledAvgPrice).toBeNull();
    expect(order.limitPrice).toBe(0.01);

    const canceled = await adapter.cancelOrder(order.brokerOrderId);
    expect(canceled.status).toBe('cancelada');
    expect(canceled.brokerOrderId).toBe(order.brokerOrderId);
  });

  it('una orden stop lejos de dispararse queda abierta', async () => {
    const adapter = make();
    const order = await adapter.submitOrder(
      request({ type: 'stop', side: 'sell', stopPrice: 0.01 }),
    );
    expect(order.status).toBe('enviada');
    expect(order.stopPrice).toBe(0.01);
    await adapter.cancelOrder(order.brokerOrderId);
  });

  it('una OCO lleva sus dos patas (objetivo limit + stop)', async () => {
    const adapter = make();
    const order = await adapter.submitOrder(
      request({ type: 'oco', side: 'sell', limitPrice: 999_999, stopPrice: 0.01 }),
    );
    expect(order.type).toBe('oco');
    expect(OPEN).toContain(order.status);
    expect(order.limitPrice).toBe(999_999);
    expect(order.stopPrice).toBe(0.01);
    expect(order.ocoGroupId).toBeTruthy();
    expect(order.legs).toHaveLength(2);
    const kinds = order.legs!.map((leg) => leg.type).sort();
    expect(kinds).toEqual(['limit', 'stop']);
    await adapter.cancelOrder(order.brokerOrderId);
  });

  it('getOrderByClientId encuentra la enviada y null la desconocida', async () => {
    const adapter = make();
    const order = await adapter.submitOrder(request({ type: 'market' }));
    const found = await adapter.getOrderByClientId(order.clientOrderId);
    expect(found?.brokerOrderId).toBe(order.brokerOrderId);
    expect(found?.status).toBe(order.status);
    expect(await adapter.getOrderByClientId('tradia-inexistente')).toBeNull();
  });

  it('listOrders devuelve las enviadas y openOnly filtra las cerradas', async () => {
    const adapter = make();
    const open = await adapter.submitOrder(request({ type: 'limit', limitPrice: 0.01 }));
    await adapter.submitOrder(request({ type: 'market' }));
    const all = await adapter.listOrders();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const openOnly = await adapter.listOrders({ openOnly: true });
    expect(openOnly.map((o) => o.brokerOrderId)).toContain(open.brokerOrderId);
    expect(openOnly.every((o) => OPEN.includes(o.status))).toBe(true);
  });

  it('cancelar una orden desconocida o cerrada lanza BrokerError tipado', async () => {
    const adapter = make();
    await expect(adapter.cancelOrder('orden-que-no-existe')).rejects.toMatchObject({
      name: 'BrokerError',
      kind: 'not-found',
    });
    const closed = await adapter.submitOrder(request({ type: 'market' }));
    const error = await adapter.cancelOrder(closed.brokerOrderId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrokerError);
    expect(BROKER_ERROR_KINDS).toContain((error as BrokerError).kind);
    expect((error as BrokerError).retryable).toBe(false);
  });

  it('rechaza entradas inválidas con BrokerError bad-data', async () => {
    const adapter = make();
    await expect(adapter.submitOrder(request({ ticker: '!!!' }))).rejects.toMatchObject({
      kind: 'bad-data',
    });
    await expect(adapter.submitOrder(request({ quantity: 0 }))).rejects.toMatchObject({
      kind: 'bad-data',
    });
    await expect(adapter.submitOrder(request({ type: 'limit' }))).rejects.toMatchObject({
      kind: 'bad-data',
    });
    await expect(
      adapter.submitOrder(request({ type: 'oco', limitPrice: 100 })),
    ).rejects.toMatchObject({ kind: 'bad-data' });
  });

  it('los errores son BrokerError con kind tipado y flag retryable', async () => {
    const adapter = make();
    const error = await adapter.cancelOrder('nope').catch((e: unknown) => e);
    expect(isBrokerError(error)).toBe(true);
    expect(isBrokerError(error, 'not-found')).toBe(true);
    expect(isBrokerError(error, 'auth')).toBe(false);
    for (const kind of ['rate-limit', 'server', 'timeout', 'network'] as const) {
      expect(new BrokerError(kind, 'x', { adapter: 't' }).retryable).toBe(true);
    }
    for (const kind of ['auth', 'reject', 'not-found', 'bad-data'] as const) {
      expect(new BrokerError(kind, 'x', { adapter: 't' }).retryable).toBe(false);
    }
  });
});
