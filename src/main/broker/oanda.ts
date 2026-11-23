/**
 * Adaptador del bróker OANDA (API REST v20) — divisas y oro.
 *
 * Alpaca solo opera acciones de EE. UU.; EUR/USD, USD/JPY, GBP/USD y el
 * oro (XAU/USD) van por OANDA, que admite órdenes desde 1 unidad (1 €
 * en EUR/USD): ideal para empezar con muy poco capital. Implementa el
 * mismo contrato `BrokerAdapter` que Alpaca y añade lo propio de un
 * bróker de divisas (precios, cierre de posición y resumen de margen).
 *
 * Dos perfiles con URL FIJA, como Alpaca:
 * - 'practice' → `https://api-fxpractice.oanda.com` (dinero simulado).
 * - 'live' → `https://api-fxtrade.oanda.com` (dinero real). Solo se
 *   construye con la lista del modo real completa (`isLiveGateOpen`) y
 *   la vuelve a comprobar en cada envío; cerrar una posición nunca se
 *   bloquea (reduce riesgo).
 * Cualquier otra URL se rechaza en la construcción ('bad-data'). Un
 * token de un entorno no autentica en el otro: OANDA responde 401 y el
 * adaptador lo traduce a 'auth' con un mensaje claro.
 *
 * - `fetch` es inyectable: las pruebas sirven respuestas grabadas de
 *   `__fixtures__/oanda/` sin tocar la red.
 * - Token y número de cuenta llegan por `getCredentials` (los lee el
 *   servicio desde `secrets`); el token viaja solo en la cabecera
 *   `Authorization` y se borra de cualquier texto externo (`redact`).
 * - Órdenes: 'market' (FOK) con `stopLossOnFill`/`takeProfitOnFill`
 *   adjuntos, 'limit' y 'stop'. El 'oco' de Alpaca no existe en OANDA:
 *   el stop y el objetivo van pegados a la orden de entrada.
 * - `listOrders` omite las órdenes dependientes (stop y objetivo de una
 *   operación abierta): forman parte de la posición, no son órdenes de
 *   la app, y la conciliación las vería como ajenas.
 * - El `clientOrderId` viaja en `clientExtensions.id`; OANDA permite
 *   buscar la orden por él (`/orders/@<id>`), que es lo que hace la
 *   idempotencia tras un tiempo de espera.
 */
import type {
  BrokerAccount,
  BrokerOrderStatus,
  BrokerOrderType,
  BrokerPosition,
} from '../../shared/broker';
import {
  FX_INSTRUMENT_SPECS,
  fromOandaInstrument,
  toFxBrokerInstrument,
  type FxBrokerCredentials,
  type FxBrokerEnvironment,
  type FxBrokerInstrument,
} from '../../shared/fxBroker';
import {
  BrokerError,
  type BrokerAdapter,
  type BrokerErrorKind,
  type BrokerOrderRequest,
  type ListOrdersRequest,
  type RemoteOrder,
} from './types';

export const OANDA_PRACTICE_BASE_URL = 'https://api-fxpractice.oanda.com';
export const OANDA_LIVE_BASE_URL = 'https://api-fxtrade.oanda.com';
export const OANDA_BASE_URLS: Record<FxBrokerEnvironment, string> = {
  practice: OANDA_PRACTICE_BASE_URL,
  live: OANDA_LIVE_BASE_URL,
};
export const OANDA_ADAPTER_IDS = {
  practice: 'oanda-practice',
  live: 'oanda-live',
} as const;
export const OANDA_TIMEOUT_MS = 20_000;

/** Tipos de orden dependientes de una operación (no son órdenes de la app). */
const DEPENDENT_ORDER_TYPES = new Set([
  'STOP_LOSS',
  'TAKE_PROFIT',
  'TRAILING_STOP_LOSS',
  'GUARANTEED_STOP_LOSS',
]);

const OANDA_STATUS_MAP: Record<string, BrokerOrderStatus> = {
  PENDING: 'enviada',
  FILLED: 'ejecutada',
  TRIGGERED: 'ejecutada',
  CANCELLED: 'cancelada',
};

const OANDA_TYPE_MAP: Record<string, BrokerOrderType> = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP: 'stop',
  MARKET_IF_TOUCHED: 'stop',
};

/** Resumen de la cuenta propio de un bróker con margen. */
export interface OandaAccountDetails {
  accountId: string;
  currency: string;
  balance: number;
  nav: number;
  marginUsed: number;
  marginAvailable: number;
  unrealizedPnl: number;
  openPositionCount: number;
}

/** Precio actual de un instrumento (compra y venta). */
export interface OandaPrice {
  instrument: FxBrokerInstrument;
  bid: number;
  ask: number;
  mid: number;
  tradeable: boolean;
  time: string;
}

export interface OandaCloseResult {
  instrument: FxBrokerInstrument;
  /** Unidades cerradas (positivas). */
  units: number;
  /** Precio medio del cierre; null si no había nada que cerrar. */
  fillPrice: number | null;
  /** Resultado realizado del cierre en la divisa de la cuenta. */
  realizedPnl: number | null;
}

export interface OandaAdapter extends BrokerAdapter {
  readonly environment: FxBrokerEnvironment;
  getAccountDetails(): Promise<OandaAccountDetails>;
  getPrices(
    instruments: readonly FxBrokerInstrument[],
  ): Promise<Map<FxBrokerInstrument, OandaPrice>>;
  /** Cierra toda la posición del instrumento (larga y corta). Nunca se bloquea. */
  closePosition(instrument: FxBrokerInstrument): Promise<OandaCloseResult>;
}

export interface OandaBrokerDeps {
  fetch: typeof globalThis.fetch;
  /** Token y cuenta del entorno; null o vacíos = sin conectar ('auth' sin red). */
  getCredentials: () => Promise<FxBrokerCredentials | null>;
  /** Si se pasa, debe ser exactamente la URL del entorno; otra se rechaza. */
  baseUrl?: string;
  timeoutMs?: number;
  logger?: { warn(message: string): void };
  /** Solo 'live': puerta de la lista de comprobación del modo real. */
  isLiveGateOpen?: () => boolean;
}

type JsonObject = Record<string, unknown>;

const truncate = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

export function createOandaBroker(
  environment: FxBrokerEnvironment,
  deps: OandaBrokerDeps,
): OandaAdapter {
  const adapterId = OANDA_ADAPTER_IDS[environment];
  const label = environment === 'practice' ? 'práctica' : 'real';
  const profileUrl = OANDA_BASE_URLS[environment];
  const requested = (deps.baseUrl ?? profileUrl).replace(/\/+$/, '');
  if (requested !== profileUrl) {
    throw new BrokerError(
      'bad-data',
      `OANDA ${label}: solo se admite ${profileUrl}; URL rechazada: ${deps.baseUrl}`,
      { adapter: adapterId },
    );
  }
  const gateOpen = (): boolean =>
    environment === 'practice' || (deps.isLiveGateOpen !== undefined && deps.isLiveGateOpen());
  if (!gateOpen()) {
    throw new BrokerError(
      'reject',
      'OANDA real: la lista de comprobación del modo real no está completa; la cuenta real sigue bloqueada',
      { adapter: adapterId },
    );
  }
  const timeoutMs = deps.timeoutMs ?? OANDA_TIMEOUT_MS;

  const fail = (
    kind: BrokerErrorKind,
    message: string,
    details: { clientOrderId?: string; status?: number; retryAfterMs?: number } = {},
  ): BrokerError =>
    new BrokerError(kind, `OANDA ${label}: ${message}`, { adapter: adapterId, ...details });

  const badData = (detail: string): never => {
    throw fail('bad-data', `respuesta inesperada: ${detail}`);
  };

  const asRecord = (value: unknown, ctx: string): JsonObject => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      badData(`${ctx} no es un objeto: ${truncate(JSON.stringify(value) ?? 'null')}`);
    }
    return value as JsonObject;
  };
  const reqStr = (obj: JsonObject, field: string, ctx: string): string => {
    const value = obj[field];
    if (typeof value !== 'string' || value.length === 0) {
      badData(`${ctx} sin '${field}': ${JSON.stringify(value)}`);
    }
    return value as string;
  };
  const optStr = (obj: JsonObject, field: string): string | null =>
    typeof obj[field] === 'string' && (obj[field] as string).length > 0
      ? (obj[field] as string)
      : null;
  /** OANDA envía números decimales como cadenas ('1.08452', '-10'). */
  const toNum = (value: unknown, field: string, ctx: string): number => {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n)) badData(`${ctx} con '${field}' no numérico: ${JSON.stringify(value)}`);
    return n;
  };
  const reqNum = (obj: JsonObject, field: string, ctx: string): number =>
    toNum(obj[field], field, ctx);
  const optNum = (obj: JsonObject, field: string, ctx: string): number | null => {
    const value = obj[field];
    if (value === null || value === undefined || value === '') return null;
    return toNum(value, field, ctx);
  };

  const instrumentOf = (symbol: string, clientOrderId?: string): FxBrokerInstrument => {
    const instrument = toFxBrokerInstrument(symbol);
    if (instrument === null) {
      throw fail(
        'reject',
        `${symbol} no se opera en OANDA desde Tradia (solo EUR/USD, USD/JPY, GBP/USD y oro)`,
        { clientOrderId },
      );
    }
    return instrument;
  };

  const priceText = (instrument: FxBrokerInstrument, price: number): string =>
    price.toFixed(FX_INSTRUMENT_SPECS[instrument].pricePrecision);

  // -------------------------------------------------------------------------
  // Transporte
  // -------------------------------------------------------------------------

  interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT';
    body?: JsonObject;
    clientOrderId?: string;
  }

  const credentials = async (clientOrderId?: string): Promise<FxBrokerCredentials> => {
    const creds = await deps.getCredentials();
    if (!creds || !creds.token.trim() || !creds.accountId.trim()) {
      throw fail('auth', `sin token o cuenta guardados (cuenta de ${label} no conectada)`, {
        clientOrderId,
      });
    }
    return { token: creds.token.trim(), accountId: creds.accountId.trim() };
  };

  /** Petición autenticada sobre `/v3/accounts/{cuenta}{path}`. */
  const request = async (path: string, options: RequestOptions = {}): Promise<JsonObject> => {
    const creds = await credentials(options.clientOrderId);
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${creds.token}`,
      Accept: 'application/json',
      'Accept-Datetime-Format': 'RFC3339',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const url = `${profileUrl}/v3/accounts/${encodeURIComponent(creds.accountId)}${path}`;
    let response: Response;
    try {
      response = await deps.fetch(url, {
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
          : `fallo de transporte: ${String((error as Error)?.message ?? error)
              .split(creds.token)
              .join('***')}`,
        { clientOrderId: options.clientOrderId },
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    text = text.split(creds.token).join('***');
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw fail('bad-data', 'la respuesta no es JSON válido', {
            clientOrderId: options.clientOrderId,
            status: response.status,
          });
        }
      }
    }

    if (!response.ok) {
      const status = response.status;
      const body = (typeof json === 'object' && json !== null ? json : {}) as JsonObject;
      const reject = (body['orderRejectTransaction'] ?? body['orderCancelRejectTransaction']) as
        JsonObject | undefined;
      const detail =
        optStr(body, 'errorMessage') ??
        (reject ? optStr(reject, 'rejectReason') : null) ??
        truncate(text);
      const code = optStr(body, 'errorCode') ?? (reject ? optStr(reject, 'rejectReason') : null);
      const base = { clientOrderId: options.clientOrderId, status };
      deps.logger?.warn(`[oanda] HTTP ${status} en ${method} ${path}${code ? ` (${code})` : ''}`);
      if (status === 401 || status === 403) {
        throw fail(
          'auth',
          `token o cuenta rechazados (HTTP ${status}): comprueba que el token es de la cuenta de ${label} y que el número de cuenta es el suyo${detail ? ` — ${detail}` : ''}`,
          base,
        );
      }
      if (status === 404) {
        throw fail('not-found', `no encontrado (HTTP 404)${detail ? `: ${detail}` : ''}`, base);
      }
      if (status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw fail('rate-limit', `demasiadas peticiones (HTTP 429): ${detail}`, {
          ...base,
          retryAfterMs:
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        });
      }
      if (status >= 500) throw fail('server', `error del bróker (HTTP ${status}): ${detail}`, base);
      throw fail(
        'reject',
        `orden rechazada por el bróker (HTTP ${status})${code ? ` [${code}]` : ''}: ${detail}`,
        base,
      );
    }
    if (json === null) return {};
    return asRecord(json, 'respuesta');
  };

  // -------------------------------------------------------------------------
  // Mapeos
  // -------------------------------------------------------------------------

  const mapOrder = (
    raw: unknown,
    fill: { price: number | null; time: string | null } | null = null,
  ): RemoteOrder => {
    const obj = asRecord(raw, 'orden');
    const id = reqStr(obj, 'id', 'orden');
    const ctx = `orden ${id}`;
    const rawType = reqStr(obj, 'type', ctx);
    const type = OANDA_TYPE_MAP[rawType] ?? badData(`${ctx} con tipo no admitido: ${rawType}`);
    const instrument =
      fromOandaInstrument(reqStr(obj, 'instrument', ctx)) ??
      badData(`${ctx} con instrumento ajeno: ${String(obj['instrument'])}`);
    const units = reqNum(obj, 'units', ctx);
    if (units === 0) badData(`${ctx} con 0 unidades`);
    const stateRaw = reqStr(obj, 'state', ctx);
    const status =
      OANDA_STATUS_MAP[stateRaw] ?? badData(`${ctx} con estado desconocido: ${stateRaw}`);
    const ext = obj['clientExtensions'];
    const clientOrderId =
      typeof ext === 'object' && ext !== null && typeof (ext as JsonObject)['id'] === 'string'
        ? ((ext as JsonObject)['id'] as string)
        : '';
    const price = optNum(obj, 'price', ctx);
    const filled = status === 'ejecutada';
    return {
      brokerOrderId: id,
      clientOrderId,
      ticker: instrument,
      type,
      side: units > 0 ? 'buy' : 'sell',
      quantity: Math.abs(units),
      filledQuantity: filled ? Math.abs(units) : 0,
      limitPrice: type === 'limit' ? price : null,
      stopPrice: type === 'stop' ? price : null,
      status,
      submittedAt: reqStr(obj, 'createTime', ctx),
      filledAt: filled ? (fill?.time ?? optStr(obj, 'filledTime')) : null,
      filledAvgPrice: filled ? (fill?.price ?? null) : null,
      ocoGroupId: null,
      legs: null,
    };
  };

  /** Precio y hora de la transacción de ejecución de una orden ya ejecutada. */
  const fillOf = async (
    order: JsonObject,
  ): Promise<{ price: number | null; time: string | null }> => {
    const txId = optStr(order, 'fillingTransactionID');
    if (txId === null) return { price: null, time: optStr(order, 'filledTime') };
    const raw = await request(`/transactions/${encodeURIComponent(txId)}`);
    const tx = asRecord(raw['transaction'], `transacción ${txId}`);
    return { price: optNum(tx, 'price', `transacción ${txId}`), time: optStr(tx, 'time') };
  };

  const orderBody = (req: BrokerOrderRequest, instrument: FxBrokerInstrument): JsonObject => {
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) {
      throw fail('bad-data', `las unidades deben ser un entero positivo: ${req.quantity}`, {
        clientOrderId: req.clientOrderId,
      });
    }
    const units = String(req.side === 'buy' ? req.quantity : -req.quantity);
    const base: JsonObject = {
      instrument: FX_INSTRUMENT_SPECS[instrument].oanda,
      units,
      positionFill: 'DEFAULT',
      clientExtensions: { id: req.clientOrderId, tag: 'tradia' },
    };
    const onFill = (price: number | null | undefined, key: string): JsonObject =>
      price === null || price === undefined
        ? {}
        : { [key]: { price: priceText(instrument, price), timeInForce: 'GTC' } };
    const brackets = {
      ...onFill(req.stopLossOnFill, 'stopLossOnFill'),
      ...onFill(req.takeProfitOnFill, 'takeProfitOnFill'),
    };
    if (req.type === 'market') return { ...base, type: 'MARKET', timeInForce: 'FOK', ...brackets };
    const timeInForce = req.timeInForce === 'day' ? 'GFD' : 'GTC';
    if (req.type === 'limit') {
      return {
        ...base,
        type: 'LIMIT',
        price: priceText(instrument, req.limitPrice as number),
        timeInForce,
        ...brackets,
      };
    }
    if (req.type === 'stop') {
      return {
        ...base,
        type: 'STOP',
        price: priceText(instrument, req.stopPrice as number),
        timeInForce,
        ...brackets,
      };
    }
    throw fail(
      'bad-data',
      "OANDA no tiene órdenes 'oco' sueltas: el stop y el objetivo van adjuntos a la orden de entrada",
      { clientOrderId: req.clientOrderId },
    );
  };

  const assertOrder = (req: BrokerOrderRequest): FxBrokerInstrument => {
    const bad = (detail: string): never => {
      throw fail('bad-data', `orden inválida: ${detail}`, { clientOrderId: req?.clientOrderId });
    };
    if (typeof req !== 'object' || req === null) bad('la petición no es un objeto');
    if (
      typeof req.clientOrderId !== 'string' ||
      req.clientOrderId.trim().length === 0 ||
      req.clientOrderId.length > 64
    ) {
      bad('clientOrderId debe ser una cadena no vacía de hasta 64 caracteres');
    }
    const instrument = instrumentOf(req.ticker, req.clientOrderId);
    const positive = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0;
    if (req.type === 'limit' && !positive(req.limitPrice))
      bad("una orden 'limit' necesita limitPrice");
    if (req.type === 'stop' && !positive(req.stopPrice)) bad("una orden 'stop' necesita stopPrice");
    for (const [name, value] of [
      ['stopLossOnFill', req.stopLossOnFill],
      ['takeProfitOnFill', req.takeProfitOnFill],
    ] as const) {
      if (value !== null && value !== undefined && !positive(value)) bad(`${name} debe ser > 0`);
    }
    return instrument;
  };

  // -------------------------------------------------------------------------
  // Operaciones
  // -------------------------------------------------------------------------

  const getAccountDetails = async (): Promise<OandaAccountDetails> => {
    const raw = await request('/summary');
    const acc = asRecord(raw['account'], 'cuenta');
    return {
      accountId: reqStr(acc, 'id', 'cuenta'),
      currency: reqStr(acc, 'currency', 'cuenta'),
      balance: reqNum(acc, 'balance', 'cuenta'),
      nav: reqNum(acc, 'NAV', 'cuenta'),
      marginUsed: optNum(acc, 'marginUsed', 'cuenta') ?? 0,
      marginAvailable: optNum(acc, 'marginAvailable', 'cuenta') ?? 0,
      unrealizedPnl: optNum(acc, 'unrealizedPL', 'cuenta') ?? 0,
      openPositionCount: optNum(acc, 'openPositionCount', 'cuenta') ?? 0,
    };
  };

  const listOrders = async (req?: ListOrdersRequest): Promise<RemoteOrder[]> => {
    const raw =
      req?.openOnly === true
        ? await request('/pendingOrders')
        : await request('/orders?state=ALL&count=500');
    const orders = raw['orders'];
    if (!Array.isArray(orders))
      badData(`órdenes no es una lista: ${truncate(JSON.stringify(orders))}`);
    return (orders as unknown[])
      .filter((order) => {
        const type = (order as JsonObject | null)?.['type'];
        return !(typeof type === 'string' && DEPENDENT_ORDER_TYPES.has(type));
      })
      .map((order) => mapOrder(order));
  };

  const adapter: OandaAdapter = {
    id: adapterId,
    paperOnly: environment === 'practice',
    environment,

    getAccount: async () => {
      const details = await getAccountDetails();
      const account: BrokerAccount = {
        accountId: details.accountId,
        // OANDA no informa un estado: una cuenta que responde está operativa.
        status: 'ACTIVE',
        currency: details.currency,
        cash: details.balance,
        equity: details.nav,
        buyingPower: details.marginAvailable,
        paper: environment === 'practice',
        // En divisas vender primero es lo normal: no hay préstamo de títulos.
        shortingEnabled: true,
      };
      return account;
    },

    getAccountDetails,

    listPositions: async () => {
      const raw = await request('/openPositions');
      const positions = raw['positions'];
      if (!Array.isArray(positions)) badData('posiciones no es una lista');
      const out: BrokerPosition[] = [];
      for (const entry of positions as unknown[]) {
        const obj = asRecord(entry, 'posición');
        const name = reqStr(obj, 'instrument', 'posición');
        const instrument = fromOandaInstrument(name);
        if (instrument === null) continue; // instrumento abierto fuera de Tradia
        for (const sideKey of ['long', 'short'] as const) {
          const leg = obj[sideKey];
          if (typeof leg !== 'object' || leg === null) continue;
          const legObj = leg as JsonObject;
          const units = optNum(legObj, 'units', `posición ${name}`) ?? 0;
          if (units === 0) continue;
          out.push({
            ticker: instrument,
            side: sideKey,
            quantity: Math.abs(units),
            avgEntryPrice: reqNum(legObj, 'averagePrice', `posición ${name}`),
            marketValue: null,
            unrealizedPnl: optNum(legObj, 'unrealizedPL', `posición ${name}`),
            currency: FX_INSTRUMENT_SPECS[instrument].quote,
          });
        }
      }
      return out;
    },

    getPrices: async (instruments) => {
      const names = [...new Set(instruments)].map((i) => FX_INSTRUMENT_SPECS[i].oanda);
      const raw = await request(`/pricing?instruments=${encodeURIComponent(names.join(','))}`);
      const prices = raw['prices'];
      if (!Array.isArray(prices)) badData('precios no es una lista');
      const out = new Map<FxBrokerInstrument, OandaPrice>();
      for (const entry of prices as unknown[]) {
        const obj = asRecord(entry, 'precio');
        const instrument = fromOandaInstrument(obj['instrument']);
        if (instrument === null) continue;
        const best = (key: 'bids' | 'asks'): number => {
          const book = obj[key];
          if (!Array.isArray(book) || book.length === 0) badData(`precio sin ${key}`);
          return reqNum(asRecord((book as unknown[])[0], key), 'price', `precio ${key}`);
        };
        const bid = best('bids');
        const ask = best('asks');
        out.set(instrument, {
          instrument,
          bid,
          ask,
          mid: (bid + ask) / 2,
          tradeable: obj['tradeable'] !== false,
          time: optStr(obj, 'time') ?? '',
        });
      }
      return out;
    },

    listOrders,

    getOrderByClientId: async (clientOrderId) => {
      if (typeof clientOrderId !== 'string' || clientOrderId.trim().length === 0) {
        throw fail('bad-data', `client_order_id inválido: ${JSON.stringify(clientOrderId)}`);
      }
      let raw: JsonObject;
      try {
        raw = await request(`/orders/@${encodeURIComponent(clientOrderId)}`, { clientOrderId });
      } catch (error) {
        if (error instanceof BrokerError && error.kind === 'not-found') return null;
        throw error;
      }
      const order = asRecord(raw['order'], 'orden');
      const fill = optStr(order, 'state') === 'FILLED' ? await fillOf(order) : null;
      return mapOrder(order, fill);
    },

    submitOrder: async (req) => {
      const instrument = assertOrder(req);
      if (!gateOpen()) {
        throw fail(
          'reject',
          'la lista de comprobación del modo real no está completa; el envío está bloqueado',
          { clientOrderId: req.clientOrderId },
        );
      }
      const raw = await request('/orders', {
        method: 'POST',
        body: { order: orderBody(req, instrument) },
        clientOrderId: req.clientOrderId,
      });
      const created = raw['orderCreateTransaction'];
      if (typeof created !== 'object' || created === null) badData('sin orderCreateTransaction');
      const createdTx = created as JsonObject;
      const cancelled = raw['orderCancelTransaction'] as JsonObject | undefined;
      if (cancelled && req.type === 'market') {
        // Una de mercado FOK que no se ejecuta (mercado cerrado, margen
        // insuficiente, stop en el lado equivocado…) se cancela al
        // instante: para la app es un rechazo de negocio.
        throw fail(
          'reject',
          `la orden no se ejecutó (${optStr(cancelled, 'reason') ?? 'cancelada por el bróker'})`,
          { clientOrderId: req.clientOrderId },
        );
      }
      const fillTx = raw['orderFillTransaction'] as JsonObject | undefined;
      const orderId = reqStr(createdTx, 'id', 'orderCreateTransaction');
      const createdAt = optStr(createdTx, 'time') ?? new Date().toISOString();
      const filled = fillTx !== undefined;
      return {
        brokerOrderId: orderId,
        clientOrderId: req.clientOrderId,
        ticker: instrument,
        type: req.type,
        side: req.side,
        quantity: req.quantity,
        filledQuantity: filled ? Math.abs(optNum(fillTx, 'units', 'ejecución') ?? req.quantity) : 0,
        limitPrice: req.type === 'limit' ? (req.limitPrice ?? null) : null,
        stopPrice: req.type === 'stop' ? (req.stopPrice ?? null) : null,
        status: filled ? 'ejecutada' : cancelled ? 'cancelada' : 'enviada',
        submittedAt: createdAt,
        filledAt: filled ? (optStr(fillTx, 'time') ?? createdAt) : null,
        filledAvgPrice: filled ? optNum(fillTx, 'price', 'ejecución') : null,
        ocoGroupId: null,
        legs: null,
      };
    },

    cancelOrder: async (brokerOrderId) => {
      if (typeof brokerOrderId !== 'string' || brokerOrderId.trim().length === 0) {
        throw fail('bad-data', `id de orden inválido: ${JSON.stringify(brokerOrderId)}`);
      }
      const path = `/orders/${encodeURIComponent(brokerOrderId)}`;
      await request(`${path}/cancel`, { method: 'PUT' });
      const raw = await request(path);
      return mapOrder(raw['order']);
    },

    closePosition: async (instrument) => {
      const name = FX_INSTRUMENT_SPECS[instrument].oanda;
      const positionsRaw = await request(`/positions/${encodeURIComponent(name)}`).catch(
        (error: unknown) => {
          if (error instanceof BrokerError && error.kind === 'not-found') return null;
          throw error;
        },
      );
      const position = positionsRaw
        ? (positionsRaw['position'] as JsonObject | undefined)
        : undefined;
      const unitsOf = (key: 'long' | 'short'): number => {
        const leg = position?.[key];
        if (typeof leg !== 'object' || leg === null) return 0;
        return optNum(leg as JsonObject, 'units', `posición ${name}`) ?? 0;
      };
      const longUnits = unitsOf('long');
      const shortUnits = unitsOf('short');
      if (longUnits === 0 && shortUnits === 0) {
        return { instrument, units: 0, fillPrice: null, realizedPnl: null };
      }
      const raw = await request(`/positions/${encodeURIComponent(name)}/close`, {
        method: 'PUT',
        body: {
          ...(longUnits !== 0 ? { longUnits: 'ALL' } : {}),
          ...(shortUnits !== 0 ? { shortUnits: 'ALL' } : {}),
        },
      });
      let units = 0;
      let notional = 0;
      let pnl = 0;
      let anyPnl = false;
      for (const key of ['longOrderFillTransaction', 'shortOrderFillTransaction']) {
        const tx = raw[key];
        if (typeof tx !== 'object' || tx === null) continue;
        const txObj = tx as JsonObject;
        const u = Math.abs(optNum(txObj, 'units', key) ?? 0);
        const p = optNum(txObj, 'price', key);
        units += u;
        if (p !== null) notional += u * p;
        const pl = optNum(txObj, 'pl', key);
        if (pl !== null) {
          pnl += pl;
          anyPnl = true;
        }
      }
      return {
        instrument,
        units,
        fillPrice: units > 0 && notional > 0 ? notional / units : null,
        realizedPnl: anyPnl ? pnl : null,
      };
    },
  };
  return adapter;
}
