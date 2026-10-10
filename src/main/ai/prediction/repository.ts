/**
 * Repositorio del servicio de predicción sobre `model_cards` y
 * `predictions` (migración 011).
 *
 * - `registerModelCard` es idempotente por (version, hash): una ficha
 *   ya registrada se devuelve tal cual (conserva `id` y `registrado_en`).
 * - `upsertPrediction` es idempotente por (ticker, sesión, horizonte,
 *   versión): una vela corregida actualiza la probabilidad y anula la
 *   resolución para que se recompute con los datos actuales; una fila
 *   idéntica no se toca.
 * - La resolución a t+N la escribe `resolvePrediction`: sesión de la
 *   vela del horizonte, acierto (subida estricta del cierre) y Brier
 *   realizado de esa predicción.
 */
import type Database from 'better-sqlite3';

import {
  PREDICTIONS_MAX_LIMIT,
  type CalibrationBin,
  type FeatureReference,
  type ModelCard,
  type Prediction,
} from '../../../shared/ai';
import { assertValidTicker } from '../../market/providers/types';
import type { NewModelCard } from './modelCard';

const SOURCE = 'ai/prediction';

export class PredictionRepositoryError extends Error {
  readonly code = 'invalid-input';

  constructor(message: string) {
    super(message);
    this.name = 'PredictionRepositoryError';
  }
}

/** Predicción nueva a persistir (sin resolución; llega con la vela t+N). */
export interface NewPrediction {
  ticker: string;
  /** Sesión del cierre evaluado ('YYYY-MM-DD'). */
  session: string;
  horizonDays: number;
  /** Probabilidad calibrada de subida (0–1). */
  probUp: number;
  /** Volatilidad esperada a N sesiones (tanto por uno); null si no aplica. */
  expectedVolatility: number | null;
  modelVersion: string;
  modelHash: string;
  modelCardId: number | null;
}

export interface PredictionsRepository {
  /** Registra la ficha si no existe; devuelve la fila persistida. */
  registerModelCard(card: NewModelCard): ModelCard;
  /** Ficha por (version, hash); null si nunca se registró. */
  modelCard(version: string, hash: string): ModelCard | null;
  /** Última ficha registrada (la más reciente por `registrado_en`). */
  latestModelCard(): ModelCard | null;
  /**
   * Inserta la predicción o, si la vela cambió la probabilidad, la
   * actualiza y anula su resolución para recomputarla. Devuelve la fila
   * y si la escritura cambió algo.
   */
  upsertPrediction(entry: NewPrediction): { prediction: Prediction; changed: boolean };
  /** Predicciones guardadas, más recientes primero. */
  listPredictions(query?: { ticker?: string; limit?: number }): Prediction[];
  /** Última predicción guardada del ticker (cualquier versión). */
  latestPrediction(ticker: string): Prediction | null;
  /** Última sesión con predicción del ticker para una versión concreta. */
  latestSession(ticker: string, modelVersion: string): string | null;
  /** Pendientes de resolver del ticker (todas las versiones), por sesión. */
  pendingResolutions(ticker: string): Prediction[];
  /** Resueltas del ticker (para re-verificarlas tras velas corregidas). */
  resolvedForTicker(ticker: string): Prediction[];
  /** Escribe la resolución a t+N (acierto y Brier realizado). */
  resolvePrediction(
    id: number,
    resolution: { session: string; outcomeUp: boolean; realizedBrier: number },
  ): Prediction | null;
}

interface ModelCardRow {
  id: number;
  version: string;
  hash: string;
  horizonte_dias: number;
  origen_datos: string;
  entrenamiento_desde: string;
  entrenamiento_hasta: string;
  calibracion_desde: string;
  calibracion_hasta: string;
  prueba_desde: string;
  prueba_hasta: string;
  brier_oos: number | null;
  log_loss_oos: number | null;
  brier_referencia: number | null;
  calibracion: string;
  distribucion_referencia: string;
  apto: number;
  motivo_no_apto: string | null;
  entrenado_en: string | null;
  registrado_en: string;
}

interface PredictionRow {
  id: number;
  ticker: string;
  sesion: string;
  horizonte_dias: number;
  prob_subida: number;
  vol_esperada: number | null;
  modelo_version: string;
  modelo_hash: string;
  model_card_id: number | null;
  creado_en: string;
  resuelta_sesion: string | null;
  acierto: number | null;
  brier_realizado: number | null;
}

const CARD_COLUMNS =
  'id, version, hash, horizonte_dias, origen_datos, ' +
  'entrenamiento_desde, entrenamiento_hasta, ' +
  'calibracion_desde, calibracion_hasta, prueba_desde, prueba_hasta, ' +
  'brier_oos, log_loss_oos, brier_referencia, calibracion, ' +
  'distribucion_referencia, apto, motivo_no_apto, entrenado_en, registrado_en';

const PREDICTION_COLUMNS =
  'id, ticker, sesion, horizonte_dias, prob_subida, vol_esperada, ' +
  'modelo_version, modelo_hash, model_card_id, creado_en, ' +
  'resuelta_sesion, acierto, brier_realizado';

const parseJsonArray = <T>(raw: string, field: string): T[] => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    throw new PredictionRepositoryError(`${field}: JSON corrupto en model_cards`);
  }
};

const toModelCard = (row: ModelCardRow): ModelCard => ({
  id: row.id,
  version: row.version,
  hash: row.hash,
  horizonDays: row.horizonte_dias,
  trainingPeriod: { desde: row.entrenamiento_desde, hasta: row.entrenamiento_hasta },
  calibrationPeriod: { desde: row.calibracion_desde, hasta: row.calibracion_hasta },
  testPeriod: { desde: row.prueba_desde, hasta: row.prueba_hasta },
  dataOrigin: row.origen_datos as ModelCard['dataOrigin'],
  metrics: {
    brierOos: row.brier_oos ?? 0,
    logLossOos: row.log_loss_oos,
    brierBaseline: row.brier_referencia ?? 0,
  },
  calibration: parseJsonArray<CalibrationBin>(row.calibracion, 'calibracion'),
  referenceDistribution: parseJsonArray<FeatureReference>(
    row.distribucion_referencia,
    'distribucion_referencia',
  ),
  eligible: row.apto === 1,
  ineligibleReason: row.motivo_no_apto,
  trainedAt: row.entrenado_en ?? '',
  registeredAt: row.registrado_en,
});

const toPrediction = (row: PredictionRow): Prediction => ({
  id: row.id,
  ticker: row.ticker,
  sessionDate: row.sesion,
  horizonDays: row.horizonte_dias,
  probUp: row.prob_subida,
  probDown: 1 - row.prob_subida,
  expectedVolatility: row.vol_esperada,
  modelVersion: row.modelo_version,
  modelHash: row.modelo_hash,
  modelCardId: row.model_card_id,
  createdAt: row.creado_en,
  resolvedSession: row.resuelta_sesion,
  outcomeUp: row.acierto === null ? null : row.acierto === 1,
  realizedBrier: row.brier_realizado,
});

function normalizeTicker(ticker: string): string {
  if (typeof ticker !== 'string' || ticker.trim() === '') {
    throw new PredictionRepositoryError('ticker vacío');
  }
  const key = ticker.trim().toUpperCase();
  assertValidTicker(key, SOURCE);
  return key;
}

function assertFinite(value: number | null, field: string): void {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new PredictionRepositoryError(`${field} no es un número finito`);
  }
}

export function createPredictionsRepository(db: Database.Database): PredictionsRepository {
  const insertCard = db.prepare(`
    INSERT INTO model_cards (
      version, hash, horizonte_dias, origen_datos,
      entrenamiento_desde, entrenamiento_hasta,
      calibracion_desde, calibracion_hasta, prueba_desde, prueba_hasta,
      brier_oos, log_loss_oos, brier_referencia,
      calibracion, distribucion_referencia,
      apto, motivo_no_apto, entrenado_en, registrado_en
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectCard = db.prepare(
    `SELECT ${CARD_COLUMNS} FROM model_cards WHERE version = ? AND hash = ?`,
  );
  const selectLatestCard = db.prepare(
    `SELECT ${CARD_COLUMNS} FROM model_cards ORDER BY registrado_en DESC, id DESC LIMIT 1`,
  );
  const selectPrediction = db.prepare(
    `SELECT ${PREDICTION_COLUMNS} FROM predictions
     WHERE ticker = ? AND sesion = ? AND horizonte_dias = ? AND modelo_version = ?`,
  );
  const selectPredictionById = db.prepare(
    `SELECT ${PREDICTION_COLUMNS} FROM predictions WHERE id = ?`,
  );
  const insertPrediction = db.prepare(`
    INSERT INTO predictions (
      ticker, sesion, horizonte_dias, prob_subida, vol_esperada,
      modelo_version, modelo_hash, model_card_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  /** Vela corregida: nueva probabilidad y resolución anulada para recomputarla. */
  const updatePrediction = db.prepare(`
    UPDATE predictions SET
      prob_subida = ?, vol_esperada = ?, model_card_id = ?,
      resuelta_sesion = NULL, acierto = NULL, brier_realizado = NULL
    WHERE id = ?
  `);
  const resolveStmt = db.prepare(`
    UPDATE predictions SET resuelta_sesion = ?, acierto = ?, brier_realizado = ?
    WHERE id = ?
  `);
  const selectLatestPrediction = db.prepare(
    `SELECT ${PREDICTION_COLUMNS} FROM predictions
     WHERE ticker = ? ORDER BY sesion DESC, id DESC LIMIT 1`,
  );
  const selectLatestSession = db.prepare(
    'SELECT MAX(sesion) AS s FROM predictions WHERE ticker = ? AND modelo_version = ?',
  );
  const selectPending = db.prepare(
    `SELECT ${PREDICTION_COLUMNS} FROM predictions
     WHERE ticker = ? AND resuelta_sesion IS NULL ORDER BY sesion, id`,
  );
  const selectResolved = db.prepare(
    `SELECT ${PREDICTION_COLUMNS} FROM predictions
     WHERE ticker = ? AND resuelta_sesion IS NOT NULL ORDER BY sesion, id`,
  );

  const cardByVersionHash = (version: string, hash: string): ModelCard | null => {
    const row = selectCard.get(version, hash) as ModelCardRow | undefined;
    return row === undefined ? null : toModelCard(row);
  };

  const getPredictionById = (id: number): Prediction | null => {
    const row = selectPredictionById.get(id) as PredictionRow | undefined;
    return row === undefined ? null : toPrediction(row);
  };

  return {
    registerModelCard: (card) => {
      const existing = cardByVersionHash(card.version, card.hash);
      if (existing !== null) return existing;
      insertCard.run(
        card.version,
        card.hash,
        card.horizonDays,
        card.dataOrigin,
        card.trainingPeriod.desde,
        card.trainingPeriod.hasta,
        card.calibrationPeriod.desde,
        card.calibrationPeriod.hasta,
        card.testPeriod.desde,
        card.testPeriod.hasta,
        card.metrics.brierOos,
        card.metrics.logLossOos,
        card.metrics.brierBaseline,
        JSON.stringify(card.calibration),
        JSON.stringify(card.referenceDistribution),
        card.eligible ? 1 : 0,
        card.ineligibleReason,
        card.trainedAt,
        new Date().toISOString(),
      );
      return cardByVersionHash(card.version, card.hash)!;
    },

    modelCard: cardByVersionHash,

    latestModelCard: () => {
      const row = selectLatestCard.get() as ModelCardRow | undefined;
      return row === undefined ? null : toModelCard(row);
    },

    upsertPrediction: (entry) => {
      const key = normalizeTicker(entry.ticker);
      assertFinite(entry.probUp, 'prob_subida');
      if (entry.probUp < 0 || entry.probUp > 1) {
        throw new PredictionRepositoryError('prob_subida fuera de [0, 1]');
      }
      assertFinite(entry.expectedVolatility, 'vol_esperada');
      if (entry.expectedVolatility !== null && entry.expectedVolatility < 0) {
        throw new PredictionRepositoryError('vol_esperada negativa');
      }
      if (!Number.isInteger(entry.horizonDays) || entry.horizonDays < 1) {
        throw new PredictionRepositoryError('horizonte_dias debe ser un entero >= 1');
      }

      const existing = selectPrediction.get(
        key,
        entry.session,
        entry.horizonDays,
        entry.modelVersion,
      ) as PredictionRow | undefined;

      if (existing === undefined) {
        insertPrediction.run(
          key,
          entry.session,
          entry.horizonDays,
          entry.probUp,
          entry.expectedVolatility,
          entry.modelVersion,
          entry.modelHash,
          entry.modelCardId,
        );
        const row = selectPrediction.get(
          key,
          entry.session,
          entry.horizonDays,
          entry.modelVersion,
        ) as PredictionRow;
        return { prediction: toPrediction(row), changed: true };
      }

      if (
        existing.prob_subida === entry.probUp &&
        existing.vol_esperada === entry.expectedVolatility &&
        existing.model_card_id === entry.modelCardId
      ) {
        return { prediction: toPrediction(existing), changed: false };
      }
      updatePrediction.run(entry.probUp, entry.expectedVolatility, entry.modelCardId, existing.id);
      return { prediction: getPredictionById(existing.id)!, changed: true };
    },

    listPredictions: (query = {}) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.ticker !== undefined) {
        clauses.push('ticker = ?');
        params.push(normalizeTicker(query.ticker));
      }
      const limit = Math.min(
        PREDICTIONS_MAX_LIMIT,
        Math.max(1, Math.floor(query.limit ?? PREDICTIONS_MAX_LIMIT)),
      );
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      const rows = db
        .prepare(
          `SELECT ${PREDICTION_COLUMNS} FROM predictions ${where}
           ORDER BY sesion DESC, id DESC LIMIT ?`,
        )
        .all(...params, limit) as PredictionRow[];
      return rows.map(toPrediction);
    },

    latestPrediction: (ticker) => {
      const row = selectLatestPrediction.get(normalizeTicker(ticker)) as PredictionRow | undefined;
      return row === undefined ? null : toPrediction(row);
    },

    latestSession: (ticker, modelVersion) => {
      const row = selectLatestSession.get(normalizeTicker(ticker), modelVersion) as {
        s: string | null;
      };
      return row.s;
    },

    pendingResolutions: (ticker) =>
      (selectPending.all(normalizeTicker(ticker)) as PredictionRow[]).map(toPrediction),

    resolvedForTicker: (ticker) =>
      (selectResolved.all(normalizeTicker(ticker)) as PredictionRow[]).map(toPrediction),

    resolvePrediction: (id, resolution) => {
      if (!Number.isInteger(id) || id < 1) {
        throw new PredictionRepositoryError('id de predicción inválido');
      }
      assertFinite(resolution.realizedBrier, 'brier_realizado');
      resolveStmt.run(
        resolution.session,
        resolution.outcomeUp ? 1 : 0,
        resolution.realizedBrier,
        id,
      );
      return getPredictionById(id);
    },
  };
}
