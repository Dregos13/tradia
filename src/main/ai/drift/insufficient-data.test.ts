/**
 * Pruebas de «Salud de modelos» sin evidencia: una ficha registrada sin
 * una sola predicción resuelta no puede aparecer como «saludable»; con
 * resueltas y sin drift sí. Cubre la regla de «Sin datos suficientes»
 * del panel (caso QA: modelo a estrenar vendido como sano).
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DRIFT_BRIER_WINDOW, type FeatureReference } from '../../../shared/ai';
import { openDatabase } from '../../db/database';
import { parseModelCard } from '../prediction/modelCard';
import { createPredictionsRepository } from '../prediction/repository';
import { createDriftRepository } from './repository';
import { createDriftService, type DriftService } from './service';

const HASH = 'a'.repeat(64);
const NOW_MS = Date.parse('2026-10-10T17:30:00.000Z');

const cardJson = (): Record<string, unknown> => ({
  version: '0.1.0',
  hash: HASH,
  horizonDays: 5,
  trainingPeriod: { startDate: '2020-01-01', endDate: '2021-12-31' },
  calibrationPeriod: { startDate: '2022-01-01', endDate: '2022-06-30' },
  testPeriod: { startDate: '2022-07-01', endDate: '2022-12-31' },
  dataOrigin: 'real',
  metrics: { brierOos: 0.18, logLossOos: 0.55, brierBaseline: 0.25 },
  calibration: [],
  referenceDistribution: [] as FeatureReference[],
  trainedAt: '2026-01-01T00:00:00.000Z',
});

let db: Database.Database;
let cardId: number;

const makeService = (): DriftService =>
  createDriftService({
    repo: createDriftRepository(db),
    listWatchlistTickers: () => [],
    barsFor: () => [],
    listStrategies: () => [],
    setStrategyStatus: () => undefined,
    closedTrades: () => [],
    expectationFor: () => ({
      perTradeReturnPct: null,
      winRate: null,
      backtestVersion: null,
      backtestRunId: null,
    }),
    now: () => NOW_MS,
  });

const registerCard = (): void => {
  cardId = createPredictionsRepository(db).registerModelCard(parseModelCard(cardJson())).id;
};

const seedResolved = (count: number): void => {
  const predictions = createPredictionsRepository(db);
  for (let i = 0; i < count; i += 1) {
    const { prediction } = predictions.upsertPrediction({
      ticker: 'AAPL',
      session: `2026-08-${String(i + 1).padStart(2, '0')}`,
      horizonDays: 5,
      probUp: 0.6,
      expectedVolatility: null,
      modelVersion: '0.1.0',
      modelHash: HASH,
      modelCardId: cardId,
    });
    predictions.resolvePrediction(prediction.id, {
      session: '2026-09-01',
      outcomeUp: true,
      realizedBrier: 0.18,
    });
  }
};

const modelRow = (service: DriftService) =>
  service.overview().subjects.find((s) => s.subject === 'modelo')!;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

describe('salud del modelo sin evidencia', () => {
  it('una ficha sin predicciones resueltas queda insuficiente, no saludable', () => {
    registerCard();
    const row = modelRow(makeService());
    expect(row.state).toBe('insuficiente');
    expect(row.reason).toContain(`${DRIFT_BRIER_WINDOW} predicciones resueltas`);
  });

  it('ni siquiera con revisiones ya hechas: sin resueltas sigue sin datos suficientes', () => {
    registerCard();
    const service = makeService();
    service.evaluate(); // revisión diaria con la ventana aún vacía
    const row = modelRow(service);
    expect(row.state).toBe('insuficiente');
  });

  it('con predicciones resueltas en línea con la ficha vuelve a saludable', () => {
    registerCard();
    const service = makeService();
    seedResolved(10);
    service.evaluate();
    const row = modelRow(service);
    expect(row.state).toBe('saludable');
  });
});
