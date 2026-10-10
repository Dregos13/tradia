/**
 * Servicio del broker en modo paper — Fase 5 (registro en el proceso
 * principal).
 *
 * Une las piezas del dominio (`repository`, `orderManager`,
 * `reconcileService`, `deviationService`) con los servicios de la app y
 * registra los canales IPC del contrato (`broker:*`, `orders:*`,
 * `reconcile:*`, `deviation:*`; ver `IPC_CHANNELS` en shared/ipc.ts).
 *
 * Reglas de negocio:
 * - Solo paper: el adaptador real es Alpaca paper (`createAlpacaBroker`,
 *   URL fija `paper-api.alpaca.markets`). Las claves cuyo id no empieza
 *   por 'PK' — la convención de Alpaca para paper (las live usan 'AK')—
 *   se rechazan antes de tocar la red, y una cuenta que no valida contra
 *   el endpoint paper nunca llega a guardar claves. En modo E2E
 *   (`TRADIA_E2E` sin empaquetar) el adaptador es el broker simulado.
 * - Las claves se guardan en `secrets` (cifradas con el llavero del SO)
 *   solo DESPUÉS de validar la cuenta, y se borran al desconectar. Nunca
 *   salen del proceso principal: ningún handler las devuelve y los
 *   mensajes de error no las incluyen.
 * - Con la cuenta conectada, cada `signals:new` con decisión aprobada o
 *   reducida entra al gestor de órdenes por la envoltura de
 *   `ctx.broadcast` (el mismo patrón que `delivery`/`health`); sin
 *   cuenta, el seguimiento local de `signals/paper.ts` sigue igual.
 * - La conciliación corre cada 15 min con cuenta y conexión, tras el
 *   postmercado de la rutina y a demanda (`reconcile:run`); el informe
 *   real vs backtest se recalcula cada hora y en el postmercado para
 *   que las alertas salgan aunque nadie abra la página. El gestor
 *   sincroniza las órdenes abiertas cada minuto y al volver la conexión.
 * - Ganchos E2E (`broker:fail-next`, `broker:create-discrepancy`,
 *   `broker:seed-weeks`) solo se registran con el broker simulado.
 *
 * `createBrokerService` es testeable sin Electron: la base, los
 * servicios, el reloj y los temporizadores llegan inyectados.
 */
import { app, ipcMain } from 'electron';

import {
  BROKER_ORDER_OPEN_STATUSES,
  BROKER_SECRET_KEYS,
  DEVIATION_MARGIN_PP_DEFAULT,
  DEVIATION_SLIPPAGE_BPS_DEFAULT,
  IPC_CHANNELS,
  IpcValidationError,
  isBrokerConnectRequest,
  isBrokerDiscrepancyRequest,
  isBrokerFailNextRequest,
  isBrokerOrdersQuery,
  isBrokerSeedWeeksRequest,
  isBrokerTestRequest,
  isCancelOrderRequest,
  isDeviationReportQuery,
  isE2eEnabled,
  type BrokerAccount,
  type BrokerAdapterId,
  type BrokerConnectRequest,
  type BrokerConnectionState,
  type BrokerCredentials,
  type BrokerDiscrepancyResult,
  type BrokerE2eDiscrepancy,
  type BrokerE2eFailure,
  type BrokerFailNextResult,
  type BrokerOrder,
  type BrokerOrdersQuery,
  type BrokerSeedWeeksRequest,
  type BrokerSeedWeeksResult,
  type BrokerStatus,
  type BrokerTestRequest,
  type BrokerTestResult,
  type CancelOrderRequest,
  type ConnectivityState,
  type DeviationReport,
  type DeviationReportQuery,
  type ReconcileDiscrepancyEvent,
  type ReconcileRun,
  type ReconcileStatusResult,
} from '../../shared/ipc';
import type { DeliveryEventKind, JournalRecordInput } from '../../shared/journal';
import type { Signal } from '../../shared/signals';
import { openDatabase } from '../db/database';
import type { DeliveryMessage } from '../delivery';
import type { ServiceContext } from '../services';
import { createAlpacaBroker } from './alpaca';
import { expectationFromReport, type StrategyExpectation } from './deviation';
import {
  createDeviationService,
  type DeviationMargins,
  type StrategyInfo,
} from './deviationService';
import { createOrderManager, type OrderManager } from './orderManager';
import { createReconcileService } from './reconcileService';
import { createBrokerRepository, type BrokerRepository } from './repository';
import { createSimulatedBroker, type SimulatedBroker } from './simulated';
import { isBrokerError, type BrokerAdapter } from './types';

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

/** Sincronización de órdenes abiertas con el broker: cada minuto. */
export const BROKER_SYNC_INTERVAL_MS = 60_000;
/** Recálculo del informe real vs backtest: cada hora y en el postmercado. */
export const DEVIATION_RECALC_INTERVAL_MS = 60 * 60_000;

/** Mensajes legibles de la conexión (los textos del diseño de Ajustes). */
export const ERR_BROKER_LIVE_KEYS =
  'Estas claves no corresponden a una cuenta paper. No se han guardado.';
export const ERR_BROKER_AUTH =
  'No se pudo autenticar la cuenta paper. Revisa la clave y el secreto.';
export const ERR_BROKER_NO_KEYS =
  'No hay claves guardadas de una cuenta paper. Conecta la cuenta primero.';
export const ERR_BROKER_NO_ACCOUNT =
  'No hay una cuenta paper conectada: el broker no puede cancelar la orden.';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface BrokerServiceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Almacén de claves cifradas que necesita el servicio (`services.secrets`). */
export interface BrokerSecretsStore {
  setKey(provider: string, apiKey: string): Promise<void>;
  hasKey(provider: string): Promise<boolean>;
  deleteKey(provider: string): Promise<void>;
  getKey(provider: string): Promise<string | null>;
}

export interface BrokerServiceDeps {
  /** Repositorio del dominio broker (migración 010). */
  repository: BrokerRepository;
  /** Claves cifradas del broker (`BROKER_SECRET_KEYS` como proveedores). */
  secrets: BrokerSecretsStore;
  /**
   * Factoría del adaptador real: recibe el lector de claves (secrets o
   * las recién pedidas) y devuelve el adaptador Alpaca paper.
   */
  createAdapter(getCredentials: () => Promise<BrokerCredentials | null>): BrokerAdapter;
  /**
   * Broker simulado del modo E2E; cuando existe sustituye al adaptador
   * real en connect/test y habilita los ganchos `service.e2e`.
   */
  e2eBroker?: SimulatedBroker;
  /** Interruptor «Ejecutar señales aprobadas en paper» (settings). */
  isExecutionEnabled(): boolean;
  /** Conexión a internet disponible (services.connectivity). */
  isOnline?(): boolean;
  /** Parada de emergencia activa (services.killSwitch). */
  isKillSwitchActive?(): boolean;
  /** Señal persistida por id (services.signals.engine.getSignal). */
  getSignal?(signalId: number): Signal | null;
  /** `journal.record`; si falta, los rastros de diario se omiten. */
  recordJournal?(input: JournalRecordInput): void;
  /** `journal.record` con la entrada creada (para deviation_alerts). */
  recordJournalEntry?(input: JournalRecordInput): import('../../shared/journal').JournalEntry;
  /** `delivery.sendEvent` (aviso de descuadre por los canales). */
  sendEvent?(kind: DeliveryEventKind, message: DeliveryMessage): void;
  /** `notifications.notify` (alerta de desviación de escritorio). */
  notify?(payload: import('../../shared/ipc').NotificationPayload): void;
  /** Emite `broker:order-updated` hacia las ventanas (payload: la orden). */
  emitOrderUpdated?(order: BrokerOrder): void;
  /** Emite `reconcile:discrepancy` hacia las ventanas. */
  emitDiscrepancy?(event: ReconcileDiscrepancyEvent): void;
  /** Márgenes del informe de desviación (settings). */
  margins(): DeviationMargins;
  /** Expectativa del último backtest de la estrategia. */
  expectationFor(strategyId: number): StrategyExpectation;
  /** Nombre y versión vigente de la estrategia; null si no consta. */
  strategyInfo?(strategyId: number): StrategyInfo | null;
  /** Oyente del postmercado de la rutina (`routine.onPostMarket`). */
  onPostMarket?(listener: (dia: string) => void): () => void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  /** Espera entre reintentos del gestor; por defecto setTimeout real. */
  sleep?(ms: number): Promise<void>;
  setTimer?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer?(handle: ReturnType<typeof setTimeout>): void;
  logger?: Partial<BrokerServiceLogger>;
}

/** Ganchos del broker simulado; solo existen en modo E2E. */
export interface BrokerE2eHooks {
  failNext(request: { kind: BrokerE2eFailure }): BrokerFailNextResult;
  createDiscrepancy(request: { kind: BrokerE2eDiscrepancy }): Promise<BrokerDiscrepancyResult>;
  seedWeeks(request?: BrokerSeedWeeksRequest): BrokerSeedWeeksResult;
}

export interface BrokerService {
  /** Estado de la conexión para `broker:status` (nunca incluye claves). */
  status(): BrokerStatus;
  /** `broker:connect`: valida la cuenta paper y guarda las claves. */
  connect(request: BrokerConnectRequest): Promise<BrokerStatus>;
  /** `broker:disconnect`: borra las claves y suelta el adaptador. */
  disconnect(): Promise<BrokerStatus>;
  /** `broker:test`: valida claves nuevas o las guardadas. */
  test(request?: BrokerTestRequest): Promise<BrokerTestResult>;
  /** `orders:list`. */
  listOrders(query?: BrokerOrdersQuery): BrokerOrder[];
  /** `orders:cancel`: cancela una orden abierta por id local. */
  cancelOrder(request: CancelOrderRequest): Promise<BrokerOrder>;
  /** `reconcile:run`: una pasada manual de conciliación. */
  reconcileRun(): Promise<ReconcileRun>;
  /** `reconcile:status`. */
  reconcileStatus(): ReconcileStatusResult;
  /** `deviation:report`. */
  deviationReport(query: DeviationReportQuery): DeviationReport;
  /** Entrada del evento `signals:new` (envoltura de broadcast). */
  handleSignalEvent(payload: unknown): void;
  /** Entrada de `connectivity:changed`: al volver la conexión, resincroniza. */
  handleConnectivityChange(payload: unknown): void;
  /** Ganchos del broker simulado; null fuera del modo E2E. */
  e2e: BrokerE2eHooks | null;
  /**
   * Arma los temporizadores (sincronización de órdenes, recálculo del
   * informe) y el enganche del postmercado, y restaura la conexión si
   * hay claves guardadas de una sesión anterior.
   */
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

interface ConnectionState {
  state: BrokerConnectionState;
  adapterId: BrokerAdapterId | null;
  account: BrokerAccount | null;
  error: string | null;
  checkedAt: string | null;
}

const DISCONNECTED: ConnectionState = {
  state: 'desconectada',
  adapterId: null,
  account: null,
  error: null,
  checkedAt: null,
};

type TimerHandle = ReturnType<typeof setTimeout>;

export function createBrokerService(deps: BrokerServiceDeps): BrokerService {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h: TimerHandle) => clearTimeout(h));
  const logger = deps.logger ?? console;
  const isoNow = (): string => new Date(now()).toISOString();

  let conn: ConnectionState = { ...DISCONNECTED };
  let adapter: BrokerAdapter | null = null;
  let orders: OrderManager | null = null;
  let busy: Promise<unknown> | null = null;
  let stopped = false;

  /** Nombre legible del broker para los mensajes de contacto. */
  const brokerLabel = (): string =>
    (conn.adapterId ?? deps.e2eBroker?.id) === 'simulado' ? 'el broker simulado' : 'Alpaca Paper';

  /**
   * Traduce el fallo del adaptador al mensaje de Ajustes: credenciales,
   * claves live o alcance; el resto conserva su mensaje legible.
   */
  const mapError = (error: unknown): string => {
    if (isBrokerError(error)) {
      if (error.kind === 'auth') return ERR_BROKER_AUTH;
      if (error.retryable) {
        return `No se pudo contactar con ${brokerLabel()}. Comprueba la conexión e inténtalo de nuevo.`;
      }
    }
    return errorMessage(error);
  };

  /** El renderer nunca ve claves: el estado solo lleva cuenta y saldo. */
  const status = (): BrokerStatus => ({
    state: conn.state,
    adapter: conn.adapterId,
    account: conn.account,
    executionEnabled: deps.isExecutionEnabled(),
    error: conn.error,
    checkedAt: conn.checkedAt,
  });

  /**
   * Con la cuenta ya validada: monta el gestor de órdenes sobre el
   * adaptador, marca la conexión y lanza la primera sincronización.
   */
  const activate = (candidate: BrokerAdapter, account: BrokerAccount): void => {
    if (stopped) return;
    adapter = candidate;
    conn = {
      state: 'conectada',
      adapterId: candidate.id,
      account,
      error: null,
      checkedAt: isoNow(),
    };
    orders = createOrderManager({
      adapter: candidate,
      repository: deps.repository,
      getSignal: deps.getSignal,
      isKillSwitchActive: deps.isKillSwitchActive,
      isOnline: deps.isOnline,
      isExecutionEnabled: deps.isExecutionEnabled,
      recordJournal: deps.recordJournal,
      onOrderUpdated: deps.emitOrderUpdated,
      sleep: deps.sleep,
      now,
      logger,
    });
    void orders.syncWithBroker().catch((error: unknown) => {
      logger.warn?.(`[broker] la primera sincronización falló: ${errorMessage(error)}`);
    });
    logger.info?.(`[broker] cuenta paper conectada (${candidate.id}, ${account.accountId})`);
  };

  const savedKeysExist = async (): Promise<boolean> => {
    try {
      const [id, secret] = await Promise.all([
        deps.secrets.hasKey(BROKER_SECRET_KEYS.apiKeyId),
        deps.secrets.hasKey(BROKER_SECRET_KEYS.apiSecret),
      ]);
      return id && secret;
    } catch {
      return false;
    }
  };

  /** Lector de las claves guardadas para el adaptador real. */
  const readSavedCredentials = async (): Promise<BrokerCredentials | null> => {
    const [apiKeyId, apiSecret] = await Promise.all([
      deps.secrets.getKey(BROKER_SECRET_KEYS.apiKeyId),
      deps.secrets.getKey(BROKER_SECRET_KEYS.apiSecret),
    ]);
    return apiKeyId !== null && apiSecret !== null ? { apiKeyId, apiSecret } : null;
  };

  /** Adaptador candidato: el simulado en E2E, el real con esas claves si no. */
  const candidateFor = (getCredentials: () => Promise<BrokerCredentials | null>): BrokerAdapter =>
    deps.e2eBroker ?? deps.createAdapter(getCredentials);

  /**
   * Las claves de una cuenta live de Alpaca nunca salen a la red: el id
   * de las paper empieza por 'PK' y el de las live por 'AK' (convención
   * del propio broker). Con el simulado E2E no aplica.
   */
  const looksLive = (credentials: BrokerCredentials): boolean =>
    deps.e2eBroker === undefined && !credentials.apiKeyId.startsWith('PK');

  const failConnection = (message: string): BrokerStatus => {
    conn = { ...conn, state: 'error', account: null, error: message };
    return status();
  };

  const doConnect = async (request: BrokerConnectRequest): Promise<BrokerStatus> => {
    conn = { ...conn, state: 'comprobando', error: null };
    if (looksLive(request)) return failConnection(ERR_BROKER_LIVE_KEYS);

    const candidate = candidateFor(async () => request);
    let account: BrokerAccount;
    try {
      // Validación contra el endpoint paper antes de guardar nada: unas
      // claves live o inválidas obtienen 401/'auth' y no se persisten.
      account = await candidate.getAccount();
    } catch (error: unknown) {
      return failConnection(mapError(error));
    }

    try {
      // Solo cifradas en el llavero del SO (secrets.setKey rechaza el
      // texto plano); si no hay llavero, la conexión no se completa.
      await deps.secrets.setKey(BROKER_SECRET_KEYS.apiKeyId, request.apiKeyId);
      await deps.secrets.setKey(BROKER_SECRET_KEYS.apiSecret, request.apiSecret);
    } catch (error: unknown) {
      return failConnection(errorMessage(error));
    }

    orders?.stop();
    orders = null;
    adapter = null;
    activate(candidate, account);
    return status();
  };

  /**
   * Al arrancar con claves guardadas la app vuelve a conectar sola: es
   * residente en bandeja y las señales deben seguir ejecutándose.
   */
  const restore = async (): Promise<void> => {
    if (!(await savedKeysExist())) return;
    conn = { ...conn, state: 'comprobando' };
    const candidate = candidateFor(readSavedCredentials);
    try {
      activate(candidate, await candidate.getAccount());
    } catch (error: unknown) {
      conn = { ...conn, state: 'error', error: mapError(error) };
      logger.warn?.(`[broker] no se pudo restaurar la cuenta paper: ${errorMessage(error)}`);
    }
  };

  const failTest = (error: string, startMs: number): BrokerTestResult => ({
    ok: false,
    account: null,
    error,
    latencyMs: Math.max(0, Math.round(now() - startMs)),
  });

  const reconcile = createReconcileService({
    getAdapter: () => adapter,
    repository: deps.repository,
    isOnline: deps.isOnline,
    recordJournal: deps.recordJournal,
    sendEvent: deps.sendEvent,
    emitDiscrepancy: deps.emitDiscrepancy,
    now,
    setTimer,
    clearTimer,
    logger,
  });

  const deviation = createDeviationService({
    repo: deps.repository,
    expectationFor: deps.expectationFor,
    strategyInfo: deps.strategyInfo,
    margins: deps.margins,
    recordJournal: deps.recordJournalEntry,
    notify: deps.notify,
    now,
    logger,
  });

  // -- Temporizadores --------------------------------------------------------

  let started = false;
  let syncTimer: TimerHandle | null = null;
  let deviationTimer: TimerHandle | null = null;
  let unsubscribePostMarket: (() => void) | null = null;

  /** Pasada de sincronización de órdenes abiertas, solo con cuenta y conexión. */
  const syncTick = (): void => {
    if (!started || stopped) return;
    if (orders === null || deps.isOnline?.() === false) return;
    void orders.syncWithBroker().catch((error: unknown) => {
      logger.warn?.(`[broker] la sincronización programada falló: ${errorMessage(error)}`);
    });
  };

  /** Recalcula el informe para que las alertas salgan sin abrir la página. */
  const recalcDeviation = (): void => {
    if (!started || stopped) return;
    try {
      deviation.report({ period: 'semanal' });
    } catch (error: unknown) {
      logger.warn?.(`[broker] el recálculo del informe falló: ${errorMessage(error)}`);
    }
  };

  const armEvery = (callback: () => void, intervalMs: number, slot: 'sync' | 'deviation'): void => {
    const handle = setTimer(() => {
      if (slot === 'sync') syncTimer = null;
      else deviationTimer = null;
      callback();
      if (started && !stopped) armEvery(callback, intervalMs, slot);
    }, intervalMs);
    (handle as { unref?: () => void }).unref?.();
    if (slot === 'sync') syncTimer = handle;
    else deviationTimer = handle;
  };

  // -- Ganchos E2E ------------------------------------------------------------

  const e2e: BrokerE2eHooks | null =
    deps.e2eBroker === undefined
      ? null
      : {
          failNext: (request) => {
            deps.e2eBroker!.failNext(request.kind);
            return { armed: request.kind };
          },
          createDiscrepancy: async (request) => {
            const sim = deps.e2eBroker!;
            if (request.kind === 'posicion-cantidad') {
              const positions = await sim.listPositions();
              const first = positions[0];
              if (first !== undefined) {
                // La app conserva su cantidad; el broker muestra una más.
                sim.tamperPosition(first.ticker, { quantity: first.quantity + 1 });
              } else {
                // Sin posiciones, el descuadre es una que el broker tiene y la app no.
                sim.setPosition({
                  ticker: 'AAPL',
                  side: 'long',
                  quantity: 7,
                  avgEntryPrice: 100,
                  marketValue: null,
                  unrealizedPnl: null,
                  currency: 'USD',
                });
              }
            } else if (request.kind === 'orden-borrada') {
              const open = deps.repository
                .listOrders({ limit: 500 })
                .find((o) => (BROKER_ORDER_OPEN_STATUSES as readonly string[]).includes(o.status));
              if (open !== undefined) {
                sim.dropOrder(open.clientOrderId);
              } else {
                // Sin orden abierta se fabrica una local que el broker no conoce.
                deps.repository.insertOrder({
                  clientOrderId: `tradia-borrada-${now()}`,
                  ticker: 'AAPL',
                  type: 'limit',
                  side: 'buy',
                  quantity: 1,
                  limitPrice: 1,
                  requestedPrice: 1,
                  requestedAt: isoNow(),
                  status: 'enviada',
                });
              }
            } else {
              sim.injectPhantomOrder();
            }
            return { kind: request.kind };
          },
          seedWeeks: (request) => deviation.seedWeeks(request),
        };

  // -- Superficie -------------------------------------------------------------

  const service: BrokerService = {
    status,

    connect: (request) => {
      // Una sola conexión en curso: el reintento devuelve la misma promesa.
      busy ??= doConnect(request).finally(() => {
        busy = null;
      });
      return busy as Promise<BrokerStatus>;
    },

    disconnect: async () => {
      try {
        await busy;
      } catch {
        // El fallo de la conexión en curso ya quedó anotado en el estado.
      }
      orders?.stop();
      orders = null;
      adapter = null;
      try {
        await deps.secrets.deleteKey(BROKER_SECRET_KEYS.apiKeyId);
        await deps.secrets.deleteKey(BROKER_SECRET_KEYS.apiSecret);
      } catch (error: unknown) {
        logger.warn?.(`[broker] no se pudieron borrar las claves: ${errorMessage(error)}`);
      }
      // Se conserva el adapterId (el diseño muestra el último broker usado).
      conn = { ...DISCONNECTED, adapterId: conn.adapterId };
      return status();
    },

    test: async (request) => {
      const startMs = now();
      try {
        let candidate: BrokerAdapter;
        if (request?.apiKeyId !== undefined || request?.apiSecret !== undefined) {
          if (request?.apiKeyId === undefined || request?.apiSecret === undefined) {
            return failTest('las dos claves a la vez o ninguna', startMs);
          }
          const credentials = { apiKeyId: request.apiKeyId, apiSecret: request.apiSecret };
          if (looksLive(credentials)) return failTest(ERR_BROKER_LIVE_KEYS, startMs);
          candidate = candidateFor(async () => credentials);
        } else {
          if (adapter === null && !(await savedKeysExist())) {
            return failTest(ERR_BROKER_NO_KEYS, startMs);
          }
          candidate = adapter ?? candidateFor(readSavedCredentials);
        }
        const account = await candidate.getAccount();
        const latencyMs = Math.max(0, Math.round(now() - startMs));
        if (candidate === adapter && conn.state === 'conectada') {
          conn = { ...conn, account, checkedAt: isoNow() };
        }
        return { ok: true, account, error: null, latencyMs };
      } catch (error: unknown) {
        return failTest(mapError(error), startMs);
      }
    },

    listOrders: (query) => deps.repository.listOrders(query),

    cancelOrder: async (request) => {
      if (orders === null) throw new Error(ERR_BROKER_NO_ACCOUNT);
      return orders.cancelOrder(request.id);
    },

    reconcileRun: () => reconcile.runNow('manual'),
    reconcileStatus: () => reconcile.status(),
    deviationReport: (query) => deviation.report(query),

    handleSignalEvent: (payload) => {
      const manager = orders;
      if (manager === null || stopped) return;
      void manager.handleSignalEvent(payload).catch((error: unknown) => {
        logger.warn?.(`[broker] el gestor de órdenes falló con una señal: ${errorMessage(error)}`);
      });
    },

    handleConnectivityChange: (payload) => {
      const state = (payload as Partial<ConnectivityState> | null | undefined)?.status;
      if (state !== 'online' || orders === null || stopped) return;
      void orders.syncWithBroker().catch((error: unknown) => {
        logger.warn?.(`[broker] la resincronización tras reconectar falló: ${errorMessage(error)}`);
      });
    },

    e2e,

    start: () => {
      if (started || stopped) return;
      started = true;
      reconcile.start();
      armEvery(syncTick, BROKER_SYNC_INTERVAL_MS, 'sync');
      armEvery(recalcDeviation, DEVIATION_RECALC_INTERVAL_MS, 'deviation');
      unsubscribePostMarket =
        deps.onPostMarket?.(() => {
          void reconcile.runNow('rutina').catch((error: unknown) => {
            logger.warn?.(`[broker] la conciliación de rutina falló: ${errorMessage(error)}`);
          });
          recalcDeviation();
        }) ?? null;
      void restore().catch((error: unknown) => {
        logger.warn?.(`[broker] la restauración de la conexión falló: ${errorMessage(error)}`);
      });
    },

    stop: () => {
      stopped = true;
      started = false;
      if (syncTimer !== null) clearTimer(syncTimer);
      if (deviationTimer !== null) clearTimer(deviationTimer);
      syncTimer = null;
      deviationTimer = null;
      unsubscribePostMarket?.();
      unsubscribePostMarket = null;
      reconcile.stop();
      orders?.stop();
      orders = null;
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

/** Almacén de claves para cuando `services.secrets` no está disponible. */
const unavailableSecrets: BrokerSecretsStore = {
  setKey: () =>
    Promise.reject(new Error('El almacén de claves cifradas no está disponible en esta sesión.')),
  hasKey: () => Promise.resolve(false),
  deleteKey: () => Promise.resolve(),
  getKey: () => Promise.resolve(null),
};

export function registerBroker(ctx: ServiceContext): BrokerService {
  // Sin base de datos el dominio degrada a memoria (mismo patrón que signals).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[broker] almacén no disponible: las órdenes solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const repository = createBrokerRepository(db);

  // Solo en modo E2E sin empaquetar el adaptador es el broker simulado.
  const e2eBroker = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)
    ? createSimulatedBroker({ seed: 'tradia-e2e' })
    : undefined;

  const journal = ctx.services.journal;
  const service = createBrokerService({
    repository,
    secrets: ctx.services.secrets ?? unavailableSecrets,
    createAdapter: (getCredentials) =>
      createAlpacaBroker({ fetch: globalThis.fetch, getCredentials }),
    e2eBroker,
    isExecutionEnabled: () => ctx.services.settings?.get().brokerExecutionEnabled ?? true,
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
    isKillSwitchActive: () => ctx.services.killSwitch?.getState().active ?? false,
    getSignal: (id) => ctx.services.signals?.engine.getSignal(id) ?? null,
    recordJournal: journal ? (input) => void journal.record(input) : undefined,
    recordJournalEntry: journal ? (input) => journal.record(input) : undefined,
    sendEvent: (kind, message) => ctx.services.delivery?.sendEvent(kind, message),
    notify: (payload) => ctx.services.notifications?.notify(payload),
    emitOrderUpdated: (order) => ctx.broadcast(IPC_CHANNELS.broker.orderUpdated, order),
    emitDiscrepancy: (event) => ctx.broadcast(IPC_CHANNELS.reconcile.discrepancy, event),
    margins: () => {
      const settings = ctx.services.settings?.get();
      return {
        marginPp: settings?.deviationMarginPp ?? DEVIATION_MARGIN_PP_DEFAULT,
        maxSlippageBps: settings?.deviationSlippageBps ?? DEVIATION_SLIPPAGE_BPS_DEFAULT,
      };
    },
    expectationFor: (strategyId) => {
      const latest = ctx.services.backtest?.listRuns({ strategyId, limit: 1 })[0];
      return expectationFromReport(
        latest === undefined ? null : (ctx.services.backtest?.getRun(latest.id) ?? null),
      );
    },
    strategyInfo: (strategyId) => {
      const ficha = ctx.services.strategies?.get(strategyId);
      return ficha === null || ficha === undefined
        ? null
        : { name: ficha.name, version: ficha.version };
    },
    onPostMarket: (listener) => ctx.services.routine?.onPostMarket(listener) ?? (() => undefined),
  });

  // Las señales aprobadas y la vuelta de la conexión llegan por la envoltura
  // de ctx.broadcast (los emisores lo llaman de forma perezosa, patrón de
  // delivery/health). Sin cuenta conectada el gestor es null y sigue
  // mandando el seguimiento local de signals/paper.ts.
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.signals.new) service.handleSignalEvent(payload);
    else if (channel === IPC_CHANNELS.connectivity.changed) {
      service.handleConnectivityChange(payload);
    }
  };

  ipcMain.handle(IPC_CHANNELS.broker.connect, (_event, request: unknown) => {
    if (!isBrokerConnectRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.broker.connect,
        'se esperaba {apiKeyId, apiSecret}',
      );
    }
    return service.connect(request);
  });
  ipcMain.handle(IPC_CHANNELS.broker.disconnect, () => service.disconnect());
  ipcMain.handle(IPC_CHANNELS.broker.status, () => service.status());
  ipcMain.handle(IPC_CHANNELS.broker.test, (_event, request: unknown) => {
    if (!isBrokerTestRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.broker.test,
        'se esperaba {apiKeyId, apiSecret} o nada',
      );
    }
    return service.test(request);
  });
  ipcMain.handle(IPC_CHANNELS.orders.list, (_event, query: unknown) => {
    if (!isBrokerOrdersQuery(query)) {
      throw new IpcValidationError(
        IPC_CHANNELS.orders.list,
        'se esperaba {status?, strategyId?, ticker?, limit?, offset?}',
      );
    }
    return service.listOrders(query);
  });
  ipcMain.handle(IPC_CHANNELS.orders.cancel, (_event, request: unknown) => {
    if (!isCancelOrderRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.orders.cancel, 'se esperaba {id}');
    }
    return service.cancelOrder(request);
  });
  ipcMain.handle(IPC_CHANNELS.reconcile.run, () => service.reconcileRun());
  ipcMain.handle(IPC_CHANNELS.reconcile.status, () => service.reconcileStatus());
  ipcMain.handle(IPC_CHANNELS.deviation.report, (_event, query: unknown) => {
    if (!isDeviationReportQuery(query)) {
      throw new IpcValidationError(IPC_CHANNELS.deviation.report, 'se esperaba {period}');
    }
    return service.deviationReport(query);
  });

  // Ganchos del broker simulado: solo E2E y sin empaquetar (la app real no
  // los registra, mismo patrón que risk:simulate-* y news:poll-now).
  if (service.e2e !== null) {
    const hooks = service.e2e;
    ipcMain.handle(IPC_CHANNELS.broker.failNext, (_event, request: unknown) => {
      if (!isBrokerFailNextRequest(request)) {
        throw new IpcValidationError(IPC_CHANNELS.broker.failNext, 'se esperaba {kind}');
      }
      return hooks.failNext(request);
    });
    ipcMain.handle(IPC_CHANNELS.broker.createDiscrepancy, (_event, request: unknown) => {
      if (!isBrokerDiscrepancyRequest(request)) {
        throw new IpcValidationError(IPC_CHANNELS.broker.createDiscrepancy, 'se esperaba {kind}');
      }
      return hooks.createDiscrepancy(request);
    });
    ipcMain.handle(IPC_CHANNELS.broker.seedWeeks, (_event, request: unknown) => {
      if (!isBrokerSeedWeeksRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.broker.seedWeeks,
          'se esperaba {weeks?: 1-52} o nada',
        );
      }
      return hooks.seedWeeks(request);
    });
  }

  service.start();
  return service;
}
