/**
 * Persistencia de la rutina diaria (fase 4) — `routine_runs`
 * (migración 008) y lecturas de conciliación.
 *
 * `routine_runs` es la deduplicación «como mucho una vez al día»: el
 * UNIQUE (rutina, dia) decide qué evaluación envía, así un despertar
 * tardío, un reloj adelantado o dos evaluaciones seguidas no repiten
 * el resumen. `con_retraso` marca el envío hecho tras perder la hora y
 * `journal_id` enlaza con la entrada 'resumen' del diario.
 *
 * Las lecturas de conciliación (`routineReads`) consultan
 * `risk_portfolio_positions` y `risk_equity_history` en modo solo
 * lectura: la escritura de la cartera simulada sigue siendo exclusiva
 * de `src/main/risk/`. Aquí solo se cuadra lo ya escrito.
 */

import type Database from 'better-sqlite3';

import type { RoutineKind } from '../../shared/journal';
import type { PaperPositionRecord } from '../risk/portfolio';

// ---------------------------------------------------------------------------
// Registro de ejecuciones (routine_runs)
// ---------------------------------------------------------------------------

export interface RoutineRunRecord {
  id: number;
  rutina: RoutineKind;
  /** Día de mercado al que corresponde ('YYYY-MM-DD', America/New_York). */
  dia: string;
  /** Instante real del envío (ISO 8601). */
  enviadaEn: string;
  /** true si se envió al despertar tras perder la hora programada. */
  conRetraso: boolean;
  /** Entrada 'resumen' del diario enlazada; null si aún no se grabó. */
  journalId: number | null;
}

interface RoutineRunRow {
  id: number;
  rutina: string;
  dia: string;
  enviada_en: string;
  con_retraso: number;
  journal_id: number | null;
}

const toRunRecord = (row: RoutineRunRow): RoutineRunRecord => ({
  id: row.id,
  rutina: row.rutina as RoutineKind,
  dia: row.dia,
  enviadaEn: row.enviada_en,
  conRetraso: row.con_retraso === 1,
  journalId: row.journal_id,
});

export interface RoutineRunsRepository {
  /**
   * Reserva la ejecución de `rutina` para `dia`: INSERT OR IGNORE sobre el
   * UNIQUE (rutina, dia). Devuelve el id de la fila reservada, o null si
   * ya existía (la rutina de ese día ya se envió o está en curso).
   */
  claim(rutina: RoutineKind, dia: string, conRetraso: boolean, enviadaEn: string): number | null;
  /** Enlaza la entrada 'resumen' del diario con la ejecución. */
  attachJournal(runId: number, journalId: number): void;
  /** true si la rutina de ese día ya tiene ejecución registrada. */
  has(rutina: RoutineKind, dia: string): boolean;
  /** Ejecución registrada, o null. */
  get(rutina: RoutineKind, dia: string): RoutineRunRecord | null;
}

export function createRoutineRunsRepository(db: Database.Database): RoutineRunsRepository {
  const claimStmt = db.prepare(
    `INSERT OR IGNORE INTO routine_runs (rutina, dia, con_retraso, enviada_en)
     VALUES (?, ?, ?, ?)`,
  );
  const attachStmt = db.prepare('UPDATE routine_runs SET journal_id = ? WHERE id = ?');
  const hasStmt = db.prepare('SELECT 1 AS x FROM routine_runs WHERE rutina = ? AND dia = ?');
  const getStmt = db.prepare('SELECT * FROM routine_runs WHERE rutina = ? AND dia = ?');

  return {
    claim: (rutina, dia, conRetraso, enviadaEn) => {
      const result = claimStmt.run(rutina, dia, conRetraso ? 1 : 0, enviadaEn);
      return result.changes > 0 ? Number(result.lastInsertRowid) : null;
    },
    attachJournal: (runId, journalId) => {
      attachStmt.run(journalId, runId);
    },
    has: (rutina, dia) => hasStmt.get(rutina, dia) !== undefined,
    get: (rutina, dia) => {
      const row = getStmt.get(rutina, dia) as RoutineRunRow | undefined;
      return row === undefined ? null : toRunRecord(row);
    },
  };
}

// ---------------------------------------------------------------------------
// Lecturas de conciliación (solo lectura sobre la cartera simulada)
// ---------------------------------------------------------------------------

interface PositionRow {
  id: number;
  ticker: string;
  direccion: string;
  entrada: number;
  stop: number | null;
  objetivo: number | null;
  tamano: number;
  sector: string | null;
  divisa: string;
  senal_id: number | null;
  vela_apertura: string | null;
  salida: number | null;
  motivo_salida: string | null;
  abierta_en: string;
  cerrada_en: string | null;
}

const toPaperPosition = (row: PositionRow): PaperPositionRecord => ({
  id: row.id,
  ticker: row.ticker,
  direction: row.direccion as PaperPositionRecord['direction'],
  entry: row.entrada,
  stop: row.stop,
  target: row.objetivo,
  size: row.tamano,
  sector: row.sector,
  currency: row.divisa,
  signalId: row.senal_id,
  openedOnBar: row.vela_apertura,
  openedAt: row.abierta_en,
  closedAt: row.cerrada_en,
  exit: row.salida,
  exitReason: row.motivo_salida as PaperPositionRecord['exitReason'],
});

/** Punto de la curva de capital simulada (`risk_equity_history`). */
export interface EquityHistoryRow {
  /** Instante del punto (ISO 8601). */
  fecha: string;
  capital: number;
}

/**
 * Lecturas que necesita la conciliación: posiciones simuladas (abiertas y
 * cerradas) y la curva de capital completa, en orden cronológico.
 */
export interface RoutineReads {
  /** Todas las posiciones simuladas, por id. */
  listPaperPositions(): PaperPositionRecord[];
  /** Posición por id; null si no existe. */
  getPaperPosition(id: number): PaperPositionRecord | null;
  /** true si alguna posición (abierta o cerrada) enlaza la señal. */
  hasPositionForSignal(signalId: number): boolean;
  /** Curva de capital completa, más antigua primero. */
  listEquityHistory(): EquityHistoryRow[];
}

export function createRoutineReads(db: Database.Database): RoutineReads {
  const allPositions = db.prepare('SELECT * FROM risk_portfolio_positions ORDER BY id');
  const positionById = db.prepare('SELECT * FROM risk_portfolio_positions WHERE id = ?');
  const bySignal = db.prepare(
    'SELECT 1 AS x FROM risk_portfolio_positions WHERE senal_id = ? LIMIT 1',
  );
  const equity = db.prepare('SELECT fecha, capital FROM risk_equity_history ORDER BY fecha');

  return {
    listPaperPositions: () => (allPositions.all() as PositionRow[]).map(toPaperPosition),
    getPaperPosition: (id) => {
      const row = positionById.get(id) as PositionRow | undefined;
      return row === undefined ? null : toPaperPosition(row);
    },
    hasPositionForSignal: (signalId) => bySignal.get(signalId) !== undefined,
    listEquityHistory: () => equity.all() as EquityHistoryRow[],
  };
}
