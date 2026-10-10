import { describe, expect, it, vi } from 'vitest';

import accountFixture from './__fixtures__/account.json';
import error401 from './__fixtures__/error-401.json';
import error404 from './__fixtures__/error-404.json';
import error422 from './__fixtures__/error-422.json';
import error429 from './__fixtures__/error-429.json';
import error500 from './__fixtures__/error-500.json';
import { createAlpacaFakeFetch } from './__fixtures__/fake-server';
import positionsFixture from './__fixtures__/positions.json';
import {
  ALPACA_ADAPTER_ID,
  ALPACA_PAPER_BASE_URL,
  createAlpacaBroker,
  type AlpacaCredentials,
} from './alpaca';
import { BrokerError, isBrokerError, type BrokerOrderRequest } from './types';

const CREDS: AlpacaCredentials = {
  apiKeyId: 'PK-SECRETO-de-prueba-123',
  apiSecret: 'SK-SECRETO-de-prueba-456',
};

const NOW_ISO = '2026-10-08T15:00:00.000Z';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** fetch que graba las llamadas y deja responder según url/método. */
function fetchStub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return { fetch, calls };
}

const fetchReturning = (response: () => Response | Promise<Response>) =>
  fetchStub(() => response());

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const make = (
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof createAlpacaBroker>[0]> = {},
) =>
  createAlpacaBroker({
    fetch,
    getCredentials: async () => CREDS,
    ...extra,
  });

/** Orden con la forma exacta de la API v2 de Alpaca, sobreescribible. */
const orderJson = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '61e69015-8549-4bfd-b9c3-01e75843f47d',
  client_order_id: 'tradia-test-1',
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
  submitted_at: NOW_ISO,
  filled_at: null,
  expired_at: null,
  canceled_at: null,
  failed_at: null,
  replaced_at: null,
  replaced_by: null,
  replaces: null,
  asset_id: 'b0b6dd9d-8b9e-4ef6-9c7d-2c19f5c9a0a1',
  symbol: 'AAPL',
  asset_class: 'us_equity',
  notional: null,
  qty: '5',
  filled_qty: '0',
  filled_avg_price: null,
  order_class: 'simple',
  type: 'market',
  side: 'buy',
  time_in_force: 'day',
  limit_price: null,
  stop_price: null,
  status: 'new',
  extended_hours: false,
  legs: null,
  trail_percent: null,
  trail_price: null,
  hwm: null,
  ...patch,
});

const request = (patch: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest => ({
  clientOrderId: 'tradia-test-1',
  ticker: 'AAPL',
  type: 'market',
  side: 'buy',
  quantity: 5,
  ...patch,
});

const bodyJson = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body)) as Record<string, unknown>;

describe('adaptador Alpaca paper', () => {
  it.each([
    'https://api.alpaca.markets',
    'https://api.alpaca.markets/v2',
    'http://localhost:9999',
    'https://paper-api.alpaca.markets.evil.test',
    'https://paper-api2.alpaca.markets',
  ])('rechaza en el constructor la URL no paper %s', (baseUrl) => {
    expect(() =>
      createAlpacaBroker({
        fetch: vi.fn(),
        getCredentials: async () => CREDS,
        baseUrl,
      }),
    ).toThrowError(BrokerError);
    let thrown: unknown;
    try {
      createAlpacaBroker({ fetch: vi.fn(), getCredentials: async () => CREDS, baseUrl });
    } catch (error) {
      thrown = error;
    }
    expect(isBrokerError(thrown, 'bad-data')).toBe(true);
    expect((thrown as BrokerError).retryable).toBe(false);
  });

  it('acepta la URL paper (también con barra final) y solo llama a esa base', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(accountFixture));
    const broker = make(fetch, { baseUrl: `${ALPACA_PAPER_BASE_URL}/` });
    await broker.getAccount();
    expect(calls[0]!.url).toBe(`${ALPACA_PAPER_BASE_URL}/v2/account`);
  });

  it('envía las claves en cabeceras APCA, nunca en la URL', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(accountFixture));
    await make(fetch).getAccount();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['APCA-API-KEY-ID']).toBe(CREDS.apiKeyId);
    expect(headers['APCA-API-SECRET-KEY']).toBe(CREDS.apiSecret);
    expect(calls[0]!.url).not.toContain(CREDS.apiKeyId);
    expect(calls[0]!.url).not.toContain(CREDS.apiSecret);
  });

  it.each<[string, () => Promise<AlpacaCredentials | null>]>([
    ['sin credenciales', async () => null],
    ['clave vacía', async () => ({ apiKeyId: '', apiSecret: 'x' })],
    ['secreto vacío', async () => ({ apiKeyId: 'x', apiSecret: '  ' })],
  ])('%s falla con auth sin tocar la red', async (_label, getCredentials) => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(accountFixture));
    const broker = make(fetch, { getCredentials });
    await expect(broker.getAccount()).rejects.toMatchObject({
      name: 'BrokerError',
      kind: 'auth',
      adapter: ALPACA_ADAPTER_ID,
    });
    expect(calls).toHaveLength(0);
  });

  it('getAccount mapea el fixture a la cuenta paper', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(accountFixture));
    const account = await make(fetch).getAccount();
    expect(account).toEqual({
      accountId: 'PA3XQJ8W1K2L',
      status: 'ACTIVE',
      currency: 'USD',
      cash: 100_000,
      equity: 100_250.55,
      buyingPower: 200_501.1,
      paper: true,
    });
  });

  it('listPositions mapea las posiciones del fixture', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(positionsFixture));
    const positions = await make(fetch).listPositions();
    expect(positions).toHaveLength(2);
    expect(positions[0]).toEqual({
      ticker: 'AAPL',
      side: 'long',
      quantity: 1,
      avgEntryPrice: 250.55,
      marketValue: 250.55,
      unrealizedPnl: 0,
      currency: 'USD',
    });
    expect(positions[1]!.side).toBe('short');
  });

  describe('submitOrder', () => {
    it('una market viaja como type=market day con client_order_id', async () => {
      const { fetch, calls } = fetchReturning(() => jsonResponse(orderJson()));
      await make(fetch).submitOrder(request());
      const body = bodyJson(calls[0]!.init);
      expect(calls[0]!.url).toBe(`${ALPACA_PAPER_BASE_URL}/v2/orders`);
      expect(calls[0]!.init.method).toBe('POST');
      expect(body).toMatchObject({
        symbol: 'AAPL',
        qty: '5',
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        client_order_id: 'tradia-test-1',
      });
      expect(body).not.toHaveProperty('limit_price');
      expect(body).not.toHaveProperty('stop_price');
      expect(body).not.toHaveProperty('order_class');
    });

    it('una limit viaja con limit_price', async () => {
      const { fetch, calls } = fetchReturning(() => jsonResponse(orderJson({ type: 'limit' })));
      await make(fetch).submitOrder(request({ type: 'limit', limitPrice: 0.01 }));
      expect(bodyJson(calls[0]!.init)).toMatchObject({
        type: 'limit',
        limit_price: '0.01',
        time_in_force: 'day',
      });
    });

    it('una stop viaja con stop_price', async () => {
      const { fetch, calls } = fetchReturning(() => jsonResponse(orderJson({ type: 'stop' })));
      await make(fetch).submitOrder(request({ type: 'stop', side: 'sell', stopPrice: 0.01 }));
      expect(bodyJson(calls[0]!.init)).toMatchObject({ type: 'stop', stop_price: '0.01' });
    });

    it('una OCO viaja como order_class=oco en gtc con take_profit y stop_loss', async () => {
      const { fetch, calls } = fetchReturning(() =>
        jsonResponse(orderJson({ order_class: 'oco', type: 'limit', legs: [] })),
      );
      await make(fetch).submitOrder(
        request({ type: 'oco', side: 'sell', limitPrice: 999_999, stopPrice: 0.01 }),
      );
      expect(bodyJson(calls[0]!.init)).toMatchObject({
        type: 'limit',
        order_class: 'oco',
        time_in_force: 'gtc',
        limit_price: '999999',
        take_profit: { limit_price: '999999' },
        stop_loss: { stop_price: '0.01' },
      });
    });

    it('una OCO pedida con timeInForce day sale igualmente en gtc', async () => {
      const { fetch, calls } = fetchReturning(() =>
        jsonResponse(orderJson({ order_class: 'oco', type: 'limit', legs: [] })),
      );
      await make(fetch).submitOrder(
        request({ type: 'oco', side: 'sell', limitPrice: 9, stopPrice: 0.01, timeInForce: 'day' }),
      );
      expect(bodyJson(calls[0]!.init)['time_in_force']).toBe('gtc');
    });

    it('mapea una OCO con sus dos patas al RemoteOrder', async () => {
      const legLimit = orderJson({
        id: 'leg-objetivo',
        type: 'limit',
        limit_price: '999999',
        status: 'new',
      });
      const legStop = orderJson({
        id: 'leg-stop',
        type: 'stop',
        stop_price: '0.01',
        status: 'new',
      });
      const { fetch } = fetchReturning(() =>
        jsonResponse(
          orderJson({
            order_class: 'oco',
            type: 'limit',
            limit_price: '999999',
            stop_price: '0.01',
            legs: [legLimit, legStop],
          }),
        ),
      );
      const order = await make(fetch).submitOrder(
        request({ type: 'oco', side: 'sell', limitPrice: 999_999, stopPrice: 0.01 }),
      );
      expect(order.type).toBe('oco');
      expect(order.ocoGroupId).toBe(order.brokerOrderId);
      expect(order.legs).toHaveLength(2);
      expect(order.legs!.map((leg) => leg.type).sort()).toEqual(['limit', 'stop']);
      expect(order.legs!.every((leg) => leg.ocoGroupId === order.brokerOrderId)).toBe(true);
    });

    it('normaliza cantidades y precios de texto a número', async () => {
      const { fetch } = fetchReturning(() =>
        jsonResponse(
          orderJson({
            status: 'filled',
            filled_qty: '5',
            filled_avg_price: '250.55',
            filled_at: NOW_ISO,
          }),
        ),
      );
      const order = await make(fetch).submitOrder(request());
      expect(order.status).toBe('ejecutada');
      expect(order.filledQuantity).toBe(5);
      expect(order.filledAvgPrice).toBe(250.55);
    });
  });

  describe('cancelOrder', () => {
    it('hace DELETE y confirma el estado con GET', async () => {
      const { fetch, calls } = fetchStub((url, init) => {
        if (init.method === 'DELETE') return new Response(null, { status: 204 });
        if (url.endsWith('/v2/orders/ord-1')) {
          return jsonResponse(orderJson({ id: 'ord-1', status: 'canceled' }));
        }
        return jsonResponse(error404, 404);
      });
      const result = await make(fetch).cancelOrder('ord-1');
      expect(result.status).toBe('cancelada');
      expect(result.brokerOrderId).toBe('ord-1');
      expect(calls.map((c) => c.init.method)).toEqual(['DELETE', 'GET']);
    });

    it('un DELETE 404 es not-found y un 422 es reject (no reintentables)', async () => {
      const notFound = make(fetchReturning(() => jsonResponse(error404, 404)).fetch);
      await expect(notFound.cancelOrder('nope')).rejects.toMatchObject({ kind: 'not-found' });

      const closed = make(fetchReturning(() => jsonResponse(error422, 422)).fetch);
      const error = await closed.cancelOrder('ord-1').catch((e: unknown) => e);
      expect(isBrokerError(error, 'reject')).toBe(true);
      expect((error as BrokerError).retryable).toBe(false);
    });
  });

  describe('listOrders y getOrderByClientId', () => {
    it('lista con nested=true y filtra abiertas con status=open', async () => {
      const { fetch, calls } = fetchReturning(() => jsonResponse([]));
      const broker = make(fetch);
      await broker.listOrders();
      await broker.listOrders({ openOnly: true });
      expect(calls[0]!.url).toContain('status=all');
      expect(calls[0]!.url).toContain('nested=true');
      expect(calls[1]!.url).toContain('status=open');
    });

    it('busca por client_order_id y devuelve null si el broker no la conoce', async () => {
      const { fetch, calls } = fetchStub((url) =>
        url.includes('tradia-test-1') ? jsonResponse(orderJson()) : jsonResponse(error404, 404),
      );
      const broker = make(fetch);
      const found = await broker.getOrderByClientId('tradia-test-1');
      expect(found?.brokerOrderId).toBe('61e69015-8549-4bfd-b9c3-01e75843f47d');
      expect(calls[0]!.url).toContain(
        '/v2/orders:by_client_order_id?client_order_id=tradia-test-1',
      );
      expect(await broker.getOrderByClientId('tradia-inexistente')).toBeNull();
    });
  });

  describe('mapeo de estados y errores', () => {
    it.each([
      ['new', 'enviada'],
      ['accepted', 'enviada'],
      ['pending_new', 'enviada'],
      ['pending_cancel', 'enviada'],
      ['held', 'enviada'],
      ['partially_filled', 'parcial'],
      ['filled', 'ejecutada'],
      ['canceled', 'cancelada'],
      ['expired', 'cancelada'],
      ['done_for_day', 'cancelada'],
      ['rejected', 'rechazada'],
    ] as const)('estado de Alpaca %s → %s', async (alpacaStatus, expected) => {
      const { fetch } = fetchReturning(() => jsonResponse(orderJson({ status: alpacaStatus })));
      const order = await make(fetch).submitOrder(request());
      expect(order.status).toBe(expected);
    });

    it('un estado desconocido de Alpaca es bad-data', async () => {
      const { fetch } = fetchReturning(() => jsonResponse(orderJson({ status: 'quantum' })));
      await expect(make(fetch).submitOrder(request())).rejects.toMatchObject({
        kind: 'bad-data',
      });
    });

    it.each<[string, unknown, number, string]>([
      ['401 → auth', error401, 401, 'auth'],
      ['403 → auth', { code: 40310000, message: 'forbidden' }, 403, 'auth'],
      ['404 → not-found', error404, 404, 'not-found'],
      ['422 → reject', error422, 422, 'reject'],
      ['429 → rate-limit', error429, 429, 'rate-limit'],
      ['500 → server', error500, 500, 'server'],
    ])('mapea el error HTTP %s', async (_label, body, status, kind) => {
      const { fetch } = fetchReturning(() => jsonResponse(body, status));
      const error = await make(fetch)
        .getAccount()
        .catch((e: unknown) => e);
      expect(isBrokerError(error)).toBe(true);
      expect((error as BrokerError).kind).toBe(kind);
      expect((error as BrokerError).status).toBe(status);
      expect((error as BrokerError).retryable).toBe(kind === 'rate-limit' || kind === 'server');
    });

    it('429 trae la espera sugerida de la cabecera Retry-After', async () => {
      const { fetch } = fetchReturning(() => jsonResponse(error429, 429, { 'Retry-After': '120' }));
      const error = await make(fetch)
        .getAccount()
        .catch((e: unknown) => e);
      expect(isBrokerError(error, 'rate-limit')).toBe(true);
      expect((error as BrokerError).retryAfterMs).toBe(120_000);
    });

    it('un fallo de transporte es network y un timeout es timeout', async () => {
      const transport = make(
        fetchReturning(() => Promise.reject(new Error('socket hang up'))).fetch,
      );
      await expect(transport.getAccount()).rejects.toMatchObject({ kind: 'network' });

      const timeout = make(
        fetchReturning(() =>
          Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
        ).fetch,
      );
      const error = await timeout.getAccount().catch((e: unknown) => e);
      expect(isBrokerError(error, 'timeout')).toBe(true);
      expect((error as BrokerError).retryable).toBe(true);
    });

    it('una respuesta que no es JSON es bad-data', async () => {
      const { fetch } = fetchReturning(() => new Response('<html>error</html>', { status: 200 }));
      await expect(make(fetch).getAccount()).rejects.toMatchObject({ kind: 'bad-data' });
    });

    it('una orden con campos que faltan es bad-data', async () => {
      const { fetch } = fetchReturning(() => jsonResponse({ id: 'x', symbol: 'AAPL' }));
      await expect(make(fetch).submitOrder(request())).rejects.toMatchObject({
        kind: 'bad-data',
      });
    });

    it('las claves nunca aparecen en los errores ni en los avisos del logger', async () => {
      const logger = { warn: vi.fn() };
      const { fetch } = fetchReturning(() =>
        jsonResponse({ message: `token ${CREDS.apiSecret} y ${CREDS.apiKeyId} rechazados` }, 401),
      );
      const broker = make(fetch, { logger });
      const error = await broker.getAccount().catch((e: unknown) => e);
      expect(JSON.stringify(error)).not.toContain(CREDS.apiKeyId);
      expect(JSON.stringify(error)).not.toContain(CREDS.apiSecret);
      for (const call of logger.warn.mock.calls) {
        expect(String(call[0])).not.toContain(CREDS.apiKeyId);
        expect(String(call[0])).not.toContain(CREDS.apiSecret);
      }
    });
  });

  describe('contra el servidor falso con fixtures', () => {
    const makeFake = () => make(createAlpacaFakeFetch({ prices: { AAPL: 250 } }));

    it('rechaza un client_order_id repetido como reject', async () => {
      const broker = makeFake();
      await broker.submitOrder(request());
      const error = await broker.submitOrder(request()).catch((e: unknown) => e);
      expect(isBrokerError(error, 'reject')).toBe(true);
      expect((error as BrokerError).retryable).toBe(false);
    });
  });
});
