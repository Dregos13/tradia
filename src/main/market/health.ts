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
  type DataFreshnessItem,
  type DataFreshnessState,
  type DataFreshnessSummary,
  type DataStatusEntry,
  type DataStatusState,
  type NotificationPayload,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import * as nyseCalendar from './calendar';
import { bondCalendar } from './calendar';
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
/**
 * Silencio que cierra la ventana de puesta al día: entre dos activos de
 * la misma pasada puede no haber ningún 'actualizando' un instante;
 * pasado este margen sin trabajo nuevo, la pasada se da por terminada.
 */
export const HEALTH_CATCHUP_QUIET_MS = 15_000;

const DAY_MS = 86_400_000;

/**
 * Series macro que siguen el calendario del mercado de bonos / Reserva
 * Federal (SIFMA) en lugar del de NYSE: el Tesoro y la Fed no publican en
 * Columbus Day ni Veterans Day, días en que la bolsa sí abre.
 */
const BOND_CALENDAR_SERIES = new Set(['DFF', 'DGS2', 'DGS10', 'T10Y2Y']);

/**
 * Margen de publicación de las series mensuales: FRED recibe el dato del
 * mes M-1 hacia mediados/finales de M (el IPC sale sobre el día 10–14 y
 * otras series a final de mes), así que hasta este día solo se exige el
 * dato de M-2; a partir de él, el de M-1.
 */
const MONTHLY_PUBLICATION_DAY = 20;

/** Nombres legibles de los proveedores conocidos (franja y resumen de frescura). */
const PROVIDER_LABELS: Record<string, string> = {
  tiingo: 'Tiingo',
  fred: 'FRED',
  simulated: 'Proveedor simulado',
  'macro-simulated': 'Proveedor macro simulado',
};
const MACRO_PROVIDER_IDS = new Set(['fred', 'macro-simulated']);

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
  /** Silencio que cierra la ventana de puesta al día; por defecto 15 s. */
  catchupQuietMs?: number;
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
  /**
   * Resumen único «Datos desactualizados desde …» (`data-status:freshness`):
   * agrega los estados ticker/macro/proveedor con la fecha real del último
   * dato de cada uno.
   */
  freshness(): DataFreshnessSummary;
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
  const catchupQuietMs = deps.catchupQuietMs ?? HEALTH_CATCHUP_QUIET_MS;
  const logger = deps.logger;

  let started = false;
  let timer: TimerHandle | null = null;
  let evalQueued = false;
  /** Claves que estuvieron en estado malo desde el arranque del servicio. */
  const badSince = new Set<string>();
  /** Último aviso enviado por clave: estado y cuándo (agrupación de 6 h). */
  const notified = new Map<string, { state: DataStatusState; at: number }>();
  /**
   * Ventana de puesta al día en curso: claves 'ticker:*'/'macro:*' que
   * pasaron por 'actualizando' en esta pasada. Se cierra cuando todo lo
   * pendiente quedó procesado o tras `catchupQuietMs` sin novedad.
   */
  const catchUpTouched = new Set<string>();
  let catchUpLastActivity = Number.NEGATIVE_INFINITY;

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
    if (key.startsWith('modelo:')) return `modelo v${key.slice('modelo:'.length)}`;
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
    /**
     * Solo en 'no-fiable': la causa es el contenido del dato (valor
     * anómalo, lote rechazado), no fallos del proveedor. Deja
     * `consecutiveFailures` en 0 para que la parada de emergencia la
     * distinga de una caída de red: un proveedor caído nunca dispara la
     * parada, una anomalía de mercado sí.
     */
    anomaly?: boolean;
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
        ? { state: 'no-fiable', reason: 'valor anómalo grave en el último lote', anomaly: true }
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

  /** Calendario de publicación de la serie: bonos/Fed para las del Tesoro, NYSE para el resto. */
  const calendarForSeries = (seriesId: string): HealthCalendar =>
    BOND_CALENDAR_SERIES.has(seriesId) ? bondCalendar : calendar;

  /**
   * Fecha mínima de observación esperada de una serie mensual: el dato del
   * mes M-1 no se exige hasta `MONTHLY_PUBLICATION_DAY` de M (FRED lo
   * recibe hacia mediados/finales de mes); antes basta el de M-2.
   */
  const monthlyExpectedMinDate = (refDate: string): string => {
    const [y, m, d] = refDate.split('-').map(Number) as [number, number, number];
    const back = d < MONTHLY_PUBLICATION_DAY ? 3 : 2;
    return new Date(Date.UTC(y, m - back, 1)).toISOString().slice(0, 10);
  };

  /** Fecha mínima de observación esperada según la frecuencia y el calendario de la serie. */
  const expectedMacroMinDate = (
    seriesId: string,
    frequency: string | null,
    refDate: string,
  ): string => {
    if (frequency === 'monthly') return monthlyExpectedMinDate(refDate);
    // Diaria (u otra): el proveedor publica con hasta una sesión de desfase,
    // contada sobre el calendario propio de la serie.
    const prev = calendarForSeries(seriesId)
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

    const lastExpected = calendarForSeries(seriesId).lastExpectedSession(now());
    if (lastExpected === null) return null;

    const { respected, current } = respectsInFlight(rawCurrent);
    if (respected) return null;

    const lastObs = repo.lastMacroObservationDate(seriesId);
    if (lastObs === null && rawCurrent === null) {
      // Sin datos ni estado previo: el estado lo fija el primer refresco.
      return null;
    }
    if (
      lastObs !== null &&
      lastObs >= expectedMacroMinDate(seriesId, frequency, lastExpected.date)
    ) {
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

  // -- Frescura por proveedor ---------------------------------------------------

  /**
   * Claves 'ticker:*'/'macro:*' que alimenta un proveedor: sus series
   * propias en los proveedores macro; el seguimiento completo en los de
   * mercado (el proveedor de velas sirve a toda la lista).
   */
  const providerChildKeys = (providerId: string): string[] => {
    if (MACRO_PROVIDER_IDS.has(providerId)) {
      return repo
        .listMacroSeries()
        .filter((series) => series.source === providerId)
        .map((series) => dataStatusKey.macro(series.id));
    }
    return repo.listWatchlist().map((item) => dataStatusKey.ticker(item.ticker));
  };

  /**
   * La misma regla de frescura aplicada al proveedor: si alguno de sus
   * hijos quedó 'desactualizado'/'no-fiable' el proveedor sirve datos
   * viejos aunque responda bien (caso del proveedor que solo publica
   * hasta una fecha antigua), y se dice con la fecha real del último
   * dato. Al revés, con los hijos al día un 'desactualizado' que no era
   * de fallos (consecutiveFailures en 0) vuelve a 'fiable'. Los
   * 'no-fiable' y las cuentas de fallos solo los levanta un refresco con
   * éxito, que escribe el propio servicio.
   */
  const computeProvider = (providerId: string): Desired | null => {
    const key = dataStatusKey.provider(providerId);
    const rawCurrent = repo.getDataStatus(key);
    if (rawCurrent === null) return null;
    if ((rawCurrent.consecutiveFailures ?? 0) >= maxFailures) {
      return {
        state: 'no-fiable',
        reason: rawCurrent.reason ?? `${maxFailures} fallos seguidos del proveedor`,
      };
    }
    if (rawCurrent.state === 'no-fiable') return null;

    const { respected } = respectsInFlight(rawCurrent);
    if (respected) return null;

    const children = providerChildKeys(providerId);
    if (children.length === 0) return null;

    let oldestBadDate: string | null = null;
    let anyBad = false;
    for (const childKey of children) {
      const child = repo.getDataStatus(childKey);
      if (child === null || !isBad(child.state)) continue;
      anyBad = true;
      const date = lastDataDateFor(childKey);
      if (date !== null && (oldestBadDate === null || date < oldestBadDate)) {
        oldestBadDate = date;
      }
    }
    if (anyBad) {
      return {
        state: 'desactualizado',
        reason:
          oldestBadDate === null
            ? 'el proveedor no tiene el dato esperado todavía'
            : `faltan datos recientes; último dato: ${oldestBadDate}`,
      };
    }
    if (rawCurrent.state !== 'fiable' && (rawCurrent.consecutiveFailures ?? 0) === 0) {
      return { state: 'fiable', reason: null, confirmOk: true };
    }
    return null;
  };

  const needsWrite = (current: DataStatusEntry | null, desired: Desired): boolean => {
    if (current === null) return true;
    return (
      current.state !== desired.state ||
      (current.reason ?? null) !== desired.reason ||
      (desired.confirmOk === true &&
        (current.consecutiveFailures !== 0 || current.lastOkAt === null)) ||
      (desired.anomaly === true && current.consecutiveFailures !== 0)
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
        // Una anomalía de contenido queda marcada con fallos en 0: la
        // parada de emergencia distingue así 'no-fiable' por dato malo
        // (para) de 'no-fiable' por proveedor caído (no para).
        ...(desired.anomaly === true ? { consecutiveFailures: 0 } : {}),
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
      // Los proveedores se evalúan al final: su frescura es la de sus
      // hijos (tickers y series), ya escritos en esta misma pasada.
      for (const entry of repo.listDataStatus()) {
        if (!entry.key.startsWith('provider:')) continue;
        const desired = computeProvider(entry.key.slice('provider:'.length));
        if (desired) applyDesired(entry.key, desired, written);
      }
    } catch (error: unknown) {
      logger?.warn(`[health] la evaluación de salud falló: ${String(error)}`);
    }
    return written;
  };

  // -- Observación de cambios ajenos ------------------------------------------

  const observe = (incoming: DataStatusEntry): void => {
    let entry = incoming;
    // Ventana de puesta al día: cada activo o serie que entra en
    // 'actualizando' se apunta para el progreso del resumen de frescura.
    if (
      (entry.key.startsWith('ticker:') || entry.key.startsWith('macro:')) &&
      entry.state === 'actualizando'
    ) {
      catchUpTouched.add(entry.key);
      catchUpLastActivity = now();
    }
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
        if (entry.key.startsWith('ticker:') && entry.consecutiveFailures > 0) {
          // La ingesta publica primero el activo y después su proveedor.
          // Espera a ambos estados para emitir un solo aviso por la caída.
          const failedEntry = entry;
          queueMicrotask(() => {
            const providerIncident = repo
              .listDataStatus()
              .some(
                (status) =>
                  status.key.startsWith('provider:') &&
                  status.consecutiveFailures > 0 &&
                  status.reason === failedEntry.reason &&
                  status.updatedAt >= failedEntry.updatedAt &&
                  SEVERITY[status.state] >= SEVERITY[failedEntry.state],
              );
            if (!providerIncident) notifyState(failedEntry);
          });
        } else {
          notifyState(entry);
        }
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

  // -- Resumen único de frescura ----------------------------------------------

  /** Etiqueta legible de una clave de estado para el resumen. */
  const freshnessLabel = (key: string): string => {
    if (key.startsWith('ticker:')) return key.slice('ticker:'.length);
    if (key.startsWith('macro:')) {
      const id = key.slice('macro:'.length);
      return repo.getMacroSeries(id)?.name ?? id;
    }
    if (key.startsWith('provider:')) {
      const id = key.slice('provider:'.length);
      return PROVIDER_LABELS[id] ?? `proveedor '${id}'`;
    }
    return key;
  };

  /** Fecha real del último dato conocido de una clave ('YYYY-MM-DD'), o null. */
  const lastDataDateFor = (key: string): string | null => {
    if (key.startsWith('ticker:')) return repo.lastBarDate(key.slice('ticker:'.length));
    if (key.startsWith('macro:')) {
      return repo.lastMacroObservationDate(key.slice('macro:'.length));
    }
    if (key.startsWith('provider:')) {
      const providerId = key.slice('provider:'.length);
      const dates: string[] = [];
      if (MACRO_PROVIDER_IDS.has(providerId)) {
        for (const series of repo.listMacroSeries()) {
          if (series.source !== providerId) continue;
          const date = repo.lastMacroObservationDate(series.id);
          if (date !== null) dates.push(date);
        }
      } else {
        for (const { ticker } of repo.listWatchlist()) {
          const date = repo.lastBarDate(ticker);
          if (date !== null) dates.push(date);
        }
      }
      return dates.sort().at(-1) ?? null;
    }
    return null;
  };

  /**
   * Claves que una pasada todavía tendría que traer: el dato guardado
   * queda por detrás de lo que espera la regla de frescura de cada
   * ámbito (vela de la última sesión para los tickers; observación
   * mínima según frecuencia y calendario para las series).
   */
  const pendingFetchKeys = (): Set<string> => {
    const pending = new Set<string>();
    const lastExpected = calendar.lastExpectedSession(now());
    if (lastExpected === null) return pending;
    for (const { ticker } of repo.listWatchlist()) {
      const last = repo.lastBarDate(ticker);
      if (last === null || last < lastExpected.date) {
        pending.add(dataStatusKey.ticker(ticker));
      }
    }
    for (const series of repo.listMacroSeries()) {
      const lastObs = repo.lastMacroObservationDate(series.id);
      const expectedMin = expectedMacroMinDate(series.id, series.frequency, lastExpected.date);
      if (lastObs === null || lastObs < expectedMin) {
        pending.add(dataStatusKey.macro(series.id));
      }
    }
    return pending;
  };

  /** true si la entrada sigue en 'actualizando' dentro del margen. */
  const isInFlight = (key: string): boolean => {
    const entry = repo.getDataStatus(key);
    return entry?.state === 'actualizando' && now() - Date.parse(entry.updatedAt) < staleGraceMs;
  };

  /**
   * La ventana de puesta al día está activa mientras quede algún
   * 'actualizando' en vuelo o trabajo pendiente que la pasada aún no
   * tocó, y solo durante `catchupQuietMs` desde la última novedad. Así
   * el resumen muestra 'catching-up' durante toda la pasada —no solo en
   * el instante en que hay una descarga en el aire— y vuelve a 'stale'
   * si el proveedor no puede completar lo que falta.
   */
  const catchUpActive = (): boolean => {
    if (catchUpTouched.size === 0) return false;
    for (const key of catchUpTouched) {
      if (isInFlight(key)) return true;
    }
    const pending = pendingFetchKeys();
    const untouchedPending = [...pending].some((key) => !catchUpTouched.has(key));
    return untouchedPending && now() - catchUpLastActivity < catchupQuietMs;
  };

  /**
   * Progreso de la pasada en curso: `total` son los activos y series
   * que hay que poner al día (los ya tocados por la pasada más los que
   * aún le quedan por traer); `done`, los que ya terminaron, con éxito
   * o con error.
   */
  const catchUpProgress = (): { done: number; total: number } => {
    const total = new Set<string>([...catchUpTouched, ...pendingFetchKeys()]);
    let done = 0;
    for (const key of total) {
      if (catchUpTouched.has(key) && !isInFlight(key)) done += 1;
    }
    return { done, total: total.size };
  };

  const freshness = (): DataFreshnessSummary => {
    const entries = repo
      .listDataStatus()
      .filter(
        (entry) =>
          entry.key.startsWith('ticker:') ||
          entry.key.startsWith('macro:') ||
          entry.key.startsWith('provider:'),
      );
    // Los 'actualizando' escritos sin pasar por observe() (p. ej. antes
    // de que la vigilancia envolviera broadcast) también abren ventana.
    for (const entry of entries) {
      if (
        (entry.key.startsWith('ticker:') || entry.key.startsWith('macro:')) &&
        entry.state === 'actualizando'
      ) {
        catchUpTouched.add(entry.key);
        catchUpLastActivity = Math.max(catchUpLastActivity, Date.parse(entry.updatedAt));
      }
    }
    // La pasada terminada (o caducada por silencio) cierra la ventana.
    if (!catchUpActive()) catchUpTouched.clear();

    // Hijos cuyo último dato guardado queda por detrás de lo exigible
    // ahora (sin requerir que una pasada los haya marcado). Un hijo sin
    // datos todavía no cuenta: no hay «último dato» que caducar —el
    // estado 'sin datos' lo da el conjunto, no el fallo del proveedor.
    const behind = new Set<string>();
    const lastExpectedForBehind = calendar.lastExpectedSession(now());
    if (lastExpectedForBehind !== null) {
      for (const { ticker } of repo.listWatchlist()) {
        const last = repo.lastBarDate(ticker);
        if (last !== null && last < lastExpectedForBehind.date) {
          behind.add(dataStatusKey.ticker(ticker));
        }
      }
      for (const series of repo.listMacroSeries()) {
        const lastObs = repo.lastMacroObservationDate(series.id);
        if (
          lastObs !== null &&
          lastObs < expectedMacroMinDate(series.id, series.frequency, lastExpectedForBehind.date)
        ) {
          behind.add(dataStatusKey.macro(series.id));
        }
      }
    }

    const items: DataFreshnessItem[] = [];
    let updating = catchUpTouched.size > 0;
    for (const entry of entries) {
      if (entry.state === 'actualizando') {
        // Un 'actualizando' colgado no cuenta como «poniéndose al día».
        if (now() - Date.parse(entry.updatedAt) < staleGraceMs) updating = true;
        continue;
      }
      if (!isBad(entry.state)) continue;
      if (entry.key.startsWith('provider:')) {
        // Un proveedor en mal estado solo pesa en la frescura cuando a
        // alguno de sus hijos le falta dato: con los datos al día su
        // fallo queda en data_status y en Ajustes, pero no hay nada
        // desactualizado —y menos con una fecha «desde» posterior a la
        // sesión esperada—.
        const behindChildren = providerChildKeys(entry.key.slice('provider:'.length)).filter(
          (child) => behind.has(child),
        );
        if (behindChildren.length === 0) continue;
        items.push({
          key: entry.key,
          label: freshnessLabel(entry.key),
          state: entry.state,
          // «Desde cuándo falta dato»: el hijo atrasado más viejo, no el
          // más fresco que sirvió el proveedor.
          lastDataDate:
            behindChildren
              .map((child) => lastDataDateFor(child))
              .filter((date): date is string => date !== null)
              .sort()[0] ?? null,
          reason: entry.reason,
        });
        continue;
      }
      items.push({
        key: entry.key,
        label: freshnessLabel(entry.key),
        state: entry.state,
        lastDataDate: lastDataDateFor(entry.key),
        reason: entry.reason,
      });
    }

    // Atraso por calendario aunque ninguna pasada lo haya escrito: sin
    // red o antes de la primera evaluación, un dato viejo no espera a
    // que observe/evaluate lo marque — la frescura lo calcula igual.
    const covered = new Set(items.map((item) => item.key));
    for (const { ticker } of repo.listWatchlist()) {
      const key = dataStatusKey.ticker(ticker);
      if (covered.has(key)) continue;
      const desired = computeTicker(ticker);
      if (desired !== null && isBad(desired.state)) {
        items.push({
          key,
          label: ticker,
          state: desired.state,
          lastDataDate: repo.lastBarDate(ticker),
          reason: desired.reason,
        });
      }
    }
    for (const series of repo.listMacroSeries()) {
      const key = dataStatusKey.macro(series.id);
      if (covered.has(key)) continue;
      const desired = computeMacro(series.id, series.frequency);
      if (desired !== null && isBad(desired.state)) {
        items.push({
          key,
          label: series.name,
          state: desired.state,
          lastDataDate: repo.lastMacroObservationDate(series.id),
          reason: desired.reason,
        });
      }
    }

    // Las más antiguas primero: el último dato más viejo marca el «desde».
    items.sort((a, b) => (a.lastDataDate ?? '9999').localeCompare(b.lastDataDate ?? '9999'));

    // 'catching-up' por encima de 'stale': mientras corre la puesta al
    // día el aviso es «Poniéndose al día…», no «desactualizado».
    const state: DataFreshnessState = items.some((item) => item.state === 'no-fiable')
      ? 'unreliable'
      : updating
        ? 'catching-up'
        : items.length > 0
          ? 'stale'
          : entries.some((entry) => entry.lastOkAt !== null)
            ? 'current'
            : 'no-data';

    const lastExpected = calendar.lastExpectedSession(now());
    const expectedSessionDate = lastExpected?.date ?? null;
    const sinceDate =
      items
        .map((item) => item.lastDataDate)
        .filter((date): date is string => date !== null)
        .sort()[0] ?? null;
    const missingSessions =
      sinceDate !== null && expectedSessionDate !== null && sinceDate < expectedSessionDate
        ? calendar.expectedSessionsBetween(shiftDays(sinceDate, 1), expectedSessionDate).length
        : 0;
    return {
      state,
      sinceDate,
      expectedSessionDate,
      missingSessions,
      items,
      // Solo durante la puesta al día: «Descargando X de Y activos».
      progress: state === 'catching-up' ? catchUpProgress() : null,
      updatedAt: isoNow(),
    };
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
    freshness,

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
  ipcMain.handle(IPC_CHANNELS.dataStatus.freshness, () => service.freshness());

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
