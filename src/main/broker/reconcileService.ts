/**
 * Servicio de conciliación periódica con el broker — Fase 5.
 *
 * Ejecuta `reconcileBrokerState` contra el adaptador vigente y deja el
 * rastro de cada pasada en `reconcile_runs`/`reconcile_discrepancies`:
 *
 * - Cada descuadre NUEVO se guarda como discrepancia 'abierta', deja
 *   una entrada 'error' en el Diario (una por ejecución, con todos los
 *   detalles nuevos) y sale como aviso por `sendEvent` — el canal
 *   'limite-alcanzado' del servicio de entrega cubre la notificación de
 *   escritorio y los canales externos que lo tengan activo—. Las pasadas
 *   siguientes que vuelven a detectar el mismo descuadre no repiten el
 *   aviso: la discrepancia ya está abierta.
 * - Tras cada ejecución que pudo comparar se emite
 *   `reconcile:discrepancy` (`emitDiscrepancy`) con los descuadres que
 *   siguen abiertos; una ejecución limpia llega con la lista vacía y el
 *   banner se cierra.
 * - La resolución es selectiva: una discrepancia abierta que la nueva
 *   ejecución ya no detecta queda 'resuelta', haya o no otros
 *   descuadres (una ejecución limpia las resuelve todas, como pide el
 *   contrato).
 *
 * Disparadores (`reconcile_runs.origen`):
 * - 'programada': cada `intervalMs` (15 min) con la app en marcha, con
 *   conexión y la cuenta conectada; sin alguna de las tres condiciones
 *   la pasada se salta sin dejar rastro.
 * - 'manual': «Conciliar ahora» desde Órdenes o el banner.
 * - 'rutina': el postmercado de la rutina diaria (gancho
 *   `routine.onPostMarket` que cablea el servicio del broker).
 *
 * En manual y rutina las puertas no saltan la pasada sino que la cierran
 * con resultado 'error' (el usuario ve «No se pudo conciliar» y el
 * motivo). Las ejecuciones se serializan: dos disparos simultáneos no
 * se pisan.
 *
 * Dependencias inyectables: el adaptador por `getAdapter` (null = cuenta
 * no conectada, así el servicio sobrevive a conectar/desconectar), el
 * repositorio, la conectividad, el diario, los canales de entrega, el
 * emisor del evento y el reloj/temporizadores. El registro IPC
 * (`reconcile:run`, `reconcile:status`) lo monta la tarea del servicio
 * del broker; todo lo que necesita está aquí.
 */
import {
  BROKER_ORDERS_MAX_LIMIT,
  type BrokerOrder,
  type ReconcileDiscrepancy,
  type ReconcileDiscrepancyEvent,
  type ReconcileRun,
  type ReconcileStatusResult,
  type ReconcileTrigger,
} from '../../shared/broker';
import type { DeliveryEventKind, JournalRecordInput } from '../../shared/journal';
import type { DeliveryMessage } from '../delivery';
import { reconcileBrokerState, type FoundDiscrepancy } from './reconcile';
import type { BrokerRepository } from './repository';
import type { BrokerAdapter } from './types';

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

/** Intervalo de la conciliación programada: 15 minutos. */
export const RECONCILE_INTERVAL_MS = 15 * 60_000;

export type ReconcileTimerHandle = ReturnType<typeof setTimeout>;

export interface ReconcileLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ReconcileServiceDeps {
  /** Adaptador de la cuenta paper conectada; null mientras no la haya. */
  getAdapter(): BrokerAdapter | null;
  /** Repositorio del dominio broker (migración 010). */
  repository: Pick<
    BrokerRepository,
    | 'listOrders'
    | 'startReconcileRun'
    | 'finishReconcileRun'
    | 'getLastReconcileRun'
    | 'listOpenDiscrepancies'
    | 'insertDiscrepancy'
    | 'resolveDiscrepancy'
  >;
  /** Conexión a internet disponible (services.connectivity). */
  isOnline?(): boolean;
  /** `journal.record` del servicio de diario; opcional en pruebas. */
  recordJournal?(input: JournalRecordInput): void;
  /**
   * `delivery.sendEvent`: reparte el aviso por la notificación de
   * escritorio y los canales externos suscritos al evento. Se llama con
   * 'limite-alcanzado', el kind de alerta del contrato de entrega.
   */
  sendEvent?(kind: DeliveryEventKind, message: DeliveryMessage): void;
  /** Emite `reconcile:discrepancy` hacia las ventanas. */
  emitDiscrepancy?(event: ReconcileDiscrepancyEvent): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  setTimer?(callback: () => void, delayMs: number): ReconcileTimerHandle;
  clearTimer?(handle: ReconcileTimerHandle): void;
  /** Intervalo de la pasada programada (ms); por defecto 15 min. */
  intervalMs?: number;
  /** Gracia de las 'pendiente' (ms); ver reconcile.ts. */
  pendingGraceMs?: number;
  /** Tolerancia del precio medio; ver reconcile.ts. */
  priceTolerance?: number;
  logger?: Partial<ReconcileLogger>;
}

export interface ReconcileService {
  /**
   * Ejecuta una conciliación y devuelve la ejecución persistida. Las
   * pasadas se serializan; en manual/rutina las puertas (cuenta no
   * conectada, sin conexión) producen una ejecución con resultado
   * 'error' en vez de saltarla.
   */
  runNow(trigger: ReconcileTrigger): Promise<ReconcileRun>;
  /** Lectura de `reconcile:status`: última ejecución y descuadres abiertos. */
  status(): ReconcileStatusResult;
  /** Arma la pasada programada cada `intervalMs`. */
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

const TRIGGER_LABELS: Record<ReconcileTrigger, string> = {
  programada: 'programada',
  manual: 'a demanda',
  rutina: 'postmercado',
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Clave de deduplicación de un descuadre: tipo + activo + detalle. */
const discrepancyKey = (d: { type: string; ticker: string | null; detail: string }): string =>
  `${d.type}|${d.ticker ?? ''}|${d.detail}`;

export function createReconcileService(deps: ReconcileServiceDeps): ReconcileService {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h: ReconcileTimerHandle) => clearTimeout(h));
  const logger = deps.logger ?? console;
  const intervalMs = Math.max(1_000, deps.intervalMs ?? RECONCILE_INTERVAL_MS);

  const isoNow = (): string => new Date(now()).toISOString();

  let started = false;
  let timer: ReconcileTimerHandle | null = null;
  // Cola serializadora: dos disparos (programada + manual, p. ej.) no se pisan.
  let tail: Promise<unknown> = Promise.resolve();

  /** Todas las órdenes locales (paginado por el tope del contrato). */
  const listAllOrders = (): BrokerOrder[] => {
    const orders: BrokerOrder[] = [];
    let offset = 0;
    for (;;) {
      const page = deps.repository.listOrders({
        limit: BROKER_ORDERS_MAX_LIMIT,
        offset,
      });
      orders.push(...page);
      if (page.length < BROKER_ORDERS_MAX_LIMIT) return orders;
      offset += BROKER_ORDERS_MAX_LIMIT;
    }
  };

  const recordJournal = (input: JournalRecordInput): void => {
    try {
      deps.recordJournal?.(input);
    } catch (error: unknown) {
      logger.warn?.(`[reconcile] no se pudo escribir en el diario: ${errorMessage(error)}`);
    }
  };

  /** Cierra la ejecución con 'error' y lo anota en el Diario. */
  const failRun = (run: ReconcileRun, message: string): ReconcileRun => {
    const finished = deps.repository.finishReconcileRun(run.id, {
      finishedAt: isoNow(),
      result: 'error',
      error: message,
    });
    logger.warn?.(`[reconcile] ejecución ${run.id} (${run.trigger}) falló: ${message}`);
    recordJournal({
      type: 'error',
      reason: `No se pudo conciliar con el broker (${TRIGGER_LABELS[run.trigger]}): ${message}`,
      dataUsed: { runId: run.id, origen: run.trigger },
      result: 'error',
      errors: [message],
    });
    return finished;
  };

  /** Motivo por el que no se puede comparar ahora, o null. */
  const blockedReason = (): string | null => {
    if (deps.getAdapter() === null) return 'la cuenta paper no está conectada';
    if (deps.isOnline?.() === false) return 'sin conexión';
    return null;
  };

  /**
   * Persiste lo encontrado: resuelve los avisos abiertos que ya no se
   * detectan, inserta los nuevos (deduplicado por tipo+activo+detalle)
   * y devuelve las filas nuevas para el aviso.
   */
  const persistFindings = (
    run: ReconcileRun,
    found: readonly FoundDiscrepancy[],
  ): ReconcileDiscrepancy[] => {
    const openRows = deps.repository.listOpenDiscrepancies();
    const foundKeys = new Set(found.map(discrepancyKey));
    const openKeys = new Set(openRows.map(discrepancyKey));
    for (const row of openRows) {
      if (foundKeys.has(discrepancyKey(row))) continue;
      deps.repository.resolveDiscrepancy(row.id, isoNow());
    }
    const inserted: ReconcileDiscrepancy[] = [];
    for (const item of found) {
      if (openKeys.has(discrepancyKey(item))) continue;
      inserted.push(
        deps.repository.insertDiscrepancy({
          runId: run.id,
          type: item.type,
          ticker: item.ticker,
          detail: item.detail,
          appValue: item.appValue,
          brokerValue: item.brokerValue,
        }),
      );
    }
    return inserted;
  };

  /** Aviso de los descuadres nuevos: Diario 'error' + canales de entrega. */
  const announce = (run: ReconcileRun, fresh: readonly ReconcileDiscrepancy[]): void => {
    const details = fresh.map((d) => d.detail);
    recordJournal({
      type: 'error',
      reason:
        `Conciliación ${TRIGGER_LABELS[run.trigger]} con el broker: ` +
        `${fresh.length} ${fresh.length === 1 ? 'descuadre detectado' : 'descuadres detectados'}`,
      dataUsed: {
        runId: run.id,
        origen: run.trigger,
        descuadres: fresh.map((d) => ({ tipo: d.type, ticker: d.ticker })),
      },
      result: 'error',
      errors: details,
    });
    const first = fresh[0]!;
    deps.sendEvent?.('limite-alcanzado', {
      title: 'Descuadre con el broker',
      body: first.detail + (fresh.length > 1 ? `\n+${fresh.length - 1} diferencias más.` : ''),
      navigateTo: 'ordenes',
    });
  };

  const emitEvent = (run: ReconcileRun): void => {
    try {
      deps.emitDiscrepancy?.({
        runId: run.id,
        at: run.finishedAt ?? isoNow(),
        discrepancies: deps.repository.listOpenDiscrepancies(),
      });
    } catch (error: unknown) {
      logger.warn?.(`[reconcile] el evento de descuadres falló: ${errorMessage(error)}`);
    }
  };

  /** Una pasada completa: leer ambos lados, comparar, persistir y avisar. */
  const execute = async (trigger: ReconcileTrigger): Promise<ReconcileRun> => {
    const run = deps.repository.startReconcileRun(trigger, isoNow());
    const blocked = blockedReason();
    if (blocked !== null) return failRun(run, blocked);

    const adapter = deps.getAdapter()!;
    let brokerPositions: Awaited<ReturnType<BrokerAdapter['listPositions']>>;
    let brokerOpenOrders: Awaited<ReturnType<BrokerAdapter['listOrders']>>;
    try {
      brokerPositions = await adapter.listPositions();
      brokerOpenOrders = await adapter.listOrders({ openOnly: true });
    } catch (error: unknown) {
      return failRun(run, errorMessage(error));
    }

    const comparison = reconcileBrokerState(
      {
        appOrders: listAllOrders(),
        brokerPositions,
        brokerOpenOrders,
      },
      {
        nowMs: now(),
        pendingGraceMs: deps.pendingGraceMs,
        priceTolerance: deps.priceTolerance,
      },
    );

    const fresh = persistFindings(run, comparison.discrepancies);
    const finished = deps.repository.finishReconcileRun(run.id, {
      finishedAt: isoNow(),
      result: comparison.discrepancies.length > 0 ? 'descuadre' : 'ok',
      positionsApp: comparison.appPositions.length,
      positionsBroker: brokerPositions.length,
      ordersApp: comparison.appOpenOrders.length,
      ordersBroker: brokerOpenOrders.length,
      discrepancies: fresh.length,
    });
    if (fresh.length > 0) announce(finished, fresh);
    emitEvent(finished);
    logger.info?.(
      `[reconcile] ejecución ${run.id} (${trigger}): ${finished.result}` +
        ` · posiciones ${finished.positionsApp}/${finished.positionsBroker}` +
        ` · órdenes ${finished.ordersApp}/${finished.ordersBroker}` +
        ` · ${fresh.length} descuadres nuevos`,
    );
    return finished;
  };

  /** Las pasadas programadas solo corren con cuenta conectada y conexión. */
  const tick = (): void => {
    if (!started) return;
    if (blockedReason() !== null) return;
    void service.runNow('programada').catch((error: unknown) => {
      logger.error?.(`[reconcile] la pasada programada falló: ${errorMessage(error)}`);
    });
  };

  const arm = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!started) return;
    timer = setTimer(() => {
      timer = null;
      tick();
      arm();
    }, intervalMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const service: ReconcileService = {
    runNow: (trigger) => {
      const runPromise = tail.then(() => execute(trigger));
      tail = runPromise.catch(() => undefined);
      return runPromise;
    },

    status: () => ({
      lastRun: deps.repository.getLastReconcileRun(),
      openDiscrepancies: deps.repository.listOpenDiscrepancies(),
    }),

    start: () => {
      if (started) return;
      started = true;
      arm();
    },

    stop: () => {
      started = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };

  return service;
}
