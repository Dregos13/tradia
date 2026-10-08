import { ipcMain } from 'electron';

import { IPC_CHANNELS, type AgentsState } from '../../shared/ipc';
import type { ServiceContext } from './index';

/**
 * Planificador de tareas de los agentes.
 *
 * Ejecuta un latido cada `HEARTBEAT_INTERVAL_MS` (30 s): registra la hora en
 * el log, la guarda como `lastHeartbeatAt` y la emite al renderer por
 * `agents:heartbeat`. Mientras los agentes están en pausa el latido no avanza.
 *
 * Hay dos pausas independientes: la manual del usuario (`pause`/`resume`) y la
 * automática por motivo externo (`pauseDecisions`/`resumeDecisions`, que usa
 * connectivity con 'sin-conexion'). Reanudar una no toca la otra: si el
 * usuario reanuda mientras falta la conexión, los agentes siguen en pausa
 * hasta que vuelva la red.
 *
 * Las fases siguientes registrarán aquí los agentes reales.
 */
export interface SchedulerService {
  getState(): AgentsState;
  /** Pausa manual del usuario. */
  pause(): AgentsState;
  resume(): AgentsState;
  /** Pausa automática por motivo externo (connectivity la usa con 'sin-conexion'). */
  pauseDecisions(reason: 'sin-conexion'): AgentsState;
  resumeDecisions(): AgentsState;
  /**
   * Listener interno del proceso principal (la bandeja lo usa para refrescar
   * icono y menú). Los renderers reciben el cambio por `agents:changed`.
   */
  onChanged(listener: (state: AgentsState) => void): () => void;
  start(): void;
  stop(): void;
}

export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface SchedulerLogger {
  info(message: string): void;
}

export interface SchedulerDeps {
  /** Envía un evento a todas las ventanas (renderer). */
  broadcast: (channel: string, payload: unknown) => void;
  logger?: SchedulerLogger;
  /** Intervalo del latido; por defecto HEARTBEAT_INTERVAL_MS. */
  intervalMs?: number;
}

export function createSchedulerService(deps: SchedulerDeps): SchedulerService {
  const logger = deps.logger ?? console;
  const intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS;

  let manualPause = false;
  let autoPauseReason: 'sin-conexion' | null = null;
  let lastHeartbeatAt: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  const listeners = new Set<(state: AgentsState) => void>();

  const getState = (): AgentsState => ({
    paused: manualPause || autoPauseReason !== null,
    pauseReason: autoPauseReason ?? (manualPause ? 'usuario' : null),
    lastHeartbeatAt,
  });

  const emitChanged = (): void => {
    const state = getState();
    deps.broadcast(IPC_CHANNELS.agents.changed, state);
    for (const listener of listeners) listener(state);
  };

  const tick = (): void => {
    if (getState().paused) return;
    lastHeartbeatAt = new Date().toISOString();
    logger.info(`[scheduler] latido ${lastHeartbeatAt}`);
    deps.broadcast(IPC_CHANNELS.agents.heartbeat, lastHeartbeatAt);
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
    onChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      // El intervalo no debe mantener vivo el proceso por sí solo.
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  return service;
}

export function registerScheduler(ctx: ServiceContext): SchedulerService {
  const service = createSchedulerService({ broadcast: ctx.broadcast });

  ipcMain.handle(IPC_CHANNELS.agents.getState, () => service.getState());
  ipcMain.handle(IPC_CHANNELS.agents.pause, () => service.pause());
  ipcMain.handle(IPC_CHANNELS.agents.resume, () => service.resume());

  service.start();
  return service;
}
