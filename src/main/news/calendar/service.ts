/**
 * Servicio del calendario económico y de resultados — Fase 1b.
 *
 * Repositorio sobre `calendar_events` (migración 004) + servicio que:
 *
 * - Regenera el calendario en una ventana móvil (desde hace
 *   `CALENDAR_PAST_DAYS` días hasta dentro de `CALENDAR_FUTURE_DAYS`):
 *   fechas por regla (NFP, EIA, ISM/PMI, vencimientos), fechas publicadas
 *   por los organismos (FOMC, IPC, PCE, PIB y OPEP, 2026-2027) y los
 *   resultados de los activos seguidos desde Finnhub cuando hay clave
 *   (simulado solo con TRADIA_E2E).
 * - Guarda con `INSERT ... ON CONFLICT(clave) DO UPDATE`, así el `id` de
 *   cada evento es estable entre refrescos (lo referencia
 *   `notification_log`) y borra solo los eventos de la ventana que ya no
 *   se generan (correcciones de tabla, ticker quitado de la lista).
 * - Refresca a diario (00:05 UTC), al reanudar el equipo y cuando cambia
 *   la watchlist (`onWatchlistChanged` del servicio de mercado).
 * - Sirve `calendar:list` por rango de fechas civiles y emite
 *   `calendar:updated` cuando una pasada cambia algo.
 *
 * Gancho de desarrollo: con reloj inyectado, `advanceClock` adelanta el
 * reloj y reevalúa; el handler `news:advance-clock` (lector de noticias)
 * debe invocarlo para que el calendario avance al mismo paso.
 */
import type Database from 'better-sqlite3';
import { app, ipcMain, powerMonitor } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isCalendarListQuery,
  isE2eEnabled,
  type CalendarEvent,
  type CalendarListQuery,
  type CalendarUpdatedEvent,
} from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import { createMarketClock } from '../../market/ingestion';
import type { ServiceContext } from '../../services';
import { connectorFetch } from '../connectors';
import {
  createFinnhubEarnings,
  createSimulatedEarnings,
  FINNHUB_SECRETS_KEY,
  type EarningsProvider,
} from './earnings';
import { earningsToEvent, generateCalendarEvents, type GeneratedCalendarEvent } from './generate';

/** Días hacia atrás y hacia adelante que cubre cada regeneración. */
export const CALENDAR_PAST_DAYS = 45;
export const CALENDAR_FUTURE_DAYS = 400;
/** Instante del refresco diario programado (00:05 UTC del día siguiente). */
const DAILY_REFRESH = { hour: 0, minute: 5 } as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Repositorio (tabla calendar_events)
// ---------------------------------------------------------------------------

interface EventRow {
  id: number;
  tipo: CalendarEvent['kind'];
  titulo: string;
  fecha_utc: string;
  impacto: CalendarEvent['impact'];
  pais: string | null;
  activo: string | null;
  origen: string;
}

const toCalendarEvent = (row: EventRow): CalendarEvent => ({
  id: row.id,
  kind: row.tipo,
  title: row.titulo,
  dateUtc: row.fecha_utc,
  impact: row.impacto,
  country: row.pais,
  asset: row.activo,
  origin: row.origen,
});

export interface CalendarRepository {
  /** Eventos cuyo instante UTC cae entre `desde` y `hasta` ('YYYY-MM-DD', inclusive). */
  listInRange(desde: string, hasta: string): CalendarEvent[];
  /**
   * Inserta o actualiza por `clave` conservando el `id` existente (lo
   * referencia `notification_log`); devuelve las filas que cambiaron.
   */
  upsert(events: readonly GeneratedCalendarEvent[]): number;
  /**
   * Borra los eventos dentro de la ventana UTC que ya no se generan.
   * `preserveKinds` salva tipos enteros (p. ej. 'resultados' cuando el
   * proveedor de earnings falló y no hay datos nuevos que comparar).
   */
  pruneStale(
    desdeUtc: string,
    hastaUtc: string,
    keep: ReadonlySet<string>,
    preserveKinds?: readonly string[],
  ): number;
}

export function createCalendarRepository(db: Database.Database): CalendarRepository {
  const selectRange = db.prepare(`
    SELECT id, tipo, titulo, fecha_utc, impacto, pais, activo, origen
    FROM calendar_events
    WHERE fecha_utc >= ? AND fecha_utc <= ?
    ORDER BY fecha_utc, id
  `);
  const upsertStmt = db.prepare(`
    INSERT INTO calendar_events (tipo, titulo, fecha_utc, impacto, pais, activo, origen, clave)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (clave) DO UPDATE SET
      tipo = excluded.tipo,
      titulo = excluded.titulo,
      fecha_utc = excluded.fecha_utc,
      impacto = excluded.impacto,
      pais = excluded.pais,
      activo = excluded.activo,
      origen = excluded.origen,
      actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    -- Solo reescribe si algo cambió de verdad (IS NOT = distinto, nulo-seguro):
    -- así actualizado_en no se toca en cada pasada y el servicio sabe si
    -- hubo cambios reales antes de emitir calendar:updated.
    WHERE excluded.tipo IS NOT calendar_events.tipo
       OR excluded.titulo IS NOT calendar_events.titulo
       OR excluded.fecha_utc IS NOT calendar_events.fecha_utc
       OR excluded.impacto IS NOT calendar_events.impacto
       OR excluded.pais IS NOT calendar_events.pais
       OR excluded.activo IS NOT calendar_events.activo
       OR excluded.origen IS NOT calendar_events.origen
  `);
  const selectClaves = db.prepare(
    'SELECT clave, tipo FROM calendar_events WHERE fecha_utc >= ? AND fecha_utc <= ?',
  );
  const deleteByClave = db.prepare('DELETE FROM calendar_events WHERE clave = ?');

  return {
    listInRange: (desde, hasta) =>
      (selectRange.all(`${desde}T00:00:00.000Z`, `${hasta}T23:59:59.999Z`) as EventRow[]).map(
        toCalendarEvent,
      ),

    upsert: (events) => {
      let changed = 0;
      for (const event of events) {
        changed += upsertStmt.run(
          event.kind,
          event.title,
          event.dateUtc,
          event.impact,
          event.country,
          event.asset,
          event.origin,
          event.clave,
        ).changes;
      }
      return changed;
    },

    pruneStale: (desdeUtc, hastaUtc, keep, preserveKinds = []) => {
      const preserve = new Set<string>(preserveKinds);
      const stale = (
        selectClaves.all(desdeUtc, hastaUtc) as Array<{
          clave: string;
          tipo: string;
        }>
      ).filter((row) => !keep.has(row.clave) && !preserve.has(row.tipo));
      let removed = 0;
      for (const row of stale) removed += deleteByClave.run(row.clave).changes;
      return removed;
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export interface CalendarRefreshResult {
  /** Eventos generados en la pasada (macro + resultados). */
  generated: number;
  /** true si la pasada cambió la tabla (alta, actualización o borrado). */
  changed: boolean;
  /** Origen del proveedor de resultados usado, o null si no hubo. */
  earningsOrigin: 'finnhub' | 'simulado' | null;
  /** ISO 8601 del instante de la pasada. */
  refreshedAt: string;
}

export interface CalendarPowerMonitorLike {
  on(event: 'resume', listener: () => void): unknown;
  removeListener(event: 'resume', listener: () => void): unknown;
}

/** Reloj con avance manual; `MarketClock` y `NewsClock` cumplen esta forma. */
export interface CalendarClock {
  now(): number;
  /** Adelanta el reloj `deltaMs` y devuelve el nuevo instante (ms epoch). */
  advance(deltaMs: number): number;
}

export interface CalendarServiceDeps {
  repo: CalendarRepository;
  broadcast(channel: string, payload: unknown): void;
  /** Tickers de la lista de seguimiento (del servicio de mercado). */
  getWatchedTickers?: () => string[];
  /** Proveedor de resultados en cada pasada; null si no toca ninguno. */
  resolveEarnings?: () => Promise<EarningsProvider | null>;
  /** false sin conexión: se regenera lo local pero no se llama a Finnhub. */
  isOnline?: () => boolean;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Reloj con avance manual; habilita `advanceClock` (desarrollo). */
  clock?: CalendarClock;
  /** Recuperación al volver de la suspensión. */
  powerMonitor?: CalendarPowerMonitorLike;
  logger?: Partial<{ info(m: string): void; warn(m: string): void; error(m: string): void }>;
}

export interface CalendarService {
  /** Eventos del rango pedido por `calendar:list` (fechas civiles, inclusive). */
  list(query: CalendarListQuery): CalendarEvent[];
  /**
   * Regenera la ventana móvil y persiste los cambios; emite
   * `calendar:updated` si la tabla cambió. Devuelve el resultado de la
   * pasada para pruebas y diagnósticos.
   */
  refresh(): Promise<CalendarRefreshResult>;
  /** Gancho de desarrollo: avanza el reloj y reevalúa (necesita `clock`). */
  advanceClock?(deltaMs: number): { now: string };
  /** Primera pasada + programación diaria; resuelve al terminar la primera. */
  start(): Promise<void>;
  stop(): void;
}

/** Lunes…domingo: ventana civil [desde, hasta] de una pasada. */
function refreshWindow(nowMs: number): {
  desde: string;
  hasta: string;
  desdeUtc: string;
  hastaUtc: string;
} {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const desde = new Date(Date.parse(`${today}T00:00:00.000Z`) - CALENDAR_PAST_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const hasta = new Date(Date.parse(`${today}T00:00:00.000Z`) + CALENDAR_FUTURE_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return {
    desde,
    hasta,
    desdeUtc: `${desde}T00:00:00.000Z`,
    hastaUtc: `${hasta}T23:59:59.999Z`,
  };
}

export function createCalendarService(deps: CalendarServiceDeps): CalendarService {
  const repo = deps.repo;
  const now = deps.clock ? deps.clock.now : (deps.now ?? (() => Date.now()));
  const isOnline = deps.isOnline ?? (() => true);
  const getWatchedTickers = deps.getWatchedTickers ?? (() => []);
  const logger = deps.logger ?? console;

  let started = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<CalendarRefreshResult> | null = null;

  const isoNow = (): string => new Date(now()).toISOString();

  const safeResolveEarnings = async (): Promise<EarningsProvider | null> => {
    try {
      return (await deps.resolveEarnings?.()) ?? null;
    } catch (error: unknown) {
      logger.error?.(`[calendar] no se pudo resolver el proveedor de resultados: ${String(error)}`);
      return null;
    }
  };

  const runRefresh = (): Promise<CalendarRefreshResult> => {
    // Una sola pasada en vuelo: las llamadas concurrentes comparten promesa.
    if (running) return running;
    const task = (async (): Promise<CalendarRefreshResult> => {
      const window = refreshWindow(now());
      const generated: GeneratedCalendarEvent[] = generateCalendarEvents(
        window.desde,
        window.hasta,
      );

      // Resultados de los activos seguidos: si el proveedor falla se
      // conservan los 'resultados' guardados (no hay datos con los que
      // comparar); si no hay proveedor configurado se podan igual que el
      // resto (la vista muestra el aviso de clave Finnhub).
      const preserveKinds: string[] = [];
      let earningsOrigin: CalendarRefreshResult['earningsOrigin'] = null;
      if (!isOnline()) {
        preserveKinds.push('resultados');
      } else {
        const provider = await safeResolveEarnings();
        if (provider !== null) {
          const tickers = getWatchedTickers();
          try {
            for (const entry of await provider.fetch(tickers, window.desde, window.hasta)) {
              generated.push(earningsToEvent(entry, provider.id));
            }
            earningsOrigin = provider.id;
          } catch (error: unknown) {
            preserveKinds.push('resultados');
            logger.warn?.(
              `[calendar] resultados no actualizados (${provider.id}): ${String(error)}`,
            );
          }
        }
      }

      const keep = new Set(generated.map((event) => event.clave));
      const changed =
        repo.upsert(generated) +
          repo.pruneStale(window.desdeUtc, window.hastaUtc, keep, preserveKinds) >
        0;
      if (changed) {
        const updated: CalendarUpdatedEvent = { updatedAt: isoNow() };
        deps.broadcast(IPC_CHANNELS.calendar.updated, updated);
      }
      return { generated: generated.length, changed, earningsOrigin, refreshedAt: isoNow() };
    })();
    running = task;
    task.finally(() => {
      if (running === task) running = null;
    });
    return task;
  };

  // -- Programación -----------------------------------------------------------

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const armDaily = (): void => {
    if (!started) return;
    const nowMs = now();
    const day = new Date(nowMs);
    const next =
      Date.UTC(
        day.getUTCFullYear(),
        day.getUTCMonth(),
        day.getUTCDate() + 1,
        DAILY_REFRESH.hour,
        DAILY_REFRESH.minute,
      ) - nowMs;
    clearTimer();
    timer = setTimeout(
      () => {
        timer = null;
        void evaluateSafely();
      },
      Math.max(0, next),
    );
    // El temporizador no debe mantener vivo el proceso por sí solo.
    timer.unref?.();
  };

  const evaluateSafely = (): Promise<void> =>
    runRefresh()
      .then(() => {
        armDaily();
      })
      .catch((error: unknown) => {
        logger.error?.(`[calendar] la pasada programada falló: ${String(error)}`);
        armDaily();
      });

  const onResume = (): void => {
    logger.info?.('[calendar] el equipo despertó; se regenera el calendario');
    void evaluateSafely();
  };

  const service: CalendarService = {
    list: (query) => repo.listInRange(query.desde, query.hasta),

    refresh: runRefresh,

    ...(deps.clock
      ? {
          advanceClock: (deltaMs: number): { now: string } => {
            const instant = deps.clock!.advance(deltaMs);
            logger.info?.(`[calendar] reloj adelantado ${deltaMs} ms (desarrollo)`);
            void evaluateSafely();
            return { now: new Date(instant).toISOString() };
          },
        }
      : {}),

    start: () => {
      if (started) return Promise.resolve();
      started = true;
      deps.powerMonitor?.on('resume', onResume);
      return evaluateSafely();
    },

    stop: () => {
      started = false;
      clearTimer();
      deps.powerMonitor?.removeListener('resume', onResume);
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Registro en la app (canal calendar:list + evento calendar:updated)
// ---------------------------------------------------------------------------

export function registerCalendar(ctx: ServiceContext): CalendarService {
  // Sin almacén el servicio no puede persistir: se degrada a memoria para
  // que el resto de la app siga arrancando (mismo patrón que market).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[calendar] almacén no disponible: el calendario solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createCalendarRepository(db);
  const secrets = ctx.services.secrets;
  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);

  const clock = createMarketClock();

  let finnhub: EarningsProvider | null = null;
  let simulated: EarningsProvider | null = null;
  const resolveEarnings = async (): Promise<EarningsProvider | null> => {
    if (secrets && (await secrets.hasKey(FINNHUB_SECRETS_KEY))) {
      finnhub ??= createFinnhubEarnings({
        fetch: connectorFetch,
        getApiKey: () => secrets.getKey(FINNHUB_SECRETS_KEY),
      });
      return finnhub;
    }
    if (e2e) {
      simulated ??= createSimulatedEarnings();
      return simulated;
    }
    return null;
  };

  const service = createCalendarService({
    repo,
    broadcast: ctx.broadcast,
    getWatchedTickers: () =>
      (ctx.services.market?.listWatchlist() ?? []).map((item) => item.ticker),
    resolveEarnings,
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
    clock,
    powerMonitor,
  });

  ipcMain.handle(IPC_CHANNELS.calendar.list, (_event, request: unknown) => {
    if (!isCalendarListQuery(request)) {
      throw new IpcValidationError(IPC_CHANNELS.calendar.list, 'rango de fechas inválido');
    }
    return service.list(request);
  });

  // La watchlist manda los resultados: al cambiarla se regenera la ventana.
  ctx.services.market?.onWatchlistChanged(() => {
    service.refresh().catch((error: unknown) => {
      console.error(`[calendar] refresco tras cambio de watchlist falló: ${String(error)}`);
    });
  });

  // `news:advance-clock` lo registra el lector de noticias y solo mueve su
  // NewsClock; se encadena el avance al reloj del calendario para que ambos
  // servicios avancen al mismo paso en las pruebas E2E.
  const poller = ctx.services.poller;
  if (poller?.advanceClock) {
    const advancePoller = poller.advanceClock.bind(poller);
    poller.advanceClock = (deltaMs) => {
      const result = advancePoller(deltaMs);
      service.advanceClock?.(deltaMs);
      return result;
    };
  }

  void service.start();
  return service;
}
