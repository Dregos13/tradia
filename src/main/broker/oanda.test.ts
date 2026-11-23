/**
 * Adaptador OANDA v20 contra respuestas grabadas (`__fixtures__/oanda/`):
 * ninguna prueba toca la red. Un `fetch` falso enruta cada petición a su
 * respuesta y guarda lo que se envió para comprobar URL, cabeceras y cuerpo.
 */
import { describe, expect, it, vi } from 'vitest';

import accountSummary from './__fixtures__/oanda/account-summary.json';
import error400Reject from './__fixtures__/oanda/error-400-reject.json';
import error401 from './__fixtures__/oanda/error-401.json';
import error404Order from './__fixtures__/oanda/error-404-order.json';
import openPositions from './__fixtures__/oanda/open-positions.json';
import orderByClientId from './__fixtures__/oanda/order-by-client-id.json';
import orderMarketCancelled from './__fixtures__/oanda/order-market-cancelled.json';
import orderMarketFilled from './__fixtures__/oanda/order-market-filled.json';
import pendingOrders from './__fixtures__/oanda/pending-orders.json';
import positionClose from './__fixtures__/oanda/position-close.json';
import positionEurUsd from './__fixtures__/oanda/position-eur-usd.json';
import pricing from './__fixtures__/oanda/pricing.json';
import transactionFill from './__fixtures__/oanda/transaction-fill.json';
import { createOandaFakeServer } from './__fixtures__/oanda-fake-server';
import {
  createOandaBroker,
  OANDA_LIVE_BASE_URL,
  OANDA_PRACTICE_BASE_URL,
  type OandaBrokerDeps,
} from './oanda';
import { BrokerError } from './types';

const TOKEN = 'a'.repeat(32) + '-' + 'b'.repeat(32);
const ACCOUNT = '101-004-1234567-001';
const LIVE_ACCOUNT = '001-004-7654321-001';

type Route = { status?: number; body: unknown; headers?: Record<string, string> };

function recordedFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: { method: string; url: string; headers: Headers; body: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = new URL(url).pathname + new URL(url).search;
    const key = `${method} ${path}`;
    const entry = routes[key];
    if (!entry)
      return new Response(JSON.stringify({ errorMessage: `sin ruta ${key}` }), { status: 404 });
    const route = typeof entry === 'function' ? entry() : entry;
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...route.headers },
    });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const base = `/v3/accounts/${ACCOUNT}`;

function practice(
  routes: Record<string, Route | (() => Route)>,
  extra: Partial<OandaBrokerDeps> = {},
) {
  const recorded = recordedFetch(routes);
  const adapter = createOandaBroker('practice', {
    fetch: recorded.fetch,
    getCredentials: async () => ({ token: TOKEN, accountId: ACCOUNT }),
    ...extra,
  });
  return { adapter, ...recorded };
}

describe('createOandaBroker · construcción', () => {
  it('solo admite la URL fija de cada entorno', () => {
    expect(() =>
      createOandaBroker('practice', {
        fetch: vi.fn() as unknown as typeof fetch,
        getCredentials: async () => null,
        baseUrl: OANDA_LIVE_BASE_URL,
      }),
    ).toThrowError(/solo se admite https:\/\/api-fxpractice\.oanda\.com/);
    expect(() =>
      createOandaBroker('live', {
        fetch: vi.fn() as unknown as typeof fetch,
        getCredentials: async () => null,
        baseUrl: 'https://evil.example.com',
        isLiveGateOpen: () => true,
      }),
    ).toThrowError(BrokerError);
  });

  it('la cuenta real no se construye sin la lista de comprobación completa', () => {
    expect(() =>
      createOandaBroker('live', {
        fetch: vi.fn() as unknown as typeof fetch,
        getCredentials: async () => null,
      }),
    ).toThrowError(/lista de comprobación/);
    const live = createOandaBroker('live', {
      fetch: vi.fn() as unknown as typeof fetch,
      getCredentials: async () => null,
      isLiveGateOpen: () => true,
    });
    expect(live.paperOnly).toBe(false);
    expect(live.id).toBe('oanda-live');
  });
});

describe('createOandaBroker · cuenta, posiciones y precios', () => {
  it('lee el resumen con el token en la cabecera y nunca en la URL', async () => {
    const { adapter, calls } = practice({ [`GET ${base}/summary`]: { body: accountSummary } });
    const account = await adapter.getAccount();
    expect(account).toEqual({
      accountId: ACCOUNT,
      status: 'ACTIVE',
      currency: 'EUR',
      cash: 100,
      equity: 100,
      buyingPower: 100,
      paper: true,
      shortingEnabled: true,
    });
    expect(calls[0]!.url).toBe(`${OANDA_PRACTICE_BASE_URL}${base}/summary`);
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('sin credenciales falla con «auth» sin tocar la red', async () => {
    const recorded = recordedFetch({});
    const adapter = createOandaBroker('practice', {
      fetch: recorded.fetch,
      getCredentials: async () => null,
    });
    await expect(adapter.getAccount()).rejects.toMatchObject({ kind: 'auth' });
    expect(recorded.calls).toHaveLength(0);
  });

  it('traduce las posiciones largas y cortas e ignora instrumentos ajenos a Tradia', async () => {
    const { adapter } = practice({ [`GET ${base}/openPositions`]: { body: openPositions } });
    expect(await adapter.listPositions()).toEqual([
      {
        ticker: 'EURUSD',
        side: 'long',
        quantity: 1000,
        avgEntryPrice: 1.08462,
        marketValue: null,
        unrealizedPnl: -0.0011,
        currency: 'USD',
      },
      {
        ticker: 'XAUUSD',
        side: 'short',
        quantity: 1,
        avgEntryPrice: 2650.9,
        marketValue: null,
        unrealizedPnl: 0.37,
        currency: 'USD',
      },
    ]);
  });

  it('lee la horquilla de precios por instrumento', async () => {
    const { adapter, calls } = practice({
      [`GET ${base}/pricing?instruments=EUR_USD%2CUSD_JPY`]: { body: pricing },
    });
    const prices = await adapter.getPrices(['EURUSD', 'USDJPY', 'EURUSD']);
    expect(prices.get('EURUSD')).toMatchObject({ bid: 1.0845, ask: 1.08462, tradeable: true });
    expect(prices.get('USDJPY')?.mid).toBeCloseTo(151.207, 6);
    expect(calls).toHaveLength(1);
  });
});

describe('createOandaBroker · órdenes', () => {
  it('envía una de mercado FOK con stop y objetivo adjuntos y devuelve la ejecución', async () => {
    const { adapter, calls } = practice({
      [`POST ${base}/orders`]: { status: 201, body: orderMarketFilled },
    });
    const order = await adapter.submitOrder({
      clientOrderId: 'tradia-prueba-1',
      ticker: 'EUR/USD',
      type: 'market',
      side: 'buy',
      quantity: 1,
      stopLossOnFill: 1.082448,
      takeProfitOnFill: 1.088961,
    });
    expect(calls[0]!.body).toEqual({
      order: {
        type: 'MARKET',
        instrument: 'EUR_USD',
        units: '1',
        timeInForce: 'FOK',
        positionFill: 'DEFAULT',
        clientExtensions: { id: 'tradia-prueba-1', tag: 'tradia' },
        // Redondeado a los 5 decimales que admite OANDA en EUR/USD.
        stopLossOnFill: { price: '1.08245', timeInForce: 'GTC' },
        takeProfitOnFill: { price: '1.08896', timeInForce: 'GTC' },
      },
    });
    expect(order).toMatchObject({
      brokerOrderId: '7',
      clientOrderId: 'tradia-prueba-1',
      ticker: 'EURUSD',
      status: 'ejecutada',
      filledQuantity: 1,
      filledAvgPrice: 1.08462,
    });
  });

  it('una venta lleva unidades negativas', async () => {
    const { adapter, calls } = practice({
      [`POST ${base}/orders`]: { status: 201, body: orderMarketFilled },
    });
    await adapter.submitOrder({
      clientOrderId: 'tradia-v',
      ticker: 'USDJPY',
      type: 'limit',
      side: 'sell',
      quantity: 3,
      limitPrice: 152.12345,
    });
    expect(calls[0]!.body).toMatchObject({
      order: {
        type: 'LIMIT',
        instrument: 'USD_JPY',
        units: '-3',
        price: '152.123',
        timeInForce: 'GTC',
      },
    });
  });

  it('una de mercado cancelada al instante (mercado cerrado) es un rechazo', async () => {
    const { adapter } = practice({
      [`POST ${base}/orders`]: { status: 201, body: orderMarketCancelled },
    });
    await expect(
      adapter.submitOrder({
        clientOrderId: 'tradia-prueba-2',
        ticker: 'EURUSD',
        type: 'market',
        side: 'buy',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ kind: 'reject', message: expect.stringContaining('MARKET_HALTED') });
  });

  it('el rechazo 400 del bróker llega con su código legible y no es reintentable', async () => {
    const { adapter } = practice({
      [`POST ${base}/orders`]: { status: 400, body: error400Reject },
    });
    const error = (await adapter
      .submitOrder({
        clientOrderId: 'tradia-x',
        ticker: 'EURUSD',
        type: 'market',
        side: 'buy',
        quantity: 1,
        stopLossOnFill: 1.09,
      })
      .then(
        () => null,
        (e: unknown) => e,
      )) as BrokerError;
    expect(error).toBeInstanceOf(BrokerError);
    expect(error.kind).toBe('reject');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('STOP_LOSS_ON_FILL_LOSS');
  });

  it('no envía instrumentos fuera de los cuatro ni cantidades fraccionarias ni OCO', async () => {
    const { adapter, calls } = practice({});
    await expect(
      adapter.submitOrder({
        clientOrderId: 't1',
        ticker: 'AAPL',
        type: 'market',
        side: 'buy',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ kind: 'reject' });
    await expect(
      adapter.submitOrder({
        clientOrderId: 't2',
        ticker: 'EURUSD',
        type: 'market',
        side: 'buy',
        quantity: 1.5,
      }),
    ).rejects.toMatchObject({ kind: 'bad-data' });
    await expect(
      adapter.submitOrder({
        clientOrderId: 't3',
        ticker: 'EURUSD',
        type: 'oco',
        side: 'sell',
        quantity: 1,
        limitPrice: 1.1,
        stopPrice: 1.0,
      }),
    ).rejects.toMatchObject({ kind: 'bad-data', message: expect.stringContaining('adjuntos') });
    expect(calls).toHaveLength(0);
  });

  it('busca por client_order_id y completa el precio con la transacción de ejecución', async () => {
    const { adapter } = practice({
      [`GET ${base}/orders/@tradia-prueba-1`]: { body: orderByClientId },
      [`GET ${base}/transactions/8`]: { body: transactionFill },
    });
    expect(await adapter.getOrderByClientId('tradia-prueba-1')).toMatchObject({
      brokerOrderId: '7',
      status: 'ejecutada',
      filledAvgPrice: 1.08462,
      filledAt: '2026-11-23T15:00:02.118340923Z',
    });
  });

  it('una orden desconocida es null (idempotencia)', async () => {
    const { adapter } = practice({
      [`GET ${base}/orders/@tradia-nada`]: { status: 404, body: error404Order },
    });
    expect(await adapter.getOrderByClientId('tradia-nada')).toBeNull();
  });

  it('las abiertas omiten el stop y el objetivo dependientes de una operación', async () => {
    const { adapter } = practice({ [`GET ${base}/pendingOrders`]: { body: pendingOrders } });
    const open = await adapter.listOrders({ openOnly: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      clientOrderId: 'tradia-manual-21',
      ticker: 'GBPUSD',
      type: 'limit',
      side: 'sell',
      quantity: 500,
      limitPrice: 1.275,
      status: 'enviada',
    });
  });

  it('cierra la posición entera y devuelve precio y resultado', async () => {
    const { adapter, calls } = practice({
      [`GET ${base}/positions/EUR_USD`]: { body: positionEurUsd },
      [`PUT ${base}/positions/EUR_USD/close`]: { body: positionClose },
    });
    expect(await adapter.closePosition('EURUSD')).toEqual({
      instrument: 'EURUSD',
      units: 1,
      fillPrice: 1.0845,
      realizedPnl: -0.0001,
    });
    expect(calls[1]!.body).toEqual({ longUnits: 'ALL' });
  });
});

describe('createOandaBroker · errores', () => {
  it('401: token de otro entorno → «auth» con mensaje claro y sin el token', async () => {
    const { adapter } = practice({ [`GET ${base}/summary`]: { status: 401, body: error401 } });
    const error = (await adapter.getAccount().then(
      () => null,
      (e: unknown) => e,
    )) as BrokerError;
    expect(error.kind).toBe('auth');
    expect(error.message).toContain('cuenta de práctica');
    expect(error.message).not.toContain(TOKEN);
  });

  it('429 es reintentable con la espera sugerida; 5xx es «server»', async () => {
    let n = 0;
    const { adapter } = practice({
      [`GET ${base}/summary`]: () =>
        n++ === 0
          ? { status: 429, body: { errorMessage: 'Too many' }, headers: { 'Retry-After': '2' } }
          : { status: 503, body: { errorMessage: 'down' } },
    });
    await expect(adapter.getAccount()).rejects.toMatchObject({
      kind: 'rate-limit',
      retryAfterMs: 2000,
    });
    await expect(adapter.getAccount()).rejects.toMatchObject({ kind: 'server' });
  });

  it('un fallo de transporte es «network» y un tiempo agotado es «timeout»', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError(`fetch failed ${TOKEN}`))
      .mockRejectedValueOnce(timeout);
    const adapter = createOandaBroker('practice', {
      fetch: fetch as unknown as typeof globalThis.fetch,
      getCredentials: async () => ({ token: TOKEN, accountId: ACCOUNT }),
    });
    const network = (await adapter.getAccount().then(
      () => null,
      (e: unknown) => e,
    )) as BrokerError;
    expect(network.kind).toBe('network');
    expect(network.message).not.toContain(TOKEN);
    await expect(adapter.getAccount()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('la cuenta real vuelve a mirar la puerta en cada envío pero no al cerrar', async () => {
    let gate = true;
    const server = createOandaFakeServer({
      baseUrl: OANDA_LIVE_BASE_URL,
      token: TOKEN,
      accountId: LIVE_ACCOUNT,
    });
    const live = createOandaBroker('live', {
      fetch: server.fetch,
      getCredentials: async () => ({ token: TOKEN, accountId: LIVE_ACCOUNT }),
      isLiveGateOpen: () => gate,
    });
    await live.submitOrder({
      clientOrderId: 'tradia-l1',
      ticker: 'EURUSD',
      type: 'market',
      side: 'buy',
      quantity: 1,
    });
    gate = false;
    await expect(
      live.submitOrder({
        clientOrderId: 'tradia-l2',
        ticker: 'EURUSD',
        type: 'market',
        side: 'buy',
        quantity: 1,
      }),
    ).rejects.toMatchObject({
      kind: 'reject',
      message: expect.stringContaining('lista de comprobación'),
    });
    expect(await live.closePosition('EURUSD')).toMatchObject({ units: 1 });
  });
});

describe('servidor falso de OANDA', () => {
  it('rechaza un token o una cuenta de otro entorno como el real', async () => {
    const server = createOandaFakeServer({
      baseUrl: OANDA_PRACTICE_BASE_URL,
      token: TOKEN,
      accountId: ACCOUNT,
    });
    const wrongToken = createOandaBroker('practice', {
      fetch: server.fetch,
      getCredentials: async () => ({
        token: 'c'.repeat(32) + '-' + 'd'.repeat(32),
        accountId: ACCOUNT,
      }),
    });
    await expect(wrongToken.getAccount()).rejects.toMatchObject({ kind: 'auth', status: 401 });
    const wrongAccount = createOandaBroker('practice', {
      fetch: server.fetch,
      getCredentials: async () => ({ token: TOKEN, accountId: '101-004-0000000-001' }),
    });
    await expect(wrongAccount.getAccount()).rejects.toMatchObject({ kind: 'auth', status: 403 });
  });

  it('abre, concilia por posición y cierra con el diferencial como resultado', async () => {
    const server = createOandaFakeServer({
      baseUrl: OANDA_PRACTICE_BASE_URL,
      token: TOKEN,
      accountId: ACCOUNT,
    });
    const adapter = createOandaBroker('practice', {
      fetch: server.fetch,
      getCredentials: async () => ({ token: TOKEN, accountId: ACCOUNT }),
    });
    const fill = await adapter.submitOrder({
      clientOrderId: 'tradia-f1',
      ticker: 'EURUSD',
      type: 'market',
      side: 'buy',
      quantity: 1000,
      stopLossOnFill: 1.08,
      takeProfitOnFill: 1.09,
    });
    expect(fill.filledAvgPrice).toBe(1.08462);
    expect(await adapter.listPositions()).toMatchObject([
      { ticker: 'EURUSD', side: 'long', quantity: 1000 },
    ]);
    expect(await adapter.listOrders({ openOnly: true })).toEqual([]);
    const closed = await adapter.closePosition('EURUSD');
    expect(closed.fillPrice).toBe(1.0845);
    expect(closed.realizedPnl).toBeLessThan(0);
    expect((await adapter.getAccountDetails()).openPositionCount).toBe(0);
  });
});
