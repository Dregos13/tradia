/**
 * Vigilancia de datos caducados o no fiables y notificación — Fase 1.
 *
 * `createDataHealthService` es el núcleo, con todo lo externo inyectado
 * (reloj, calendario, notificaciones, temporizadores): las pruebas lo montan
 * sin Electron. `registerHealth` lo cablea en la app.
 *
 * Estados por ticker (`ticker:*`) y por serie macro (`macro:*`), guardados en
 * `data_status` y emitidos por `data-status:changed`:
 *
 * - 'fiable': hay vela de la última sesión esperada (u observación al día).
 * - 'actualizando': lo escriben la ingesta y el servicio macro mientras dura
 *   su refresco; la vigilancia lo respeta si es reciente.
 * - 'desactualizado': falta la vela de una sesión esperada pasadas
 *   `STALE_GRACE_MS` (12 h) desde la hora de actualización de la primera
 *   sesión que falta. Para las series macro se pide la observación esperada
 *   según su frecuencia (una sesión de margen en las diarias —FRED publica
 *   con desfase—, primer día del mes anterior en las mensuales).
 * - 'no-fiable': `HEALTH_MAX_CONSECUTIVE_FAILURES` (3) fallos seguidos del
 *   proveedor, o un valor anómalo grave (`quality_flags` 'anomalo') en el
 *   último lote guardado. Solo un refresco con éxito lo levanta: la
 *   evaluación nunca degrada 'no-fiable'.
 *
 * Notificaciones (`services/notifications`): al empeorar el estado se envía
 * 'alerta' para 'desactualizado' y 'critica' para 'no-fiable'; las
 * repeticiones del mismo estado se agrupan como máximo una vez cada
 * `NOTIFY_COOLDOWN_MS` (6 h), y al recuperarse el dato ('fiable' tras un
 * estado malo) se envía un aviso 'info'.
 *
 * Integración: `registerHealth` envuelve `ctx.broadcast` **antes** de que
 * market/macro lo capturen, así cada `data-status:changed` que escriben pasa
 * por `observe()` y las notificaciones salen al instante, sin esperar a la
 * evaluación periódica (`HEALTH_EVAL_INTERVAL_MS`, 15 min). Cada cambio
 * observado encola además una evaluación diferida (microtask) para que la
 * caducidad se aplique en cuanto cambia cualquier estado.
 *
 * Gancho de desarrollo: `data-status:simulate-provider-failure`, solo con
 * TRADIA_E2E y sin empaquetar. Activa el fallo persistente de los
 * proveedores simulados (mercado y macro) y fuerza una pasada para que los
 * estados y la notificación se vean como en un fallo real.
 */
import { app, ipcMain } from 'electron';

import {
  dataStatusKey,
  IPC_CHANNELS,
  IpcValidationError,
  isDataStatusState,
  isE2eEnabled,
  type DataStatusEntry,
  type DataStatusState,
  type NotificationPayload,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import * as nyseCalendar from './calendar';
import type { MarketSession } from './calendar';
import { createMarketRepository, type MarketRepository } from './repository';

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

/** Horas tras la hora de actualización antes de declarar el dato caducado. */
export const HEALTH_STALE_GRACE_MS = 12 * 3_600_000;
/** Agrupación de avisos repetidos del mismo estado: máximo uno cada 6 h. */
export const HEALTH_NOTIFY_COOLDOWN_MS = 6 * 3_600_000;
/** Cadencia de la evaluación programada de frescura. */
export const HEALTH_EVAL_INTERVAL_MS = 15 * 60_000;
/** Fallos seguidos del proveedor que declaran el dato 'no-fiable'. */
export const HEALTH_MAX_CONSECUTIVE_FAILURES = 3;

const DAY_MS = 86_400_000;

export type TimerHandle = ReturnType<typeof setTimeout>;

/** Lo que la vigilancia necesita del calendario de NYSE (inyectable). */
export interface HealthCalendar {
  lastExpectedSession(now: number): MarketSession | null;
  expectedSessionsBetween(desde: string, hasta: string): MarketSession[];
}

export interface DataHealthDeps {
  repo: MarketRepository;
  /** Emite `data-status:changed` al renderer (y de vuelta a `observe`). */
  broadcast(channel: string, payload: unknown): void;
  /** Punto único de notificaciones nativas. */
  notify?(payload: NotificationPayload): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Calendario de sesiones; por defecto el real de NYSE. */
  calendar?: HealthCalendar;
  /** Temporizadores inyectables para las pruebas; por defecto los globales. */
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  evalIntervalMs?: number;
  staleGraceMs?: number;
  notifyCooldownMs?: number;
  maxFailures?: number;
  logger?: { warn(message: string): void; info?(message: string): void };
}

export interface DataHealthService {
  /** Estados guardados (handler de `data-status:get`). */
  list(): DataStatusEntry[];
  /**
   * Evalúa la frescura de cada ticker de la lista y cada serie macro y
   * escribe los cambios en `data_status` (emitidos por `data-status:changed`).
   * Devuelve las entradas escritas en esta pasada.
   */
  evaluate(): DataStatusEntry[];
  /**
   * Procesa una entrada emitida por `data-status:changed`: aplica la regla
   * de 3 fallos, notifica los empeoramientos (con agrupación de 6 h) y los
   * avisos de recuperación, y encola una evaluación diferida.
   */
  observe(entry: DataStatusEntry): void;
  /** Evaluación inicial + temporizador periódico. Idempotente. */
  start(): void;
  stop(): void;
}

/** Severidad para decidir si un cambio es un empeoramiento. */
const SEVERITY: Record<DataStatusState, number> = {
  fiable: 0,
  actualizando: 0,
  desactualizado: 1,
  'no-fiable': 2,
};

const NOTIFY_LEVEL: Partial<Record<DataStatusState, NotificationPayload['level']>> = {
  desactualizado: 'alerta',
  'no-fiable': 'critica',
};

const isBad = (state: DataStatusState): boolean => SEVERITY[state] > 0;

const shiftDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Primer día del mes anterior al de `date` ('YYYY-MM-DD'). */
const firstOfPreviousMonth = (date: string): string => {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export function createDataHealthService(deps: DataHealthDeps): DataHealthService {
  const repo = deps.repo;
  const now = deps.now ?? (() => Date.now());
  const calendar = deps.calendar ?? nyseCalendar;
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const evalIntervalMs = deps.evalIntervalMs ?? HEALTH_EVAL_INTERVAL_MS;
  const staleGraceMs = deps.staleGraceMs ?? HEALTH_STALE_GRACE_MS;
  const notifyCooldownMs = deps.notifyCooldownMs ?? HEALTH_NOTIFY_COOLDOWN_MS;
  const maxFailures = deps.maxFailures ?? HEALTH_MAX_CONSECUTIVE_FAILURES;
  const logger = deps.logger;

  let started = false;
  let timer: TimerHandle | null = null;
  let evalQueued = false;
  /** Claves que estuvieron en estado malo desde el arranque del servicio. */
  const badSince = new Set<string>();
  /** Último aviso enviado por clave: estado y cuándo (agrupación de 6 h). */
  const notified = new Map<string, { state: DataStatusState; at: number }>();

  const emit = (patch: Parameters<MarketRepository['setDataStatus']>[0]): DataStatusEntry => {
    const entry = repo.setDataStatus(patch);
    deps.broadcast(IPC_CHANNELS.dataStatus.changed, entry);
    return entry;
  };

  // -- Nombres y textos de las notificaciones ---------------------------------

  const labelFor = (key: string): string => {
    if (key.startsWith('ticker:')) return key.slice('ticker:'.length);
    if (key.startsWith('macro:')) {
      const id = key.slice('macro:'.length);
      return repo.getMacroSeries(id)?.name ?? id;
    }
    if (key.startsWith('provider:')) return `proveedor '${key.slice('provider:'.length)}'`;
    return key;
  };

  const notifyState = (entry: DataStatusEntry): void => {
    const level = NOTIFY_LEVEL[entry.state];
    if (!level) return;
    const label = labelFor(entry.key);
    const title =
      entry.state === 'no-fiable'
        ? `Tradia — ${label} no fiable`
        : `Tradia — ${label} desactualizado`;
    const body =
      entry.reason ??
      (entry.state === 'no-fiable'
        ? 'Fallos repetidos del proveedor o un valor anómalo grave; el dato no se usará para cálculos.'
        : 'Faltan datos recientes; se muestra el último lote válido.');
    deps.notify?.({ level, title, body });
  };

  const notifyRecovery = (entry: DataStatusEntry): void => {
    const label = labelFor(entry.key);
    deps.notify?.({
      level: 'info',
      title: `Tradia — ${label} recuperado`,
      body: 'El dato vuelve a estar al día y es fiable.',
    });
  };

  // -- Cálculo de estado -------------------------------------------------------

  interface Desired {
    state: DataStatusState;
    reason: string | null;
    /** Solo en 'fiable': confirma el último dato bueno y limpia fallos. */
    confirmOk?: boolean;
  }

  /**
   * 'actualizando' reciente se respeta tal cual: el refresco en curso decidirá
   * el resultado. Devuelve null si la clave debe conservar su estado.
   */
  const respectsInFlight = (
    current: DataStatusEntry | null,
  ): { respected: boolean; current: DataStatusEntry | null } => {
    if (current?.state === 'actualizando' && now() - Date.parse(current.updatedAt) < staleGraceMs) {
      return { respected: true, current };
    }
    // Un 'actualizando' viejo (refresco colgado) ya no se preserva.
    return { respected: false, current: current?.state === 'actualizando' ? null : current };
  };

  const computeTicker = (ticker: string): Desired | null => {
    const key = dataStatusKey.ticker(ticker);
    const rawCurrent = repo.getDataStatus(key);
    if ((rawCurrent?.consecutiveFailures ?? 0) >= maxFailures) {
      return {
        state: 'no-fiable',
        reason: rawCurrent?.reason ?? `${maxFailures} fallos seguidos del proveedor`,
      };
    }
    // 'no-fiable' solo lo levanta un refresco con éxito (lo escribe el servicio).
    if (rawCurrent?.state === 'no-fiable') return null;

    const lastExpected = calendar.lastExpectedSession(now());
    if (lastExpected === null) return null;

    const { respected, current } = respectsInFlight(rawCurrent);
    if (respected) return null;

    const lastStored = repo.lastBarDate(ticker);
    if (lastStored === null && rawCurrent === null) {
      // Sin datos ni estado previo: el estado lo fija la primera ingesta.
      return null;
    }
    if (lastStored !== null && lastStored >= lastExpected.date) {
      return lastBatchHasAnomaly(ticker)
        ? { state: 'no-fiable', reason: 'valor anómalo grave en el último lote' }
        : { state: 'fiable', reason: null, confirmOk: true };
    }

    // Primera sesión esperada que falta: su hora de actualización marca el
    // plazo (una sesión nueva no reinicia la caducidad de una más antigua).
    const searchFrom = lastStored === null ? shiftDays(lastExpected.date, -31) : lastStored;
    const missing = calendar
      .expectedSessionsBetween(shiftDays(searchFrom, 1), lastExpected.date)
      .filter((s) => lastStored === null || s.date > lastStored);
    const firstMissing = missing[0] ?? lastExpected;
    const deadline = Date.parse(firstMissing.updateAtUtc) + staleGraceMs;
    if (now() >= deadline) {
      const extra = missing.length > 1 ? ` (+${missing.length - 1} más)` : '';
      return {
        state: 'desactualizado',
        reason: `falta la vela del ${firstMissing.date}${extra}; último dato: ${lastStored ?? 'sin datos'}`,
      };
    }
    // Dentro del plazo de 12 h: el último dato verificado sigue sirviendo.
    return { state: current?.state ?? 'fiable', reason: current?.reason ?? null };
  };

  /** true si el lote del que procede la vela más reciente tiene una anomalía. */
  const lastBatchHasAnomaly = (ticker: string): boolean => {
    const lastStored = repo.lastBarDate(ticker);
    if (lastStored === null) return false;
    const bars = repo.getBars(ticker, { desde: lastStored });
    const batchId = bars[bars.length - 1]?.batchId;
    if (batchId === undefined) return false;
    return repo.getQualityFlags({ batchId, kind: 'anomalo' }).length > 0;
  };

  /** Fecha mínima de observación esperada según la frecuencia de la serie. */
  const expectedMacroMinDate = (frequency: string | null, refDate: string): string => {
    if (frequency === 'monthly') return firstOfPreviousMonth(refDate);
    // Diaria (u otra): FRED publica con hasta una sesión de desfase.
    const prev = calendar
      .expectedSessionsBetween(shiftDays(refDate, -14), shiftDays(refDate, -1))
      .pop();
    return prev?.date ?? shiftDays(refDate, -1);
  };

  const computeMacro = (seriesId: string, frequency: string | null): Desired | null => {
    const rawCurrent = repo.getDataStatus(dataStatusKey.macro(seriesId));
    if ((rawCurrent?.consecutiveFailures ?? 0) >= maxFailures) {
      return {
        state: 'no-fiable',
        reason: rawCurrent?.reason ?? `${maxFailures} fallos seguidos del proveedor`,
      };
    }
    if (rawCurrent?.state === 'no-fiable') return null;

    const lastExpected = calendar.lastExpectedSession(now());
    if (lastExpected === null) return null;

    const { respected, current } = respectsInFlight(rawCurrent);
    if (respected) return null;

    const lastObs = repo.lastMacroObservationDate(seriesId);
    if (lastObs === null && rawCurrent === null) {
      // Sin datos ni estado previo: el estado lo fija el primer refresco.
      return null;
    }
    if (lastObs !== null && lastObs >= expectedMacroMinDate(frequency, lastExpected.date)) {
      return { state: 'fiable', reason: null, confirmOk: true };
    }
    const deadline = Date.parse(lastExpected.updateAtUtc) + staleGraceMs;
    if (now() >= deadline) {
      return {
        state: 'desactualizado',
        reason: `falta la observación esperada; último dato: ${lastObs ?? 'sin datos'}`,
      };
    }
    return { state: current?.state ?? 'fiable', reason: current?.reason ?? null };
  };

  const needsWrite = (current: DataStatusEntry | null, desired: Desired): boolean => {
    if (current === null) return true;
    return (
      current.state !== desired.state ||
      (current.reason ?? null) !== desired.reason ||
      (desired.confirmOk === true &&
        (current.consecutiveFailures !== 0 || current.lastOkAt === null))
    );
  };

  const applyDesired = (key: string, desired: Desired, written: DataStatusEntry[]): void => {
    const current = repo.getDataStatus(key);
    if (!needsWrite(current, desired)) return;
    written.push(
      emit({
        key,
        state: desired.state,
        reason: desired.reason,
        ...(desired.confirmOk === true ? { lastOkAt: isoNow(), consecutiveFailures: 0 } : {}),
      }),
    );
  };

  const isoNow = (): string => new Date(now()).toISOString();

  const evaluate = (): DataStatusEntry[] => {
    const written: DataStatusEntry[] = [];
    try {
      for (const { ticker } of repo.listWatchlist()) {
        const desired = computeTicker(ticker);
        if (desired) applyDesired(dataStatusKey.ticker(ticker), desired, written);
      }
      for (const series of repo.listMacroSeries()) {
        const desired = computeMacro(series.id, series.frequency);
        if (desired) applyDesired(dataStatusKey.macro(series.id), desired, written);
      }
    } catch (error: unknown) {
      logger?.warn(`[health] la evaluación de salud falló: ${String(error)}`);
    }
    return written;
  };

  // -- Observación de cambios ajenos ------------------------------------------

  const observe = (incoming: DataStatusEntry): void => {
    let entry = incoming;
    // Regla central de los 3 fallos: aunque el escritor dejara otro estado,
    // el contador manda y la clave pasa a 'no-fiable'.
    if (entry.state !== 'no-fiable' && (entry.consecutiveFailures ?? 0) >= maxFailures) {
      entry = emit({
        key: entry.key,
        state: 'no-fiable',
        reason: entry.reason ?? `${maxFailures} fallos seguidos del proveedor`,
      });
    }

    if (isBad(entry.state)) {
      badSince.add(entry.key);
      const last = notified.get(entry.key);
      const worsened = last === undefined || SEVERITY[entry.state] > SEVERITY[last.state];
      const repeatDue =
        last !== undefined && last.state === entry.state && now() - last.at >= notifyCooldownMs;
      if (worsened || repeatDue) {
        notifyState(entry);
        notified.set(entry.key, { state: entry.state, at: now() });
      }
    } else if (entry.state === 'fiable' && badSince.delete(entry.key)) {
      // El dato se recupera tras un estado malo: aviso 'info' una sola vez
      // (badSince queda limpio; si vuelve a fallar se notifica de nuevo).
      notified.delete(entry.key);
      notifyRecovery(entry);
    }

    // Cada cambio dispara una evaluación diferida: la caducidad se aplica en
    // cuanto hay actividad, no solo en la cita de cada 15 minutos.
    if (!evalQueued) {
      evalQueued = true;
      queueMicrotask(() => {
        evalQueued = false;
        evaluate();
      });
    }
  };

  // -- Ciclo de vida -----------------------------------------------------------

  const armTimer = (): void => {
    if (!started) return;
    timer = setTimer(() => {
      timer = null;
      evaluate();
      armTimer();
    }, evalIntervalMs);
    (timer as { unref?: () => void }).unref?.();
  };

  const service: DataHealthService = {
    list: () => repo.listDataStatus(),
    evaluate,
    observe,

    start: () => {
      if (started) return;
      started = true;
      // Semilla del estado visto: los estados malos ya guardados no cuentan
      // como empeoramientos nuevos (evita una tormenta de avisos al arrancar),
      // pero sí entran en badSince para avisar de su recuperación.
      for (const entry of repo.listDataStatus()) {
        if (isBad(entry.state)) badSince.add(entry.key);
      }
      evaluate();
      armTimer();
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

export interface RegisterHealthOptions {
  /** Reloj compartido con la ingesta (adelantable por `market:advance-clock`). */
  clock?: { now(): number };
  /** Reloj simple inyectable (pruebas). */
  now?: () => number;
  evalIntervalMs?: number;
  /** false para registrar el handler sin lanzar la evaluación (pruebas). */
  autoStart?: boolean;
}

const isDataStatusEntryLike = (value: unknown): value is DataStatusEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { key?: unknown }).key === 'string' &&
  isDataStatusState((value as { state?: unknown }).state);

export function registerHealth(
  ctx: ServiceContext,
  options: RegisterHealthOptions = {},
): DataHealthService {
  // Sin base de datos la vigilancia degrada a memoria (mismo patrón que
  // registerMarket): la app sigue arrancando.
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[health] almacén no disponible: la salud del dato solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createMarketRepository(db);

  const service = createDataHealthService({
    repo,
    // Indirección: usa el ctx.broadcast vigente en cada emisión (el envuelto
    // de abajo), así los cambios escritos por la propia vigilancia también
    // pasan por observe() y siguen la misma ruta de notificaciones.
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    notify: (payload) => ctx.services.notifications?.notify(payload),
    now: options.clock ? () => options.clock!.now() : options.now,
    evalIntervalMs: options.evalIntervalMs,
    logger: console,
  });

  // Intercepta los estados que escriben market/macro: sus `data-status:changed`
  // alimentan observe() al instante. Debe instalarse antes de que esos
  // servicios capturen ctx.broadcast en su registro.
  const previousBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    previousBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.dataStatus.changed && isDataStatusEntryLike(payload)) {
      service.observe(payload);
    }
  };

  ipcMain.handle(IPC_CHANNELS.dataStatus.get, () => service.list());

  // Gancho de desarrollo: solo con TRADIA_E2E y sin empaquetar. Activa el
  // fallo de los proveedores simulados y fuerza una pasada para que el
  // estado y la notificación se vean como en un fallo real; con `false`
  // restaura y refresca de nuevo.
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.dataStatus.simulateProviderFailure, async (_event, failing) => {
      if (typeof failing !== 'boolean') {
        throw new IpcValidationError(
          IPC_CHANNELS.dataStatus.simulateProviderFailure,
          'se esperaba un booleano',
        );
      }
      const kind = failing ? 'network' : null;
      ctx.services.market?.setProviderFailure?.(kind);
      ctx.services.macro?.setProviderFailure?.(kind);
      await ctx.services.macro?.refreshAll();
      await ctx.services.market?.refreshNow();
      return service.list();
    });
  }

  if (options.autoStart ?? true) service.start();
  return service;
}
