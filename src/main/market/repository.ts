/**
 * Repositorio tipado de datos de mercado sobre la migración 003.
 *
 * Único punto de escritura/lectura de `watchlist`, `bars`,
 * `corporate_actions`, `data_batches`, `quality_flags`, `macro_series`,
 * `macro_observations` y `data_status`. Las columnas de la base usan el
 * español de la migración (`fecha`, `fuente`, `lote_id`…); la superficie de
 * este módulo expone tipos en inglés coherentes con `shared/ipc.ts` y
 * `market/providers/types.ts`.
 *
 * Convenciones:
 * - Los tickers se normalizan a mayúsculas sin espacios al entrar.
 * - Toda escritura múltiple corre en una transacción.
 * - `upsertBars` conserva los valores ajustados ya calculados cuando la fila
 *   entrante no los trae (un lote crudo no pisa la limpieza anterior).
 */
import type Database from 'better-sqlite3';

import {
  dataStatusKey,
  WATCHLIST_MAX_ITEMS,
  type DataStatusEntry,
  type DataStatusState,
} from '../../shared/ipc';
import {
  assertValidDateRange,
  assertValidTicker,
  type CorporateActionKind,
  type SessionDate,
} from './providers/types';

const REPOSITORY = 'repository';

// ---------------------------------------------------------------------------
// Tipos de fila
// ---------------------------------------------------------------------------

export interface WatchlistEntry {
  ticker: string;
  /** Alta en la lista (ISO 8601). */
  addedAt: string;
  /** Orden de visualización, 0..n-1. */
  position: number;
}

export interface BarInput {
  date: SessionDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Ajustados por la limpieza; ausentes en lotes crudos. */
  adjOpen?: number | null;
  adjHigh?: number | null;
  adjLow?: number | null;
  adjClose?: number | null;
  adjVolume?: number | null;
}

export interface StoredBar {
  id: number;
  ticker: string;
  date: SessionDate;
  source: string;
  batchId: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjOpen: number | null;
  adjHigh: number | null;
  adjLow: number | null;
  adjClose: number | null;
  adjVolume: number | null;
}

export interface StoredCorporateAction {
  id: number;
  ticker: string;
  date: SessionDate;
  kind: CorporateActionKind;
  value: number;
  source: string;
}

export type BatchScope = 'bars' | 'macro';

/**
 * Resumen de calidad del lote, guardado como JSON en `resumen_calidad`.
 * Los campos conocidos son los del `QualityReport` de `market/cleaning`;
 * el resto viaja por la firma de índice (listas de huecos, duplicados,
 * anomalías, avisos…), así el informe se serializa tal cual.
 */
export interface BatchQualitySummary {
  received?: number;
  kept?: number;
  stored?: number;
  expected?: number;
  reliable?: boolean;
  [extra: string]: unknown;
}

export interface DataBatch {
  id: number;
  version: number;
  hash: string;
  provider: string;
  scope: BatchScope;
  /** Presente cuando scope === 'bars'. */
  ticker: string | null;
  /** Presente cuando scope === 'macro'. */
  seriesId: string | null;
  rangeStart: SessionDate;
  rangeEnd: SessionDate;
  receivedAt: string;
  qualitySummary: BatchQualitySummary;
  createdAt: string;
}

export interface NewDataBatch {
  version: number;
  hash: string;
  provider: string;
  scope: BatchScope;
  ticker?: string;
  seriesId?: string;
  rangeStart: SessionDate;
  rangeEnd: SessionDate;
  /** ISO 8601; por defecto, ahora. */
  receivedAt?: string;
  qualitySummary?: BatchQualitySummary;
}

export const QUALITY_FLAG_KINDS = ['hueco', 'duplicado', 'anomalo'] as const;
export type QualityFlagKind = (typeof QUALITY_FLAG_KINDS)[number];

export interface QualityFlag {
  id: number;
  batchId: number;
  ticker: string | null;
  seriesId: string | null;
  date: SessionDate | null;
  kind: QualityFlagKind;
  detail: string | null;
  createdAt: string;
}

export interface NewQualityFlag {
  batchId: number;
  ticker?: string;
  seriesId?: string;
  date?: SessionDate;
  kind: QualityFlagKind;
  detail?: string;
}

export interface MacroSeriesRow {
  id: string;
  source: string;
  name: string;
  unit: string | null;
  frequency: string | null;
  createdAt: string;
}

export interface NewMacroSeries {
  id: string;
  source: string;
  name: string;
  unit?: string;
  frequency?: string;
}

export interface MacroObservationInput {
  date: SessionDate;
  value: number;
}

export interface MacroObservationRow {
  seriesId: string;
  date: SessionDate;
  value: number;
  batchId: number | null;
}

export interface DataStatusPatch {
  key: string;
  state: DataStatusState;
  /** undefined conserva el valor anterior; null lo borra. */
  lastOkAt?: string | null;
  consecutiveFailures?: number;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export type MarketRepositoryErrorCode = 'watchlist-full' | 'invalid-input';

export class MarketRepositoryError extends Error {
  readonly code: MarketRepositoryErrorCode;

  constructor(code: MarketRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'MarketRepositoryError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Filas crudas de SQLite
// ---------------------------------------------------------------------------

interface WatchlistRow {
  ticker: string;
  alta: string;
  orden: number;
}

interface BarRow {
  id: number;
  ticker: string;
  fecha: string;
  fuente: string;
  lote_id: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adj_open: number | null;
  adj_high: number | null;
  adj_low: number | null;
  adj_close: number | null;
  adj_volume: number | null;
}

interface CorporateActionRow {
  id: number;
  ticker: string;
  fecha: string;
  tipo: CorporateActionKind;
  valor: number;
  fuente: string;
}

interface BatchRow {
  id: number;
  version: number;
  hash: string;
  proveedor: string;
  ambito: BatchScope;
  ticker: string | null;
  serie: string | null;
  desde: string;
  hasta: string;
  recibido_en: string;
  resumen_calidad: string;
  creado_en: string;
}

interface QualityFlagRow {
  id: number;
  lote_id: number;
  ticker: string | null;
  serie: string | null;
  fecha: string | null;
  tipo: QualityFlagKind;
  detalle: string | null;
  creado_en: string;
}

interface MacroSeriesDbRow {
  id: string;
  fuente: string;
  nombre: string;
  unidad: string | null;
  frecuencia: string | null;
  creado_en: string;
}

interface MacroObservationDbRow {
  serie_id: string;
  fecha: string;
  valor: number;
  lote_id: number | null;
}

interface DataStatusDbRow {
  clave: string;
  estado: DataStatusState;
  ultimo_ok: string | null;
  fallos_seguidos: number;
  motivo: string | null;
  actualizado_en: string;
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export interface MarketRepository {
  // Lista de seguimiento
  listWatchlist(): WatchlistEntry[];
  /** Idempotente: si el ticker ya está devuelve su entrada sin duplicar. */
  addWatchlistTicker(ticker: string): WatchlistEntry;
  /** Añade en orden los tickers que falten, hasta WATCHLIST_MAX_ITEMS. */
  addWatchlistUniverse(tickers: readonly string[]): WatchlistEntry[];
  /** Quita el ticker y compacta el orden. Devuelve si existía. */
  removeWatchlistTicker(ticker: string): boolean;

  // Velas
  /** Único por (ticker, fecha, fuente): la fila entrante gana; conserva ajustes. */
  upsertBars(ticker: string, source: string, batchId: number, bars: readonly BarInput[]): number;
  getBars(
    ticker: string,
    filter?: { desde?: SessionDate; hasta?: SessionDate; source?: string },
  ): StoredBar[];
  lastBarDate(ticker: string, source?: string): SessionDate | null;

  // Acciones corporativas
  upsertCorporateActions(actions: readonly StoredCorporateActionInput[]): number;
  getCorporateActions(
    ticker: string,
    desde?: SessionDate,
    hasta?: SessionDate,
  ): StoredCorporateAction[];

  // Lotes
  createBatch(input: NewDataBatch): DataBatch;
  getBatch(id: number): DataBatch | null;
  /** Último lote del ámbito/proveedor para un ticker (`bars`) o serie (`macro`). */
  latestBatch(scope: BatchScope, provider: string, ref: string): DataBatch | null;

  // Marcas de calidad
  addQualityFlags(flags: readonly NewQualityFlag[]): number;
  getQualityFlags(filter?: {
    batchId?: number;
    ticker?: string;
    kind?: QualityFlagKind;
  }): QualityFlag[];

  // Macro
  upsertMacroSeries(series: readonly NewMacroSeries[]): void;
  getMacroSeries(id: string): MacroSeriesRow | null;
  listMacroSeries(): MacroSeriesRow[];
  upsertMacroObservations(
    seriesId: string,
    batchId: number | null,
    observations: readonly MacroObservationInput[],
  ): number;
  getMacroObservations(
    seriesId: string,
    desde?: SessionDate,
    hasta?: SessionDate,
  ): MacroObservationRow[];
  lastMacroObservationDate(seriesId: string): SessionDate | null;

  // Salud del dato
  getDataStatus(key: string): DataStatusEntry | null;
  listDataStatus(): DataStatusEntry[];
  /** Fusiona el parche con la fila existente; `actualizado_en` se pone a ahora. */
  setDataStatus(patch: DataStatusPatch): DataStatusEntry;
}

export interface StoredCorporateActionInput {
  ticker: string;
  date: SessionDate;
  kind: CorporateActionKind;
  value: number;
  source: string;
}

const nowIso = (): string => new Date().toISOString();

function normalizeTicker(ticker: string, what = 'ticker'): string {
  if (typeof ticker !== 'string' || ticker.trim() === '') {
    throw new MarketRepositoryError('invalid-input', `${what} vacío`);
  }
  return ticker.trim().toUpperCase();
}

function assertFinite(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MarketRepositoryError('invalid-input', `${field} no es un número finito`);
  }
}

export function createMarketRepository(db: Database.Database): MarketRepository {
  // -- Lista de seguimiento -------------------------------------------------

  const watchlistRows = (): WatchlistEntry[] =>
    (
      db.prepare('SELECT ticker, alta, orden FROM watchlist ORDER BY orden').all() as WatchlistRow[]
    ).map((row) => ({ ticker: row.ticker, addedAt: row.alta, position: row.orden }));

  const addWatchlistTicker = (ticker: string): WatchlistEntry => {
    const key = normalizeTicker(ticker);
    const existing = db
      .prepare('SELECT ticker, alta, orden FROM watchlist WHERE ticker = ?')
      .get(key) as WatchlistRow | undefined;
    if (existing) {
      return { ticker: existing.ticker, addedAt: existing.alta, position: existing.orden };
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM watchlist').get() as { n: number }).n;
    if (count >= WATCHLIST_MAX_ITEMS) {
      throw new MarketRepositoryError(
        'watchlist-full',
        `la lista de seguimiento admite un máximo de ${WATCHLIST_MAX_ITEMS} activos`,
      );
    }
    const addedAt = nowIso();
    db.prepare('INSERT INTO watchlist (ticker, alta, orden) VALUES (?, ?, ?)').run(
      key,
      addedAt,
      count,
    );
    return { ticker: key, addedAt, position: count };
  };

  const compactWatchlist = db.transaction(() => {
    const rows = db.prepare('SELECT ticker FROM watchlist ORDER BY orden').all() as {
      ticker: string;
    }[];
    const update = db.prepare('UPDATE watchlist SET orden = ? WHERE ticker = ?');
    rows.forEach((row, index) => update.run(index, row.ticker));
  });

  // -- Velas ----------------------------------------------------------------

  const upsertBarStmt = db.prepare(`
    INSERT INTO bars (
      ticker, fecha, fuente, lote_id,
      open, high, low, close, volume,
      adj_open, adj_high, adj_low, adj_close, adj_volume
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ticker, fecha, fuente) DO UPDATE SET
      lote_id = excluded.lote_id,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      adj_open = COALESCE(excluded.adj_open, bars.adj_open),
      adj_high = COALESCE(excluded.adj_high, bars.adj_high),
      adj_low = COALESCE(excluded.adj_low, bars.adj_low),
      adj_close = COALESCE(excluded.adj_close, bars.adj_close),
      adj_volume = COALESCE(excluded.adj_volume, bars.adj_volume)
  `);

  const toStoredBar = (row: BarRow): StoredBar => ({
    id: row.id,
    ticker: row.ticker,
    date: row.fecha,
    source: row.fuente,
    batchId: row.lote_id,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    adjOpen: row.adj_open,
    adjHigh: row.adj_high,
    adjLow: row.adj_low,
    adjClose: row.adj_close,
    adjVolume: row.adj_volume,
  });

  // -- Lotes ----------------------------------------------------------------

  const toDataBatch = (row: BatchRow): DataBatch => {
    let summary: BatchQualitySummary = {};
    try {
      const parsed: unknown = JSON.parse(row.resumen_calidad);
      if (typeof parsed === 'object' && parsed !== null) {
        summary = parsed as BatchQualitySummary;
      }
    } catch {
      console.warn(`[market] resumen_calidad ilegible en el lote ${row.id}`);
    }
    return {
      id: row.id,
      version: row.version,
      hash: row.hash,
      provider: row.proveedor,
      scope: row.ambito,
      ticker: row.ticker,
      seriesId: row.serie,
      rangeStart: row.desde,
      rangeEnd: row.hasta,
      receivedAt: row.recibido_en,
      qualitySummary: summary,
      createdAt: row.creado_en,
    };
  };

  // -- Salud del dato --------------------------------------------------------

  const toDataStatus = (row: DataStatusDbRow): DataStatusEntry => ({
    key: row.clave,
    state: row.estado,
    lastOkAt: row.ultimo_ok,
    consecutiveFailures: row.fallos_seguidos,
    reason: row.motivo,
    updatedAt: row.actualizado_en,
  });

  const repo: MarketRepository = {
    listWatchlist: watchlistRows,

    addWatchlistTicker,

    addWatchlistUniverse: (tickers) => {
      const added: WatchlistEntry[] = [];
      for (const ticker of tickers) {
        try {
          added.push(addWatchlistTicker(ticker));
        } catch (error: unknown) {
          if (error instanceof MarketRepositoryError && error.code === 'watchlist-full') break;
          throw error;
        }
      }
      return added;
    },

    removeWatchlistTicker: (ticker) => {
      const key = normalizeTicker(ticker);
      const removed = db.transaction(() => {
        const result = db.prepare('DELETE FROM watchlist WHERE ticker = ?').run(key);
        if (result.changes > 0) compactWatchlist();
        return result.changes > 0;
      });
      return removed();
    },

    upsertBars: (ticker, source, batchId, bars) => {
      const key = normalizeTicker(ticker);
      if (typeof source !== 'string' || source.trim() === '') {
        throw new MarketRepositoryError('invalid-input', 'fuente vacía en upsertBars');
      }
      let written = 0;
      db.transaction(() => {
        for (const bar of bars) {
          assertValidDateRange(bar.date, bar.date, REPOSITORY);
          for (const [field, value] of [
            ['open', bar.open],
            ['high', bar.high],
            ['low', bar.low],
            ['close', bar.close],
            ['volume', bar.volume],
          ] as const) {
            assertFinite(value, `bars.${field}`);
          }
          written += upsertBarStmt.run(
            key,
            bar.date,
            source,
            batchId,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            bar.adjOpen ?? null,
            bar.adjHigh ?? null,
            bar.adjLow ?? null,
            bar.adjClose ?? null,
            bar.adjVolume ?? null,
          ).changes;
        }
      })();
      return written;
    },

    getBars: (ticker, filter = {}) => {
      const key = normalizeTicker(ticker);
      const clauses = ['ticker = ?'];
      const params: unknown[] = [key];
      if (filter.source !== undefined) {
        clauses.push('fuente = ?');
        params.push(filter.source);
      }
      if (filter.desde !== undefined) {
        clauses.push('fecha >= ?');
        params.push(filter.desde);
      }
      if (filter.hasta !== undefined) {
        clauses.push('fecha <= ?');
        params.push(filter.hasta);
      }
      const rows = db
        .prepare(`SELECT * FROM bars WHERE ${clauses.join(' AND ')} ORDER BY fecha`)
        .all(...params) as BarRow[];
      return rows.map(toStoredBar);
    },

    lastBarDate: (ticker, source) => {
      const key = normalizeTicker(ticker);
      const row = (
        source === undefined
          ? db.prepare('SELECT MAX(fecha) AS f FROM bars WHERE ticker = ?').get(key)
          : db
              .prepare('SELECT MAX(fecha) AS f FROM bars WHERE ticker = ? AND fuente = ?')
              .get(key, source)
      ) as { f: string | null };
      return row.f;
    },

    upsertCorporateActions: (actions) => {
      const stmt = db.prepare(`
        INSERT INTO corporate_actions (ticker, fecha, tipo, valor, fuente)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (ticker, fecha, tipo, fuente) DO UPDATE SET valor = excluded.valor
      `);
      let written = 0;
      db.transaction(() => {
        for (const action of actions) {
          const key = normalizeTicker(action.ticker);
          assertValidDateRange(action.date, action.date, REPOSITORY);
          assertValidTicker(key, REPOSITORY);
          assertFinite(action.value, 'corporate_actions.valor');
          written += stmt.run(key, action.date, action.kind, action.value, action.source).changes;
        }
      })();
      return written;
    },

    getCorporateActions: (ticker, desde, hasta) => {
      const key = normalizeTicker(ticker);
      const clauses = ['ticker = ?'];
      const params: unknown[] = [key];
      if (desde !== undefined) {
        clauses.push('fecha >= ?');
        params.push(desde);
      }
      if (hasta !== undefined) {
        clauses.push('fecha <= ?');
        params.push(hasta);
      }
      const rows = db
        .prepare(
          `SELECT * FROM corporate_actions WHERE ${clauses.join(' AND ')} ORDER BY fecha, tipo`,
        )
        .all(...params) as CorporateActionRow[];
      return rows.map((row) => ({
        id: row.id,
        ticker: row.ticker,
        date: row.fecha,
        kind: row.tipo,
        value: row.valor,
        source: row.fuente,
      }));
    },

    createBatch: (input) => {
      if (!Number.isInteger(input.version) || input.version < 1) {
        throw new MarketRepositoryError('invalid-input', 'la versión del lote debe ser >= 1');
      }
      if (typeof input.hash !== 'string' || input.hash.trim() === '') {
        throw new MarketRepositoryError('invalid-input', 'el lote necesita un hash de contenido');
      }
      assertValidDateRange(input.rangeStart, input.rangeEnd, REPOSITORY);
      const ticker = input.scope === 'bars' ? normalizeTicker(input.ticker ?? '') : null;
      const seriesId =
        input.scope === 'macro' && typeof input.seriesId === 'string' && input.seriesId.trim()
          ? input.seriesId.trim()
          : null;
      if (input.scope === 'macro' && seriesId === null) {
        throw new MarketRepositoryError('invalid-input', 'un lote macro necesita su serie');
      }
      const result = db
        .prepare(
          `INSERT INTO data_batches (
            version, hash, proveedor, ambito, ticker, serie, desde, hasta, recibido_en, resumen_calidad
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.version,
          input.hash,
          input.provider,
          input.scope,
          ticker,
          seriesId,
          input.rangeStart,
          input.rangeEnd,
          input.receivedAt ?? nowIso(),
          JSON.stringify(input.qualitySummary ?? {}),
        );
      const created = db
        .prepare('SELECT * FROM data_batches WHERE id = ?')
        .get(result.lastInsertRowid) as BatchRow;
      return toDataBatch(created);
    },

    getBatch: (id) => {
      const row = db.prepare('SELECT * FROM data_batches WHERE id = ?').get(id) as
        BatchRow | undefined;
      return row ? toDataBatch(row) : null;
    },

    latestBatch: (scope, provider, ref) => {
      const column = scope === 'bars' ? 'ticker' : 'serie';
      const value = scope === 'bars' ? normalizeTicker(ref) : ref;
      const row = db
        .prepare(
          `SELECT * FROM data_batches
           WHERE ambito = ? AND proveedor = ? AND ${column} = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(scope, provider, value) as BatchRow | undefined;
      return row ? toDataBatch(row) : null;
    },

    addQualityFlags: (flags) => {
      const stmt = db.prepare(
        `INSERT INTO quality_flags (lote_id, ticker, serie, fecha, tipo, detalle)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      let written = 0;
      db.transaction(() => {
        for (const flag of flags) {
          if (!QUALITY_FLAG_KINDS.includes(flag.kind)) {
            throw new MarketRepositoryError(
              'invalid-input',
              `tipo de marca desconocido: ${String(flag.kind)}`,
            );
          }
          written += stmt.run(
            flag.batchId,
            flag.ticker ? normalizeTicker(flag.ticker) : null,
            flag.seriesId ?? null,
            flag.date ?? null,
            flag.kind,
            flag.detail ?? null,
          ).changes;
        }
      })();
      return written;
    },

    getQualityFlags: (filter = {}) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.batchId !== undefined) {
        clauses.push('lote_id = ?');
        params.push(filter.batchId);
      }
      if (filter.ticker !== undefined) {
        clauses.push('ticker = ?');
        params.push(normalizeTicker(filter.ticker));
      }
      if (filter.kind !== undefined) {
        clauses.push('tipo = ?');
        params.push(filter.kind);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM quality_flags ${where} ORDER BY id`)
        .all(...params) as QualityFlagRow[];
      return rows.map((row) => ({
        id: row.id,
        batchId: row.lote_id,
        ticker: row.ticker,
        seriesId: row.serie,
        date: row.fecha,
        kind: row.tipo,
        detail: row.detalle,
        createdAt: row.creado_en,
      }));
    },

    upsertMacroSeries: (series) => {
      const stmt = db.prepare(`
        INSERT INTO macro_series (id, fuente, nombre, unidad, frecuencia)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          fuente = excluded.fuente,
          nombre = excluded.nombre,
          unidad = excluded.unidad,
          frecuencia = excluded.frecuencia
      `);
      db.transaction(() => {
        for (const item of series) {
          if (typeof item.id !== 'string' || item.id.trim() === '') {
            throw new MarketRepositoryError('invalid-input', 'serie macro con id vacío');
          }
          stmt.run(
            item.id.trim(),
            item.source,
            item.name,
            item.unit ?? null,
            item.frequency ?? null,
          );
        }
      })();
    },

    getMacroSeries: (id) => {
      const row = db.prepare('SELECT * FROM macro_series WHERE id = ?').get(id) as
        MacroSeriesDbRow | undefined;
      return row
        ? {
            id: row.id,
            source: row.fuente,
            name: row.nombre,
            unit: row.unidad,
            frequency: row.frecuencia,
            createdAt: row.creado_en,
          }
        : null;
    },

    listMacroSeries: () => {
      const rows = db.prepare('SELECT * FROM macro_series ORDER BY id').all() as MacroSeriesDbRow[];
      return rows.map((row) => ({
        id: row.id,
        source: row.fuente,
        name: row.nombre,
        unit: row.unidad,
        frequency: row.frecuencia,
        createdAt: row.creado_en,
      }));
    },

    upsertMacroObservations: (seriesId, batchId, observations) => {
      const stmt = db.prepare(`
        INSERT INTO macro_observations (serie_id, fecha, valor, lote_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (serie_id, fecha) DO UPDATE SET
          valor = excluded.valor,
          lote_id = COALESCE(excluded.lote_id, macro_observations.lote_id)
      `);
      let written = 0;
      db.transaction(() => {
        for (const obs of observations) {
          assertValidDateRange(obs.date, obs.date, REPOSITORY);
          assertFinite(obs.value, 'macro_observations.valor');
          written += stmt.run(seriesId, obs.date, obs.value, batchId).changes;
        }
      })();
      return written;
    },

    getMacroObservations: (seriesId, desde, hasta) => {
      const clauses = ['serie_id = ?'];
      const params: unknown[] = [seriesId];
      if (desde !== undefined) {
        clauses.push('fecha >= ?');
        params.push(desde);
      }
      if (hasta !== undefined) {
        clauses.push('fecha <= ?');
        params.push(hasta);
      }
      const rows = db
        .prepare(`SELECT * FROM macro_observations WHERE ${clauses.join(' AND ')} ORDER BY fecha`)
        .all(...params) as MacroObservationDbRow[];
      return rows.map((row) => ({
        seriesId: row.serie_id,
        date: row.fecha,
        value: row.valor,
        batchId: row.lote_id,
      }));
    },

    lastMacroObservationDate: (seriesId) => {
      const row = db
        .prepare('SELECT MAX(fecha) AS f FROM macro_observations WHERE serie_id = ?')
        .get(seriesId) as { f: string | null };
      return row.f;
    },

    getDataStatus: (key) => {
      const row = db.prepare('SELECT * FROM data_status WHERE clave = ?').get(key) as
        DataStatusDbRow | undefined;
      return row ? toDataStatus(row) : null;
    },

    listDataStatus: () => {
      const rows = db
        .prepare('SELECT * FROM data_status ORDER BY clave')
        .all() as DataStatusDbRow[];
      return rows.map(toDataStatus);
    },

    setDataStatus: (patch) => {
      const write = db.transaction(() => {
        const current = db.prepare('SELECT * FROM data_status WHERE clave = ?').get(patch.key) as
          DataStatusDbRow | undefined;
        const merged: DataStatusDbRow = {
          clave: patch.key,
          estado: patch.state,
          ultimo_ok: patch.lastOkAt === undefined ? (current?.ultimo_ok ?? null) : patch.lastOkAt,
          fallos_seguidos:
            patch.consecutiveFailures === undefined
              ? (current?.fallos_seguidos ?? 0)
              : Math.max(0, Math.floor(patch.consecutiveFailures)),
          motivo: patch.reason === undefined ? (current?.motivo ?? null) : patch.reason,
          actualizado_en: nowIso(),
        };
        db.prepare(
          `INSERT INTO data_status (clave, estado, ultimo_ok, fallos_seguidos, motivo, actualizado_en)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (clave) DO UPDATE SET
             estado = excluded.estado,
             ultimo_ok = excluded.ultimo_ok,
             fallos_seguidos = excluded.fallos_seguidos,
             motivo = excluded.motivo,
             actualizado_en = excluded.actualizado_en`,
        ).run(
          merged.clave,
          merged.estado,
          merged.ultimo_ok,
          merged.fallos_seguidos,
          merged.motivo,
          merged.actualizado_en,
        );
        return merged;
      });
      return toDataStatus(write());
    },
  };

  return repo;
}

// Reexport para que el resto del proceso principal no importe shared/ipc solo
// por las claves de estado.
export { dataStatusKey };
