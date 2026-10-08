/**
 * Ingesta de datos de mercado y actualización diaria programada — Fase 1.
 *
 * `createMarketIngestionService` es el núcleo, con todo lo externo inyectado
 * (reloj, conexión, proveedor, powerMonitor): las pruebas lo montan sin
 * Electron y con reloj falso. `registerMarket` lo cablea en la app:
 *
 * - Proveedor: Tiingo si hay clave en secrets; si no, el simulado solo con
 *   TRADIA_E2E y sin empaquetar. Sin clave ni E2E no hay proveedor.
 * - Histórico de 5 años al añadir un ticker; después, actualización
 *   incremental desde la última vela guardada.
 * - Cada lote pasa por `cleaning/cleanBars` (dedupe, validación, huecos,
 *   ajuste hacia atrás) y se guarda versionado (`data_batches` + marcas en
 *   `quality_flags`); las acciones corporativas se persisten en
 *   `corporate_actions` para reajustar la serie completa en cada ingesta.
 * - Trabajo diario a la hora `nextUpdateAt` del calendario (16:00 ET + 75
 *   min, convertido a hora de Madrid); si falla algo recuperable, hasta 4
 *   reintentos cada 30 minutos. Al arrancar y al volver de la suspensión
 *   (`powerMonitor` resume) se recuperan los cierres perdidos.
 * - Sin conexión (`connectivity` en 'offline') no se llama al proveedor: el
 *   trabajo se pospone sin gastar reintentos.
 * - Salud del dato: cada resultado se escribe en `data_status` y se emite
 *   `data-status:changed`; cada lote guardado emite `market:updated`.
 *
 * Gancho de desarrollo: `market:advance-clock` (solo sin empaquetar) mueve
 * el reloj del servicio y reevalúa el trabajo pendiente al instante; en el
 * preload se expone como `testing.advanceMarketClock` bajo TRADIA_E2E.
 */
import { app, ipcMain, powerMonitor } from 'electron';

import {
  dataStatusKey,
  INITIAL_UNIVERSE_TICKERS,
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isGetBarsRequest,
  isTicker,
  type GetBarsRequest,
  type MarketBar,
  type MarketBarsResult,
  type MarketClockAdvanceResult,
  type MarketRefreshResult,
  type MarketUpdatedEvent,
  type WatchlistItem,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import * as nyseCalendar from './calendar';
import type { MarketSession } from './calendar';
import {
  cleanBars,
  deriveCorporateActions,
  type QualityReport,
  type SessionCalendar,
} from './cleaning';
import {
  createSimulatedProvider,
  createTiingoProvider,
  SIMULATED_PROVIDER_ID,
  TIINGO_SECRETS_KEY,
  isMarketDataError,
  type Bar,
  type MarketDataProvider,
  type SessionDate,
} from './providers';
import {
  createMarketRepository,
  type BatchQualitySummary,
  type DataStatusPatch,
  type MarketRepository,
  type StoredBar,
} from './repository';

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

/** Reintento del trabajo diario: cada 30 minutos, hasta 4 veces. */
export const MARKET_RETRY_INTERVAL_MS = 30 * 60_000;
export const MARKET_MAX_RETRIES = 4;
/** Años de histórico que se descargan al añadir un ticker. */
export const HISTORY_YEARS = 5;

const DAY_MS = 86_400_000;

/** Reloj del servicio: ahora mismo y avance manual para desarrollo/pruebas. */
export interface MarketClock {
  now(): number;
  /** Adelanta el reloj `deltaMs` y devuelve el nuevo instante (ms epoch). */
  advance(deltaMs: number): number;
}

export function createMarketClock(base: () => number = () => Date.now()): MarketClock {
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
export interface MarketPowerMonitorLike {
  on(event: 'resume', listener: () => void): unknown;
  removeListener(event: 'resume', listener: () => void): unknown;
}

export type IngestOutcome = 'actualizado' | 'pendiente' | 'fallido';

export interface TickerIngestResult {
  ticker: string;
  outcome: IngestOutcome;
  /** Velas guardadas en esta pasada (0 si ya estaba al día). */
  stored: number;
  /** Fecha de la última vela guardada tras la pasada, o null si no hay. */
  lastDate: SessionDate | null;
  /** true si un nuevo intento puede arreglarlo (red, cuota, proveedor tardío). */
  retryable: boolean;
  /** Motivo legible cuando no quedó 'actualizado'. */
  reason?: string;
}

export interface UpdateAllResult {
  /** false si quedó algún resultado reintentable (pendiente o fallo recuperable). */
  ok: boolean;
  results: TickerIngestResult[];
}

export interface MarketIngestionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface MarketIngestionDeps {
  repo: MarketRepository;
  /** Resuelve el proveedor activo en cada pasada (null si no hay). */
  resolveProvider(): Promise<MarketDataProvider | null>;
  broadcast(channel: string, payload: unknown): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Reloj con avance manual; habilita `advanceClock` (desarrollo). */
  clock?: MarketClock;
  /** false cuando connectivity ve 'offline'; por defecto siempre en línea. */
  isOnline?: () => boolean;
  /** Recuperación al volver de la suspensión. */
  powerMonitor?: MarketPowerMonitorLike;
  /** Calendario de sesiones para la limpieza por proveedor. */
  sessionsFor?: (provider: MarketDataProvider) => SessionCalendar;
  retryIntervalMs?: number;
  maxRetries?: number;
  logger?: Partial<MarketIngestionLogger>;
}

export interface MarketIngestionService {
  listWatchlist(): WatchlistItem[];
  /** Añade el ticker, lanza su histórico y devuelve la lista completa. */
  addTicker(ticker: string): Promise<WatchlistItem[]>;
  removeTicker(ticker: string): WatchlistItem[];
  /** Añade el universo inicial e ingiere lo que falte. */
  addUniverse(): Promise<WatchlistItem[]>;
  getBars(request: GetBarsRequest): Promise<MarketBarsResult>;
  refreshNow(): Promise<MarketRefreshResult>;
  /**
   * Gancho de desarrollo: avanza el reloj y reevalúa el trabajo pendiente.
   * Solo existe si se inyectó `clock`.
   */
  advanceClock?(deltaMs: number): MarketClockAdvanceResult;
  /** Arranca la programación y recupera cierres perdidos; devuelve cuando
   * termina la primera evaluación (útil en pruebas). */
  start(): Promise<void>;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Calendario de laborables (el proveedor simulado no modela festivos)
// ---------------------------------------------------------------------------

const SESSION_STUB: Omit<MarketSession, 'date'> = {
  opensAtUtc: '',
  closesAtUtc: '',
  updateAtUtc: '',
  earlyClose: false,
};

/**
 * Sesiones = todos los laborables del rango. Es el calendario que casa con
 * el proveedor simulado: como emite también los festivos de NYSE, usar el
 * calendario real marcaría huecos y velas 'non-session' que no existen.
 * Con Tiingo (o cualquier proveedor real) se usa `market/calendar.ts`.
 */
export const weekdaySessionsCalendar: SessionCalendar = {
  expectedSessionsBetween(desde, hasta) {
    const sessions: MarketSession[] = [];
    let dayMs = Date.parse(`${desde}T00:00:00.000Z`);
    const endMs = Date.parse(`${hasta}T00:00:00.000Z`);
    for (; dayMs <= endMs; dayMs += DAY_MS) {
      const date = new Date(dayMs).toISOString().slice(0, 10);
      const dow = new Date(dayMs).getUTCDay();
      if (dow >= 1 && dow <= 5) sessions.push({ ...SESSION_STUB, date });
    }
    return sessions;
  },
};

/** El simulado genera laborables; el resto usa el calendario real de NYSE. */
export function defaultSessionsFor(provider: MarketDataProvider): SessionCalendar {
  return provider.id === SIMULATED_PROVIDER_ID ? weekdaySessionsCalendar : nyseCalendar;
}

// ---------------------------------------------------------------------------
// Utilidades de fechas
// ---------------------------------------------------------------------------

function addDays(date: SessionDate, days: number): SessionDate {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Mismo día del mes hace `years` años; el 29 de febrero cae al 28. */
function yearsBack(date: SessionDate, years: number): SessionDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y - years, m - 1, d));
  if (shifted.getUTCMonth() !== m - 1) shifted.setUTCDate(0);
  return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export function createMarketIngestionService(deps: MarketIngestionDeps): MarketIngestionService {
  const repo = deps.repo;
  const now = deps.clock ? deps.clock.now : (deps.now ?? (() => Date.now()));
  const isOnline = deps.isOnline ?? (() => true);
  const sessionsFor = deps.sessionsFor ?? defaultSessionsFor;
  const retryIntervalMs = deps.retryIntervalMs ?? MARKET_RETRY_INTERVAL_MS;
  const maxRetries = deps.maxRetries ?? MARKET_MAX_RETRIES;
  const logger = deps.logger ?? console;

  let started = false;
  let timer: NodeJS.Timeout | null = null;
  let retries = 0;
  let running: Promise<UpdateAllResult> | null = null;
  /** Tickers con una ingesta en vuelo, para no solapar add/diario/manual. */
  const ingesting = new Set<string>();

  const isoNow = (): string => new Date(now()).toISOString();

  const publishStatus = (patch: DataStatusPatch): void => {
    const entry = repo.setDataStatus(patch);
    deps.broadcast(IPC_CHANNELS.dataStatus.changed, entry);
  };

  const emitUpdated = (ticker: string, providerId: string, lastDate: SessionDate | null): void => {
    const event: MarketUpdatedEvent = {
      ticker,
      source: providerId,
      lastDate,
      updatedAt: isoNow(),
    };
    deps.broadcast(IPC_CHANNELS.market.updated, event);
  };

  // -- Salud del dato --------------------------------------------------------

  const bumpProviderFailure = (provider: MarketDataProvider, reason: string): void => {
    const key = dataStatusKey.provider(provider.id);
    const current = repo.getDataStatus(key);
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    publishStatus({
      key,
      // La credencial rechazada o varios fallos seguidos ya son "no fiable".
      state: failures >= 3 ? 'no-fiable' : 'desactualizado',
      consecutiveFailures: failures,
      reason,
    });
  };

  const markProviderOk = (provider: MarketDataProvider): void => {
    const key = dataStatusKey.provider(provider.id);
    const current = repo.getDataStatus(key);
    if (current?.state === 'fiable' && current.consecutiveFailures === 0) return;
    publishStatus({
      key,
      state: 'fiable',
      lastOkAt: isoNow(),
      consecutiveFailures: 0,
      reason: null,
    });
  };

  const classifyFailure = (
    error: unknown,
  ): { retryable: boolean; reason: string; tickerState: 'desactualizado' | 'no-fiable' } => {
    if (isMarketDataError(error)) {
      const e = error;
      if (e.kind === 'not-found' || e.kind === 'bad-data') {
        return { retryable: false, reason: e.message, tickerState: 'no-fiable' };
      }
      if (e.kind === 'auth') {
        return { retryable: false, reason: e.message, tickerState: 'desactualizado' };
      }
      // 'network' y 'rate-limit': se reintentan.
      return { retryable: true, reason: e.message, tickerState: 'desactualizado' };
    }
    return {
      retryable: false,
      reason: `error inesperado de ingesta: ${String(error)}`,
      tickerState: 'no-fiable',
    };
  };

  const failTicker = (
    ticker: string,
    provider: MarketDataProvider,
    error: unknown,
  ): TickerIngestResult => {
    const { retryable, reason, tickerState } = classifyFailure(error);
    const key = dataStatusKey.ticker(ticker);
    const current = repo.getDataStatus(key);
    publishStatus({
      key,
      state: tickerState,
      consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
      reason,
    });
    bumpProviderFailure(provider, reason);
    logger.warn?.(`[market] ingesta de ${ticker} falló (${reason})`);
    return {
      ticker,
      outcome: 'fallido',
      stored: 0,
      lastDate: repo.lastBarDate(ticker, provider.id),
      retryable,
      reason,
    };
  };

  const qualityReason = (report: QualityReport): string => {
    const parts: string[] = [];
    if (report.gaps.length > 0) parts.push(`${report.gaps.length} huecos`);
    if (report.duplicates.length > 0) parts.push(`${report.duplicates.length} duplicados`);
    if (report.anomalies.length > 0) parts.push(`${report.anomalies.length} anomalías`);
    if (report.warnings.length > 0) parts.push(`${report.warnings.length} avisos`);
    return `lote con incidencias de calidad: ${parts.join(', ')}`;
  };

  const toQualityFlags = (batchId: number, ticker: string, report: QualityReport) => {
    const flags: Array<{
      batchId: number;
      ticker: string;
      date?: SessionDate;
      kind: 'hueco' | 'duplicado' | 'anomalo';
      detail?: string;
    }> = [];
    for (const date of report.gaps) {
      flags.push({ batchId, ticker, date, kind: 'hueco', detail: 'sesión esperada sin vela' });
    }
    for (const date of report.duplicates) {
      flags.push({
        batchId,
        ticker,
        date,
        kind: 'duplicado',
        detail: 'fecha recibida más de una vez; se conservó la última',
      });
    }
    for (const anomaly of report.anomalies) {
      flags.push({
        batchId,
        ticker,
        date: anomaly.date,
        kind: 'anomalo',
        detail: `${anomaly.kind}: ${anomaly.detail}`,
      });
    }
    return flags;
  };

  // -- Ingesta de un ticker ---------------------------------------------------

  /** Reconstruye la `Bar` de entrada para la limpieza desde la fila guardada. */
  const storedToBar = (
    stored: StoredBar,
    splitOn: ReadonlyMap<SessionDate, number>,
    dividendOn: ReadonlyMap<SessionDate, number>,
  ): Bar => ({
    date: stored.date,
    open: stored.open,
    high: stored.high,
    low: stored.low,
    close: stored.close,
    volume: stored.volume,
    adjClose: stored.adjClose ?? stored.close,
    splitFactor: splitOn.get(stored.date) ?? 1,
    dividend: dividendOn.get(stored.date) ?? 0,
  });

  const ingestOne = async (
    ticker: string,
    provider: MarketDataProvider,
  ): Promise<TickerIngestResult> => {
    const statusKey = dataStatusKey.ticker(ticker);
    const lastExpected = nyseCalendar.lastExpectedSession(now());
    const lastStored = repo.lastBarDate(ticker, provider.id);

    if (lastExpected === null) {
      // Sin sesión esperada en el horizonte del calendario: nada que hacer.
      return { ticker, outcome: 'actualizado', stored: 0, lastDate: lastStored, retryable: false };
    }
    if (lastStored !== null && lastStored >= lastExpected.date) {
      return { ticker, outcome: 'actualizado', stored: 0, lastDate: lastStored, retryable: false };
    }

    const desde = lastStored ? addDays(lastStored, 1) : yearsBack(lastExpected.date, HISTORY_YEARS);
    const hasta = lastExpected.date;

    let newBars: Bar[];
    try {
      newBars = await provider.getBars(ticker, desde, hasta);
    } catch (error: unknown) {
      return failTicker(ticker, provider, error);
    }

    if (newBars.length === 0) {
      if (lastStored === null) {
        publishStatus({
          key: statusKey,
          state: 'no-fiable',
          consecutiveFailures: 0,
          reason: `el proveedor '${provider.id}' no devolvió datos para ${ticker}`,
        });
        return {
          ticker,
          outcome: 'fallido',
          stored: 0,
          lastDate: null,
          retryable: false,
          reason: 'sin datos del proveedor',
        };
      }
      // La sesión esperada aún no está publicada: merece reintento, pero no
      // es un fallo del proveedor (no se cuentan fallos seguidos).
      const current = repo.getDataStatus(statusKey);
      publishStatus({
        key: statusKey,
        state: current?.state ?? 'desactualizado',
        reason: `esperando la vela del ${hasta} en '${provider.id}'`,
      });
      return {
        ticker,
        outcome: 'pendiente',
        stored: 0,
        lastDate: lastStored,
        retryable: true,
        reason: `sin la vela de ${hasta} todavía`,
      };
    }

    // Acciones corporativas: las nuevas se derivan de las velas (ambos
    // adaptadores las traen por fila) y se fusionan con las ya guardadas,
    // así el reajuste cubre la serie completa sin peticiones extra.
    const newActions = deriveCorporateActions(ticker, newBars);
    if (newActions.length > 0) {
      repo.upsertCorporateActions(newActions.map((a) => ({ ...a, source: provider.id })));
    }
    const actions = repo.getCorporateActions(ticker);
    const splitOn = new Map<SessionDate, number>();
    const dividendOn = new Map<SessionDate, number>();
    for (const action of actions) {
      if (action.kind === 'split') splitOn.set(action.date, action.value);
      else dividendOn.set(action.date, action.value);
    }

    const stored = repo.getBars(ticker, { source: provider.id });
    // El lote limpia la serie completa (guardada + nueva): un split o
    // dividendo reciente reajusta todas las velas anteriores. Los crudos
    // nuevos van al final para que ganen sobre los guardados en un choque.
    const combined: Bar[] = [...stored.map((s) => storedToBar(s, splitOn, dividendOn)), ...newBars];

    const previous = repo.latestBatch('bars', provider.id, ticker);
    const clean = cleanBars(
      {
        ticker,
        bars: combined,
        corporateActions: actions,
        calendar: sessionsFor(provider),
      },
      { previousBatch: previous ? { version: previous.version, hash: previous.hash } : null },
    );

    if (clean.bars.length === 0) {
      publishStatus({
        key: statusKey,
        state: 'no-fiable',
        consecutiveFailures: 0,
        reason: `todas las velas del lote de '${provider.id}' fueron rechazadas`,
      });
      return {
        ticker,
        outcome: 'fallido',
        stored: 0,
        lastDate: lastStored,
        retryable: false,
        reason: 'lote vacío tras la limpieza',
      };
    }

    const batch = repo.createBatch({
      version: clean.batch.version,
      hash: clean.batch.hash,
      provider: provider.id,
      scope: 'bars',
      ticker,
      rangeStart: clean.bars[0]!.date,
      rangeEnd: clean.bars[clean.bars.length - 1]!.date,
      receivedAt: isoNow(),
      qualitySummary: clean.report as unknown as BatchQualitySummary,
    });
    repo.upsertBars(ticker, provider.id, batch.id, clean.bars);
    const flags = toQualityFlags(batch.id, ticker, clean.report);
    if (flags.length > 0) repo.addQualityFlags(flags);

    publishStatus({
      key: statusKey,
      state: clean.report.reliable ? 'fiable' : 'no-fiable',
      lastOkAt: isoNow(),
      consecutiveFailures: 0,
      reason: clean.report.reliable ? null : qualityReason(clean.report),
    });

    const lastDate = clean.bars[clean.bars.length - 1]!.date;
    emitUpdated(ticker, provider.id, lastDate);
    logger.info?.(
      `[market] ${ticker}: lote v${batch.version} con ${clean.bars.length} velas hasta ${lastDate}`,
    );
    return {
      ticker,
      outcome: 'actualizado',
      stored: clean.bars.length,
      lastDate,
      retryable: false,
    };
  };

  /** Ingesta de un ticker con guarda de concurrencia (null si ya estaba en vuelo). */
  const ingestGuarded = async (
    ticker: string,
    provider: MarketDataProvider,
  ): Promise<TickerIngestResult | null> => {
    if (ingesting.has(ticker)) return null;
    ingesting.add(ticker);
    try {
      return await ingestOne(ticker, provider);
    } catch (error: unknown) {
      // Defensa ante fallos de base de datos u otros no tipados.
      return failTicker(ticker, provider, error);
    } finally {
      ingesting.delete(ticker);
    }
  };

  const runUpdate = (provider: MarketDataProvider): Promise<UpdateAllResult> => {
    // Una sola pasada en vuelo: las llamadas concurrentes comparten promesa.
    if (running) return running;
    const task = (async () => {
      const results: TickerIngestResult[] = [];
      let anyProviderError = false;
      for (const { ticker } of repo.listWatchlist()) {
        const result = await ingestGuarded(ticker, provider);
        if (result === null) {
          results.push({
            ticker,
            outcome: 'actualizado',
            stored: 0,
            lastDate: repo.lastBarDate(ticker, provider.id),
            retryable: false,
          });
          continue;
        }
        if (result.outcome === 'fallido') anyProviderError = true;
        results.push(result);
      }
      const ok = results.every((r) => !r.retryable);
      if (!anyProviderError) markProviderOk(provider);
      return { ok, results };
    })();
    running = task;
    task.finally(() => {
      if (running === task) running = null;
    });
    return task;
  };

  // -- Programación ------------------------------------------------------------

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  /** Resuelve el proveedor sin propagar errores (se registran y queda null). */
  const safeResolveProvider = async (): Promise<MarketDataProvider | null> => {
    try {
      return await deps.resolveProvider();
    } catch (error: unknown) {
      logger.error?.(`[market] no se pudo resolver el proveedor: ${String(error)}`);
      return null;
    }
  };

  /** Evalúa el trabajo pendiente y arma el siguiente temporizador. */
  const evaluate = async (): Promise<void> => {
    if (!started) return;
    if (!isOnline()) {
      // Sin conexión no se llama al proveedor ni se gastan reintentos: se
      // vuelve a mirar pasado el intervalo de reintento.
      armTimer(retryIntervalMs);
      return;
    }
    const provider = await safeResolveProvider();
    if (provider === null) {
      armDaily();
      return;
    }
    const result = await runUpdate(provider);
    if (!started) return;
    if (!result.ok && retries < maxRetries) {
      retries += 1;
      logger.warn?.(`[market] actualización incompleta; reintento ${retries}/${maxRetries}`);
      armTimer(retryIntervalMs);
    } else {
      retries = 0;
      armDaily();
    }
  };

  /** evaluate() sin rechazos flotantes: un fallo inesperado queda en el log. */
  const evaluateSafely = (): Promise<void> =>
    evaluate().catch((error: unknown) => {
      logger.error?.(`[market] la evaluación programada falló: ${String(error)}`);
    });

  const armTimer = (delayMs: number): void => {
    if (!started) return;
    clearTimer();
    timer = setTimeout(
      () => {
        timer = null;
        void evaluateSafely();
      },
      Math.max(0, delayMs),
    );
    // El temporizador no debe mantener vivo el proceso por sí solo.
    timer.unref?.();
  };

  const armDaily = (): void => {
    if (!started) return;
    try {
      // nextUpdateAt devuelve el instante >= ahora: se pide desde now()+1
      // para no rearmar sobre el instante que acaba de ejecutarse.
      const next = nyseCalendar.nextUpdateAt(now() + 1);
      armTimer(Date.parse(next.utc) - now());
    } catch (error: unknown) {
      logger.error?.(`[market] no se pudo programar la próxima actualización: ${String(error)}`);
    }
  };

  const onResume = (): void => {
    logger.info?.('[market] el equipo despertó; se reevalúa el trabajo pendiente');
    void evaluateSafely();
  };

  /** Actualiza un ticker recién añadido sin esperar a la pasada diaria. */
  const ingestNewTicker = async (ticker: string): Promise<void> => {
    if (!isOnline()) {
      publishStatus({
        key: dataStatusKey.ticker(ticker),
        state: 'desactualizado',
        reason: 'sin conexión a internet',
      });
      return;
    }
    const provider = await safeResolveProvider();
    if (provider === null) {
      publishStatus({
        key: dataStatusKey.ticker(ticker),
        state: 'desactualizado',
        reason: 'sin proveedor de datos configurado',
      });
      return;
    }
    await ingestGuarded(ticker, provider);
  };

  // -- API pública -----------------------------------------------------------

  const toMarketBar = (bar: StoredBar): MarketBar => ({
    date: bar.date,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    adjOpen: bar.adjOpen,
    adjHigh: bar.adjHigh,
    adjLow: bar.adjLow,
    adjClose: bar.adjClose,
    adjVolume: bar.adjVolume,
    batchId: bar.batchId,
  });

  const service: MarketIngestionService = {
    listWatchlist: () => repo.listWatchlist(),

    addTicker: async (ticker) => {
      const entry = repo.addWatchlistTicker(ticker);
      await ingestNewTicker(entry.ticker);
      return repo.listWatchlist();
    },

    removeTicker: (ticker) => {
      repo.removeWatchlistTicker(ticker);
      return repo.listWatchlist();
    },

    addUniverse: async () => {
      repo.addWatchlistUniverse(INITIAL_UNIVERSE_TICKERS);
      // La pasada diaria cubre lo que falte; aquí se fuerza una pasada ya.
      if (isOnline()) {
        const provider = await safeResolveProvider();
        if (provider !== null) await runUpdate(provider);
      }
      return repo.listWatchlist();
    },

    getBars: async (request) => {
      const ticker = request.ticker.trim().toUpperCase();
      const rows = repo.getBars(ticker, { desde: request.desde, hasta: request.hasta });
      // Una sola fuente por serie: la del proveedor activo, o la de la vela
      // más reciente guardada si ya no hay proveedor resoluble.
      const provider = await safeResolveProvider();
      const source = provider?.id ?? rows[rows.length - 1]?.source ?? null;
      const bars = (source === null ? rows : rows.filter((r) => r.source === source)).map(
        toMarketBar,
      );
      return { ticker, source, bars };
    },

    refreshNow: async () => {
      if (!isOnline()) return { accepted: false, reason: 'sin-conexion' };
      const provider = await safeResolveProvider();
      if (provider === null) return { accepted: false, reason: 'sin-proveedor' };
      if (repo.listWatchlist().length === 0) return { accepted: false, reason: 'sin-activos' };
      if (running) return { accepted: false, reason: 'en-curso' };
      await runUpdate(provider);
      return { accepted: true, reason: null };
    },

    ...(deps.clock
      ? {
          advanceClock: (deltaMs: number): MarketClockAdvanceResult => {
            const instant = deps.clock!.advance(deltaMs);
            logger.info?.(`[market] reloj adelantado ${deltaMs} ms (desarrollo)`);
            void evaluateSafely();
            return { now: new Date(instant).toISOString() };
          },
        }
      : {}),

    start: () => {
      if (started) return Promise.resolve();
      started = true;
      deps.powerMonitor?.on('resume', onResume);
      // La primera evaluación es la recuperación de arranque: cubre los
      // cierres que quedaron pendientes con la app cerrada.
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
// Registro en la app
// ---------------------------------------------------------------------------

export function registerMarket(ctx: ServiceContext): MarketIngestionService {
  // Sin base de datos el servicio no puede funcionar: se degrada a memoria
  // para que el resto de la app siga arrancando (mismo patrón que settings).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[market] almacén no disponible: los datos de mercado solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createMarketRepository(db);
  const clock = createMarketClock();
  const secrets = ctx.services.secrets;

  let tiingo: MarketDataProvider | null = null;
  let simulated: MarketDataProvider | null = null;
  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);

  const resolveProvider = async (): Promise<MarketDataProvider | null> => {
    if (secrets && (await secrets.hasKey(TIINGO_SECRETS_KEY))) {
      tiingo ??= createTiingoProvider({
        fetch: globalThis.fetch,
        getApiKey: () => secrets.getKey(TIINGO_SECRETS_KEY),
        now: () => clock.now(),
      });
      return tiingo;
    }
    if (e2e) {
      simulated ??= createSimulatedProvider({ seed: 'tradia-e2e', now: () => clock.now() });
      return simulated;
    }
    return null;
  };

  const service = createMarketIngestionService({
    repo,
    resolveProvider,
    broadcast: ctx.broadcast,
    clock,
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
    powerMonitor,
  });

  const list = (): WatchlistItem[] => service.listWatchlist();

  ipcMain.handle(IPC_CHANNELS.watchlist.list, list);
  ipcMain.handle(IPC_CHANNELS.watchlist.add, (_event, ticker: unknown) => {
    if (!isTicker(ticker)) {
      throw new IpcValidationError(IPC_CHANNELS.watchlist.add, 'ticker inválido');
    }
    return service.addTicker(ticker);
  });
  ipcMain.handle(IPC_CHANNELS.watchlist.remove, (_event, ticker: unknown) => {
    if (!isTicker(ticker)) {
      throw new IpcValidationError(IPC_CHANNELS.watchlist.remove, 'ticker inválido');
    }
    return service.removeTicker(ticker);
  });
  ipcMain.handle(IPC_CHANNELS.watchlist.addUniverse, () => service.addUniverse());
  ipcMain.handle(IPC_CHANNELS.market.getBars, (_event, request: unknown) => {
    if (!isGetBarsRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.market.getBars, 'petición inválida');
    }
    return service.getBars(request);
  });
  ipcMain.handle(IPC_CHANNELS.market.refreshNow, () => service.refreshNow());

  // Gancho de desarrollo: la app empaquetada no registra el canal.
  if (!app.isPackaged) {
    ipcMain.handle(IPC_CHANNELS.market.advanceClock, (_event, deltaMs: unknown) => {
      if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs <= 0) {
        throw new IpcValidationError(
          IPC_CHANNELS.market.advanceClock,
          'se esperaba un número de ms positivo',
        );
      }
      return service.advanceClock?.(deltaMs) ?? { now: new Date().toISOString() };
    });
  }

  void service.start();
  return service;
}
