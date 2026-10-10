import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../db/database';
import { createRegimeRepository, RegimeRepositoryError, type NewRegimeEntry } from './repository';

let db: Database.Database;

const entry = (over: Partial<NewRegimeEntry> = {}): NewRegimeEntry => ({
  scope: 'activo',
  ticker: 'AAPL',
  session: '2026-10-05',
  direction: 'tendencia',
  volatility: 'volatilidad-baja',
  metrics: { adx: 30, smaSlope: 0.2, realizedVolatility: 0.01, volatilityMedian: 0.015 },
  computedAt: '2026-10-05T21:00:00.000Z',
  ...over,
});

const countRows = (ticker = 'AAPL'): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM regimes WHERE ticker = ?').get(ticker) as { n: number }).n;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

describe('upsert', () => {
  it('inserta la fila y la devuelve como instantánea', () => {
    const repo = createRegimeRepository(db);
    const snapshot = repo.upsert(entry());
    expect(snapshot).toMatchObject({
      scope: 'activo',
      ticker: 'AAPL',
      sessionDate: '2026-10-05',
      direction: 'tendencia',
      volatility: 'volatilidad-baja',
      metrics: { adx: 30, smaSlope: 0.2, realizedVolatility: 0.01, volatilityMedian: 0.015 },
      computedAt: '2026-10-05T21:00:00.000Z',
      previousChange: null,
    });
    expect(countRows()).toBe(1);
  });

  it('es idempotente por sesión: el recálculo actualiza sin duplicar', () => {
    const repo = createRegimeRepository(db);
    repo.upsert(entry());
    const again = repo.upsert(
      entry({ direction: 'lateral', computedAt: '2026-10-06T08:00:00.000Z' }),
    );
    expect(countRows()).toBe(1);
    expect(again.direction).toBe('lateral');
    expect(again.computedAt).toBe('2026-10-06T08:00:00.000Z');
  });

  it('los dos ámbitos del mismo ticker coexisten sin pisarse', () => {
    const repo = createRegimeRepository(db);
    repo.upsert(entry({ scope: 'activo', ticker: 'SPY' }));
    repo.upsert(entry({ scope: 'mercado', ticker: 'SPY', direction: 'lateral' }));
    expect(countRows('SPY')).toBe(2);
    expect(repo.get('activo', 'SPY', '2026-10-05')!.direction).toBe('tendencia');
    expect(repo.get('mercado', 'SPY', '2026-10-05')!.direction).toBe('lateral');
  });

  it('normaliza el ticker y valida etiquetas y fechas', () => {
    const repo = createRegimeRepository(db);
    expect(repo.upsert(entry({ ticker: ' aapl ' })).ticker).toBe('AAPL');
    expect(() => repo.upsert(entry({ direction: 'raro' as NewRegimeEntry['direction'] }))).toThrow(
      RegimeRepositoryError,
    );
    expect(() => repo.upsert(entry({ session: 'ayer' }))).toThrow();
    expect(() => repo.upsert(entry({ ticker: '***' }))).toThrow();
  });
});

describe('lectura', () => {
  it('latest y latestSession devuelven la sesión más reciente', () => {
    const repo = createRegimeRepository(db);
    repo.upsert(entry({ session: '2026-10-05' }));
    repo.upsert(entry({ session: '2026-10-07', direction: 'lateral' }));
    repo.upsert(entry({ session: '2026-10-06' }));
    expect(repo.latestSession('activo', 'AAPL')).toBe('2026-10-07');
    expect(repo.latest('activo', 'AAPL')!.sessionDate).toBe('2026-10-07');
    expect(repo.latest('mercado', 'AAPL')).toBeNull();
    expect(repo.latestSession('mercado', 'AAPL')).toBeNull();
  });

  it('previousSession devuelve la última fila anterior a la sesión', () => {
    const repo = createRegimeRepository(db);
    repo.upsert(entry({ session: '2026-10-05' }));
    repo.upsert(entry({ session: '2026-10-08', direction: 'lateral' }));
    expect(repo.previousSession('activo', 'AAPL', '2026-10-08')!.sessionDate).toBe('2026-10-05');
    expect(repo.previousSession('activo', 'AAPL', '2026-10-05')).toBeNull();
  });

  it('previousChange: dirección anterior y sesión en que empezó la racha', () => {
    const repo = createRegimeRepository(db);
    for (const session of ['2026-10-01', '2026-10-02', '2026-10-05']) {
      repo.upsert(entry({ session, direction: 'lateral' }));
    }
    for (const session of ['2026-10-06', '2026-10-07']) {
      repo.upsert(entry({ session, direction: 'tendencia' }));
    }
    const latest = repo.latest('activo', 'AAPL')!;
    expect(latest.previousChange).toEqual({ direction: 'lateral', sessionDate: '2026-10-06' });
    // La primera dirección conocida no tiene «cambio anterior».
    expect(repo.get('activo', 'AAPL', '2026-10-01')!.previousChange).toBeNull();
    // Un cambio en la volatilidad no es un cambio de dirección.
    expect(latest.previousChange!.direction).toBe('lateral');
  });

  it('list ordena por sesión y filtra por rango', () => {
    const repo = createRegimeRepository(db);
    for (const session of ['2026-10-01', '2026-10-03', '2026-10-02']) {
      repo.upsert(entry({ session }));
    }
    const all = repo.list('activo', 'AAPL');
    expect(all.map((row) => row.sessionDate)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    const ranged = repo.list('activo', 'AAPL', { desde: '2026-10-02', hasta: '2026-10-02' });
    expect(ranged.map((row) => row.sessionDate)).toEqual(['2026-10-02']);
  });
});
