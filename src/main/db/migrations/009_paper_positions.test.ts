import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: lo que la 009 extiende. */
const PHASE_0_4 = MIGRATIONS.filter((m) => m.version <= 8);
/** Hasta posiciones simuladas inclusive: lo que cubre esta prueba. */
const PHASE_4 = MIGRATIONS.filter((m) => m.version <= 9);

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

const DECISION_JSON =
  '{"status":"aprobada","size":10,"sizeFactor":1,"riskAmount":50,"notional":2000,' +
  '"reasons":[],"decidedAt":"2026-10-09T20:00:00.000Z"}';

const INSERT_SIGNAL = `INSERT INTO signals
    (ticker, direccion, entrada, stop, objetivo, confianza, motivo, estrategias,
     datos_usados, decision, estado, vela_fecha)
  VALUES ('AAPL', 'largo', 200, 190, 220, 0.8, 'x', '[]', '{}', ?, 'aprobada', '2026-10-08')`;

const INSERT_POSITION = `INSERT INTO risk_portfolio_positions
    (ticker, direccion, entrada, stop, objetivo, tamano, sector, divisa,
     senal_id, vela_apertura, salida, motivo_salida, abierta_en, cerrada_en)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

describe('migración 009 · posiciones simuladas desde señales', () => {
  it('sube sobre la fase anterior y añade las columnas de trazabilidad', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_4);

    expect(migrate(db, PHASE_4)).toEqual([9]);
    expect(columnNames(db, 'risk_portfolio_positions')).toEqual(
      expect.arrayContaining(['senal_id', 'vela_apertura', 'salida', 'motivo_salida']),
    );
    db.close();
  });

  it('aplica limpia sobre una base vacía', () => {
    const db = new Database(':memory:');
    expect(migrate(db, PHASE_4)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    db.close();
  });

  it('enlaza la posición con la señal y la desenlaza al borrarla', () => {
    const db = new Database(':memory:');
    // Mismo pragma que openDatabase: hace efectivo el ON DELETE SET NULL.
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_4);

    db.prepare(INSERT_SIGNAL).run(DECISION_JSON);
    const signalId = (db.prepare('SELECT id FROM signals').get() as { id: number }).id;
    db.prepare(INSERT_POSITION).run(
      'AAPL',
      'largo',
      200,
      190,
      220,
      8,
      'tecnologia',
      'USD',
      signalId,
      '2026-10-08',
      null,
      null,
      '2026-10-08T21:00:00.000Z',
      null,
    );

    // La FK rechaza señales inexistentes.
    expect(() =>
      db
        .prepare(INSERT_POSITION)
        .run(
          'MSFT',
          'largo',
          100,
          90,
          120,
          5,
          null,
          'USD',
          999,
          '2026-10-08',
          null,
          null,
          '2026-10-08T21:00:00.000Z',
          null,
        ),
    ).toThrowError();

    // Borrar la señal deja la posición con senal_id a NULL (SET NULL).
    db.prepare('DELETE FROM signals').run();
    const row = db.prepare('SELECT senal_id FROM risk_portfolio_positions WHERE id = 1').get() as {
      senal_id: number | null;
    };
    expect(row.senal_id).toBeNull();
    db.close();
  });

  it('el motivo de salida solo admite stop u objetivo', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_4);

    for (const motivo of ['stop', 'objetivo']) {
      db.prepare(INSERT_POSITION).run(
        'AAPL',
        'largo',
        200,
        190,
        220,
        8,
        null,
        'USD',
        null,
        '2026-10-08',
        190,
        motivo,
        '2026-10-08T21:00:00.000Z',
        '2026-10-09T21:00:00.000Z',
      );
    }
    expect(() =>
      db
        .prepare(INSERT_POSITION)
        .run(
          'AAPL',
          'largo',
          200,
          190,
          220,
          8,
          null,
          'USD',
          null,
          '2026-10-08',
          190,
          'manual',
          '2026-10-08T21:00:00.000Z',
          null,
        ),
    ).toThrowError();
    db.close();
  });

  it('revertir la 009 solo elimina las columnas nuevas y conserva las filas', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_4);
    db.prepare(INSERT_POSITION).run(
      'AAPL',
      'largo',
      200,
      190,
      220,
      8,
      'tecnologia',
      'USD',
      null,
      '2026-10-08',
      null,
      null,
      '2026-10-08T21:00:00.000Z',
      null,
    );

    expect(rollbackLast(db, PHASE_4)).toBe(9);
    const columns = columnNames(db, 'risk_portfolio_positions');
    for (const column of ['senal_id', 'vela_apertura', 'salida', 'motivo_salida']) {
      expect(columns).not.toContain(column);
    }
    // La posición y su contenido original sobreviven a la reversión.
    const row = db.prepare('SELECT ticker, entrada FROM risk_portfolio_positions').get() as {
      ticker: string;
      entrada: number;
    };
    expect(row).toEqual({ ticker: 'AAPL', entrada: 200 });
    db.close();
  });
});
