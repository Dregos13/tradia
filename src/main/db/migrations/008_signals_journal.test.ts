import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: lo que la 008 extiende. */
const PHASE_0_3 = MIGRATIONS.filter((m) => m.version <= 7);
/** Hasta señales y diario inclusive: lo que cubre esta prueba. */
const PHASE_4 = MIGRATIONS.filter((m) => m.version <= 8);

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

const DECISION_JSON =
  '{"status":"aprobada","size":10,"sizeFactor":1,"riskAmount":50,"notional":2000,' +
  '"reasons":[],"decidedAt":"2026-10-09T20:00:00.000Z"}';

const INSERT_SIGNAL = `INSERT INTO signals
    (ticker, direccion, entrada, stop, objetivo, confianza, motivo, estrategias,
     datos_usados, decision, estado, vela_fecha)
  VALUES (?, ?, 200, 190, 220, ?, ?, '[]', '{}', ?, ?, ?)`;

const INSERT_JOURNAL = `INSERT INTO journal_entries
    (tipo, ticker, estrategia_id, motivo, datos, resultado, errores, reglas, senal_id)
  VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?)`;

const INSERT_ROUTINE = `INSERT INTO routine_runs (rutina, dia, con_retraso, journal_id)
  VALUES (?, ?, ?, ?)`;

describe('migración 008 · señales y diario', () => {
  it('sube sobre la fase anterior y crea las tres tablas del módulo', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_3);

    expect(migrate(db, PHASE_4)).toEqual([8]);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['signals', 'journal_entries', 'routine_runs']),
    );
    db.close();
  });

  it('aplica limpia sobre una base vacía', () => {
    const db = new Database(':memory:');
    expect(migrate(db, PHASE_4)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    db.close();
  });

  it('la señal guarda dirección, confianza, motivo, datos y decisión', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_4);

    db.prepare(INSERT_SIGNAL).run(
      'AAPL',
      'largo',
      0.8,
      'Cruce 50/200 alcista',
      DECISION_JSON,
      'aprobada',
      '2026-10-08',
    );
    // La vetada también se persiste, con su decisión completa.
    db.prepare(INSERT_SIGNAL).run(
      'MSFT',
      'corto',
      0.7,
      'RSI sobrecomprado',
      DECISION_JSON.replace('aprobada', 'vetada'),
      'vetada',
      '2026-10-08',
    );

    // Los CHECK rechazan direcciones y estados ajenos al contrato.
    expect(() =>
      db
        .prepare(INSERT_SIGNAL)
        .run('NVDA', 'compra', 0.5, 'x', DECISION_JSON, 'aprobada', '2026-10-08'),
    ).toThrowError();
    expect(() =>
      db
        .prepare(INSERT_SIGNAL)
        .run('NVDA', 'largo', 0.5, 'x', DECISION_JSON, 'pendiente', '2026-10-08'),
    ).toThrowError();
    // Entrada o confianza no válidas quedan rechazadas.
    expect(() =>
      db
        .prepare(INSERT_SIGNAL.replace('200', '0'))
        .run('NVDA', 'largo', 0.5, 'x', DECISION_JSON, 'aprobada', '2026-10-08'),
    ).toThrowError();
    expect(() =>
      db
        .prepare(INSERT_SIGNAL)
        .run('NVDA', 'largo', -0.2, 'x', DECISION_JSON, 'aprobada', '2026-10-08'),
    ).toThrowError();

    expect((db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n).toBe(2);
    db.close();
  });

  it('la misma vela del mismo activo no genera dos señales (idempotencia)', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_4);

    db.prepare(INSERT_SIGNAL).run(
      'AAPL',
      'largo',
      0.8,
      'x',
      DECISION_JSON,
      'aprobada',
      '2026-10-08',
    );
    expect(() =>
      db
        .prepare(INSERT_SIGNAL)
        .run('AAPL', 'largo', 0.9, 'x', DECISION_JSON, 'aprobada', '2026-10-08'),
    ).toThrowError();
    // Otro activo u otra vela sí pueden.
    db.prepare(INSERT_SIGNAL).run(
      'MSFT',
      'largo',
      0.8,
      'x',
      DECISION_JSON,
      'aprobada',
      '2026-10-08',
    );
    db.prepare(INSERT_SIGNAL).run(
      'AAPL',
      'largo',
      0.8,
      'x',
      DECISION_JSON,
      'aprobada',
      '2026-10-09',
    );
    db.close();
  });

  it('el diario admite los siete tipos y enlaza con la señal', () => {
    const db = new Database(':memory:');
    // Mismo pragma que openDatabase: hace efectivo el ON DELETE SET NULL.
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_4);

    db.prepare(INSERT_SIGNAL).run(
      'AAPL',
      'largo',
      0.8,
      'x',
      DECISION_JSON,
      'aprobada',
      '2026-10-08',
    );
    const signalId = (db.prepare('SELECT id FROM signals').get() as { id: number }).id;

    for (const tipo of [
      'senal',
      'veto',
      'contradiccion',
      'operacion',
      'resumen',
      'error',
      'limite',
    ]) {
      db.prepare(INSERT_JOURNAL).run(tipo, 'AAPL', null, 'motivo', null, null, signalId);
    }
    // El CHECK rechaza tipos ajenos.
    expect(() =>
      db.prepare(INSERT_JOURNAL).run('aviso', 'AAPL', null, 'x', null, null, null),
    ).toThrowError();

    // Borrar la señal deja la entrada con senal_id a NULL (SET NULL).
    db.prepare('DELETE FROM signals').run();
    const nulled = db
      .prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE senal_id IS NULL')
      .get() as { n: number };
    expect(nulled.n).toBe(7);
    db.close();
  });

  it('las rutinas se deduplican por día y marcan el envío con retraso', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_4);

    db.prepare(INSERT_ROUTINE).run('preapertura', '2026-10-09', 0, null);
    db.prepare(INSERT_ROUTINE).run('cierre', '2026-10-09', 0, null);
    // La misma rutina el mismo día no se repite; al día siguiente sí.
    expect(() =>
      db.prepare(INSERT_ROUTINE).run('preapertura', '2026-10-09', 1, null),
    ).toThrowError();
    db.prepare(INSERT_ROUTINE).run('preapertura', '2026-10-10', 1, null);

    // Rutina desconocida o marca fuera de 0/1 quedan rechazadas.
    expect(() => db.prepare(INSERT_ROUTINE).run('cierre2', '2026-10-10', 0, null)).toThrowError();
    expect(() =>
      db.prepare(INSERT_ROUTINE).run('conciliacion', '2026-10-10', 2, null),
    ).toThrowError();
    db.close();
  });

  it('revertir la 008 solo elimina las tablas del módulo', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_4);
    db.prepare(INSERT_SIGNAL).run(
      'AAPL',
      'largo',
      0.8,
      'x',
      DECISION_JSON,
      'aprobada',
      '2026-10-08',
    );
    db.prepare(INSERT_JOURNAL).run('senal', 'AAPL', null, 'x', null, 'aprobada', null);
    db.prepare(INSERT_ROUTINE).run('preapertura', '2026-10-09', 0, null);

    expect(rollbackLast(db, PHASE_4)).toBe(8);
    const tables = tableNames(db);
    for (const table of ['signals', 'journal_entries', 'routine_runs']) {
      expect(tables).not.toContain(table);
    }
    // Las fases anteriores quedan intactas.
    expect(tables).toContain('risk_limits');
    expect(tables).toContain('strategies');
    db.close();
  });
});
