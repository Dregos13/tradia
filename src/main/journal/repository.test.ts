import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JournalRecordInput } from '../../shared/ipc';
import { openDatabase } from '../db/database';
import { createJournalRepository, type JournalRepository } from './repository';

let db: Database.Database;
let repo: JournalRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createJournalRepository(db);
});

afterEach(() => {
  db.close();
});

const NOW = '2026-10-09T15:00:00.000Z';

const input = (patch: Partial<JournalRecordInput> = {}): JournalRecordInput => ({
  type: 'senal',
  ticker: 'aapl',
  reason: 'Cierre sobre SMA 50 con volumen 1,4×',
  result: 'aprobada',
  strategies: [{ strategyId: 7, name: 'Tendencia SMA', version: 3 }],
  dataUsed: { barDate: '2026-10-08', barCount: 60 },
  ...patch,
});

describe('journal repository: registro', () => {
  it('persiste la entrada completa y la devuelve tal como la lee el renderer', () => {
    const created = repo.insert(
      input({
        errors: ['proveedor lento'],
        ruleChecks: [
          {
            code: 'RR_TOO_LOW',
            label: 'Beneficio/riesgo',
            cumplida: true,
            observed: '2,4',
            limit: '2',
          },
        ],
        signalId: null,
      }),
      NOW,
    );

    expect(created.id).toBeGreaterThan(0);
    expect(created).toMatchObject({
      type: 'senal',
      createdAt: NOW,
      ticker: 'AAPL',
      reason: 'Cierre sobre SMA 50 con volumen 1,4×',
      result: 'aprobada',
      errors: ['proveedor lento'],
      signalId: null,
    });
    expect(created.strategies).toEqual([{ strategyId: 7, name: 'Tendencia SMA', version: 3 }]);
    expect(created.dataUsed).toEqual({ barDate: '2026-10-08', barCount: 60 });
    expect(created.ruleChecks[0]).toMatchObject({ code: 'RR_TOO_LOW', cumplida: true });
  });

  it('normaliza el activo a mayúsculas y aplica los valores por defecto', () => {
    const created = repo.insert({ type: 'error', reason: 'Fallo de red' }, NOW);
    expect(created.ticker).toBeNull();
    expect(created.strategies).toEqual([]);
    expect(created.errors).toEqual([]);
    expect(created.ruleChecks).toEqual([]);
    expect(created.result).toBeNull();
    expect(created.dataUsed).toBeNull();
  });

  it('getById devuelve null cuando la entrada no existe', () => {
    expect(repo.getById(999)).toBeNull();
  });

  it('senal_id sobrevive al borrado de la señal (ON DELETE SET NULL)', () => {
    const signal = db
      .prepare(
        `INSERT INTO signals (ticker, direccion, entrada, confianza, motivo, decision, estado, vela_fecha)
         VALUES ('AAPL', 'largo', 100, 0.7, 'm', '{}', 'aprobada', '2026-10-08')`,
      )
      .run();
    const signalId = Number(signal.lastInsertRowid);

    const created = repo.insert(input({ signalId }), NOW);
    expect(created.signalId).toBe(signalId);

    db.prepare('DELETE FROM signals WHERE id = ?').run(signalId);
    expect(repo.getById(created.id)?.signalId).toBeNull();
  });
});

describe('journal repository: consulta y filtros', () => {
  const seed = (): void => {
    repo.insert(input(), '2026-10-07T09:00:00.000Z');
    repo.insert(
      input({
        type: 'veto',
        ticker: 'NVDA',
        result: 'vetada',
        strategies: [{ strategyId: 9, name: 'Momentum', version: 1 }],
      }),
      '2026-10-08T10:00:00.000Z',
    );
    repo.insert(
      input({
        type: 'contradiccion',
        result: 'sin-senal',
        strategies: [
          { strategyId: 7, name: 'Tendencia SMA', version: 3 },
          { strategyId: 9, name: 'Momentum', version: 1 },
        ],
      }),
      '2026-10-09T11:00:00.000Z',
    );
  };

  it('devuelve más reciente primero con total del conjunto', () => {
    seed();
    const page = repo.list();
    expect(page.total).toBe(3);
    expect(page.entries.map((e) => e.type)).toEqual(['contradiccion', 'veto', 'senal']);
    expect(page.limit).toBe(1000);
    expect(page.offset).toBe(0);
  });

  it('filtra por fecha, ambos inclusive', () => {
    seed();
    expect(repo.list({ desde: '2026-10-08', hasta: '2026-10-08' }).entries).toHaveLength(1);
    expect(repo.list({ desde: '2026-10-08' }).entries).toHaveLength(2);
    expect(repo.list({ hasta: '2026-10-07' }).entries).toHaveLength(1);
    expect(repo.list({ desde: '2026-10-10' }).entries).toHaveLength(0);
  });

  it('filtra por tipo, activo (insensible a mayúsculas) y resultado', () => {
    seed();
    expect(repo.list({ type: 'veto' }).entries).toHaveLength(1);
    expect(repo.list({ ticker: 'nvda' }).entries).toHaveLength(1);
    expect(repo.list({ result: 'vetada' }).entries[0]?.type).toBe('veto');
    expect(repo.list({ type: 'senal', result: 'vetada' }).entries).toHaveLength(0);
  });

  it('filtra por estrategia aunque no sea la primera de la lista', () => {
    seed();
    // La contradicción toca dos estrategias: el filtro acierta con cualquiera.
    expect(repo.list({ strategyId: 9 }).total).toBe(2);
    expect(repo.list({ strategyId: 7 }).total).toBe(2);
    expect(repo.list({ strategyId: 42 }).total).toBe(0);
  });

  it('pagina con limit y offset sin perder el total filtrado', () => {
    seed();
    const first = repo.list({ limit: 2, offset: 0 });
    expect(first.entries.map((e) => e.type)).toEqual(['contradiccion', 'veto']);
    expect(first.total).toBe(3);

    const second = repo.list({ limit: 2, offset: 2 });
    expect(second.entries.map((e) => e.type)).toEqual(['senal']);
    expect(second.total).toBe(3);
  });
});
