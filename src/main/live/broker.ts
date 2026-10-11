/**
 * Servicio del broker real mínimo (fase 7) — conexión live con la puerta
 * de la lista, ranura de claves separada y ejecución con techos.
 *
 * `createLiveBrokerService` es testeable sin Electron: la puerta (el
 * servicio `live` de la misma fase), el almacén, las claves, la factoría
 * del adaptador, el repositorio de `broker_orders_live` y los relojes
 * llegan inyectados.
 *
 * Reglas de negocio:
 * - Nada existe sin la lista cumplida: `connect` exige
 *   `live.getChecklist().allComplete` y la factoría del adaptador
 *   (`createAlpacaLiveBroker`) vuelve a comprobarla al construir y en
 *   cada envío. Unas claves que no empiezan por 'AK' (la convención live
 *   de Alpaca; las paper son 'PK') se rechazan con mensaje claro y no se
 *   guardan.
 * - Las claves live se validan contra `GET /v2/account` del endpoint
 *   real ANTES de guardarse en su ranura (`LIVE_BROKER_SECRET_KEYS`),
 *   cifradas por `secrets`; nunca salen del proceso principal.
 * - Las órdenes reales viven en `broker_orders_live`, aisladas de las
 *   paper: la conciliación, el informe real vs backtest y la muestra de
 *   «paper continuo» siguen mirando solo `broker_orders`.
 * - Las señales se ejecutan en real solo con el modo 'activo' y la
 *   cuenta conectada (`liveExecutionActive`); el resto del tiempo las
 *   sigue gestionando el broker paper.
 * - Cada envío pasa las puertas externas (parada, conexión) y la guarda
 *   de techos de `orderGuard.ts` (modo activo, límites confirmados,
 *   nocional, posiciones, capital y pérdida diaria), siempre antes de la
 *   red; las patas 'salida' pasan siempre (cierran riesgo).
 */
import {
  BROKER_ORDER_OPEN_STATUSES,
  type BrokerAccount,
  type BrokerOrder,
  type ReconcileDiscrepancyEvent,
} from '../../shared/broker';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { DeliveryEventKind, JournalRecordInput } from '../../shared/journal';
import {
  LIVE_BROKER_SECRET_KEYS,
  liveConfirmationPhrase,
  type LiveConnectRequest,
  type LiveLimits,
  type LiveSmokeTestRequest,
  type LiveSmokeTestResult,
  type LiveState,
} from '../../shared/live';
import type { Signal } from '../../shared/signals';
import type { AlpacaCredentials } from '../broker/alpaca';
import { closedTradesFromOrders, nyToday } from '../broker/deviation';
import type { DeliveryMessage } from '../delivery';
import type { BrokerSecretsStore } from '../broker/index';
import { createOrderManager, type OrderManager } from '../broker/orderManager';
import { positionsFromOrders } from '../broker/reconcile';
import { createReconcileService, type ReconcileService } from '../broker/reconcileService';
import type { BrokerRepository } from '../broker/repository';
import { isBrokerError, type BrokerAdapter } from '../broker/types';
import { liveOrderBlockReason, liveOrderWirePrice } from './orderGuard';
import { createLiveSmokeTest, type LiveSmokeTestService } from './smoke';
import type { LiveService, LiveStore } from './service';

/** Sincronización de órdenes live con el broker: cada minuto (como paper). */
export const LIVE_SYNC_INTERVAL_MS = 60_000;

/** Prefijo de las claves live de Alpaca (las paper son 'PK…'). */
export const LIVE_KEY_PREFIX = 'AK';

export const ERR_LIVE_GATE =
  'La lista de comprobación del modo real no está completa. Las claves live no se han guardado.';
export const ERR_LIVE_PAPER_KEYS =
  'Estas claves no corresponden a una cuenta real de Alpaca (las claves live empiezan por «AK»). No se han guardado.';
export const ERR_LIVE_AUTH =
  'No se pudo autenticar la cuenta real de Alpaca. Revisa la clave y el secreto.';
export const ERR_LIVE_SIMULATED_ONLY_E2E =
  'El broker real simulado solo está disponible en modo E2E.';

export const LIVE_BROKER_ERROR_CODES = [
  'lista-incompleta',
  'clave-paper',
  'validacion-cuenta',
  'sin-secrets',
  'no-e2e',
] as const;
export type LiveBrokerErrorCode = (typeof LIVE_BROKER_ERROR_CODES)[number];

/** Error legible de la conexión live; `code` lo usa la prueba y la UI. */
export class LiveBrokerError extends Error {
  readonly code: LiveBrokerErrorCode;

  constructor(code: LiveBrokerErrorCode, message: string) {
    super(message);
    this.name = 'LiveBrokerError';
    this.code = code;
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Cuenta enmascarada para la franja («•••• 4821»). */
const maskAccount = (accountId: string): string => `•••• ${accountId.replace(/\s/g, '').slice(-4)}`;

export interface LiveBrokerServiceDeps {
  /**
   * Servicio del modo real: la puerta (checklist), el estado emitido y
   * la suspensión (la prueba de humo la ejerce al fallar).
   */
  live: Pick<LiveService, 'getChecklist' | 'getState' | 'suspend'>;
  /** Almacén del modo real (live_mode.broker/cuenta, límites y estado). */
  store: LiveStore;
  /** Repositorio de las órdenes reales (`broker_orders_live`). */
  repository: BrokerRepository;
  /** Ranura de claves live del almacén cifrado (`LIVE_BROKER_SECRET_KEYS`). */
  secrets: BrokerSecretsStore;
  /**
   * Factoría del adaptador live: Alpaca con URL fija api.alpaca.markets
   * y la puerta de la lista ya cableada (`isLiveGateOpen`).
   */
  createAdapter(getCredentials: () => Promise<AlpacaCredentials | null>): BrokerAdapter;
  /**
   * Factoría del adaptador live sobre el servidor falso; solo existe en
   * E2E (`live:use-simulated-broker`). Misma puerta y mismo contrato.
   */
  createSimulatedAdapter?(getCredentials: () => Promise<AlpacaCredentials | null>): BrokerAdapter;
  /** Parada de emergencia activa (bloquea envíos). */
  isKillSwitchActive?(): boolean;
  /** Conexión a internet disponible (bloquea envíos). */
  isOnline?(): boolean;
  /** Señal persistida por id (reconstrucción del OCO de salida). */
  getSignal?(signalId: number): Signal | null;
  /** Entrada del diario automático. */
  recordJournal?(input: JournalRecordInput): void;
  /** Aviso por cada cambio de una orden live (`broker:order-updated`). */
  emitOrderUpdated?(order: BrokerOrder): void;
  /** Emite `live:changed` hacia las ventanas. */
  broadcast?(channel: string, payload: unknown): void;
  /**
   * Último cierre del ticker con la fecha de su vela, para la prueba de
   * humo; null si no hay datos. Sin una referencia reciente la prueba
   * no se lanza.
   */
  referencePrice?(
    ticker: string,
  ): { price: number; asOf: string } | null | Promise<{ price: number; asOf: string } | null>;
  /**
   * Reloj de mercado para juzgar la frescura de la referencia de la
   * prueba de humo (el reloj anclado con el que se ingieren las velas);
   * por defecto `now`.
   */
  marketNow?(): number;
  /** `delivery.sendEvent`: aviso de descuadres de la conciliación live. */
  sendEvent?(kind: DeliveryEventKind, message: DeliveryMessage): void;
  /** Emite `reconcile:discrepancy` tras una conciliación live. */
  emitDiscrepancy?(event: ReconcileDiscrepancyEvent): void;
  /** Espera máxima de la prueba de humo por cada ejecución (ms). */
  smokeFillTimeoutMs?: number;
  /** Intervalo entre consultas de estado de orden en la prueba (ms). */
  smokePollIntervalMs?: number;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  setTimer?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer?(handle: ReturnType<typeof setTimeout>): void;
  /** Intervalo de la sincronización de órdenes; por defecto 1 minuto. */
  syncIntervalMs?: number;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}

export interface LiveBrokerService {
  /** `live:connect`: valida la cuenta real y guarda las claves cifradas. */
  connect(request: LiveConnectRequest): Promise<LiveState>;
  /**
   * `live:use-simulated-broker` (solo E2E): conmuta la factoría del
   * adaptador al servidor falso; desconecta la cuenta vigente.
   */
  useSimulatedBroker(enabled: boolean): Promise<LiveState>;
  /**
   * true cuando las señales aprobadas deben ejecutarse en la cuenta
   * real (modo 'activo' + adaptador conectado); el broker paper se las
   * cede entonces.
   */
  liveExecutionActive(): boolean;
  /** Id del adaptador live conectado; null si no hay cuenta. */
  adapterId(): string | null;
  /**
   * `live:smoke-test`: compra de mercado fraccionaria de 1 USD en SPY,
   * venta de cierre y conciliación contra la cuenta conectada, con el
   * resultado persistido y un paso a paso en el Diario. Falla → suspende.
   */
  runSmokeTest(request: LiveSmokeTestRequest): Promise<LiveSmokeTestResult>;
  /** Entrada del evento `signals:new` (envoltura de broadcast). */
  handleSignalEvent(payload: unknown): Promise<void>;
  /** Reconecta con las claves guardadas si la puerta está abierta. */
  restore(): Promise<void>;
  stop(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export function createLiveBrokerService(deps: LiveBrokerServiceDeps): LiveBrokerService {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h: TimerHandle) => clearTimeout(h));
  const logger = deps.logger ?? console;
  const isoNow = (): string => new Date(now()).toISOString();
  const syncIntervalMs = Math.max(1_000, deps.syncIntervalMs ?? LIVE_SYNC_INTERVAL_MS);

  let adapter: BrokerAdapter | null = null;
  let orders: OrderManager | null = null;
  let simulated = false;
  let busy: Promise<unknown> | null = null;
  let syncTimer: TimerHandle | null = null;
  let stopped = false;

  /** La puerta del modo real: la lista de comprobación completa. */
  const gateOpen = (): boolean => deps.live.getChecklist().allComplete;

  const journal = (input: JournalRecordInput): void => {
    try {
      // Todo lo que traza el broker real es dinero real ('live').
      deps.recordJournal?.({ ...input, mode: 'live' });
    } catch (error: unknown) {
      logger.warn?.(`[live-broker] no se pudo escribir el Diario: ${errorMessage(error)}`);
    }
  };

  const emitChanged = async (): Promise<LiveState> => {
    const state = await deps.live.getState();
    deps.broadcast?.(IPC_CHANNELS.live.changed, state);
    return state;
  };

  const reject = (code: LiveBrokerErrorCode, message: string): never => {
    journal({
      type: 'limite',
      result: 'alcanzado',
      reason: `Conexión del dinero real rechazada: ${message}`,
      errors: [message],
    });
    logger.warn?.(`[live-broker] conexión rechazada (${code}): ${message}`);
    throw new LiveBrokerError(code, message);
  };

  /**
   * Lectura de la exposición real para la guarda de techos: posiciones
   * abiertas (coste medio), nocional de las compras aún abiertas y la
   * pérdida realizada en la sesión de Nueva York de hoy.
   */
  const orderSnapshot = (): Parameters<typeof liveOrderBlockReason>[0] => {
    const all = deps.repository.listOrders();
    const positions = positionsFromOrders(all);
    const positionUsd = positions.reduce(
      (sum, position) => sum + position.quantity * position.avgEntryPrice,
      0,
    );
    const openStatuses = new Set<string>(BROKER_ORDER_OPEN_STATUSES);
    const pendingUsd = all
      .filter(
        (order) =>
          order.side === 'buy' &&
          order.leg !== 'salida' &&
          openStatuses.has(order.status) &&
          order.filledQuantity < order.quantity,
      )
      .reduce((sum, order) => {
        const price = order.limitPrice ?? order.execution.requestedPrice;
        if (price === null || !(price > 0)) return sum;
        return sum + (order.quantity - order.filledQuantity) * price;
      }, 0);

    const byId = new Map(all.map((order) => [order.id, order]));
    const todayNy = nyToday(now());
    const realizedLossTodayUsd = closedTradesFromOrders(all)
      .filter((trade) => trade.closedAtNy === todayNy && trade.returnPct < 0)
      .reduce((sum, trade) => {
        const entry = byId.get(trade.entryOrderId);
        const entryNotional =
          entry === null || entry === undefined
            ? 0
            : entry.filledQuantity * (entry.execution.executedPrice ?? 0);
        return sum + (Math.abs(trade.returnPct) / 100) * entryNotional;
      }, 0);

    const limitsRow = deps.store.getLimits();
    const limits: LiveLimits | null =
      limitsRow !== null && limitsRow.confirmados === 1
        ? {
            capitalUsd: limitsRow.capital_usd,
            orderUsd: limitsRow.orden_usd,
            dailyLossUsd: limitsRow.perdida_diaria_usd,
            openPositions: limitsRow.posiciones_max,
          }
        : null;

    return {
      mode: deps.store.getMode().estado,
      limits,
      openTickers: positions.map((position) => position.ticker),
      capitalInUseUsd: positionUsd + pendingUsd,
      realizedLossTodayUsd,
    };
  };

  /**
   * Gestor de órdenes live sobre `broker_orders_live`: las mismas reglas
   * de paper (idempotencia, reintentos, huérfanas, OCO de salida) más la
   * guarda de techos. El interruptor «ejecución en paper» no aplica: en
   * real el interruptor es el propio modo 'activo'.
   */
  const buildOrderManager = (candidate: BrokerAdapter): OrderManager =>
    createOrderManager({
      adapter: candidate,
      repository: deps.repository,
      getSignal: deps.getSignal,
      isKillSwitchActive: deps.isKillSwitchActive,
      isOnline: deps.isOnline,
      checkOrderAllowed: (request, context) =>
        liveOrderBlockReason(orderSnapshot(), request, context),
      orderWirePrice: (request, context) =>
        liveOrderWirePrice(orderSnapshot(), request, context),
      recordJournal: deps.recordJournal,
      onOrderUpdated: deps.emitOrderUpdated,
      sleep: deps.sleep,
      now,
      logger,
    });

  /** Pasada de sincronización, solo con cuenta y conexión. */
  const syncTick = (): void => {
    if (stopped || orders === null || deps.isOnline?.() === false) return;
    void orders.syncWithBroker().catch((error: unknown) => {
      logger.warn?.(`[live-broker] la sincronización programada falló: ${errorMessage(error)}`);
    });
  };

  const armSync = (): void => {
    if (syncTimer !== null || stopped) return;
    const tick = (): void => {
      syncTimer = null;
      syncTick();
      armSync();
    };
    const handle = setTimer(tick, syncIntervalMs);
    (handle as { unref?: () => void }).unref?.();
    syncTimer = handle;
  };

  const attach = (candidate: BrokerAdapter, account: BrokerAccount): void => {
    adapter = candidate;
    orders = buildOrderManager(candidate);
    deps.store.setConnection({
      broker: simulated ? 'simulado' : 'alpaca',
      cuenta: maskAccount(account.accountId),
      actualizadoEn: isoNow(),
    });
    armSync();
    void orders.syncWithBroker().catch((error: unknown) => {
      logger.warn?.(`[live-broker] la primera sincronización falló: ${errorMessage(error)}`);
    });
    logger.info?.(
      `[live-broker] cuenta real conectada (${candidate.id}, ${maskAccount(account.accountId)})`,
    );
  };

  const detach = (): void => {
    if (syncTimer !== null) clearTimer(syncTimer);
    syncTimer = null;
    orders?.stop();
    orders = null;
    adapter = null;
    deps.store.setConnection({ broker: null, cuenta: null, actualizadoEn: isoNow() });
  };

  /** Factoría vigente: la simulada cuando el conmutador E2E está puesto. */
  const factory = () =>
    simulated && deps.createSimulatedAdapter !== undefined
      ? deps.createSimulatedAdapter
      : deps.createAdapter;

  const readSavedCredentials = async (): Promise<AlpacaCredentials | null> => {
    const [apiKeyId, apiSecret] = await Promise.all([
      deps.secrets.getKey(LIVE_BROKER_SECRET_KEYS.apiKeyId),
      deps.secrets.getKey(LIVE_BROKER_SECRET_KEYS.apiSecret),
    ]);
    return apiKeyId !== null && apiSecret !== null ? { apiKeyId, apiSecret } : null;
  };

  /**
   * Conciliación bajo demanda de la cuenta real: la misma lógica que la
   * paper sobre `broker_orders_live` y el adaptador vigente (comparten
   * `reconcile_runs`/`reconcile_discrepancies`, decisión de la migración
   * 012). La prueba de humo la usa como último paso.
   */
  const reconcile: ReconcileService = createReconcileService({
    getAdapter: () => adapter,
    repository: deps.repository,
    isOnline: deps.isOnline,
    recordJournal: deps.recordJournal,
    sendEvent: deps.sendEvent,
    emitDiscrepancy: deps.emitDiscrepancy,
    now,
    logger,
  });

  /**
   * Prueba de humo del modo real: 1 USD nocional de SPY comprado,
   * vendido y conciliado. La compra pasa la misma guarda de techos que
   * cualquier señal; el cierre se evalúa como 'salida' (siempre pasa).
   * Si algo falla, suspende el modo real ('requisito-vencido').
   */
  const smoke: LiveSmokeTestService = createLiveSmokeTest({
    getAdapter: () => adapter,
    repository: deps.repository,
    store: deps.store,
    getChecklist: () => deps.live.getChecklist(),
    checkOrderAllowed: (request, context) =>
      liveOrderBlockReason(orderSnapshot(), request, context),
    referencePrice: deps.referencePrice ?? (() => null),
    marketNow: deps.marketNow ?? now,
    reconcileNow: () => reconcile.runNow('manual'),
    openDiscrepancyCount: () => reconcile.status().openDiscrepancies.length,
    suspend: (detail) => deps.live.suspend('requisito-vencido', detail),
    isKillSwitchActive: deps.isKillSwitchActive,
    isOnline: deps.isOnline,
    recordJournal: deps.recordJournal,
    emitChanged: () => void emitChanged(),
    fillTimeoutMs: deps.smokeFillTimeoutMs,
    pollIntervalMs: deps.smokePollIntervalMs,
    now,
    sleep: deps.sleep,
    logger,
  });

  const savedKeysExist = async (): Promise<boolean> => {
    try {
      const [id, secret] = await Promise.all([
        deps.secrets.hasKey(LIVE_BROKER_SECRET_KEYS.apiKeyId),
        deps.secrets.hasKey(LIVE_BROKER_SECRET_KEYS.apiSecret),
      ]);
      return id && secret;
    } catch {
      return false;
    }
  };

  const mapError = (error: unknown): string => {
    if (isBrokerError(error)) {
      if (error.kind === 'auth') return ERR_LIVE_AUTH;
      if (error.retryable) {
        return 'No se pudo contactar con el broker. Comprueba la conexión e inténtalo de nuevo.';
      }
    }
    return errorMessage(error);
  };

  const doConnect = async (request: LiveConnectRequest): Promise<LiveState> => {
    if (!gateOpen()) reject('lista-incompleta', ERR_LIVE_GATE);
    if (!request.apiKeyId.startsWith(LIVE_KEY_PREFIX)) {
      reject('clave-paper', ERR_LIVE_PAPER_KEYS);
    }

    const candidate = factory()(async () => request);
    // Validación contra la cuenta real antes de guardar nada.
    const account = await candidate
      .getAccount()
      .catch((error: unknown) => reject('validacion-cuenta', mapError(error)));

    try {
      // Solo cifradas en el llavero del SO y en la ranura live (nunca en
      // la de paper, nunca en texto plano).
      await deps.secrets.setKey(LIVE_BROKER_SECRET_KEYS.apiKeyId, request.apiKeyId);
      await deps.secrets.setKey(LIVE_BROKER_SECRET_KEYS.apiSecret, request.apiSecret);
    } catch (error: unknown) {
      reject('sin-secrets', errorMessage(error));
    }

    orders?.stop();
    orders = null;
    adapter = null;
    attach(candidate, account);

    const limitsRow = deps.store.getLimits();
    const limits =
      limitsRow === null
        ? null
        : {
            capitalUsd: limitsRow.capital_usd,
            orderUsd: limitsRow.orden_usd,
            dailyLossUsd: limitsRow.perdida_diaria_usd,
            openPositions: limitsRow.posiciones_max,
          };
    journal({
      type: 'resumen',
      result: 'completado',
      reason:
        `Cuenta real de Alpaca conectada (${maskAccount(account.accountId)})` +
        (limits !== null ? ` con los límites: ${liveConfirmationPhrase(limits)}.` : '.'),
      dataUsed: {
        broker: simulated ? 'simulado' : 'alpaca',
        cuenta: maskAccount(account.accountId),
      },
    });
    return emitChanged();
  };

  const service: LiveBrokerService = {
    connect: (request) => {
      busy ??= doConnect(request).finally(() => {
        busy = null;
      });
      return busy as Promise<LiveState>;
    },

    useSimulatedBroker: async (enabled) => {
      if (deps.createSimulatedAdapter === undefined) {
        throw new LiveBrokerError('no-e2e', ERR_LIVE_SIMULATED_ONLY_E2E);
      }
      if (enabled === simulated) return deps.live.getState();
      detach();
      simulated = enabled;
      journal({
        type: 'resumen',
        result: 'completado',
        reason: enabled
          ? 'Broker real simulado activado (E2E): la cuenta live apunta al servidor falso.'
          : 'Broker real simulado desactivado (E2E): la cuenta live vuelve al adaptador real.',
      });
      logger.warn?.(`[live-broker] broker real simulado ${enabled ? 'activado' : 'desactivado'}`);
      return emitChanged();
    },

    liveExecutionActive: () =>
      adapter !== null && deps.store.getMode().estado === 'activo' && !stopped,

    adapterId: () => adapter?.id ?? null,

    runSmokeTest: (request) => smoke.run(request),

    handleSignalEvent: (payload) => {
      const manager = orders;
      if (manager === null || stopped || !service.liveExecutionActive()) {
        return Promise.resolve();
      }
      return manager.handleSignalEvent(payload).then(
        () => undefined,
        (error: unknown) => {
          logger.warn?.(
            `[live-broker] el gestor de órdenes falló con una señal: ${errorMessage(error)}`,
          );
        },
      );
    },

    restore: async () => {
      if (stopped || !(await savedKeysExist())) return;
      if (!gateOpen()) {
        logger.warn?.(
          '[live-broker] hay claves live guardadas pero la lista no está completa; no se reconecta',
        );
        return;
      }
      try {
        const candidate = factory()(readSavedCredentials);
        attach(candidate, await candidate.getAccount());
      } catch (error: unknown) {
        // Las claves se conservan: el usuario puede reconectar a mano.
        logger.warn?.(`[live-broker] no se pudo restaurar la cuenta real: ${errorMessage(error)}`);
      }
    },

    stop: () => {
      stopped = true;
      detach();
    },
  };

  return service;
}
