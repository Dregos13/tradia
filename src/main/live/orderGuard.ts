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
 * - Ninguna orden puede dar la vuelta a una posición abierta: vender más
 *   que el largo en cartera abriría un corto, y comprar más que el corto
 *   abierto abriría un largo. Antes hay que cerrarla entera.
 * - La recompra de un corto abierto (una compra de hasta la cantidad en
 *   corto) cierra riesgo: pasa siempre, como la pata 'salida', incluso
 *   con el modo suspendido o los límites sin confirmar.
 * - Para lo que abre o amplía riesgo se exige el modo 'activo', límites
 *   confirmados y, en este orden, nocional por orden, posiciones abiertas,
 *   capital en uso y pérdida diaria realizada.
 * - Una orden de mercado sin precio de referencia no puede estimar su
 *   nocional: se bloquea (mejor no enviar que enviar a ciegas con dinero
 *   real).
 * - Una compra de mercado no puede garantizar el techo por orden: el
 *   precio ejecutado puede superar la referencia de la señal (hueco de
 *   apertura). Sale a la red convertida en limitada con tope
 *   (`liveOrderWirePrice`): min(techo por orden, capital libre) /
 *   cantidad, acotado además por la referencia con un margen de hueco.
 * - Una entrada en corto (venta sobre un ticker sin largo en cartera)
 *   pasa su puerta propia, además de las puertas comunes: los límites del
 *   corto escritos y confirmados (>0; a 0 el corto está desactivado), la
 *   cuenta del broker con margen (`shortingEnabled`), el título prestable
 *   (`shortable` y `easyToBorrow`, leídos del broker en el momento), el
 *   nocional con margen de hueco acotado por `shortOrderUsd` y por el
 *   límite general por orden, la exposición corta a precio actual más el
 *   pedido acotada por `shortExposureUsd`, los cortos y el total de
 *   posiciones dentro de su techo, y la pérdida diaria. La entrada en
 *   corto sale siempre como limitada —una venta a mercado no puede
 *   acotar el nominal en un hueco al alza— y lleva un stop de compra de
 *   protección a no más de `LIVE_FIXED_SHORT_CAPS.shortMaxStopPct` % por
 *   encima de la entrada: la pérdida en corto no tiene tope natural.
 *   Cualquier lectura del broker que falte (cuenta, prestabilidad,
 *   exposición) cierra el paso: con dinero real no se opera en corto a
 *   ciegas.
 * - La parada de emergencia recompra los cortos abiertos (la emisión va
 *   por `live/broker.ts`, fuera de esta guarda, para que ni los techos ni
 *   la puerta externa puedan atrapar un cierre de riesgo).
 */
import type { BrokerOrderLeg } from '../../shared/broker';
import type { LiveLimits, LiveModeState } from '../../shared/live';
import { LIVE_FIXED_SHORT_CAPS, LIVE_SHORT_ERROR_CODE } from '../../shared/live';
import { FX_BROKER_REJECTION_REASON, isFxSymbol } from '../../shared/fxTrading';
import type { BrokerOrderRequest } from '../broker/types';

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

/** Posición abierta según la app, con lado y cantidad neta. */
export interface LiveOpenPosition {
  ticker: string;
  /** 'long' = acciones en cartera; 'short' = vendidas en corto. */
  side: 'long' | 'short';
  /** Unidades netas de la posición (siempre > 0). */
  quantity: number;
}

/** Aptitud del título para el corto, leída del broker. */
export interface LiveAssetSnapshot {
  /** El broker admite posiciones cortas sobre el título. */
  shortable: boolean;
  /** Hay inventario fácil de tomar prestado ahora mismo. */
  easyToBorrow: boolean;
}

/** Lectura del estado real en el instante del envío (la arma el servicio). */
export interface LiveOrderSnapshot {
  /** Estado del modo real (`live_mode.estado`). */
  mode: LiveModeState;
  /** Límites escritos confirmados por escrito; null si no los hay. */
  limits: LiveLimits | null;
  /** Posiciones abiertas en la cuenta real con su lado y cantidad neta. */
  openPositions: readonly LiveOpenPosition[];
  /**
   * Exposición corta abierta valorada al precio actual según el broker
   * (suma de |valor de mercado| de las posiciones cortas); null cuando
   * no se pudo leer —una entrada en corto se rechaza sin ese dato.
   */
  shortExposureUsd: number | null;
  /**
   * Nocional de las ventas de entrada aún abiertas sobre tickers sin
   * largo en cartera (cortos pendientes de ejecutar): cuentan para la
   * exposición corta futura, igual que las compras abiertas cuentan para
   * el capital en uso.
   */
  pendingShortUsd: number;
  /**
   * La cuenta del broker permite operar en corto (`shorting_enabled` en
   * Alpaca); null cuando no se pudo leer —la entrada en corto se rechaza.
   */
  accountShorting: boolean | null;
  /**
   * Aptitud del título de esta orden para el corto; null cuando no se
   * pudo comprobar. Solo se lee del broker al evaluar una entrada en
   * corto.
   */
  asset: LiveAssetSnapshot | null;
  /**
   * Capital comprometido en USD: coste de las posiciones abiertas más el
   * nocional estimado de las órdenes de compra aún abiertas.
   */
  capitalInUseUsd: number;
  /** Pérdida realizada hoy en USD (≥ 0; sesión de Nueva York). */
  realizedLossTodayUsd: number;
  /**
   * Motivo del bloqueo por los requisitos propios del corto
   * (`LIVE_SHORT_REQUIREMENTS`: la declaración legal y fiscal del corto
   * y las semanas de cortos en paper cuadrados); null cuando están
   * cumplidos. Con motivo, toda entrada en corto se rechaza con
   * «[corto-requisitos] motivo», aunque los límites estén confirmados —
   * las salidas y la recompra siguen pasando siempre.
   */
  shortRequirementsBlockReason: string | null;
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
  /**
   * Stop de compra de protección de la entrada en corto (el `stop` de la
   * señal, que luego viaja en la pata 'stop' de su OCO): obligatorio en
   * toda entrada en corto y a no más del techo `shortMaxStopPct` por
   * encima de la entrada.
   */
  entryStopPrice?: number | null;
}

/** Margen de comparación para cantidades fraccionarias. */
const QUANTITY_EPSILON = 1e-9;

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
 *
 * Una entrada en corto (venta a mercado sin largo en ese ticker) sale a
 * su vez acotada: el gestor la convierte en una venta STOP con precio de
 * activación en la referencia, redondeado a la baja en centavos. Así la
 * venta solo se dispara con el mercado a la referencia o por debajo —un
 * hueco al alza jamás la ejecuta por encima de lo estimado— y el nominal
 * real queda acotado por el nominal planeado. Una venta sobre un largo
 * en cartera es un cierre y sigue saliendo a mercado.
 */
export function liveOrderWirePrice(
  snapshot: LiveOrderSnapshot,
  request: Pick<BrokerOrderRequest, 'type' | 'side' | 'quantity' | 'ticker'>,
  context: LiveOrderContext,
): number | null {
  if (context.leg === 'salida') return null;
  if (request.type !== 'market') return null;
  const limits = snapshot.limits;
  if (snapshot.mode !== 'activo' || limits === null) return null;
  const reference = context.requestedPrice;
  if (reference === null || !(reference > 0) || !Number.isFinite(reference)) return null;
  if (request.side === 'sell') {
    const position = snapshot.openPositions.find(
      (p) => p.ticker === request.ticker.trim().toUpperCase(),
    );
    // Una venta sobre un largo en cartera (cierre o reducción) sale tal
    // cual; la entrada en corto sale como stop a la referencia.
    if (position?.side === 'long') return null;
    const price = Math.floor(reference * 100) / 100;
    return price > 0 ? price : null;
  }
  const freeUsd = Math.max(0, limits.capitalUsd - snapshot.capitalInUseUsd);
  const capUsd = Math.min(limits.orderUsd, freeUsd);
  const marginBound = reference * (1 + LIVE_ORDER_PRICE_MARGIN);
  const bound = Math.min(capUsd / request.quantity, marginBound);
  if (!Number.isFinite(bound) || bound <= 0) return null;
  const price = Math.floor(bound * 100) / 100;
  return price > 0 ? price : null;
}

/**
 * Motivo del bloqueo de una entrada en corto (venta sobre un ticker sin
 * largo en cartera, o ampliación de un corto abierto), o null si pasa.
 * La llama `liveOrderBlockReason` tras las puertas comunes de modo,
 * límites confirmados y nocional acotable.
 */
function shortEntryBlockReason(
  snapshot: LiveOrderSnapshot,
  request: Pick<BrokerOrderRequest, 'ticker' | 'type' | 'quantity' | 'limitPrice' | 'stopPrice'>,
  context: LiveOrderContext,
  notional: number,
  position: LiveOpenPosition | undefined,
): string | null {
  const limits = snapshot.limits!; // comprobado por quien llama
  const ticker = request.ticker.trim().toUpperCase();

  // Primero los requisitos propios del corto (revisión legal y fiscal
  // específica y las semanas de cortos en paper cuadrados): sin ellos
  // ninguna entrada en corto real pasa, aunque los límites del corto
  // estén confirmados. El código viaja en el mensaje porque un error
  // tipado pierde sus propiedades al cruzar el IPC.
  if (snapshot.shortRequirementsBlockReason !== null) {
    return `[${LIVE_SHORT_ERROR_CODE}] ${snapshot.shortRequirementsBlockReason}`;
  }

  // El corto solo abre con sus tres límites escritos y confirmados por
  // encima de 0: con los límites del corto a 0 —como quedan las cuentas
  // migradas— el corto está desactivado.
  if (
    !(limits.shortOrderUsd > 0) ||
    !(limits.shortExposureUsd > 0) ||
    !(limits.shortPositions > 0)
  ) {
    return (
      'el corto con dinero real no está habilitado en los límites escritos: ' +
      'los límites del corto son 0. Confírmalos por escrito en «Dinero real» para habilitarlo'
    );
  }

  // Una entrada en corto nunca sale a mercado: la venta tiene que llevar
  // un tope o una activación que acote el nominal. Una venta limitada al
  // precio de referencia impide ejecutar por debajo de él —nunca vende
  // más barato de lo planeado—; una venta stop con activación en la
  // referencia solo se dispara con el mercado a ese nivel o por debajo,
  // así que un hueco al alza no la ejecuta por encima de lo estimado.
  if (request.type !== 'limit' && request.type !== 'stop') {
    return 'una entrada en corto con dinero real sale con precio acotado (limitada o stop), nunca a mercado';
  }

  // Stop de compra de protección obligatorio: en corto la pérdida no
  // tiene tope natural, así que la posición nace con su seguro ya
  // comprometido (la pata 'stop' de su OCO de salida).
  const stop = context.entryStopPrice ?? null;
  if (stop === null || !Number.isFinite(stop) || stop <= 0) {
    return 'toda entrada en corto lleva un stop de compra de protección sobre la entrada';
  }
  const entryPrice =
    request.type === 'stop'
      ? (request.stopPrice ?? context.requestedPrice)
      : (request.limitPrice ?? context.requestedPrice);
  if (entryPrice === null || !(entryPrice > 0)) {
    return 'una entrada en corto necesita un precio de entrada para situar su stop de protección';
  }
  if (!(stop > entryPrice)) {
    return (
      `el stop de compra del corto debe quedar por encima de la entrada ` +
      `(stop ${fmtUsd(stop)}, entrada ${fmtUsd(entryPrice)})`
    );
  }
  const stopCapPct = LIVE_FIXED_SHORT_CAPS.shortMaxStopPct;
  const maxStop = entryPrice * (1 + stopCapPct / 100);
  if (stop > maxStop + entryPrice * 1e-9) {
    return (
      `el stop del corto queda a más del ${stopCapPct} % por encima de la entrada ` +
      `(stop ${fmtUsd(stop)}, máximo ${fmtUsd(maxStop)}): acércalo o reduce la entrada`
    );
  }

  // La cuenta y el título se leen del broker justo antes de decidir:
  // cualquier dato que falte cierra el paso, nunca se asume permiso.
  if (snapshot.accountShorting === null) {
    return 'no se pudo comprobar en el broker que la cuenta permite operar en corto';
  }
  if (snapshot.accountShorting === false) {
    return (
      'la cuenta del broker no permite operar en corto: Alpaca exige una ' +
      'cuenta con margen habilitado y al menos 2.000 USD'
    );
  }
  if (snapshot.asset === null) {
    return `no se pudo comprobar que el título ${ticker} se puede tomar prestado para venderlo en corto`;
  }
  if (!snapshot.asset.shortable || !snapshot.asset.easyToBorrow) {
    const detail = !snapshot.asset.shortable
      ? 'el broker no admite cortarlo'
      : 'no es fácil de tomar prestado ahora mismo';
    return `el título ${ticker} no se puede vender en corto: ${detail}`;
  }

  // Techos del corto: el nocional con margen de hueco acotado por su
  // límite y por el general por orden (un hueco al alza encarece la
  // recompra), y la exposición corta a precio actual —los cortos abiertos
  // según el broker más las ventas de entrada pendientes— acotada por el
  // suyo.
  const boundedNotional = notional * (1 + LIVE_ORDER_PRICE_MARGIN);
  if (boundedNotional > limits.shortOrderUsd) {
    return (
      `el importe estimado del corto de ${fmtUsd(notional)} con margen de hueco ` +
      `supera el límite por orden en corto de ${fmtUsd(limits.shortOrderUsd)}`
    );
  }
  if (boundedNotional > limits.orderUsd) {
    return (
      `el importe estimado de ${fmtUsd(notional)} con margen de hueco ` +
      `(${fmtUsd(boundedNotional)}) supera el límite por orden de ${fmtUsd(limits.orderUsd)}`
    );
  }
  if (snapshot.shortExposureUsd === null) {
    return 'no se pudo leer la exposición en corto del broker a precio actual';
  }
  const exposureAfter = snapshot.shortExposureUsd + snapshot.pendingShortUsd + notional;
  if (exposureAfter > limits.shortExposureUsd) {
    return (
      `la exposición en corto tras la orden (${fmtUsd(exposureAfter)}) ` +
      `superaría el límite escrito de ${fmtUsd(limits.shortExposureUsd)}`
    );
  }
  if (position?.side !== 'short') {
    const openShorts = snapshot.openPositions.filter((p) => p.side === 'short').length;
    if (openShorts >= limits.shortPositions) {
      return `ya hay ${openShorts} posición(es) en corto abierta(s) (máximo ${limits.shortPositions})`;
    }
    if (snapshot.openPositions.length >= limits.openPositions) {
      return (
        `ya hay ${snapshot.openPositions.length} posición(es) abierta(s) en real ` +
        `(máximo ${limits.openPositions})`
      );
    }
  }
  if (snapshot.realizedLossTodayUsd >= limits.dailyLossUsd) {
    return (
      `la pérdida realizada de hoy (${fmtUsd(snapshot.realizedLossTodayUsd)}) ya alcanza ` +
      `el límite diario de ${fmtUsd(limits.dailyLossUsd)}`
    );
  }
  return null;
}

/**
 * Motivo legible por el que la orden no debe salir a la red en la cuenta
 * real, o null si puede enviarse. Las patas 'salida' pasan siempre, y la
 * recompra de un corto abierto también (cierra riesgo).
 */
export function liveOrderBlockReason(
  snapshot: LiveOrderSnapshot,
  request: Pick<
    BrokerOrderRequest,
    'ticker' | 'type' | 'side' | 'quantity' | 'limitPrice' | 'stopPrice'
  >,
  context: LiveOrderContext,
): string | null {
  // Los pares de divisas no llegan al bróker: Alpaca no opera FX, así que
  // una orden sobre un par se bloquea siempre, sea la pata que sea.
  if (isFxSymbol(request.ticker)) {
    return FX_BROKER_REJECTION_REASON;
  }

  // Una salida (el OCO que protege una posición abierta) nunca se frena
  // por techos: dejar una posición real sin protección sería peor.
  if (context.leg === 'salida') return null;

  const position = snapshot.openPositions.find(
    (p) => p.ticker === request.ticker.trim().toUpperCase(),
  );

  // Ninguna orden puede dar la vuelta a una posición abierta: vender más
  // que el largo en cartera abriría un corto, y comprar más que el corto
  // abierto abriría un largo. Para invertir el lado hay que cerrarla
  // entera primero y entrar después con una orden propia.
  if (
    request.side === 'sell' &&
    position?.side === 'long' &&
    request.quantity > position.quantity + QUANTITY_EPSILON
  ) {
    return (
      `vender ${request.quantity} uds supera el largo abierto de ` +
      `${position.quantity} uds en ${position.ticker}: daría la vuelta a la ` +
      `posición (se abriría un corto); ciérrala entera primero`
    );
  }
  if (
    request.side === 'buy' &&
    position?.side === 'short' &&
    request.quantity > position.quantity + QUANTITY_EPSILON
  ) {
    return (
      `comprar ${request.quantity} uds supera el corto abierto de ` +
      `${position.quantity} uds en ${position.ticker}: daría la vuelta a la ` +
      `posición (se abriría un largo); ciérralo entero primero`
    );
  }

  // La recompra de un corto cierra riesgo: pasa siempre, como la pata
  // 'salida', aunque el modo esté suspendido o los límites sin confirmar.
  if (request.side === 'buy' && position?.side === 'short') return null;

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

  // Entrada en corto: venta sobre un ticker sin largo en cartera (o
  // ampliación de un corto abierto). Tiene su puerta propia.
  if (request.side === 'sell' && position?.side !== 'long') {
    return shortEntryBlockReason(snapshot, request, context, notional, position);
  }

  if (notional > limits.orderUsd) {
    return (
      `el importe estimado de ${fmtUsd(notional)} supera el límite por orden ` +
      `de ${fmtUsd(limits.orderUsd)}`
    );
  }

  const opensNewPosition = position === undefined;
  if (opensNewPosition && snapshot.openPositions.length >= limits.openPositions) {
    return (
      `ya hay ${snapshot.openPositions.length} posición(es) abierta(s) en real ` +
      `(máximo ${limits.openPositions})`
    );
  }

  // El límite de capital mide capital comprometido: solo lo consume una
  // compra. Vender lo que ya está en cartera lo libera, nunca lo gasta.
  if (request.side === 'buy' && snapshot.capitalInUseUsd + notional > limits.capitalUsd) {
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
