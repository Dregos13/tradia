/**
 * Broker simulado determinista — pruebas y modo E2E (TRADIA_E2E).
 *
 * Reproduce el contrato `BrokerAdapter` sin red: una cuenta paper con
 * efectivo configurable, órdenes de mercado, limitadas, stop y OCO, y
 * posiciones que se actualizan con cada ejecución.
 *
 * Reglas del motor de ejecución (deterministas, mismo criterio que el
 * seguimiento paper de la fase 4: si una pata del OCO toca las dos, gana
 * el stop):
 * - 'market' ejecuta al instante al precio de referencia con el slippage
 *   fijo configurado (desfavorable: la compra paga de más, la venta cobra
 *   de menos).
 * - 'limit' ejecuta si ya es cruzable (buy: ref ≤ límite; sell: ref ≥
 *   límite) al mejor de los dos precios; si no, queda 'enviada'.
 * - 'stop' ejecuta si está disparado (buy: ref ≥ stop; sell: ref ≤ stop)
 *   al peor de los dos precios (hueco en contra).
 * - 'oco' es la orden padre con dos patas (objetivo limit + stop);
 *   ejecuta la primera pata disparada y cancela la otra. Los ticks de
 *   precio (`setPrice`/`tick`) reevalúan las abiertas.
 *
 * Fallos inyectables (`failNext`, una sola llamada; `setFailing`, hasta
 * retirarlo): 'timeout' (la operación SE APLICA pero la respuesta se
 * pierde, como en la realidad), 'rate-limit' (429), 'server' (5xx),
 * 'reject' (rechazo de negocio) y 'partial' (ejecución parcial). Además
 * `dropOrder`, `tamperPosition` e `injectPhantomOrder` fabrican los
 * descuadres de la conciliación.
 */
import type {
  BrokerE2eFailure,
  BrokerOrderSide,
  BrokerPosition,
} from '../../shared/broker';
import {
  assertValidOrderRequest,
  BrokerError,
  type BrokerAdapter,
  type BrokerErrorKind,
  type BrokerOrderRequest,
  type ListOrdersRequest,
  type RemoteOrder,
} from './types';

export const SIMULATED_BROKER_ID = 'simulado' as const;

export interface SimulatedBrokerOptions {
  /** Semilla de los precios de referencia por ticker (número o texto). */
  seed?: number | string;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Slippage fijo de las de mercado, en puntos básicos (por defecto 5). */
  slippageBps?: number;
  /** Efectivo inicial de la cuenta paper (por defecto 100 000). */
  cash?: number;
  /** Precios de referencia por ticker (en mayúsculas). */
  prices?: Record<string, number>;
  accountId?: string;
}

/** BrokerAdapter simulado con controles extra para pruebas. */
export interface SimulatedBroker extends BrokerAdapter {
  /** Fija el precio de referencia de un ticker (sin reevaluar órdenes). */
  setPrice(ticker: string, price: number): void;
  /** Reevalúa las órdenes abiertas del ticker con el precio actual. */
  tick(ticker: string): void;
  /** Arma un fallo para la próxima llamada (cualquier método). */
  failNext(kind: BrokerE2eFailure): void;
  /** Fallo permanente hasta pasar null; simula al broker caído. */
  setFailing(kind: BrokerE2eFailure | null): void;
  /** El broker olvida una orden (descuadre 'orden-borrada'). */
  dropOrder(clientOrderId: string): boolean;
  /** Añade una orden 'tradia-*' que la app nunca envió (orden fantasma). */
  injectPhantomOrder(patch?: Partial<RemoteOrder>): RemoteOrder;
  /** Altera una posición del broker (descuadre 'posicion-cantidad'). */
  tamperPosition(ticker: string, patch: { quantity?: number; avgEntryPrice?: number }): void;
  /** Establece una posición tal cual (siembra de pruebas). */
  setPosition(position: BrokerPosition): void;
  /** Ejecuta a mano una orden abierta (leg: qué pata de un OCO). */
  fillOrder(
    clientOrderId: string,
    options?: { price?: number; leg?: 'objetivo' | 'stop' },
  ): RemoteOrder | null;
  /** Vuelve al estado inicial (cuenta limpia, sin órdenes ni posiciones). */
  reset(): void;
}

/** Hash FNV-1a de una semilla de texto a uint32. */
function hashSeed(seed: number | string): number {
  const text = String(seed);
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
const normalizeTicker = (ticker: string): string => ticker.trim().toUpperCase();

interface PositionState {
  /** Cantidad neta con signo (+largo / −corto). */
  signedQty: number;
  avgPrice: number;
}

const FAILURE_KIND_TO_ERROR: Record<Exclude<BrokerE2eFailure, 'partial'>, BrokerErrorKind> = {
  timeout: 'timeout',
  'rate-limit': 'rate-limit',
  server: 'server',
  reject: 'reject',
};

export function createSimulatedBroker(options: SimulatedBrokerOptions = {}): SimulatedBroker {
  const seed = options.seed ?? 'tradia-broker';
  const now = options.now ?? (() => Date.now());
  const slippageBps = options.slippageBps ?? 5;
  const initialCash = options.cash ?? 100_000;
  const accountId = options.accountId ?? 'SIM-PAPER-001';
  const initialPrices = new Map<string, number>(
    Object.entries(options.prices ?? {}).map(([t, p]) => [normalizeTicker(t), p] as const),
  );

  let prices = new Map(initialPrices);
  let orders: RemoteOrder[] = [];
  let positions = new Map<string, PositionState>();
  let cash = initialCash;
  let orderSeq = 0;
  let phantomSeq = 0;
  let armedFailure: BrokerE2eFailure | null = null;
  let persistentFailure: BrokerE2eFailure | null = null;

  const isoNow = (): string => new Date(now()).toISOString();

  /** Precio de referencia determinista: inyectado o derivado del ticker. */
  const refPrice = (ticker: string): number => {
    const key = normalizeTicker(ticker);
    const injected = prices.get(key);
    if (injected !== undefined) return injected;
    return round2(20 + (hashSeed(`${String(seed)}:${key}`) % 48_000) / 100);
  };

  const fail = (kind: BrokerErrorKind, detail: string, clientOrderId?: string): never => {
    throw new BrokerError(kind, `broker simulado: ${detail}`, {
      adapter: SIMULATED_BROKER_ID,
      clientOrderId,
      status: kind === 'rate-limit' ? 429 : kind === 'server' ? 500 : undefined,
      retryAfterMs: kind === 'rate-limit' ? 1_000 : undefined,
    });
  };

  /**
   * Consume el fallo armado (prioridad al persistente). Devuelve el fallo
   * a aplicar o null. 'partial' no lanza: la degrada el propio método.
   */
  const consumeFailure = (): BrokerE2eFailure | null => {
    if (persistentFailure !== null) return persistentFailure;
    if (armedFailure !== null) {
      const kind = armedFailure;
      armedFailure = null;
      return kind;
    }
    return null;
  };

  const throwIfFailure = (kind: BrokerE2eFailure | null, clientOrderId?: string): void => {
    if (kind === null || kind === 'partial') return;
    const errorKind = FAILURE_KIND_TO_ERROR[kind];
    fail(
      errorKind,
      kind === 'timeout' ? 'la respuesta se perdió por tiempo de espera' : `fallo ${kind}`,
      clientOrderId,
    );
  };

  // -----------------------------------------------------------------------
  // Estado de mercado y posiciones
  // -----------------------------------------------------------------------

  const applyFill = (ticker: string, side: BrokerOrderSide, qty: number, price: number): void => {
    const key = normalizeTicker(ticker);
    const signed = side === 'buy' ? qty : -qty;
    const pos = positions.get(key) ?? { signedQty: 0, avgPrice: 0 };
    const next = pos.signedQty + signed;
    let avg = pos.avgPrice;
    if (pos.signedQty === 0 || Math.sign(pos.signedQty) === Math.sign(next)) {
      // Aumento de posición (o apertura): precio medio ponderado.
      const total = Math.abs(pos.signedQty) + qty;
      avg = total > 0 ? (pos.avgPrice * Math.abs(pos.signedQty) + price * qty) / total : price;
    } else if (next === 0) {
      avg = 0;
    } else if (Math.sign(next) !== Math.sign(pos.signedQty)) {
      // Cruce de signo: la nueva posición abre al precio de la ejecución.
      avg = price;
    }
    if (next === 0) positions.delete(key);
    else positions.set(key, { signedQty: next, avgPrice: avg });
    cash -= signed * price;
  };

  const marketValue = (ticker: string, qty: number): number => round2(qty * refPrice(ticker));

  const equity = (): number => {
    let total = cash;
    for (const [ticker, pos] of positions) total += pos.signedQty * refPrice(ticker);
    return round2(total);
  };

  const toBrokerPosition = (ticker: string, pos: PositionState): BrokerPosition => {
    const qty = Math.abs(pos.signedQty);
    const ref = refPrice(ticker);
    return {
      ticker,
      side: pos.signedQty > 0 ? 'long' : 'short',
      quantity: round4(qty),
      avgEntryPrice: round4(pos.avgPrice),
      marketValue: marketValue(ticker, qty),
      unrealizedPnl: round2((ref - pos.avgPrice) * pos.signedQty),
      currency: 'USD',
    };
  };

  // -----------------------------------------------------------------------
  // Motor de ejecución
  // -----------------------------------------------------------------------

  /** La orden limitada ya es cruzable al precio de referencia. */
  const limitMarketable = (side: BrokerOrderSide, limit: number, ref: number): boolean =>
    side === 'buy' ? ref <= limit : ref >= limit;

  /** La orden stop ya está disparada al precio de referencia. */
  const stopTriggered = (side: BrokerOrderSide, stop: number, ref: number): boolean =>
    side === 'buy' ? ref >= stop : ref <= stop;

  /** Precio de ejecución de una limit: el mejor de referencia y límite. */
  const limitFill = (side: BrokerOrderSide, limit: number, ref: number): number =>
    side === 'buy' ? Math.min(ref, limit) : Math.max(ref, limit);

  /** Precio de ejecución de una stop: el peor de referencia y stop (hueco). */
  const stopFill = (side: BrokerOrderSide, stop: number, ref: number): number =>
    side === 'buy' ? Math.max(ref, stop) : Math.min(ref, stop);

  const fill = (order: RemoteOrder, price: number, qty?: number): void => {
    const filledQty = round4(qty ?? order.quantity);
    order.filledQuantity = filledQty;
    order.filledAvgPrice = round4(price);
    order.filledAt = isoNow();
    order.status = filledQty >= order.quantity ? 'ejecutada' : 'parcial';
    applyFill(order.ticker, order.side, filledQty, price);
  };

  /** Reevalúa una orden abierta (limit/stop) al precio de referencia. */
  const evalTriggered = (order: RemoteOrder): void => {
    if (order.status !== 'enviada' && order.status !== 'parcial') return;
    const ref = refPrice(order.ticker);
    const remaining = order.quantity - order.filledQuantity;
    if (order.type === 'limit' && order.limitPrice !== null) {
      if (limitMarketable(order.side, order.limitPrice, ref)) {
        fill(order, limitFill(order.side, order.limitPrice, ref), remaining);
      }
    } else if (order.type === 'stop' && order.stopPrice !== null) {
      if (stopTriggered(order.side, order.stopPrice, ref)) {
        fill(order, stopFill(order.side, order.stopPrice, ref), remaining);
      }
    } else if (order.type === 'oco') {
      evalOco(order, ref);
    }
  };

  /**
   * Reevalúa las patas de un OCO al precio de referencia. Primero el stop
   * (semántica conservadora de la app: si tocan las dos, gana el stop);
   * la pata perdedora queda 'cancelada' y la padre 'ejecutada'.
   */
  const evalOco = (order: RemoteOrder, ref: number): void => {
    const legs = order.legs ?? [];
    const target = legs.find((l) => l.type === 'limit');
    const stop = legs.find((l) => l.type === 'stop');
    if (!target || !stop) return;
    const stopHit = stop.stopPrice !== null && stopTriggered(order.side, stop.stopPrice, ref);
    const targetHit =
      !stopHit && target.limitPrice !== null && limitMarketable(order.side, target.limitPrice, ref);
    if (!stopHit && !targetHit) return;
    const winner = stopHit ? stop : target;
    const loser = stopHit ? target : stop;
    const price = stopHit
      ? stopFill(order.side, winner.stopPrice!, ref)
      : limitFill(order.side, winner.limitPrice!, ref);
    fill(winner, price);
    winner.status = 'ejecutada';
    loser.status = 'cancelada';
    loser.filledQuantity = 0;
    order.filledQuantity = order.quantity;
    order.filledAvgPrice = winner.filledAvgPrice;
    order.filledAt = winner.filledAt;
    order.status = 'ejecutada';
  };

  const nextId = (): string => `sim-${++orderSeq}`;

  const findTopLevel = (clientOrderId: string): RemoteOrder | undefined =>
    orders.find((o) => o.clientOrderId === clientOrderId);

  // -----------------------------------------------------------------------
  // Adaptador
  // -----------------------------------------------------------------------

  const adapter: SimulatedBroker = {
    id: SIMULATED_BROKER_ID,
    paperOnly: true,

    getAccount: async () => {
      throwIfFailure(consumeFailure());
      return {
        accountId,
        status: 'ACTIVE',
        currency: 'USD',
        cash: round2(cash),
        equity: equity(),
        buyingPower: round2(cash),
        paper: true,
      };
    },

    listPositions: async () => {
      throwIfFailure(consumeFailure());
      return [...positions.entries()]
        .filter(([, pos]) => pos.signedQty !== 0)
        .map(([ticker, pos]) => toBrokerPosition(ticker, pos));
    },

    listOrders: async (request?: ListOrdersRequest) => {
      throwIfFailure(consumeFailure());
      const openOnly = request?.openOnly === true;
      const visible = openOnly
        ? orders.filter((o) => o.status === 'enviada' || o.status === 'parcial')
        : orders;
      return visible.map((o) => ({ ...o, legs: o.legs?.map((l) => ({ ...l })) ?? null }));
    },

    getOrderByClientId: async (clientOrderId) => {
      throwIfFailure(consumeFailure());
      const order = findTopLevel(clientOrderId);
      if (order === undefined) return null;
      return { ...order, legs: order.legs?.map((l) => ({ ...l })) ?? null };
    },

    submitOrder: async (request: BrokerOrderRequest) => {
      assertValidOrderRequest(request, SIMULATED_BROKER_ID);
      const failure = consumeFailure();
      if (findTopLevel(request.clientOrderId) !== undefined) {
        fail('reject', `client_order_id ya en uso: ${request.clientOrderId}`, request.clientOrderId);
      }
      // 'timeout' es ambiguo como en un broker real: la orden QUEDA
      // REGISTRADA (se evalúa y hasta puede ejecutarse) pero la respuesta
      // se pierde; getOrderByClientId la encuentra después.
      const loseResponse = failure === 'timeout';
      if (failure !== null && !loseResponse && failure !== 'partial') {
        throwIfFailure(failure, request.clientOrderId);
      }

      const ref = refPrice(request.ticker);
      const submittedAt = isoNow();
      const isOco = request.type === 'oco';
      const order: RemoteOrder = {
        brokerOrderId: nextId(),
        clientOrderId: request.clientOrderId,
        ticker: normalizeTicker(request.ticker),
        type: request.type,
        side: request.side,
        quantity: request.quantity,
        filledQuantity: 0,
        limitPrice: request.limitPrice ?? null,
        stopPrice: request.stopPrice ?? null,
        status: 'enviada',
        submittedAt,
        filledAt: null,
        filledAvgPrice: null,
        ocoGroupId: null,
        legs: null,
      };

      if (isOco) {
        const groupId = nextId();
        order.ocoGroupId = groupId;
        const legBase = {
          ticker: order.ticker,
          side: order.side,
          quantity: order.quantity,
          filledQuantity: 0,
          status: 'enviada' as const,
          submittedAt,
          filledAt: null,
          filledAvgPrice: null,
          ocoGroupId: groupId,
          legs: null,
        };
        order.legs = [
          {
            ...legBase,
            brokerOrderId: nextId(),
            clientOrderId: `${request.clientOrderId}-objetivo`,
            type: 'limit',
            limitPrice: request.limitPrice ?? null,
            stopPrice: null,
          },
          {
            ...legBase,
            brokerOrderId: nextId(),
            clientOrderId: `${request.clientOrderId}-stop`,
            type: 'stop',
            limitPrice: null,
            stopPrice: request.stopPrice ?? null,
          },
        ];
      }

      orders.push(order);

      // Evaluación inmediata según el tipo.
      if (failure === 'partial') {
        const partial = round4(request.quantity / 2);
        const price =
          request.type === 'market'
            ? ref * (1 + (slippageBps / 10_000) * (request.side === 'buy' ? 1 : -1))
            : (order.limitPrice ?? ref);
        fill(order, price, partial);
      } else if (request.type === 'market') {
        const price = ref * (1 + (slippageBps / 10_000) * (request.side === 'buy' ? 1 : -1));
        fill(order, price);
      } else {
        evalTriggered(order);
      }

      const snapshot = { ...order, legs: order.legs?.map((l) => ({ ...l })) ?? null };
      if (loseResponse) {
        fail('timeout', 'la respuesta se perdió por tiempo de espera', request.clientOrderId);
      }
      return snapshot;
    },

    cancelOrder: async (brokerOrderId) => {
      const failure = consumeFailure();
      const found = orders.find((o) => o.brokerOrderId === brokerOrderId);
      if (found === undefined) {
        throwIfFailure(failure);
        return fail('not-found', `orden desconocida: ${brokerOrderId}`);
      }
      const order = found;
      if (order.status !== 'enviada' && order.status !== 'parcial') {
        throwIfFailure(failure);
        return fail('reject', `la orden ${brokerOrderId} ya está ${order.status}`);
      }
      // 'timeout' también es ambiguo al cancelar: la cancelación se aplica
      // pero la respuesta se pierde.
      if (failure !== null && failure !== 'timeout' && failure !== 'partial') {
        throwIfFailure(failure);
      }
      order.status = 'cancelada';
      for (const leg of order.legs ?? []) leg.status = 'cancelada';
      const snapshot = { ...order, legs: order.legs?.map((l) => ({ ...l })) ?? null };
      if (failure === 'timeout') {
        fail('timeout', 'la respuesta se perdió por tiempo de espera', order.clientOrderId);
      }
      return snapshot;
    },

    // ---------------------------------------------------------------------
    // Controles de prueba
    // ---------------------------------------------------------------------

    setPrice: (ticker, price) => {
      prices.set(normalizeTicker(ticker), price);
    },

    tick: (ticker) => {
      const key = normalizeTicker(ticker);
      for (const order of orders) {
        if (order.ticker === key) evalTriggered(order);
      }
    },

    failNext: (kind) => {
      armedFailure = kind;
    },

    setFailing: (kind) => {
      persistentFailure = kind;
    },

    dropOrder: (clientOrderId) => {
      const before = orders.length;
      orders = orders.filter((o) => o.clientOrderId !== clientOrderId);
      return orders.length < before;
    },

    injectPhantomOrder: (patch) => {
      const ticker = normalizeTicker(patch?.ticker ?? 'AAPL');
      const order: RemoteOrder = {
        brokerOrderId: patch?.brokerOrderId ?? nextId(),
        clientOrderId: patch?.clientOrderId ?? `tradia-fantasma-${++phantomSeq}`,
        ticker,
        type: patch?.type ?? 'limit',
        side: patch?.side ?? 'buy',
        quantity: patch?.quantity ?? 1,
        filledQuantity: patch?.filledQuantity ?? 0,
        limitPrice: patch?.limitPrice ?? refPrice(ticker),
        stopPrice: patch?.stopPrice ?? null,
        status: patch?.status ?? 'enviada',
        submittedAt: patch?.submittedAt ?? isoNow(),
        filledAt: patch?.filledAt ?? null,
        filledAvgPrice: patch?.filledAvgPrice ?? null,
        ocoGroupId: patch?.ocoGroupId ?? null,
        legs: patch?.legs ?? null,
      };
      orders.push(order);
      return { ...order, legs: order.legs?.map((l) => ({ ...l })) ?? null };
    },

    tamperPosition: (ticker, patch) => {
      const key = normalizeTicker(ticker);
      const pos = positions.get(key) ?? {
        signedQty: patch.quantity ?? 1,
        avgPrice: patch.avgEntryPrice ?? refPrice(key),
      };
      positions.set(key, {
        signedQty: patch.quantity ?? pos.signedQty,
        avgPrice: patch.avgEntryPrice ?? pos.avgPrice,
      });
    },

    setPosition: (position) => {
      const signed = position.side === 'long' ? position.quantity : -position.quantity;
      const key = normalizeTicker(position.ticker);
      if (signed === 0) positions.delete(key);
      else positions.set(key, { signedQty: signed, avgPrice: position.avgEntryPrice });
    },

    fillOrder: (clientOrderId, fillOptions) => {
      const order = findTopLevel(clientOrderId);
      if (order === undefined) return null;
      if (order.status !== 'enviada' && order.status !== 'parcial') return null;
      if (order.type === 'oco') {
        const leg = fillOptions?.leg ?? 'stop';
        const legs = order.legs ?? [];
        const winner = legs.find((l) => (leg === 'stop' ? l.type === 'stop' : l.type === 'limit'));
        const loser = legs.find((l) => l !== winner);
        if (!winner || !loser) return null;
        const price = fillOptions?.price ?? refPrice(order.ticker);
        fill(winner, price);
        winner.status = 'ejecutada';
        loser.status = 'cancelada';
        order.filledQuantity = order.quantity;
        order.filledAvgPrice = winner.filledAvgPrice;
        order.filledAt = winner.filledAt;
        order.status = 'ejecutada';
      } else {
        const price = fillOptions?.price ?? refPrice(order.ticker);
        fill(order, price, order.quantity - order.filledQuantity);
      }
      return { ...order, legs: order.legs?.map((l) => ({ ...l })) ?? null };
    },

    reset: () => {
      prices = new Map(initialPrices);
      orders = [];
      positions = new Map();
      cash = initialCash;
      orderSeq = 0;
      phantomSeq = 0;
      armedFailure = null;
      persistentFailure = null;
    },
  };

  return adapter;
}
