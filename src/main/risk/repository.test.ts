import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RISK_DEFAULTS, type RiskLimits, type SignalIntent } from '../../shared/ipc';
import { openDatabase } from '../db/database';
import { createRiskRepository, RISK_PAPER_EQUITY_DEFAULT, type RiskRepository } from './repository';

const NOW = '2026-10-09T15:00:00.000Z';

let db: Database.Database;
let repo: RiskRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createRiskRepository(db);
});

afterEach(() => {
  db.close();
});

const signal = (patch: Partial<SignalIntent> = {}): SignalIntent => ({
  ticker: 'aapl',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 110,
  confidence: 0.7,
  origin: 'probador',
  ...patch,
});

const vetoRecord = (code: Parameters<RiskRepository['appendVeto']>[0]['reason']['code']) => ({
  signal: signal(),
  decision: 'vetada' as const,
  reason: { code, message: `motivo ${code}`, details: { limite: 1, real: 2 } },
  size: 4,
});

/** Inserta un lote + barras diarias consecutivas para un ticker. */
const seedBars = (ticker: string, closes: number[], volume = 1_000_000): void => {
  const batch = db
    .prepare(
      `INSERT INTO data_batches (version, hash, proveedor, ambito, ticker, desde, hasta, recibido_en)
       VALUES (1, 'h', 'test', 'bars', ?, '2026-01-01', '2026-12-31', ?)`,
    )
    .run(ticker, NOW);
  const batchId = Number(batch.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO bars (ticker, fecha, fuente, lote_id, open, high, low, close, volume)
     VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?)`,
  );
  closes.forEach((close, i) => {
    const fecha = `2026-09-${String(i + 1).padStart(2, '0')}`;
    insert.run(ticker, fecha, batchId, close, close, close, close, volume);
  });
};

describe('risk repository: límites', () => {
  it('siembra RISK_DEFAULTS en la primera lectura y los devuelve congelados', () => {
    const limits = repo.getLimits();
    expect(limits).toEqual(RISK_DEFAULTS);
    expect(Object.isFrozen(limits)).toBe(true);
    const row = db.prepare('SELECT * FROM risk_limits WHERE id = 1').get();
    expect(row).toBeDefined();
  });

  it('setLimits persiste y getLimits lee lo guardado', () => {
    const next: RiskLimits = { ...RISK_DEFAULTS, riskPerTradePct: 1.5, maxDailyLossPct: 3 };
    const saved = repo.setLimits(next);
    expect(saved.riskPerTradePct).toBe(1.5);
    expect(repo.getLimits()).toEqual(next);
  });

  it('los CHECK de la tabla vuelven a exigir los márgenes duros', () => {
    // Defensa en profundidad: aunque un escritor saltara la validación del
    // servicio, la base rechaza valores fuera de margen (apalancamiento 2x).
    expect(() => repo.setLimits({ ...RISK_DEFAULTS, maxLeverage: 2 })).toThrow();
    expect(() => repo.setLimits({ ...RISK_DEFAULTS, riskPerTradePct: 3 })).toThrow();
  });
});

describe('risk repository: vetos', () => {
  it('appendVeto guarda señal, código, motivo, valores y tamaño', () => {
    const veto = repo.appendVeto(vetoRecord('STOP_MISSING'));
    expect(veto.id).toBeGreaterThan(0);
    expect(veto.code).toBe('STOP_MISSING');
    expect(veto.message).toBe('motivo STOP_MISSING');
    expect(veto.details).toEqual({ limite: 1, real: 2 });
    expect(veto.signal.ticker).toBe('aapl');
    expect(veto.ticker).toBe('AAPL');
    expect(veto.size).toBe(4);
    expect(veto.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('listVetoes ordena de más reciente a más antigua', () => {
    repo.appendVeto(vetoRecord('STOP_MISSING'));
    repo.appendVeto(vetoRecord('RR_TOO_LOW'));
    const rows = repo.listVetoes();
    expect(rows.map((r) => r.code)).toEqual(['RR_TOO_LOW', 'STOP_MISSING']);
  });

  it('filtra por regla, decisión y ticker, y pagina con limit/offset', () => {
    repo.appendVeto(vetoRecord('DAILY_LOSS'));
    repo.appendVeto({ ...vetoRecord('MAX_POSITIONS'), decision: 'reducida' });
    repo.appendVeto(vetoRecord('DAILY_LOSS'));

    expect(repo.listVetoes({ rule: 'DAILY_LOSS' }).map((r) => r.code)).toEqual([
      'DAILY_LOSS',
      'DAILY_LOSS',
    ]);
    expect(repo.listVetoes({ decision: 'reducida' })).toHaveLength(1);
    expect(repo.listVetoes({ ticker: 'MSFT' })).toHaveLength(0);
    expect(repo.listVetoes({ ticker: 'aapl' })).toHaveLength(3);
    expect(repo.listVetoes({ limit: 1 })).toHaveLength(1);
    expect(repo.listVetoes({ limit: 1, offset: 2 })[0]?.code).toBe('DAILY_LOSS');
  });
});

describe('risk repository: cartera simulada e instantánea', () => {
  it('seedPortfolio sustituye posiciones y curva en una transacción', () => {
    const first = repo.seedPortfolio(
      {
        equity: 50_000,
        positions: [
          { ticker: 'aapl', direction: 'largo', entry: 100, size: 10 },
          { ticker: 'msft', direction: 'corto', entry: 200, size: 5, closedAt: NOW },
        ],
        equityHistory: [{ at: '2026-10-01T00:00:00.000Z', equity: 55_000 }],
      },
      NOW,
    );
    expect(first).toEqual({ openPositions: 1, equityPoints: 2 });
    expect(repo.openTickers()).toEqual(['AAPL']);

    const second = repo.seedPortfolio({ equity: 60_000 }, NOW);
    expect(second).toEqual({ openPositions: 0, equityPoints: 1 });
    expect(repo.openTickers()).toEqual([]);
    const snapshot = repo.buildSnapshot(NOW);
    expect(snapshot.equity).toBe(60_000);
    expect(snapshot.equityHistory).toHaveLength(1);
  });

  it('sin siembra usa el capital de papel por defecto', () => {
    const snapshot = repo.buildSnapshot(NOW);
    expect(snapshot.equity).toBe(RISK_PAPER_EQUITY_DEFAULT);
    expect(snapshot.positions).toEqual([]);
  });

  it('la instantánea lleva metadatos de barras: marca, volumen medio y rendimientos', () => {
    seedBars('AAPL', [100, 102, 101, 105], 2_000_000);
    repo.seedPortfolio(
      { positions: [{ ticker: 'AAPL', direction: 'largo', entry: 99, size: 3 }] },
      NOW,
    );

    const snapshot = repo.buildSnapshot(NOW, ['MSFT']);
    const aapl = snapshot.positions[0];
    expect(aapl?.markPrice).toBe(105);
    expect(aapl?.currency).toBe('USD');

    expect(snapshot.instruments['AAPL']?.avgDailyVolume20d).toBe(2_000_000);
    expect(snapshot.instruments['MSFT']?.avgDailyVolume20d).toBeNull();

    const returns = snapshot.dailyReturns['AAPL'];
    expect(returns).toHaveLength(3);
    expect(returns?.[0]).toBeCloseTo(102 / 100 - 1, 10);
    expect(returns?.[2]).toBeCloseTo(105 / 101 - 1, 10);
  });

  it('lastVix lee la última observación VIXCLS y null sin dato', () => {
    expect(repo.lastVix()).toBeNull();
    db.prepare(
      `INSERT INTO macro_series (id, fuente, nombre) VALUES ('VIXCLS', 'fred', 'VIX')`,
    ).run();
    db.prepare(
      `INSERT INTO macro_observations (serie_id, fecha, valor) VALUES ('VIXCLS', '2026-10-07', 20), ('VIXCLS', '2026-10-08', 22.5)`,
    ).run();
    expect(repo.lastVix()).toBe(22.5);
  });
});
