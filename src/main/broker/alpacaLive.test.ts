/**
 * Pruebas del adaptador Alpaca live (`alpacaLive.ts`): la puerta de la
 * lista, la URL fija real y el contrato completo contra el servidor
 * falso live (`createAlpacaLiveFakeFetch`): mercado fraccionario, OCO,
 * cancelación y errores.
 */
import { describe, expect, it, vi } from 'vitest';

import accountFixture from './__fixtures__/account.json';
import { createAlpacaLiveFakeFetch } from './__fixtures__/fake-server';
import {
  ALPACA_LIVE_ADAPTER_ID,
  ALPACA_LIVE_BASE_URL,
  createAlpacaLiveBroker,
  type AlpacaLiveBrokerDeps,
} from './alpacaLive';
import { ALPACA_PAPER_BASE_URL } from './alpaca';
import { BrokerError, isBrokerError, type BrokerOrderRequest } from './types';

const LIVE_CREDS = { apiKeyId: 'AK-SECRETO-de-prueba-123', apiSecret: 'SK-secreto-456' };
const PAPER_CREDS = { apiKeyId: 'PK-SECRETO-de-prueba-123', apiSecret: 'SK-secreto-456' };

const makeDeps = (extra: Partial<AlpacaLiveBrokerDeps> = {}): AlpacaLiveBrokerDeps => ({
  fetch: createAlpacaLiveFakeFetch({ prices: { SPY: 500, AAPL: 250 } }),
  getCredentials: async () => LIVE_CREDS,
  isLiveGateOpen: () => true,
  ...extra,
});

let orderSeq = 0;
const request = (patch: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest => ({
  clientOrderId: `tradia-live-test-${++orderSeq}`,
  ticker: 'SPY',
  type: 'market',
  side: 'buy',
  quantity: 1,
  ...patch,
});

describe('adaptador Alpaca live — puerta de la lista', () => {
  it('sin la lista cumplida el adaptador no se puede crear', () => {
    expect(() => createAlpacaLiveBroker(makeDeps({ isLiveGateOpen: () => false }))).toThrowError(
      BrokerError,
    );
    let thrown: unknown;
    try {
      createAlpacaLiveBroker(makeDeps({ isLiveGateOpen: () => false }));
    } catch (error) {
      thrown = error;
    }
    expect(isBrokerError(thrown, 'reject')).toBe(true);
    expect((thrown as BrokerError).adapter).toBe(ALPACA_LIVE_ADAPTER_ID);
  });

  it('la puerta se vuelve a comprobar antes de cada envío', async () => {
    let open = true;
    const fetch = vi.fn(createAlpacaLiveFakeFetch());
    const adapter = createAlpacaLiveBroker(makeDeps({ fetch, isLiveGateOpen: () => open }));
    open = false;
    const postsBefore = fetch.mock.calls.filter(([, init]) => init?.method === 'POST').length;
    await expect(adapter.submitOrder(request())).rejects.toMatchObject({
      name: 'BrokerError',
      kind: 'reject',
      adapter: ALPACA_LIVE_ADAPTER_ID,
    });
    // El envío quedó bloqueado antes de la red: no hubo POST nuevo.
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
      postsBefore,
    );
  });

  it('la cuenta y las lecturas siguen funcionando con la puerta cerrada', async () => {
    let open = true;
    const adapter = createAlpacaLiveBroker(makeDeps({ isLiveGateOpen: () => open }));
    open = false;
    // Consultar no envía dinero: solo los envíos se bloquean.
    await expect(adapter.listOrders()).resolves.toEqual([]);
  });
});

describe('adaptador Alpaca live — URL fija real', () => {
  it.each([
    ALPACA_PAPER_BASE_URL,
    'https://paper-api.alpaca.markets',
    'http://localhost:9999',
    'https://api.alpaca.markets.evil.test',
    'https://api2.alpaca.markets',
  ])('rechaza en el constructor la URL %s', (baseUrl) => {
    let thrown: unknown;
    try {
      createAlpacaLiveBroker(makeDeps({ baseUrl }));
    } catch (error) {
      thrown = error;
    }
    expect(isBrokerError(thrown, 'bad-data')).toBe(true);
  });

  it('solo llama a api.alpaca.markets y declara no-paper', async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(String(input));
      return createAlpacaLiveFakeFetch()(input, init);
    };
    const adapter = createAlpacaLiveBroker(makeDeps({ fetch }));
    expect(adapter.id).toBe(ALPACA_LIVE_ADAPTER_ID);
    expect(adapter.paperOnly).toBe(false);
    const account = await adapter.getAccount();
    expect(account.paper).toBe(false);
    expect(calls.every((url) => url.startsWith(ALPACA_LIVE_BASE_URL))).toBe(true);
    expect(calls[0]).toBe(`${ALPACA_LIVE_BASE_URL}/v2/account`);
  });
});

describe('adaptador Alpaca live — contrato contra el servidor falso live', () => {
  const make = () => createAlpacaLiveBroker(makeDeps());

  it('una orden de mercado fraccionaria ejecuta y llega con qty decimal', async () => {
    const fetch = vi.fn(createAlpacaLiveFakeFetch({ prices: { SPY: 500 } }));
    const adapter = createAlpacaLiveBroker(makeDeps({ fetch }));
    const order = await adapter.submitOrder(request({ quantity: 0.02 }));
    expect(order.status).toBe('ejecutada');
    expect(order.quantity).toBe(0.02);
    expect(order.filledQuantity).toBe(0.02);
    expect(order.filledAvgPrice).toBe(500);
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ symbol: 'SPY', qty: '0.02', type: 'market', side: 'buy' });
  });

  it('una OCO lleva sus dos patas y gtc; cancelarla la marca cancelada', async () => {
    const adapter = make();
    const order = await adapter.submitOrder(
      request({ type: 'oco', side: 'sell', limitPrice: 999_999, stopPrice: 0.01 }),
    );
    expect(order.type).toBe('oco');
    expect(order.limitPrice).toBe(999_999);
    expect(order.stopPrice).toBe(0.01);
    expect(order.ocoGroupId).toBe(order.brokerOrderId);
    expect(order.legs).toHaveLength(2);
    expect(order.legs!.map((leg) => leg.type).sort()).toEqual(['limit', 'stop']);

    const canceled = await adapter.cancelOrder(order.brokerOrderId);
    expect(canceled.status).toBe('cancelada');
    expect(canceled.brokerOrderId).toBe(order.brokerOrderId);
  });

  it('una limitada queda abierta y se encuentra por client_order_id', async () => {
    const adapter = make();
    const order = await adapter.submitOrder(
      request({ type: 'limit', limitPrice: 0.01, timeInForce: 'gtc' }),
    );
    expect(order.status).toBe('enviada');
    const found = await adapter.getOrderByClientId(order.clientOrderId);
    expect(found?.brokerOrderId).toBe(order.brokerOrderId);
    expect(await adapter.getOrderByClientId('tradia-inexistente')).toBeNull();
  });

  it('unas claves paper en el endpoint live reciben auth sin guardar nada', async () => {
    const adapter = createAlpacaLiveBroker(makeDeps({ getCredentials: async () => PAPER_CREDS }));
    await expect(adapter.getAccount()).rejects.toMatchObject({
      name: 'BrokerError',
      kind: 'auth',
      adapter: ALPACA_LIVE_ADAPTER_ID,
    });
  });

  it('un client_order_id repetido es reject y una cancelación desconocida not-found', async () => {
    const adapter = make();
    const once = request();
    await adapter.submitOrder(once);
    const repeated = await adapter.submitOrder(once).catch((e: unknown) => e);
    expect(isBrokerError(repeated, 'reject')).toBe(true);
    await expect(adapter.cancelOrder('orden-que-no-existe')).rejects.toMatchObject({
      kind: 'not-found',
    });
    const closed = await adapter.submitOrder(request({ type: 'market' }));
    await expect(adapter.cancelOrder(closed.brokerOrderId)).rejects.toMatchObject({
      kind: 'reject',
    });
  });

  it('la cuenta live reporta saldo y posiciones igual que en paper', async () => {
    const adapter = make();
    const account = await adapter.getAccount();
    expect(account).toMatchObject({
      accountId: accountFixture.account_number,
      status: 'ACTIVE',
      currency: 'USD',
      paper: false,
    });
    const positions = await adapter.listPositions();
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((p) => p.currency === 'USD')).toBe(true);
  });
});
