import { ipcMain } from 'electron';

import { IPC_CHANNELS, type AgentsState } from '../../shared/ipc';
import type { ServiceContext } from './index';

/**
 * Planificador de tareas de los agentes.
 *
 * Stub funcional mínimo: ya ejecuta el latido cada 30 s y mantiene el estado
 * de pausa (manual o automática, p. ej. por falta de conexión) para que el
 * contrato IPC funcione de principio a fin. La tarea «tray-background»
 * completa la lógica (segundo plano, menú de bandeja) y las fases siguientes
 * registrarán aquí los agentes reales.
 */
export interface SchedulerService {
  getState(): AgentsState;
  /** Pausa manual del usuario. */
  pause(): AgentsState;
  resume(): AgentsState;
  /** Pausa automática por motivo externo (connectivity la usa con 'sin-conexion'). */
  pauseDecisions(reason: 'sin-conexion'): AgentsState;
  resumeDecisions(): AgentsState;
  start(): void;
  stop(): void;
}

export const HEARTBEAT_INTERVAL_MS = 30_000;

export function registerScheduler(ctx: ServiceContext): SchedulerService {
  let manualPause = false;
  let autoPauseReason: 'sin-conexion' | null = null;
  let lastHeartbeatAt: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const getState = (): AgentsState => ({
    paused: manualPause || autoPauseReason !== null,
    pauseReason: autoPauseReason ?? (manualPause ? 'usuario' : null),
    lastHeartbeatAt,
  });

  const emitChanged = (): void => {
    ctx.broadcast(IPC_CHANNELS.agents.changed, getState());
  };

  const tick = (): void => {
    if (getState().paused) return;
    lastHeartbeatAt = new Date().toISOString();
    ctx.broadcast(IPC_CHANNELS.agents.heartbeat, lastHeartbeatAt);
  };

  const service: SchedulerService = {
    getState,
    pause: () => {
      manualPause = true;
      const state = getState();
      emitChanged();
      return state;
    },
    resume: () => {
      manualPause = false;
      const state = getState();
      emitChanged();
      return state;
    },
    pauseDecisions: (reason) => {
      autoPauseReason = reason;
      const state = getState();
      emitChanged();
      return state;
    },
    resumeDecisions: () => {
      autoPauseReason = null;
      const state = getState();
      emitChanged();
      return state;
    },
    start: () => {
      if (timer) return;
      timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
      timer.unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  ipcMain.handle(IPC_CHANNELS.agents.getState, () => service.getState());
  ipcMain.handle(IPC_CHANNELS.agents.pause, () => service.pause());
  ipcMain.handle(IPC_CHANNELS.agents.resume, () => service.resume());

  service.start();
  return service;
}
