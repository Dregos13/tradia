import { ipcMain } from 'electron';

import { IPC_CHANNELS, type ConnectivityState } from '../../shared/ipc';
import type { ServiceContext } from './index';

/**
 * Vigilancia de conexión — stub.
 *
 * La tarea «connectivity-service» lo implementa: net.isOnline + peticiones
 * ligeras a dos URL configurables, espera exponencial con fluctuación
 * (2 s → 5 min), eventos powerMonitor, pausa de decisiones vía
 * `scheduler.pauseDecisions('sin-conexion')`, notificación al perder y
 * recuperar la conexión, y modo de simulación TRADIA_SIMULATE_OFFLINE.
 */
export interface ConnectivityService {
  getState(): ConnectivityState;
  checkNow(): Promise<ConnectivityState>;
  start(): void;
  stop(): void;
}

export function registerConnectivity(ctx: ServiceContext): ConnectivityService {
  const state: ConnectivityState = {
    status: 'online',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  };

  const service: ConnectivityService = {
    getState: () => ({ ...state }),
    checkNow: () => {
      // TODO(connectivity-service): comprobación real con net.isOnline + fetch.
      state.lastCheckedAt = new Date().toISOString();
      ctx.broadcast(IPC_CHANNELS.connectivity.changed, service.getState());
      // La bandeja repinta icono y tooltip con el nuevo estado de conexión.
      ctx.services.tray?.refresh();
      return Promise.resolve(service.getState());
    },
    start() {
      // TODO(connectivity-service): iniciar el bucle de vigilancia.
    },
    stop() {
      // TODO(connectivity-service): detener el bucle y los reintentos.
    },
  };

  ipcMain.handle(IPC_CHANNELS.connectivity.getState, () => service.getState());
  ipcMain.handle(IPC_CHANNELS.connectivity.checkNow, () => service.checkNow());

  return service;
}
