/**
 * Adaptador del broker Alpaca en modo paper — Fase 5.
 *
 * Habla con la API REST v2 de Alpaca (`GET/POST /v2/orders`, `DELETE`,
 * `/v2/account`, `/v2/positions`) contra la URL paper FIJA
 * `https://paper-api.alpaca.markets`: la app no tiene modo real y el
 * constructor rechaza cualquier otra URL (`BrokerError` 'bad-data'), así
 * que ni una clave ni una orden pueden escapar a producción. Las claves
 * live no pasan la autenticación del endpoint paper: Alpaca responde 401
 * y el adaptador lo traduce a 'auth' con un mensaje claro.
 *
 * - `fetch` es inyectable: las pruebas sirven respuestas grabadas de
 *   `__fixtures__` (servidor falso en `__fixtures__/fake-server.ts`) sin
 *   tocar la red.
 * - Las claves (`APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`) se piden por
 *   `getCredentials` inyectado — quien monta el adaptador las lee del
 *   servicio `secrets` (`BROKER_SECRET_KEYS`); viajan en cabeceras,
 *   nunca en la URL ni en mensajes de error (cualquier texto externo se
 *   sanea con `redact` antes de llegar al error o al logger).
 * - Errores HTTP → `BrokerError`: 401/403 → 'auth', 404 → 'not-found',
 *   429 → 'rate-limit' (con `retryAfterMs` si llega `Retry-After`),
 *   5xx → 'server', 4xx de negocio → 'reject' (nunca se reintenta),
 *   transporte → 'network', tiempo de espera → 'timeout', JSON o campos
 *   malformados → 'bad-data'.
 * - Órdenes: 'market'|'limit'|'stop' (order_class simple) y 'oco'
 *   (`order_class=oco` con `take_profit`/`stop_loss`, que Alpaca exige
 *   en `time_in_force=gtc`). `cancelOrder` hace `DELETE` y confirma el
 *   estado con un `GET` (el `DELETE` devuelve 204 sin cuerpo).
 * - `listOrders` pide `nested=true` para que las patas de un OCO lleguen
 *   dentro del padre, no como órdenes sueltas.
 */
import type {
  BrokerAccount,
  BrokerOrderSide,
  BrokerOrderStatus,
  BrokerOrderType,
  BrokerPosition,
} from '../../shared/broker';
import {
  assertValidOrderRequest,
  BrokerError,
  type BrokerAdapter,
  type BrokerOrderRequest,
  type ListOrdersRequest,
  type RemoteOrder,
} from './types';

export const ALPACA_ADAPTER_ID = 'alpaca';
/** Única URL admitida: el adaptador solo puede hablar con Alpaca paper. */
export const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
export const ALPACA_TIMEOUT_MS = 20_000;
/** Máximo de órdenes por página en `listOrders` (límite de la API). */
const LIST_ORDERS_PAGE_LIMIT = 500;

/** Credenciales de Alpaca tal como viven (cifradas) en `secrets`. */
export interface AlpacaCredentials {
  apiKeyId: string;
  apiSecret: string;
}

export interface AlpacaBrokerDeps {
  /** fetch inyectable (en producción, la global del proceso principal). */
  fetch: typeof globalThis.fetch;
  /**
   * Lee las claves del servicio secrets (solo proceso principal). Null o
   * campos vacíos = cuenta sin conectar → 'auth' sin tocar la red.
   */
  getCredentials: () => Promise<AlpacaCredentials | null>;
  /** Si se pasa, debe ser exactamente la URL paper; otra se rechaza. */
  baseUrl?: string;
  timeoutMs?: number;
  logger?: { warn(message: string): void };
}

type JsonObject = Record<string, unknown>;

/** Quita las claves de cualquier texto externo antes de meterlo en un error. */
function redact(text: string, creds: AlpacaCredentials | null): string {
  if (!creds) return text;
  return text.split(creds.apiKeyId).join('***').split(creds.apiSecret).join('***');
}

const truncate = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Estados de orden de Alpaca → estados normalizados del contrato. */
const ALPACA_STATUS_MAP: Record<string, BrokerOrderStatus> = {
  new: 'enviada',
  accepted: 'enviada',
  pending_new: 'enviada',
  accepted_for_bidding: 'enviada',
  pending_review: 'enviada',
  pending_replace: 'enviada',
  pending_cancel: 'enviada',
  stopped: 'enviada',
  suspended: 'enviada',
  calculated: 'enviada',
  held: 'enviada',
  partially_filled: 'parcial',
  filled: 'ejecutada',
  canceled: 'cancelada',
  expired: 'cancelada',
  replaced: 'cancelada',
  done_for_day: 'cancelada',
  rejected: 'rechazada',
};

/** Tipos de orden de Alpaca (order_class simple) → tipos del contrato. */
const ALPACA_TYPE_MAP: Record<string, BrokerOrderType> = {
  market: 'market',
  limit: 'limit',
  stop: 'stop',
};

export function createAlpacaBroker(deps: AlpacaBrokerDeps): BrokerAdapter {
  const requestedBase = (deps.baseUrl ?? ALPACA_PAPER_BASE_URL).replace(/\/+$/, '');
  if (requestedBase !== ALPACA_PAPER_BASE_URL) {
    throw new BrokerError(
      'bad-data',
      `Alpaca: solo se admite la cuenta paper (${ALPACA_PAPER_BASE_URL}); URL rechazada: ${deps.baseUrl}`,
      { adapter: ALPACA_ADAPTER_ID },
    );
  }
  const baseUrl = requestedBase;
  const timeoutMs = deps.timeoutMs ?? ALPACA_TIMEOUT_MS;

  const fail = (
    kind: ConstructorParameters<typeof BrokerError>[0],
    message: string,
    details: { clientOrderId?: string; status?: number; retryAfterMs?: number } = {},
  ): BrokerError =>
    new BrokerError(kind, `Alpaca: ${message}`, {
      adapter: ALPACA_ADAPTER_ID,
      ...details,
    });

  const badData = (detail: string, clientOrderId?: string): never => {
    throw fail('bad-data', `respuesta inesperada: ${detail}`, { clientOrderId });
  };

  const asRecord = (value: unknown, ctx: string): JsonObject => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      badData(`${ctx} no es un objeto: ${truncate(JSON.stringify(value) ?? 'null')}`);
    }
    return value as JsonObject;
  };

  const reqStr = (obj: JsonObject, field: string, ctx: string): string => {
    const value = obj[field];
    if (typeof value !== 'string') badData(`${ctx} sin '${field}' texto: ${JSON.stringify(value)}`);
    return value as string;
  };

  const optStr = (obj: JsonObject, field: string): string | null =>
    typeof obj[field] === 'string' && (obj[field] as string).length > 0
      ? (obj[field] as string)
      : null;

  /** Alpaca devuelve cantidades y precios como cadenas decimales. */
  const toNum = (value: unknown, field: string, ctx: string): number => {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n)) {
      badData(`${ctx} con '${field}' no numérico: ${JSON.stringify(value)}`);
    }
    return n;
  };

  const reqNum = (obj: JsonObject, field: string, ctx: string): number =>
    toNum(obj[field], field, ctx);

  const optNum = (obj: JsonObject, field: string, ctx: string): number | null => {
    const value = obj[field];
    if (value === null || value === undefined || value === '') return null;
    return toNum(value, field, ctx);
  };

  const mapStatus = (raw: string, ctx: string): BrokerOrderStatus => {
    const status = ALPACA_STATUS_MAP[raw];
    if (status === undefined) {
      return badData(`${ctx} con estado desconocido: ${JSON.stringify(raw)}`);
    }
    return status;
  };

  const mapOrder = (raw: unknown, ocoGroupId: string | null = null): RemoteOrder => {
    const obj = asRecord(raw, 'orden');
    const id = reqStr(obj, 'id', 'orden');
    const orderClass = optStr(obj, 'order_class') ?? 'simple';
    const ctx = `orden ${id}`;
    const rawType = reqStr(obj, 'type', ctx);
    const type =
      orderClass === 'oco'
        ? 'oco'
        : orderClass === 'simple'
          ? (ALPACA_TYPE_MAP[rawType] ?? badData(`${ctx} con tipo no admitido: ${rawType}`))
          : badData(`${ctx} con order_class no admitido: ${orderClass}`);
    const sideRaw = reqStr(obj, 'side', ctx);
    if (sideRaw !== 'buy' && sideRaw !== 'sell') badData(`${ctx} con side inválido: ${sideRaw}`);
    const rawLegs = obj['legs'];
    const legs = Array.isArray(rawLegs) ? rawLegs.map((leg) => mapOrder(leg, id)) : null;
    return {
      brokerOrderId: id,
      clientOrderId: typeof obj['client_order_id'] === 'string' ? obj['client_order_id'] : '',
      ticker: reqStr(obj, 'symbol', ctx),
      type,
      side: sideRaw as BrokerOrderSide,
      quantity: reqNum(obj, 'qty', ctx),
      filledQuantity: optNum(obj, 'filled_qty', ctx) ?? 0,
      limitPrice: optNum(obj, 'limit_price', ctx),
      stopPrice: optNum(obj, 'stop_price', ctx),
      status: mapStatus(reqStr(obj, 'status', ctx), ctx),
      submittedAt: optStr(obj, 'submitted_at') ?? reqStr(obj, 'created_at', ctx),
      filledAt: optStr(obj, 'filled_at'),
      filledAvgPrice: optNum(obj, 'filled_avg_price', ctx),
      ocoGroupId: orderClass === 'oco' ? id : ocoGroupId,
      legs,
    };
  };

  interface RequestOptions {
    method?: 'GET' | 'POST' | 'DELETE';
    body?: JsonObject;
    clientOrderId?: string;
  }

  /** Petición autenticada a la API paper; devuelve el JSON o null en 204. */
  const request = async (path: string, options: RequestOptions = {}): Promise<unknown> => {
    const creds = await deps.getCredentials();
    if (!creds || !creds.apiKeyId.trim() || !creds.apiSecret.trim()) {
      throw fail('auth', 'sin claves del broker guardadas en secrets (cuenta paper no conectada)', {
        clientOrderId: options.clientOrderId,
      });
    }
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      'APCA-API-KEY-ID': creds.apiKeyId,
      'APCA-API-SECRET-KEY': creds.apiSecret,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await deps.fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: unknown })?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw fail(
        timedOut ? 'timeout' : 'network',
        timedOut
          ? `tiempo de espera agotado (${timeoutMs} ms): la operación pudo aplicarse, comprobar por client_order_id`
          : `fallo de transporte: ${String((error as Error)?.message ?? error)}`,
        { clientOrderId: options.clientOrderId },
      );
    }

    if (response.status === 204) return null;

    if (!response.ok) {
      let body: string;
      try {
        body = truncate(await response.text());
      } catch {
        body = '';
      }
      const detail = redact(body, creds);
      const status = response.status;
      deps.logger?.warn(`[alpaca] HTTP ${status} en ${method} ${path}`);
      const base = { clientOrderId: options.clientOrderId, status };
      if (status === 401 || status === 403) {
        throw fail(
          'auth',
          `credenciales rechazadas (HTTP ${status}): comprueba que son de una cuenta paper${detail ? ` — ${detail}` : ''}`,
          base,
        );
      }
      if (status === 404) {
        throw fail(
          'not-found',
          `recurso no encontrado (HTTP 404)${detail ? `: ${detail}` : ''}`,
          base,
        );
      }
      if (status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const retryAfterMs =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
        throw fail('rate-limit', `cuota del broker excedida (HTTP 429): ${detail}`, {
          ...base,
          retryAfterMs,
        });
      }
      if (status >= 500) {
        throw fail('server', `error del broker (HTTP ${status}): ${detail}`, base);
      }
      // Resto de 4xx (400, 403 tratada arriba, 422…): rechazo de negocio.
      throw fail('reject', `orden rechazada por el broker (HTTP ${status}): ${detail}`, base);
    }

    try {
      return await response.json();
    } catch {
      throw fail('bad-data', 'la respuesta no es JSON válido', {
        clientOrderId: options.clientOrderId,
        status: response.status,
      });
    }
  };

  const orderBody = (req: BrokerOrderRequest): JsonObject => {
    const base: JsonObject = {
      symbol: req.ticker.toUpperCase(),
      qty: String(req.quantity),
      side: req.side,
      client_order_id: req.clientOrderId,
      // Alpaca exige time_in_force 'gtc' en órdenes con patas (OCO).
      time_in_force: req.type === 'oco' ? 'gtc' : (req.timeInForce ?? 'day'),
    };
    if (req.type === 'oco') {
      return {
        ...base,
        type: 'limit',
        order_class: 'oco',
        limit_price: String(req.limitPrice),
        take_profit: { limit_price: String(req.limitPrice) },
        stop_loss: { stop_price: String(req.stopPrice) },
      };
    }
    const body: JsonObject = { ...base, type: req.type };
    if (req.type === 'limit') body['limit_price'] = String(req.limitPrice);
    if (req.type === 'stop') body['stop_price'] = String(req.stopPrice);
    return body;
  };

  return {
    id: ALPACA_ADAPTER_ID,
    paperOnly: true,

    getAccount: async () => {
      const raw = asRecord(await request('/v2/account'), 'cuenta');
      const account: BrokerAccount = {
        accountId: optStr(raw, 'account_number') ?? reqStr(raw, 'id', 'cuenta'),
        status: reqStr(raw, 'status', 'cuenta'),
        currency: reqStr(raw, 'currency', 'cuenta'),
        cash: reqNum(raw, 'cash', 'cuenta'),
        equity: reqNum(raw, 'equity', 'cuenta'),
        buyingPower: optNum(raw, 'buying_power', 'cuenta'),
        paper: true,
      };
      return account;
    },

    listPositions: async () => {
      const raw = await request('/v2/positions');
      if (!Array.isArray(raw))
        badData(`posiciones no es una lista: ${truncate(JSON.stringify(raw))}`);
      return (raw as unknown[]).map((entry): BrokerPosition => {
        const obj = asRecord(entry, 'posición');
        const side = reqStr(obj, 'side', 'posición');
        if (side !== 'long' && side !== 'short') {
          badData(`posición con side inválido: ${side}`);
        }
        return {
          ticker: reqStr(obj, 'symbol', 'posición'),
          side: side as BrokerPosition['side'],
          quantity: reqNum(obj, 'qty', 'posición'),
          avgEntryPrice: reqNum(obj, 'avg_entry_price', 'posición'),
          marketValue: optNum(obj, 'market_value', 'posición'),
          unrealizedPnl: optNum(obj, 'unrealized_pl', 'posición'),
          // La API de posiciones no informa divisa: Alpaca solo opera en USD.
          currency: 'USD',
        };
      });
    },

    listOrders: async (req?: ListOrdersRequest) => {
      const status = req?.openOnly === true ? 'open' : 'all';
      const raw = await request(
        `/v2/orders?status=${status}&direction=desc&limit=${LIST_ORDERS_PAGE_LIMIT}&nested=true`,
      );
      if (!Array.isArray(raw)) badData(`órdenes no es una lista: ${truncate(JSON.stringify(raw))}`);
      return (raw as unknown[]).map((order) => mapOrder(order));
    },

    getOrderByClientId: async (clientOrderId) => {
      if (typeof clientOrderId !== 'string' || clientOrderId.trim().length === 0) {
        throw fail('bad-data', `client_order_id inválido: ${JSON.stringify(clientOrderId)}`);
      }
      const path = `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`;
      try {
        return mapOrder(await request(path, { clientOrderId }));
      } catch (error) {
        // El contrato espera null cuando el broker no conoce la orden.
        if (error instanceof BrokerError && error.kind === 'not-found') return null;
        throw error;
      }
    },

    submitOrder: async (req: BrokerOrderRequest) => {
      assertValidOrderRequest(req, ALPACA_ADAPTER_ID);
      const raw = await request('/v2/orders', {
        method: 'POST',
        body: orderBody(req),
        clientOrderId: req.clientOrderId,
      });
      return mapOrder(raw);
    },

    cancelOrder: async (brokerOrderId) => {
      if (typeof brokerOrderId !== 'string' || brokerOrderId.trim().length === 0) {
        throw fail('bad-data', `id de orden del broker inválido: ${JSON.stringify(brokerOrderId)}`);
      }
      const path = `/v2/orders/${encodeURIComponent(brokerOrderId)}`;
      // DELETE devuelve 204 sin cuerpo: el estado resultante se confirma
      // con un GET (Alpaca tarda un instante en asentar 'canceled').
      await request(path, { method: 'DELETE' });
      return mapOrder(await request(path));
    },
  };
}
