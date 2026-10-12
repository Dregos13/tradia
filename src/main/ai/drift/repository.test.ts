import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../db/database';
import { createStrategiesRepository } from '../../strategies/repository';
import { parseModelCard } from '../prediction/modelCard';
import { createPredictionsRepository } from '../prediction/repository';
import {
  createDriftRepository,
  nextQuarterStart,
  quarterOf,
  type DriftRepository,
  type NewDriftCheck,
} from './repository';

const HASH = 'a'.repeat(64);

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
  referenceDistribution: [],
  trainedAt: '2026-01-01T00:00:00.000Z',
});

const check = (over: Partial<NewDriftCheck> = {}): NewDriftCheck => ({
  subject: 'modelo',
  subjectId: 1,
  subjectName: 'Modelo v0.1.0',
  kind: 'datos',
  streak: 0,
  detail: { 'psi:ret_5': 0.1 },
  drifted: false,
  evaluatedAt: '2026-10-01T17:30:00.000Z',
  ...over,
});

let db: Database.Database;
let repo: DriftRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createDriftRepository(db);
});

afterEach(() => {
  db.close();
});

describe('quarterOf / nextQuarterStart', () => {
  it('mapea la fecha civil al trimestre natural', () => {
    expect(quarterOf('2026-01-15')).toBe('2026-Q1');
    expect(quarterOf('2026-03-31')).toBe('2026-Q1');
    expect(quarterOf('2026-04-01')).toBe('2026-Q2');
    expect(quarterOf('2026-10-10')).toBe('2026-Q4');
    expect(quarterOf('2026-12-31')).toBe('2026-Q4');
  });

  it('da el primer día del trimestre siguiente, cruzando de año', () => {
    expect(nextQuarterStart('2026-Q1')).toBe('2026-04-01');
    expect(nextQuarterStart('2026-Q4')).toBe('2027-01-01');
    expect(() => nextQuarterStart('2026-Q9')).toThrow();
  });
});

describe('drift_checks', () => {
  it('persiste la revisión con persistencia, detalle y resultado', () => {
    const saved = repo.insertCheck(
      check({ streak: 3, drifted: true, detail: { 'psi:ret_5': 0.31, 'psi:vol_20': 0.4 } }),
    );
    expect(saved).toMatchObject({
      subject: 'modelo',
      kind: 'datos',
      streak: 3,
      drifted: true,
    });
    expect(saved.detail['psi:vol_20']).toBe(0.4);
  });

  it('lista en orden cronológico y filtra por tipo', () => {
    repo.insertCheck(check({ evaluatedAt: '2026-10-02T17:30:00.000Z' }));
    repo.insertCheck(check({ evaluatedAt: '2026-10-01T17:30:00.000Z' }));
    repo.insertCheck(check({ kind: 'resultados', evaluatedAt: '2026-10-03T17:30:00.000Z' }));
    const all = repo.listChecks('modelo', 1);
    expect(all.map((c) => c.evaluatedAt.slice(0, 10))).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(repo.listChecks('modelo', 1, 'datos')).toHaveLength(2);
    expect(repo.latestCheck('modelo', 1, 'datos')?.evaluatedAt.slice(0, 10)).toBe('2026-10-02');
    expect(repo.latestCheck('modelo', 2)).toBeNull();
    expect(repo.latestEvaluatedAt()).toBe('2026-10-03T17:30:00.000Z');
  });
});

describe('retrain_proposals', () => {
  it('crea la propuesta pendiente y calcula la próxima fecha permitida', () => {
    const cardId = createPredictionsRepository(db).registerModelCard(parseModelCard(cardJson())).id;
    const strategyId = createStrategiesRepository(db).create({
      name: 'Cruce de medias',
      hypothesis: 'h',
      rules: { entry: 'e', exit: 'x', stop: 's', target: 't' },
      parameters: {},
      markets: ['SPY'],
      regime: 'tendencia',
    }).id;
    const { proposal, inserted } = repo.createProposal({
      modelCardId: cardId,
      strategyId,
      quarter: '2026-Q4',
      reason: 'Drift sostenido en ret_5 y vol_20',
      dataScope: 'velas limpias exportadas',
      createdAt: '2026-10-10T17:30:00.000Z',
    });
    expect(inserted).toBe(true);
    expect(proposal).toMatchObject({
      modelCardId: cardId,
      strategyId,
      quarter: '2026-Q4',
      status: 'pendiente',
      lastTrainedAt: '2026-01-01T00:00:00.000Z',
      nextAllowedAt: '2027-01-01',
    });
  });

  it('una segunda propuesta en el mismo trimestre devuelve la existente', () => {
    const first = repo.createProposal({
      modelCardId: null,
      strategyId: null,
      quarter: '2026-Q4',
      reason: 'primera',
      dataScope: null,
      createdAt: '2026-10-10T17:30:00.000Z',
    });
    const second = repo.createProposal({
      modelCardId: null,
      strategyId: null,
      quarter: '2026-Q4',
      reason: 'segunda',
      dataScope: null,
      createdAt: '2026-10-11T17:30:00.000Z',
    });
    expect(second.inserted).toBe(false);
    expect(second.proposal.id).toBe(first.proposal.id);
    expect(second.proposal.reason).toBe('primera');
    const third = repo.createProposal({
      modelCardId: null,
      strategyId: null,
      quarter: '2027-Q1',
      reason: 'tercera',
      dataScope: null,
      createdAt: '2027-01-05T17:30:00.000Z',
    });
    expect(third.inserted).toBe(true);
  });

  it('rechaza trimestres mal formados y motivos vacíos', () => {
    const base = {
      modelCardId: null,
      strategyId: null,
      dataScope: null,
      createdAt: '2026-10-10T00:00:00.000Z',
    };
    expect(() => repo.createProposal({ ...base, quarter: '2026-10', reason: 'x' })).toThrow();
    expect(() => repo.createProposal({ ...base, quarter: '2026-Q4', reason: ' ' })).toThrow();
  });

  it('resuelve solo propuestas pendientes y respeta la fecha de aplazamiento', () => {
    const { proposal } = repo.createProposal({
      modelCardId: null,
      strategyId: null,
      quarter: '2026-Q4',
      reason: 'drift',
      dataScope: null,
      createdAt: '2026-10-10T17:30:00.000Z',
    });
    const resolved = repo.resolveProposal(proposal.id, {
      status: 'pospuesta',
      note: 'esperar a más datos',
      postponedUntil: '2027-03-01',
      resolvedAt: '2026-10-12T09:00:00.000Z',
    });
    expect(resolved).toMatchObject({
      status: 'pospuesta',
      note: 'esperar a más datos',
      postponedUntil: '2027-03-01',
      resolvedAt: '2026-10-12T09:00:00.000Z',
      // El aplazamiento pasa del inicio del trimestre siguiente.
      nextAllowedAt: '2027-03-01',
    });
    expect(
      repo.resolveProposal(proposal.id, {
        status: 'aprobada',
        note: null,
        postponedUntil: null,
        resolvedAt: '2026-10-13T09:00:00.000Z',
      }),
    ).toBeNull();
    expect(repo.getProposal(999)).toBeNull();
  });
});

describe('lecturas de predicción y marca de la ficha', () => {
  it('cuenta y devuelve los Brier realizados de la versión, más recientes primero', () => {
    const predictions = createPredictionsRepository(db);
    const cardId = predictions.registerModelCard(parseModelCard(cardJson())).id;
    const seed = (session: string, brier: number): void => {
      const { prediction } = predictions.upsertPrediction({
        ticker: 'AAPL',
        session,
        horizonDays: 5,
        probUp: 0.6,
        expectedVolatility: null,
        modelVersion: '0.1.0',
        modelHash: HASH,
        modelCardId: cardId,
      });
      predictions.resolvePrediction(prediction.id, {
        session: '2026-01-20',
        outcomeUp: true,
        realizedBrier: brier,
      });
    };
    seed('2026-01-05', 0.1);
    seed('2026-01-06', 0.2);
    predictions.upsertPrediction({
      ticker: 'AAPL',
      session: '2026-01-07',
      horizonDays: 5,
      probUp: 0.5,
      expectedVolatility: null,
      modelVersion: '0.1.0',
      modelHash: HASH,
      modelCardId: cardId,
    });
    expect(repo.resolvedCount('0.1.0')).toBe(2);
    expect(repo.resolvedCount('9.9.9')).toBe(0);
    expect(repo.resolvedBriers('0.1.0', 60)).toEqual([0.2, 0.1]);
    expect(repo.resolvedBriers('0.1.0', 1)).toEqual([0.2]);
  });

  it('marca la ficha como degradada sin borrarla', () => {
    const predictions = createPredictionsRepository(db);
    const card = predictions.registerModelCard(parseModelCard(cardJson()));
    expect(card.eligible).toBe(true);
    expect(repo.markModelCardDegraded(card.id, 'Degradada por drift sostenido: datos')).toBe(true);
    const marked = predictions.latestModelCard();
    expect(marked?.eligible).toBe(false);
    expect(marked?.ineligibleReason).toBe('Degradada por drift sostenido: datos');
    expect(repo.markModelCardDegraded(card.id, 'Degradada por drift sostenido: datos')).toBe(true);
    expect(repo.markModelCardDegraded(999, 'x')).toBe(false);
  });
});
