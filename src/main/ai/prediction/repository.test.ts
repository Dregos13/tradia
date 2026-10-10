import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../db/database';
import { parseModelCard } from './modelCard';
import { createPredictionsRepository, type PredictionsRepository } from './repository';
import type { NewPrediction } from './repository';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const cardJson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: '0.1.0',
  hash: HASH_A,
  horizonDays: 5,
  trainingPeriod: { startDate: '2020-01-01', endDate: '2021-12-31' },
  calibrationPeriod: { startDate: '2022-01-01', endDate: '2022-06-30' },
  testPeriod: { startDate: '2022-07-01', endDate: '2022-12-31' },
  dataOrigin: 'real',
  metrics: { brierOos: 0.18, logLossOos: 0.55, brierBaseline: 0.25 },
  calibration: [{ from: 0, to: 0.5, meanPredicted: 0.4, observed: 0.45, count: 10 }],
  referenceDistribution: [
    { name: 'ret_1', mean: 0.001, std: 0.02, bins: [{ from: null, to: 0, proportion: 0.5 }] },
  ],
  trainedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const entry = (over: Partial<NewPrediction> = {}): NewPrediction => ({
  ticker: 'AAPL',
  session: '2026-01-05',
  horizonDays: 5,
  probUp: 0.62,
  expectedVolatility: 0.021,
  modelVersion: '0.1.0',
  modelHash: HASH_A,
  modelCardId: cardId,
  ...over,
});

let db: Database.Database;
let repo: PredictionsRepository;
let cardId: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createPredictionsRepository(db);
  cardId = repo.registerModelCard(parseModelCard(cardJson())).id;
});

afterEach(() => {
  db.close();
});

describe('registerModelCard', () => {
  it('persiste la ficha con la aptitud decidida por la app', () => {
    const card = repo.registerModelCard(parseModelCard(cardJson()));
    expect(card.id).toBeGreaterThan(0);
    expect(card.eligible).toBe(true);
    expect(card.ineligibleReason).toBeNull();
    expect(card.metrics.brierOos).toBe(0.18);
    expect(card.calibration).toHaveLength(1);
    expect(card.referenceDistribution[0]!.name).toBe('ret_1');
    expect(repo.modelCard('0.1.0', HASH_A)?.id).toBe(card.id);
  });

  it('es idempotente por (version, hash)', () => {
    const first = repo.registerModelCard(parseModelCard(cardJson()));
    const second = repo.registerModelCard(parseModelCard(cardJson()));
    expect(second.id).toBe(first.id);
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(repo.latestModelCard()?.id).toBe(first.id);
  });

  it('un origen sintético queda no apto aunque el Brier mejore la referencia', () => {
    const card = repo.registerModelCard(
      parseModelCard(cardJson({ dataOrigin: 'sintetico', hash: HASH_B })),
    );
    expect(card.eligible).toBe(false);
    expect(card.ineligibleReason).toBe('Datos sintéticos · no apto');
  });

  it('datos reales sin superar la referencia quedan no aptos', () => {
    const card = repo.registerModelCard(
      parseModelCard(
        cardJson({
          hash: HASH_B,
          metrics: { brierOos: 0.3, logLossOos: 0.9, brierBaseline: 0.25 },
        }),
      ),
    );
    expect(card.eligible).toBe(false);
    expect(card.ineligibleReason).toBe('No supera la referencia · no apto para apoyar señales');
  });
});

describe('upsertPrediction', () => {
  it('guarda ticker, sesión, horizonte, probabilidades, versión y hash', () => {
    const { prediction } = repo.upsertPrediction(entry());
    expect(prediction).toMatchObject({
      ticker: 'AAPL',
      sessionDate: '2026-01-05',
      horizonDays: 5,
      probUp: 0.62,
      probDown: 0.38,
      expectedVolatility: 0.021,
      modelVersion: '0.1.0',
      modelHash: HASH_A,
      modelCardId: cardId,
      resolvedSession: null,
      outcomeUp: null,
      realizedBrier: null,
    });
  });

  it('una repetición idéntica no cambia la fila ni borra la resolución', () => {
    const { prediction } = repo.upsertPrediction(entry());
    repo.resolvePrediction(prediction.id, {
      session: '2026-01-12',
      outcomeUp: true,
      realizedBrier: (0.62 - 1) ** 2,
    });
    const again = repo.upsertPrediction(entry());
    expect(again.changed).toBe(false);
    expect(again.prediction.resolvedSession).toBe('2026-01-12');
  });

  it('una vela corregida actualiza la probabilidad y anula la resolución', () => {
    const { prediction } = repo.upsertPrediction(entry());
    repo.resolvePrediction(prediction.id, {
      session: '2026-01-12',
      outcomeUp: true,
      realizedBrier: 0.1,
    });
    const corrected = repo.upsertPrediction(entry({ probUp: 0.55 }));
    expect(corrected.changed).toBe(true);
    expect(corrected.prediction.probUp).toBe(0.55);
    expect(corrected.prediction.resolvedSession).toBeNull();
    expect(corrected.prediction.outcomeUp).toBeNull();
    expect(corrected.prediction.realizedBrier).toBeNull();
  });

  it('la misma sesión con otra versión del modelo es otra fila', () => {
    repo.upsertPrediction(entry());
    repo.upsertPrediction(entry({ modelVersion: '0.2.0' }));
    expect(repo.listPredictions({ ticker: 'AAPL' })).toHaveLength(2);
  });
});

describe('resolución y consultas', () => {
  it('resuelve con sesión, acierto y Brier realizado', () => {
    const { prediction } = repo.upsertPrediction(entry());
    const resolved = repo.resolvePrediction(prediction.id, {
      session: '2026-01-12',
      outcomeUp: false,
      realizedBrier: 0.62 ** 2,
    });
    expect(resolved?.resolvedSession).toBe('2026-01-12');
    expect(resolved?.outcomeUp).toBe(false);
    expect(resolved?.realizedBrier).toBeCloseTo(0.3844, 6);
    expect(repo.pendingResolutions('AAPL')).toHaveLength(0);
    expect(repo.resolvedForTicker('AAPL')).toHaveLength(1);
  });

  it('lista pendientes y resueltas por ticker con la sesión ordenada', () => {
    repo.upsertPrediction(entry({ session: '2026-01-05' }));
    repo.upsertPrediction(entry({ session: '2026-01-06' }));
    repo.upsertPrediction(entry({ session: '2026-01-07', ticker: 'MSFT' }));
    expect(repo.pendingResolutions('AAPL').map((p) => p.sessionDate)).toEqual([
      '2026-01-05',
      '2026-01-06',
    ]);
    expect(repo.listPredictions({ ticker: 'AAPL' })[0]!.sessionDate).toBe('2026-01-06');
    expect(repo.listPredictions({}).map((p) => p.ticker)).toContain('MSFT');
    expect(repo.latestPrediction('aapl')?.sessionDate).toBe('2026-01-06');
    expect(repo.latestSession('AAPL', '0.1.0')).toBe('2026-01-06');
    expect(repo.latestSession('AAPL', '9.9.9')).toBeNull();
  });

  it('rechaza probabilidades fuera de [0, 1] o no finitas', () => {
    expect(() => repo.upsertPrediction(entry({ probUp: 1.2 }))).toThrow();
    expect(() => repo.upsertPrediction(entry({ probUp: Number.NaN }))).toThrow();
    expect(() => repo.upsertPrediction(entry({ expectedVolatility: -1 }))).toThrow();
    expect(() => repo.upsertPrediction(entry({ ticker: ' ' }))).toThrow();
  });
});
