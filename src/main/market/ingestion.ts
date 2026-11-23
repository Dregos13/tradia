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
 * - Cada activo usa el calendario de su tipo (`assetClass`): NYSE para las
 *   acciones y el 24/5 (`fxCalendar`) para los pares de divisas —tanto para
 *   decidir la vela esperada como para los huecos de la limpieza—; la
 *   pasada diaria sale en la hora más próxima de los calendarios presentes.
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
 * Además, `TRADIA_E2E_MARKET_NOW` fija el instante de arranque del reloj
 * (ver `e2eMarketClockBase`).
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
  WATCHLIST_MAX_ITEMS,
  type AssetClass,
  type GetBarsRequest,
  type MarketBar,
  type MarketBarsResult,
  type MarketClockAdvanceResult,
  type MarketRefreshResult,
  type MarketUpdatedEvent,
  type WatchlistAddResult,
  type WatchlistCoverageEntry,
  type WatchlistItem,
} from '../../shared/ipc';
import { sessionDateLabel } from '../../shared/dates';
import { fxPairForCurrency } from '../../shared/fx';
import { tickerSuggestions } from '../../shared/suggestions';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import * as nyseCalendar from './calendar';
import { fxNextUpdateAt } from './calendar';
import { calendarForAssetClass, type AssetSessionCalendar } from './assetCalendar';
import { cleanBars, deriveCorporateActions, type QualityReport } from './cleaning';
import {
  createSimulatedProvider,
  createTiingoProvider,
  TIINGO_SECRETS_KEY,
  isMarketDataError,
  type Bar,
  type MarketDataErrorKind,
  type MarketDataProvider,
  type SessionDate,
  type TickerInfo,
} from './providers';
import {
  createMarketRepository,
  type BatchQualitySummary,
  type DataStatusPatch,
  type MarketRepository,
  type StoredBar,
} from './repository';
import { registerMarketSearch } from './search';
import { plainStatusReason } from './statusReason';

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

/**
 * Gancho E2E (`TRADIA_E2E_MARKET_NOW`, instante ISO 8601): fija el instante
 * en que arranca el reloj de mercado; desde ahí sigue el tiempo real más los
 * avances de `market:advance-clock`. Permite que una prueba viva en una
 * semana de sesiones conocida sin depender de la fecha del sistema (un salto
 * de 24 h en fin de semana no cruza ningún cierre y no ejercita nada).
 *
 * Devuelve la base para `createMarketClock`, o undefined fuera de E2E, sin
 * la variable o con una fecha inválida. `realNow` es inyectable en pruebas.
 */
export function e2eMarketClockBase(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  realNow: () => number = () => Date.now(),
): (() => number) | undefined {
  if (!isE2eEnabled(isPackaged, env.TRADIA_E2E)) return undefined;
  const pinned = Date.parse(env.TRADIA_E2E_MARKET_NOW ?? '');
  if (Number.isNaN(pinned)) return undefined;
  const realStart = realNow();
  return () => pinned + (realNow() - realStart);
}

/**
 * Gancho E2E (`TRADIA_E2E_UNCOVERED_TICKERS`, lista separada por comas):
 * los tickers que el proveedor simulado declara «sin cobertura» — responde
 * 'not-found' a `getTickerInfo`/`getBars`, como Tiingo con EUR. Por defecto
 * ['EUR'] para que el E2E reproduzca el rechazo del alta; la cadena vacía
 * desactiva la lista (pruebas que necesitan EUR con datos simulados).
 */
export const E2E_DEFAULT_UNCOVERED_TICKERS: readonly string[] = ['EUR'];

export function e2eUncoveredTickers(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isE2eEnabled(isPackaged, env.TRADIA_E2E)) return [];
  const raw = env.TRADIA_E2E_UNCOVERED_TICKERS;
  if (raw === undefined) return [...E2E_DEFAULT_UNCOVERED_TICKERS];
  return raw
    .split(',')
    .map((ticker) => ticker.trim().toUpperCase())
    .filter((ticker) => ticker !== '');
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
  /**
   * true si el fallo es del proveedor entero (red, cuota, credencial): la
   * pasada lo cuenta UNA vez en provider:<id>. Los fallos propios del
   * activo ('not-found', 'bad-data', respuesta vacía → 'sin-cobertura')
   * no lo son.
   */
  providerError?: boolean;
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
  /** Calendario de sesiones por proveedor y tipo de activo. */
  sessionsFor?: (provider: MarketDataProvider, assetClass: AssetClass) => AssetSessionCalendar;
  retryIntervalMs?: number;
  maxRetries?: number;
  logger?: Partial<MarketIngestionLogger>;
}

export interface MarketIngestionService {
  listWatchlist(): WatchlistItem[];
  /**
   * Comprueba la cobertura del ticker en el proveedor (`getTickerInfo`)
   * antes de darlo de alta: si el proveedor no lo cubre se rechaza con
   * 'no-cubierto' y sus alternativas; si no se puede comprobar (sin
   * conexión, sin clave, fallo o cuota) entra como 'pendiente-verificar'
   * y la siguiente ingesta lo resuelve. Devuelve el resultado tipado.
   */
  addTicker(ticker: string): Promise<WatchlistAddResult>;
  removeTicker(ticker: string): WatchlistItem[];
  /** Cobertura del proveedor por activo de la lista (Ajustes › Conectores). */
  watchlistCoverage(): WatchlistCoverageEntry[];
  /** Añade el universo inicial e ingiere lo que falte. */
  addUniverse(): Promise<WatchlistItem[]>;
  getBars(request: GetBarsRequest): Promise<MarketBarsResult>;
  refreshNow(): Promise<MarketRefreshResult>;
  /**
   * Gancho de desarrollo: avanza el reloj y reevalúa el trabajo pendiente.
   * Solo existe si se inyectó `clock`.
   */
  advanceClock?(deltaMs: number): MarketClockAdvanceResult;
  /**
   * Gancho de desarrollo (TRADIA_E2E): hace que el proveedor simulado falle
   * de forma persistente hasta pasar null. Lo consume `market/health.ts`.
   */
  setProviderFailure?(kind: MarketDataErrorKind | null): void;
  /**
   * Listener interno del proceso principal: se emite tras cambiar la
   * watchlist (alta, baja o universo inicial). El calendario económico lo
   * usa para recalcular los resultados de los activos seguidos.
   */
  onWatchlistChanged(listener: (items: WatchlistItem[]) => void): () => void;
  /**
   * Listener interno del proceso principal: se emite tras guardar un lote
   * de velas de un ticker, con la fecha de la última vela del lote (el
   * mismo instante y contenido que el `market:updated` del renderer). El
   * motor de señales (fase 4) lo usa para evaluar las estrategias al
   * cierre de cada vela nueva sin esperar a la siguiente pasada.
   */
  onBarsStored(listener: (event: MarketUpdatedEvent) => void): () => void;
  /** Arranca la programación y recupera cierres perdidos; devuelve cuando
   * termina la primera evaluación (útil en pruebas). */
  start(): Promise<void>;
  /**
   * Puesta al día inmediata fuera del horario programado (al volver la
   * conexión o al guardar la clave del proveedor). No duplica trabajo:
   * comparte la pasada en curso si la hay y arma el temporizador correcto
   * al terminar.
   */
  requestCatchUp(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Calendario compartido por los proveedores reales y el simulado
// ---------------------------------------------------------------------------

/**
 * Calendario de un activo: las sesiones esperadas entre dos fechas (huecos
 * y limpieza) y la última cuyo cierre ya pasó (qué vela toca pedir). La
 * forma es la de `assetCalendar.ts` — `calendarForAssetClass` la resuelve
 * por tipo ('equity' → NYSE, 'fx' → 24/5).
 */
export function defaultSessionsFor(
  _provider: MarketDataProvider,
  assetClass: AssetClass,
): AssetSessionCalendar {
  return calendarForAssetClass(assetClass);
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
  /** Oyentes internos del cambio de watchlist (calendario, fases siguientes). */
  const watchlistListeners = new Set<(items: WatchlistItem[]) => void>();
  /** Oyentes internos de «lote de velas guardado» (motor de señales). */
  const barsStoredListeners = new Set<(event: MarketUpdatedEvent) => void>();

  const emitWatchlistChanged = (): void => {
    const items = repo.listWatchlist();
    for (const listener of watchlistListeners) listener(items);
  };

  const isoNow = (): string => new Date(now()).toISOString();

  /**
   * Todo motivo que llega a la interfaz va en español llano («Tiingo no
   * tiene datos de EUR.», no «el proveedor 'tiingo' no devolvió datos»):
   * la traducción vive en `statusReason` y se aplica aquí, al guardar.
   */
  const publishStatus = (patch: DataStatusPatch, providerId?: string): void => {
    const entry = repo.setDataStatus({
      ...patch,
      reason:
        patch.reason === undefined || patch.reason === null
          ? patch.reason
          : plainStatusReason({
              key: patch.key,
              state: patch.state,
              reason: patch.reason,
              providerId,
            }),
    });
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
    for (const listener of barsStoredListeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        // Un oyente no puede romper la ingesta: el fallo queda en el log.
        logger.error?.(`[market] un oyente de velas guardadas falló: ${String(error)}`);
      }
    }
  };

  // -- Salud del dato --------------------------------------------------------

  const bumpProviderFailure = (provider: MarketDataProvider, reason: string): void => {
    const key = dataStatusKey.provider(provider.id);
    const current = repo.getDataStatus(key);
    const failures = (current?.consecutiveFailures ?? 0) + 1;
    publishStatus(
      {
        key,
        // La credencial rechazada o varios fallos seguidos ya son "no fiable".
        state: failures >= 3 ? 'no-fiable' : 'desactualizado',
        consecutiveFailures: failures,
        reason,
      },
      provider.id,
    );
  };

  const markProviderOk = (provider: MarketDataProvider): void => {
    const key = dataStatusKey.provider(provider.id);
    const current = repo.getDataStatus(key);
    if (current?.state === 'fiable' && current.consecutiveFailures === 0) return;
    publishStatus(
      {
        key,
        state: 'fiable',
        lastOkAt: isoNow(),
        consecutiveFailures: 0,
        reason: null,
      },
      provider.id,
    );
  };

  const classifyFailure = (
    error: unknown,
  ): {
    retryable: boolean;
    reason: string;
    tickerState: 'desactualizado' | 'no-fiable' | 'sin-cobertura';
    /** true si el error es del proveedor entero, no solo del activo. */
    providerError: boolean;
  } => {
    if (isMarketDataError(error)) {
      const e = error;
      if (e.kind === 'not-found') {
        // 404: el proveedor no cubre el símbolo. No es un fallo del
        // proveedor ni un dato malo: queda aislado en 'sin-cobertura'.
        return {
          retryable: false,
          reason: e.message,
          tickerState: 'sin-cobertura',
          providerError: false,
        };
      }
      if (e.kind === 'bad-data') {
        return {
          retryable: false,
          reason: e.message,
          tickerState: 'no-fiable',
          providerError: false,
        };
      }
      if (e.kind === 'auth') {
        return {
          retryable: false,
          reason: e.message,
          tickerState: 'desactualizado',
          providerError: true,
        };
      }
      // 'network' y 'rate-limit': se reintentan.
      return {
        retryable: true,
        reason: e.message,
        tickerState: 'desactualizado',
        providerError: true,
      };
    }
    return {
      retryable: false,
      reason: `error inesperado de ingesta: ${String(error)}`,
      tickerState: 'no-fiable',
      providerError: false,
    };
  };

  const failTicker = (
    ticker: string,
    provider: MarketDataProvider,
    error: unknown,
    onProviderFailure?: (reason: string) => void,
  ): TickerIngestResult => {
    const { retryable, reason: rawReason, tickerState, providerError } = classifyFailure(error);
    const key = dataStatusKey.ticker(ticker);
    const current = repo.getDataStatus(key);
    // El motivo guardado (y devuelto) va ya en llano; el texto técnico
    // del adaptador queda solo en el log.
    const reason =
      plainStatusReason({
        key,
        state: tickerState,
        reason: rawReason,
        providerId: isMarketDataError(error) ? error.provider : provider.id,
      }) ?? rawReason;
    publishStatus(
      {
        key,
        state: tickerState,
        // 'sin-cobertura' no es un fallo: el contador queda a 0 para que la
        // regla de los 3 fallos (proveedor caído) nunca lo degrade.
        consecutiveFailures:
          tickerState === 'sin-cobertura' ? 0 : (current?.consecutiveFailures ?? 0) + 1,
        reason,
      },
      provider.id,
    );
    // El fallo del proveedor se cuenta UNA vez por pasada (el primer
    // fallo de la pasada lo escribe justo después del del activo, para
    // que los avisos se agrupen en uno solo).
    if (providerError) onProviderFailure?.(reason);
    logger.warn?.(`[market] ingesta de ${ticker} falló (${rawReason})`);
    return {
      ticker,
      outcome: 'fallido',
      stored: 0,
      lastDate: repo.lastBarDate(ticker, provider.id),
      retryable,
      reason,
      providerError,
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
    assetClass: AssetClass,
    onProviderFailure?: (reason: string) => void,
  ): Promise<TickerIngestResult> => {
    const statusKey = dataStatusKey.ticker(ticker);
    // El calendario es del tipo de activo: NYSE en acciones, 24/5 en divisas.
    const calendar = sessionsFor(provider, assetClass);
    const lastExpected = calendar.lastExpectedSession(now());
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

    publishStatus(
      {
        key: statusKey,
        state: 'actualizando',
        reason: `descargando velas del ${sessionDateLabel(desde)} al ${sessionDateLabel(hasta)} en '${provider.id}'`,
      },
      provider.id,
    );

    let newBars: Bar[];
    try {
      newBars = await provider.getBars(ticker, desde, hasta);
    } catch (error: unknown) {
      return failTicker(ticker, provider, error, onProviderFailure);
    }

    if (newBars.length === 0) {
      if (lastStored === null) {
        // Respuesta vacía sin historial previo: el proveedor no cubre el
        // símbolo ('sin-cobertura'). Es un caso del activo, no del
        // proveedor: no suma fallos a provider:<id> ni lo marca no fiable,
        // así el resto de la lista sigue trabajando (régimen, predicciones
        // y señales solo se pausan para este ticker).
        const reason = plainStatusReason({
          key: statusKey,
          state: 'sin-cobertura',
          reason: `el proveedor '${provider.id}' no devolvió datos para ${ticker}`,
          providerId: provider.id,
        });
        publishStatus(
          {
            key: statusKey,
            state: 'sin-cobertura',
            consecutiveFailures: 0,
            reason,
          },
          provider.id,
        );
        return {
          ticker,
          outcome: 'fallido',
          stored: 0,
          lastDate: null,
          retryable: false,
          reason: reason ?? undefined,
          providerError: false,
        };
      }
      // La sesión esperada aún no está publicada: merece reintento, pero no
      // es un fallo del proveedor (no se cuentan fallos seguidos).
      const current = repo.getDataStatus(statusKey);
      publishStatus(
        {
          key: statusKey,
          state: current?.state ?? 'desactualizado',
          reason: `esperando la vela del ${sessionDateLabel(hasta)} en '${provider.id}'`,
        },
        provider.id,
      );
      return {
        ticker,
        outcome: 'pendiente',
        stored: 0,
        lastDate: lastStored,
        retryable: true,
        reason: `sin la vela de ${sessionDateLabel(hasta)} todavía`,
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
        calendar,
      },
      { previousBatch: previous ? { version: previous.version, hash: previous.hash } : null },
    );

    if (clean.bars.length === 0) {
      publishStatus(
        {
          key: statusKey,
          state: 'no-fiable',
          consecutiveFailures: 0,
          reason: `todas las velas del lote de '${provider.id}' fueron rechazadas`,
        },
        provider.id,
      );
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

    publishStatus(
      {
        key: statusKey,
        state: clean.report.reliable ? 'fiable' : 'no-fiable',
        lastOkAt: isoNow(),
        consecutiveFailures: 0,
        reason: clean.report.reliable ? null : qualityReason(clean.report),
      },
      provider.id,
    );

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
    assetClass: AssetClass,
    onProviderFailure?: (reason: string) => void,
  ): Promise<TickerIngestResult | null> => {
    if (ingesting.has(ticker)) return null;
    ingesting.add(ticker);
    try {
      return await ingestOne(ticker, provider, assetClass, onProviderFailure);
    } catch (error: unknown) {
      // Defensa ante fallos de base de datos u otros no tipados.
      return failTicker(ticker, provider, error, onProviderFailure);
    } finally {
      ingesting.delete(ticker);
    }
  };

  const runUpdate = (provider: MarketDataProvider): Promise<UpdateAllResult> => {
    // Una sola pasada en vuelo: las llamadas concurrentes comparten promesa.
    if (running) return running;
    const task = (async () => {
      const results: TickerIngestResult[] = [];
      // Una caída del proveedor cuenta UNA vez por pasada, no por activo:
      // un solo corte de red no alcanza la regla de los 3 fallos seguidos.
      let providerBumped = false;
      const bumpOnce = (reason: string): void => {
        if (providerBumped) return;
        providerBumped = true;
        bumpProviderFailure(provider, reason);
      };
      for (const { ticker, assetClass } of repo.listWatchlist()) {
        const result = await ingestGuarded(ticker, provider, assetClass, bumpOnce);
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
        results.push(result);
      }
      const providerError = results.find((r) => r.providerError === true);
      if (providerError !== undefined) bumpOnce(providerError.reason ?? 'fallo del proveedor');
      else markProviderOk(provider);
      const ok = results.every((r) => !r.retryable);
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
      const from = now() + 1;
      let nextMs = Date.parse(nyseCalendar.nextUpdateAt(from).utc);
      // Con divisas en la lista, la pasada sale en la hora más próxima de
      // los dos calendarios (la 01:00 UTC del 24/5 adelanta a la de NYSE).
      if (repo.listWatchlist().some((item) => item.assetClass === 'fx')) {
        nextMs = Math.min(nextMs, Date.parse(fxNextUpdateAt(from).utc));
      }
      armTimer(nextMs - now());
    } catch (error: unknown) {
      logger.error?.(`[market] no se pudo programar la próxima actualización: ${String(error)}`);
    }
  };

  const onResume = (): void => {
    logger.info?.('[market] el equipo despertó; se reevalúa el trabajo pendiente');
    void evaluateSafely();
  };

  /** Actualiza un ticker recién añadido sin esperar a la pasada diaria. */
  const ingestNewTicker = async (item: WatchlistItem): Promise<void> => {
    if (!isOnline()) {
      publishStatus({
        key: dataStatusKey.ticker(item.ticker),
        state: 'desactualizado',
        reason: 'sin conexión a internet',
      });
      return;
    }
    const provider = await safeResolveProvider();
    if (provider === null) {
      publishStatus({
        key: dataStatusKey.ticker(item.ticker),
        state: 'desactualizado',
        reason: 'sin proveedor de datos configurado',
      });
      return;
    }
    await ingestGuarded(item.ticker, provider, item.assetClass);
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

  // -- Alta de ticker con comprobación de cobertura -------------------------

  /**
   * Alternativas para un símbolo sin cobertura: primero el par de divisas
   * que lo sigue ('EUR' → 'EURUSD', operable en la cartera simulada) y
   * después los ETF de la tabla estática ('EUR' → 'FXE').
   */
  const uncoveredSuggestions = (ticker: string): string[] => {
    const pair = fxPairForCurrency(ticker);
    return pair !== null ? [pair, ...tickerSuggestions(ticker)] : [...tickerSuggestions(ticker)];
  };

  /**
   * Alta sin verificación posible: el ticker entra igualmente, con su
   * estado de dato explicando por qué está pendiente, y la siguiente
   * ingesta (al volver la conexión o configurar el proveedor) lo resuelve
   * a cubierto o a 'sin-cobertura'. No se fuerza una ingesta inmediata:
   * sin conexión o sin proveedor no habría petición, y tras un fallo o
   * una cuota agotada la espera sería peor que la pasada programada.
   */
  const addPendingVerification = async (
    ticker: string,
    reason: string,
    providerId?: string,
  ): Promise<WatchlistAddResult> => {
    const entry = repo.addWatchlistTicker(ticker);
    publishStatus(
      {
        key: dataStatusKey.ticker(entry.ticker),
        state: 'desactualizado',
        reason,
      },
      providerId,
    );
    emitWatchlistChanged();
    return { added: true, reason: 'pendiente-verificar' };
  };

  const service: MarketIngestionService = {
    listWatchlist: () => repo.listWatchlist(),

    addTicker: async (ticker) => {
      const key = ticker.trim().toUpperCase();
      const current = repo.listWatchlist();
      // Duplicado y límite se deciden en local, sin gastar cuota del proveedor.
      if (current.some((item) => item.ticker === key)) {
        return { added: false, reason: 'duplicado' };
      }
      if (current.length >= WATCHLIST_MAX_ITEMS) {
        return { added: false, reason: 'limite' };
      }

      if (!isOnline()) {
        return addPendingVerification(
          key,
          'sin conexión a internet: pendiente de verificar la cobertura',
        );
      }
      const provider = await safeResolveProvider();
      if (provider === null) {
        return addPendingVerification(
          key,
          'sin proveedor de datos configurado: pendiente de verificar la cobertura',
        );
      }

      let info: TickerInfo;
      try {
        info = await provider.getTickerInfo(key);
      } catch (error: unknown) {
        if (isMarketDataError(error, 'not-found')) {
          // El proveedor conoce el universo y este símbolo no está: se
          // rechaza con las alternativas conocidas, sin tocar la lista.
          const suggestions = uncoveredSuggestions(key);
          logger.info?.(
            `[market] alta de ${key} rechazada: el proveedor '${provider.id}' no lo cubre`,
          );
          return {
            added: false,
            reason: 'no-cubierto',
            ...(suggestions.length > 0 ? { suggestions } : {}),
          };
        }
        // No se pudo comprobar (red, cuota, clave, respuesta malformada):
        // se añade pendiente y la próxima ingesta lo resuelve. El estado
        // guarda el motivo real del proveedor (ya saneado: «vuelve a
        // pegarla», cuota, transporte…) para que Ajustes lo cuente.
        logger.warn?.(
          `[market] no se pudo verificar ${key} en '${provider.id}', queda pendiente: ${String(
            isMarketDataError(error) ? error.message : error,
          )}`,
        );
        return addPendingVerification(
          key,
          isMarketDataError(error)
            ? error.message
            : `pendiente de verificar la cobertura en '${provider.id}'`,
          isMarketDataError(error) ? error.provider : provider.id,
        );
      }

      const entry = repo.addWatchlistTicker(key, info.assetClass);
      await ingestNewTicker(entry);
      emitWatchlistChanged();
      return {
        added: true,
        reason: null,
        ...(info.name !== undefined ? { name: info.name } : {}),
      };
    },

    watchlistCoverage: () =>
      repo.listWatchlist().map((item) => {
        const key = dataStatusKey.ticker(item.ticker);
        const status = repo.getDataStatus(key);
        if (status?.state === 'sin-cobertura') {
          return {
            ticker: item.ticker,
            coverage: 'sin-cobertura' as const,
            // El motivo sale en llano también para filas escritas por
            // versiones anteriores («ticker 'EUR' no existe»).
            reason: plainStatusReason({ key, state: status.state, reason: status.reason }),
            // La misma alternativa que `uncovered[].suggestion` del resumen
            // de frescura (la tabla estática), para contar una sola historia.
            suggestion: tickerSuggestions(item.ticker)[0] ?? null,
          };
        }
        // La prueba de cobertura es el dato servido: con velas guardadas el
        // proveedor cubre el símbolo; sin ellas el alta quedó pendiente de
        // verificar (o aún no llegó su primera ingesta).
        if (repo.lastBarDate(item.ticker) !== null) {
          return {
            ticker: item.ticker,
            coverage: 'cubierto' as const,
            reason: null,
            suggestion: null,
          };
        }
        return {
          ticker: item.ticker,
          coverage: 'pendiente-verificar' as const,
          reason:
            status === null
              ? null
              : plainStatusReason({ key, state: status.state, reason: status.reason }),
          suggestion: null,
        };
      }),

    removeTicker: (ticker) => {
      repo.removeWatchlistTicker(ticker);
      emitWatchlistChanged();
      return repo.listWatchlist();
    },

    addUniverse: async () => {
      repo.addWatchlistUniverse(INITIAL_UNIVERSE_TICKERS);
      // La pasada diaria cubre lo que falte; aquí se fuerza una pasada ya.
      if (isOnline()) {
        const provider = await safeResolveProvider();
        if (provider !== null) await runUpdate(provider);
      }
      emitWatchlistChanged();
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
      const result = await runUpdate(provider);
      // La pasada corrió pero puede no haber puesto todo al día: la
      // franja del dato necesita el motivo real (HTTP 503, cuota, la
      // vela esperada aún sin publicar), no un «solicitado» optimista.
      const detail =
        result.results.find((r) => r.providerError === true)?.reason ??
        result.results.find((r) => r.reason !== undefined)?.reason ??
        null;
      // Éxito total vs parcial: `ok` solo es true si TODOS los activos
      // quedaron al día — un fallo no reintentable (activo sin cobertura)
      // también da ok=false para que la interfaz no diga «Datos
      // actualizados.» con la lista incompleta.
      const updated = result.results.filter((r) => r.outcome === 'actualizado').length;
      const failedTickers = result.results
        .filter((r) => r.outcome !== 'actualizado')
        .map((r) => r.ticker);
      return {
        accepted: true,
        reason: null,
        ok: failedTickers.length === 0,
        detail,
        updated,
        total: result.results.length,
        failedTickers,
      };
    },

    onWatchlistChanged: (listener) => {
      watchlistListeners.add(listener);
      return () => {
        watchlistListeners.delete(listener);
      };
    },

    onBarsStored: (listener) => {
      barsStoredListeners.add(listener);
      return () => {
        barsStoredListeners.delete(listener);
      };
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

    requestCatchUp: () => {
      logger.info?.('[market] se pide una puesta al día inmediata');
      void evaluateSafely();
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

export interface RegisterMarketOptions {
  /**
   * Reloj compartido con la vigilancia (`market/health.ts`): al adelantarlo
   * con `market:advance-clock` también envejecen los datos para las pruebas
   * de caducidad. Por defecto se crea uno nuevo.
   */
  clock?: MarketClock;
}

export function registerMarket(
  ctx: ServiceContext,
  options: RegisterMarketOptions = {},
): MarketIngestionService {
  // Sin base de datos el servicio no puede funcionar: se degrada a memoria
  // para que el resto de la app siga arrancando (mismo patrón que settings).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[market] almacén no disponible: los datos de mercado solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createMarketRepository(db);
  const clock = options.clock ?? createMarketClock();
  const secrets = ctx.services.secrets;

  let tiingo: MarketDataProvider | null = null;
  let simulated: ReturnType<typeof createSimulatedProvider> | null = null;
  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);
  // Tickers «sin cobertura» del simulado E2E (EUR por defecto, ver
  // TRADIA_E2E_UNCOVERED_TICKERS): reproduce el caso real de Tiingo.
  const uncoveredForE2e = e2eUncoveredTickers(app.isPackaged, process.env);
  const createE2eProvider = (): ReturnType<typeof createSimulatedProvider> =>
    createSimulatedProvider({
      seed: 'tradia-e2e',
      now: () => clock.now(),
      unknownTickers: [...uncoveredForE2e],
    });
  // Gancho E2E: fuerza el proveedor simulado fallando aunque haya clave real.
  let forcedFailure: MarketDataErrorKind | null = null;

  const resolveProvider = async (): Promise<MarketDataProvider | null> => {
    if (e2e && forcedFailure !== null) {
      simulated ??= createE2eProvider();
      simulated.setFailing(forcedFailure);
      return simulated;
    }
    if (secrets && (await secrets.hasKey(TIINGO_SECRETS_KEY))) {
      tiingo ??= createTiingoProvider({
        fetch: globalThis.fetch,
        getApiKey: () => secrets.getKey(TIINGO_SECRETS_KEY),
        now: () => clock.now(),
      });
      return tiingo;
    }
    if (e2e) {
      simulated ??= createE2eProvider();
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

  // Puesta al día sin esperar al horario: al volver la conexión y al
  // guardar la clave del proveedor. Los eventos se observan envolviendo
  // ctx.broadcast (mismo patrón que health/broker); 'online' solo se
  // dispara tras un 'offline' para no reevaluar en cada sondeo.
  let connectivityWasDown = ctx.services.connectivity?.getState().status === 'offline';
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.connectivity.changed) {
      const status = (payload as { status?: unknown }).status;
      if (status === 'online' && connectivityWasDown) {
        service.requestCatchUp();
      }
      if (status === 'offline') connectivityWasDown = true;
      else if (status === 'online') connectivityWasDown = false;
    } else if (channel === IPC_CHANNELS.secrets.changed) {
      if ((payload as { provider?: unknown }).provider === TIINGO_SECRETS_KEY) {
        service.requestCatchUp();
      }
    }
  };

  // Gancho de desarrollo para `market/health.ts` (simulateProviderFailure):
  // activa el fallo persistente del simulado; `resolveProvider` lo devuelve
  // fallando aunque exista una clave real configurada.
  if (e2e) {
    service.setProviderFailure = (kind) => {
      forcedFailure = kind;
      simulated?.setFailing(kind);
    };
  }

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
  ipcMain.handle(IPC_CHANNELS.watchlist.coverage, () => service.watchlistCoverage());
  ipcMain.handle(IPC_CHANNELS.watchlist.addUniverse, () => service.addUniverse());
  registerMarketSearch(ipcMain);
  ipcMain.handle(IPC_CHANNELS.market.getBars, (_event, request: unknown) => {
    if (!isGetBarsRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.market.getBars, 'petición inválida');
    }
    return service.getBars(request);
  });
  ipcMain.handle(IPC_CHANNELS.market.refreshNow, () => service.refreshNow());

  // Gancho de desarrollo: la app empaquetada no registra el canal.
  if (!app.isPackaged) {
    ipcMain.handle(IPC_CHANNELS.market.advanceClock, async (_event, deltaMs: unknown) => {
      if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs <= 0) {
        throw new IpcValidationError(
          IPC_CHANNELS.market.advanceClock,
          'se esperaba un número de ms positivo',
        );
      }
      const result = service.advanceClock?.(deltaMs) ?? { now: new Date().toISOString() };
      // Las series macro refrescan con temporizadores de tiempo real: al
      // adelantar el reloj en desarrollo/E2E hay que ponerlas al día en
      // esta misma llamada, o sus claves macro:* pasarían a
      // 'desactualizado' solo por el salto del reloj. `refreshNow`
      // devuelve el motivo del rechazo, nunca lanza.
      await ctx.services.macro?.refreshNow();
      return result;
    });
  }

  void service.start();
  return service;
}
