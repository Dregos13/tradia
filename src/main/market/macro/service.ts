/**
 * Servicio de series macro del proceso principal.
 *
 * - `refreshAll` baja cada serie del proveedor desde su última fecha
 *   guardada (o los últimos `historyDays` si está vacía) y la persiste en
 *   `macro_observations` con su lote versionado en `data_batches`
 *   (ámbito 'macro'); `syncCatalog` mantiene `macro_series`.
 * - Salud del dato: cada refresco escribe `data_status` con la clave
 *   `macro:<serie>` y, al final, `provider:<id>`. Éxito → 'fiable' con
 *   `ultimo_ok`; fallo → `fallos_seguidos` + 1 y 'no-fiable' al llegar a 3
 *   (los umbrales y las notificaciones los completa la vigilancia de
 *   `market/health.ts`; aquí solo se deja el rastro). Cada cambio se emite
 *   por `data-status:changed`.
 * - Refresco programado: al arrancar (`start`) se lanza un refresco y se
 *   arma el siguiente en `nextUpdateAt` del calendario de NYSE (cierre
 *   16:00 ET + 75 min, en hora de Madrid — para entonces FRED ya ha
 *   publicado el dato del día). Fuera del rango del calendario la
 *   periodicidad cae a 24 h fijas. Sin conexión, el refresco se pospone a
 *   la siguiente cita (la recuperación es automática: cada refresco baja
 *   desde la última fecha guardada).
 * - `getSeries` construye los `MacroSeriesSnapshot` que sirve el handler
 *   IPC `macro:get-series`.
 */
import {
  IPC_CHANNELS,
  dataStatusKey,
  type MacroSeriesQuery,
  type MacroSeriesSnapshot,
} from '../../../shared/ipc';
import { nextUpdateAt } from '../calendar';
import { MarketDataError, type MarketDataErrorKind } from '../providers/types';
import type { MarketRepository } from '../repository';
import type { MacroDataProvider, MacroObservation } from './types';
import { macroBatchHash } from './version';

const DAY_MS = 86_400_000;
/** Histórico inicial por serie (~5 años, con bisiestos de sobra). */
export const MACRO_HISTORY_DAYS = 1_830;
/** Fallos seguidos a partir de los cuales la serie se marca 'no-fiable'. */
export const MACRO_MAX_CONSECUTIVE_FAILURES = 3;

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface MacroServiceDeps {
  provider: MacroDataProvider;
  /** Repositorio sobre la migración 003; null degrada el servicio (sin base). */
  repository: MarketRepository | null;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Emite `data-status:changed` al renderer. */
  broadcast?: (channel: string, payload: unknown) => void;
  /** Guarda de conexión; por defecto siempre en línea. */
  isOnline?: () => boolean;
  /** Temporizadores inyectables para las pruebas; por defecto los globales. */
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Días de histórico en la primera descarga de cada serie. */
  historyDays?: number;
  logger?: { warn(message: string): void; info?(message: string): void };
}

export interface MacroRefreshSeriesResult {
  seriesId: string;
  /** Observaciones recibidas y guardadas en este refresco. */
  stored: number;
  /** Lote creado, o null si no llegaron datos nuevos. */
  batchId: number | null;
  /** 'al-dia' si no quedaba rango por pedir; 'sin-base-de-datos' si falta el almacén. */
  skipped?: 'al-dia' | 'sin-base-de-datos';
  /** Mensaje del fallo, si la serie no se pudo refrescar. */
  error?: string;
}

export interface MacroService {
  /** Id del proveedor activo ('fred', 'macro-simulated'…). */
  readonly providerId: string;
  /** Inserta/actualiza los metadatos de las series del proveedor. */
  syncCatalog(): void;
  /** Refresca una serie concreta; propaga el error tipado del proveedor. */
  refreshSeries(seriesId: string): Promise<MacroRefreshSeriesResult>;
  /** Refresca todas las series del catálogo; un fallo no aborta las demás. */
  refreshAll(): Promise<MacroRefreshSeriesResult[]>;
  /** Snapshots para `macro:get-series` (todas las series registradas). */
  getSeries(query?: MacroSeriesQuery): MacroSeriesSnapshot[];
  /** Instante del próximo refresco programado (ISO 8601) o null. */
  nextRunAt(): string | null;
  /** Refresco al arrancar + programa el diario. Idempotente. */
  start(): void;
  stop(): void;
  /**
   * Gancho de desarrollo (TRADIA_E2E): hace que el proveedor simulado falle
   * de forma persistente hasta pasar null. Lo consume `market/health.ts`.
   */
  setProviderFailure?(kind: MarketDataErrorKind | null): void;
}

const truncate = (text: string, max = 200): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const shiftDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function createMacroService(deps: MacroServiceDeps): MacroService {
  const { provider, repository } = deps;
  const now = deps.now ?? (() => Date.now());
  const isOnline = deps.isOnline ?? (() => true);
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const historyDays = deps.historyDays ?? MACRO_HISTORY_DAYS;
  const logger = deps.logger;

  const isoNow = (): string => new Date(now()).toISOString();
  const today = (): string => isoNow().slice(0, 10);

  const publishStatus = (patch: Parameters<MarketRepository['setDataStatus']>[0]): void => {
    if (!repository) return;
    const entry = repository.setDataStatus(patch);
    deps.broadcast?.(IPC_CHANNELS.dataStatus.changed, entry);
  };

  const markSeriesOk = (seriesId: string): void => {
    publishStatus({
      key: dataStatusKey.macro(seriesId),
      state: 'fiable',
      lastOkAt: isoNow(),
      consecutiveFailures: 0,
      reason: null,
    });
  };

  const failureReason = (error: unknown): string => {
    if (error instanceof MarketDataError) return `${error.kind}: ${truncate(error.message)}`;
    return truncate(String(error));
  };

  const markSeriesFailure = (seriesId: string, error: unknown): void => {
    if (!repository) return;
    const key = dataStatusKey.macro(seriesId);
    const prev = repository.getDataStatus(key);
    const failures = (prev?.consecutiveFailures ?? 0) + 1;
    // 'actualizando' no se conserva tras un fallo: la operación ya terminó.
    const prevState = prev?.state === 'actualizando' ? null : prev?.state;
    publishStatus({
      key,
      state:
        failures >= MACRO_MAX_CONSECUTIVE_FAILURES ? 'no-fiable' : (prevState ?? 'desactualizado'),
      consecutiveFailures: failures,
      reason: failureReason(error),
    });
  };

  const markProvider = (total: number, failures: number): void => {
    if (!repository) return;
    const key = dataStatusKey.provider(provider.id);
    if (failures === 0) {
      publishStatus({
        key,
        state: 'fiable',
        lastOkAt: isoNow(),
        consecutiveFailures: 0,
        reason: null,
      });
      return;
    }
    const prev = repository.getDataStatus(key);
    const count = (prev?.consecutiveFailures ?? 0) + 1;
    publishStatus({
      key,
      state:
        count >= MACRO_MAX_CONSECUTIVE_FAILURES ? 'no-fiable' : (prev?.state ?? 'desactualizado'),
      consecutiveFailures: count,
      reason: `${failures} de ${total} series fallaron en el último refresco`,
    });
  };

  const syncCatalog = (): void => {
    repository?.upsertMacroSeries(
      provider.listSeries().map((meta) => ({
        id: meta.id,
        source: provider.id,
        name: meta.name,
        unit: meta.unit,
        frequency: meta.frequency,
      })),
    );
  };

  const refreshSeries = async (seriesId: string): Promise<MacroRefreshSeriesResult> => {
    if (!repository) return { seriesId, stored: 0, batchId: null, skipped: 'sin-base-de-datos' };
    const meta = provider.listSeries().find((s) => s.id === seriesId);
    if (!meta) {
      throw new MarketDataError('not-found', `serie '${seriesId}' no está en el catálogo`, {
        provider: provider.id,
      });
    }
    const hasta = today();
    const last = repository.lastMacroObservationDate(seriesId);
    // Se repide la última fecha conocida (upsert): FRED revisa valores.
    const desde = last ?? shiftDays(hasta, -historyDays);
    if (desde > hasta) return { seriesId, stored: 0, batchId: null, skipped: 'al-dia' };

    let observations: MacroObservation[];
    publishStatus({
      key: dataStatusKey.macro(seriesId),
      state: 'actualizando',
      reason: `descargando observaciones del ${desde} al ${hasta} en '${provider.id}'`,
    });
    try {
      observations = await provider.getObservations(seriesId, desde, hasta);
    } catch (error) {
      markSeriesFailure(seriesId, error);
      throw error;
    }

    let batchId: number | null = null;
    const stored = repository.getMacroObservations(seriesId, desde, hasta);
    const unchanged =
      stored.length === observations.length &&
      stored.every(
        (s, i) => s.date === observations[i]!.date && s.value === observations[i]!.value,
      );
    if (observations.length > 0 && !unchanged) {
      // Lote solo cuando el contenido cambia: ni lotes vacíos ni reescrituras
      // idénticas, así la versión solo sube cuando cambia el dato.
      const previous = repository.latestBatch('macro', provider.id, seriesId);
      const hash = macroBatchHash(observations);
      const version =
        previous && previous.hash === hash ? previous.version : (previous?.version ?? 0) + 1;
      const batch = repository.createBatch({
        version,
        hash,
        provider: provider.id,
        scope: 'macro',
        seriesId,
        rangeStart: desde,
        rangeEnd: hasta,
        receivedAt: isoNow(),
        qualitySummary: {
          received: observations.length,
          stored: observations.length,
          desde,
          hasta,
        },
      });
      repository.upsertMacroObservations(seriesId, batch.id, observations);
      batchId = batch.id;
    }
    markSeriesOk(seriesId);
    return { seriesId, stored: observations.length, batchId };
  };

  const refreshAll = async (): Promise<MacroRefreshSeriesResult[]> => {
    if (!repository) {
      logger?.warn('[macro] sin base de datos: refresco omitido');
      return [];
    }
    syncCatalog();
    const results: MacroRefreshSeriesResult[] = [];
    let failures = 0;
    for (const meta of provider.listSeries()) {
      try {
        results.push(await refreshSeries(meta.id));
      } catch (error) {
        failures++;
        logger?.warn(`[macro] refresco de '${meta.id}' falló: ${failureReason(error)}`);
        results.push({ seriesId: meta.id, stored: 0, batchId: null, error: failureReason(error) });
      }
    }
    markProvider(provider.listSeries().length, failures);
    return results;
  };

  // -- Programación diaria ---------------------------------------------------

  let started = false;
  let refreshing = false;
  let timer: TimerHandle | null = null;
  let nextRun: string | null = null;

  const runRefresh = async (): Promise<void> => {
    if (refreshing) return;
    if (!isOnline()) {
      logger?.info?.('[macro] sin conexión: refresco pospuesto a la siguiente cita');
      return;
    }
    refreshing = true;
    try {
      await refreshAll();
    } catch (error) {
      logger?.warn(`[macro] refresco diario falló: ${failureReason(error)}`);
    } finally {
      refreshing = false;
    }
  };

  const arm = (): void => {
    if (!started) return;
    let at: number;
    try {
      at = Date.parse(nextUpdateAt(now()).utc);
    } catch {
      // Fuera del rango del calendario (2021–2027): periodicidad de 24 h fijas.
      at = now() + DAY_MS;
    }
    nextRun = new Date(at).toISOString();
    timer = setTimer(
      () => {
        timer = null;
        void runRefresh().finally(arm);
      },
      Math.max(0, at - now()),
    );
    (timer as { unref?: () => void }).unref?.();
  };

  const service: MacroService = {
    providerId: provider.id,
    syncCatalog,
    refreshSeries,
    refreshAll,

    getSeries: (query) => {
      if (!repository) return [];
      return repository.listMacroSeries().map((row) => ({
        id: row.id,
        name: row.name,
        unit: row.unit,
        frequency: row.frequency,
        observations: repository
          .getMacroObservations(row.id, query?.desde)
          .map((obs) => ({ date: obs.date, value: obs.value })),
        status: repository.getDataStatus(dataStatusKey.macro(row.id)),
      }));
    },

    nextRunAt: () => nextRun,

    start: () => {
      if (started) return;
      started = true;
      arm();
      void runRefresh();
    },

    stop: () => {
      started = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      nextRun = null;
    },
  };

  return service;
}
