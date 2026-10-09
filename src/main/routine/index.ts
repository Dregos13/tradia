/**
 * Rutina diaria de los agentes (fase 4): resumen previo a la apertura,
 * revisión al cierre y conciliación posterior.
 *
 * - Horario `America/New_York` (`ROUTINE_TIMEZONE`), configurable por
 *   `routine:get-config`/`routine:set-config` (`ROUTINE_DEFAULTS` si no hay
 *   nada guardado): preapertura 08:30, cierre 16:15, conciliación 17:30.
 * - Solo en sesiones de negociación: se omiten fines de semana y festivos
 *   NYSE (`market/calendar.ts`). En cierres anticipados corren a su hora
 *   configurada igualmente (los datos del día ya son definitivos).
 * - Deduplicación «como mucho una vez al día»: `routine_runs` UNIQUE por
 *   (rutina, dia); el claim previo a generar evita dobles envíos aunque
 *   dos evaluaciones coincidan.
 * - Recuperación: si la hora programada pasó sin enviar (equipo dormido o
 *   app cerrada), la siguiente evaluación la envía marcada «con retraso»
 *   (`con_retraso = 1`, marca « Enviado con retraso.» y resultado
 *   'con-retraso' en el diario). Solo se recupera el día en curso: los
 *   resúmenes de días ya pasados quedan obsoletos y no se envían.
 * - Cada envío produce una entrada 'resumen' del diario (resultado
 *   'completado'/'con-retraso') enlazada desde `routine_runs.journal_id`,
 *   más el aviso `resumen-diario` por los canales activos (`sendEvent`).
 *   Las discrepancias de la conciliación se anotan como entrada 'error'.
 * - Reloj inyectable (`RoutineClock`, mismo patrón que market/news) y
 *   temporizadores inyectables para las pruebas; el gancho E2E
 *   `routine:advance-clock` adelanta el reloj y reevalúa al instante.
 */

import { app, ipcMain, powerMonitor } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isRoutineConfig,
  type CalendarEvent,
  type NewsItem,
  type NewsListQuery,
  type NewsPriority,
} from '../../shared/ipc';
import {
  ROUTINE_DEFAULTS,
  ROUTINE_KINDS,
  ROUTINE_TIMEZONE,
  type JournalEntry,
  type JournalListQuery,
  type JournalPage,
  type DeliveryEventKind,
  type JournalRecordInput,
  type RoutineClockAdvanceResult,
  type RoutineConfig,
  type RoutineKind,
} from '../../shared/journal';
import type { PaperPortfolioOverview, Signal, SignalsListQuery } from '../../shared/signals';
import { openDatabase } from '../db/database';
import type { DeliveryMessage } from '../delivery';
import { getSession, isTradingDay, nySessionDate, zonedToUtcMs } from '../market/calendar';
import { createMarketRepository, type StoredBar } from '../market/repository';
import type { ServiceContext } from '../services';
import { reconcileDay } from './reconcile';
import {
  createRoutineReads,
  createRoutineRunsRepository,
  type RoutineReads,
  type RoutineRunsRepository,
} from './repository';
import {
  closeReviewText,
  preMarketText,
  reconcileText,
  type CalendarDayStat,
  type GapWatch,
  type OvernightNewsStat,
} from './summaries';

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

/** Clave de settings con la config persistida (JSON RoutineConfig). */
export const ROUTINE_CONFIG_KEY = 'routine.config';

/**
 * Margen tras la hora programada que aún cuenta como «a su hora»: cubre el
 * jitter de los temporizadores sin marcar retrasos falsos. Pasado el margen
 * el envío va marcado «con retraso».
 */
export const ROUTINE_LATE_GRACE_MS = 60_000;

/** Hueco de apertura mínimo (en %) que entra «en seguimiento». */
export const ROUTINE_GAP_MIN_PCT = 1;

/** Titulares relevantes que se conservan en el detalle del resumen. */
export const ROUTINE_HEADLINES_MAX = 5;

/** Días máximos hacia atrás/adelante buscando una sesión de negociación. */
const SESSION_SEARCH_DAYS = 15;

const _DAY_MS = 86_400_000;

/** Orden de severidad para ordenar los titulares de la noche. */
const PRIORITY_RANK: Record<NewsPriority, number> = {
  maxima: 0,
  activo: 1,
  media: 2,
  baja: 3,
};

export class RoutineServiceError extends Error {
  readonly code = 'config-invalida';
  constructor(message: string) {
    super(message);
    this.name = 'RoutineServiceError';
  }
}

/** Reloj con avance manual; habilita `routine:advance-clock` (desarrollo/E2E). */
export interface RoutineClock {
  now(): number;
  /** Adelanta el reloj `deltaMs` y devuelve el nuevo instante (ms epoch). */
  advance(deltaMs: number): number;
}

export function createRoutineClock(base: () => number = () => Date.now()): RoutineClock {
  let offset = 0;
  return {
    now: () => base() + offset,
    advance: (deltaMs) => {
      offset += deltaMs;
      return base() + offset;
    },
  };
}

/** Mínimo de `Electron.PowerMonitor` que usa el servicio (inyectable). */
export interface RoutinePowerMonitorLike {
  on(event: 'resume', listener: () => void): unknown;
  removeListener(event: 'resume', listener: () => void): unknown;
}

export type RoutineTimerHandle = ReturnType<typeof setTimeout>;

export interface RoutineLogger {
  info?(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RoutineDeps {
  runs: RoutineRunsRepository;
  /** Lecturas de conciliación (posiciones completas y curva de capital). */
  reads: RoutineReads;
  /** Reloj con avance manual; habilita `advanceClock`. */
  clock?: RoutineClock;
  /** Reloj simple (ms epoch); por defecto Date.now. */
  now?(): number;
  /** Config persistida; por defecto ROUTINE_DEFAULTS. */
  getConfig?(): RoutineConfig;
  /** Persiste la config nueva (settings); opcional en pruebas. */
  persistConfig?(config: RoutineConfig): void;
  // Fuentes del resumen previo a la apertura.
  listNews?(query: NewsListQuery): NewsItem[];
  listCalendarEvents?(desde: string, hasta: string): CalendarEvent[];
  listWatchlistTickers?(): string[];
  /** Velas guardadas del activo (cualquier fuente), en orden de fecha. */
  getBars?(ticker: string): StoredBar[];
  // Fuentes de la revisión al cierre y la conciliación.
  listSignals?(query: SignalsListQuery): Signal[];
  listJournal?(query: JournalListQuery): JournalPage;
  getPortfolio?(): PaperPortfolioOverview | null;
  // Salidas.
  recordJournal?(input: JournalRecordInput): JournalEntry | null;
  sendEvent?(kind: DeliveryEventKind, message: DeliveryMessage): void;
  /** Umbral del hueco de apertura en %; por defecto ROUTINE_GAP_MIN_PCT. */
  gapMinPct?: number;
  setTimer?(callback: () => void, delayMs: number): RoutineTimerHandle;
  clearTimer?(handle: RoutineTimerHandle): void;
  /** Recuperación al volver de la suspensión. */
  powerMonitor?: RoutinePowerMonitorLike;
  logger?: Partial<RoutineLogger>;
}

/** Resultado de ejecutar una tarea en una evaluación. */
export interface RoutineRunOutcome {
  kind: RoutineKind;
  /** Día de mercado servido ('YYYY-MM-DD'). */
  dia: string;
  /** true si se envió marcado «con retraso». */
  late: boolean;
  /** Entrada del diario enlazada ('resumen', o 'error' si la tarea falló). */
  journalId: number | null;
  /** Mensaje de fallo si la tarea no pudo generarse. */
  error: string | null;
}

export interface RoutineService {
  getConfig(): RoutineConfig;
  /** Guarda horarios nuevos y reprograma el siguiente envío. */
  setConfig(config: RoutineConfig): RoutineConfig;
  /**
   * Reevalúa envíos pendientes: corre cada tarea cuya hora programada del
   * día ya pasó y no tiene marca en `routine_runs`. Expuesto para pruebas;
   * los temporizadores y el despertar lo llaman solos.
   */
  evaluate(): RoutineRunOutcome[];
  /** Evalúa lo pendiente y arma el temporizador del próximo envío. */
  start(): void;
  stop(): void;
  /**
   * Gancho de desarrollo/E2E: adelanta el reloj interno `deltaMs`, reevalúa
   * los envíos y devuelve el nuevo instante.
   */
  advanceClock?(deltaMs: number): RoutineClockAdvanceResult;
}

// ---------------------------------------------------------------------------
// Aritmética de fechas de sesión (todo en America/New_York)
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');

const parseDia = (dia: string): { year: number; month: number; day: number } => ({
  year: Number(dia.slice(0, 4)),
  month: Number(dia.slice(5, 7)),
  day: Number(dia.slice(8, 10)),
});

const toDia = (utcMs: number): string => {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

/** Suma `delta` días civiles a una fecha 'YYYY-MM-DD'. */
const addDays = (dia: string, delta: number): string => {
  const { year, month, day } = parseDia(dia);
  return toDia(Date.UTC(year, month - 1, day + delta));
};

const parseHHMM = (hhmm: string): { hour: number; minute: number } => ({
  hour: Number(hhmm.slice(0, 2)),
  minute: Number(hhmm.slice(3, 5)),
});

/** Instante UTC (ms) de la hora 'HH:MM' del día de sesión `dia`. */
const scheduledAtMs = (dia: string, hhmm: string): number => {
  const { year, month, day } = parseDia(dia);
  const { hour, minute } = parseHHMM(hhmm);
  return zonedToUtcMs(year, month, day, hour, minute, ROUTINE_TIMEZONE);
};

/** Sesión de negociación anterior a `dia` ('YYYY-MM-DD'), o null si no hay en el tope. */
const prevTradingDay = (dia: string): string | null => {
  for (let i = 1; i <= SESSION_SEARCH_DAYS; i += 1) {
    const candidate = addDays(dia, -i);
    if (isTradingDay(candidate)) return candidate;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export function createRoutineService(deps: RoutineDeps): RoutineService {
  const now = deps.clock ? deps.clock.now : (deps.now ?? (() => Date.now()));
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h: RoutineTimerHandle) => clearTimeout(h));
  const logger = deps.logger ?? console;
  const gapMinPct = deps.gapMinPct ?? ROUTINE_GAP_MIN_PCT;

  let config: RoutineConfig = { ...ROUTINE_DEFAULTS };
  const stored = deps.getConfig?.();
  if (stored !== undefined && isRoutineConfig(stored)) config = { ...stored };

  let started = false;
  let timer: RoutineTimerHandle | null = null;

  const _isoNow = (): string => new Date(now()).toISOString();

  const recordJournal = (input: JournalRecordInput): JournalEntry | null =>
    deps.recordJournal?.(input) ?? null;

  // --- Recolección del resumen previo a la apertura -------------------------

  /** Noticias publicadas desde el cierre de la sesión anterior hasta ahora. */
  const collectOvernightNews = (dia: string, nowMs: number): OvernightNewsStat => {
    const prevDia = prevTradingDay(dia);
    const prevCloseUtc = prevDia === null ? null : (getSession(prevDia)?.closesAtUtc ?? null);
    const prevCloseMs = prevCloseUtc === null ? null : Date.parse(prevCloseUtc);
    const items =
      deps.listNews?.({
        desde: prevDia ?? dia,
        hasta: dia,
        limit: 500,
      }) ?? [];
    const overnight = items.filter((item) => {
      const publishedMs = Date.parse(item.publishedAt);
      if (Number.isNaN(publishedMs) || publishedMs > nowMs) return false;
      return prevCloseMs === null || publishedMs > prevCloseMs;
    });
    const porPrioridad: Record<string, number> = {};
    for (const item of overnight) {
      porPrioridad[item.priority] = (porPrioridad[item.priority] ?? 0) + 1;
    }
    const relevantes = overnight
      .filter((item) => item.priority !== 'baja')
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    return {
      total: overnight.length,
      relevantes: relevantes.length,
      porPrioridad,
      titulares: relevantes.slice(0, ROUTINE_HEADLINES_MAX).map((item) => ({
        titulo: item.title,
        prioridad: item.priority,
        activos: item.assets,
      })),
    };
  };

  /** Eventos del calendario que caen en el día civil de sesión `dia`. */
  const collectDayEvents = (dia: string): CalendarDayStat => {
    const events = (deps.listCalendarEvents?.(dia, dia) ?? [])
      .filter((event) => nySessionDate(event.dateUtc) === dia)
      .sort((a, b) => (a.dateUtc < b.dateUtc ? -1 : 1));
    return {
      total: events.length,
      destacados: events
        .filter((event) => event.impact === 'alto')
        .map((event) => ({
          titulo: event.title,
          impacto: event.impact,
          dateUtc: event.dateUtc,
        })),
    };
  };

  /**
   * Hueco de apertura por activo de la watchlist: apertura de la última
   * vela guardada frente al cierre de la anterior (valores ajustados si
   * existen). Solo entran los que superan `gapMinPct` en valor absoluto.
   */
  const collectGaps = (): GapWatch[] => {
    if (deps.getBars === undefined) return [];
    const gaps: GapWatch[] = [];
    for (const ticker of deps.listWatchlistTickers?.() ?? []) {
      const bars = deps.getBars(ticker);
      const byDate = new Map<string, StoredBar>();
      for (const bar of bars) byDate.set(bar.date, bar);
      const dates = [...byDate.keys()].sort();
      if (dates.length < 2) continue;
      const prev = byDate.get(dates[dates.length - 2]!)!;
      const last = byDate.get(dates[dates.length - 1]!)!;
      const prevClose = prev.adjClose ?? prev.close;
      const lastOpen = last.adjOpen ?? last.open;
      if (!(prevClose > 0)) continue;
      const gapPct = Math.round(((lastOpen - prevClose) / prevClose) * 100 * 100) / 100;
      if (Math.abs(gapPct) >= gapMinPct) {
        gaps.push({ ticker, gapPct, lastOpen, prevClose, barDate: last.date });
      }
    }
    return gaps.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
  };

  // --- Tareas ---------------------------------------------------------------

  const reasonOf = (body: string): string =>
    body
      .replace(/ Aviso informativo.*$/, '')
      .replace(' Enviado con retraso.', '')
      .trim();

  /** Construye el aviso + datos de cada tarea y devuelve ambos. */
  const buildTask = (
    kind: RoutineKind,
    dia: string,
    nowMs: number,
    late: boolean,
  ): { message: DeliveryMessage; dataUsed: Record<string, unknown>; reason: string } => {
    // Motivo para el diario: la frase del aviso sin la marca de retraso (ya
    // va en `result`) ni la línea de exención.
    if (kind === 'preapertura') {
      const news = collectOvernightNews(dia, nowMs);
      const events = collectDayEvents(dia);
      const gaps = collectGaps();
      const prevDia = prevTradingDay(dia);
      const message = preMarketText(dia, { news, events, gaps }, late);
      return {
        message,
        reason: `Resumen previo a la apertura del ${dia}: ${reasonOf(message.body)}`,
        dataUsed: {
          rutina: kind,
          dia,
          sesionAnterior: prevDia,
          noticias: news,
          eventos: events,
          huecos: gaps,
          umbralGapPct: gapMinPct,
        },
      };
    }
    if (kind === 'cierre') {
      const signals = deps.listSignals?.({ desde: dia, hasta: dia, limit: 200 }) ?? [];
      const emitted = signals.filter((s) => s.decision.status !== 'vetada');
      const vetoed = signals.filter((s) => s.decision.status === 'vetada');
      const vetoesPage = deps.listJournal?.({ type: 'veto', limit: 1000 });
      const vetosDiario = (vetoesPage?.entries ?? []).filter(
        (entry) => nySessionDate(entry.createdAt) === dia,
      ).length;
      const portfolio = deps.getPortfolio?.() ?? null;
      const closedToday = deps.reads
        .listPaperPositions()
        .filter((p) => p.closedAt !== null && nySessionDate(p.closedAt) === dia).length;
      const stat = {
        senales: emitted.length,
        vetos: vetoed.length,
        vetosDiario,
        posicionesAbiertas: portfolio?.openPositions ?? 0,
        posicionesCerradasHoy: closedToday,
        drawdownPct: portfolio?.drawdownPct ?? 0,
        dailyLossPct: portfolio?.dailyLossPct ?? 0,
        equity: portfolio?.equity ?? 0,
      };
      const message = closeReviewText(dia, stat, late);
      return {
        message,
        reason: `Revisión al cierre del ${dia}: ${reasonOf(message.body)}`,
        dataUsed: {
          rutina: kind,
          dia,
          ...stat,
          senalIds: signals.map((s) => s.id),
        },
      };
    }
    // conciliacion
    const signals = deps.listSignals?.({ desde: dia, hasta: dia, limit: 200 }) ?? [];
    const operations = deps.listJournal?.({ type: 'operacion', limit: 1000 }).entries ?? [];
    const result = reconcileDay({
      dia,
      signals,
      positions: deps.reads.listPaperPositions(),
      operations,
      equityHistory: deps.reads.listEquityHistory(),
    });
    if (result.discrepancies.length > 0) {
      recordJournal({
        type: 'error',
        reason:
          `Conciliación del ${dia}: ` +
          `${result.discrepancies.length} ` +
          (result.discrepancies.length === 1
            ? 'discrepancia detectada'
            : 'discrepancias detectadas'),
        dataUsed: { rutina: kind, dia, comprobaciones: result.checked },
        result: 'error',
        errors: result.discrepancies,
      });
    }
    const message = reconcileText(dia, result.discrepancies.length, late);
    return {
      message,
      reason: `Conciliación del ${dia}: ${reasonOf(message.body)}`,
      dataUsed: {
        rutina: kind,
        dia,
        discrepancias: result.discrepancies,
        comprobaciones: result.checked,
      },
    };
  };

  /**
   * Ejecuta una tarea ya reclamada: graba la entrada 'resumen' del diario
   * y envía el aviso por los canales. Devuelve el id de la entrada.
   */
  const runTask = (kind: RoutineKind, dia: string, late: boolean, nowMs: number): number | null => {
    const { message, dataUsed, reason } = buildTask(kind, dia, nowMs, late);
    const entry = recordJournal({
      type: 'resumen',
      reason,
      dataUsed: {
        ...dataUsed,
        programada: new Date(scheduledAtMs(dia, config[kind])).toISOString(),
        enviadaEn: new Date(nowMs).toISOString(),
        conRetraso: late,
      },
      result: late ? 'con-retraso' : 'completado',
    });
    deps.sendEvent?.('resumen-diario', message);
    logger.info?.(
      `[routine] ${kind} del ${dia} enviado${late ? ' con retraso' : ''}` +
        (entry === null ? '' : ` (diario #${entry.id})`),
    );
    return entry?.id ?? null;
  };

  // --- Evaluación y temporizadores ------------------------------------------

  const evaluate = (): RoutineRunOutcome[] => {
    if (!started) return [];
    const nowMs = now();
    const dia = nySessionDate(nowMs);
    if (!isTradingDay(dia)) return [];
    const outcomes: RoutineRunOutcome[] = [];
    for (const kind of ROUTINE_KINDS) {
      const scheduledMs = scheduledAtMs(dia, config[kind]);
      if (scheduledMs > nowMs) continue;
      const late = nowMs - scheduledMs > ROUTINE_LATE_GRACE_MS;
      // El claim va antes de generar: el UNIQUE (rutina, dia) reserva la
      // ejecución y hace imposible el doble envío, incluso si la tarea falla.
      const runId = deps.runs.claim(kind, dia, late, new Date(nowMs).toISOString());
      if (runId === null) continue;
      const outcome: RoutineRunOutcome = {
        kind,
        dia,
        late,
        journalId: null,
        error: null,
      };
      try {
        outcome.journalId = runTask(kind, dia, late, nowMs);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        outcome.error = message;
        logger.error?.(`[routine] la rutina «${kind}» del ${dia} falló: ${message}`);
        try {
          const errorEntry = recordJournal({
            type: 'error',
            reason: `La rutina «${kind}» del ${dia} falló al generarse`,
            dataUsed: { rutina: kind, dia },
            result: 'error',
            errors: [message],
          });
          outcome.journalId = errorEntry?.id ?? null;
        } catch {
          // Sin diario no hay más donde anotarlo: queda solo el log.
        }
      }
      if (outcome.journalId !== null) deps.runs.attachJournal(runId, outcome.journalId);
      outcomes.push(outcome);
    }
    return outcomes;
  };

  const safeEvaluate = (): void => {
    try {
      evaluate();
    } catch (error: unknown) {
      logger.error?.(`[routine] la evaluación falló: ${String(error)}`);
    }
  };

  /** Próximo instante programado de `kind` estrictamente futuro. */
  const nextOccurrence = (kind: RoutineKind, fromMs: number): number | null => {
    const today = nySessionDate(fromMs);
    for (let i = 0; i <= SESSION_SEARCH_DAYS; i += 1) {
      const dia = addDays(today, i);
      if (!isTradingDay(dia)) continue;
      const at = scheduledAtMs(dia, config[kind]);
      if (at > fromMs) return at;
    }
    return null;
  };

  const arm = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!started) return;
    const nowMs = now();
    let next: number | null = null;
    for (const kind of ROUTINE_KINDS) {
      const at = nextOccurrence(kind, nowMs);
      if (at !== null && (next === null || at < next)) next = at;
    }
    if (next === null) return;
    timer = setTimer(
      () => {
        timer = null;
        safeEvaluate();
        arm();
      },
      Math.max(0, next - nowMs),
    );
    (timer as { unref?: () => void }).unref?.();
  };

  const onResume = (): void => {
    safeEvaluate();
    arm();
  };

  const service: RoutineService = {
    getConfig: () => ({ ...config }),

    setConfig: (input) => {
      if (!isRoutineConfig(input)) {
        throw new RoutineServiceError(
          'la configuración de la rutina debe ser {preapertura, cierre, conciliacion} en HH:MM',
        );
      }
      config = { ...input };
      deps.persistConfig?.(config);
      arm(); // reprograma con las horas nuevas (la deduplicación por día sigue)
      return { ...config };
    },

    evaluate,

    start: () => {
      if (started) return;
      started = true;
      deps.powerMonitor?.on('resume', onResume);
      safeEvaluate();
      arm();
    },

    stop: () => {
      started = false;
      deps.powerMonitor?.removeListener('resume', onResume);
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };

  if (deps.clock !== undefined) {
    const clock = deps.clock;
    service.advanceClock = (deltaMs: number): RoutineClockAdvanceResult => {
      clock.advance(deltaMs);
      safeEvaluate();
      arm();
      return { now: new Date(clock.now()).toISOString() };
    };
  }

  return service;
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

export function registerRoutine(ctx: ServiceContext): RoutineService {
  // Sin base de datos el servicio degrada a memoria (mismo patrón que el
  // resto de servicios del proceso principal).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[routine] almacén no disponible: la deduplicación solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const settings = ctx.services.settings;
  const market = createMarketRepository(db);
  const clock = createRoutineClock();

  const service = createRoutineService({
    runs: createRoutineRunsRepository(db),
    reads: createRoutineReads(db),
    clock,
    getConfig: () => {
      const raw = settings?.getValue(ROUTINE_CONFIG_KEY);
      if (typeof raw !== 'string') return { ...ROUTINE_DEFAULTS };
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRoutineConfig(parsed)) return parsed;
      } catch {
        // Config ilegible: se aplican los horarios por defecto.
      }
      console.warn('[routine] config guardada ilegible; se usan los horarios por defecto');
      return { ...ROUTINE_DEFAULTS };
    },
    persistConfig: (config) => settings?.setValue(ROUTINE_CONFIG_KEY, JSON.stringify(config)),
    listNews: (query) => ctx.services.poller?.listNews(query) ?? [],
    listCalendarEvents: (desde, hasta) => ctx.services.calendar?.list({ desde, hasta }) ?? [],
    listWatchlistTickers: () =>
      ctx.services.market?.listWatchlist().map((item) => item.ticker) ?? [],
    getBars: (ticker) => market.getBars(ticker),
    listSignals: (query) => ctx.services.signals?.engine.listSignals(query) ?? [],
    listJournal: (query) =>
      ctx.services.journal?.list(query) ?? { entries: [], total: 0, limit: 0, offset: 0 },
    recordJournal: (input) => ctx.services.journal?.record?.(input) ?? null,
    getPortfolio: () => ctx.services.risk?.getPortfolio() ?? null,
    sendEvent: (kind, message) => ctx.services.delivery?.sendEvent?.(kind, message),
    powerMonitor,
    logger: console,
  });

  ipcMain.handle(IPC_CHANNELS.routine.getConfig, () => service.getConfig());
  ipcMain.handle(IPC_CHANNELS.routine.setConfig, (_event, value: unknown) => {
    if (!isRoutineConfig(value)) {
      throw new IpcValidationError(
        IPC_CHANNELS.routine.setConfig,
        'la configuración debe ser {preapertura, cierre, conciliacion} en HH:MM',
      );
    }
    return service.setConfig(value);
  });

  // Gancho E2E/desarrollo: la app empaquetada no registra el canal (mismo
  // patrón que signals:evaluate-now y los risk:simulate-*).
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.routine.advanceClock, (_event, deltaMs: unknown) => {
      if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs <= 0) {
        throw new IpcValidationError(
          IPC_CHANNELS.routine.advanceClock,
          'se esperaba un número de ms positivo',
        );
      }
      return service.advanceClock?.(deltaMs) ?? { now: new Date().toISOString() };
    });
  }

  service.start();
  return service;
}
