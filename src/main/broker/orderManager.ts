/**
 * Gestor de órdenes del broker paper — Fase 5.
 *
 * `createOrderManager` es testeable sin Electron: el adaptador del
 * broker, el repositorio, el reloj, la espera, el diario y las puertas
 * de seguridad (parada de emergencia, conexión e interruptor de
 * ejecución) llegan inyectados.
 *
 * Reglas de negocio:
 * - Una señal con decisión 'aprobada' o 'reducida' (`signals:new`,
 *   payload `SignalNewEvent`) se convierte en una orden de mercado de
 *   entrada y, cuando queda 'ejecutada', en un OCO de stop + objetivo
 *   del lado contrario (pata 'salida').
 * - Idempotencia: el `client_order_id` es determinista
 *   (`tradia-<señal>-<pata>`, ver `orderClientId`) y UNIQUE en
 *   `broker_orders`; la misma señal nunca crea dos órdenes.
 * - Reintentos: solo ante errores reintentables (`retryable`, esto es
 *   red, 5xx, timeout y 429), con espera exponencial y un máximo de
 *   `maxAttempts` envíos (3 por defecto). Antes de cada reenvío se
 *   consulta al broker por `client_order_id`: si el envío anterior sí
 *   llegó (p. ej. un timeout con respuesta perdida) se adopta la orden
 *   remota en vez de duplicar.
 * - Los rechazos de negocio no se reintentan: la orden queda
 *   'rechazada' con su motivo y una entrada 'error' en el diario. El
 *   mismo destino tienen los envíos agotados tras el último reintento.
 * - Huérfanas, en ambos sentidos: una orden local 'pendiente' sin
 *   respuesta del broker tras `orphanAfterMs` (2 min por defecto), o
 *   abierta local que el broker ya no conoce, queda 'huerfana'; y toda
 *   orden abierta del broker con prefijo 'tradia-' sin registro local
 *   se importa como 'huerfana' para que sea visible y conciliable.
 * - Trazabilidad: se guardan la hora y el precio pedidos, la hora y el
 *   precio ejecutados y el slippage en puntos básicos con el signo del
 *   contrato (`slippageBpsOf`). En un OCO el precio de referencia es el
 *   nivel de la pata que ejecutó.
 * - Bloqueos: no se envía nada con la parada de emergencia activa, sin
 *   conexión o con el interruptor de ejecución apagado; el bloqueo deja
 *   una entrada 'error' en el diario.
 */
import {
  BROKER_ORDER_OPEN_STATUSES,
  slippageBpsOf,
  type BrokerOrder,
  type BrokerOrderLeg,
  type BrokerOrderSide,
  type CreateOrderRequest,
} from '../../shared/broker';
import type { JournalRecordInput } from '../../shared/journal';
import type { Signal, SignalNewEvent } from '../../shared/signals';
import type { BrokerOrderPatch, BrokerRepository } from './repository';
import {
  BrokerError,
  isBrokerError,
  type BrokerAdapter,
  type BrokerOrderRequest,
  type RemoteOrder,
} from './types';

// ---------------------------------------------------------------------------
// Constantes y contrato
// ---------------------------------------------------------------------------

/** Prefijo de toda orden creada por la app; la conciliación lo reconoce. */
export const ORDER_CLIENT_ID_PREFIX = 'tradia-';

/** Envíos máximos por orden (el primero más los reintentos). */
export const ORDER_MAX_ATTEMPTS = 3;
/** Base de la espera exponencial entre reintentos (ms). */
export const ORDER_RETRY_BASE_MS = 250;
/** Edad de una 'pendiente' sin respuesta para marcarla huérfana (ms). */
export const ORDER_ORPHAN_AFTER_MS = 2 * 60_000;

/**
 * client_order_id determinista de una pata del plan de una señal:
 * `tradia-<señal>-<pata>`. Forma parte del contrato de idempotencia.
 */
export function orderClientId(signalId: number, leg: BrokerOrderLeg): string {
  return `${ORDER_CLIENT_ID_PREFIX}${signalId}-${leg}`;
}

/** Resultado de procesar un `signals:new` en el gestor. */
export type OrderHandleOutcome =
  /** La entrada quedó ejecutada (el OCO de salida va en `exit`). */
  | 'ejecutada'
  /** Aceptada por el broker y abierta, sin ejecutar aún. */
  | 'enviada'
  /** Ejecutada en parte. */
  | 'parcial'
  /** Rechazada por el broker o agotados los reintentos. */
  | 'rechazada'
  /** La señal ya tenía su orden (evento duplicado). */
  | 'duplicada'
  /** Parada activa, sin conexión o ejecución desactivada. */
  | 'bloqueada'
  /** Vetada, sin tamaño o payload inválido: no procede orden. */
  | 'ignorada';

export interface OrderHandleResult {
  outcome: OrderHandleOutcome;
  /** Orden de entrada persistida; null si no llegó a crearse. */
  entry: BrokerOrder | null;
  /** OCO de salida creado o ya existente; null si no procede todavía. */
  exit: BrokerOrder | null;
}

/** Conteos de una pasada de `syncWithBroker`. */
export interface OrderSyncResult {
  /** Órdenes abiertas locales actualizadas con el estado del broker. */
  synced: number;
  /** Órdenes locales marcadas huérfanas (sin respuesta o borradas). */
  orphanedLocal: number;
  /** Órdenes 'tradia-*' del broker importadas como huérfanas. */
  orphanedRemote: number;
  /** OCO de salida creados en esta pasada para entradas ya ejecutadas. */
  exitsCreated: number;
  /** true si no se pudo leer el broker (no se marca nada sin datos). */
  unreachable: boolean;
}

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

export interface OrderManagerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface OrderManagerDeps {
  adapter: BrokerAdapter;
  repository: BrokerRepository;
  /**
   * Señal persistida por id (`signals`); hace falta para construir el
   * OCO cuando la entrada ejecuta fuera de `handleSignalEvent` (p. ej.
   * en una pasada de `syncWithBroker` tras un reinicio).
   */
  getSignal?(signalId: number): Signal | null;
  /** Parada de emergencia activa (bloquea envíos). */
  isKillSwitchActive?(): boolean;
  /** Conexión con el broker disponible (bloquea envíos). */
  isOnline?(): boolean;
  /** Interruptor «Ejecutar señales aprobadas en paper» (bloquea envíos). */
  isExecutionEnabled?(): boolean;
  /** Entrada del diario automático (`services.journal.record`). */
  recordJournal?(input: JournalRecordInput): void;
  /** Aviso por cada cambio persistido de una orden (`broker:order-updated`). */
  onOrderUpdated?(order: BrokerOrder): void;
  /** Espera entre reintentos (ms); por defecto un setTimeout real. */
  sleep?(ms: number): Promise<void>;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  logger?: Partial<OrderManagerLogger>;
  /** Envíos máximos por orden; por defecto `ORDER_MAX_ATTEMPTS` (3). */
  maxAttempts?: number;
  /** Base de la espera exponencial (ms); por defecto `ORDER_RETRY_BASE_MS`. */
  retryBaseMs?: number;
  /** Edad de una 'pendiente' sin respuesta para huérfana (ms). */
  orphanAfterMs?: number;
}

export interface OrderManager {
  /** Entrada del evento `signals:new` del motor (payload SignalNewEvent). */
  handleSignalEvent(payload: unknown): Promise<OrderHandleResult>;
  /**
   * Pasada de mantenimiento: sincroniza las órdenes abiertas con el
   * broker, marca las huérfanas en ambos sentidos y lanza el OCO de las
   * entradas ejecutadas que aún no tengan salida. La usa el servicio de
   * forma periódica y tras recuperar la conexión.
   */
  syncWithBroker(): Promise<OrderSyncResult>;
  /**
   * Crea una orden limitada suelta (sin señal): la pide el usuario desde
   * la página Órdenes. Comparte el conducto de reintentos e idempotencia
   * de las órdenes de señal; su `client_order_id` es
   * 'tradia-manual-<instante>-<n>' y su pata queda null. La bloquean la
   * parada de emergencia y la falta de conexión; el interruptor de
   * ejecución es solo de las señales y no aplica aquí.
   */
  createLimitOrder(request: CreateOrderRequest): Promise<BrokerOrder>;
  /**
   * Cancela una orden abierta local por su id (`broker_orders.id`). Con
   * respuesta perdida o 'not-found' sincroniza con el broker antes de
   * decidir el estado final.
   */
  cancelOrder(id: number): Promise<BrokerOrder>;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

const OPEN_STATUSES = new Set<string>(BROKER_ORDER_OPEN_STATUSES);

const isOpen = (order: BrokerOrder): boolean => OPEN_STATUSES.has(order.status);

const directionToEntrySide = (signal: Signal): BrokerOrderSide =>
  signal.direction === 'largo' ? 'buy' : 'sell';

const oppositeSide = (side: BrokerOrderSide): BrokerOrderSide =>
  side === 'buy' ? 'sell' : 'buy';

/** Pata 'entrada'/'salida' si el client_order_id sigue el patrón propio. */
const legOfClientId = (clientOrderId: string): BrokerOrderLeg | null => {
  if (clientOrderId.endsWith('-entrada')) return 'entrada';
  if (clientOrderId.endsWith('-salida')) return 'salida';
  return null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// Gestor
// ---------------------------------------------------------------------------

export function createOrderManager(deps: OrderManagerDeps): OrderManager {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, Math.floor(deps.maxAttempts ?? ORDER_MAX_ATTEMPTS));
  const retryBaseMs = Math.max(0, deps.retryBaseMs ?? ORDER_RETRY_BASE_MS);
  const orphanAfterMs = Math.max(0, deps.orphanAfterMs ?? ORDER_ORPHAN_AFTER_MS);

  const isoNow = (): string => new Date(now()).toISOString();
  let stopped = false;
  /** Contador de órdenes manuales del proceso: sufijo del client_order_id. */
  let manualSeq = 0;

  const recordJournal = (input: JournalRecordInput): void => {
    try {
      deps.recordJournal?.(input);
    } catch (error: unknown) {
      logger.warn?.(`[ordenes] no se pudo escribir en el diario: ${errorMessage(error)}`);
    }
  };

  const notify = (order: BrokerOrder): void => {
    try {
      deps.onOrderUpdated?.(order);
    } catch (error: unknown) {
      logger.warn?.(`[ordenes] el aviso de orden actualizada falló: ${errorMessage(error)}`);
    }
  };

  const update = (order: BrokerOrder, patch: BrokerOrderPatch): BrokerOrder => {
    const updated = deps.repository.updateOrder(order.id, patch, isoNow());
    notify(updated);
    return updated;
  };

  /**
   * Motivo por el que no se puede enviar ahora, o null si se puede. Las
   * tres puertas son externas (parada, conectividad e interruptor) y se
   * consultan en cada envío, no solo al entrar la señal.
   */
  const blockedReason = (): string | null => {
    if (deps.isKillSwitchActive?.() === true) return 'la parada de emergencia está activa';
    if (deps.isOnline?.() === false) return 'sin conexión';
    if (deps.isExecutionEnabled?.() === false) return 'la ejecución en paper está desactivada';
    return null;
  };

  /**
   * Precio de referencia para el slippage de una ejecución: en un OCO es
   * el nivel de la pata que ejecutó (limit del objetivo o stop de la
   * protección); en el resto, el que quedó guardado al pedirla.
   */
  const referencePrice = (order: BrokerOrder, remote: RemoteOrder): number | null => {
    if (remote.type === 'oco') {
      const winner = (remote.legs ?? []).find((leg) => leg.status === 'ejecutada');
      return winner ? (winner.limitPrice ?? winner.stopPrice) : null;
    }
    return order.execution.requestedPrice ?? remote.limitPrice ?? remote.stopPrice;
  };

  /** Copia el estado que reporta el broker sobre la fila local. */
  const adoptRemote = (
    order: BrokerOrder,
    remote: RemoteOrder,
    patch: BrokerOrderPatch = {},
  ): BrokerOrder => {
    const merged: BrokerOrderPatch = {
      brokerOrderId: remote.brokerOrderId,
      status: remote.status,
      filledQuantity: remote.filledQuantity,
      ocoGroupId: remote.ocoGroupId,
      ...patch,
    };
    if (remote.filledAt !== null || remote.filledAvgPrice !== null) {
      merged.executedAt = remote.filledAt;
      merged.executedPrice = remote.filledAvgPrice;
      const requested = referencePrice(order, remote);
      if (requested !== null && order.execution.requestedPrice === null) {
        merged.requestedPrice = requested;
      }
      merged.slippageBps = slippageBpsOf(
        remote.side,
        requested ?? order.execution.requestedPrice,
        remote.filledAvgPrice,
      );
    }
    if (remote.status === 'rechazada' && merged.rejectReason === undefined) {
      merged.rejectReason = 'rechazada por el broker';
    }
    const updated = update(order, merged);
    logger.info?.(
      `[ordenes] ${remote.clientOrderId}: estado ${remote.status}` +
        (remote.filledAvgPrice !== null ? ` @ ${remote.filledAvgPrice}` : ''),
    );
    return updated;
  };

  /** Marca la orden 'rechazada' con su motivo y deja la entrada en el diario. */
  const markRejected = (order: BrokerOrder, reason: string): BrokerOrder => {
    const updated = update(order, { status: 'rechazada', rejectReason: reason });
    logger.warn?.(`[ordenes] ${order.clientOrderId} rechazada: ${reason}`);
    recordJournal({
      type: 'error',
      ticker: order.ticker,
      reason: `Orden ${order.clientOrderId} rechazada: ${reason}`,
      dataUsed: {
        clientOrderId: order.clientOrderId,
        tipo: order.type,
        lado: order.side,
        cantidad: order.quantity,
        intentos: updated.attempts,
      },
      result: 'error',
      errors: [reason],
      signalId: order.signalId,
    });
    return updated;
  };

  /** Espera exponencial; un 429 puede pedir más (`retryAfterMs`). */
  const backoffMs = (attempts: number, error: BrokerError): number => {
    const exponential = retryBaseMs * 2 ** (attempts - 1);
    return Math.max(exponential, error.retryAfterMs ?? 0);
  };

  /**
   * Envía la orden con reintentos: cada error reintentable espera en
   * exponencial y consulta al broker por `client_order_id` antes de
   * reenviar (un timeout puede haber registrado la orden aunque la
   * respuesta se perdiera). Los no reintentables quedan 'rechazada' sin
   * reintento; agotados los envíos, igual.
   */
  const submitWithRetry = async (
    order: BrokerOrder,
    request: BrokerOrderRequest,
  ): Promise<BrokerOrder> => {
    let current = order;
    let attempts = current.attempts;
    for (;;) {
      attempts += 1;
      try {
        const remote = await deps.adapter.submitOrder(request);
        return adoptRemote(current, remote, { attempts });
      } catch (error: unknown) {
        current = update(current, { attempts });
        if (!isBrokerError(error) || !error.retryable) {
          return markRejected(current, errorMessage(error));
        }
        if (attempts >= maxAttempts) {
          return markRejected(
            current,
            `sin respuesta del broker tras ${attempts} intentos (${error.kind})`,
          );
        }
        await sleep(backoffMs(attempts, error));
        try {
          const remote = await deps.adapter.getOrderByClientId(request.clientOrderId);
          if (remote !== null) {
            // El envío anterior sí llegó: se adopta, no se duplica.
            return adoptRemote(current, remote);
          }
        } catch (lookupError: unknown) {
          logger.warn?.(
            `[ordenes] no se pudo consultar ${request.clientOrderId} antes de reintentar: ` +
              errorMessage(lookupError),
          );
        }
      }
    }
  };

  /**
   * Lanza (o recupera) el OCO de salida de una entrada ejecutada. La pata
   * lleva el lado contrario, el objetivo en `limitPrice` y el stop en
   * `stopPrice`; sin ambos niveles no se envía nada. Devuelve la orden de
   * salida o null si no procede.
   */
  const ensureExitOco = async (
    entry: BrokerOrder,
    signal: Signal | null,
  ): Promise<BrokerOrder | null> => {
    if (entry.leg !== 'entrada' || entry.status !== 'ejecutada') return null;
    const signalId = entry.signalId ?? signal?.id ?? null;
    if (signalId === null) {
      logger.warn?.(
        `[ordenes] ${entry.clientOrderId} ejecutada sin señal asociada; no hay OCO de salida`,
      );
      return null;
    }
    const clientOrderId = orderClientId(signalId, 'salida');
    const existing = deps.repository.getOrderByClientId(clientOrderId);
    if (existing !== null) return existing;

    const resolvedSignal =
      signal ?? (signalId !== null ? (deps.getSignal?.(signalId) ?? null) : null);
    if (resolvedSignal === null) {
      logger.warn?.(
        `[ordenes] no se puede crear el OCO de ${clientOrderId}: la señal ${signalId} no consta`,
      );
      return null;
    }
    if (resolvedSignal.stop === null || resolvedSignal.target === null) {
      logger.warn?.(
        `[ordenes] señal ${signalId} sin stop u objetivo; la posición queda sin protección OCO`,
      );
      recordJournal({
        type: 'error',
        ticker: entry.ticker,
        reason: `La señal ${signalId} ejecutó su entrada sin stop u objetivo; no hay OCO de salida`,
        dataUsed: { clientOrderId, signalId },
        result: 'error',
        errors: ['señal sin stop u objetivo'],
        signalId,
      });
      return null;
    }

    const blocked = blockedReason();
    if (blocked !== null) {
      logger.warn?.(`[ordenes] OCO ${clientOrderId} bloqueado: ${blocked}`);
      recordJournal({
        type: 'error',
        ticker: entry.ticker,
        reason: `OCO ${clientOrderId} no enviado: ${blocked}`,
        dataUsed: { clientOrderId, signalId },
        result: 'error',
        errors: [`envío bloqueado: ${blocked}`],
        signalId,
      });
      return null;
    }

    const side = oppositeSide(entry.side);
    const quantity = entry.filledQuantity > 0 ? entry.filledQuantity : entry.quantity;
    const request: BrokerOrderRequest = {
      clientOrderId,
      ticker: entry.ticker,
      type: 'oco',
      side,
      quantity,
      limitPrice: resolvedSignal.target,
      stopPrice: resolvedSignal.stop,
      // La protección debe sobrevivir al cierre de sesión: 'gtc'.
      timeInForce: 'gtc',
    };
    const { order } = deps.repository.insertOrder({
      clientOrderId,
      signalId,
      strategyId: entry.strategyId,
      leg: 'salida',
      ticker: entry.ticker,
      type: 'oco',
      side,
      quantity,
      limitPrice: resolvedSignal.target,
      stopPrice: resolvedSignal.stop,
      requestedPrice: null,
      requestedAt: isoNow(),
      status: 'pendiente',
    });
    return submitWithRetry(order, request);
  };

  const outcomeOf = (entry: BrokerOrder | null): OrderHandleOutcome =>
    entry === null
      ? 'ignorada'
      : entry.status === 'ejecutada'
        ? 'ejecutada'
        : entry.status === 'parcial'
          ? 'parcial'
          : entry.status === 'rechazada'
            ? 'rechazada'
            : 'enviada';

  const handleSignal = async (signal: Signal): Promise<OrderHandleResult> => {
    const { decision } = signal;
    if (decision.status === 'vetada' || !(decision.size > 0)) {
      return { outcome: 'ignorada', entry: null, exit: null };
    }

    const clientOrderId = orderClientId(signal.id, 'entrada');
    const existing = deps.repository.getOrderByClientId(clientOrderId);
    if (existing !== null) {
      // La misma señal nunca crea dos órdenes; la salida puede quedar
      // pendiente si la entrada ya ejecutó (p. ej. envío bloqueado).
      const exit = existing.status === 'ejecutada' ? await ensureExitOco(existing, signal) : null;
      return { outcome: 'duplicada', entry: existing, exit };
    }

    const blocked = blockedReason();
    if (blocked !== null) {
      logger.warn?.(`[ordenes] señal ${signal.id} no ejecutada: ${blocked}`);
      recordJournal({
        type: 'error',
        ticker: signal.ticker,
        reason: `Señal ${signal.id} aprobada pero no ejecutada: ${blocked}`,
        dataUsed: { clientOrderId, signalId: signal.id },
        result: 'error',
        errors: [`envío bloqueado: ${blocked}`],
        signalId: signal.id,
      });
      return { outcome: 'bloqueada', entry: null, exit: null };
    }

    const request: BrokerOrderRequest = {
      clientOrderId,
      ticker: signal.ticker,
      type: 'market',
      side: directionToEntrySide(signal),
      quantity: decision.size,
      timeInForce: 'day',
    };
    let order: BrokerOrder;
    try {
      order = deps.repository.insertOrder({
        clientOrderId,
        signalId: signal.id,
        strategyId: signal.strategies[0]?.strategyId ?? null,
        leg: 'entrada',
        ticker: signal.ticker,
        type: 'market',
        side: request.side,
        quantity: decision.size,
        requestedPrice: signal.entry,
        requestedAt: isoNow(),
        status: 'pendiente',
      }).order;
    } catch (error: unknown) {
      // p. ej. una señal no persistida (senal_id sin fila): el evento no
      // debe tumbar al emisor; queda registrado para la auditoría.
      const message = errorMessage(error);
      logger.error?.(`[ordenes] no se pudo registrar ${clientOrderId}: ${message}`);
      recordJournal({
        type: 'error',
        ticker: signal.ticker,
        reason: `No se pudo registrar la orden ${clientOrderId}`,
        dataUsed: { clientOrderId, signalId: signal.id },
        result: 'error',
        errors: [message],
        signalId: signal.id,
      });
      return { outcome: 'rechazada', entry: null, exit: null };
    }
    const entry = await submitWithRetry(order, request);
    const exit = await ensureExitOco(entry, signal);
    return { outcome: outcomeOf(entry), entry, exit };
  };

  const manager: OrderManager = {
    handleSignalEvent: async (payload) => {
      if (stopped) return { outcome: 'ignorada', entry: null, exit: null };
      const signal =
        typeof payload === 'object' && payload !== null
          ? (payload as Partial<SignalNewEvent>).signal
          : undefined;
      if (
        signal === undefined ||
        signal === null ||
        typeof signal.id !== 'number' ||
        typeof signal.ticker !== 'string' ||
        typeof signal.decision !== 'object' ||
        signal.decision === null
      ) {
        logger.warn?.('[ordenes] evento de señal sin forma válida; se ignora');
        return { outcome: 'ignorada', entry: null, exit: null };
      }
      return handleSignal(signal);
    },

    syncWithBroker: async () => {
      const result: OrderSyncResult = {
        synced: 0,
        orphanedLocal: 0,
        orphanedRemote: 0,
        exitsCreated: 0,
        unreachable: false,
      };
      if (stopped) return result;

      const localOrders = deps.repository.listOrders();
      const openLocal = localOrders.filter(isOpen);

      // Órdenes locales → broker: se consulta cada una (openOnly no
      // mostraría una recién ejecutada y la marcaría huérfana por error).
      const remoteByClientId = new Map<string, RemoteOrder>();
      for (const order of openLocal) {
        let remote: RemoteOrder | null;
        try {
          remote = await deps.adapter.getOrderByClientId(order.clientOrderId);
        } catch (error: unknown) {
          // Sin lectura del broker no se marca nada: el descuadre podría
          // ser del medio, no de la orden.
          logger.warn?.(
            `[ordenes] sincronización incompleta (${order.clientOrderId}): ${errorMessage(error)}`,
          );
          result.unreachable = true;
          continue;
        }
        if (remote === null) {
          const ageMs = now() - Date.parse(order.execution.requestedAt);
          const stalePending = order.status === 'pendiente' && ageMs > orphanAfterMs;
          const lostAck = order.status !== 'pendiente';
          if (stalePending || lostAck) {
            update(order, { status: 'huerfana' });
            result.orphanedLocal += 1;
            logger.warn?.(
              `[ordenes] ${order.clientOrderId} huérfana: ` +
                (stalePending
                  ? `pendiente sin respuesta del broker hace ${Math.round(ageMs / 1000)} s`
                  : `la app la tiene ${order.status} y el broker no la conoce`),
            );
          }
          continue;
        }
        remoteByClientId.set(remote.clientOrderId, remote);
        const unchanged =
          remote.status === order.status &&
          remote.filledQuantity === order.filledQuantity &&
          remote.brokerOrderId === order.brokerOrderId;
        const updated = unchanged ? order : adoptRemote(order, remote);
        if (!unchanged) result.synced += 1;
        if (updated.leg === 'entrada' && updated.status === 'ejecutada') {
          const exit = await ensureExitOco(updated, null);
          if (exit !== null && exit.status !== 'huerfana') result.exitsCreated += 1;
        }
      }

      // Entradas ya ejecutadas sin salida: por si el OCO quedó bloqueado.
      for (const order of localOrders) {
        if (order.leg !== 'entrada' || order.status !== 'ejecutada' || order.signalId === null) {
          continue;
        }
        if (deps.repository.getOrderByClientId(orderClientId(order.signalId, 'salida')) !== null) {
          continue;
        }
        const exit = await ensureExitOco(order, null);
        if (exit !== null) result.exitsCreated += 1;
      }

      // Broker → app: órdenes abiertas 'tradia-*' sin registro local.
      let remoteOpen: RemoteOrder[];
      try {
        remoteOpen = await deps.adapter.listOrders({ openOnly: true });
      } catch (error: unknown) {
        logger.warn?.(`[ordenes] no se pudieron listar las órdenes del broker: ${errorMessage(error)}`);
        result.unreachable = true;
        return result;
      }
      for (const remote of remoteOpen) {
        if (!remote.clientOrderId.startsWith(ORDER_CLIENT_ID_PREFIX)) continue;
        if (remoteByClientId.has(remote.clientOrderId)) continue;
        if (deps.repository.getOrderByClientId(remote.clientOrderId) !== null) continue;
        const { order } = deps.repository.insertOrder({
          clientOrderId: remote.clientOrderId,
          brokerOrderId: remote.brokerOrderId,
          signalId: null,
          strategyId: null,
          leg: legOfClientId(remote.clientOrderId),
          ticker: remote.ticker,
          type: remote.type,
          side: remote.side,
          quantity: remote.quantity,
          filledQuantity: remote.filledQuantity,
          limitPrice: remote.limitPrice,
          stopPrice: remote.stopPrice,
          requestedPrice: remote.limitPrice ?? remote.stopPrice,
          requestedAt: remote.submittedAt,
          status: 'huerfana',
          ocoGroupId: remote.ocoGroupId,
        });
        result.orphanedRemote += 1;
        notify(order);
        logger.warn?.(
          `[ordenes] ${remote.clientOrderId} huérfana: existe en el broker sin registro local`,
        );
      }
      return result;
    },

    createLimitOrder: async (request) => {
      const ticker = request.ticker.trim().toUpperCase();
      // Una orden manual es una acción explícita del usuario: la paran la
      // parada de emergencia y la falta de conexión, no el interruptor de
      // ejecución automática de señales.
      const blocked =
        deps.isKillSwitchActive?.() === true
          ? 'la parada de emergencia está activa'
          : deps.isOnline?.() === false
            ? 'sin conexión'
            : null;
      if (blocked !== null) {
        logger.warn?.(`[ordenes] orden limitada manual de ${ticker} bloqueada: ${blocked}`);
        recordJournal({
          type: 'error',
          ticker,
          reason: `Orden limitada manual de ${ticker} no enviada: ${blocked}`,
          dataUsed: {
            lado: request.side,
            cantidad: request.quantity,
            precioLimite: request.limitPrice,
          },
          result: 'error',
          errors: [`envío bloqueado: ${blocked}`],
        });
        throw new Error(`La orden limitada de ${ticker} no se envió: ${blocked}.`);
      }

      manualSeq += 1;
      const clientOrderId = `tradia-manual-${now()}-${manualSeq}`;
      const { order } = deps.repository.insertOrder({
        clientOrderId,
        signalId: null,
        strategyId: null,
        leg: null,
        ticker,
        type: 'limit',
        side: request.side,
        quantity: request.quantity,
        limitPrice: request.limitPrice,
        requestedPrice: request.limitPrice,
        requestedAt: isoNow(),
        status: 'pendiente',
      });
      notify(order);
      return submitWithRetry(order, {
        clientOrderId,
        ticker,
        type: 'limit',
        side: request.side,
        quantity: request.quantity,
        limitPrice: request.limitPrice,
        // Una limitada manual debe sobrevivir al cierre de sesión: 'gtc'.
        timeInForce: 'gtc',
      });
    },

    cancelOrder: async (id) => {
      const order = deps.repository.getOrder(id);
      if (order === null) {
        throw new BrokerError('not-found', `orden local desconocida: ${id}`, {
          adapter: deps.adapter.id,
        });
      }
      if (!isOpen(order)) {
        throw new BrokerError('reject', `la orden ${order.clientOrderId} ya está ${order.status}`, {
          adapter: deps.adapter.id,
          clientOrderId: order.clientOrderId,
        });
      }

      try {
        if (order.brokerOrderId !== null) {
          const remote = await deps.adapter.cancelOrder(order.brokerOrderId);
          return adoptRemote(order, remote);
        }
        // 'pendiente' sin id del broker: si el broker tampoco la conoce,
        // cancelarla es solo cerrarla en local; si sí la conoce (respuesta
        // perdida al enviar), se cancela por el id que reporta.
        const remote = await deps.adapter.getOrderByClientId(order.clientOrderId);
        if (remote === null) return update(order, { status: 'cancelada' });
        if (!OPEN_STATUSES.has(remote.status)) return adoptRemote(order, remote);
        return adoptRemote(order, await deps.adapter.cancelOrder(remote.brokerOrderId));
      } catch (error: unknown) {
        // La cancelación también es ambigua: tras un timeout o un
        // not-found se consulta el estado real antes de decidir.
        if (isBrokerError(error) && (error.kind === 'timeout' || error.kind === 'not-found')) {
          const remote = await findRemote(order);
          if (remote !== null) return adoptRemote(order, remote);
        }
        throw error;
      }
    },

    stop: () => {
      stopped = true;
    },
  };

  async function findRemote(order: BrokerOrder): Promise<RemoteOrder | null> {
    try {
      return await deps.adapter.getOrderByClientId(order.clientOrderId);
    } catch {
      return null;
    }
  }

  return manager;
}
