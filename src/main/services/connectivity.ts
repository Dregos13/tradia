import { app, ipcMain, net, powerMonitor } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  type ConnectivityState,
  type ConnectivityStatus,
  type NotificationPayload,
} from '../../shared/ipc';
import type { NotificationsService } from './notifications';
import type { SchedulerService } from './scheduler';
import type { ServiceContext } from './index';

/**
 * Vigilancia de conexión a internet.
 *
 * Comprueba `net.isOnline` y hace una petición ligera a dos URL
 * configurables (ajustes `connectivity.urls` o `TRADIA_CONNECTIVITY_URLS`;
 * si responde al menos una, hay conexión). En línea hay dos vías:
 * - la vía rápida consulta `net.isOnline()` cada `fastCheckIntervalMs`
 *   (2 s), una llamada local al SO sin tráfico: detecta en ≤ 2 s los
 *   cortes locales (wifi apagado, cable desenchufado, modo avión);
 * - el sondeo HTTP se repite cada `onlineIntervalMs` (15 s) por si la red
 *   local sigue activa pero no hay salida a internet (detección ≤ 20 s).
 * Sin conexión se reintenta con espera exponencial y fluctuación (2 s,
 * 4 s, 8 s… hasta `backoffMaxMs`, 5 min) y se vuelve a comprobar al
 * instante con los eventos `resume` y `unlock-screen` de powerMonitor.
 *
 * Al pasar a 'sin conexión': `scheduler.pauseDecisions('sin-conexion')`,
 * repinta la bandeja, emite `connectivity:changed` y avisa con una
 * notificación de nivel 'alerta'. Al volver: `scheduler.resumeDecisions()`
 * (no levanta la pausa manual del usuario) y notifica en nivel 'info'.
 * Cada transición se procesa una sola vez, aunque haya reintentos.
 *
 * Modo simulación (solo desarrollo): `TRADIA_SIMULATE_OFFLINE=1` arranca
 * sin conexión simulada y el canal IPC `connectivity:simulate-offline` la
 * activa/desactiva en caliente; la app empaquetada no registra el handler.
 */
export interface ConnectivityService {
  getState(): ConnectivityState;
  checkNow(): Promise<ConnectivityState>;
  /** Activa/desactiva la simulación de 'sin conexión' (solo desarrollo). */
  setSimulatedOffline(offline: boolean): void;
  isSimulatedOffline(): boolean;
  start(): void;
  stop(): void;
}

export const ONLINE_INTERVAL_MS = 15_000;
/** Intervalo del sondeo local de `isOnline()` mientras se está en línea. */
export const FAST_CHECK_INTERVAL_MS = 2_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 300_000;
export const PROBE_TIMEOUT_MS = 5_000;

/** Endpoints ligeros por defecto (hosts distintos para aislar fallos de DNS). */
export const DEFAULT_CONNECTIVITY_ENDPOINTS = [
  'https://www.gstatic.com/generate_204',
  'https://connectivitycheck.gstatic.com/generate_204',
] as const;

/** Clave de ajustes (JSON con un array de URL) que sobreescribe los endpoints. */
export const CONNECTIVITY_URLS_SETTING_KEY = 'connectivity.urls';

/**
 * Espera exponencial con fluctuación: `base * 2^(attempt-1)` con tope `max`
 * y un jitter de ±25 %. Con `random() = 0.5` sale la secuencia exacta
 * 2 s, 4 s, 8 s… — los tests fijan `random` para comprobarla.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs = BACKOFF_BASE_MS,
  maxMs = BACKOFF_MAX_MS,
  random: () => number = Math.random,
): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(raw * (0.75 + random() * 0.5));
}

function parseEndpointList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((u): u is string => typeof u === 'string');
  } catch {
    // No es JSON: se interpreta como lista separada por comas (env).
  }
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
}

function isUsableEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Resuelve los endpoints a vigilar desde `raw` (JSON o lista por comas).
 * Hacen falta al menos dos URL http/https válidas; si no, se usan los
 * valores por defecto.
 */
export function resolveEndpoints(
  raw: string | null | undefined,
  logger: Pick<Console, 'warn'> = console,
): string[] {
  if (raw) {
    const valid = parseEndpointList(raw).filter(isUsableEndpoint);
    if (valid.length >= 2) return valid;
    logger.warn('[connectivity] endpoints configurados no válidos; se usan los por defecto');
  }
  return [...DEFAULT_CONNECTIVITY_ENDPOINTS];
}

/** Mínimo de `Electron.PowerMonitor` que usa el servicio (inyectable). */
export interface PowerMonitorLike {
  on(event: 'resume' | 'unlock-screen', listener: () => void): unknown;
  removeListener(event: 'resume' | 'unlock-screen', listener: () => void): unknown;
}

export interface ConnectivityLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ConnectivityDeps {
  /** `net.isOnline` de Electron: comprobación rápida del SO. */
  isOnline(): boolean;
  /** Petición ligera a un endpoint; true si responde (status < 400). */
  probe(url: string): Promise<boolean>;
  /** Envía un evento a todas las ventanas (renderer). */
  broadcast(channel: string, payload: unknown): void;
  /** Planificador: pausa/reanudación automática por 'sin-conexion'. */
  scheduler?: Pick<SchedulerService, 'pauseDecisions' | 'resumeDecisions'>;
  /** Punto único de notificaciones nativas. */
  notify?: (payload: NotificationPayload) => void;
  /** Repinta icono y tooltip de la bandeja tras cada cambio. */
  refreshTray?: () => void;
  /** Eventos del SO que disparan un reintento inmediato. */
  powerMonitor?: PowerMonitorLike;
  /** URL ligeras a comprobar; hay conexión si responde al menos una. */
  endpoints?: string[];
  onlineIntervalMs?: number;
  /** Intervalo de la vía rápida (sondeo local de isOnline, sin red). */
  fastCheckIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Fuente del jitter de la espera (los tests la fijan a 0.5). */
  random?: () => number;
  /** Arranca con la simulación de 'sin conexión' activada (desarrollo). */
  simulateOfflineInitially?: boolean;
  logger?: ConnectivityLogger;
}

export function createConnectivityService(deps: ConnectivityDeps): ConnectivityService {
  const logger = deps.logger ?? console;
  const endpoints =
    deps.endpoints && deps.endpoints.length > 0
      ? deps.endpoints
      : [...DEFAULT_CONNECTIVITY_ENDPOINTS];
  const onlineIntervalMs = deps.onlineIntervalMs ?? ONLINE_INTERVAL_MS;
  const fastCheckIntervalMs = deps.fastCheckIntervalMs ?? FAST_CHECK_INTERVAL_MS;
  const backoffBaseMs = deps.backoffBaseMs ?? BACKOFF_BASE_MS;
  const backoffMaxMs = deps.backoffMaxMs ?? BACKOFF_MAX_MS;
  const random = deps.random ?? Math.random;

  let status: ConnectivityStatus = 'online';
  // Último estado consolidado: las transiciones y sus efectos (pausa,
  // notificación) se disparan solo cuando cambia, no en cada reintento.
  let settled: 'online' | 'offline' = 'online';
  let lastCheckedAt: string | null = null;
  let nextRetryAt: string | null = null;
  let attempt = 0;
  let simulatedOffline = deps.simulateOfflineInitially === true;
  let started = false;
  let timer: NodeJS.Timeout | null = null;
  let fastTimer: NodeJS.Timeout | null = null;
  let inflight: Promise<ConnectivityState> | null = null;
  const powerListeners: Array<['resume' | 'unlock-screen', () => void]> = [];

  const getState = (): ConnectivityState => ({ status, lastCheckedAt, nextRetryAt, attempt });

  const emit = (): void => {
    deps.broadcast(IPC_CHANNELS.connectivity.changed, getState());
    deps.refreshTray?.();
  };

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const scheduleNext = (): void => {
    clearTimer();
    if (!started) return;
    let delayMs: number;
    if (settled === 'offline') {
      delayMs = backoffDelayMs(attempt, backoffBaseMs, backoffMaxMs, random);
      nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    } else {
      delayMs = onlineIntervalMs;
      nextRetryAt = null;
    }
    timer = setTimeout(() => {
      void service.checkNow();
    }, delayMs);
    // El temporizador no debe mantener vivo el proceso por sí solo.
    timer.unref?.();
  };

  /**
   * Vía rápida: sondeo local de isOnline() mientras el estado consolidado
   * es 'online'. No lanza peticiones HTTP; si el SO ya no ve red se aplica
   * 'sin conexión' al instante, sin esperar al sondeo programado.
   */
  const fastCheck = (): void => {
    if (settled !== 'online' || inflight) return;
    try {
      if (deps.isOnline()) return;
    } catch {
      return;
    }
    applyResult(false);
  };

  const probeAll = async (): Promise<boolean> => {
    if (simulatedOffline) return false;
    try {
      if (!deps.isOnline()) return false;
    } catch {
      return false;
    }
    const results = await Promise.all(
      endpoints.map(async (url) => {
        try {
          return await deps.probe(url);
        } catch {
          return false;
        }
      }),
    );
    return results.some(Boolean);
  };

  const applyResult = (online: boolean): void => {
    lastCheckedAt = new Date().toISOString();
    const next: 'online' | 'offline' = online ? 'online' : 'offline';
    status = next;

    if (next === settled) {
      // Sin transición: solo crece el contador de reintentos en la espera.
      attempt = online ? 0 : attempt + 1;
    } else {
      settled = next;
      if (next === 'offline') {
        attempt = 1;
        deps.scheduler?.pauseDecisions('sin-conexion');
        deps.notify?.({
          level: 'alerta',
          title: 'Tradia — Sin conexión',
          body: 'Se ha perdido la conexión a internet. Las decisiones de los agentes quedan en pausa hasta que vuelva.',
        });
        logger.warn('[connectivity] conexión perdida; las decisiones quedan en pausa');
      } else {
        attempt = 0;
        deps.scheduler?.resumeDecisions();
        deps.notify?.({
          level: 'info',
          title: 'Tradia — En línea',
          body: 'Se ha recuperado la conexión a internet. Los agentes reanudan su actividad.',
        });
        logger.info('[connectivity] conexión recuperada; las decisiones se reanudan');
      }
    }

    scheduleNext();
    emit();
  };

  const service: ConnectivityService = {
    getState,
    checkNow: () => {
      // Una sola comprobación en vuelo; las llamadas concurrentes comparten
      // la misma promesa.
      if (inflight) return inflight;
      clearTimer();
      nextRetryAt = null;
      status = 'checking';
      emit();
      inflight = (async () => {
        try {
          applyResult(await probeAll());
        } catch (error: unknown) {
          // Defensivo: probeAll ya traga sus errores; si algo escapa igual
          // contamos el intento como fallo para no quedarnos sin reintento.
          logger.error(`[connectivity] la comprobación falló: ${String(error)}`);
          applyResult(false);
        } finally {
          inflight = null;
        }
        return getState();
      })();
      return inflight;
    },
    setSimulatedOffline: (offline) => {
      if (simulatedOffline === offline) return;
      simulatedOffline = offline;
      logger.warn(
        `[connectivity] simulación de 'sin conexión' ${offline ? 'activada' : 'desactivada'}`,
      );
      void service.checkNow();
    },
    isSimulatedOffline: () => simulatedOffline,
    start: () => {
      if (started) return;
      started = true;
      fastTimer = setInterval(fastCheck, fastCheckIntervalMs);
      // La vía rápida no debe mantener vivo el proceso por sí sola.
      fastTimer.unref?.();
      if (deps.powerMonitor) {
        // Al despertar o desbloquear el equipo se comprueba al instante,
        // sin esperar al siguiente reintento programado.
        for (const event of ['resume', 'unlock-screen'] as const) {
          const listener = (): void => {
            logger.info(`[connectivity] evento '${event}'; comprobación inmediata`);
            void service.checkNow();
          };
          deps.powerMonitor.on(event, listener);
          powerListeners.push([event, listener]);
        }
      }
      void service.checkNow();
    },
    stop: () => {
      started = false;
      clearTimer();
      if (fastTimer) clearInterval(fastTimer);
      fastTimer = null;
      for (const [event, listener] of powerListeners) {
        deps.powerMonitor?.removeListener(event, listener);
      }
      powerListeners.length = 0;
    },
  };

  return service;
}

const PROBE_REQUEST_INIT = { method: 'HEAD', cache: 'no-store' } as const;

/** Petición ligera real: HEAD con tiempo de espera, red de Chromium (net.fetch). */
async function probeEndpoint(url: string): Promise<boolean> {
  try {
    const response = await net.fetch(url, {
      ...PROBE_REQUEST_INIT,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Cualquier respuesta <400 confirma salida a internet.
    return response.status < 400;
  } catch {
    return false;
  }
}

export function registerConnectivity(ctx: ServiceContext): ConnectivityService {
  const isDev = !app.isPackaged;
  const scheduler: Pick<SchedulerService, 'pauseDecisions' | 'resumeDecisions'> | undefined =
    ctx.services.scheduler;
  const notifications: NotificationsService | undefined = ctx.services.notifications;

  const service = createConnectivityService({
    isOnline: () => net.isOnline(),
    probe: probeEndpoint,
    // Indirección a propósito: el broker envuelve ctx.broadcast al
    // registrarse después y necesita ver los `connectivity:changed`.
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    scheduler,
    notify: (payload) => notifications?.notify(payload),
    refreshTray: () => ctx.services.tray?.refresh(),
    powerMonitor,
    endpoints: resolveEndpoints(
      ctx.services.settings?.getValue(CONNECTIVITY_URLS_SETTING_KEY) ??
        process.env.TRADIA_CONNECTIVITY_URLS ??
        null,
    ),
    // La simulación solo existe en desarrollo: ni el arranque con la env ni
    // el canal de depuración están disponibles en la app empaquetada.
    simulateOfflineInitially: isDev && process.env.TRADIA_SIMULATE_OFFLINE === '1',
  });

  ipcMain.handle(IPC_CHANNELS.connectivity.getState, () => service.getState());
  ipcMain.handle(IPC_CHANNELS.connectivity.checkNow, () => service.checkNow());
  if (isDev) {
    ipcMain.handle(IPC_CHANNELS.connectivity.simulateOffline, (_event, offline: unknown) => {
      if (typeof offline !== 'boolean') {
        throw new IpcValidationError(
          IPC_CHANNELS.connectivity.simulateOffline,
          'se esperaba un booleano',
        );
      }
      service.setSimulatedOffline(offline);
      return service.getState();
    });
  }

  service.start();
  return service;
}
