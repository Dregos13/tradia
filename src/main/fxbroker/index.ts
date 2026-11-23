/**
 * Registro del bróker de divisas y oro (OANDA) en la app.
 *
 * Monta `createFxBrokerService` con las tablas de la migración 022, la
 * pasarela única del motor de riesgo (`services.risk.submitSignal`), la
 * puerta del modo real (`services.live.getChecklist().allComplete`), la
 * parada de emergencia y la conectividad; envuelve `ctx.broadcast` para
 * cerrar las posiciones de OANDA cuando salta la parada y registra los
 * canales `fx-broker:*`.
 *
 * En E2E (TRADIA_E2E sin empaquetar) el gancho `fx-broker:use-simulated`
 * sustituye OANDA por el servidor falso de `__fixtures__` (misma API,
 * sin red): el token y la cuenta que se conecten son los que acepta.
 */
import { app, ipcMain } from 'electron';

import type { FxBrokerCredentials, FxBrokerEnvironment } from '../../shared/fxBroker';
import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isFxBrokerConnectRequest,
  isFxCloseRequest,
  isFxConfirmLiveRequest,
  isFxEnvironment,
  isFxLimits,
  isFxOrderRequest,
  isFxSimulatedBrokerRequest,
  isFxTestOrderRequest,
} from '../../shared/ipc';
import {
  createOandaFakeServer,
  type OandaFakeServer,
} from '../broker/__fixtures__/oanda-fake-server';
import type { BrokerSecretsStore } from '../broker/index';
import { createOandaBroker, OANDA_BASE_URLS } from '../broker/oanda';
import { createBrokerRepository } from '../broker/repository';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { createFxBrokerService, type FxBrokerService } from './service';

export type { FxBrokerService } from './service';

const unavailableSecrets: BrokerSecretsStore = {
  setKey: () =>
    Promise.reject(new Error('El almacén de claves cifradas no está disponible en esta sesión.')),
  hasKey: () => Promise.resolve(false),
  deleteKey: () => Promise.resolve(),
  getKey: () => Promise.resolve(null),
};

export function registerFxBroker(ctx: ServiceContext): FxBrokerService {
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[fx-broker] almacén no disponible: las órdenes de divisas vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const memorySettings = new Map<string, string>();
  const settings = ctx.services.settings;
  const e2eEnabled = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);
  let simulated = false;
  const fakeServers = new Map<FxBrokerEnvironment, OandaFakeServer>();
  const liveGateOpen = (): boolean => ctx.services.live?.getChecklist().allComplete ?? false;

  const service = createFxBrokerService({
    secrets: ctx.services.secrets ?? unavailableSecrets,
    repositories: {
      practice: createBrokerRepository(db, { ordersTable: 'broker_orders_fx_practice' }),
      live: createBrokerRepository(db, { ordersTable: 'broker_orders_fx_live' }),
    },
    createAdapter: (environment, getCredentials) => {
      if (!simulated) {
        return createOandaBroker(environment, {
          fetch: globalThis.fetch,
          getCredentials,
          isLiveGateOpen: liveGateOpen,
          logger: console,
        });
      }
      // Bróker simulado: un servidor falso por entorno que acepta las
      // primeras credenciales que se conecten (como una cuenta recién
      // creada en OANDA) y rechaza cualquier otra después.
      const lazyFetch: typeof globalThis.fetch = async (input, init) => {
        let server = fakeServers.get(environment);
        if (!server) {
          const creds: FxBrokerCredentials | null = await getCredentials();
          server = createOandaFakeServer({
            baseUrl: OANDA_BASE_URLS[environment],
            token: creds?.token ?? '',
            accountId: creds?.accountId ?? '',
          });
          fakeServers.set(environment, server);
        }
        return server.fetch(input, init);
      };
      return createOandaBroker(environment, {
        fetch: lazyFetch,
        getCredentials,
        isLiveGateOpen: liveGateOpen,
      });
    },
    submitSignal: (intent) => ctx.services.risk?.submitSignal(intent) ?? null,
    isLiveGateOpen: liveGateOpen,
    isKillSwitchActive: () => ctx.services.killSwitch?.getState().active ?? false,
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
    settings: {
      get: (key) => (settings ? settings.getValue(key) : (memorySettings.get(key) ?? null)),
      set: (key, value) => {
        if (settings) settings.setValue(key, value);
        else memorySettings.set(key, value);
      },
    },
    isSimulated: () => simulated,
    recordJournal: (input) => ctx.services.journal?.record(input),
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    logger: console,
  });

  // La parada de emergencia cierra las posiciones de OANDA (las dos cuentas).
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.risk.changed) service.handleRiskChanged(payload);
  };

  const channels = IPC_CHANNELS.fxBroker;
  ipcMain.handle(channels.status, () => service.getStatus());
  ipcMain.handle(channels.connect, (_event, request: unknown) => {
    if (!isFxBrokerConnectRequest(request)) {
      throw new IpcValidationError(channels.connect, 'se esperaba {environment, token, accountId}');
    }
    return service.connect(request);
  });
  ipcMain.handle(channels.disconnect, (_event, environment: unknown) => {
    if (!isFxEnvironment(environment)) {
      throw new IpcValidationError(channels.disconnect, "se esperaba 'practice' o 'live'");
    }
    return service.disconnect(environment);
  });
  ipcMain.handle(channels.setLimits, (_event, limits: unknown) => {
    if (!isFxLimits(limits)) {
      throw new IpcValidationError(
        channels.setLimits,
        'se esperaba {capitalEur, riskPerOrderEur, dailyLossEur, openPositions}',
      );
    }
    return service.setLimits(limits);
  });
  ipcMain.handle(channels.confirmLive, (_event, request: unknown) => {
    if (!isFxConfirmLiveRequest(request)) {
      throw new IpcValidationError(channels.confirmLive, 'se esperaba {phrase}');
    }
    return service.confirmLive(request);
  });
  ipcMain.handle(channels.placeOrder, (_event, request: unknown) => {
    if (!isFxOrderRequest(request)) {
      throw new IpcValidationError(
        channels.placeOrder,
        'se esperaba {environment, instrument, side, size: {units}|{riskEur}, stopPrice, targetPrice}',
      );
    }
    return service.placeOrder(request);
  });
  ipcMain.handle(channels.closePosition, (_event, request: unknown) => {
    if (!isFxCloseRequest(request)) {
      throw new IpcValidationError(channels.closePosition, 'se esperaba {environment, instrument}');
    }
    return service.closePosition(request);
  });
  ipcMain.handle(channels.testOrder, (_event, request: unknown) => {
    if (!isFxTestOrderRequest(request)) {
      throw new IpcValidationError(channels.testOrder, 'se esperaba {environment, confirm: true}');
    }
    return service.runTestOrder(request);
  });
  ipcMain.handle(channels.reconcile, (_event, environment: unknown) => {
    if (!isFxEnvironment(environment)) {
      throw new IpcValidationError(channels.reconcile, "se esperaba 'practice' o 'live'");
    }
    return service.reconcile(environment);
  });

  if (e2eEnabled) {
    ipcMain.handle(channels.useSimulated, (_event, request: unknown) => {
      if (!isFxSimulatedBrokerRequest(request)) {
        throw new IpcValidationError(channels.useSimulated, 'se esperaba {enabled: boolean}');
      }
      simulated = request.enabled;
      fakeServers.clear();
      service.resetAdapters();
      return service.getStatus();
    });
  }

  void service.restore().catch((error: unknown) => {
    console.warn('[fx-broker] la restauración de las cuentas OANDA falló:', error);
  });
  return service;
}
