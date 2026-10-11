/**
 * Guarda de techos del dinero real (fase 7) — evaluación pura.
 *
 * Es la puerta por orden que el gestor de órdenes consulta ANTES de cada
 * envío (`checkOrderAllowed` en `orderManager.ts`), además del motor de
 * riesgo de la fase 3 y de las puertas externas (parada, conexión).
 * Compara la orden ya construida con los límites escritos confirmados —
 * siempre ≤ `LIVE_FIXED_CAPS`— y con la exposición actual de la cuenta
 * real (posiciones y órdenes abiertas en `broker_orders_live`, pérdida
 * realizada del día en sesión de Nueva York).
 *
 * Reglas:
 * - Las patas 'salida' (el OCO de protección de una entrada ejecutada)
 *   nunca se bloquean por techos: cierran riesgo, y una posición real no
 *   puede quedar atrapada por un límite.
 * - Para el resto (entradas de señal y órdenes sueltas) se exige el modo
 *   'activo', límites confirmados y, en este orden, nocional por orden,
 *   posiciones abiertas, capital en uso y pérdida diaria realizada.
 * - Una orden de mercado sin precio de referencia no puede estimar su
 *   nocional: se bloquea (mejor no enviar que enviar a ciegas con dinero
 *   real).
 * - Una compra de mercado no puede garantizar el techo por orden: el
 *   precio ejecutado puede superar la referencia de la señal (hueco de
 *   apertura). Sale a la red convertida en limitada con tope
 *   (`liveOrderWirePrice`): min(techo por orden, capital libre) /
 *   cantidad, acotado además por la referencia con un margen de hueco.
 *   Una venta de entrada no admite precio tope —su notional sube con el
 *   precio—: se bloquea con un margen sobre la referencia.
 */
import type { BrokerOrderLeg } from '../../shared/broker';
import type { LiveLimits, LiveModeState } from '../../shared/live';
import type { BrokerOrderRequest } from '../broker/types';

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

/** Lectura del estado real en el instante del envío (la arma el servicio). */
export interface LiveOrderSnapshot {
  /** Estado del modo real (`live_mode.estado`). */
  mode: LiveModeState;
  /** Límites escritos confirmados por escrito; null si no los hay. */
  limits: LiveLimits | null;
  /** Tickers con posición abierta en la cuenta real. */
  openTickers: readonly string[];
  /**
   * Capital comprometido en USD: coste de las posiciones abiertas más el
   * nocional estimado de las órdenes de compra aún abiertas.
   */
  capitalInUseUsd: number;
  /** Pérdida realizada hoy en USD (≥ 0; sesión de Nueva York). */
  realizedLossTodayUsd: number;
}

/** Contexto que acompaña a la orden: su pata y el precio de referencia. */
export interface LiveOrderContext {
  leg: BrokerOrderLeg | null;
  /**
   * Precio de referencia del pedido (la señal `entry`, el limit de una
   * orden suelta o el objetivo del OCO); null en una de mercado sin
   * referencia.
   */
  requestedPrice: number | null;
}

const fmtUsd = (value: number): string =>
  `${Number.isInteger(value) ? String(value) : value.toFixed(2)} USD`;

const MODE_LABELS: Record<LiveModeState, string> = {
  bloqueado: 'bloqueado por la lista de comprobación',
  listo: 'listo pero aún no activado',
  activo: 'activo',
  suspendido: 'suspendido',
};

/**
 * Margen de hueco sobre la referencia: el tope de una compra de mercado
 * convertida y el colchón que exige una venta de entrada. 5 %.
 */
export const LIVE_ORDER_PRICE_MARGIN = 0.05;

// ---------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------

/**
 * Nocional estimado de la orden en USD: cantidad × precio conocido (el
 * limit/stop del tipo, o la referencia del pedido en una de mercado).
 * Null si no hay precio con el que estimarla.
 */
export function estimateOrderNotionalUsd(
  request: Pick<BrokerOrderRequest, 'quantity' | 'limitPrice' | 'stopPrice'>,
  requestedPrice: number | null,
): number | null {
  const price = request.limitPrice ?? requestedPrice ?? request.stopPrice ?? null;
  if (price === null || !(price > 0) || !Number.isFinite(request.quantity)) return null;
  return request.quantity * price;
}

/**
 * Precio limit máximo con el que una compra de mercado real sale a la
 * red sin poder superar los techos: min(límite por orden, capital libre)
 * / cantidad, acotado además por la referencia con `LIVE_ORDER_PRICE_MARGIN`
 * de margen de hueco (así un dato desfasado no deja colar un fill absurdo).
 * Redondeado a la baja en centavos para que cantidad × precio jamás se
 * pase del techo. Null cuando la orden no es una compra de mercado o no
 * hay tope computable (la guarda la bloquea entonces).
 */
export function liveOrderWirePrice(
  snapshot: LiveOrderSnapshot,
  request: Pick<BrokerOrderRequest, 'type' | 'side' | 'quantity'>,
  context: LiveOrderContext,
): number | null {
  if (context.leg === 'salida') return null;
  if (request.type !== 'market' || request.side !== 'buy') return null;
  const limits = snapshot.limits;
  if (snapshot.mode !== 'activo' || limits === null) return null;
  const freeUsd = Math.max(0, limits.capitalUsd - snapshot.capitalInUseUsd);
  const capUsd = Math.min(limits.orderUsd, freeUsd);
  const marginBound =
    context.requestedPrice !== null && context.requestedPrice > 0
      ? context.requestedPrice * (1 + LIVE_ORDER_PRICE_MARGIN)
      : Number.POSITIVE_INFINITY;
  const bound = Math.min(capUsd / request.quantity, marginBound);
  if (!Number.isFinite(bound) || bound <= 0) return null;
  const price = Math.floor(bound * 100) / 100;
  return price > 0 ? price : null;
}

/**
 * Motivo legible por el que la orden no debe salir a la red en la cuenta
 * real, o null si puede enviarse. Las patas 'salida' pasan siempre.
 */
export function liveOrderBlockReason(
  snapshot: LiveOrderSnapshot,
  request: Pick<
    BrokerOrderRequest,
    'ticker' | 'type' | 'side' | 'quantity' | 'limitPrice' | 'stopPrice'
  >,
  context: LiveOrderContext,
): string | null {
  // Una salida (el OCO que protege una posición abierta) nunca se frena
  // por techos: dejar una posición real sin protección sería peor.
  if (context.leg === 'salida') return null;

  if (snapshot.mode !== 'activo') {
    return `el modo real está ${MODE_LABELS[snapshot.mode]}; no se envían órdenes nuevas`;
  }
  const limits = snapshot.limits;
  if (limits === null) {
    return 'los límites escritos del modo real no están confirmados';
  }

  const notional = estimateOrderNotionalUsd(request, context.requestedPrice);
  if (notional === null) {
    return 'no se pudo estimar el importe de la orden (falta precio de referencia)';
  }
  if (notional > limits.orderUsd) {
    return (
      `el importe estimado de ${fmtUsd(notional)} supera el límite por orden ` +
      `de ${fmtUsd(limits.orderUsd)}`
    );
  }

  // Una venta de entrada no admite precio tope —su notional crece con el
  // precio de ejecución—: se exige un margen de hueco sobre la referencia
  // por debajo del límite por orden.
  if (request.side === 'sell' && notional * (1 + LIVE_ORDER_PRICE_MARGIN) > limits.orderUsd) {
    return (
      `el importe estimado de ${fmtUsd(notional)} con margen de hueco ` +
      `(${fmtUsd(notional * (1 + LIVE_ORDER_PRICE_MARGIN))}) supera el límite ` +
      `por orden de ${fmtUsd(limits.orderUsd)}`
    );
  }

  const ticker = request.ticker.trim().toUpperCase();
  const opensNewPosition = !snapshot.openTickers.includes(ticker);
  if (opensNewPosition && snapshot.openTickers.length >= limits.openPositions) {
    return (
      `ya hay ${snapshot.openTickers.length} posición(es) abierta(s) en real ` +
      `(máximo ${limits.openPositions})`
    );
  }

  if (snapshot.capitalInUseUsd + notional > limits.capitalUsd) {
    return (
      `supera el límite de capital real: ${fmtUsd(snapshot.capitalInUseUsd)} en uso ` +
      `+ ${fmtUsd(notional)} de la orden > ${fmtUsd(limits.capitalUsd)}`
    );
  }

  if (snapshot.realizedLossTodayUsd >= limits.dailyLossUsd) {
    return (
      `la pérdida realizada de hoy (${fmtUsd(snapshot.realizedLossTodayUsd)}) ya alcanza ` +
      `el límite diario de ${fmtUsd(limits.dailyLossUsd)}`
    );
  }

  // Una compra de mercado sale limitada con tope (`liveOrderWirePrice`);
  // sin un tope computable la orden no sale a ciegas.
  if (
    request.type === 'market' &&
    request.side === 'buy' &&
    liveOrderWirePrice(snapshot, request, context) === null
  ) {
    return 'no se pudo acotar el precio máximo de la compra dentro de los techos';
  }

  return null;
}
