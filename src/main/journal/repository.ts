/**
 * Persistencia del diario automático (fase 4) — `journal_entries`
 * (migración 008).
 *
 * El diario es histórico: sobrevive a las fichas de estrategia y a las
 * señales, así que `estrategia_id` no tiene FK y `senal_id` queda en NULL
 * si la señal se borra (`ON DELETE SET NULL`). Los payloads por tipo viajan
 * en JSON (`estrategias`, `datos`, `errores`, `reglas`) y las columnas
 * sueltas (`tipo`, `ticker`, `estrategia_id`, `resultado`, `creado_en`)
 * sirven para filtrar e indexar.
 *
 * La entrada llega ya validada desde el servicio (`index.ts`); aquí solo
 * se normaliza el activo (mayúsculas) y se fija `estrategia_id` a la
 * estrategia principal, que es la primera de la lista.
 */

import type Database from 'better-sqlite3';

import {
  JOURNAL_LIST_MAX_LIMIT,
  type JournalEntry,
  type JournalListQuery,
  type JournalPage,
  type JournalRecordInput,
  type JournalResult,
  type JournalRuleCheck,
  type JournalStrategyRef,
  type JournalEntryType,
} from '../../shared/ipc';

/** Milisegundos de un día; los filtros `hasta` son inclusive por fecha. */
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface JournalRow {
  id: number;
  tipo: string;
  ticker: string | null;
  estrategia_id: number | null;
  estrategias: string;
  motivo: string;
  datos: string | null;
  resultado: string | null;
  errores: string;
  reglas: string;
  senal_id: number | null;
  creado_en: string;
}

export interface JournalRepository {
  /**
   * Inserta la entrada ya normalizada con la fecha de creación dada y
   * devuelve la fila persistida tal como la lee el renderer.
   */
  insert(input: JournalRecordInput, createdAt: string): JournalEntry;
  /** Entrada completa por id; null si no existe. */
  getById(id: number): JournalEntry | null;
  /**
   * Página del diario, más reciente primero, con los filtros del contrato
   * combinados y el recuento total del conjunto filtrado (sin paginar).
   */
  list(query?: JournalListQuery): JournalPage;
}

// ---------------------------------------------------------------------------
// Implementación
// ---------------------------------------------------------------------------

const normalizeTicker = (ticker: string): string => ticker.trim().toUpperCase();

/** Lee un payload JSON de una columna; ante un valor corrupto degrada al fallback. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToEntry(row: JournalRow): JournalEntry {
  return {
    id: row.id,
    type: row.tipo as JournalEntryType,
    createdAt: row.creado_en,
    ticker: row.ticker,
    strategies: parseJson<JournalStrategyRef[]>(row.estrategias, []),
    reason: row.motivo,
    dataUsed: parseJson<Record<string, unknown> | null>(row.datos, null),
    result: (row.resultado as JournalResult | null) ?? null,
    errors: parseJson<string[]>(row.errores, []),
    ruleChecks: parseJson<JournalRuleCheck[]>(row.reglas, []),
    signalId: row.senal_id,
  };
}

/** Día siguiente a `hasta` ('YYYY-MM-DD'): la cota superior es exclusiva. */
function nextDay(isoDate: string): string {
  return new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
}

export function createJournalRepository(db: Database.Database): JournalRepository {
  const insertEntry = db.prepare(
    `INSERT INTO journal_entries
       (tipo, ticker, estrategia_id, estrategias, motivo, datos, resultado, errores, reglas, senal_id, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const entryById = db.prepare('SELECT * FROM journal_entries WHERE id = ?');

  /** WHERE y parámetros del filtro; compartido por la página y el recuento. */
  const buildWhere = (query: JournalListQuery): { where: string; params: (string | number)[] } => {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    // `desde`/`hasta` filtran por fecha de creación (ambos inclusive).
    if (query.desde !== undefined) {
      clauses.push('creado_en >= ?');
      params.push(query.desde);
    }
    if (query.hasta !== undefined) {
      clauses.push('creado_en < ?');
      params.push(nextDay(query.hasta));
    }
    if (query.type !== undefined) {
      clauses.push('tipo = ?');
      params.push(query.type);
    }
    if (query.ticker !== undefined) {
      clauses.push('ticker = ?');
      params.push(normalizeTicker(query.ticker));
    }
    if (query.strategyId !== undefined) {
      // La entrada puede tocar varias estrategias (p. ej. contradicción):
      // el filtro acierta si cualquiera de las referencias coincide.
      clauses.push(
        `EXISTS (
           SELECT 1 FROM json_each(journal_entries.estrategias) ref
           WHERE json_extract(ref.value, '$.strategyId') = ?
         )`,
      );
      params.push(query.strategyId);
    }
    if (query.result !== undefined) {
      clauses.push('resultado = ?');
      params.push(query.result);
    }
    return {
      where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  };

  return {
    insert: (input, createdAt) => {
      const strategies = input.strategies ?? [];
      const result = insertEntry.run(
        input.type,
        input.ticker !== undefined && input.ticker !== null ? normalizeTicker(input.ticker) : null,
        strategies[0]?.strategyId ?? null,
        JSON.stringify(strategies),
        input.reason,
        input.dataUsed !== undefined && input.dataUsed !== null
          ? JSON.stringify(input.dataUsed)
          : null,
        input.result ?? null,
        JSON.stringify(input.errors ?? []),
        JSON.stringify(input.ruleChecks ?? []),
        input.signalId ?? null,
        createdAt,
      );
      const row = entryById.get(Number(result.lastInsertRowid)) as JournalRow;
      return rowToEntry(row);
    },

    getById: (id) => {
      const row = entryById.get(id) as JournalRow | undefined;
      return row === undefined ? null : rowToEntry(row);
    },

    list: (query = {}) => {
      const { where, params } = buildWhere(query);
      const limit = Math.min(query.limit ?? JOURNAL_LIST_MAX_LIMIT, JOURNAL_LIST_MAX_LIMIT);
      const offset = query.offset ?? 0;
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM journal_entries ${where}`).get(...params) as {
          n: number;
        }
      ).n;
      const rows = db
        .prepare(`SELECT * FROM journal_entries ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as JournalRow[];
      return { entries: rows.map(rowToEntry), total, limit, offset };
    },
  };
}
