/**
 * Parada de emergencia (kill switch) — Fase 3.
 *
 * `createKillSwitchService` es el núcleo, con todo lo externo inyectado
 * (almacén, reloj, temporizadores, planificador, notificaciones, bandeja y
 * sondeo de conectividad): las pruebas lo montan sin Electron.
 * `registerKillSwitch` lo cablea en la app.
 *
 * Reglas de negocio:
 * - `activate(causa, actor)` es idempotente: con la parada ya activa no se
 *   escribe otro evento ni se repite la notificación.
 * - Cada acción se guarda en `kill_switch_events` (migración 007); el
 *   estado es el del último evento, así sobrevive al reinicio, y al
 *   arrancar con la parada activa se reaplica la pausa del planificador.
 * - Al activarse: pausa los agentes y el programador (`scheduler.pause()`,
 *   lo mismo que `agents:pause`), refresca la bandeja, emite
 *   `risk:changed` con el `RiskOverview` y envía la notificación crítica
 *   cuyo clic abre `#riesgo`.
 * - `resume` exige `confirm: true` (`KillSwitchResumeRequest`): nunca se
 *   reanuda de forma automática, ni al volver la conexión ni al
 *   recuperarse el dato.
 *
 * Disparadores automáticos (umbrales de `shared/risk.ts`):
 * - 'perdida-anomala': `observeDailyLoss` (pérdida diaria ≥ 1,5 × límite)
 *   y `observeDrawdown` (drawdown ≥ límite).
 * - 'dato-anomalo': `observeDataStatus` (`data-status:changed` con estado
 *   'no-fiable', observado envolviendo `ctx.broadcast` como hace health) y
 *   `observePriceJump` (|Δ%| ≥ 20).
 * - 'sin-conexion': `checkConnectivity` sondea el estado de connectivity
 *   (reloj inyectable): 'offline' sostenido ≥ 60 s dispara la parada.
 * - 'modelo-erratico': `observeSignal` (ráfaga de más de 20 señales por
 *   hora, 5 señales inválidas seguidas o confianza fuera de 0–1).
 *
 * El `RiskOverview` que emite `risk:changed` toma límites y cautela de un
 * proveedor de extras (`setOverviewExtras`): por defecto usa
 * `RISK_DEFAULTS` y cautela inactiva; la pasarela del motor de riesgo lo
 * sustituirá por las fuentes reales al registrarse.
 */
import { app, ipcMain } from 'electron';
import type Database from 'better-sqlite3';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isDataStatusState,
  isE2eEnabled,
  isKillSwitchCause,
  isResumeKillSwitchRequest,
  KILL_SWITCH_DAILY_LOSS_FACTOR,
  KILL_SWITCH_MAX_INVALID_SIGNALS,
  KILL_SWITCH_MAX_SIGNALS_PER_HOUR,
  KILL_SWITCH_OFFLINE_SECONDS,
  KILL_SWITCH_PRICE_JUMP_PCT,
  RISK_DEFAULTS,
  type ConnectivityState,
  type CautionState,
  type DataStatusEntry,
  type KillSwitchActor,
  type KillSwitchCause,
  type KillSwitchResumeRequest,
  type KillSwitchState,
  type NotificationPayload,
  type RiskLimits,
  type RiskOverview,
  type SignalIntent,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';

// ---------------------------------------------------------------------------
// Constantes y textos
// ---------------------------------------------------------------------------

/** Cadencia del sondeo del estado de conectividad. */
export const KILL_SWITCH_CONNECTIVITY_POLL_MS = 5_000;

/** Una hora en ms: ventana de la ráfaga de señales. */
const SIGNAL_BURST_WINDOW_MS = 3_600_000;

/**
 * Causa de la parada tal como la lee el usuario (banner y notificación),
 * fijada por la guía de diseño: `Parada manual` para el usuario y textos
 * completos para los disparadores automáticos.
 */
export const KILL_SWITCH_NOTIFICATION_CAUSES: Record<KillSwitchCause, string> = {
  manual: 'Parada manual',
  'perdida-anomala': 'Pérdida anómala',
  'dato-anomalo': 'Dato de mercado anómalo',
  'sin-conexion': 'Sin conexión durante más de 60 s',
  'modelo-erratico': 'Comportamiento errático del modelo',
};

/** Título y cuerpo de la notificación crítica (guía de diseño). */
export const KILL_SWITCH_NOTIFICATION_TITLE = 'Tradia ha activado la parada';

/** Cautela inactiva por defecto hasta que la pasarela aporte la real. */
export const CAUTION_INACTIVE: CautionState = {
  active: false,
  effect: 'ninguno',
  sizeFactor: 1,
  cause: null,
  eventTitle: null,
  until: null,
};

export const KILL_SWITCH_ERROR_CODES = ['confirmacion-requerida'] as const;
export type KillSwitchErrorCode = (typeof KILL_SWITCH_ERROR_CODES)[number];

export class KillSwitchError extends Error {
  readonly code: KillSwitchErrorCode;

  constructor(code: KillSwitchErrorCode, message: string) {
    super(message);
    this.name = 'KillSwitchError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Almacén (kill_switch_events)
// ---------------------------------------------------------------------------

type KillSwitchAction = 'activada' | 'reanudada';

export interface KillSwitchEventRow {
  id: number;
  accion: KillSwitchAction;
  causa: KillSwitchCause;
  actor: KillSwitchActor;
  detalle: string | null;
  creado_en: string;
}

/**
 * Escritura/lectura de `kill_switch_events`. El estado actual es el del
 * último evento; `lastActivation` recupera la última 'activada' para
 * conservar causa, actor y hora tras una reanudación.
 */
export interface KillSwitchStore {
  append(
    action: KillSwitchAction,
    cause: KillSwitchCause,
    actor: KillSwitchActor,
    detail: string | null,
    at: string,
  ): void;
  lastEvent(): KillSwitchEventRow | null;
  lastActivation(): KillSwitchEventRow | null;
}

export function createKillSwitchStore(db: Database.Database): KillSwitchStore {
  const insert = db.prepare(
    `INSERT INTO kill_switch_events (accion, causa, actor, detalle, creado_en)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const lastEventStmt = db.prepare(
    `SELECT id, accion, causa, actor, detalle, creado_en
     FROM kill_switch_events ORDER BY id DESC LIMIT 1`,
  );
  const lastActivationStmt = db.prepare(
    `SELECT id, accion, causa, actor, detalle, creado_en
     FROM kill_switch_events WHERE accion = 'activada' ORDER BY id DESC LIMIT 1`,
  );

  return {
    append: (action, cause, actor, detail, at) => {
      insert.run(action, cause, actor, detail, at);
    },
    lastEvent: () => (lastEventStmt.get() as KillSwitchEventRow | undefined) ?? null,
    lastActivation: () => (lastActivationStmt.get() as KillSwitchEventRow | undefined) ?? null,
  };
}

/** Deriva el estado del dominio a partir del historial persistido. */
function stateFromStore(store: KillSwitchStore): KillSwitchState {
  const last = store.lastEvent();
  const activation = last?.accion === 'activada' ? last : store.lastActivation();
  return {
    active: last?.accion === 'activada',
    cause: activation?.causa ?? null,
    actor: activation?.actor ?? null,
    activatedAt: activation?.creado_en ?? null,
    detail: activation?.detalle ?? null,
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

/** Límites y cautela que completa la pasarela para el `risk:changed`. */
export interface KillSwitchOverviewExtras {
  limits: RiskLimits;
  caution: CautionState;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface KillSwitchDeps {
  store: KillSwitchStore;
  /** Emite `risk:changed` a todas las ventanas. */
  broadcast(channel: string, payload: unknown): void;
  /** `scheduler.pause()`: detiene agentes y planificador al activar. */
  pauseAgents(): void;
  /** `scheduler.resume()`: solo tras la reanudación confirmada. */
  resumeAgents(): void;
  /** Punto único de notificaciones nativas (la crítica de la parada). */
  notify?(payload: NotificationPayload): void;
  /** Repinta icono, tooltip y menú de la bandeja tras cada cambio. */
  refreshTray?(): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  /** Estado actual de conectividad, para el sondeo de 'sin-conexion'. */
  getConnectivityState?(): ConnectivityState | undefined;
  /** Límites vigentes, para el umbral de pérdida anómala. */
  getLimits?(): RiskLimits;
  /** Límites y cautela reales para el `risk:changed` (los pone la pasarela). */
  overviewExtras?(): KillSwitchOverviewExtras;
  /** Temporizadores inyectables (un disparo que se rearma, patrón de health). */
  setTimer?(callback: () => void, delayMs: number): TimerHandle;
  clearTimer?(handle: TimerHandle): void;
  connectivityPollMs?: number;
  offlineThresholdMs?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface KillSwitchService {
  getState(): KillSwitchState;
  /**
   * Activa la parada. Idempotente: ya activa no escribe ni notifica otra
   * vez. `actor` es 'usuario' para la manual y 'automatico' para los
   * disparadores.
   */
  activate(cause: KillSwitchCause, actor: KillSwitchActor, detail?: string | null): KillSwitchState;
  /** Reanuda solo con `{confirm: true}`; nunca de forma automática. */
  resume(request: KillSwitchResumeRequest): KillSwitchState;
  /** Pérdida diaria realizada (% del capital); ≥ 1,5 × límite → parada. */
  observeDailyLoss(lossPct: number): void;
  /** Drawdown actual (% del capital); ≥ límite → parada. */
  observeDrawdown(drawdownPct: number): void;
  /** Entrada de `data-status:changed`; 'no-fiable' → parada. */
  observeDataStatus(entry: DataStatusEntry): void;
  /** Salto de precio en %; |Δ%| ≥ 20 → parada. */
  observePriceJump(ticker: string, changePct: number): void;
  /**
   * Cada señal que entra al motor: ráfaga (> 20/h), inválidas seguidas
   * (≥ 5) o confianza fuera de 0–1 → parada.
   */
  observeSignal(signal: SignalIntent): void;
  /** Una pasada del sondeo de conectividad; 'offline' ≥ 60 s → parada. */
  checkConnectivity(): void;
  /** La pasarela instala aquí límites y cautela reales para `risk:changed`. */
  setOverviewExtras(provider: () => KillSwitchOverviewExtras): void;
  /** Listeners internos del proceso principal (p. ej. la pasarela). */
  onChanged(listener: (state: KillSwitchState) => void): () => void;
  /** Reaplica la pausa si la parada quedó activa y arma el sondeo. Idempotente. */
  start(): void;
  stop(): void;
}

export function createKillSwitchService(deps: KillSwitchDeps): KillSwitchService {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const getLimits = deps.getLimits ?? (() => RISK_DEFAULTS);
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const connectivityPollMs = deps.connectivityPollMs ?? KILL_SWITCH_CONNECTIVITY_POLL_MS;
  const offlineThresholdMs = deps.offlineThresholdMs ?? KILL_SWITCH_OFFLINE_SECONDS * 1_000;

  let state = stateFromStore(deps.store);
  let overviewExtras =
    deps.overviewExtras ?? (() => ({ limits: RISK_DEFAULTS, caution: CAUTION_INACTIVE }));
  let started = false;
  let timer: TimerHandle | null = null;
  /** Desde cuándo está 'offline' seguido (null si está en línea o sin muestras). */
  let offlineSince: number | null = null;
  /** Instantes de las señales observadas en la última hora. */
  const signalTimes: number[] = [];
  let consecutiveInvalid = 0;
  const listeners = new Set<(state: KillSwitchState) => void>();

  const isoNow = (): string => new Date(now()).toISOString();

  /** HH:MM local para el cuerpo de la notificación. */
  const localTime = (): string => {
    const d = new Date(now());
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const emitChanged = (): void => {
    const extras = overviewExtras();
    const overview: RiskOverview = {
      limits: extras.limits,
      killSwitch: state,
      caution: extras.caution,
    };
    deps.broadcast(IPC_CHANNELS.risk.changed, overview);
    for (const listener of listeners) listener(state);
    deps.refreshTray?.();
  };

  const service: KillSwitchService = {
    getState: () => ({ ...state }),

    activate: (cause, actor, detail = null) => {
      if (state.active) return { ...state };
      deps.store.append('activada', cause, actor, detail, isoNow());
      state = stateFromStore(deps.store);
      deps.pauseAgents();
      deps.notify?.({
        level: 'critica',
        title: KILL_SWITCH_NOTIFICATION_TITLE,
        body: `${KILL_SWITCH_NOTIFICATION_CAUSES[cause]}. Señales y órdenes detenidas desde las ${localTime()}. Abre Riesgo para revisar y reanudar.`,
        navigateTo: 'riesgo',
      });
      logger.warn(`[risk] parada de emergencia activada (${cause}${detail ? `: ${detail}` : ''})`);
      emitChanged();
      return { ...state };
    },

    resume: (request) => {
      // Defensa en profundidad: la forma ya la exige el tipo y la guarda
      // isResumeKillSwitchRequest, pero la reanudación jamás es automática.
      if (request.confirm !== true) {
        throw new KillSwitchError(
          'confirmacion-requerida',
          'la reanudación de la parada exige confirmación explícita',
        );
      }
      if (!state.active) return { ...state };
      deps.store.append('reanudada', 'manual', 'usuario', request.note ?? null, isoNow());
      state = stateFromStore(deps.store);
      deps.resumeAgents();
      logger.info('[risk] parada de emergencia reanudada por el usuario');
      emitChanged();
      return { ...state };
    },

    observeDailyLoss: (lossPct) => {
      if (!Number.isFinite(lossPct)) return;
      const threshold = KILL_SWITCH_DAILY_LOSS_FACTOR * getLimits().maxDailyLossPct;
      if (lossPct >= threshold) {
        service.activate(
          'perdida-anomala',
          'automatico',
          `pérdida diaria del ${lossPct} % ≥ ${KILL_SWITCH_DAILY_LOSS_FACTOR} × ${getLimits().maxDailyLossPct} %`,
        );
      }
    },

    observeDrawdown: (drawdownPct) => {
      if (!Number.isFinite(drawdownPct)) return;
      const limit = getLimits().maxDrawdownPct;
      if (drawdownPct >= limit) {
        service.activate(
          'perdida-anomala',
          'automatico',
          `drawdown del ${drawdownPct} % ≥ máximo ${limit} %`,
        );
      }
    },

    observeDataStatus: (entry) => {
      // 'desactualizado' no es anómalo: solo 'no-fiable' (valor anómalo
      // grave o fallos repetidos del proveedor) dispara la parada.
      if (entry.state !== 'no-fiable') return;
      service.activate(
        'dato-anomalo',
        'automatico',
        `${entry.key}: ${entry.reason ?? 'estado no fiable'}`,
      );
    },

    observePriceJump: (ticker, changePct) => {
      if (!Number.isFinite(changePct)) return;
      if (Math.abs(changePct) >= KILL_SWITCH_PRICE_JUMP_PCT) {
        service.activate('dato-anomalo', 'automatico', `salto del ${changePct} % en ${ticker}`);
      }
    },

    observeSignal: (signal) => {
      const t = now();
      signalTimes.push(t);
      while (signalTimes.length > 0) {
        const oldest = signalTimes[0];
        if (oldest === undefined || t - oldest < SIGNAL_BURST_WINDOW_MS) break;
        signalTimes.shift();
      }
      if (signalTimes.length > KILL_SWITCH_MAX_SIGNALS_PER_HOUR) {
        service.activate(
          'modelo-erratico',
          'automatico',
          `ráfaga de ${signalTimes.length} señales en 1 h`,
        );
      }

      const confidenceOutOfRange =
        !Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1;
      if (confidenceOutOfRange) {
        service.activate(
          'modelo-erratico',
          'automatico',
          `confianza fuera de rango: ${signal.confidence}`,
        );
      }

      // Señal inválida: forma rota aunque haya pasado la guarda del borde
      // (números no finitos, precios no positivos, confianza anómala).
      const invalid =
        confidenceOutOfRange ||
        !Number.isFinite(signal.entry) ||
        signal.entry <= 0 ||
        (signal.stop !== null && (!Number.isFinite(signal.stop) || signal.stop <= 0)) ||
        (signal.target !== null && (!Number.isFinite(signal.target) || signal.target <= 0));
      consecutiveInvalid = invalid ? consecutiveInvalid + 1 : 0;
      if (!confidenceOutOfRange && consecutiveInvalid >= KILL_SWITCH_MAX_INVALID_SIGNALS) {
        service.activate(
          'modelo-erratico',
          'automatico',
          `${consecutiveInvalid} señales inválidas seguidas`,
        );
      }
    },

    checkConnectivity: () => {
      const connectivity = deps.getConnectivityState?.();
      if (!connectivity) return;
      if (connectivity.status === 'offline') {
        if (offlineSince === null) {
          offlineSince = now();
        } else if (now() - offlineSince >= offlineThresholdMs) {
          service.activate(
            'sin-conexion',
            'automatico',
            `sin conexión durante más de ${Math.round(offlineThresholdMs / 1_000)} s`,
          );
        }
      } else if (connectivity.status === 'online') {
        offlineSince = null;
      }
      // 'checking' ni cuenta ni reinicia: es un estado de paso entre sondeos.
    },

    setOverviewExtras: (provider) => {
      overviewExtras = provider;
    },

    onChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start: () => {
      if (started) return;
      started = true;
      // La parada sobrevive al reinicio: si el último evento fue una
      // activación, los agentes arrancan otra vez en pausa.
      if (state.active) deps.pauseAgents();
      const arm = (): void => {
        if (!started) return;
        timer = setTimer(() => {
          timer = null;
          service.checkConnectivity();
          arm();
        }, connectivityPollMs);
        (timer as { unref?: () => void }).unref?.();
      };
      arm();
    },

    stop: () => {
      started = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

const isDataStatusEntryLike = (value: unknown): value is DataStatusEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { key?: unknown }).key === 'string' &&
  isDataStatusState((value as { state?: unknown }).state);

/** Dependencias opcionales del registro; la pasarela aporta los límites reales. */
export interface RegisterKillSwitchDeps {
  /**
   * Límites vigentes para los umbrales automáticos (pérdida anómala y
   * drawdown). Se consulta en cada observación: la pasarela lo enlaza con
   * el repositorio de límites cuando se registra. Por defecto RISK_DEFAULTS.
   */
  getLimits?(): RiskLimits;
}

export function registerKillSwitch(
  ctx: ServiceContext,
  deps: RegisterKillSwitchDeps = {},
): KillSwitchService {
  // Sin base de datos la parada degrada a memoria (mismo patrón que
  // registerHealth): la app sigue arrancando, aunque el estado no sobreviva.
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[risk] almacén no disponible: la parada de emergencia solo vivirá en memoria');
    db = openDatabase(':memory:');
  }

  const service = createKillSwitchService({
    store: createKillSwitchStore(db),
    getLimits: deps.getLimits,
    // Indirección: usa el ctx.broadcast vigente en cada emisión.
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    pauseAgents: () => {
      ctx.services.scheduler?.pause();
    },
    resumeAgents: () => {
      ctx.services.scheduler?.resume();
    },
    notify: (payload) => ctx.services.notifications?.notify(payload),
    refreshTray: () => ctx.services.tray?.refresh(),
    getConnectivityState: () => ctx.services.connectivity?.getState(),
    logger: console,
  });

  // Los 'data-status:changed' que escriben health/market/macro alimentan
  // observeDataStatus: se envuelve ctx.broadcast (mismo patrón que health)
  // antes de que macro y market lo capturen en su registro.
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.dataStatus.changed && isDataStatusEntryLike(payload)) {
      service.observeDataStatus(payload);
    }
  };

  ipcMain.handle(IPC_CHANNELS.risk.getKillSwitch, () => service.getState());
  ipcMain.handle(IPC_CHANNELS.risk.activateKillSwitch, () => service.activate('manual', 'usuario'));
  ipcMain.handle(IPC_CHANNELS.risk.resumeKillSwitch, (_event, request: unknown) => {
    if (!isResumeKillSwitchRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.risk.resumeKillSwitch,
        'se esperaba {confirm: true, note?}',
      );
    }
    return service.resume(request);
  });

  // Gancho E2E: activa la parada como si la hubiera disparado la causa
  // dada (la app empaquetada no registra el handler).
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.risk.simulateCause, (_event, cause: unknown) => {
      if (!isKillSwitchCause(cause)) {
        throw new IpcValidationError(IPC_CHANNELS.risk.simulateCause, 'causa inválida');
      }
      return service.activate(cause, cause === 'manual' ? 'usuario' : 'automatico', 'simulado');
    });
  }

  service.start();
  return service;
}
