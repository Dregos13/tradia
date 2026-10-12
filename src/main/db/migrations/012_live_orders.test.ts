import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: todo lo que la 012 necesita (signals, broker). */
const PHASE_0_11 = MIGRATIONS.filter((m) => m.version <= 11);
/** Hasta las órdenes del broker real inclusive: lo que cubre esta prueba. */
const PHASE_7 = MIGRATIONS.filter((m) => m.version <= 12);

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((row) => row.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

/** Orden mínima válida en cualquiera de las dos tablas de órdenes. */
const insertOrder = (db: Database.Database, table: string, clientOrderId: string): void => {
  db.prepare(
    `INSERT INTO ${table} (client_order_id, ticker, tipo, lado, cantidad, pedida_en)
     VALUES (?, 'SPY', 'market', 'buy', 1, '2026-10-09T15:00:00.000Z')`,
  ).run(clientOrderId);
};

describe('migración 012 · órdenes del broker real', () => {
  it('sube sobre la fase anterior y crea broker_orders_live sin tocar las paper', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_11);
    expect(tableNames(db)).not.toContain('broker_orders_live');

    expect(migrate(db, PHASE_7)).toEqual([12]);
    expect(tableNames(db)).toContain('broker_orders_live');
    expect(tableNames(db)).toContain('broker_orders');
    // Mismo esquema que la tabla paper.
    expect(columnNames(db, 'broker_orders_live')).toEqual(columnNames(db, 'broker_orders'));
    db.close();
  });

  it('aplica limpia sobre una base vacía', () => {
    const db = new Database(':memory:');
    expect(migrate(db, PHASE_7)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    db.close();
  });

  it('la idempotencia por client_order_id es independiente por tabla', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_7);

    // El mismo client_order_id puede existir en cada cuenta: la paper y
    // la real son libros distintos; dentro de cada una sigue siendo UNIQUE.
    insertOrder(db, 'broker_orders', 'tradia-1-entrada');
    insertOrder(db, 'broker_orders_live', 'tradia-1-entrada');
    expect(() => insertOrder(db, 'broker_orders_live', 'tradia-1-entrada')).toThrowError();

    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM broker_orders) AS paper,
                (SELECT COUNT(*) FROM broker_orders_live) AS live`,
      )
      .get() as { paper: number; live: number };
    expect(counts).toEqual({ paper: 1, live: 1 });
    db.close();
  });

  it('los CHECK del contrato de órdenes también valen en live', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_7);
    // Estado ajeno al contrato → CHECK.
    expect(() =>
      db
        .prepare(
          `INSERT INTO broker_orders_live
             (client_order_id, ticker, tipo, lado, cantidad, pedida_en, estado)
           VALUES ('x', 'SPY', 'market', 'buy', 1, '2026-10-09T15:00:00.000Z', 'volada')`,
        )
        .run(),
    ).toThrowError();
    // Cantidad no positiva → CHECK.
    expect(() =>
      db
        .prepare(
          `INSERT INTO broker_orders_live
             (client_order_id, ticker, tipo, lado, cantidad, pedida_en)
           VALUES ('x', 'SPY', 'market', 'buy', 0, '2026-10-09T15:00:00.000Z')`,
        )
        .run(),
    ).toThrowError();
    db.close();
  });

  it('senal_id hace SET NULL al borrar la señal, como en paper', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_7);
    const signalId = Number(
      db
        .prepare(
          `INSERT INTO signals (ticker, direccion, entrada, stop, objetivo, confianza,
             motivo, estrategias, datos_usados, decision, estado, vela_fecha)
           VALUES ('SPY', 'largo', 100, 90, 110, 0.8, 'r', '[]', '{}', '{}',
                   'aprobada', '2026-10-09')`,
        )
        .run().lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO broker_orders_live
         (client_order_id, senal_id, ticker, tipo, lado, cantidad, pedida_en)
       VALUES ('tradia-live-s', ?, 'SPY', 'market', 'buy', 1, '2026-10-09T15:00:00.000Z')`,
    ).run(signalId);
    db.prepare('DELETE FROM signals WHERE id = ?').run(signalId);
    const row = db
      .prepare(
        `SELECT senal_id AS sid FROM broker_orders_live WHERE client_order_id = 'tradia-live-s'`,
      )
      .get() as { sid: number | null };
    expect(row.sid).toBeNull();
    db.close();
  });

  it('el down retira solo la tabla live y conserva las paper', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_7);
    insertOrder(db, 'broker_orders', 'tradia-1-entrada');
    insertOrder(db, 'broker_orders_live', 'tradia-9-entrada');

    expect(rollbackLast(db, PHASE_7)).toBe(12);
    expect(tableNames(db)).not.toContain('broker_orders_live');
    expect(tableNames(db)).toContain('broker_orders');
    expect(tableNames(db)).toContain('live_mode');
    const paper = db.prepare(`SELECT COUNT(*) AS n FROM broker_orders`).get() as { n: number };
    expect(paper.n).toBe(1);
    db.close();
  });
});
