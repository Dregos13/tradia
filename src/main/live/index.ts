/**
 * Registro del servicio del modo real (fase 7) en la app.
 *
 * `registerLive` monta `createLiveService` con el almacén de la migración
 * 011, la evidencia en settings y las fuentes del resto de dominios
 * (estrategias y pruebas finales por SQL, órdenes del broker, expectativa
 * del último backtest, canales de entrega, parada, claves live, diario y
 * notificaciones), envuelve `ctx.broadcast` para suspender el modo real
 * al saltar la parada o perder la conexión, y registra los canales
 * `live:*` de esta tarea.
 *
 * Además monta `createLiveBrokerService` (live/broker.ts): el broker
 * real con su ranura de claves separada, la puerta de la lista y los
 * techos por orden sobre `broker_orders_live` (migración 012). Las
 * señales aprobadas se ejecutan en la cuenta real solo cuando
 * `liveExecutionActive()` —modo 'activo' y cuenta conectada—; el broker
 * paper se las cede (`isLiveExecution` en broker/index.ts).
 *
 * Canales cubiertos aquí: checklist, state, declare, set-limits,
 * activate, deactivate, test-kill-switch, connect, smoke-test, scaling,
 * el gancho E2E seed-progress y el conmutador E2E use-simulated-broker.
 */
import { app, ipcMain } from 'electron';

import {
  BROKER_ORDERS_MAX_LIMIT,
  IPC_CHANNELS,
  IpcValidationError,
  isDeliveryConfigInput,
  isE2eEnabled,
  isLiveActivateRequest,
  isLiveConnectRequest,
  isLiveDeclareRequest,
  isLiveLimitsInput,
  isLiveSeedProgressRequest,
  isLiveSimulatedBrokerRequest,
  isLiveSmokeTestRequest,
} from '../../shared/ipc';
import { DEVIATION_MARGIN_PP_DEFAULT, DEVIATION_SLIPPAGE_BPS_DEFAULT } from '../../shared/broker';
import { LIVE_BROKER_SECRET_KEYS } from '../../shared/live';
import { createAlpacaLiveBroker } from '../broker/alpacaLive';
import { expectationFromReport } from '../broker/deviation';
import type { BrokerSecretsStore } from '../broker/index';
import { createBrokerRepository } from '../broker/repository';
import { createAlpacaLiveFakeFetch } from '../broker/__fixtures__/fake-server';
import { openDatabase } from '../db/database';
import { DELIVERY_CONFIG_KEY } from '../delivery';
import { createMarketRepository } from '../market/repository';
import type { ServiceContext } from '../services';
import { createLiveBrokerService, type LiveBrokerService } from './broker';
import { DELIVERY_TEST_EVIDENCE_KEY, type AlertTestEvidence } from './checklist';
import { computeLiveScalingStatus } from './scaling';
import {
  createLiveEvidenceStore,
  createLiveService,
  createLiveStore,
  type LiveService,
} from './service';

export type { LiveService } from './service';
export type { LiveBrokerService } from './broker';

/**
 * Lo que `registerLive` devuelve y `services.live` publica: el servicio
 * de la lista y del modo, más el broker real y el conmutador que decide
 * si las señales se ejecutan en real (el broker paper lo consulta).
 */
export interface LiveServices extends LiveService {
  /** Broker real: conexión, claves live y ejecución con techos. */
  readonly broker: LiveBrokerService;
  /** true con modo 'activo' y cuenta live conectada (señales → real). */
  liveExecutionActive(): boolean;
}

const DELIVERY_TESTABLE_CHANNELS = ['telegram', 'correo'] as const;

const isAlertTestEvidence = (value: unknown): value is AlertTestEvidence => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.channel === 'string' &&
    (DELIVERY_TESTABLE_CHANNELS as readonly string[]).includes(v.channel) &&
    typeof v.at === 'string' &&
    v.at.length > 0
  );
};

/** Almacén de claves para cuando `services.secrets` no está disponible. */
const unavailableSecrets: BrokerSecretsStore = {
  setKey: () =>
    Promise.reject(new Error('El almacén de claves cifradas no está disponible en esta sesión.')),
  hasKey: () => Promise.resolve(false),
  deleteKey: () => Promise.resolve(),
  getKey: () => Promise.resolve(null),
};

export interface RegisterLiveOptions {
  /**
   * Reloj de mercado (el mismo anclado con el que se ingieren las
   * velas): la prueba de humo lo usa para juzgar la frescura de la
   * referencia. Por defecto el tiempo real.
   */
  marketNow?: () => number;
}

export function registerLive(ctx: ServiceContext, options?: RegisterLiveOptions): LiveServices {
  // Mismo patrón que registerKillSwitch: sin base de datos el servicio
  // degrada a memoria y la app sigue arrancando.
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[live] almacén no disponible: la lista del modo real vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const settings = ctx.services.settings;
  const store = createLiveStore(db);
  // Las órdenes reales viven aisladas de las paper (migración 012): ni la
  // conciliación ni la muestra de «paper continuo» las mezclan.
  const liveRepository = createBrokerRepository(db, { ordersTable: 'broker_orders_live' });
  const secrets = ctx.services.secrets ?? unavailableSecrets;
  // Referencia de precio para la prueba de humo (misma fuente que el
  // resto del dominio: las velas ingeridas de la watchlist).
  const marketRepo = createMarketRepository(db);
  // Los ganchos E2E existen solo con TRADIA_E2E y sin empaquetar; la
  // evidencia sembrada en settings solo cuenta en ese mismo contexto.
  const e2eEnabled = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);
  /** Último cierre ingerido del ticker con la fecha de su vela. */
  const lastClose = (ticker: string): { price: number; asOf: string } | null => {
    const lastDate = marketRepo.lastBarDate(ticker);
    if (lastDate === null) return null;
    const close = marketRepo.getBars(ticker, { desde: lastDate, hasta: lastDate }).at(-1)?.close;
    return close === undefined || close === null ? null : { price: close, asOf: lastDate };
  };

  const service = createLiveService({
    store,
    evidence: createLiveEvidenceStore(
      settings ? (key) => settings.getValue(key) : undefined,
      settings ? (key, value) => settings.setValue(key, value) : undefined,
    ),
    // Fuera del contexto E2E la evidencia de settings no cuenta: una
    // copia restaurada o una edición a mano no cumple requisitos.
    allowSeededEvidence: () => e2eEnabled,
    listExecutedOrders: () => {
      const broker = ctx.services.broker;
      if (!broker) return [];
      const orders = [];
      let offset = 0;
      for (;;) {
        const page = broker.listOrders({
          status: 'ejecutada',
          // La muestra de «paper continuo» de la lista solo mide la
          // cuenta paper: orders:list une las reales desde la fase 7.
          mode: 'paper',
          limit: BROKER_ORDERS_MAX_LIMIT,
          offset,
        });
        orders.push(...page);
        if (page.length < BROKER_ORDERS_MAX_LIMIT) return orders;
        offset += BROKER_ORDERS_MAX_LIMIT;
      }
    },
    expectationFor: (strategyId) => {
      const backtest = ctx.services.backtest;
      if (!backtest) return { perTradeReturnPct: null };
      const latest = backtest.listRuns({ strategyId, limit: 1 })[0];
      return expectationFromReport(latest === undefined ? null : backtest.getRun(latest.id));
    },
    alertChannels: () => {
      const raw = settings?.getValue(DELIVERY_CONFIG_KEY);
      if (raw === null || raw === undefined) return [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isDeliveryConfigInput(parsed)) return [];
        return [
          {
            channel: 'telegram',
            enabled: parsed.telegram.enabled,
            configured: parsed.telegram.chatId.trim().length > 0,
          },
          {
            channel: 'correo',
            enabled: parsed.email.enabled,
            configured:
              parsed.email.host.trim().length > 0 &&
              parsed.email.to.trim().length > 0 &&
              parsed.email.user.trim().length > 0,
          },
        ];
      } catch {
        return [];
      }
    },
    alertTest: () => {
      const raw = settings?.getValue(DELIVERY_TEST_EVIDENCE_KEY);
      if (raw === null || raw === undefined) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isAlertTestEvidence(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    // Indirección perezosa: la parada se registra antes en initServices,
    // pero el servicio no debe acoplar su orden de arranque.
    killSwitch: ctx.services.killSwitch
      ? {
          getState: () => ctx.services.killSwitch!.getState(),
          activate: (cause, actor, detail) =>
            ctx.services.killSwitch!.activate(cause, actor, detail),
          resume: (request) => ctx.services.killSwitch!.resume(request),
        }
      : undefined,
    hasLiveCredentials: () => secrets.hasKey(LIVE_BROKER_SECRET_KEYS.apiKeyId),
    recordJournal: (input) => ctx.services.journal?.record(input),
    notify: (payload) => ctx.services.notifications?.notify(payload),
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    logger: console,
  });

  // La puerta del modo real: la lista completa, evaluada en el proceso
  // principal en cada construcción del adaptador y en cada envío.
  const liveGateOpen = (): boolean => service.getChecklist().allComplete;

  const liveBroker = createLiveBrokerService({
    live: service,
    store,
    repository: liveRepository,
    secrets,
    createAdapter: (getCredentials) =>
      createAlpacaLiveBroker({
        fetch: globalThis.fetch,
        getCredentials,
        isLiveGateOpen: liveGateOpen,
      }),
    // Solo E2E y sin empaquetar: el adaptador live contra el servidor
    // falso de __fixtures__ (misma API, mismo contrato, sin red). La
    // cuenta falsa arranca sin posiciones para que la prueba de humo
    // (compra + cierre) quede plana y concilie sin descuadres. Ejecuta
    // al último cierre ingerido, como haría un broker real al contado:
    // así el slippage frente a la referencia es el honesto (≈ 0).
    createSimulatedAdapter: e2eEnabled
      ? (getCredentials) =>
          createAlpacaLiveBroker({
            fetch: createAlpacaLiveFakeFetch({
              positions: [],
              priceFor: (ticker) => lastClose(ticker)?.price,
            }),
            getCredentials,
            isLiveGateOpen: liveGateOpen,
          })
      : undefined,
    isKillSwitchActive: () => ctx.services.killSwitch?.getState().active ?? false,
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
    getSignal: (id) => ctx.services.signals?.engine.getSignal(id) ?? null,
    recordJournal: (input) => ctx.services.journal?.record(input),
    emitOrderUpdated: (order) => ctx.broadcast(IPC_CHANNELS.broker.orderUpdated, order),
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    // Precio de referencia de la prueba de humo: el último cierre
    // ingerido del ticker con la fecha de su vela (la prueba exige una
    // referencia reciente, juzgada con el reloj de mercado). Sin velas
    // guardadas no hay compra dimensionable.
    referencePrice: lastClose,
    marketNow: options?.marketNow,
    sendEvent: (kind, message) => ctx.services.delivery?.sendEvent(kind, message),
    emitDiscrepancy: (event) => ctx.broadcast(IPC_CHANNELS.reconcile.discrepancy, event),
    logger: console,
  });

  // La parada (`risk:changed`), la pérdida de conexión y las señales
  // aprobadas llegan por la envoltura de ctx.broadcast (mismo patrón que
  // broker/delivery). Las señales solo pasan al gestor live cuando el
  // modo real está 'activo' y la cuenta conectada.
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.risk.changed) service.handleRiskChanged(payload);
    else if (channel === IPC_CHANNELS.connectivity.changed) {
      service.handleConnectivityChange(payload);
    } else if (channel === IPC_CHANNELS.signals.new) {
      liveBroker.handleSignalEvent(payload);
    }
  };

  ipcMain.handle(IPC_CHANNELS.live.checklist, () => service.getChecklist());
  ipcMain.handle(IPC_CHANNELS.live.state, () => service.getState());
  ipcMain.handle(IPC_CHANNELS.live.declare, (_event, request: unknown) => {
    if (!isLiveDeclareRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.live.declare,
        'se esperaba {requirement: declaración, confirmed: boolean, detail?}',
      );
    }
    return service.declare(request);
  });
  ipcMain.handle(IPC_CHANNELS.live.setLimits, (_event, input: unknown) => {
    if (!isLiveLimitsInput(input)) {
      throw new IpcValidationError(
        IPC_CHANNELS.live.setLimits,
        'se esperaba {capitalUsd, orderUsd, dailyLossUsd, openPositions} dentro de los techos fijos',
      );
    }
    return service.setLimits(input);
  });
  ipcMain.handle(IPC_CHANNELS.live.connect, (_event, request: unknown) => {
    if (!isLiveConnectRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.live.connect,
        'se esperaba {apiKeyId, apiSecret} de una cuenta live (prefijo «AK»)',
      );
    }
    return liveBroker.connect(request);
  });
  ipcMain.handle(IPC_CHANNELS.live.activate, (_event, request: unknown) => {
    if (!isLiveActivateRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.live.activate, 'se esperaba {phrase}');
    }
    return service.activate(request);
  });
  ipcMain.handle(IPC_CHANNELS.live.deactivate, () => service.deactivate());
  ipcMain.handle(IPC_CHANNELS.live.testKillSwitch, () => service.testKillSwitch());
  ipcMain.handle(IPC_CHANNELS.live.smokeTest, (_event, request: unknown) => {
    if (!isLiveSmokeTestRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.live.smokeTest,
        'se esperaba {confirm: true}: la prueba usa dinero real',
      );
    }
    return liveBroker.runSmokeTest(request);
  });
  // Estado del escalado: lectura informativa sobre broker_orders_live;
  // en esta fase nunca ofrece acción para subir los techos.
  ipcMain.handle(IPC_CHANNELS.live.scaling, () =>
    computeLiveScalingStatus({
      repository: liveRepository,
      store,
      expectationFor: (strategyId) => {
        const backtest = ctx.services.backtest;
        if (!backtest) return expectationFromReport(null);
        const latest = backtest.listRuns({ strategyId, limit: 1 })[0];
        return expectationFromReport(
          latest === undefined ? null : (backtest.getRun(latest.id) ?? null),
        );
      },
      strategyNameFor: (strategyId) =>
        ctx.services.strategies?.get(strategyId)?.name ?? `Estrategia ${strategyId}`,
      margins: () => {
        const current = ctx.services.settings?.get();
        return {
          marginPp: current?.deviationMarginPp ?? DEVIATION_MARGIN_PP_DEFAULT,
          maxSlippageBps: current?.deviationSlippageBps ?? DEVIATION_SLIPPAGE_BPS_DEFAULT,
        };
      },
    }),
  );

  // Ganchos E2E: siembra la evidencia de los requisitos automáticos y
  // conmuta el adaptador live al broker real simulado. En la app
  // empaquetada los handlers no existen (isE2eEnabled los descarta).
  if (e2eEnabled) {
    ipcMain.handle(IPC_CHANNELS.live.seedProgress, (_event, request: unknown) => {
      if (!isLiveSeedProgressRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.live.seedProgress,
          'se esperaba {paperMonths?, paperTrades?, deviationPct?, finalTestDone?, killSwitchTested?, alertsTested?} o nada',
        );
      }
      return service.seedProgress(request);
    });
    ipcMain.handle(IPC_CHANNELS.live.useSimulatedBroker, (_event, request: unknown) => {
      if (!isLiveSimulatedBrokerRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.live.useSimulatedBroker,
          'se esperaba {enabled: boolean}',
        );
      }
      return liveBroker.useSimulatedBroker(request.enabled);
    });
  }

  // Con claves guardadas y la lista vigente la cuenta real reconecta
  // sola (mismo patrón que el broker paper).
  void liveBroker.restore().catch((error: unknown) => {
    console.warn('[live] la restauración de la cuenta real falló:', error);
  });

  return {
    ...service,
    broker: liveBroker,
    liveExecutionActive: () => liveBroker.liveExecutionActive(),
  };
}
