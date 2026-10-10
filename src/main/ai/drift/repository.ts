/**
 * Repositorio de la detección de degradación — fase 6 (`drift_checks`,
 * `retrain_proposals` y la marca de degradada sobre `model_cards`,
 * migración 011).
 *
 * - `insertCheck` guarda una revisión ('datos' y 'resultados' sobre el
 *   modelo, 'rendimiento' sobre una estrategia) con su persistencia: el
 *   número de revisiones consecutivas en alerta hasta esa evaluación.
 * - `createProposal` es idempotente por trimestre natural (UNIQUE
 *   `trimestre` con INSERT OR IGNORE): pedir una segunda propuesta en el
 *   mismo trimestre devuelve la existente sin duplicarla.
 * - `markModelCardDegraded` deja constancia en la ficha (`apto = 0` con
 *   el motivo) sin borrar la fila: reversible y sin pérdida de datos.
 * - Las lecturas de `predictions` son de solo consulta (Brier móvil de
 *   las resueltas); la escritura sigue siendo del servicio de predicción.
 */
import type Database from 'better-sqlite3';

import {
  RETRAIN_PROPOSAL_STATUSES,
  type DriftCheck,
  type DriftCheckKind,
  type DriftSubject,
  type ModelCard,
  type RetrainProposal,
  type RetrainProposalStatus,
} from '../../../shared/ai';
import { createPredictionsRepository } from '../prediction/repository';

export class DriftRepositoryError extends Error {
  readonly code = 'invalid-input';

  constructor(message: string) {
    super(message);
    this.name = 'DriftRepositoryError';
  }
}

/** Revisión nueva a persistir (sin id; `evaluatedAt` la da el servicio). */
export interface NewDriftCheck {
  subject: DriftSubject;
  subjectId: number | null;
  subjectName: string;
  kind: DriftCheckKind;
  /** Revisiones consecutivas en alerta hasta esta evaluación (0 si no alerta). */
  streak: number;
  detail: Record<string, number | string>;
  drifted: boolean;
  evaluatedAt: string;
}

/** Propuesta nueva; `trimestre` 'YYYY-Qn' decide la unicidad. */
export interface NewRetrainProposal {
  modelCardId: number | null;
  strategyId: number | null;
  quarter: string;
  reason: string;
  dataScope: string | null;
  createdAt: string;
}

export interface DriftRepository {
  insertCheck(check: NewDriftCheck): DriftCheck;
  /** Historial del sujeto (y tipo) en orden cronológico. */
  listChecks(subject: DriftSubject, subjectId: number, kind?: DriftCheckKind): DriftCheck[];
  /** Última revisión del sujeto (y tipo); null si nunca se evaluó. */
  latestCheck(subject: DriftSubject, subjectId: number, kind?: DriftCheckKind): DriftCheck | null;
  /** Instante de la última revisión evaluada (cualquier sujeto); null si ninguna. */
  latestEvaluatedAt(): string | null;

  /** Una por trimestre: `inserted` false si ya existía una propuesta en ese trimestre. */
  createProposal(proposal: NewRetrainProposal): { proposal: RetrainProposal; inserted: boolean };
  /** Pendientes primero (más recientes arriba), después el historial resuelto. */
  listProposals(): RetrainProposal[];
  getProposal(id: number): RetrainProposal | null;
  /**
   * Resuelve una propuesta pendiente ('aprobada'/'pospuesta' con nota y
   * fecha opcionales). Devuelve null si no existe o ya estaba resuelta.
   */
  resolveProposal(
    id: number,
    resolution: {
      status: 'aprobada' | 'pospuesta';
      note: string | null;
      postponedUntil: string | null;
      resolvedAt: string;
    },
  ): RetrainProposal | null;

  /** Última ficha de modelo registrada (delegado del repositorio de predicción). */
  latestModelCard(): ModelCard | null;
  /** Brier realizado de las últimas `limit` predicciones resueltas de la versión. */
  resolvedBriers(modelVersion: string, limit: number): number[];
  /** Predicciones resueltas disponibles de la versión (sin tope de ventana). */
  resolvedCount(modelVersion: string): number;
  /**
   * Marca la ficha como degradada (`apto` 0 + motivo). Devuelve false si
   * la ficha no existe o ya estaba marcada con ese motivo.
   */
  markModelCardDegraded(cardId: number, reason: string): boolean;
}

// ---------------------------------------------------------------------------
// Filas crudas y conversión
// ---------------------------------------------------------------------------

interface DriftCheckRow {
  id: number;
  ambito: DriftSubject;
  sujeto_id: number | null;
  sujeto_nombre: string;
  tipo: DriftCheckKind;
  persistencia: number;
  detalle: string;
  resultado: 'ok' | 'alerta';
  evaluado_en: string;
}

interface ProposalRow {
  id: number;
  model_card_id: number | null;
  estrategia_id: number | null;
  trimestre: string;
  motivo: string;
  ambito_datos: string | null;
  estado: RetrainProposalStatus;
  nota: string | null;
  pospuesta_hasta: string | null;
  creado_en: string;
  resuelta_en: string | null;
  entrenado_en: string | null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Trimestre natural 'YYYY-Qn' de una fecha 'YYYY-MM-DD'. */
export function quarterOf(nyDate: string): string {
  const year = nyDate.slice(0, 4);
  const quarter = Math.floor((Number(nyDate.slice(5, 7)) - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}

/** Primer día ('YYYY-MM-DD') del trimestre siguiente a `quarter` ('YYYY-Qn'). */
export function nextQuarterStart(quarter: string): string {
  const year = Number(quarter.slice(0, 4));
  const q = Number(quarter.slice(6, 7));
  if (!Number.isInteger(year) || !Number.isInteger(q) || q < 1 || q > 4) {
    throw new DriftRepositoryError(`trimestre inválido: ${JSON.stringify(quarter)}`);
  }
  const nextYear = q === 4 ? year + 1 : year;
  const nextMonth = q === 4 ? 1 : q * 3 + 1;
  return `${nextYear}-${pad2(nextMonth)}-01`;
}

const toDriftCheck = (row: DriftCheckRow): DriftCheck => {
  let detail: Record<string, number | string> = {};
  try {
    const parsed: unknown = JSON.parse(row.detalle);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      detail = parsed as Record<string, number | string>;
    }
  } catch {
    console.warn(`[ai/drift] detalle ilegible en drift_checks ${row.id}; se devuelve {}`);
  }
  return {
    id: row.id,
    subject: row.ambito,
    subjectId: row.sujeto_id,
    subjectName: row.sujeto_nombre,
    kind: row.tipo,
    streak: row.persistencia,
    detail,
    drifted: row.resultado === 'alerta',
    evaluatedAt: row.evaluado_en,
  };
};

const toProposal = (row: ProposalRow): RetrainProposal => {
  // Primera fecha en que podría proponerse otro reentrenamiento: el
  // inicio del trimestre siguiente, o la fecha de aplazamiento si cae
  // más tarde (una pospuesta larga también retrasa la próxima propuesta).
  const nextQuarter = nextQuarterStart(row.trimestre);
  const nextAllowedAt =
    row.pospuesta_hasta !== null && row.pospuesta_hasta > nextQuarter
      ? row.pospuesta_hasta
      : nextQuarter;
  return {
    id: row.id,
    modelCardId: row.model_card_id,
    strategyId: row.estrategia_id,
    quarter: row.trimestre,
    reason: row.motivo,
    dataScope: row.ambito_datos,
    lastTrainedAt: row.entrenado_en,
    nextAllowedAt,
    status: row.estado,
    note: row.nota,
    postponedUntil: row.pospuesta_hasta,
    createdAt: row.creado_en,
    resolvedAt: row.resuelta_en,
  };
};

const QUARTER_RE = /^\d{4}-Q[1-4]$/;

function assertProposal(input: NewRetrainProposal): void {
  if (!QUARTER_RE.test(input.quarter)) {
    throw new DriftRepositoryError(
      `trimestre inválido (se esperaba 'YYYY-Qn'): ${JSON.stringify(input.quarter)}`,
    );
  }
  if (typeof input.reason !== 'string' || input.reason.trim() === '') {
    throw new DriftRepositoryError('el motivo de la propuesta no puede estar vacío');
  }
}

export function createDriftRepository(db: Database.Database): DriftRepository {
  const predictions = createPredictionsRepository(db);

  const insertCheckStmt = db.prepare(`
    INSERT INTO drift_checks
      (ambito, sujeto_id, sujeto_nombre, tipo, persistencia, detalle, resultado, evaluado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectCheckById = db.prepare(`
    SELECT id, ambito, sujeto_id, sujeto_nombre, tipo, persistencia, detalle, resultado, evaluado_en
    FROM drift_checks WHERE id = ?
  `);
  const selectLatestEvaluated = db.prepare(
    'SELECT MAX(evaluado_en) AS e FROM drift_checks',
  );

  const insertProposalStmt = db.prepare(`
    INSERT OR IGNORE INTO retrain_proposals
      (model_card_id, estrategia_id, trimestre, motivo, ambito_datos, creado_en)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectProposalById = db.prepare(`
    SELECT p.id, p.model_card_id, p.estrategia_id, p.trimestre, p.motivo,
           p.ambito_datos, p.estado, p.nota, p.pospuesta_hasta, p.creado_en,
           p.resuelta_en, m.entrenado_en
    FROM retrain_proposals p
    LEFT JOIN model_cards m ON m.id = p.model_card_id
    WHERE p.id = ?
  `);
  const selectProposalByQuarter = db.prepare(`
    SELECT p.id, p.model_card_id, p.estrategia_id, p.trimestre, p.motivo,
           p.ambito_datos, p.estado, p.nota, p.pospuesta_hasta, p.creado_en,
           p.resuelta_en, m.entrenado_en
    FROM retrain_proposals p
    LEFT JOIN model_cards m ON m.id = p.model_card_id
    WHERE p.trimestre = ?
  `);
  const selectProposals = db.prepare(`
    SELECT p.id, p.model_card_id, p.estrategia_id, p.trimestre, p.motivo,
           p.ambito_datos, p.estado, p.nota, p.pospuesta_hasta, p.creado_en,
           p.resuelta_en, m.entrenado_en
    FROM retrain_proposals p
    LEFT JOIN model_cards m ON m.id = p.model_card_id
    ORDER BY CASE WHEN p.estado = 'pendiente' THEN 0 ELSE 1 END,
             p.creado_en DESC, p.id DESC
  `);
  const resolveProposalStmt = db.prepare(`
    UPDATE retrain_proposals
    SET estado = ?, nota = ?, pospuesta_hasta = ?, resuelta_en = ?
    WHERE id = ? AND estado = 'pendiente'
  `);

  const selectResolvedBriers = db.prepare(`
    SELECT brier_realizado
    FROM predictions
    WHERE modelo_version = ? AND resuelta_sesion IS NOT NULL AND brier_realizado IS NOT NULL
    ORDER BY resuelta_sesion DESC, id DESC
    LIMIT ?
  `);
  const countResolved = db.prepare(`
    SELECT COUNT(*) AS n
    FROM predictions
    WHERE modelo_version = ? AND resuelta_sesion IS NOT NULL AND brier_realizado IS NOT NULL
  `);
  const markDegradedStmt = db.prepare(
    'UPDATE model_cards SET apto = 0, motivo_no_apto = ? WHERE id = ?',
  );

  const getCheck = (id: number): DriftCheck => {
    const row = selectCheckById.get(id) as DriftCheckRow | undefined;
    if (row === undefined) {
      throw new DriftRepositoryError(`revisión de drift ${id} no encontrada tras insertarla`);
    }
    return toDriftCheck(row);
  };

  const getProposalById = (id: number): RetrainProposal | null => {
    const row = selectProposalById.get(id) as ProposalRow | undefined;
    return row === undefined ? null : toProposal(row);
  };

  return {
    insertCheck: (check) => {
      const result = insertCheckStmt.run(
        check.subject,
        check.subjectId,
        check.subjectName,
        check.kind,
        check.streak,
        JSON.stringify(check.detail),
        check.drifted ? 'alerta' : 'ok',
        check.evaluatedAt,
      );
      return getCheck(Number(result.lastInsertRowid));
    },

    listChecks: (subject, subjectId, kind) => {
      const clauses = ['ambito = ?', 'sujeto_id = ?'];
      const params: unknown[] = [subject, subjectId];
      if (kind !== undefined) {
        clauses.push('tipo = ?');
        params.push(kind);
      }
      const rows = db
        .prepare(
          `SELECT id, ambito, sujeto_id, sujeto_nombre, tipo, persistencia, detalle, resultado, evaluado_en
           FROM drift_checks WHERE ${clauses.join(' AND ')}
           ORDER BY evaluado_en, id`,
        )
        .all(...params) as DriftCheckRow[];
      return rows.map(toDriftCheck);
    },

    latestCheck: (subject, subjectId, kind) => {
      const clauses = ['ambito = ?', 'sujeto_id = ?'];
      const params: unknown[] = [subject, subjectId];
      if (kind !== undefined) {
        clauses.push('tipo = ?');
        params.push(kind);
      }
      const row = db
        .prepare(
          `SELECT id, ambito, sujeto_id, sujeto_nombre, tipo, persistencia, detalle, resultado, evaluado_en
           FROM drift_checks WHERE ${clauses.join(' AND ')}
           ORDER BY evaluado_en DESC, id DESC LIMIT 1`,
        )
        .get(...params) as DriftCheckRow | undefined;
      return row === undefined ? null : toDriftCheck(row);
    },

    latestEvaluatedAt: () => {
      const row = selectLatestEvaluated.get() as { e: string | null };
      return row.e;
    },

    createProposal: (proposal) => {
      assertProposal(proposal);
      const result = insertProposalStmt.run(
        proposal.modelCardId,
        proposal.strategyId,
        proposal.quarter,
        proposal.reason.trim(),
        proposal.dataScope,
        proposal.createdAt,
      );
      const row = (
        result.changes > 0
          ? selectProposalById.get(Number(result.lastInsertRowid))
          : selectProposalByQuarter.get(proposal.quarter)
      ) as ProposalRow | undefined;
      if (row === undefined) {
        throw new DriftRepositoryError('no se pudo releer la propuesta de reentrenamiento');
      }
      return { proposal: toProposal(row), inserted: result.changes > 0 };
    },

    listProposals: () =>
      (selectProposals.all() as ProposalRow[]).map(toProposal),

    getProposal: getProposalById,

    resolveProposal: (id, resolution) => {
      if (!Number.isInteger(id) || id < 1) {
        throw new DriftRepositoryError('id de propuesta inválido');
      }
      if (!(RETRAIN_PROPOSAL_STATUSES as readonly string[]).includes(resolution.status)) {
        throw new DriftRepositoryError(`estado de propuesta inválido: ${resolution.status}`);
      }
      const result = resolveProposalStmt.run(
        resolution.status,
        resolution.note,
        resolution.postponedUntil,
        resolution.resolvedAt,
        id,
      );
      return result.changes > 0 ? getProposalById(id) : null;
    },

    latestModelCard: () => predictions.latestModelCard(),

    resolvedBriers: (modelVersion, limit) =>
      (selectResolvedBriers.all(modelVersion, Math.max(0, limit)) as {
        brier_realizado: number;
      }[]).map((row) => row.brier_realizado),

    resolvedCount: (modelVersion) =>
      (countResolved.get(modelVersion) as { n: number }).n,

    markModelCardDegraded: (cardId, reason) => {
      if (!Number.isInteger(cardId) || cardId < 1) {
        throw new DriftRepositoryError('id de ficha inválido');
      }
      return markDegradedStmt.run(reason.trim(), cardId).changes > 0;
    },
  };
}
