import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RiskDecision } from '../../shared/risk';
import { openDatabase } from '../db/database';
import { createSignalsRepository, type NewSignal, type SignalsRepository } from './repository';

const DECISION: RiskDecision = {
  status: 'aprobada',
  size: 10,
  sizeFactor: 1,
  riskAmount: 50,
  notional: 2000,
  reasons: [],
  decidedAt: '2026-10-09T20:00:00.000Z',
};

const newSignal = (patch: Partial<NewSignal> = {}): NewSignal => ({
  ticker: 'AAPL',
  direction: 'largo',
  entry: 200,
  stop: 190,
  target: 220,
  confidence: 0.72,
  reason: 'Cruce de medias al alza',
  strategies: [
    {
      strategyId: 1,
      name: 'Cruce de medias',
      version: 2,
      direction: 'largo',
      confidence: 0.72,
      reason: 'r',
    },
  ],
  dataUsed: {
    barDate: '2026-10-08',
    desde: '2025-10-08',
    hasta: '2026-10-08',
    barCount: 252,
    batchId: 7,
    batchVersion: 3,
    source: 'tiingo',
  },
  decision: DECISION,
  barDate: '2026-10-08',
  ...patch,
});

let db: Database.Database;
let repo: SignalsRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createSignalsRepository(db);
});

afterEach(() => {
  db.close();
});

describe('repositorio de señales', () => {
  it('inserta y relee la señal con toda su trazabilidad', () => {
    const { signal, inserted } = repo.insertSignal(newSignal());
    expect(inserted).toBe(true);

    const read = repo.getSignal(signal.id);
    expect(read).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      entry: 200,
      stop: 190,
      target: 220,
      confidence: 0.72,
      reason: 'Cruce de medias al alza',
      decision: DECISION,
      dataUsed: { barDate: '2026-10-08', batchId: 7, batchVersion: 3, source: 'tiingo' },
    });
    expect(read!.strategies[0]).toMatchObject({ strategyId: 1, version: 2, direction: 'largo' });
    expect(read!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('la misma vela del mismo activo devuelve la fila existente (inserted: false)', () => {
    const first = repo.insertSignal(newSignal());
    const second = repo.insertSignal(newSignal({ confidence: 0.9, reason: 'otra' }));
    expect(second.inserted).toBe(false);
    expect(second.signal.id).toBe(first.signal.id);
    // La original no se pisa.
    expect(repo.getSignal(first.signal.id)!.confidence).toBe(0.72);
    expect(repo.signalExists('AAPL', '2026-10-08')).toBe(true);
    expect(repo.signalExists('AAPL', '2026-10-09')).toBe(false);
  });

  it('lista con filtros de activo, decisión, estrategia y rango de vela', () => {
    repo.insertSignal(newSignal());
    repo.insertSignal(
      newSignal({
        ticker: 'MSFT',
        barDate: '2026-10-08',
        decision: { ...DECISION, status: 'vetada' },
      }),
    );
    repo.insertSignal(
      newSignal({
        ticker: 'AAPL',
        barDate: '2026-10-09',
        dataUsed: { ...newSignal().dataUsed, barDate: '2026-10-09' },
      }),
    );

    // Más recientes primero (id desc dentro del mismo instante).
    expect(repo.listSignals().map((s) => `${s.ticker}@${s.dataUsed.barDate}#${s.id}`)).toEqual([
      'AAPL@2026-10-09#3',
      'MSFT@2026-10-08#2',
      'AAPL@2026-10-08#1',
    ]);
    expect(repo.listSignals({ ticker: 'aapl' })).toHaveLength(2);
    expect(repo.listSignals({ decision: 'vetada' }).map((s) => s.ticker)).toEqual(['MSFT']);
    expect(repo.listSignals({ desde: '2026-10-09' })).toHaveLength(1);
    expect(repo.listSignals({ hasta: '2026-10-08' })).toHaveLength(2);
    expect(repo.listSignals({ strategyId: 1 })).toHaveLength(3);
    expect(repo.listSignals({ strategyId: 999 })).toHaveLength(0);
    expect(repo.listSignals({ limit: 2 })).toHaveLength(2);
    expect(repo.listSignals({ limit: 2, offset: 2 })).toHaveLength(1);
  });

  it('getSignal devuelve null ante ids inexistentes o inválidos', () => {
    expect(repo.getSignal(999)).toBeNull();
    expect(repo.getSignal(0)).toBeNull();
    expect(repo.getSignal(-3)).toBeNull();
  });
});
