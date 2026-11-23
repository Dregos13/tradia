/**
 * Servidor falso de la API v20 de OANDA, con estado y sin red.
 *
 * Lo usan las pruebas del servicio de divisas y el E2E (bróker
 * simulado): devuelve un `fetch` que responde con la misma forma que
 * OANDA (la de las respuestas grabadas de `__fixtures__/oanda/`) y
 * mantiene en memoria saldo, posiciones, órdenes y transacciones:
 *
 * - Las de mercado se ejecutan al instante (compra al ask, venta al bid)
 *   y crean el stop y el objetivo adjuntos como órdenes dependientes.
 * - Cerrar una posición realiza el resultado en la divisa de la cuenta
 *   (EUR; lo cotizado en USD/JPY se convierte con EUR/USD y USD/JPY).
 * - Autentica como OANDA: 401 con otro token y 403 con otra cuenta; las
 *   peticiones a otro host fallan como un error de red.
 */
import { FX_INSTRUMENT_SPECS, fromOandaInstrument } from '../../../shared/fxBroker';

type JsonObject = Record<string, unknown>;

export interface OandaFakeServerOptions {
  baseUrl: string;
  token: string;
  accountId: string;
  /** Saldo inicial en EUR; 100 por defecto. */
  balance?: number;
  /** Horquilla bid/ask por instrumento OANDA ('EUR_USD'). */
  prices?: Record<string, { bid: number; ask: number }>;
  now?: () => number;
}

export interface OandaFakeServer {
  fetch: typeof globalThis.fetch;
  /** Mueve el precio de un instrumento (para simular ganancias/pérdidas). */
  setPrice(instrument: string, bid: number, ask: number): void;
  /** Próxima petición de órdenes falla así (E2E y pruebas de error). */
  failNext(kind: 'reject' | 'server' | 'timeout'): void;
  /** Quita una posición sin pasar por la app (para provocar un descuadre). */
  forgetPosition(instrument: string): void;
  readonly requests: { method: string; path: string; body: unknown }[];
}

const DEFAULT_PRICES: Record<string, { bid: number; ask: number }> = {
  EUR_USD: { bid: 1.0845, ask: 1.08462 },
  USD_JPY: { bid: 151.2, ask: 151.214 },
  GBP_USD: { bid: 1.27, ask: 1.27015 },
  XAU_USD: { bid: 2650.1, ask: 2650.5 },
};

interface FakePosition {
  units: number; // con signo
  avg: number;
}

interface FakeOrder extends JsonObject {
  id: string;
  state: string;
}

export function createOandaFakeServer(options: OandaFakeServerOptions): OandaFakeServer {
  const now = options.now ?? (() => Date.parse('2026-11-23T15:00:00.000Z'));
  const prices: Record<string, { bid: number; ask: number }> = {
    ...DEFAULT_PRICES,
    ...options.prices,
  };
  let balance = options.balance ?? 100;
  let txId = 6;
  const positions = new Map<string, FakePosition>();
  const orders: FakeOrder[] = [];
  const transactions = new Map<string, JsonObject>();
  let nextFailure: 'reject' | 'server' | 'timeout' | null = null;
  const requests: OandaFakeServer['requests'] = [];

  const iso = (): string => new Date(now()).toISOString();
  const nextId = (): string => String(++txId);
  const mid = (name: string): number => {
    const p = prices[name] ?? { bid: 1, ask: 1 };
    return (p.bid + p.ask) / 2;
  };
  /** Importe en la moneda cotizada del instrumento → EUR. */
  const toEur = (name: string, amount: number): number => {
    const quote = name.split('_')[1];
    if (quote === 'EUR') return amount;
    if (quote === 'USD') return amount / mid('EUR_USD');
    if (quote === 'JPY') return amount / mid('USD_JPY') / mid('EUR_USD');
    return amount;
  };
  const baseToEur = (name: string, units: number, price: number): number => {
    // Nominal en la moneda cotizada (unidades × precio), salvo USD/JPY
    // cuya base ya es USD.
    if (name === 'USD_JPY') return Math.abs(units) / mid('EUR_USD');
    return toEur(name, Math.abs(units) * price);
  };
  const marginRate = (name: string): number => {
    const symbol = fromOandaInstrument(name);
    return symbol ? FX_INSTRUMENT_SPECS[symbol].marginRate : 0.05;
  };
  const unrealized = (name: string, pos: FakePosition): number => {
    const p = prices[name] ?? { bid: pos.avg, ask: pos.avg };
    const exit = pos.units > 0 ? p.bid : p.ask;
    return toEur(name, (exit - pos.avg) * pos.units);
  };
  const r4 = (n: number): string => n.toFixed(4);

  const summary = (): JsonObject => {
    let upl = 0;
    let margin = 0;
    for (const [name, pos] of positions) {
      upl += unrealized(name, pos);
      margin += baseToEur(name, pos.units, mid(name)) * marginRate(name);
    }
    const nav = balance + upl;
    return {
      id: options.accountId,
      currency: 'EUR',
      balance: r4(balance),
      NAV: r4(nav),
      unrealizedPL: r4(upl),
      marginUsed: r4(margin),
      marginAvailable: r4(Math.max(0, nav - margin)),
      openPositionCount: positions.size,
      pendingOrderCount: orders.filter((o) => o.state === 'PENDING').length,
      lastTransactionID: String(txId),
    };
  };

  const positionJson = (name: string): JsonObject => {
    const pos = positions.get(name);
    const empty = { units: '0', pl: '0.0000', unrealizedPL: '0.0000' };
    if (!pos) return { instrument: name, long: empty, short: empty, unrealizedPL: '0.0000' };
    const leg = {
      units: String(pos.units),
      averagePrice: pos.avg.toFixed(5),
      pl: '0.0000',
      unrealizedPL: r4(unrealized(name, pos)),
    };
    return {
      instrument: name,
      unrealizedPL: leg.unrealizedPL,
      long: pos.units > 0 ? leg : empty,
      short: pos.units < 0 ? leg : empty,
    };
  };

  /** Ejecuta unidades con signo al precio dado; devuelve el resultado realizado (EUR). */
  const applyFill = (name: string, units: number, price: number): number => {
    const pos = positions.get(name);
    if (!pos) {
      positions.set(name, { units, avg: price });
      return 0;
    }
    if (Math.sign(pos.units) === Math.sign(units)) {
      const total = pos.units + units;
      pos.avg = (pos.avg * pos.units + price * units) / total;
      pos.units = total;
      return 0;
    }
    const closing = Math.min(Math.abs(units), Math.abs(pos.units)) * Math.sign(pos.units);
    const pl = toEur(name, (price - pos.avg) * closing);
    balance += pl;
    const remaining = pos.units + units;
    if (remaining === 0) positions.delete(name);
    else if (Math.sign(remaining) === Math.sign(pos.units)) pos.units = remaining;
    else positions.set(name, { units: remaining, avg: price });
    // Las dependientes de la posición cerrada se cancelan con ella.
    if (!positions.has(name)) {
      for (const order of orders) {
        if (order.state === 'PENDING' && order['instrumentOfTrade'] === name) {
          order.state = 'CANCELLED';
        }
      }
    }
    return pl;
  };

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const publicOrder = (order: FakeOrder): JsonObject => {
    const copy: JsonObject = { ...order };
    delete copy['instrumentOfTrade'];
    return copy;
  };

  const createOrder = (body: JsonObject): Response => {
    const order = (body['order'] ?? {}) as JsonObject;
    const name = String(order['instrument']);
    const units = Number(order['units']);
    const type = String(order['type']);
    const ext = order['clientExtensions'] as JsonObject | undefined;
    const clientId = typeof ext?.['id'] === 'string' ? (ext['id'] as string) : undefined;
    if (
      clientId &&
      orders.some((o) => (o['clientExtensions'] as JsonObject)?.['id'] === clientId)
    ) {
      return json(400, {
        errorCode: 'CLIENT_ORDER_ID_ALREADY_EXISTS',
        errorMessage: 'The client order ID specified is already assigned',
      });
    }
    if (!prices[name] || !Number.isInteger(units) || units === 0) {
      return json(400, { errorCode: 'INVALID_UNITS', errorMessage: 'Invalid order' });
    }
    const createdId = nextId();
    const time = iso();
    const created: JsonObject = { ...order, id: createdId, accountID: options.accountId, time };
    if (type !== 'MARKET') {
      orders.push({
        id: createdId,
        createTime: time,
        type,
        instrument: name,
        units: String(units),
        price: order['price'],
        timeInForce: order['timeInForce'],
        state: 'PENDING',
        clientExtensions: ext,
      });
      return json(201, { orderCreateTransaction: created, lastTransactionID: String(txId) });
    }
    const p = prices[name]!;
    const fillPrice = units > 0 ? p.ask : p.bid;
    const stop = (order['stopLossOnFill'] as JsonObject | undefined)?.['price'];
    if (stop !== undefined) {
      const s = Number(stop);
      // OANDA rechaza un stop que saltaría al instante.
      if ((units > 0 && s >= p.bid) || (units < 0 && s <= p.ask)) {
        return json(400, {
          orderRejectTransaction: {
            type: 'MARKET_ORDER_REJECT',
            rejectReason: 'STOP_LOSS_ON_FILL_LOSS',
          },
          errorCode: 'STOP_LOSS_ON_FILL_LOSS',
          errorMessage:
            'The Stop Loss on fill specified would cause the triggering of the Stop Loss',
        });
      }
    }
    const pl = applyFill(name, units, fillPrice);
    const fillId = nextId();
    const fill: JsonObject = {
      type: 'ORDER_FILL',
      orderID: createdId,
      clientOrderID: clientId,
      instrument: name,
      units: String(units),
      price: fillPrice.toFixed(5),
      pl: r4(pl),
      id: fillId,
      time,
    };
    transactions.set(fillId, fill);
    orders.push({
      id: createdId,
      createTime: time,
      type: 'MARKET',
      instrument: name,
      units: String(units),
      timeInForce: 'FOK',
      state: 'FILLED',
      clientExtensions: ext,
      fillingTransactionID: fillId,
      filledTime: time,
    });
    for (const [key, depType] of [
      ['stopLossOnFill', 'STOP_LOSS'],
      ['takeProfitOnFill', 'TAKE_PROFIT'],
    ] as const) {
      const dep = order[key] as JsonObject | undefined;
      if (dep === undefined) continue;
      orders.push({
        id: nextId(),
        createTime: time,
        type: depType,
        tradeID: fillId,
        price: dep['price'],
        timeInForce: 'GTC',
        state: 'PENDING',
        instrumentOfTrade: name,
      });
    }
    return json(201, {
      orderCreateTransaction: created,
      orderFillTransaction: fill,
      lastTransactionID: String(txId),
    });
  };

  const closePosition = (name: string, body: JsonObject): Response => {
    const pos = positions.get(name);
    const wantsLong = body['longUnits'] !== undefined;
    const wantsShort = body['shortUnits'] !== undefined;
    if (!pos || (pos.units > 0 && !wantsLong) || (pos.units < 0 && !wantsShort)) {
      return json(400, {
        errorCode: 'CLOSEOUT_POSITION_DOESNT_EXIST',
        errorMessage: 'The Position requested to be closed out does not exist',
      });
    }
    const p = prices[name]!;
    const units = -pos.units;
    const price = units > 0 ? p.ask : p.bid;
    const pl = applyFill(name, units, price);
    const key = units < 0 ? 'longOrderFillTransaction' : 'shortOrderFillTransaction';
    const fillId = nextId();
    const fill = {
      type: 'ORDER_FILL',
      instrument: name,
      units: String(units),
      price: price.toFixed(5),
      pl: r4(pl),
      id: fillId,
      time: iso(),
    };
    transactions.set(fillId, fill);
    return json(200, { [key]: fill, lastTransactionID: String(txId) });
  };

  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.origin !== options.baseUrl) throw new TypeError(`fetch failed: ${url.origin}`);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as JsonObject) : {};
    requests.push({ method, path: url.pathname + url.search, body: init?.body ? body : undefined });
    if (headers.get('authorization') !== `Bearer ${options.token}`) {
      return json(401, { errorMessage: 'Insufficient authorization to perform request.' });
    }
    const match = /^\/v3\/accounts\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return json(404, { errorMessage: 'Not found' });
    if (decodeURIComponent(match[1]!) !== options.accountId) {
      return json(403, { errorMessage: 'The provided request was forbidden.' });
    }
    const path = match[2] ?? '';
    if (nextFailure && (path.startsWith('/orders') || path.includes('/close'))) {
      const failure = nextFailure;
      nextFailure = null;
      if (failure === 'timeout') {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        throw error;
      }
      if (failure === 'server') return json(503, { errorMessage: 'Service unavailable' });
      return json(400, { errorCode: 'MARKET_HALTED', errorMessage: 'The market is halted' });
    }
    if (method === 'GET' && path === '/summary') return json(200, { account: summary() });
    if (method === 'GET' && path === '/openPositions') {
      return json(200, { positions: [...positions.keys()].map(positionJson) });
    }
    if (method === 'GET' && path === '/pricing') {
      const wanted = (url.searchParams.get('instruments') ?? '').split(',');
      return json(200, {
        prices: wanted
          .filter((name) => prices[name])
          .map((name) => ({
            instrument: name,
            tradeable: true,
            time: iso(),
            bids: [{ price: prices[name]!.bid.toFixed(5), liquidity: 1_000_000 }],
            asks: [{ price: prices[name]!.ask.toFixed(5), liquidity: 1_000_000 }],
          })),
      });
    }
    if (method === 'GET' && path === '/pendingOrders') {
      return json(200, { orders: orders.filter((o) => o.state === 'PENDING').map(publicOrder) });
    }
    if (method === 'GET' && path === '/orders') {
      return json(200, { orders: [...orders].reverse().map(publicOrder) });
    }
    if (method === 'POST' && path === '/orders') return createOrder(body);
    const byClient = /^\/orders\/@(.+)$/.exec(path);
    if (method === 'GET' && byClient) {
      const id = decodeURIComponent(byClient[1]!);
      const order = orders.find((o) => (o['clientExtensions'] as JsonObject)?.['id'] === id);
      return order
        ? json(200, { order: publicOrder(order) })
        : json(404, {
            errorCode: 'NO_SUCH_ORDER',
            errorMessage: 'The order ClientID specified does not exist',
          });
    }
    const cancel = /^\/orders\/([^/]+)\/cancel$/.exec(path);
    if (method === 'PUT' && cancel) {
      const order = orders.find((o) => o.id === decodeURIComponent(cancel[1]!));
      if (!order || order.state !== 'PENDING') {
        return json(404, {
          errorCode: 'ORDER_DOESNT_EXIST',
          errorMessage: 'The Order specified does not exist',
        });
      }
      order.state = 'CANCELLED';
      return json(200, {
        orderCancelTransaction: { type: 'ORDER_CANCEL', orderID: order.id, id: nextId() },
      });
    }
    const orderById = /^\/orders\/([^/@]+)$/.exec(path);
    if (method === 'GET' && orderById) {
      const order = orders.find((o) => o.id === decodeURIComponent(orderById[1]!));
      return order
        ? json(200, { order: publicOrder(order) })
        : json(404, { errorMessage: 'Not found' });
    }
    const tx = /^\/transactions\/(.+)$/.exec(path);
    if (method === 'GET' && tx) {
      const found = transactions.get(decodeURIComponent(tx[1]!));
      return found ? json(200, { transaction: found }) : json(404, { errorMessage: 'Not found' });
    }
    const position = /^\/positions\/([A-Z_]+)(\/close)?$/.exec(path);
    if (position && method === 'GET' && !position[2]) {
      return json(200, { position: positionJson(position[1]!) });
    }
    if (position && method === 'PUT' && position[2]) return closePosition(position[1]!, body);
    return json(404, { errorMessage: `ruta no simulada: ${method} ${path}` });
  };

  return {
    fetch: handle as typeof globalThis.fetch,
    setPrice: (instrument, bid, ask) => {
      prices[instrument] = { bid, ask };
    },
    failNext: (kind) => {
      nextFailure = kind;
    },
    forgetPosition: (instrument) => {
      positions.delete(instrument);
    },
    requests,
  };
}
