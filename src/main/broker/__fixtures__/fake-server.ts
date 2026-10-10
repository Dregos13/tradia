/**
 * Servidor falso de la API paper de Alpaca para las pruebas del adaptador
 * (`alpaca.test.ts` y la suite de contrato `contract.test.ts`).
 *
 * Devuelve un `fetch` compatible que responde como Alpaca REST v2 usando
 * las respuestas grabadas de `__fixtures__`: cuenta y posiciones fijas, y
 * un libro de órdenes en memoria que respeta el ciclo de vida real —
 * `POST /v2/orders` crea (market ejecuta al precio de referencia; limit,
 * stop y OCO quedan 'new' con sus patas), `GET` lista/filtra/busca por
 * `client_order_id` y `DELETE` marca 'canceled' devolviendo 204. Los
 * errores también son los del broker real: 401 sin cabeceras de clave,
 * 404 en desconocidas, 422 al cancelar una cerrada o repetir
 * `client_order_id`.
 */
import accountFixture from './account.json';
import error401 from './error-401.json';
import error404 from './error-404.json';
import error422 from './error-422.json';
import positionsFixture from './positions.json';

type JsonObject = Record<string, unknown>;

export interface AlpacaFakeServerOptions {
  /** Reloj inyectable (ms epoch); instante fijo por defecto. */
  now?: () => number;
  /** Precio de referencia por ticker para ejecutar las de mercado. */
  prices?: Record<string, number>;
  /** Respuesta de `GET /v2/account`; por defecto el fixture grabado. */
  account?: JsonObject;
  /** Respuesta de `GET /v2/positions`; por defecto el fixture grabado. */
  positions?: unknown[];
}

const FIXED_NOW = Date.parse('2026-10-08T15:00:00.000Z');
const DEFAULT_PRICE = 250;

/** Estados abiertos en el vocabulario de Alpaca (filtro `status=open`). */
const OPEN_STATUSES = new Set([
  'new',
  'accepted',
  'pending_new',
  'accepted_for_bidding',
  'pending_review',
  'pending_replace',
  'pending_cancel',
  'stopped',
  'suspended',
  'calculated',
  'held',
  'partially_filled',
]);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export function createAlpacaFakeFetch(options: AlpacaFakeServerOptions = {}): typeof fetch {
  const now = options.now ?? (() => FIXED_NOW);
  const account = options.account ?? (accountFixture as JsonObject);
  const positions = options.positions ?? (positionsFixture as unknown[]);
  const orders = new Map<string, JsonObject>();
  let seq = 0;

  const isoNow = (): string => new Date(now()).toISOString();
  const refPrice = (ticker: string): number => options.prices?.[ticker] ?? DEFAULT_PRICE;
  const nextId = (): string => `fake-order-${++seq}`;

  const fill = (order: JsonObject, price: number): void => {
    order['status'] = 'filled';
    order['filled_qty'] = order['qty'];
    order['filled_avg_price'] = String(price);
    order['filled_at'] = isoNow();
  };

  const baseOrder = (body: JsonObject, now: string): JsonObject => ({
    id: nextId(),
    client_order_id: String(body['client_order_id'] ?? ''),
    created_at: now,
    updated_at: now,
    submitted_at: now,
    filled_at: null,
    expired_at: null,
    canceled_at: null,
    failed_at: null,
    replaced_at: null,
    replaced_by: null,
    replaces: null,
    asset_id: `fake-asset-${String(body['symbol'] ?? '')}`,
    symbol: String(body['symbol'] ?? ''),
    asset_class: 'us_equity',
    notional: null,
    qty: String(body['qty'] ?? ''),
    filled_qty: '0',
    filled_avg_price: null,
    order_class: 'simple',
    type: String(body['type'] ?? 'market'),
    side: body['side'] === 'sell' ? 'sell' : 'buy',
    time_in_force: String(body['time_in_force'] ?? 'day'),
    limit_price: body['limit_price'] ?? null,
    stop_price: body['stop_price'] ?? null,
    status: 'new',
    extended_hours: false,
    legs: null,
    trail_percent: null,
    trail_price: null,
    hwm: null,
  });

  const submit = (body: JsonObject): Response => {
    const clientOrderId = String(body['client_order_id'] ?? '');
    if ([...orders.values()].some((o) => o['client_order_id'] === clientOrderId)) {
      return json({ ...error422, message: 'client_order_id must be unique' }, 422);
    }
    const symbol = String(body['symbol'] ?? '');
    if (!symbol || !body['qty']) {
      return json({ ...error422, message: 'missing required fields: symbol, qty' }, 422);
    }
    const stamp = isoNow();
    const orderClass = String(body['order_class'] ?? 'simple') || 'simple';
    const order = baseOrder(body, stamp);
    order['order_class'] = orderClass;

    if (orderClass === 'oco') {
      const takeProfit = (body['take_profit'] ?? {}) as JsonObject;
      const stopLoss = (body['stop_loss'] ?? {}) as JsonObject;
      if (takeProfit['limit_price'] === undefined || stopLoss['stop_price'] === undefined) {
        return json({ ...error422, message: 'oco requires take_profit and stop_loss' }, 422);
      }
      order['type'] = 'limit';
      order['limit_price'] = takeProfit['limit_price'];
      order['stop_price'] = stopLoss['stop_price'];
      order['legs'] = [
        {
          ...baseOrder(body, stamp),
          client_order_id: `${clientOrderId}-take-profit`,
          type: 'limit',
          limit_price: takeProfit['limit_price'],
          stop_price: null,
          time_in_force: 'gtc',
        },
        {
          ...baseOrder(body, stamp),
          client_order_id: `${clientOrderId}-stop-loss`,
          type: 'stop',
          limit_price: null,
          stop_price: stopLoss['stop_price'],
          time_in_force: 'gtc',
        },
      ];
    } else if (order['type'] === 'market') {
      fill(order, refPrice(symbol));
    }

    orders.set(order['id'] as string, order);
    return json(order, 200);
  };

  const cancel = (id: string): Response => {
    const order = orders.get(id);
    if (order === undefined) return json(error404, 404);
    if (!OPEN_STATUSES.has(String(order['status']))) {
      return json(
        {
          ...error422,
          message: `order is not eligible for cancel: status=${String(order['status'])}`,
        },
        422,
      );
    }
    order['status'] = 'canceled';
    order['canceled_at'] = isoNow();
    for (const leg of (order['legs'] as JsonObject[] | null) ?? []) {
      leg['status'] = 'canceled';
      leg['canceled_at'] = isoNow();
    }
    return new Response(null, { status: 204 });
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    if (!headers.get('apca-api-key-id') || !headers.get('apca-api-secret-key')) {
      return json(error401, 401);
    }

    if (path === '/v2/account' && method === 'GET') return json(account);
    if (path === '/v2/positions' && method === 'GET') return json(positions);

    if (path === '/v2/orders' && method === 'GET') {
      const status = url.searchParams.get('status') ?? 'all';
      const all = [...orders.values()].sort((a, b) =>
        String(b['submitted_at']).localeCompare(String(a['submitted_at'])),
      );
      return json(
        status === 'open' ? all.filter((o) => OPEN_STATUSES.has(String(o['status']))) : all,
      );
    }
    if (path === '/v2/orders' && method === 'POST') {
      let body: JsonObject;
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
      } catch {
        return json({ ...error422, message: 'invalid JSON body' }, 422);
      }
      return submit(body);
    }
    if (path === '/v2/orders:by_client_order_id' && method === 'GET') {
      const clientOrderId = url.searchParams.get('client_order_id');
      const found = [...orders.values()].find((o) => o['client_order_id'] === clientOrderId);
      return found ? json(found) : json(error404, 404);
    }

    const orderMatch = /^\/v2\/orders\/([^/]+)$/.exec(path);
    if (orderMatch !== null) {
      const id = orderMatch[1]!;
      if (method === 'DELETE') return cancel(id);
      if (method === 'GET') {
        const found = orders.get(id);
        return found ? json(found) : json(error404, 404);
      }
    }
    return json({ code: 40410000, message: `ruta desconocida: ${method} ${path}` }, 404);
  };

  return fetch;
}
