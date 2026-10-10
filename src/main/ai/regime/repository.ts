/**
 * Repositorio del régimen de mercado sobre la tabla `regimes`
 * (migración 011).
 *
 * Una fila por (ambito, ticker, sesión): 'activo' para cada activo del
 * seguimiento y 'mercado' para la referencia (SPY). `upsert` es
 * idempotente por sesión: un recálculo de la misma vela actualiza las
 * medidas pero no crea duplicados.
 *
 * `previousChange` no se guarda: se reconstruye al leer buscando la
 * última sesión anterior con la etiqueta de dirección distinta; la fecha
 * del cambio es la primera sesión guardada después de ella.
 */
import type Database from 'better-sqlite3';

import {
  REGIME_DIRECTION_LABELS,
  REGIME_SCOPES,
  REGIME_VOLATILITY_LABELS,
  type RegimeDirectionLabel,
  type RegimeMetrics,
  type RegimeScope,
  type RegimeSnapshot,
  type RegimeVolatilityLabel,
} from '../../../shared/ai';
import { assertValidDateRange, assertValidTicker } from '../../market/providers/types';

const SOURCE = 'ai/regime';

export class RegimeRepositoryError extends Error {
  readonly code = 'invalid-input';

  constructor(message: string) {
    super(message);
    this.name = 'RegimeRepositoryError';
  }
}

/** Etiquetas de los dos ejes de una fila o clasificación. */
export interface RegimeRowLabels {
  direction: RegimeDirectionLabel;
  volatility: RegimeVolatilityLabel;
}

/** Fila a persistir para un cierre evaluado. */
export interface NewRegimeEntry {
  scope: RegimeScope;
  ticker: string;
  /** Sesión del cierre evaluado ('YYYY-MM-DD'). */
  session: string;
  direction: RegimeDirectionLabel;
  volatility: RegimeVolatilityLabel;
  metrics: RegimeMetrics;
  /** ISO 8601; por defecto la marca de la base. */
  computedAt?: string;
}

export interface RegimesRepository {
  /** Inserta o actualiza la fila de la sesión; devuelve la instantánea. */
  upsert(entry: NewRegimeEntry): RegimeSnapshot;
  get(scope: RegimeScope, ticker: string, session: string): RegimeSnapshot | null;
  /** Última sesión guardada del ámbito/ticker; null si nunca se calculó. */
  latest(scope: RegimeScope, ticker: string): RegimeSnapshot | null;
  /** Fecha de la última sesión guardada; null si ninguna. */
  latestSession(scope: RegimeScope, ticker: string): string | null;
  /** Última fila con sesión estrictamente anterior a `session`. */
  previousSession(scope: RegimeScope, ticker: string, session: string): RegimeSnapshot | null;
  /** Historial ordenado por sesión (para lecturas y el backtest con filtro). */
  list(
    scope: RegimeScope,
    ticker: string,
    filter?: { desde?: string; hasta?: string },
  ): RegimeSnapshot[];
}

interface RegimeRow {
  ambito: RegimeScope;
  ticker: string;
  sesion: string;
  eje_direccion: RegimeDirectionLabel;
  eje_volatilidad: RegimeVolatilityLabel;
  adx: number | null;
  sma_pendiente: number | null;
  vol_realizada: number | null;
  vol_mediana: number | null;
  creado_en: string;
}

const COLUMNS =
  'ambito, ticker, sesion, eje_direccion, eje_volatilidad, ' +
  'adx, sma_pendiente, vol_realizada, vol_mediana, creado_en';

function normalizeTicker(ticker: string): string {
  if (typeof ticker !== 'string' || ticker.trim() === '') {
    throw new RegimeRepositoryError('ticker vacío');
  }
  const key = ticker.trim().toUpperCase();
  assertValidTicker(key, SOURCE);
  return key;
}

function assertScope(scope: RegimeScope): void {
  if (!(REGIME_SCOPES as readonly string[]).includes(scope)) {
    throw new RegimeRepositoryError(`ámbito de régimen desconocido: ${String(scope)}`);
  }
}

function assertLabel(value: string, labels: readonly string[], field: string): void {
  if (!labels.includes(value)) {
    throw new RegimeRepositoryError(`${field}: etiqueta desconocida: ${JSON.stringify(value)}`);
  }
}

function assertMetric(value: number | null, field: string): void {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new RegimeRepositoryError(`${field} no es un número finito`);
  }
}

export function createRegimeRepository(db: Database.Database): RegimesRepository {
  const upsertStmt = db.prepare(`
    INSERT INTO regimes (
      ambito, ticker, sesion, eje_direccion, eje_volatilidad,
      adx, sma_pendiente, vol_realizada, vol_mediana, creado_en
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ambito, ticker, sesion) DO UPDATE SET
      eje_direccion = excluded.eje_direccion,
      eje_volatilidad = excluded.eje_volatilidad,
      adx = excluded.adx,
      sma_pendiente = excluded.sma_pendiente,
      vol_realizada = excluded.vol_realizada,
      vol_mediana = excluded.vol_mediana,
      creado_en = excluded.creado_en
  `);
  const selectOne = db.prepare(
    `SELECT ${COLUMNS} FROM regimes WHERE ambito = ? AND ticker = ? AND sesion = ?`,
  );
  const selectLatest = db.prepare(
    `SELECT ${COLUMNS} FROM regimes
     WHERE ambito = ? AND ticker = ? ORDER BY sesion DESC, id DESC LIMIT 1`,
  );
  const selectLatestSession = db.prepare(
    'SELECT MAX(sesion) AS s FROM regimes WHERE ambito = ? AND ticker = ?',
  );
  const selectPrevious = db.prepare(
    `SELECT ${COLUMNS} FROM regimes
     WHERE ambito = ? AND ticker = ? AND sesion < ? ORDER BY sesion DESC, id DESC LIMIT 1`,
  );
  /** Última sesión anterior con una etiqueta de dirección distinta. */
  const selectLastDifferentDirection = db.prepare(
    `SELECT sesion, eje_direccion AS d FROM regimes
     WHERE ambito = ? AND ticker = ? AND sesion < ? AND eje_direccion != ?
     ORDER BY sesion DESC LIMIT 1`,
  );
  /** Primera sesión guardada después de una fecha: inicio de la racha actual. */
  const selectFirstAfter = db.prepare(
    'SELECT MIN(sesion) AS s FROM regimes WHERE ambito = ? AND ticker = ? AND sesion > ?',
  );

  /**
   * Reconstruye `previousChange`: la dirección anterior y la sesión en
   * que empezó la racha vigente. Null si nunca hubo otra dirección.
   */
  const previousChangeFor = (row: RegimeRow): RegimeSnapshot['previousChange'] => {
    const different = selectLastDifferentDirection.get(
      row.ambito,
      row.ticker,
      row.sesion,
      row.eje_direccion,
    ) as { sesion: string; d: RegimeDirectionLabel } | undefined;
    if (different === undefined) return null;
    const first = selectFirstAfter.get(row.ambito, row.ticker, different.sesion) as {
      s: string | null;
    };
    if (first.s === null) return null;
    return { direction: different.d, sessionDate: first.s };
  };

  const toSnapshot = (row: RegimeRow): RegimeSnapshot => ({
    scope: row.ambito,
    ticker: row.ticker,
    sessionDate: row.sesion,
    direction: row.eje_direccion,
    volatility: row.eje_volatilidad,
    metrics: {
      adx: row.adx,
      smaSlope: row.sma_pendiente,
      realizedVolatility: row.vol_realizada,
      volatilityMedian: row.vol_mediana,
    },
    previousChange: previousChangeFor(row),
    computedAt: row.creado_en,
  });

  const get = (scope: RegimeScope, ticker: string, session: string): RegimeSnapshot | null => {
    assertScope(scope);
    const key = normalizeTicker(ticker);
    assertValidDateRange(session, session, SOURCE);
    const row = selectOne.get(scope, key, session) as RegimeRow | undefined;
    return row === undefined ? null : toSnapshot(row);
  };

  return {
    upsert: (entry) => {
      assertScope(entry.scope);
      const key = normalizeTicker(entry.ticker);
      assertValidDateRange(entry.session, entry.session, SOURCE);
      assertLabel(entry.direction, REGIME_DIRECTION_LABELS, 'eje_direccion');
      assertLabel(entry.volatility, REGIME_VOLATILITY_LABELS, 'eje_volatilidad');
      assertMetric(entry.metrics.adx, 'adx');
      assertMetric(entry.metrics.smaSlope, 'sma_pendiente');
      assertMetric(entry.metrics.realizedVolatility, 'vol_realizada');
      assertMetric(entry.metrics.volatilityMedian, 'vol_mediana');
      upsertStmt.run(
        entry.scope,
        key,
        entry.session,
        entry.direction,
        entry.volatility,
        entry.metrics.adx,
        entry.metrics.smaSlope,
        entry.metrics.realizedVolatility,
        entry.metrics.volatilityMedian,
        entry.computedAt ?? new Date().toISOString(),
      );
      return get(entry.scope, key, entry.session)!;
    },

    get,

    latest: (scope, ticker) => {
      assertScope(scope);
      const row = selectLatest.get(scope, normalizeTicker(ticker)) as RegimeRow | undefined;
      return row === undefined ? null : toSnapshot(row);
    },

    latestSession: (scope, ticker) => {
      assertScope(scope);
      const row = selectLatestSession.get(scope, normalizeTicker(ticker)) as {
        s: string | null;
      };
      return row.s;
    },

    previousSession: (scope, ticker, session) => {
      assertScope(scope);
      const key = normalizeTicker(ticker);
      assertValidDateRange(session, session, SOURCE);
      const row = selectPrevious.get(scope, key, session) as RegimeRow | undefined;
      return row === undefined ? null : toSnapshot(row);
    },

    list: (scope, ticker, filter = {}) => {
      assertScope(scope);
      const key = normalizeTicker(ticker);
      const clauses = ['ambito = ?', 'ticker = ?'];
      const params: unknown[] = [scope, key];
      if (filter.desde !== undefined) {
        clauses.push('sesion >= ?');
        params.push(filter.desde);
      }
      if (filter.hasta !== undefined) {
        clauses.push('sesion <= ?');
        params.push(filter.hasta);
      }
      const rows = db
        .prepare(
          `SELECT ${COLUMNS} FROM regimes WHERE ${clauses.join(' AND ')} ORDER BY sesion, id`,
        )
        .all(...params) as RegimeRow[];
      return rows.map(toSnapshot);
    },
  };
}
