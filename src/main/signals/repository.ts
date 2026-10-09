/**
 * Repositorio de señales — Fase 4.
 *
 * Único punto de escritura/lectura de la tabla `signals` (migración 008).
 * Las columnas de la base usan el español de la migración; la superficie
 * expone los tipos en inglés de `shared/signals.ts`.
 *
 * Reglas de negocio:
 * - La misma vela del mismo activo no genera dos señales: el UNIQUE de
 *   (ticker, vela_fecha) se reafirma aquí — un duplicado devuelve la fila
 *   ya guardada con `inserted: false` en lugar de lanzar.
 * - Las vetadas también se guardan: «sin señal» solo existe por
 *   contradicción entre estrategias y vive en el diario, no en esta tabla.
 * - JSON defensivo: un payload ilegible devuelve el valor vacío y lo deja
 *   en el log, igual que en `strategies/repository.ts`.
 */
import type Database from 'better-sqlite3';

import type { RiskDecision, SignalDirection } from '../../shared/risk';
import {
  SIGNALS_LIST_MAX_LIMIT,
  type Signal,
  type SignalDataUsed,
  type SignalStrategyVote,
  type SignalsListQuery,
} from '../../shared/signals';

// ---------------------------------------------------------------------------
// Filas crudas de SQLite
// ---------------------------------------------------------------------------

interface SignalRow {
  id: number;
  ticker: string;
  direccion: SignalDirection;
  entrada: number;
  stop: number | null;
  objetivo: number | null;
  confianza: number;
  motivo: string;
  estrategias: string;
  datos_usados: string;
  decision: string;
  estado: RiskDecision['status'];
  vela_fecha: string;
  creado_en: string;
}

/** Lo que el motor persiste por cada señal emitida. */
export interface NewSignal {
  ticker: string;
  direction: SignalDirection;
  entry: number;
  stop: number | null;
  target: number | null;
  confidence: number;
  reason: string;
  strategies: SignalStrategyVote[];
  dataUsed: SignalDataUsed;
  decision: RiskDecision;
  /** Fecha de la vela cuyo cierre disparó la evaluación ('YYYY-MM-DD'). */
  barDate: string;
}

export interface InsertSignalResult {
  signal: Signal;
  /** false si ya existía una señal para (ticker, barDate): idempotencia. */
  inserted: boolean;
}

// ---------------------------------------------------------------------------
// JSON defensivo (mismo criterio que strategies/repository.ts)
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string, fallback: T, what: string, ref: string): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed as T;
  } catch {
    // cae al warn de abajo
  }
  console.warn(`[signals] ${what} ilegible en ${ref}; se devuelve el valor vacío`);
  return fallback;
}

function toSignal(row: SignalRow): Signal {
  const ref = `señal ${row.id}`;
  return {
    id: row.id,
    ticker: row.ticker,
    direction: row.direccion,
    entry: row.entrada,
    stop: row.stop,
    target: row.objetivo,
    confidence: row.confianza,
    reason: row.motivo,
    strategies: parseJson<SignalStrategyVote[]>(row.estrategias, [], 'estrategias', ref),
    dataUsed: parseJson<SignalDataUsed>(row.datos_usados, {} as SignalDataUsed, 'datos_usados', ref),
    decision: parseJson<RiskDecision>(row.decision, {} as RiskDecision, 'decision', ref),
    createdAt: row.creado_en,
  };
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export interface SignalsRepository {
  /**
   * Inserta la señal; si ya existe una para (ticker, barDate) devuelve la
   * existente con `inserted: false` (idempotencia del motor).
   */
  insertSignal(input: NewSignal): InsertSignalResult;
  /** true si ya hay una señal para esa vela de ese activo. */
  signalExists(ticker: string, barDate: string): boolean;
  /** Señal por id; null si no existe. */
  getSignal(id: number): Signal | null;
  /** Señales emitidas con los filtros del contrato, más recientes primero. */
  listSignals(query?: SignalsListQuery): Signal[];
}

export function createSignalsRepository(db: Database.Database): SignalsRepository {
  const insert = db.prepare(
    `INSERT INTO signals (
       ticker, direccion, entrada, stop, objetivo, confianza, motivo,
       estrategias, datos_usados, decision, estado, vela_fecha
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectById = db.prepare('SELECT * FROM signals WHERE id = ?');
  const selectByBar = db.prepare('SELECT * FROM signals WHERE ticker = ? AND vela_fecha = ?');
  const existsStmt = db.prepare(
    'SELECT 1 AS x FROM signals WHERE ticker = ? AND vela_fecha = ? LIMIT 1',
  );

  const getRowById = (id: number): SignalRow | null =>
    (selectById.get(id) as SignalRow | undefined) ?? null;

  const getRowByBar = (ticker: string, barDate: string): SignalRow | null =>
    (selectByBar.get(ticker, barDate) as SignalRow | undefined) ?? null;

  const repo: SignalsRepository = {
    insertSignal: (input) => {
      let row: SignalRow | null = null;
      try {
        const result = insert.run(
          input.ticker,
          input.direction,
          input.entry,
          input.stop,
          input.target,
          input.confidence,
          input.reason,
          JSON.stringify(input.strategies),
          JSON.stringify(input.dataUsed),
          JSON.stringify(input.decision),
          input.decision.status,
          input.barDate,
        );
        row = getRowById(Number(result.lastInsertRowid));
      } catch (error: unknown) {
        // UNIQUE (ticker, vela_fecha): la vela ya produjo su señal.
        const code = (error as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_UNIQUE' && code !== 'SQLITE_CONSTRAINT') throw error;
      }
      if (row === null) {
        const existing = getRowByBar(input.ticker, input.barDate);
        if (existing === null) throw new Error('signals: inserción fallida sin fila previa');
        return { signal: toSignal(existing), inserted: false };
      }
      return { signal: toSignal(row), inserted: true };
    },

    signalExists: (ticker, barDate) => existsStmt.get(ticker, barDate) !== undefined,

    getSignal: (id) => {
      const row = Number.isInteger(id) && id > 0 ? getRowById(id) : null;
      return row === null ? null : toSignal(row);
    },

    listSignals: (query = {}) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.ticker !== undefined) {
        clauses.push('ticker = ?');
        params.push(query.ticker.trim().toUpperCase());
      }
      if (query.decision !== undefined) {
        clauses.push('estado = ?');
        params.push(query.decision);
      }
      if (query.strategyId !== undefined) {
        // El voto de cada estrategia viaja en el JSON `estrategias`.
        clauses.push(
          `EXISTS (
             SELECT 1 FROM json_each(signals.estrategias) AS je
             WHERE json_extract(je.value, '$.strategyId') = ?
           )`,
        );
        params.push(query.strategyId);
      }
      if (query.desde !== undefined) {
        clauses.push('vela_fecha >= ?');
        params.push(query.desde);
      }
      if (query.hasta !== undefined) {
        clauses.push('vela_fecha <= ?');
        params.push(query.hasta);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(query.limit ?? SIGNALS_LIST_MAX_LIMIT, SIGNALS_LIST_MAX_LIMIT);
      const offset = query.offset ?? 0;
      const rows = db
        .prepare(
          `SELECT * FROM signals ${where} ORDER BY creado_en DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as SignalRow[];
      return rows.map(toSignal);
    },
  };

  return repo;
}
