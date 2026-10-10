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
 * Canales cubiertos aquí: checklist, state, declare, set-limits,
 * activate, deactivate, test-kill-switch y el gancho E2E seed-progress.
 * `live:connect`, `live:smoke-test`, `live:scaling` y
 * `live:use-simulated-broker` los registran sus propias tareas
 * (be-broker-real y be-prueba-humo-escalado).
 */
import { app, ipcMain } from 'electron';

import {
  BROKER_ORDERS_MAX_LIMIT,
  IPC_CHANNELS,
  IpcValidationError,
  isDeliveryConfigInput,
  isE2eEnabled,
  isLiveActivateRequest,
  isLiveDeclareRequest,
  isLiveLimitsInput,
  isLiveSeedProgressRequest,
} from '../../shared/ipc';
import {
  LIVE_BROKER_SECRET_KEYS,
  type LiveActivateRequest,
  type LiveDeclareRequest,
  type LiveLimitsInput,
  type LiveSeedProgressRequest,
} from '../../shared/live';
import { expectationFromReport } from '../broker/deviation';
import { openDatabase } from '../db/database';
import { DELIVERY_CONFIG_KEY } from '../delivery';
import type { ServiceContext } from '../services';
import { DELIVERY_TEST_EVIDENCE_KEY, type AlertTestEvidence } from './checklist';
import {
  createLiveEvidenceStore,
  createLiveService,
  createLiveStore,
  type LiveService,
} from './service';

export type { LiveService } from './service';

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

export function registerLive(ctx: ServiceContext): LiveService {
  // Mismo patrón que registerKillSwitch: sin base de datos el servicio
  // degrada a memoria y la app sigue arrancando.
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[live] almacén no disponible: la lista del modo real vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const settings = ctx.services.settings;

  const service = createLiveService({
    store: createLiveStore(db),
    evidence: createLiveEvidenceStore(
      settings ? (key) => settings.getValue(key) : undefined,
      settings ? (key, value) => settings.setValue(key, value) : undefined,
    ),
    listExecutedOrders: () => {
      const broker = ctx.services.broker;
      if (!broker) return [];
      const orders = [];
      let offset = 0;
      for (;;) {
        const page = broker.listOrders({
          status: 'ejecutada',
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
    hasLiveCredentials: () =>
      ctx.services.secrets?.hasKey(LIVE_BROKER_SECRET_KEYS.apiKeyId) ??
      Promise.resolve(false),
    recordJournal: (input) => ctx.services.journal?.record(input),
    notify: (payload) => ctx.services.notifications?.notify(payload),
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    logger: console,
  });

  // La parada (`risk:changed`) y la pérdida de conexión suspenden el modo
  // real al instante: envoltura de ctx.broadcast como en broker/delivery.
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.risk.changed) service.handleRiskChanged(payload);
    else if (channel === IPC_CHANNELS.connectivity.changed) {
      service.handleConnectivityChange(payload);
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
    return service.declare(request as LiveDeclareRequest);
  });
  ipcMain.handle(IPC_CHANNELS.live.setLimits, (_event, input: unknown) => {
    if (!isLiveLimitsInput(input)) {
      throw new IpcValidationError(
        IPC_CHANNELS.live.setLimits,
        'se esperaba {capitalUsd, orderUsd, dailyLossUsd, openPositions} dentro de los techos fijos',
      );
    }
    return service.setLimits(input as LiveLimitsInput);
  });
  ipcMain.handle(IPC_CHANNELS.live.activate, (_event, request: unknown) => {
    if (!isLiveActivateRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.live.activate, 'se esperaba {phrase}');
    }
    return service.activate(request as LiveActivateRequest);
  });
  ipcMain.handle(IPC_CHANNELS.live.deactivate, () => service.deactivate());
  ipcMain.handle(IPC_CHANNELS.live.testKillSwitch, () => service.testKillSwitch());

  // Gancho E2E: siembra la evidencia de los requisitos automáticos. En la
  // app empaquetada el handler no existe (isE2eEnabled la descarta).
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.live.seedProgress, (_event, request: unknown) => {
      if (!isLiveSeedProgressRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.live.seedProgress,
          'se esperaba {paperMonths?, paperTrades?, deviationPct?, finalTestDone?, killSwitchTested?, alertsTested?} o nada',
        );
      }
      return service.seedProgress(request as LiveSeedProgressRequest | undefined);
    });
  }

  return service;
}
