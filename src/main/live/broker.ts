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
 * - Una entrada en corto pasa además su puerta propia (límites del corto
 *   confirmados, cuenta con margen, título prestable, exposición a precio
 *   actual leída del broker, orden limitada y stop de compra de
 *   protección) — `orderGuard.ts`. La parada de emergencia recompra los
 *   cortos abiertos: su pérdida no tiene tope y no pueden quedar
 *   abiertos con el sistema parado.
 */
import {
  BROKER_ORDER_OPEN_STATUSES,
  type BrokerAccount,
  type BrokerOrder,
  type ReconcileDiscrepancyEvent,
} from '../../shared/broker';
import { IPC_CHANNELS, type RiskOverview } from '../../shared/ipc';
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
import { isBrokerError, type BrokerAdapter, type BrokerOrderRequest } from '../broker/types';
import { liveOrderBlockReason, liveOrderWirePrice, type LiveOrderSnapshot } from './orderGuard';
import { createLiveSmokeTest, type LiveSmokeTestService } from './smoke';
import type { ShortAccountReading } from './checklist';
import type { LiveService, LiveStore } from './service';

/** Sincronización de órdenes live con el broker: cada minuto (como paper). */
export const LIVE_SYNC_INTERVAL_MS = 60_000;

/**
 * Vigencia del retrato de la cuenta para el control del corto
 * (`checklist.short.account`): la lista se pide en cada render, así que
 * la lectura de `getAccount()` se amortigua — como mucho una llamada de
 * red por este intervalo, y solo con cuenta conectada.
 */
export const LIVE_ACCOUNT_CACHE_MS = 30_000;

/**
 * Espera máxima de la lectura de la cuenta: una `getAccount()` que
 * agota el tiempo deja el control en 'revisar' (nunca bloquea la lista
 * ni se asume permiso).
 */
export const LIVE_ACCOUNT_READ_TIMEOUT_MS = 5_000;

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
  /**
   * Espera máxima de la lectura de la cuenta para el control del corto
   * (ms); por defecto `LIVE_ACCOUNT_READ_TIMEOUT_MS`.
   */
  accountReadTimeoutMs?: number;
  /**
   * Vigencia del retrato de la cuenta antes de releerlo (ms); por
   * defecto `LIVE_ACCOUNT_CACHE_MS`.
   */
  accountCacheMs?: number;
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
   * Último retrato de la cuenta live para el control del corto
   * (`checklist.short.account`): devuelve la caché al instante y, si
   * está vieja, relanza la lectura de `getAccount()` en segundo plano
   * (nunca espera a la red). null sin cuenta conectada o sin lectura.
   */
  shortAccount(): ShortAccountReading | null;
  /**
   * `live:smoke-test`: compra de mercado fraccionaria de 1 USD en SPY,
   * venta de cierre y conciliación contra la cuenta conectada, con el
   * resultado persistido y un paso a paso en el Diario. Falla → suspende.
   */
  runSmokeTest(request: LiveSmokeTestRequest): Promise<LiveSmokeTestResult>;
  /** Entrada del evento `signals:new` (envoltura de broadcast). */
  handleSignalEvent(payload: unknown): Promise<void>;
  /**
   * Evento `risk:changed`: con la parada de emergencia activa recompra
   * los cortos abiertos (un corto no puede quedar abierto con el
   * sistema parado: su pérdida no tiene tope).
   */
  handleRiskChanged(payload: unknown): void;
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
  // Retrato de la cuenta para el control del corto: la lista lo pide en
  // cada render, así que se conserva en caché y se relee en segundo
  // plano como mucho una vez por `accountCacheMs` (nunca una llamada de
  // red por lectura). `attach` lo siembra con la cuenta validada y
  // `detach` lo limpia: sin adaptador el control queda 'revisar'.
  let accountCache: {
    account: Pick<BrokerAccount, 'paper' | 'shortingEnabled' | 'equity'> | null;
    readError: boolean;
    checkedAt: string;
  } | null = null;
  let accountRefresh: Promise<unknown> | null = null;
  let lastAccountAttemptAt = Number.NEGATIVE_INFINITY;
  const accountCacheMs = Math.max(0, deps.accountCacheMs ?? LIVE_ACCOUNT_CACHE_MS);
  const accountReadTimeoutMs = Math.max(
    1,
    deps.accountReadTimeoutMs ?? LIVE_ACCOUNT_READ_TIMEOUT_MS,
  );

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

  // -- Retrato de la cuenta para el control del corto -------------------------

  /** `getAccount()` con espera máxima: agotarla cuenta como lectura fallida. */
  const readAccountWithTimeout = (candidate: BrokerAdapter): Promise<BrokerAccount> => {
    let timer: TimerHandle | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimer(
        () => reject(new Error('tiempo de espera agotado leyendo la cuenta')),
        accountReadTimeoutMs,
      );
    });
    return Promise.race([candidate.getAccount(), timeout]).finally(() => {
      if (timer !== null) clearTimer(timer);
    });
  };

  const snapshotAccount = (
    account: BrokerAccount,
  ): Pick<BrokerAccount, 'paper' | 'shortingEnabled' | 'equity'> => ({
    paper: account.paper,
    shortingEnabled: account.shortingEnabled ?? null,
    equity: account.equity,
  });

  /**
   * Relee la cuenta en segundo plano y deja el retrato en la caché.
   * Solo escribe si el adaptador sigue siendo el mismo (una desconexión
   * a medio camino no puede revivir datos de la cuenta anterior). Al
   * terminar emite `live:changed` para que la franja y la lista ya
   * reflejen la última lectura sin esperar al siguiente render.
   */
  const refreshAccount = (candidate: BrokerAdapter): void => {
    lastAccountAttemptAt = now();
    accountRefresh = readAccountWithTimeout(candidate)
      .then((account) => {
        if (adapter !== candidate) return;
        accountCache = {
          account: snapshotAccount(account),
          readError: false,
          checkedAt: isoNow(),
        };
      })
      .catch((error: unknown) => {
        if (adapter !== candidate) return;
        logger.warn?.(
          `[live-broker] la lectura de la cuenta para la lista falló: ${errorMessage(error)}`,
        );
        accountCache = { account: null, readError: true, checkedAt: isoNow() };
      })
      .then(() => emitChanged())
      .catch((error: unknown) => {
        logger.warn?.(
          `[live-broker] no se pudo emitir el cambio tras leer la cuenta: ${errorMessage(error)}`,
        );
      })
      .finally(() => {
        accountRefresh = null;
      });
  };

  /**
   * Último retrato de la cuenta (lo consume la lista del modo real):
   * devuelve la caché al instante y relanza la lectura en segundo plano
   * cuando está vieja — sin esperar a la red ni llamarla en cada render.
   */
  const shortAccountReading = (): ShortAccountReading | null => {
    if (adapter !== null && !stopped && accountRefresh === null) {
      if (now() - lastAccountAttemptAt >= accountCacheMs) refreshAccount(adapter);
    }
    if (accountCache === null) return null;
    return {
      paper: accountCache.account?.paper ?? null,
      shortingEnabled: accountCache.account?.shortingEnabled ?? null,
      equityUsd:
        accountCache.account !== null && Number.isFinite(accountCache.account.equity)
          ? accountCache.account.equity
          : null,
      readError: accountCache.readError,
      checkedAt: accountCache.checkedAt,
    };
  };

  /**
   * Lectura local de la exposición real para la guarda de techos:
   * posiciones abiertas con su lado (`positionsFromOrders` sobre
   * `broker_orders_live`), nocional de las compras y de las ventas de
   * entrada aún abiertas, y la pérdida realizada en la sesión de Nueva
   * York de hoy (con el signo del lado de la entrada, así que las
   * pérdidas en corto cuentan igual que las de largo). Los datos del
   * broker (cuenta, prestabilidad del título y exposición corta al
   * precio actual) los añade `orderSnapshot` solo cuando hace falta.
   */
  const localSnapshot = (): LiveOrderSnapshot => {
    const all = deps.repository.listOrders();
    const positions = positionsFromOrders(all);
    const positionUsd = positions.reduce(
      (sum, position) => sum + position.quantity * position.avgEntryPrice,
      0,
    );
    const openStatuses = new Set<string>(BROKER_ORDER_OPEN_STATUSES);
    const pending = all.filter(
      (order) => openStatuses.has(order.status) && order.filledQuantity < order.quantity,
    );
    const pendingUsd = pending
      .filter((order) => order.side === 'buy' && order.leg !== 'salida')
      .reduce((sum, order) => {
        const price = order.limitPrice ?? order.execution.requestedPrice;
        if (price === null || !(price > 0)) return sum;
        return sum + (order.quantity - order.filledQuantity) * price;
      }, 0);
    // Las ventas de entrada aún abiertas sobre un ticker sin largo son
    // cortos pendientes de ejecutar: cuentan para la exposición futura.
    const longTickers = new Set(positions.filter((p) => p.side === 'long').map((p) => p.ticker));
    const pendingShortUsd = pending
      .filter(
        (order) =>
          order.side === 'sell' && order.leg !== 'salida' && !longTickers.has(order.ticker),
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
            shortOrderUsd: limitsRow.corto_orden_usd,
            shortExposureUsd: limitsRow.corto_exposicion_usd,
            shortPositions: limitsRow.corto_posiciones_max,
          }
        : null;

    // Los requisitos propios del corto se evalúan con la lista: sin
    // ellos la guarda rechaza toda entrada en corto real con
    // «[corto-requisitos] …», aunque los límites sigan confirmados. Un
    // estado desconocido bloquea por conservador (el corto nunca se
    // asume permitido).
    const shortCheck = deps.live.getChecklist().short as
      { allComplete: boolean; blockReason: string | null } | undefined;
    const shortRequirementsBlockReason =
      shortCheck !== undefined && shortCheck.allComplete
        ? null
        : (shortCheck?.blockReason ??
          'los requisitos propios del corto con dinero real no están cumplidos');

    return {
      mode: deps.store.getMode().estado,
      limits,
      openPositions: positions.map((position) => ({
        ticker: position.ticker,
        side: position.side,
        quantity: position.quantity,
      })),
      shortExposureUsd: null,
      pendingShortUsd,
      accountShorting: null,
      asset: null,
      capitalInUseUsd: positionUsd + pendingUsd,
      realizedLossTodayUsd,
      shortRequirementsBlockReason,
    };
  };

  /**
   * Snapshot completo con lectura del broker para la guarda: solo se
   * consulta la red cuando la orden podría abrir o ampliar un corto
   * (venta sobre un ticker sin largo en cartera). Una lectura que falla
   * deja el dato en null y la guarda rechaza el corto con motivo claro.
   */
  const orderSnapshot = async (request: BrokerOrderRequest): Promise<LiveOrderSnapshot> => {
    const snapshot = localSnapshot();
    const position = snapshot.openPositions.find(
      (p) => p.ticker === request.ticker.trim().toUpperCase(),
    );
    if (request.side !== 'sell' || position?.side === 'long' || adapter === null) {
      return snapshot;
    }
    const candidate = adapter;
    try {
      const account = await candidate.getAccount();
      snapshot.accountShorting = account.shortingEnabled ?? null;
    } catch (error: unknown) {
      logger.warn?.(
        `[live-broker] no se pudo leer la cuenta para la puerta del corto: ${errorMessage(error)}`,
      );
    }
    try {
      const read = candidate.getAsset ? await candidate.getAsset(request.ticker) : null;
      snapshot.asset =
        read === null ? null : { shortable: read.shortable, easyToBorrow: read.easyToBorrow };
    } catch (error: unknown) {
      logger.warn?.(
        `[live-broker] no se pudo leer el activo ${request.ticker} para la puerta del corto: ${errorMessage(error)}`,
      );
    }
    try {
      const remote = await candidate.listPositions();
      // La exposición corta va valorada al precio actual: el broker la da
      // como marketValue (negativo en Alpaca para cortos); si no la trae,
      // se aproxima con el precio medio de entrada.
      snapshot.shortExposureUsd = remote
        .filter((p) => p.side === 'short')
        .reduce((sum, p) => sum + Math.abs(p.marketValue ?? p.avgEntryPrice * p.quantity), 0);
    } catch (error: unknown) {
      logger.warn?.(
        `[live-broker] no se pudo leer la exposición del broker para la puerta del corto: ${errorMessage(error)}`,
      );
    }
    return snapshot;
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
      checkOrderAllowed: async (request, context) =>
        liveOrderBlockReason(await orderSnapshot(request), request, context),
      orderWirePrice: (request, context) => liveOrderWirePrice(localSnapshot(), request, context),
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
    // La cuenta recién validada siembra el retrato del control del
    // corto: la lista lo ve de inmediato sin una lectura extra.
    accountCache = {
      account: snapshotAccount(account),
      readError: false,
      checkedAt: isoNow(),
    };
    lastAccountAttemptAt = now();
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
    // Sin cuenta live no hay nada que comprobar: el control del corto
    // queda 'revisar' (una lectura en curso que llegue tarde no escribe
    // gracias a la comprobación de adaptador vigente).
    accountCache = null;
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
      liveOrderBlockReason(localSnapshot(), request, context),
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
    accountCache = null;
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
            shortOrderUsd: limitsRow.corto_orden_usd,
            shortExposureUsd: limitsRow.corto_exposicion_usd,
            shortPositions: limitsRow.corto_posiciones_max,
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

  /**
   * La parada de emergencia recompra los cortos abiertos: la pérdida en
   * corto no tiene tope natural, así que ningún corto real puede quedar
   * abierto mientras el sistema está parado. Cancela primero las órdenes
   * abiertas del ticker —su OCO de salida volvería a comprar si se dejara
   * vivo— y envía la recompra a mercado directamente al adaptador: un
   * cierre de riesgo no pasa por la guarda de techos ni por la puerta
   * del gestor (la parada las bloquea a todas). Cada paso queda en el
   * Diario; un fallo se registra y se sigue con el siguiente corto.
   */
  const coverOpenShorts = async (cause: string): Promise<void> => {
    const candidate = adapter;
    if (candidate === null || stopped) return;
    const all = deps.repository.listOrders();
    const shorts = positionsFromOrders(all).filter(
      (position) => position.side === 'short' && position.quantity > 0,
    );
    if (shorts.length === 0) return;
    const openStatuses = new Set<string>(BROKER_ORDER_OPEN_STATUSES);
    for (const position of shorts) {
      // Las órdenes abiertas del ticker quedan fuera primero: el OCO de
      // salida del corto es una compra que, si viviera, abriría un largo
      // al ejecutarse sobre una posición ya cerrada.
      for (const order of all.filter(
        (o) => o.ticker === position.ticker && openStatuses.has(o.status),
      )) {
        try {
          if (order.brokerOrderId !== null) {
            await candidate.cancelOrder(order.brokerOrderId);
          }
          deps.repository.updateOrder(order.id, { status: 'cancelada' }, isoNow());
        } catch (error: unknown) {
          logger.warn?.(
            `[live-broker] no se pudo cancelar ${order.clientOrderId} al recomprar el corto: ${errorMessage(error)}`,
          );
        }
      }
      // La pata va marcada 'salida' con la señal de su entrada (si consta)
      // para que la operación cerrada se empareje y la pérdida en corto
      // cuente en la pérdida diaria realizada.
      const entryOrder = [...all]
        .reverse()
        .find((o) => o.ticker === position.ticker && o.leg === 'entrada' && o.signalId !== null);
      const clientOrderId = `tradia-parada-corto-${position.ticker}-${now()}`;
      const { order } = deps.repository.insertOrder({
        clientOrderId,
        signalId: entryOrder?.signalId ?? null,
        strategyId: entryOrder?.strategyId ?? null,
        leg: 'salida',
        ticker: position.ticker,
        type: 'market',
        side: 'buy',
        quantity: position.quantity,
        requestedAt: isoNow(),
        status: 'pendiente',
        attempts: 1,
      });
      try {
        const remote = await candidate.submitOrder({
          clientOrderId,
          ticker: position.ticker,
          type: 'market',
          side: 'buy',
          quantity: position.quantity,
          timeInForce: 'day',
        });
        const updated = deps.repository.updateOrder(
          order.id,
          {
            brokerOrderId: remote.brokerOrderId,
            status: remote.status,
            filledQuantity: remote.filledQuantity,
            executedAt: remote.filledAt,
            executedPrice: remote.filledAvgPrice,
          },
          isoNow(),
        );
        deps.emitOrderUpdated?.(updated);
        journal({
          type: 'limite',
          ticker: position.ticker,
          result: 'completado',
          reason:
            `Parada de emergencia (${cause}): recompra del corto de ` +
            `${position.quantity} uds de ${position.ticker} ` +
            `(${remote.status === 'ejecutada' ? 'ejecutada' : `enviada, estado ${remote.status}`}).`,
          dataUsed: {
            clientOrderId,
            brokerOrderId: remote.brokerOrderId,
            cantidad: position.quantity,
          },
        });
      } catch (error: unknown) {
        deps.repository.updateOrder(
          order.id,
          { status: 'rechazada', rejectReason: errorMessage(error), attempts: 1 },
          isoNow(),
        );
        deps.emitOrderUpdated?.(order);
        journal({
          type: 'error',
          ticker: position.ticker,
          result: 'error',
          reason: `No se pudo recomprar el corto de ${position.ticker} tras la parada de emergencia.`,
          errors: [errorMessage(error)],
          dataUsed: { clientOrderId, cantidad: position.quantity },
        });
        logger.warn?.(
          `[live-broker] la recompra del corto de ${position.ticker} falló: ${errorMessage(error)}`,
        );
      }
    }
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

    shortAccount: shortAccountReading,

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

    handleRiskChanged: (payload) => {
      const overview = payload as RiskOverview | null | undefined;
      if (
        overview !== null &&
        typeof overview === 'object' &&
        overview.killSwitch?.active === true
      ) {
        void coverOpenShorts(`causa: ${overview.killSwitch.cause ?? 'desconocida'}`).catch(
          (error: unknown) => {
            logger.warn?.(
              `[live-broker] la recompra de cortos tras la parada falló: ${errorMessage(error)}`,
            );
          },
        );
      }
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
