/**
 * Conciliación app ↔ broker — Fase 5. Funciones puras.
 *
 * Compara lo que la app cree tener en el broker (derivado de
 * `broker_orders`) con lo que el broker reporta (posiciones y órdenes
 * abiertas). Cada diferencia sale como una discrepancia tipada con un
 * texto legible en español: es lo que persiste el servicio en
 * `reconcile_discrepancies`, lo que enseña el banner de descuadre y lo
 * que viaja en los avisos.
 *
 * Reglas:
 * - La posición «del sistema» se deriva de las ejecuciones locales
 *   (órdenes 'ejecutada'/'parcial'): cantidad neta por activo y precio
 *   medio con la misma contabilidad de coste medio que lleva el broker
 *   (aumento → media ponderada; reducción → se conserva; cruce de signo
 *   → reinicia al precio de la ejecución).
 * - Cantidad de posición exacta (redondeo a 4 decimales, como el broker
 *   simulado) y precio medio con tolerancia de un céntimo
 *   (`RECONCILE_PRICE_TOLERANCE`).
 * - Órdenes abiertas: las 'enviada'/'parcial' locales y las 'pendiente'
 *   con más de `pendingGraceMs` (2 min por defecto, el mismo umbral que
 *   usa el gestor para marcar huérfanas) deben aparecer como abiertas
 *   en el broker; una 'pendiente' reciente puede estar en vuelo y no se
 *   cuenta. En el otro sentido, toda orden abierta del broker sin fila
 *   local, o con una fila local ya cerrada, es un descuadre.
 */
import {
  BROKER_ORDER_OPEN_STATUSES,
  type BrokerOrder,
  type BrokerOrderSide,
  type BrokerPosition,
  type BrokerPositionSide,
  type ReconcileDiscrepancyType,
} from '../../shared/broker';
import type { RemoteOrder } from './types';

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

/** Tolerancia del precio medio de una posición: un céntimo. */
export const RECONCILE_PRICE_TOLERANCE = 0.01;

/**
 * Edad mínima de una 'pendiente' para exigir que el broker la conozca:
 * por debajo puede estar en vuelo hacia el broker (envío en curso o
 * respuesta perdida que aún no se ha resuelto).
 */
export const RECONCILE_PENDING_GRACE_MS = 2 * 60_000;

/** Épsilon de las comparaciones de cantidad (las cantidades van a 4 decimales). */
const QTY_EPSILON = 1e-9;

/** Posición según la app, derivada de `broker_orders`. */
export interface ReconcilePosition {
  ticker: string;
  side: BrokerPositionSide;
  /** Unidades en cartera (≥ 0; el signo lo da `side`). */
  quantity: number;
  /** Precio medio de entrada con contabilidad de coste medio. */
  avgEntryPrice: number;
}

/** Descuadre detectado, listo para persistir en `reconcile_discrepancies`. */
export interface FoundDiscrepancy {
  type: ReconcileDiscrepancyType;
  ticker: string | null;
  /** Texto legible en español; es lo que muestra el banner. */
  detail: string;
  /** Valor según la app, ya formateado; null si no aplica. */
  appValue: string | null;
  /** Valor según el broker, ya formateado; null si no aplica. */
  brokerValue: string | null;
}

export interface ReconcileCompareInput {
  /** Órdenes locales (`broker_orders`); de ellas salen posiciones y abiertas. */
  appOrders: readonly BrokerOrder[];
  /** Posiciones que reporta el broker. */
  brokerPositions: readonly BrokerPosition[];
  /** Órdenes abiertas que reporta el broker (`listOrders({openOnly})`). */
  brokerOpenOrders: readonly RemoteOrder[];
}

export interface ReconcileCompareOptions {
  /** Instante de la comparación (ms epoch), para la gracia de 'pendiente'. */
  nowMs: number;
  /** Tolerancia del precio medio; por defecto `RECONCILE_PRICE_TOLERANCE`. */
  priceTolerance?: number;
  /** Gracia de las 'pendiente' (ms); por defecto `RECONCILE_PENDING_GRACE_MS`. */
  pendingGraceMs?: number;
}

export interface ReconcileComparison {
  /** Posiciones derivadas de las órdenes locales. */
  appPositions: ReconcilePosition[];
  /** Órdenes locales que cuentan como abiertas para la comparación. */
  appOpenOrders: BrokerOrder[];
  /** Descuadres detectados, en orden determinista. */
  discrepancies: FoundDiscrepancy[];
}

// ---------------------------------------------------------------------------
// Formato legible (español, como el diario y los avisos)
// ---------------------------------------------------------------------------

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Cantidad legible: enteros sin decimales, decimales con coma y sin ceros sobrantes. */
const fmtQty = (value: number): string => {
  const rounded = round4(value);
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
};

/** Precio legible con dos decimales y coma. */
const fmtPrice = (value: number): string => value.toFixed(2).replace('.', ',');

const positionSideLabel = (side: BrokerPositionSide): string =>
  side === 'long' ? 'largo' : 'corto';

const orderSideLabel = (side: BrokerOrderSide): string => (side === 'buy' ? 'compra' : 'venta');

const ORDER_TYPE_LABELS: Record<BrokerOrder['type'], string> = {
  market: 'de mercado',
  limit: 'limitada',
  stop: 'stop',
  oco: 'OCO',
};

const ORDER_STATUS_LABELS: Record<BrokerOrder['status'], string> = {
  pendiente: 'pendiente',
  enviada: 'enviada',
  parcial: 'parcial',
  ejecutada: 'ejecutada',
  cancelada: 'cancelada',
  rechazada: 'rechazada',
  huerfana: 'huérfana',
};

/** Descripción corta de una orden para el detalle y los valores. */
const orderDesc = (order: {
  type: BrokerOrder['type'];
  side: BrokerOrderSide;
  quantity: number;
  ticker: string;
}): string =>
  `${ORDER_TYPE_LABELS[order.type]} · ${orderSideLabel(order.side)} · ` +
  `${fmtQty(order.quantity)} uds de ${order.ticker}`;

// ---------------------------------------------------------------------------
// Posiciones según la app
// ---------------------------------------------------------------------------

/**
 * Deriva las posiciones que la app cree tener en el broker a partir de
 * las ejecuciones registradas en `broker_orders` ('ejecutada' y
 * 'parcial', por su `filledQuantity`/`executedPrice`; las 'huerfana' no
 * cuentan: son órdenes marcadas como divergentes). La contabilidad de
 * coste medio es la misma que la del broker: aumento de posición →
 * precio medio ponderado; reducción → se conserva el medio; cruce de
 * signo → el medio pasa a ser el precio de la ejecución que cruza.
 */
export function positionsFromOrders(orders: readonly BrokerOrder[]): ReconcilePosition[] {
  const fills = orders
    .filter(
      (order) =>
        (order.status === 'ejecutada' || order.status === 'parcial') &&
        order.filledQuantity > 0 &&
        order.execution.executedPrice !== null &&
        order.execution.executedPrice > 0,
    )
    .sort((a, b) => {
      const at = a.execution.executedAt ?? a.execution.requestedAt;
      const bt = b.execution.executedAt ?? b.execution.requestedAt;
      if (at !== bt) return at < bt ? -1 : 1;
      return a.id - b.id;
    });

  const positions = new Map<string, { signedQty: number; avgPrice: number }>();
  for (const order of fills) {
    const key = order.ticker.trim().toUpperCase();
    const qty = order.filledQuantity;
    const price = order.execution.executedPrice!;
    const signed = order.side === 'buy' ? qty : -qty;
    const acc = positions.get(key) ?? { signedQty: 0, avgPrice: 0 };
    const prev = acc.signedQty;
    if (prev === 0 || Math.sign(prev) === Math.sign(signed)) {
      // Apertura o aumento: media ponderada del coste.
      const total = Math.abs(prev) + qty;
      acc.avgPrice = (acc.avgPrice * Math.abs(prev) + price * qty) / total;
      acc.signedQty = prev + signed;
      positions.set(key, acc);
    } else {
      const next = prev + signed;
      if (next === 0) {
        positions.delete(key);
      } else {
        // Cruce de signo: la nueva posición abre al precio de esta ejecución.
        if (Math.sign(next) !== Math.sign(prev)) acc.avgPrice = price;
        acc.signedQty = next;
        positions.set(key, acc);
      }
    }
  }

  return [...positions.entries()]
    .map(([ticker, acc]) => ({
      ticker,
      side: (acc.signedQty > 0 ? 'long' : 'short') as BrokerPositionSide,
      quantity: round4(Math.abs(acc.signedQty)),
      avgEntryPrice: round4(acc.avgPrice),
    }))
    .sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
}

/**
 * Órdenes locales que cuentan como abiertas a efectos de conciliación:
 * 'enviada'/'parcial' siempre, 'pendiente' solo si superan la gracia
 * (una 'pendiente' reciente puede seguir en vuelo hacia el broker).
 */
function appOpenOrdersFor(
  orders: readonly BrokerOrder[],
  nowMs: number,
  pendingGraceMs: number,
): BrokerOrder[] {
  return orders
    .filter((order) => {
      if (!OPEN_STATUSES.has(order.status)) return false;
      if (order.status !== 'pendiente') return true;
      const requestedMs = Date.parse(order.execution.requestedAt);
      if (Number.isNaN(requestedMs)) return true;
      return nowMs - requestedMs >= pendingGraceMs;
    })
    .sort((a, b) => (a.clientOrderId < b.clientOrderId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Comparación
// ---------------------------------------------------------------------------

const OPEN_STATUSES = new Set<string>(BROKER_ORDER_OPEN_STATUSES);

const comparePositions = (
  appPositions: readonly ReconcilePosition[],
  brokerPositions: readonly BrokerPosition[],
  priceTolerance: number,
): FoundDiscrepancy[] => {
  const discrepancies: FoundDiscrepancy[] = [];
  const appByTicker = new Map(appPositions.map((p) => [p.ticker.toUpperCase(), p] as const));
  const brokerByTicker = new Map(brokerPositions.map((p) => [p.ticker.toUpperCase(), p] as const));
  const tickers = [...new Set([...appByTicker.keys(), ...brokerByTicker.keys()])].sort();

  for (const key of tickers) {
    const app = appByTicker.get(key);
    const broker = brokerByTicker.get(key);
    const ticker = (app ?? broker)!.ticker;
    if (app !== undefined && broker === undefined) {
      discrepancies.push({
        type: 'posicion-faltante-broker',
        ticker,
        detail:
          `La app registra ${fmtQty(app.quantity)} acciones de ${ticker} ` +
          `en ${positionSideLabel(app.side)} y el broker no tiene ` +
          'ninguna posición abierta en ese activo.',
        appValue: `${fmtQty(app.quantity)} uds · ${positionSideLabel(app.side)}`,
        brokerValue: 'sin posición',
      });
    } else if (app === undefined && broker !== undefined) {
      discrepancies.push({
        type: 'posicion-faltante-app',
        ticker,
        detail:
          `El broker mantiene ${fmtQty(broker.quantity)} acciones de ${ticker} ` +
          `en ${positionSideLabel(broker.side)} y la app no registra ` +
          'ninguna posición.',
        appValue: 'sin posición',
        brokerValue: `${fmtQty(broker.quantity)} uds · ${positionSideLabel(broker.side)}`,
      });
    } else if (app !== undefined && broker !== undefined) {
      if (app.side !== broker.side) {
        discrepancies.push({
          type: 'posicion-cantidad',
          ticker,
          detail:
            `${ticker}: la app registra ${fmtQty(app.quantity)} acciones en ` +
            `${positionSideLabel(app.side)} y el broker, ${fmtQty(broker.quantity)} ` +
            `en ${positionSideLabel(broker.side)}.`,
          appValue: `${fmtQty(app.quantity)} uds · ${positionSideLabel(app.side)}`,
          brokerValue: `${fmtQty(broker.quantity)} uds · ${positionSideLabel(broker.side)}`,
        });
      } else if (Math.abs(app.quantity - broker.quantity) > QTY_EPSILON) {
        discrepancies.push({
          type: 'posicion-cantidad',
          ticker,
          detail:
            `${ticker}: la app registra ${fmtQty(app.quantity)} acciones ` +
            `y el broker, ${fmtQty(broker.quantity)}.`,
          appValue: `${fmtQty(app.quantity)} uds`,
          brokerValue: `${fmtQty(broker.quantity)} uds`,
        });
      } else if (round4(Math.abs(app.avgEntryPrice - broker.avgEntryPrice)) > priceTolerance) {
        discrepancies.push({
          type: 'posicion-precio',
          ticker,
          detail:
            `${ticker}: el precio medio de la posición es ` +
            `${fmtPrice(app.avgEntryPrice)} en la app y ` +
            `${fmtPrice(broker.avgEntryPrice)} en el broker.`,
          appValue: fmtPrice(app.avgEntryPrice),
          brokerValue: fmtPrice(broker.avgEntryPrice),
        });
      }
    }
  }
  return discrepancies;
};

const compareOpenOrders = (
  appOrders: readonly BrokerOrder[],
  appOpenOrders: readonly BrokerOrder[],
  brokerOpenOrders: readonly RemoteOrder[],
): FoundDiscrepancy[] => {
  const discrepancies: FoundDiscrepancy[] = [];
  const localByClientId = new Map(appOrders.map((o) => [o.clientOrderId, o] as const));
  const remoteOpenIds = new Set(brokerOpenOrders.map((o) => o.clientOrderId));

  // Abiertas en la app que el broker no lista como abiertas.
  for (const order of appOpenOrders) {
    if (remoteOpenIds.has(order.clientOrderId)) continue;
    discrepancies.push({
      type: 'orden-faltante-broker',
      ticker: order.ticker,
      detail:
        `La orden ${order.clientOrderId} (${orderDesc(order)}) está abierta ` +
        'en la app pero el broker no la lista entre las abiertas.',
      appValue: `${orderDesc(order)} · ${ORDER_STATUS_LABELS[order.status]}`,
      brokerValue: 'ausente',
    });
  }

  // Abiertas en el broker: sin fila local, con fila cerrada o con otra cantidad.
  const remoteSorted = [...brokerOpenOrders].sort((a, b) =>
    a.clientOrderId < b.clientOrderId ? -1 : 1,
  );
  for (const remote of remoteSorted) {
    const local = localByClientId.get(remote.clientOrderId);
    if (local === undefined) {
      discrepancies.push({
        type: 'orden-faltante-app',
        ticker: remote.ticker,
        detail:
          `El broker mantiene abierta la orden ${remote.clientOrderId} ` +
          `(${orderDesc(remote)}) sin registro en la app.`,
        appValue: 'sin registro',
        brokerValue: `${orderDesc(remote)} · ${ORDER_STATUS_LABELS[remote.status]}`,
      });
      continue;
    }
    if (!OPEN_STATUSES.has(local.status)) {
      discrepancies.push({
        type: 'orden-estado',
        ticker: local.ticker,
        detail:
          `La orden ${local.clientOrderId} está ${ORDER_STATUS_LABELS[local.status]} ` +
          `en la app pero sigue abierta en el broker (${ORDER_STATUS_LABELS[remote.status]}).`,
        appValue: ORDER_STATUS_LABELS[local.status],
        brokerValue: ORDER_STATUS_LABELS[remote.status],
      });
      continue;
    }
    // Misma orden abierta en ambos lados: el estado puede ir desfasado por
    // la latencia de sincronización; la cantidad pedida no debería variar.
    if (Math.abs(local.quantity - remote.quantity) > QTY_EPSILON) {
      discrepancies.push({
        type: 'orden-estado',
        ticker: local.ticker,
        detail:
          `La orden ${local.clientOrderId} difiere en la cantidad: ` +
          `${fmtQty(local.quantity)} uds en la app y ${fmtQty(remote.quantity)} ` +
          'uds en el broker.',
        appValue: `${fmtQty(local.quantity)} uds`,
        brokerValue: `${fmtQty(remote.quantity)} uds`,
      });
    }
  }
  return discrepancies;
};

/**
 * Compara la vista de la app (`broker_orders`) con la del broker y
 * devuelve los descuadres con su texto legible. Las posiciones de la
 * app se derivan aquí mismo (`positionsFromOrders`), así ambos lados
 * cuentan lo mismo.
 */
export function reconcileBrokerState(
  input: ReconcileCompareInput,
  options: ReconcileCompareOptions,
): ReconcileComparison {
  const priceTolerance = options.priceTolerance ?? RECONCILE_PRICE_TOLERANCE;
  const pendingGraceMs = options.pendingGraceMs ?? RECONCILE_PENDING_GRACE_MS;
  const appPositions = positionsFromOrders(input.appOrders);
  const appOpenOrders = appOpenOrdersFor(input.appOrders, options.nowMs, pendingGraceMs);
  const discrepancies = [
    ...comparePositions(appPositions, input.brokerPositions, priceTolerance),
    ...compareOpenOrders(input.appOrders, appOpenOrders, input.brokerOpenOrders),
  ];
  return { appPositions, appOpenOrders, discrepancies };
}
